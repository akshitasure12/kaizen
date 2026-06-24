import { GoogleGenAI } from "@google/genai";
import type { CliContextHints, VerificationHints } from "./cli-context-hints";
import {
  buildGeminiThinkingConfig,
  getReasoningLevel,
  pickGeminiModel,
} from "./gemini-orchestration";
import { KAIZEN_CLI_EXECUTION_INSTRUCTIONS } from "./cli-execution-instructions";
import { validateToolCommand } from "./tool-execution";
import {
  editActionsToCommands,
  sanitizeEditActions,
  type EditAction,
} from "./edit-actions";

const geminiApiKey = process.env.GEMINI_API_KEY;
const gemini = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const REQUIRED_ARTIFACT_PATH_RE =
  /(?:^|[\s`'"(])([A-Za-z0-9][A-Za-z0-9._/-]*\.[A-Za-z0-9]{1,12})(?=$|[\s`'"),.:;!?])/g;

export interface AutonomousCliPlan {
  source: "llm" | "heuristic";
  summary: string;
  editCommands: string[];
  editActionsV1?: EditAction[];
  verifyCommands: string[];
  fixCommands: string[];
  strictCandidatesAvailable?: boolean;
  probeOnlyVerificationJustification?: string;
  model?: string;
  error?: string;
}

export interface AutonomousCliRecoveryPlan {
  source: "llm" | "heuristic";
  summary: string;
  editCommands: string[];
  editActionsV1?: EditAction[];
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
  allowedCommands?: string[];
  error?: string;
}): AutonomousCliRecoveryPlan {
  return {
    source: "heuristic",
    summary: params.summary,
    editCommands: sanitizeCommands({
      commands: params.editCommands || [],
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      allowedCommands: params.allowedCommands,
    }),
    fixCommands: sanitizeCommands({
      commands: params.fixCommands || [],
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      allowedCommands: params.allowedCommands,
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
  allowedCommands?: string[];
  reason?: string;
}): AutonomousCliRecoveryPlan {
  const command = params.failedCommand.trim();
  const stderrLower = params.failedStderr.toLowerCase();

  const noRecovery = (summary: string): AutonomousCliRecoveryPlan =>
    buildRecoveryPlanWithCommands({
      summary,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      allowedCommands: params.allowedCommands,
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
      allowedCommands: params.allowedCommands,
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
      allowedCommands: params.allowedCommands,
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
      allowedCommands: params.allowedCommands,
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
        allowedCommands: params.allowedCommands,
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
      allowedCommands: params.allowedCommands,
      ...(params.reason ? { error: params.reason } : {}),
    });
  }

  return noRecovery("No safe heuristic recovery command identified");
}

function sanitizeCommands(params: {
  commands: unknown;
  maxCommands: number;
  maxCommandLength: number;
  allowedCommands?: string[];
}): string[] {
  const allowedSet = Array.isArray(params.allowedCommands)
    ? new Set(
        params.allowedCommands
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0),
      )
    : null;

  return uniqCommands(toStringArray(params.commands))
    .filter((command) => !command.includes("<path-to-file>"))
    .filter((command) => command.length <= params.maxCommandLength)
    .filter((command) => {
      if (!allowedSet) return true;
      const check = validateToolCommand({
        command,
        allowedCommands: allowedSet,
        maxCommandLength: params.maxCommandLength,
      });
      return check.ok;
    })
    .slice(0, params.maxCommands);
}

function normalizeArtifactPath(raw: string): string | null {
  const stripped = raw
    .trim()
    .replace(/^[`'"(]+/, "")
    .replace(/[`'"),.:;!?]+$/, "")
    .replace(/\\/g, "/");

  const normalized = stripped.startsWith("./") ? stripped.slice(2) : stripped;
  if (!normalized) return null;
  if (normalized.startsWith("/") || normalized.startsWith("-")) return null;
  if (normalized.includes("..") || normalized.includes("://")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) return null;
  return normalized;
}

export function extractRequiredArtifactPaths(issueTitle: string, issueBody: string): string[] {
  const blob = `${issueTitle}\n${issueBody}`;
  const matches: string[] = [];

  REQUIRED_ARTIFACT_PATH_RE.lastIndex = 0;
  let match = REQUIRED_ARTIFACT_PATH_RE.exec(blob);
  while (match) {
    const candidate = normalizeArtifactPath(match[1] || "");
    if (candidate) {
      matches.push(candidate);
    }
    match = REQUIRED_ARTIFACT_PATH_RE.exec(blob);
  }

  return uniqCommands(matches).slice(0, 6);
}

function buildRequiredArtifactVerifyCommands(params: {
  issueTitle: string;
  issueBody: string;
  requiredArtifacts?: string[];
  maxCommandLength: number;
}): string[] {
  const artifacts =
    params.requiredArtifacts && params.requiredArtifacts.length > 0
      ? uniqCommands(params.requiredArtifacts)
      : extractRequiredArtifactPaths(params.issueTitle, params.issueBody);

  return artifacts
    .map((path) => `ls ${path}`)
    .filter((command) => command.length <= params.maxCommandLength);
}

export function mergeRequiredArtifactVerifyCommands(params: {
  verifyCommands: string[];
  issueTitle: string;
  issueBody: string;
  requiredArtifacts?: string[];
  maxCommands: number;
  maxCommandLength: number;
  allowedCommands?: string[];
}): string[] {
  const requiredArtifactChecks = buildRequiredArtifactVerifyCommands({
    issueTitle: params.issueTitle,
    issueBody: params.issueBody,
    requiredArtifacts: params.requiredArtifacts,
    maxCommandLength: params.maxCommandLength,
  });

  return sanitizeCommands({
    commands: [...requiredArtifactChecks, ...params.verifyCommands],
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });
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

function buildHeuristicPlan(params: {
  issueTitle: string;
  issueBody: string;
  contextHints: CliContextHints | null;
  verificationHints: VerificationHints | null;
  requiredArtifacts?: string[];
  maxCommands: number;
  maxCommandLength: number;
  allowedCommands?: string[];
  reason?: string;
}): AutonomousCliPlan {
  const strictCandidates = sanitizeCommands({
    commands: params.contextHints?.command_suggestions.strict || [],
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });

  const baseVerifyCommands = uniqCommands([
    ...strictCandidates,
    ...toStringArray(params.verificationHints?.suggested_test_commands),
    ...toStringArray(params.contextHints?.command_suggestions.verify),
  ])
    .filter((command) => command.length <= params.maxCommandLength)
    .slice(0, params.maxCommands);

  const verifyCommands = mergeRequiredArtifactVerifyCommands({
    verifyCommands: baseVerifyCommands,
    issueTitle: params.issueTitle,
    issueBody: params.issueBody,
    requiredArtifacts: params.requiredArtifacts,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });

  const editActionsV1: EditAction[] = [];
  if (isDocsIssue(params.issueTitle, params.issueBody)) {
    const target = pickDocumentationTarget(params.contextHints);
    if (target) {
      const issueUrl = extractFirstUrl(params.issueBody);
      const note = issueUrl
        ? `Issue context: ${issueUrl}`
        : `Issue context: ${params.issueTitle}`;
      editActionsV1.push({
        type: "append_text",
        file_path: target,
        content: note,
      });
    }
  }

  const editCommands =
    editActionsV1.length > 0
      ? editActionsToCommands({
          actions: editActionsV1,
          maxCommands: params.maxCommands,
          maxCommandLength: params.maxCommandLength,
        })
      : [];

  return {
    source: "heuristic",
    summary:
      params.reason ||
      (editActionsV1.length > 0
        ? "Generated heuristic docs-safe edit command"
        : "No safe heuristic edit command available"),
    editCommands: editCommands.slice(0, params.maxCommands),
    ...(editActionsV1.length > 0 ? { editActionsV1 } : {}),
    verifyCommands,
    fixCommands: [],
    strictCandidatesAvailable: strictCandidates.length > 0,
    ...(strictCandidates.length === 0
      ? { probeOnlyVerificationJustification: "no strict verification candidates were discovered in context hints" }
      : {}),
    ...(params.reason ? { error: params.reason } : {}),
  };
}

export async function generateAutonomousCliPlan(params: {
  issueTitle: string;
  issueBody: string;
  contextHints: CliContextHints | null;
  verificationHints: VerificationHints | null;
  requiredArtifacts?: string[];
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
      requiredArtifacts: params.requiredArtifacts,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
      allowedCommands: params.allowedCommands,
      reason,
    });

  const requiredArtifacts =
    params.requiredArtifacts && params.requiredArtifacts.length > 0
      ? uniqCommands(params.requiredArtifacts)
      : extractRequiredArtifactPaths(
          params.issueTitle,
          params.issueBody,
        );

  if (!gemini) {
    return heuristicFallback("gemini_unavailable");
  }

  const context = {
    issue_title: params.issueTitle,
    issue_body: params.issueBody,
    ranked_files: (params.contextHints?.ranked_files || []).slice(0, 8),
    ranked_tests: (params.contextHints?.ranked_tests || []).slice(0, 5),
    verify_hints: params.verificationHints?.suggested_test_commands || [],
    strict_verify_hints: params.contextHints?.command_suggestions.strict || [],
    checklist: params.verificationHints?.checklist || [],
    required_artifacts: requiredArtifacts,
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
          edit_actions_v1: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                file_path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" },
                content: { type: "string" },
                create_if_missing: { type: "boolean" },
              },
              required: ["type", "file_path"],
            },
          },
          verify_commands: { type: "array", items: { type: "string" } },
          fix_commands: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "verify_commands", "fix_commands"],
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
    allowedCommands: params.allowedCommands,
  });
  const editActionsV1 = sanitizeEditActions({
    value: parsed.edit_actions_v1,
    maxActions: params.maxCommands,
    maxStringLength: Math.min(8000, params.maxCommandLength * 8),
  });
  const actionDerivedEditCommands = sanitizeCommands({
    commands: editActionsToCommands({
      actions: editActionsV1,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
    }),
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });
  const mergedEditCommands = uniqCommands([...editCommands, ...actionDerivedEditCommands]).slice(
    0,
    params.maxCommands,
  );
  const parsedVerifyCommands = sanitizeCommands({
    commands: parsed.verify_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });
  const verifyCommands = mergeRequiredArtifactVerifyCommands({
    verifyCommands: parsedVerifyCommands,
    issueTitle: params.issueTitle,
    issueBody: params.issueBody,
    requiredArtifacts,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });
  const fixCommands = sanitizeCommands({
    commands: parsed.fix_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });

  if (mergedEditCommands.length === 0 && editActionsV1.length === 0) {
    return heuristicFallback("autonomous_plan_missing_edit_commands");
  }

  return {
    source: "llm",
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : "Generated autonomous CLI plan",
    editCommands: mergedEditCommands,
    ...(editActionsV1.length > 0 ? { editActionsV1 } : {}),
    verifyCommands,
    fixCommands,
    strictCandidatesAvailable:
      sanitizeCommands({
        commands: params.contextHints?.command_suggestions.strict || [],
        maxCommands: params.maxCommands,
        maxCommandLength: params.maxCommandLength,
        allowedCommands: params.allowedCommands,
      }).length > 0,
    ...(verifyCommands.every((command) => command.startsWith("ls "))
      ? { probeOnlyVerificationJustification: "planner returned artifact probes without strict checks" }
      : {}),
    model,
  };
}

export async function generateAutonomousCliRecoveryPlan(params: {
  issueTitle: string;
  issueBody: string;
  failedPhase: "edit" | "verify" | "fix" | "quality_gate";
  failedCommand: string;
  failedExitCode: number | null;
  failedTimedOut: boolean;
  failedBlockedReason: string | null;
  failedStdout: string;
  failedStderr: string;
  failedLogPath?: string;
  failedLogSummary?: string;
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
      allowedCommands: params.allowedCommands,
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
    ...(params.failedLogPath ? { failed_log_path: params.failedLogPath } : {}),
    ...(params.failedLogSummary ? { failed_log_summary: params.failedLogSummary } : {}),
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
          edit_actions_v1: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                file_path: { type: "string" },
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" },
                content: { type: "string" },
                create_if_missing: { type: "boolean" },
              },
              required: ["type", "file_path"],
            },
          },
          fix_commands: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "fix_commands"],
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
    allowedCommands: params.allowedCommands,
  });
  const editActionsV1 = sanitizeEditActions({
    value: parsed.edit_actions_v1,
    maxActions: params.maxCommands,
    maxStringLength: Math.min(8000, params.maxCommandLength * 8),
  });
  const actionDerivedEditCommands = sanitizeCommands({
    commands: editActionsToCommands({
      actions: editActionsV1,
      maxCommands: params.maxCommands,
      maxCommandLength: params.maxCommandLength,
    }),
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });
  const mergedEditCommands = uniqCommands([...editCommands, ...actionDerivedEditCommands]).slice(
    0,
    params.maxCommands,
  );
  const fixCommands = sanitizeCommands({
    commands: parsed.fix_commands,
    maxCommands: params.maxCommands,
    maxCommandLength: params.maxCommandLength,
    allowedCommands: params.allowedCommands,
  });

  if (mergedEditCommands.length === 0 && editActionsV1.length === 0 && fixCommands.length === 0) {
    return heuristicFallback("autonomous_recovery_missing_commands");
  }

  return {
    source: "llm",
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim().length > 0
        ? parsed.summary.trim()
        : "Generated autonomous recovery plan",
    editCommands: mergedEditCommands,
    ...(editActionsV1.length > 0 ? { editActionsV1 } : {}),
    fixCommands,
    model,
  };
}
