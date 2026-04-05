import { GoogleGenAI } from "@google/genai";
import type { CliContextHints, VerificationHints } from "./cli-context-hints";
import {
  buildGeminiThinkingConfig,
  getReasoningLevel,
  pickGeminiModel,
} from "./gemini-orchestration";
import { KAIZEN_CLI_EXECUTION_INSTRUCTIONS } from "./cli-execution-instructions";

const geminiApiKey = process.env.GEMINI_API_KEY;
const gemini = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

export interface AutonomousCliPlan {
  source: "llm" | "heuristic";
  summary: string;
  editCommands: string[];
  verifyCommands: string[];
  fixCommands: string[];
  model?: string;
  error?: string;
}

export interface AutonomousCliRecoveryPlan {
  source: "llm" | "heuristic";
  summary: string;
  editCommands: string[];
  fixCommands: string[];
  model?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function uniqCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const command of commands) {
    const normalized = command.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function truncateTail(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function splitCommandTokens(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function commandHasFlag(command: string, flag: string): boolean {
  return splitCommandTokens(command).includes(flag);
}

function appendFlag(command: string, flag: string): string {
  if (commandHasFlag(command, flag)) return command;
  return `${command.trim()} ${flag}`.trim();
}

function parseCargoAddPackages(command: string): string[] {
  const tokens = splitCommandTokens(command);
  if (tokens.length < 3) return [];
  if (tokens[0] !== "cargo" || tokens[1] !== "add") return [];

  const packages: string[] = [];
  const optionConsumesNext = new Set([
    "--rename",
    "--registry",
    "--package",
    "-p",
    "--path",
    "--git",
    "--branch",
    "--tag",
    "--rev",
  ]);

  for (let i = 2; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      if (optionConsumesNext.has(token) && i + 1 < tokens.length) {
        i += 1;
      }
      continue;
    }
    packages.push(token);
  }

  return uniqCommands(packages);
}

function splitMultiPackageAddCommand(command: string): string[] {
  const tokens = splitCommandTokens(command);
  if (tokens.length < 3) return [];

  const executable = tokens[0] || "";
  const subcommand = tokens[1] || "";
  let base: string[] = [];
  let startIndex = 0;

  if (executable === "cargo" && subcommand === "add") {
    base = ["cargo", "add"];
    startIndex = 2;
  } else if (executable === "npm" && (subcommand === "install" || subcommand === "i")) {
    base = ["npm", subcommand];
    startIndex = 2;
  } else if (executable === "pnpm" && subcommand === "add") {
    base = ["pnpm", "add"];
    startIndex = 2;
  } else if (executable === "yarn" && subcommand === "add") {
    base = ["yarn", "add"];
    startIndex = 2;
  } else {
    return [];
  }

  const options: string[] = [];
  const packages: string[] = [];
  const optionConsumesNext = new Set([
    "--tag",
    "--registry",
    "--workspace",
    "-w",
    "--filter",
    "--prefix",
    "--cwd",
    "--save-prefix",
    "--cache",
  ]);

  for (let i = startIndex; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-")) {
      options.push(token);
      if (optionConsumesNext.has(token) && i + 1 < tokens.length) {
        options.push(tokens[i + 1]!);
        i += 1;
      }
      continue;
    }
    packages.push(token);
  }

  if (packages.length <= 1) return [];
  return packages.map((pkg) => [...base, ...options, pkg].join(" "));
}

function buildRecoveryPlanWithCommands(params: {
  summary: string;
  editCommands?: string[];
  fixCommands?: string[];
  maxCommands: number;
  maxCommandLength: number;
  error?: string;
}): AutonomousCliRecoveryPlan {
  return {
    source: "heuristic",
    summary: params.summary,
    editCommands: sanitizeCommands({
      commands: params.editCommands || [],
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
    }),
    fixCommands: sanitizeCommands({
      commands: params.fixCommands || [],
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
    }),
    ...(params.error ? { error: params.error } : {}),
  };
}

export function buildHeuristicAutonomousCliRecoveryPlan(params: {
  failedCommand: string;
  failedExitCode: number | null;
  failedTimedOut: boolean;
  failedBlockedReason: string | null;
  failedStdout: string;
  failedStderr: string;
  maxCommands: number;
  maxCommandLength: number;
  reason?: string;
}): AutonomousCliRecoveryPlan {
  const command = params.failedCommand.trim();
  const stderrLower = params.failedStderr.toLowerCase();

  const noRecovery = (summary: string): AutonomousCliRecoveryPlan =>
    buildRecoveryPlanWithCommands({
      summary,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      ...(params.reason ? { error: params.reason } : {}),
    });

  if (!command) {
    return noRecovery("No recovery command available for empty failing command");
  }

  const isCargoAdd = /^cargo\s+add\b/i.test(command);
  const hasDependencyResolverConflict =
    stderrLower.includes("failed to select a version") ||
    stderrLower.includes("unable to resolve dependency tree") ||
    stderrLower.includes("eresolve") ||
    stderrLower.includes("version solving failed") ||
    stderrLower.includes("conflicting requirements") ||
    stderrLower.includes("conflicts with a previous package") ||
    stderrLower.includes("links to the native library") ||
    stderrLower.includes("peer dep") ||
    stderrLower.includes("err_pnpm_peer_dep_issues");

  const splitCommands = splitMultiPackageAddCommand(command);

  if (splitCommands.length > 0 && (params.failedTimedOut || hasDependencyResolverConflict)) {
    return buildRecoveryPlanWithCommands({
      summary: "Retry package additions one-by-one to reduce resolver and timeout risk",
      editCommands: splitCommands,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      ...(params.reason ? { error: params.reason } : {}),
    });
  }

  if (
    /^npm\s+(install|i)\b/i.test(command) &&
    hasDependencyResolverConflict &&
    !commandHasFlag(command, "--legacy-peer-deps")
  ) {
    return buildRecoveryPlanWithCommands({
      summary: "Retry npm install with peer-dependency compatibility flag",
      editCommands: [appendFlag(command, "--legacy-peer-deps")],
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      ...(params.reason ? { error: params.reason } : {}),
    });
  }

  if (
    /^pnpm\s+add\b/i.test(command) &&
    hasDependencyResolverConflict &&
    !commandHasFlag(command, "--no-strict-peer-dependencies")
  ) {
    return buildRecoveryPlanWithCommands({
      summary: "Retry pnpm add with peer-dependency strictness disabled",
      editCommands: [appendFlag(command, "--no-strict-peer-dependencies")],
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      ...(params.reason ? { error: params.reason } : {}),
    });
  }

  if (params.failedTimedOut) {
    if (splitCommands.length > 0) {
      return buildRecoveryPlanWithCommands({
        summary: "Split multi-package add command after timeout",
        editCommands: splitCommands,
        maxCommands: params.maxCommands,
        maxCommandLength: params.maxCommandLength,
        ...(params.reason ? { error: params.reason } : {}),
      });
    }
  }

  if (params.failedBlockedReason) {
    return noRecovery("No heuristic recovery for blocked command; requires replanning");
  }

  const cargoPackages = parseCargoAddPackages(command);
  if (isCargoAdd && cargoPackages.length > 1 && hasDependencyResolverConflict) {
    return buildRecoveryPlanWithCommands({
      summary: "Retry cargo dependency additions one at a time after resolver conflict",
      editCommands: cargoPackages.map((pkg) => `cargo add ${pkg}`),
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      ...(params.reason ? { error: params.reason } : {}),
    });
  }

  return noRecovery("No safe heuristic recovery command identified");
}

function sanitizeCommands(params: {
  commands: unknown;
  maxCommands: number;
  maxCommandLength: number;
}): string[] {
  return uniqCommands(toStringArray(params.commands))
    .filter((command) => !command.includes("<path-to-file>"))
    .filter((command) => command.length <= params.maxCommandLength)
    .slice(0, params.maxCommands);
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0] : null;
}

function isDocsIssue(title: string, body: string): boolean {
  const blob = `${title} ${body}`.toLowerCase();
  return /(docs?|documentation|readme|guide|tutorial|commentary|explain|reference)/.test(blob);
}

function pickDocumentationTarget(contextHints: CliContextHints | null): string | null {
  if (!contextHints) return null;

  const ranked = contextHints.ranked_files.map((hint) => hint.path);
  const preferred = ranked.find((path) => /(^|\/)readme(\.|$)/i.test(path));
  if (preferred) return preferred;

  return (
    ranked.find((path) => /\.(md|mdx|rst|txt|adoc)$/i.test(path)) ||
    ranked.find((path) => !/(^|\/)(__tests__|tests?)(\/|$)/i.test(path)) ||
    null
  );
}

function buildNodeAppendCommand(params: {
  path: string;
  note: string;
  maxCommandLength: number;
}): string | null {
  const baseNote = params.note.replace(/\s+/g, " ").trim();
  if (!baseNote) return null;

  const lengths = [Math.min(180, baseNote.length), 120, 96, 72, 56, 40]
    .filter((value, index, array) => value > 0 && array.indexOf(value) === index);

  for (const maxNoteLength of lengths) {
    const note = baseNote.slice(0, maxNoteLength);
    const script = [
      "const fs=require('fs')",
      `const p=${JSON.stringify(params.path)}`,
      "if(fs.existsSync(p)){",
      "const t=fs.readFileSync(p,'utf8')",
      `const n=${JSON.stringify(note)}`,
      "if(!t.includes(n))fs.writeFileSync(p,t.replace(/\\s*$/,'')+'\\n\\n'+n+'\\n')",
      "}",
    ].join(";");

    const command = `node -e ${JSON.stringify(script)}`;
    if (command.length <= params.maxCommandLength) {
      return command;
    }
  }

  return null;
}

function buildHeuristicPlan(params: {
  issueTitle: string;
  issueBody: string;
  contextHints: CliContextHints | null;
  verificationHints: VerificationHints | null;
  maxCommands: number;
  maxCommandLength: number;
  reason?: string;
}): AutonomousCliPlan {
  const verifyCommands = uniqCommands([
    ...toStringArray(params.verificationHints?.suggested_test_commands),
    ...toStringArray(params.contextHints?.command_suggestions.verify),
  ])
    .filter((command) => command.length <= params.maxCommandLength)
    .slice(0, params.maxCommands);

  const editCommands: string[] = [];
  if (isDocsIssue(params.issueTitle, params.issueBody)) {
    const target = pickDocumentationTarget(params.contextHints);
    if (target) {
      const issueUrl = extractFirstUrl(params.issueBody);
      const note = issueUrl
        ? `Issue context: ${issueUrl}`
        : `Issue context: ${params.issueTitle}`;
      const command = buildNodeAppendCommand({
        path: target,
        note,
        maxCommandLength: params.maxCommandLength,
      });
      if (command) {
        editCommands.push(command);
      }
    }
  }

  return {
    source: "heuristic",
    summary:
      params.reason ||
      (editCommands.length > 0
        ? "Generated heuristic docs-safe edit command"
        : "No safe heuristic edit command available"),
    editCommands: editCommands.slice(0, params.maxCommands),
    verifyCommands,
    fixCommands: [],
    ...(params.reason ? { error: params.reason } : {}),
  };
}

export async function generateAutonomousCliPlan(params: {
  issueTitle: string;
  issueBody: string;
  contextHints: CliContextHints | null;
  verificationHints: VerificationHints | null;
  allowedCommands: string[];
  maxCommands: number;
  maxCommandLength: number;
}): Promise<AutonomousCliPlan> {
  const heuristicFallback = (reason?: string) =>
    buildHeuristicPlan({
      issueTitle: params.issueTitle,
      issueBody: params.issueBody,
      contextHints: params.contextHints,
      verificationHints: params.verificationHints,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      reason,
    });

  if (!gemini) {
    return heuristicFallback("gemini_unavailable");
  }

  const context = {
    issue_title: params.issueTitle,
    issue_body: params.issueBody,
    ranked_files: (params.contextHints?.ranked_files || []).slice(0, 8),
    ranked_tests: (params.contextHints?.ranked_tests || []).slice(0, 5),
    verify_hints: params.verificationHints?.suggested_test_commands || [],
    checklist: params.verificationHints?.checklist || [],
    allowed_commands: params.allowedCommands,
  };

  const reasoningLevel = getReasoningLevel({
    issueTitle: params.issueTitle,
    issueBody: params.issueBody,
    inputChars: JSON.stringify(context).length,
    checklistCount: context.checklist.length,
    verifyHintCount: context.verify_hints.length,
    rankedFileCount: context.ranked_files.length,
    rankedTestCount: context.ranked_tests.length,
  });
  const model = pickGeminiModel(reasoningLevel);
  const thinkingConfig = buildGeminiThinkingConfig(model, reasoningLevel);

  const response = await gemini.models.generateContent({
    model,
    contents: [
      "Produce edit/verify/fix CLI commands for the issue below.",
      `Maximum commands per list: ${params.maxCommands}.`,
      `Maximum command length: ${params.maxCommandLength}.`,
      "Context JSON:",
      JSON.stringify(context, null, 2),
    ].join("\n"),
    config: {
      systemInstruction: KAIZEN_CLI_EXECUTION_INSTRUCTIONS,
      thinkingConfig,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          edit_commands: { type: "array", items: { type: "string" } },
          verify_commands: { type: "array", items: { type: "string" } },
          fix_commands: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "edit_commands", "verify_commands", "fix_commands"],
      },
    },
  });

  const parsed = JSON.parse((response.text || "{}") as string) as Record<string, unknown>;
  if (!isRecord(parsed)) {
    return heuristicFallback("autonomous_plan_invalid_response");
  }

  const editCommands = sanitizeCommands({
    commands: parsed.edit_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
  });
  const verifyCommands = sanitizeCommands({
    commands: parsed.verify_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
  });
  const fixCommands = sanitizeCommands({
    commands: parsed.fix_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
  });

  if (editCommands.length === 0) {
    return heuristicFallback("autonomous_plan_missing_edit_commands");
  }

  return {
    source: "llm",
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : "Generated autonomous CLI plan",
    editCommands,
    verifyCommands,
    fixCommands,
    model,
  };
}

export async function generateAutonomousCliRecoveryPlan(params: {
  issueTitle: string;
  issueBody: string;
  failedPhase: "edit" | "verify" | "fix";
  failedCommand: string;
  failedExitCode: number | null;
  failedTimedOut: boolean;
  failedBlockedReason: string | null;
  failedStdout: string;
  failedStderr: string;
  previousEditCommands: string[];
  previousFixCommands: string[];
  allowedCommands: string[];
  maxCommands: number;
  maxCommandLength: number;
}): Promise<AutonomousCliRecoveryPlan> {
  const heuristicFallback = (reason?: string) =>
    buildHeuristicAutonomousCliRecoveryPlan({
      failedCommand: params.failedCommand,
      failedExitCode: params.failedExitCode,
      failedTimedOut: params.failedTimedOut,
      failedBlockedReason: params.failedBlockedReason,
      failedStdout: params.failedStdout,
      failedStderr: params.failedStderr,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      reason,
    });

  if (!gemini) {
    return heuristicFallback("gemini_unavailable");
  }

  const context = {
    issue_title: params.issueTitle,
    issue_body: params.issueBody,
    failed_phase: params.failedPhase,
    failed_command: params.failedCommand,
    failed_exit_code: params.failedExitCode,
    failed_timed_out: params.failedTimedOut,
    failed_blocked_reason: params.failedBlockedReason,
    failed_stdout_tail: truncateTail(params.failedStdout, 600),
    failed_stderr_tail: truncateTail(params.failedStderr, 1200),
    previous_edit_commands: uniqCommands(params.previousEditCommands).slice(0, params.maxCommands),
    previous_fix_commands: uniqCommands(params.previousFixCommands).slice(0, params.maxCommands),
    allowed_commands: params.allowedCommands,
  };

  const reasoningLevel = getReasoningLevel({
    issueTitle: params.issueTitle,
    issueBody: params.issueBody,
    inputChars: JSON.stringify(context).length,
    checklistCount: 0,
    verifyHintCount: 0,
    rankedFileCount: 0,
    rankedTestCount: 0,
  });
  const model = pickGeminiModel(reasoningLevel);
  const thinkingConfig = buildGeminiThinkingConfig(model, reasoningLevel);

  const response = await gemini.models.generateContent({
    model,
    contents: [
      "A previous CLI command failed. Produce a safe recovery plan.",
      `Maximum commands per list: ${params.maxCommands}.`,
      `Maximum command length: ${params.maxCommandLength}.`,
      "Recovery context JSON:",
      JSON.stringify(context, null, 2),
    ].join("\n"),
    config: {
      systemInstruction: KAIZEN_CLI_EXECUTION_INSTRUCTIONS,
      thinkingConfig,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          edit_commands: { type: "array", items: { type: "string" } },
          fix_commands: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "edit_commands", "fix_commands"],
      },
    },
  });

  const parsed = JSON.parse((response.text || "{}") as string) as Record<string, unknown>;
  if (!isRecord(parsed)) {
    return heuristicFallback("autonomous_recovery_invalid_response");
  }

  const editCommands = sanitizeCommands({
    commands: parsed.edit_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
  });
  const fixCommands = sanitizeCommands({
    commands: parsed.fix_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
  });

  if (editCommands.length === 0 && fixCommands.length === 0) {
    return heuristicFallback("autonomous_recovery_missing_commands");
  }

  return {
    source: "llm",
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : "Generated autonomous recovery plan",
    editCommands,
    fixCommands,
    model,
  };
}
