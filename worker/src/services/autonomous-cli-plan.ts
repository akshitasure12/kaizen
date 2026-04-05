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
