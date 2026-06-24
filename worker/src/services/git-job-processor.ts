import fs from "fs/promises";
import os from "os";
import path from "path";
import { Octokit } from "@octokit/rest";
import simpleGit, { type SimpleGit } from "simple-git";
import { pool, query, queryOne } from "../db/client";
import { env } from "../env";
import { getGitHubLinkForRepo, getGitHubTokenForUser } from "./github-integration";
import * as bountyService from "./bounty";
import {
  parseJobCliHints,
  refineCliHintsForWorkspace,
  renderKaizenAgentNote,
  type CliContextHints,
} from "./cli-context-hints";
import {
  generateAutonomousCliPlan,
  generateAutonomousCliRecoveryPlan,
  extractRequiredArtifactPaths,
  type AutonomousCliPlan,
  type AutonomousCliRecoveryPlan,
} from "./autonomous-cli-plan";
import { judgeGitDiffContext, passesPrePrJudgeSelfCheck, storeJudgement, type JudgeResult, type Scorecard } from "./judge";
import {
  executeToolCommand,
  validateToolCommand,
  type ToolExecutionResult as CommandExecutionResult,
} from "./tool-execution";
import {
  editActionsToCommands,
  sanitizeEditActions,
  type EditAction,
} from "./edit-actions";
import {
  collectEditActionPaths,
  FileEditStateTracker,
} from "./file-edit-state";
import {
  persistCommandLog,
  summarizeLogForRecovery,
} from "./command-log-persistence";
import { evaluatePostLoopQualityGates, type PostLoopGateResult } from "./post-loop-quality-gates";
import {
  buildInitialKaizenPlan,
  summarizeKaizenPlanPhases,
  updateKaizenPlanArtifact,
  writeKaizenPlanArtifact,
} from "./kaizen-plan-artifact";

interface GitJobRow {
  id: string;
  issue_id: string;
  repo_id: string;
  user_id: string;
  agent_id: string;
  base_branch: string;
  status: string;
  stage: string;
  lease_token: string | null;
  attempt_count: number;
  attempt: number;
  max_attempts: number;
  branch_name: string | null;
  github_pr_number: number | null;
  judge_comment_id: number | null;
  diff_summary_json: unknown;
  payload: Record<string, unknown> | null;
}

interface EditLoopSummary {
  passed: boolean;
  cycles: number;
  editActionsV1?: EditAction[];
  editCommands: string[];
  verifyCommands: string[];
  fixCommands: string[];
  strictCandidateCommands?: string[];
  verifyGateDecision?: VerifyGateDecisionReason;
  verifyGateReason?: string;
  probeOnlyVerification?: boolean;
  commandResults: CommandExecutionResult[];
  recoveryPlans: EditLoopRecoverySummary[];
  lastFailedVerifyLogPath?: string;
  lastFailedVerifyLogSummary?: string;
}

interface EditLoopRecoverySummary {
  cycle: number;
  source: "llm" | "heuristic";
  summary: string;
  model?: string;
  error?: string;
  failedCommand: string;
  replacementEditActionsV1?: EditAction[];
  replacementEditCommands: string[];
  recoveryFixCommands: string[];
}

interface ResolvedAutonomousPlan {
  source: "llm" | "heuristic";
  summary: string;
  model?: string;
  error?: string;
  editCommands: string[];
  editActionsV1?: EditAction[];
  verifyCommands: string[];
  fixCommands: string[];
}

type ErrorClass = "transient" | "permanent";

const workerInstanceId = env.WORKER_INSTANCE_ID || `${os.hostname()}-${process.pid}`;
const allowedToolCommands = new Set(env.WORKER_ALLOWED_COMMANDS.map((value) => value.toLowerCase()));
const placeholderPatterns = env.WORKER_PLACEHOLDER_PATTERNS.map((value) => value.toLowerCase());

interface DiffQualityMetrics {
  addedSubstantiveChars: number;
  substantiveHunks: number;
  placeholderLineCount: number;
}

interface AssignmentExcerpt {
  title: string;
  body: string;
}

type VerifyGateDecisionReason =
  | "note_only"
  | "strict_verification_not_required"
  | "sufficient_strict_commands_found"
  | "strict_candidates_available_but_not_used"
  | "probe_only_allowed_no_strict_candidates"
  | "probe_only_disabled"
  | "no_verify_commands";

interface VerifyGateDecision {
  allow: boolean;
  reason: VerifyGateDecisionReason;
  strictVerifyCount: number;
  strictCandidatesAvailable: boolean;
  probeOnlyVerification: boolean;
  detail: string;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "issue"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractAssignmentExcerpts(payload: Record<string, unknown> | null): AssignmentExcerpt[] {
  if (!payload || !isRecord(payload)) return [];
  const orchestration = payload.orchestration;
  if (!isRecord(orchestration)) return [];

  const out: AssignmentExcerpt[] = [];
  const pushAssignment = (entry: unknown) => {
    if (!isRecord(entry)) return;
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    const body = typeof entry.body === "string" ? entry.body.trim() : "";
    if (!title && !body) return;
    out.push({ title, body });
  };

  if (Array.isArray(orchestration.child_assignments)) {
    for (const entry of orchestration.child_assignments) {
      pushAssignment(entry);
    }
  }

  const decomposition = orchestration.decomposition;
  if (isRecord(decomposition) && Array.isArray(decomposition.children)) {
    for (const entry of decomposition.children) {
      pushAssignment(entry);
    }
  }

  return out;
}

function buildOrchestrationExecutionBrief(payload: Record<string, unknown> | null): string {
  if (!payload || !isRecord(payload)) return "";
  const orchestration = payload.orchestration;
  if (!isRecord(orchestration)) return "";

  const lines: string[] = [];
  if (typeof orchestration.mode === "string" && orchestration.mode.trim().length > 0) {
    lines.push(`Execution mode: ${orchestration.mode.trim()}`);
  }
  if (
    typeof orchestration.parent_issue_id === "string" &&
    orchestration.parent_issue_id.trim().length > 0
  ) {
    lines.push(`Parent issue: ${orchestration.parent_issue_id.trim()}`);
  }

  const assignments = extractAssignmentExcerpts(payload);
  if (assignments.length > 0) {
    lines.push("Child assignment requirements:");
    for (const assignment of assignments.slice(0, 20)) {
      const title = assignment.title || "(untitled)";
      lines.push(`- ${title}`);
      if (assignment.body) {
        lines.push(`  ${assignment.body}`);
      }
    }
  }

  return lines.join("\n").trim();
}

export function deriveRequiredArtifactsForJob(params: {
  issueTitle: string;
  issueBody: string;
  payload: Record<string, unknown> | null;
  contextHints: CliContextHints | null;
}): string[] {
  const snippets: string[] = [params.issueBody || ""];
  const assignmentExcerpts = extractAssignmentExcerpts(params.payload);
  for (const assignment of assignmentExcerpts) {
    if (assignment.title) snippets.push(assignment.title);
    if (assignment.body) snippets.push(assignment.body);
  }

  if (params.contextHints?.ranked_files?.length) {
    snippets.push(
      ...params.contextHints.ranked_files
        .slice(0, Math.max(3, env.CLI_CONTEXT_HINTS_MAX_FILES))
        .map((hint) => hint.path),
    );
  }

  return extractRequiredArtifactPaths(params.issueTitle, snippets.join("\n"));
}

export function buildDefaultBranchName(params: {
  jobId: string;
  issueId: string;
  issueTitle: string;
}): string {
  const base = `agent/${params.issueId.slice(0, 8)}-${slug(params.issueTitle)}-${params.jobId.slice(0, 8)}`;
  return base.slice(0, 120);
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function classifyError(message: string): ErrorClass {
  const m = message.toLowerCase();
  if (
    m.includes("gemini_unavailable") ||
    m.includes("resource_exhausted") ||
    m.includes("rate limit") ||
    m.includes("secondary rate") ||
    m.includes("http 429") ||
    m.includes("http 502") ||
    m.includes("http 503") ||
    (m.includes("403") && m.includes("rate")) ||
    m.includes("timeout") ||
    m.includes("temporar") ||
    m.includes("econnreset") ||
    m.includes("enotfound") ||
    m.includes("network") ||
    m.includes("eai_again")
  ) {
    return "transient";
  }
  return "permanent";
}

export function isNonFastForwardPushError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("non-fast-forward") ||
    m.includes("fetch first") ||
    m.includes("failed to push some refs") ||
    m.includes("updates were rejected because the remote contains work") ||
    (m.includes("[rejected]") && m.includes("(fetch first)"))
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readFetchedHeadSha(git: Pick<SimpleGit, "raw">): Promise<string | null> {
  try {
    const output = (await git.raw(["rev-parse", "FETCH_HEAD"])) || "";
    const value = output.trim().split(/\s+/)[0] || "";
    return /^[0-9a-f]{40}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function forcePushWithLease(params: {
  git: Pick<SimpleGit, "raw">;
  branchName: string;
  expectedRemoteSha: string | null;
}): Promise<void> {
  const targetRef = `refs/heads/${params.branchName}`;
  const leaseArg = params.expectedRemoteSha
    ? `--force-with-lease=${targetRef}:${params.expectedRemoteSha}`
    : `--force-with-lease=${targetRef}`;
  await params.git.raw(["push", leaseArg, "origin", `HEAD:${targetRef}`]);
}

export async function pushBranchWithRecovery(params: {
  git: Pick<SimpleGit, "push" | "fetch" | "raw">;
  branchName: string;
  onRecoveryStart?: (details: { initialError: string }) => Promise<void>;
}): Promise<{ recovered: boolean; strategy: "none" | "rebase" | "force_with_lease" }> {
  try {
    await params.git.push("origin", params.branchName);
    return { recovered: false, strategy: "none" };
  } catch (pushError: unknown) {
    const initialError = toErrorMessage(pushError);
    if (!isNonFastForwardPushError(initialError)) {
      throw pushError;
    }

    if (params.onRecoveryStart) {
      await params.onRecoveryStart({ initialError });
    }

    try {
      await params.git.fetch("origin", params.branchName);
    } catch (fetchError: unknown) {
      const fetchMessage = toErrorMessage(fetchError);
      throw new Error(
        `Push rejected for '${params.branchName}' (non-fast-forward); failed to fetch remote branch before retry: ${fetchMessage}`,
      );
    }

    let fetchedHeadSha = await readFetchedHeadSha(params.git);

    try {
      // Fetch may update FETCH_HEAD without creating origin/<branch> locally.
      await params.git.raw(["rebase", "FETCH_HEAD"]);
    } catch (rebaseError: unknown) {
      try {
        await params.git.raw(["rebase", "--abort"]);
      } catch {
        // noop: best-effort cleanup after failed rebase
      }
      const rebaseMessage = toErrorMessage(rebaseError);
      try {
        await forcePushWithLease({
          git: params.git,
          branchName: params.branchName,
          expectedRemoteSha: fetchedHeadSha,
        });
        return { recovered: true, strategy: "force_with_lease" };
      } catch (forceError: unknown) {
        const forceMessage = toErrorMessage(forceError);
        throw new Error(
          `Push rejected for '${params.branchName}' (non-fast-forward); automatic rebase onto fetched remote head failed: ${rebaseMessage}; force-with-lease fallback failed: ${forceMessage}`,
        );
      }
    }

    try {
      await params.git.push("origin", params.branchName);
    } catch (retryError: unknown) {
      const retryMessage = toErrorMessage(retryError);
      if (isNonFastForwardPushError(retryMessage)) {
        try {
          await params.git.fetch("origin", params.branchName);
          fetchedHeadSha = await readFetchedHeadSha(params.git);
          await forcePushWithLease({
            git: params.git,
            branchName: params.branchName,
            expectedRemoteSha: fetchedHeadSha,
          });
          return { recovered: true, strategy: "force_with_lease" };
        } catch (forceError: unknown) {
          const forceMessage = toErrorMessage(forceError);
          throw new Error(
            `Push retry failed after reconciling branch '${params.branchName}': ${retryMessage}; force-with-lease fallback failed: ${forceMessage}`,
          );
        }
      }
      throw new Error(
        `Push retry failed after reconciling branch '${params.branchName}': ${retryMessage}`,
      );
    }

    return { recovered: true, strategy: "rebase" };
  }
}

export function retryBackoffMs(attempt: number): number {
  const power = Math.max(0, attempt - 1);
  const value = env.WORKER_BASE_RETRY_MS * Math.pow(2, power);
  const capped = Math.min(env.WORKER_MAX_RETRY_MS, Math.floor(value));
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(capped * 0.2)));
  return Math.min(env.WORKER_MAX_RETRY_MS, capped + jitter);
}

export function passesAwaitingMergeScoreGate(params: {
  score: number;
  minScore: number;
}): boolean {
  if (params.minScore <= 0) return true;
  return params.score >= params.minScore;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function normalizeForSubstance(value: string): string {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/(^|\n)\s*\/\/.*$/gm, " ")
    .replace(/(^|\n)\s*#.*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderOnlyLine(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!normalized) return false;
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > 4) return false;
  return tokens.every((token) => placeholderPatterns.includes(token));
}

export function computeDiffQualityMetrics(diffText: string): DiffQualityMetrics {
  const lines = diffText.split("\n");
  let addedSubstantiveChars = 0;
  let placeholderLineCount = 0;
  let currentHunkHasSubstantiveChanges = false;
  let substantiveHunks = 0;

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (currentHunkHasSubstantiveChanges) substantiveHunks += 1;
      currentHunkHasSubstantiveChanges = false;
      continue;
    }

    if (!line.startsWith("+") || line.startsWith("+++ ")) {
      continue;
    }

    const addedLine = line.slice(1);
    if (isPlaceholderOnlyLine(addedLine)) {
      placeholderLineCount += 1;
    }

    const normalized = normalizeForSubstance(addedLine);
    if (normalized.length > 0) {
      currentHunkHasSubstantiveChanges = true;
      addedSubstantiveChars += normalized.length;
    }
  }

  if (currentHunkHasSubstantiveChanges) substantiveHunks += 1;

  return {
    addedSubstantiveChars,
    substantiveHunks,
    placeholderLineCount,
  };
}

function countStrictVerificationCommands(commands: string[]): number {
  return commands.filter((command) => isStrictVerificationCommand(command)).length;
}

export function resolveVerifyGateDecision(params: {
  verifyCommands: string[];
  strictCandidateCommands: string[];
  requireStrictVerify: boolean;
  minStrictVerifyCommands: number;
  allowNoteOnly: boolean;
  verifyGateMode: "log" | "warn" | "strict";
  allowProbeOnlyWhenNoStrictCandidates: boolean;
}): VerifyGateDecision {
  const strictVerifyCount = countStrictVerificationCommands(params.verifyCommands);
  const strictCandidatesAvailable = params.strictCandidateCommands.length > 0;
  const probeOnlyVerification = params.verifyCommands.length > 0 && strictVerifyCount === 0;

  if (params.allowNoteOnly) {
    return {
      allow: true,
      reason: "note_only",
      strictVerifyCount,
      strictCandidatesAvailable,
      probeOnlyVerification,
      detail: "note_only mode enabled",
    };
  }

  if (params.verifyCommands.length === 0) {
    return {
      allow: false,
      reason: "no_verify_commands",
      strictVerifyCount,
      strictCandidatesAvailable,
      probeOnlyVerification,
      detail: "no verification commands provided",
    };
  }

  if (!params.requireStrictVerify) {
    return {
      allow: true,
      reason: "strict_verification_not_required",
      strictVerifyCount,
      strictCandidatesAvailable,
      probeOnlyVerification,
      detail: "strict verification disabled by policy",
    };
  }

  if (strictVerifyCount >= params.minStrictVerifyCommands) {
    return {
      allow: true,
      reason: "sufficient_strict_commands_found",
      strictVerifyCount,
      strictCandidatesAvailable,
      probeOnlyVerification,
      detail: `strict verification satisfied: required ${params.minStrictVerifyCommands}, got ${strictVerifyCount}`,
    };
  }

  if (strictCandidatesAvailable) {
    const strictMessage = `insufficient_strict_verify: required ${params.minStrictVerifyCommands}, got ${strictVerifyCount}; strict candidates were available`;
    if (params.verifyGateMode === "strict") {
      return {
        allow: false,
        reason: "strict_candidates_available_but_not_used",
        strictVerifyCount,
        strictCandidatesAvailable,
        probeOnlyVerification,
        detail: strictMessage,
      };
    }

    return {
      allow: true,
      reason: "strict_candidates_available_but_not_used",
      strictVerifyCount,
      strictCandidatesAvailable,
      probeOnlyVerification,
      detail: strictMessage,
    };
  }

  if (!params.allowProbeOnlyWhenNoStrictCandidates) {
    return {
      allow: false,
      reason: "probe_only_disabled",
      strictVerifyCount,
      strictCandidatesAvailable,
      probeOnlyVerification,
      detail: "probe-only verification is disabled by policy when strict candidates are unavailable",
    };
  }

  return {
    allow: true,
    reason: "probe_only_allowed_no_strict_candidates",
    strictVerifyCount,
    strictCandidatesAvailable,
    probeOnlyVerification,
    detail: "strict candidates unavailable; probe-only verification allowed with elevated artifact quality checks",
  };
}

async function validateRequiredArtifactContent(params: {
  workDir: string;
  requiredArtifacts: string[];
  minSubstantiveChars?: number;
}): Promise<{ ok: boolean; reason?: string }> {
  const minSubstantiveChars = Math.max(1, params.minSubstantiveChars ?? 24);
  for (const artifactPath of params.requiredArtifacts) {
    const absolutePath = path.resolve(params.workDir, artifactPath);
    const relativePath = path.relative(params.workDir, absolutePath).replace(/\\/g, "/");
    if (relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
      return { ok: false, reason: `required artifact path is unsafe: ${artifactPath}` };
    }

    let content = "";
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      return { ok: false, reason: `required artifact missing: ${artifactPath}` };
    }

    const normalized = normalizeForSubstance(content);
    if (normalized.length < minSubstantiveChars) {
      return {
        ok: false,
        reason: `required artifact content is too small: ${artifactPath} (min ${minSubstantiveChars} substantive chars)`,
      };
    }
    if (isPlaceholderOnlyLine(normalized)) {
      return { ok: false, reason: `required artifact looks like placeholder-only content: ${artifactPath}` };
    }
  }

  return { ok: true };
}

async function evaluatePostLoopGatesForWorkspace(params: {
  git: SimpleGit;
  workDir: string;
  requiredArtifacts: string[];
  allowNoteOnly: boolean;
  probeOnlyVerification?: boolean;
}): Promise<{
  gateResult: PostLoopGateResult;
  implementationChanges: string[];
  diffQuality: DiffQualityMetrics;
}> {
  const workspaceStatus = await params.git.status();
  const changedPaths = workspaceStatus.files.map((file) => file.path);
  const implementationChanges = changedPaths.filter((value) => value !== "KAIZEN_AGENT.md");

  let artifactCheckOk = true;
  let artifactCheckReason: string | undefined;
  if (!params.allowNoteOnly) {
    const artifactCheck = await validateRequiredArtifactContent({
      workDir: params.workDir,
      requiredArtifacts: params.requiredArtifacts,
      minSubstantiveChars: params.probeOnlyVerification
        ? env.WORKER_PROBE_ONLY_MIN_ARTIFACT_SUBSTANCE
        : 24,
    });
    artifactCheckOk = artifactCheck.ok;
    artifactCheckReason = artifactCheck.reason;
  }

  const preCommitDiffText = (await params.git.diff()) || "";
  const diffQuality = computeDiffQualityMetrics(preCommitDiffText);
  const gateResult = evaluatePostLoopQualityGates({
    workspaceFileCount: workspaceStatus.files.length,
    implementationFileCount: implementationChanges.length,
    allowNoteOnly: params.allowNoteOnly,
    artifactCheckOk,
    artifactCheckReason,
    diffQuality,
    minImplementationFiles: env.WORKER_MIN_IMPLEMENTATION_FILES_CHANGED,
    minSubstantiveChars: env.WORKER_MIN_SUBSTANTIVE_ADDED_CHARS,
    minSubstantiveHunks: env.WORKER_MIN_SUBSTANTIVE_HUNKS,
    rejectPlaceholderDiffs: env.WORKER_REJECT_PLACEHOLDER_DIFFS,
  });

  return { gateResult, implementationChanges, diffQuality };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function commandLooksLikeNonBlockingProbe(command: string): boolean {
  const c = command.toLowerCase();
  if (c.includes("--help") || c.includes("|| true")) return true;

  const executable = c.split(/\s+/).filter((token) => token.length > 0)[0] || "";
  return (
    executable === "rg" ||
    executable === "grep" ||
    executable === "sed" ||
    executable === "cat" ||
    executable === "ls" ||
    executable === "find"
  );
}

function commandExecutable(command: string): string {
  const token = command
    .trim()
    .split(/\s+/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  return token ? token.toLowerCase() : "";
}

function looksLikeMissingArtifactFailure(result: CommandExecutionResult): boolean {
  if (result.blockedReason || result.timedOut || result.exitCode === 0) return false;

  const executable = commandExecutable(result.command);
  const artifactProbeCommand =
    executable === "ls" ||
    executable === "cat" ||
    executable === "sed" ||
    executable === "grep" ||
    executable === "rg" ||
    executable === "find" ||
    executable === "test" ||
    executable === "stat";

  if (!artifactProbeCommand) {
    return false;
  }

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    output.includes("no such file") ||
    output.includes("cannot access") ||
    output.includes("can't open") ||
    output.includes("does not exist") ||
    output.includes("not found")
  );
}

function isStrictVerificationCommand(command: string): boolean {
  return !commandLooksLikeNonBlockingProbe(command);
}

function uniqCommands(commands: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const command of commands) {
    const normalized = command.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function uniqStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function parseIntSafe(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  return 0;
}

export function normalizeWorkflowDiffFiles(
  files: Array<{ file: string; insertions?: unknown; deletions?: unknown }>,
): Array<{ file: string; insertions: number; deletions: number }> {
  return files.map((file) => ({
    file: file.file,
    insertions: parseIntSafe(file.insertions),
    deletions: parseIntSafe(file.deletions),
  }));
}

function encodeGitHubPath(pathValue: string): string {
  return pathValue
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function buildGitHubFileUrl(params: {
  owner: string;
  repo: string;
  branchName: string;
  filePath: string;
}): string {
  const encodedPath = encodeGitHubPath(params.filePath);
  return `https://github.com/${params.owner}/${params.repo}/blob/${encodeURIComponent(params.branchName)}/${encodedPath}`;
}

export function parseDiffLineAnchors(params: {
  diffText: string;
  owner: string;
  repo: string;
  branchName: string;
  maxAnchors?: number;
}): Array<{ path: string; startLine: number; endLine: number; url: string }> {
  const maxAnchors = Math.max(1, params.maxAnchors ?? 24);
  const lines = params.diffText.split("\n");
  const anchors: Array<{ path: string; startLine: number; endLine: number; url: string }> = [];
  const seen = new Set<string>();
  let currentPath: string | null = null;
  const root = `https://github.com/${params.owner}/${params.repo}/blob/${encodeURIComponent(params.branchName)}`;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const parts = line.trim().split(/\s+/);
      const bPath = parts[3] || "";
      currentPath = bPath.startsWith("b/") ? bPath.slice(2) : null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const value = line.slice(4).trim();
      if (value.startsWith("b/")) {
        currentPath = value.slice(2);
      }
      continue;
    }

    if (!currentPath || !line.startsWith("@@ ")) {
      continue;
    }

    const hunk = line.match(/\+(\d+)(?:,(\d+))?/);
    if (!hunk) continue;
    const startLine = Number.parseInt(hunk[1] || "0", 10);
    if (!Number.isFinite(startLine) || startLine <= 0) continue;
    const count = Number.parseInt(hunk[2] || "1", 10);
    const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
    const endLine = startLine + safeCount - 1;
    const key = `${currentPath}:${startLine}:${endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const encodedPath = encodeGitHubPath(currentPath);
    anchors.push({
      path: currentPath,
      startLine,
      endLine,
      url:
        endLine > startLine
          ? `${root}/${encodedPath}#L${startLine}-L${endLine}`
          : `${root}/${encodedPath}#L${startLine}`,
    });
    if (anchors.length >= maxAnchors) break;
  }

  return anchors;
}

function summarizeCommandResults(results: CommandExecutionResult[]): {
  total: number;
  failed: number;
  blocked: number;
  timedOut: number;
  byPhase: Record<string, number>;
} {
  const byPhase: Record<string, number> = { edit: 0, verify: 0, fix: 0 };
  let failed = 0;
  let blocked = 0;
  let timedOut = 0;

  for (const result of results) {
    byPhase[result.phase] = (byPhase[result.phase] || 0) + 1;
    if (result.blockedReason || result.timedOut || result.exitCode !== 0) {
      failed += 1;
    }
    if (result.blockedReason) blocked += 1;
    if (result.timedOut) timedOut += 1;
  }

  return {
    total: results.length,
    failed,
    blocked,
    timedOut,
    byPhase,
  };
}

export function buildPullRequestWorkflowBody(params: {
  job: GitJobRow;
  issueTitle: string;
  issueBody: string;
  owner: string;
  repo: string;
  branchName: string;
  baseBranch: string;
  agentEns: string;
  autonomousPlan: ResolvedAutonomousPlan | null;
  editLoop: EditLoopSummary;
  diffSummary: {
    changed: number;
    insertions: number;
    deletions: number;
    files: Array<{ file: string; insertions: number | string; deletions: number | string }>;
  };
  diffText: string;
}): string {
  const orchestration =
    params.job.payload && typeof params.job.payload.orchestration === "object"
      ? (params.job.payload.orchestration as Record<string, unknown>)
      : null;
  const mode = typeof orchestration?.mode === "string" ? orchestration.mode : "single_agent";
  const parentIssueId =
    typeof orchestration?.parent_issue_id === "string" ? orchestration.parent_issue_id : null;
  const childIndex =
    typeof orchestration?.child_index === "number"
      ? orchestration.child_index
      : typeof orchestration?.child_index === "string"
        ? Number.parseInt(orchestration.child_index, 10)
        : null;
  const complexityScore =
    typeof orchestration?.plan_complexity_score === "number"
      ? orchestration.plan_complexity_score
      : null;
  const decomposition =
    orchestration && typeof orchestration.decomposition === "object"
      ? (orchestration.decomposition as {
          used?: unknown;
          reasons?: unknown;
          children?: unknown;
        })
      : null;
  const decompositionUsed = decomposition?.used === true;
  const decompositionReasons = Array.isArray(decomposition?.reasons)
    ? decomposition.reasons
        .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
        .slice(0, 8)
    : [];
  const decompositionChildren = Array.isArray(decomposition?.children)
    ? decomposition.children
        .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
        .map((entry) => ({
          issueId: typeof entry.issue_id === "string" ? entry.issue_id : "",
          title: typeof entry.title === "string" ? entry.title : "",
          body: typeof entry.body === "string" ? entry.body : "",
          agentEns: typeof entry.agent_ens === "string" ? entry.agent_ens : "",
          assignmentReason:
            typeof entry.assignment_reason === "string" ? entry.assignment_reason : "",
        }))
        .filter((entry) => entry.issueId || entry.title || entry.agentEns)
        .slice(0, 20)
    : [];

  const commandSummary = summarizeCommandResults(params.editLoop.commandResults);
  const anchors = parseDiffLineAnchors({
    diffText: params.diffText,
    owner: params.owner,
    repo: params.repo,
    branchName: params.branchName,
  });
  const topAnchors = anchors.slice(0, 12);
  const changedFiles = params.diffSummary.files.slice(0, 20);
  const changedFilesWithLinks = changedFiles.map((file) => ({
    ...file,
    url: buildGitHubFileUrl({
      owner: params.owner,
      repo: params.repo,
      branchName: params.branchName,
      filePath: file.file,
    }),
  }));

  const sections: string[] = [];
  sections.push(`## Kaizen Workflow Report`);
  sections.push(`<!-- kaizen-workflow:${params.job.id} -->`);
  sections.push("");
  sections.push(`### Issue`);
  sections.push(`- Title: ${params.issueTitle}`);
  sections.push(`- Issue ID: \`${params.job.issue_id}\``);
  if (params.issueBody.trim().length > 0) {
    sections.push(`- Spec excerpt: ${truncateText(params.issueBody.trim(), 260)}`);
  }
  sections.push("");
  sections.push(`### Agent Attribution`);
  sections.push(`- Producer agent: \`${params.agentEns}\``);
  sections.push(`- Job ID: \`${params.job.id}\``);
  sections.push(`- Branch: \`${params.branchName}\``);
  sections.push(`- Base branch: \`${params.baseBranch}\``);
  sections.push("");
  sections.push(`### Orchestration Decisions`);
  sections.push(`- Mode: \`${mode}\``);
  if (parentIssueId) {
    sections.push(`- Parent issue: \`${parentIssueId}\``);
  }
  if (typeof childIndex === "number" && Number.isFinite(childIndex)) {
    sections.push(`- Child index: ${childIndex}`);
  }
  if (complexityScore != null) {
    sections.push(`- Planner complexity score: ${complexityScore.toFixed(3)}`);
  }
  sections.push(`- Decomposition used: ${decompositionUsed}`);
  if (decompositionReasons.length > 0) {
    sections.push(`- Decomposition reasons: ${decompositionReasons.join(", ")}`);
  }
  if (decompositionChildren.length > 0) {
    sections.push(`- Decomposition child issues and assigned agents:`);
    for (const child of decompositionChildren) {
      const title = child.title || "(untitled child issue)";
      const childIdSuffix = child.issueId ? ` · ${child.issueId}` : "";
      const childAgent = child.agentEns ? ` · ${child.agentEns}` : "";
      const childReason = child.assignmentReason ? ` · ${child.assignmentReason}` : "";
      sections.push(`  - ${title}${childIdSuffix}${childAgent}${childReason}`);
      if (child.body) {
        sections.push(`    - Why: ${truncateText(child.body, 240)}`);
      }
    }
  }
  sections.push("");
  sections.push(`### Planning And Execution`);
  sections.push(`- Autonomous plan source: \`${params.autonomousPlan?.source || "payload_or_manual"}\``);
  if (params.autonomousPlan?.summary) {
    sections.push(`- Autonomous plan summary: ${params.autonomousPlan.summary}`);
  }
  if (params.autonomousPlan?.model) {
    sections.push(`- Planner model: \`${params.autonomousPlan.model}\``);
  }
  sections.push(`- Edit loop passed: ${params.editLoop.passed}`);
  sections.push(`- Edit loop cycles: ${params.editLoop.cycles}`);
  sections.push(`- Recovery plans applied: ${params.editLoop.recoveryPlans.length}`);
  sections.push(
    `- Command results: total=${commandSummary.total}, failed=${commandSummary.failed}, blocked=${commandSummary.blocked}, timed_out=${commandSummary.timedOut}`,
  );
  sections.push(
    `- Command phase counts: edit=${commandSummary.byPhase.edit || 0}, verify=${commandSummary.byPhase.verify || 0}, fix=${commandSummary.byPhase.fix || 0}`,
  );
  sections.push("");
  sections.push(`### Diff Summary`);
  sections.push(
    `- Changed files: ${params.diffSummary.changed}, insertions: ${params.diffSummary.insertions}, deletions: ${params.diffSummary.deletions}`,
  );
  if (changedFiles.length > 0) {
    sections.push(`- File deltas:`);
    for (const file of changedFilesWithLinks) {
      sections.push(
        `  - [${file.file}](${file.url}) (+${parseIntSafe(file.insertions)}, -${parseIntSafe(file.deletions)})`,
      );
    }
  }
  if (topAnchors.length > 0) {
    sections.push(`- File and line links:`);
    for (const anchor of topAnchors) {
      const label =
        anchor.endLine > anchor.startLine
          ? `${anchor.path}:${anchor.startLine}-${anchor.endLine}`
          : `${anchor.path}:${anchor.startLine}`;
      sections.push(`  - [${label}](${anchor.url})`);
    }
  }
  sections.push("");
  sections.push(`### Changes By Agent`);
  sections.push(
    `- ${params.agentEns}: produced this PR's implementation changes across ${changedFilesWithLinks.length} files.`,
  );
  if (changedFilesWithLinks.length > 0) {
    for (const file of changedFilesWithLinks.slice(0, 12)) {
      sections.push(`  - [${file.file}](${file.url})`);
    }
  }
  sections.push("");
  sections.push(`### Repository`);
  sections.push(`- Compare view: https://github.com/${params.owner}/${params.repo}/compare/${encodeURIComponent(params.baseBranch)}...${encodeURIComponent(params.branchName)}`);

  return sections.join("\n");
}

function isBooleanFalse(value: unknown): boolean {
  return value === false || value === "false" || value === "0";
}

function filterExecutableCommands(commands: string[]): string[] {
  const valid: string[] = [];
  for (const command of commands) {
    const check = validateToolCommand({
      command,
      allowedCommands: allowedToolCommands,
      maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
    });
    if (check.ok) {
      valid.push(command);
    }
  }
  return valid;
}

function compactCommandResult(result: CommandExecutionResult): Record<string, unknown> {
  return {
    phase: result.phase,
    cycle: result.cycle,
    command: result.command,
    command_bin: result.executable,
    command_args: result.args,
    action_type: result.actionType || null,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    blocked_reason: result.blockedReason,
    stdout_tail: truncateText(result.stdout, 800),
    stderr_tail: truncateText(result.stderr, 800),
  };
}

export function commandFailureSignature(result: CommandExecutionResult): string {
  const stderrTail = truncateText(result.stderr, 240).replace(/\s+/g, " ").trim();
  const stdoutTail = truncateText(result.stdout, 120).replace(/\s+/g, " ").trim();
  const blocked = result.blockedReason || "";
  return [
    result.phase,
    result.command,
    String(result.exitCode),
    String(result.timedOut),
    blocked,
    stderrTail,
    stdoutTail,
  ].join("|");
}

async function recordToolExecution(jobId: string, result: CommandExecutionResult): Promise<void> {
  try {
    await query(
      `INSERT INTO tool_execution_logs (
         git_job_id,
         phase,
         cycle,
         command_text,
         command_bin,
         command_args_json,
         execution_status,
         exit_code,
         signal,
         timed_out,
         duration_ms,
         stdout_tail,
         stderr_tail,
         blocked_reason
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        jobId,
        result.phase,
        result.cycle,
        result.command,
        result.executable,
        JSON.stringify(
          result.actionType
            ? [...result.args, { __action_type: result.actionType }]
            : result.args,
        ),
        result.blockedReason ? "blocked" : "executed",
        result.exitCode,
        result.signal,
        result.timedOut,
        result.durationMs,
        truncateText(result.stdout, 4000),
        truncateText(result.stderr, 4000),
        result.blockedReason,
      ],
    );
  } catch (error) {
    console.error("[worker] failed to persist tool execution log", {
      job_id: jobId,
      command: result.command,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function resolveVerificationCommands(params: {
  payload: Record<string, unknown> | null;
  hintedVerifyCommands: string[];
  autonomousVerifyCommands?: string[];
}): string[] {
  const payloadCommands = toStringArray(params.payload?.verify_commands);
  const merged = uniqCommands([
    ...payloadCommands,
    ...(params.autonomousVerifyCommands || []),
    ...params.hintedVerifyCommands,
  ]);
  const strict = merged.filter((command) => !commandLooksLikeNonBlockingProbe(command));
  return (strict.length > 0 ? strict : merged).slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

function resolveStrictCandidateCommands(params: {
  contextHints: CliContextHints | null;
  hintedVerifyCommands: string[];
  autonomousVerifyCommands?: string[];
}): string[] {
  const hintedStrict = toStringArray(params.contextHints?.command_suggestions.strict);
  const merged = uniqCommands([
    ...hintedStrict,
    ...params.hintedVerifyCommands,
    ...(params.autonomousVerifyCommands || []),
  ]);

  return merged
    .filter((command) => isStrictVerificationCommand(command))
    .slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

export function resolveFixCommands(
  payload: Record<string, unknown> | null,
  autonomousFixCommands: string[] = [],
): string[] {
  const payloadCommands = uniqCommands(toStringArray(payload?.fix_commands));
  const merged = payloadCommands.length > 0 ? payloadCommands : uniqCommands(autonomousFixCommands);
  return merged.slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

export function resolveEditActions(
  payload: Record<string, unknown> | null,
  autonomousEditActionsV1: EditAction[] = [],
): EditAction[] {
  const payloadEditActions = sanitizeEditActions({
    value: payload?.edit_actions_v1,
    maxActions: env.WORKER_TOOL_MAX_COMMANDS,
    maxStringLength: Math.min(8000, env.WORKER_COMMAND_MAX_LENGTH * 8),
  });
  if (payloadEditActions.length > 0) {
    return payloadEditActions;
  }

  return autonomousEditActionsV1.slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

export function resolveEditCommands(
  payload: Record<string, unknown> | null,
  autonomousEditCommands: string[] = [],
  autonomousEditActionsV1: EditAction[] = [],
): string[] {
  const actionCommands = editActionsToCommands({
    actions: resolveEditActions(payload, autonomousEditActionsV1),
    maxCommands: env.WORKER_TOOL_MAX_COMMANDS,
    maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
  });
  if (actionCommands.length > 0) {
    return actionCommands;
  }

  const payloadCommands = uniqCommands(toStringArray(payload?.edit_commands));
  if (payloadCommands.length > 0) {
    return payloadCommands.slice(0, env.WORKER_TOOL_MAX_COMMANDS);
  }

  const merged = uniqCommands(autonomousEditCommands);
  return merged.slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

function actionCommandLabel(action: EditAction): string {
  return `edit_action ${action.type} ${action.file_path}`;
}

function actionResult(params: {
  action: EditAction;
  cycle: number;
  startedAt: number;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  blockedReason?: string | null;
}): CommandExecutionResult {
  return {
    command: actionCommandLabel(params.action),
    executable: "edit-action",
    args: [params.action.type, params.action.file_path],
    actionType: params.action.type,
    phase: "edit",
    cycle: params.cycle,
    exitCode: params.exitCode,
    signal: null,
    durationMs: Date.now() - params.startedAt,
    timedOut: false,
    stdout: params.stdout || "",
    stderr: params.stderr || "",
    blockedReason: params.blockedReason || null,
  };
}

export async function executeEditAction(params: {
  action: EditAction;
  cycle: number;
  workDir: string;
  fileEditState?: FileEditStateTracker;
  requireReadBeforeEdit?: boolean;
}): Promise<CommandExecutionResult> {
  const startedAt = Date.now();
  const relative = params.action.file_path.replace(/\\/g, "/").replace(/^\.\//, "");
  const resolved = path.resolve(params.workDir, relative);
  const rel = path.relative(params.workDir, resolved).replace(/\\/g, "/");
  const requireReadBeforeEdit = params.requireReadBeforeEdit !== false;

  if (!relative || rel.startsWith("../") || path.isAbsolute(relative)) {
    return actionResult({
      action: params.action,
      cycle: params.cycle,
      startedAt,
      exitCode: -1,
      blockedReason: "path traversal syntax is not allowed",
    });
  }

  const assertFileState = async (
    content: string,
    mtimeMs: number,
  ): Promise<CommandExecutionResult | null> => {
    if (!requireReadBeforeEdit || !params.fileEditState) {
      return null;
    }
    const check = params.fileEditState.assertUnchanged(rel, content, mtimeMs);
    if (!check.ok) {
      return actionResult({
        action: params.action,
        cycle: params.cycle,
        startedAt,
        exitCode: 5,
        stderr: check.reason,
      });
    }
    return null;
  };

  const recordAfterWrite = async (content: string): Promise<void> => {
    if (!params.fileEditState) return;
    try {
      const stat = await fs.stat(resolved);
      params.fileEditState.recordSnapshot(rel, content, stat.mtimeMs);
    } catch {
      // noop
    }
  };

  try {
    if (params.action.type === "replace_text") {
      const stat = await fs.stat(resolved);
      const source = await fs.readFile(resolved, "utf8");
      const stale = await assertFileState(source, stat.mtimeMs);
      if (stale) return stale;

      if (params.action.old_string === params.action.new_string) {
        return actionResult({
          action: params.action,
          cycle: params.cycle,
          startedAt,
          exitCode: 0,
          stdout: "no-op: old_string equals new_string",
        });
      }

      if (!source.includes(params.action.old_string)) {
        return actionResult({
          action: params.action,
          cycle: params.cycle,
          startedAt,
          exitCode: 3,
          stderr: "old_string not found",
        });
      }

      let next = source;
      if (params.action.replace_all) {
        next = source.split(params.action.old_string).join(params.action.new_string);
      } else {
        const first = source.indexOf(params.action.old_string);
        const second = source.indexOf(params.action.old_string, first + params.action.old_string.length);
        if (second >= 0) {
          return actionResult({
            action: params.action,
            cycle: params.cycle,
            startedAt,
            exitCode: 4,
            stderr: "old_string is not unique; set replace_all or provide more context",
          });
        }
        next = source.replace(params.action.old_string, params.action.new_string);
      }

      if (next !== source) {
        await fs.writeFile(resolved, next, "utf8");
        await recordAfterWrite(next);
      }
      return actionResult({
        action: params.action,
        cycle: params.cycle,
        startedAt,
        exitCode: 0,
      });
    }

    if (params.action.type === "append_text") {
      const stat = await fs.stat(resolved);
      const source = await fs.readFile(resolved, "utf8");
      const stale = await assertFileState(source, stat.mtimeMs);
      if (stale) return stale;

      if (source.includes(params.action.content)) {
        return actionResult({
          action: params.action,
          cycle: params.cycle,
          startedAt,
          exitCode: 0,
          stdout: "no-op: content already present",
        });
      }
      const next = `${source.replace(/\s*$/, "")}\n\n${params.action.content}\n`;
      await fs.writeFile(resolved, next, "utf8");
      await recordAfterWrite(next);
      return actionResult({
        action: params.action,
        cycle: params.cycle,
        startedAt,
        exitCode: 0,
      });
    }

    const parent = path.dirname(resolved);
    if (params.action.create_if_missing) {
      await fs.mkdir(parent, { recursive: true });
    }

    let existing: string | null = null;
    let existingMtime = 0;
    try {
      const stat = await fs.stat(resolved);
      existingMtime = stat.mtimeMs;
      existing = await fs.readFile(resolved, "utf8");
      const stale = await assertFileState(existing, existingMtime);
      if (stale) return stale;
    } catch (error) {
      if (!params.action.create_if_missing) {
        throw error;
      }
    }

    if (existing !== params.action.content) {
      await fs.writeFile(resolved, params.action.content, "utf8");
      await recordAfterWrite(params.action.content);
    }

    return actionResult({
      action: params.action,
      cycle: params.cycle,
      startedAt,
      exitCode: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const notFound =
      lower.includes("enoent") || lower.includes("no such file") || lower.includes("not found");
    return actionResult({
      action: params.action,
      cycle: params.cycle,
      startedAt,
      exitCode: notFound ? 2 : 1,
      stderr: message,
    });
  }
}

export function shouldAttemptVerifyReplan(params: {
  enableAutonomousRecovery: boolean;
  replanCountThisCycle: number;
  replanMaxPerCycle: number;
  hasFailedVerifyResult: boolean;
}): boolean {
  return (
    params.hasFailedVerifyResult &&
    params.enableAutonomousRecovery &&
    params.replanMaxPerCycle > 0 &&
    params.replanCountThisCycle < params.replanMaxPerCycle
  );
}

async function runEditVerifyFixLoop(params: {
  jobId: string;
  workDir: string;
  issueTitle: string;
  issueBody: string;
  payload: Record<string, unknown> | null;
  hintedVerifyCommands: string[];
  strictCandidateCommands: string[];
  autonomousPlan?: ResolvedAutonomousPlan | null;
  enableAutonomousRecovery: boolean;
  leaseToken: string | null;
  recoveryOnlyEditActions?: EditAction[];
  recoveryOnlyEditCommands?: string[];
}): Promise<EditLoopSummary> {
  const initialEditActions =
    params.recoveryOnlyEditActions ??
    resolveEditActions(params.payload, params.autonomousPlan?.editActionsV1 ?? []);
  const initialEditCommands =
    params.recoveryOnlyEditCommands ??
    resolveEditCommands(
      params.payload,
      params.autonomousPlan ? params.autonomousPlan.editCommands : [],
      params.autonomousPlan?.editActionsV1 ?? [],
    );
  const verifyCommands = resolveVerificationCommands({
    payload: params.payload,
    hintedVerifyCommands: params.hintedVerifyCommands,
    autonomousVerifyCommands: params.autonomousPlan ? params.autonomousPlan.verifyCommands : [],
  });
  let activeFixCommands = resolveFixCommands(
    params.payload,
    params.autonomousPlan ? params.autonomousPlan.fixCommands : [],
  );
  let pendingEditActions = [...initialEditActions];
  let pendingEditCommands = [...initialEditCommands];
  let plannedEditActions = [...initialEditActions];
  let plannedEditCommands = [...initialEditCommands];
  const recoveryPlans: EditLoopRecoverySummary[] = [];
  const allowNoteOnly = params.payload?.allow_note_only === true;
  const verifyGateDecision = resolveVerifyGateDecision({
    verifyCommands,
    strictCandidateCommands: params.strictCandidateCommands,
    requireStrictVerify: env.WORKER_REQUIRE_STRICT_VERIFY,
    minStrictVerifyCommands: env.WORKER_MIN_STRICT_VERIFY_COMMANDS,
    allowNoteOnly,
    verifyGateMode: env.WORKER_VERIFY_GATE_MODE,
    allowProbeOnlyWhenNoStrictCandidates: env.WORKER_ALLOW_PROBE_ONLY_WHEN_NO_STRICT_CANDIDATES,
  });
  if (!verifyGateDecision.allow) {
    const gateFailure: CommandExecutionResult = {
      command: "quality_gate verify_gate_decision",
      executable: null,
      args: [],
      phase: "verify",
      cycle: 0,
      exitCode: -1,
      signal: null,
      durationMs: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      blockedReason: verifyGateDecision.detail,
    };

    await recordToolExecution(params.jobId, gateFailure);
    return {
      passed: false,
      cycles: 0,
      editActionsV1: plannedEditActions,
      editCommands: plannedEditCommands,
      verifyCommands,
      fixCommands: activeFixCommands,
      strictCandidateCommands: params.strictCandidateCommands,
      verifyGateDecision: verifyGateDecision.reason,
      verifyGateReason: verifyGateDecision.detail,
      probeOnlyVerification: verifyGateDecision.probeOnlyVerification,
      commandResults: [gateFailure],
      recoveryPlans,
    };
  }

  if (pendingEditActions.length === 0 && pendingEditCommands.length === 0 && verifyCommands.length === 0) {
    return {
      passed: true,
      cycles: 0,
      editActionsV1: plannedEditActions,
      editCommands: plannedEditCommands,
      verifyCommands,
      fixCommands: activeFixCommands,
      strictCandidateCommands: params.strictCandidateCommands,
      verifyGateDecision: verifyGateDecision.reason,
      verifyGateReason: verifyGateDecision.detail,
      probeOnlyVerification: verifyGateDecision.probeOnlyVerification,
      commandResults: [],
      recoveryPlans,
    };
  }

  const requestedCycles = toPositiveInt(params.payload?.loop_max_cycles);
  const maxCycles = Math.max(1, Math.min(6, requestedCycles ?? env.WORKER_LOOP_MAX_CYCLES));
  const commandResults: CommandExecutionResult[] = [];
  const editFailureSignatures = new Map<string, number>();
  let recoveryContinuationCount = 0;
  const maxRecoveryContinuations = Math.max(1, Math.min(4, maxCycles));
  const fileEditState = new FileEditStateTracker();
  const requireReadBeforeEdit = env.WORKER_REQUIRE_READ_BEFORE_EDIT;
  let lastFailedVerifyLogPath: string | undefined;
  let lastFailedVerifyLogSummary: string | undefined;

  const persistToolResultLog = async (
    result: CommandExecutionResult,
    phase: string,
    cycle: number,
  ): Promise<void> => {
    if (!env.WORKER_VERIFY_LOG_PERSIST) return;
    try {
      const relPath = await persistCommandLog({
        workDir: params.workDir,
        cycle,
        phase,
        command: result.command,
        stdout: result.stdout,
        stderr: result.stderr,
      });
      if (
        phase === "verify" &&
        (result.blockedReason || result.timedOut || result.exitCode !== 0)
      ) {
        const fullText = await fs.readFile(path.join(params.workDir, relPath), "utf8");
        lastFailedVerifyLogPath = relPath;
        lastFailedVerifyLogSummary = summarizeLogForRecovery(fullText);
        await setStage(
          params.jobId,
          "editing",
          { last_verify_log_path: relPath },
          params.leaseToken,
        );
      }
    } catch {
      // Log persistence is best-effort.
    }
  };

  const finalizeLoopSummary = (summary: Omit<EditLoopSummary, "lastFailedVerifyLogPath" | "lastFailedVerifyLogSummary">): EditLoopSummary => ({
    ...summary,
    ...(lastFailedVerifyLogPath ? { lastFailedVerifyLogPath } : {}),
    ...(lastFailedVerifyLogSummary ? { lastFailedVerifyLogSummary } : {}),
  });

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    let verifyReplanCountThisCycle = 0;
    await setStage(params.jobId, "editing", {
      edit_loop_cycle: cycle,
      edit_loop_max_cycles: maxCycles,
      edit_action_count: plannedEditActions.length,
      edit_command_count: plannedEditCommands.length,
      verify_command_count: verifyCommands.length,
      fix_command_count: activeFixCommands.length,
    }, params.leaseToken);

    if (pendingEditActions.length > 0 || pendingEditCommands.length > 0) {
      const actionsForCycle = [...pendingEditActions];
      const commandsForCycle = [...pendingEditCommands];
      let failedEditResult: CommandExecutionResult | null = null;

      if (actionsForCycle.length > 0) {
        await fileEditState.primeFromDisk(
          params.workDir,
          collectEditActionPaths(actionsForCycle),
        );
        for (const action of actionsForCycle) {
          const result = await executeEditAction({
            action,
            cycle,
            workDir: params.workDir,
            fileEditState,
            requireReadBeforeEdit,
          });
          commandResults.push(result);
          await recordToolExecution(params.jobId, result);
          if (result.blockedReason || result.timedOut || result.exitCode !== 0) {
            failedEditResult = result;
            break;
          }
        }
      } else {
        for (const command of commandsForCycle) {
          const result = await executeToolCommand({
            command,
            phase: "edit",
            cycle,
            cwd: params.workDir,
            timeoutMs: env.WORKER_COMMAND_TIMEOUT_MS,
            maxOutputBytes: env.WORKER_COMMAND_MAX_OUTPUT_BYTES,
            maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
            allowedCommands: allowedToolCommands,
          });
          commandResults.push(result);
          await recordToolExecution(params.jobId, result);
          if (result.blockedReason || result.timedOut || result.exitCode !== 0) {
            failedEditResult = result;
            break;
          }
        }
      }

      if (failedEditResult) {
        const failureSignature = commandFailureSignature(failedEditResult);
        const failureCount = (editFailureSignatures.get(failureSignature) ?? 0) + 1;
        editFailureSignatures.set(failureSignature, failureCount);

        if (cycle >= maxCycles) {
          return finalizeLoopSummary({
            passed: false,
            cycles: cycle,
            editCommands: plannedEditCommands,
            verifyCommands,
            fixCommands: activeFixCommands,
            commandResults,
            recoveryPlans,
          });
        }

        let recoveryPlan: AutonomousCliRecoveryPlan | null = null;
        if (params.enableAutonomousRecovery) {
          try {
            recoveryPlan = await generateAutonomousCliRecoveryPlan({
              issueTitle: params.issueTitle,
              issueBody: params.issueBody,
              failedPhase: failedEditResult.phase,
              failedCommand: failedEditResult.command,
              failedExitCode: failedEditResult.exitCode,
              failedTimedOut: failedEditResult.timedOut,
              failedBlockedReason: failedEditResult.blockedReason,
              failedStdout: failedEditResult.stdout,
              failedStderr: failedEditResult.stderr,
              failedLogPath: lastFailedVerifyLogPath,
              failedLogSummary: lastFailedVerifyLogSummary,
              previousEditCommands: plannedEditCommands,
              previousFixCommands: activeFixCommands,
              allowedCommands: Array.from(allowedToolCommands.values()).sort(),
              maxCommands: env.WORKER_TOOL_MAX_COMMANDS,
              maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
            });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            recoveryPlan = {
              source: "heuristic",
              summary: "autonomous recovery planning failed",
              error: truncateText(message, 500),
              editCommands: [],
              fixCommands: [],
            };
          }
        }

        const recoveryEditActions = recoveryPlan?.editActionsV1 ?? [];
        const recoveryEditCommands = recoveryPlan
          ? filterExecutableCommands(recoveryPlan.editCommands).slice(0, env.WORKER_TOOL_MAX_COMMANDS)
          : [];
        const recoveryFixCommands = recoveryPlan
          ? filterExecutableCommands(recoveryPlan.fixCommands).slice(0, env.WORKER_TOOL_MAX_COMMANDS)
          : [];

        if (recoveryPlan) {
          recoveryPlans.push({
            cycle,
            source: recoveryPlan.source,
            summary: recoveryPlan.summary,
            ...(recoveryPlan.model ? { model: recoveryPlan.model } : {}),
            ...(recoveryPlan.error ? { error: recoveryPlan.error } : {}),
            failedCommand: failedEditResult.command,
            replacementEditActionsV1: recoveryEditActions,
            replacementEditCommands: recoveryEditCommands,
            recoveryFixCommands,
          });
        }

        const repairCommands =
          recoveryFixCommands.length > 0
            ? recoveryFixCommands
            : activeFixCommands;

        const hasNovelRecoveryEdits =
          recoveryEditActions.some(
            (action) => !plannedEditActions.some((existing) => JSON.stringify(existing) === JSON.stringify(action)),
          ) ||
          recoveryEditCommands.some(
            (command) => !plannedEditCommands.includes(command),
          );
        const recoveryPathExists =
          recoveryEditActions.length > 0 || recoveryEditCommands.length > 0 || repairCommands.length > 0;
        const repeatedFailureStall =
          failureCount >= 2 && !hasNovelRecoveryEdits && recoveryFixCommands.length === 0;
        const continuationBudgetExhausted = recoveryContinuationCount >= maxRecoveryContinuations;

        if (!recoveryPathExists || repeatedFailureStall || continuationBudgetExhausted) {
          recoveryPlans.push({
            cycle,
            source: "heuristic",
            summary: !recoveryPathExists
              ? "Recovery circuit breaker: no executable recovery commands were available"
              : repeatedFailureStall
                ? "Recovery circuit breaker: repeated identical edit failure without novel recovery actions"
                : "Recovery circuit breaker: recovery continuation budget exhausted",
            failedCommand: failedEditResult.command,
            replacementEditActionsV1: recoveryEditActions,
            replacementEditCommands: recoveryEditCommands,
            recoveryFixCommands,
          });
          return finalizeLoopSummary({
            passed: false,
            cycles: cycle,
            editCommands: plannedEditCommands,
            verifyCommands,
            fixCommands: activeFixCommands,
            commandResults,
            recoveryPlans,
          });
        }

        if (repairCommands.length > 0) {
          for (const command of repairCommands) {
            const fixResult = await executeToolCommand({
              command,
              phase: "fix",
              cycle,
              cwd: params.workDir,
              timeoutMs: env.WORKER_COMMAND_TIMEOUT_MS,
              maxOutputBytes: env.WORKER_COMMAND_MAX_OUTPUT_BYTES,
              maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
              allowedCommands: allowedToolCommands,
            });
            commandResults.push(fixResult);
            await recordToolExecution(params.jobId, fixResult);
            await persistToolResultLog(fixResult, "fix", cycle);
            if (fixResult.blockedReason || fixResult.timedOut || fixResult.exitCode !== 0) {
              return finalizeLoopSummary({
                passed: false,
                cycles: cycle,
                editCommands: plannedEditCommands,
                verifyCommands,
                fixCommands: activeFixCommands,
                commandResults,
                recoveryPlans,
              });
            }
          }
        }

        activeFixCommands = uniqCommands([...activeFixCommands, ...recoveryFixCommands]).slice(
          0,
          env.WORKER_TOOL_MAX_COMMANDS,
        );

        if (recoveryEditActions.length > 0 || recoveryEditCommands.length > 0) {
          if (recoveryEditActions.length > 0) {
            plannedEditActions = [...plannedEditActions, ...recoveryEditActions].slice(
              0,
              env.WORKER_TOOL_MAX_COMMANDS * 2,
            );
            pendingEditActions = recoveryEditActions;
            pendingEditCommands = [];
          } else {
            plannedEditCommands = uniqCommands([
              ...plannedEditCommands,
              ...recoveryEditCommands,
            ]).slice(0, env.WORKER_TOOL_MAX_COMMANDS * 2);
            pendingEditActions = [];
            pendingEditCommands = recoveryEditCommands;
          }
          recoveryContinuationCount += 1;
          continue;
        }

        if (repairCommands.length > 0) {
          pendingEditActions = actionsForCycle;
          pendingEditCommands = commandsForCycle;
          recoveryContinuationCount += 1;
          continue;
        }

        return finalizeLoopSummary({
          passed: false,
          cycles: cycle,
          editCommands: plannedEditCommands,
          verifyCommands,
          fixCommands: activeFixCommands,
          commandResults,
          recoveryPlans,
        });
      }

      pendingEditActions = [];
      pendingEditCommands = [];
    }

    if (verifyCommands.length === 0) {
      if (env.WORKER_REQUIRE_STRICT_VERIFY && !allowNoteOnly) {
        const gateFailure: CommandExecutionResult = {
          command: "quality_gate strict_verify_missing",
          executable: null,
          args: [],
          phase: "verify",
          cycle,
          exitCode: -1,
          signal: null,
          durationMs: 0,
          timedOut: false,
          stdout: "",
          stderr: "",
          blockedReason: "insufficient_strict_verify: no verification commands provided",
        };
        commandResults.push(gateFailure);
        await recordToolExecution(params.jobId, gateFailure);
        return finalizeLoopSummary({
          passed: false,
          cycles: cycle,
          editActionsV1: plannedEditActions,
          editCommands: plannedEditCommands,
          verifyCommands,
          fixCommands: activeFixCommands,
          commandResults,
          recoveryPlans,
        });
      }

      return finalizeLoopSummary({
        passed: true,
        cycles: cycle,
        editActionsV1: plannedEditActions,
        editCommands: plannedEditCommands,
        verifyCommands,
        fixCommands: activeFixCommands,
        strictCandidateCommands: params.strictCandidateCommands,
        verifyGateDecision: verifyGateDecision.reason,
        verifyGateReason: verifyGateDecision.detail,
        probeOnlyVerification: verifyGateDecision.probeOnlyVerification,
        commandResults,
        recoveryPlans,
      });
    }

    let cyclePassed = true;
    const hasStrictVerificationCommands = verifyCommands.some((command) =>
      isStrictVerificationCommand(command),
    );
    let strictChecksExecuted = false;
    let missingArtifactFailure = false;
    let failedVerifyResult: CommandExecutionResult | null = null;
    for (const command of verifyCommands) {
      const strictCheck = isStrictVerificationCommand(command);
      if (strictCheck) strictChecksExecuted = true;

      const result = await executeToolCommand({
        command,
        phase: "verify",
        cycle,
        cwd: params.workDir,
        timeoutMs: env.WORKER_COMMAND_TIMEOUT_MS,
        maxOutputBytes: env.WORKER_COMMAND_MAX_OUTPUT_BYTES,
        maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
        allowedCommands: allowedToolCommands,
      });
      commandResults.push(result);
      await recordToolExecution(params.jobId, result);
      await persistToolResultLog(result, "verify", cycle);

      const failed = result.blockedReason || result.timedOut || result.exitCode !== 0;
      const blockedFailure = Boolean(result.blockedReason);
      const missingArtifact = failed && looksLikeMissingArtifactFailure(result);
      if (missingArtifact) {
        missingArtifactFailure = true;
      }
      const enforceWithoutStrict =
        !hasStrictVerificationCommands &&
        (result.timedOut || missingArtifact);

      if (failed && (blockedFailure || strictCheck || missingArtifact || enforceWithoutStrict)) {
        cyclePassed = false;
        failedVerifyResult = result;
        break;
      }
    }

    await setStage(
      params.jobId,
      "editing",
      {
        verify_strict_checks_executed: strictChecksExecuted,
        verify_missing_artifact_failure: missingArtifactFailure,
        ...(failedVerifyResult ? { verify_replan_count_this_cycle: verifyReplanCountThisCycle } : {}),
      },
      params.leaseToken,
    );

    if (cyclePassed) {
      return finalizeLoopSummary({
        passed: true,
        cycles: cycle,
        editActionsV1: plannedEditActions,
        editCommands: plannedEditCommands,
        verifyCommands,
        fixCommands: activeFixCommands,
        strictCandidateCommands: params.strictCandidateCommands,
        verifyGateDecision: verifyGateDecision.reason,
        verifyGateReason: verifyGateDecision.detail,
        probeOnlyVerification: verifyGateDecision.probeOnlyVerification,
        commandResults,
        recoveryPlans,
      });
    }

    let scheduledRecoveryEdits = false;
    if (
      failedVerifyResult &&
      shouldAttemptVerifyReplan({
        enableAutonomousRecovery: params.enableAutonomousRecovery,
        replanCountThisCycle: verifyReplanCountThisCycle,
        replanMaxPerCycle: env.WORKER_REPLAN_MAX_PER_CYCLE,
        hasFailedVerifyResult: true,
      })
    ) {
      const verifyFailure = failedVerifyResult;
      verifyReplanCountThisCycle += 1;
      let recoveryPlan: AutonomousCliRecoveryPlan | null = null;
      try {
        recoveryPlan = await generateAutonomousCliRecoveryPlan({
          issueTitle: params.issueTitle,
          issueBody: params.issueBody,
          failedPhase: "verify",
          failedCommand: verifyFailure.command,
          failedExitCode: verifyFailure.exitCode,
          failedTimedOut: verifyFailure.timedOut,
          failedBlockedReason: verifyFailure.blockedReason,
          failedStdout: verifyFailure.stdout,
          failedStderr: verifyFailure.stderr,
          failedLogPath: lastFailedVerifyLogPath,
          failedLogSummary: lastFailedVerifyLogSummary,
          previousEditCommands: plannedEditCommands,
          previousFixCommands: activeFixCommands,
          allowedCommands: Array.from(allowedToolCommands.values()).sort(),
          maxCommands: env.WORKER_TOOL_MAX_COMMANDS,
          maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        recoveryPlan = {
          source: "heuristic",
          summary: "verify replan failed",
          error: truncateText(message, 500),
          editCommands: [],
          fixCommands: [],
        };
      }

      const recoveryEditActions = recoveryPlan?.editActionsV1 ?? [];
      const recoveryEditCommands = recoveryPlan
        ? filterExecutableCommands(recoveryPlan.editCommands).slice(0, env.WORKER_TOOL_MAX_COMMANDS)
        : [];
      const recoveryFixCommands = recoveryPlan
        ? filterExecutableCommands(recoveryPlan.fixCommands).slice(0, env.WORKER_TOOL_MAX_COMMANDS)
        : [];

      if (recoveryPlan) {
        recoveryPlans.push({
          cycle,
          source: recoveryPlan.source,
          summary: recoveryPlan.summary,
          ...(recoveryPlan.model ? { model: recoveryPlan.model } : {}),
          ...(recoveryPlan.error ? { error: recoveryPlan.error } : {}),
          failedCommand: verifyFailure.command,
          replacementEditActionsV1: recoveryEditActions,
          replacementEditCommands: recoveryEditCommands,
          recoveryFixCommands,
        });
      }

      if (recoveryEditActions.length > 0 || recoveryEditCommands.length > 0) {
        if (recoveryEditActions.length > 0) {
          plannedEditActions = [...plannedEditActions, ...recoveryEditActions].slice(
            0,
            env.WORKER_TOOL_MAX_COMMANDS * 2,
          );
          pendingEditActions = recoveryEditActions;
          pendingEditCommands = [];
        } else {
          plannedEditCommands = uniqCommands([
            ...plannedEditCommands,
            ...recoveryEditCommands,
          ]).slice(0, env.WORKER_TOOL_MAX_COMMANDS * 2);
          pendingEditActions = [];
          pendingEditCommands = recoveryEditCommands;
        }
        scheduledRecoveryEdits = true;
      }

      if (recoveryFixCommands.length > 0) {
        activeFixCommands = uniqCommands([...activeFixCommands, ...recoveryFixCommands]).slice(
          0,
          env.WORKER_TOOL_MAX_COMMANDS,
        );
      }

      await setStage(
        params.jobId,
        "editing",
        {
          verify_replan_count_this_cycle: verifyReplanCountThisCycle,
          verify_replan_summary: recoveryPlan?.summary ?? null,
          verify_replan_scheduled_edits: scheduledRecoveryEdits,
        },
        params.leaseToken,
      );
    }

    const hasContinuationPath = scheduledRecoveryEdits || activeFixCommands.length > 0;
    if (cycle >= maxCycles || !hasContinuationPath) {
      break;
    }

    for (const command of activeFixCommands) {
      const result = await executeToolCommand({
        command,
        phase: "fix",
        cycle,
        cwd: params.workDir,
        timeoutMs: env.WORKER_COMMAND_TIMEOUT_MS,
        maxOutputBytes: env.WORKER_COMMAND_MAX_OUTPUT_BYTES,
        maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
        allowedCommands: allowedToolCommands,
      });
      commandResults.push(result);
      await recordToolExecution(params.jobId, result);
      await persistToolResultLog(result, "fix", cycle);
      if (result.blockedReason || result.timedOut || result.exitCode !== 0) {
        return finalizeLoopSummary({
          passed: false,
          cycles: cycle,
          editActionsV1: plannedEditActions,
          editCommands: plannedEditCommands,
          verifyCommands,
          fixCommands: activeFixCommands,
          commandResults,
          recoveryPlans,
        });
      }
    }
  }

  return finalizeLoopSummary({
    passed: false,
    cycles: maxCycles,
    editActionsV1: plannedEditActions,
    editCommands: plannedEditCommands,
    verifyCommands,
    fixCommands: activeFixCommands,
    commandResults,
    recoveryPlans,
  });
}

async function commitWorkerMemory(params: {
  jobId: string;
  branchName: string;
  content: string;
  message: string;
  knowledgeContext: Record<string, unknown>;
  failureContext?: Record<string, unknown>;
  trace?: Record<string, unknown>;
}): Promise<{ commit_id: string; branch_name: string } | null> {
  if (!env.WORKER_MEMORY_COMMIT_ENABLED || !env.INTERNAL_SERVICE_SECRET) {
    return null;
  }

  const baseUrl = env.BACKEND_API_URL.replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/internal/git-jobs/${params.jobId}/memory-commit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-service-secret": env.INTERNAL_SERVICE_SECRET,
    },
    body: JSON.stringify({
      branch_name: params.branchName,
      message: params.message,
      content: params.content,
      skip_semantics: true,
      reasoning_type: "trace",
      knowledge_context: params.knowledgeContext,
      failure_context: params.failureContext,
      trace: params.trace,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`memory commit failed (${response.status}): ${truncateText(body, 500)}`);
  }

  const payload = (await response.json()) as { commit_id?: string; branch_name?: string };
  if (!payload.commit_id || !payload.branch_name) {
    throw new Error("memory commit response missing commit_id or branch_name");
  }

  return {
    commit_id: payload.commit_id,
    branch_name: payload.branch_name,
  };
}

type WorkerEvent =
  | "job_claimed"
  | "planning_started"
  | "workspace_reset"
  | "clone_completed"
  | "branch_created"
  | "commit_created"
  | "push_retrying"
  | "push_recovered"
  | "push_completed"
  | "pr_opened"
  | "judge_completed"
  | "comment_posted"
  | "dry_run_completed"
  | "cleanup_completed"
  | "job_failed"
  | "job_completed";

function logWorkerEvent(event: WorkerEvent, details: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      source: "worker",
      event,
      ts: new Date().toISOString(),
      ...details,
    }),
  );
}

function getTmpRoot(): string {
  const configured = (env.GIT_TMP_ROOT || "").trim();
  return configured.length > 0 ? configured : "/tmp/kaizen-git-jobs";
}

function ensureTmpScopedPath(root: string): string {
  const resolved = path.resolve(root);
  if (!(resolved === "/tmp" || resolved.startsWith("/tmp/"))) {
    throw new Error(`Unsafe temp root: ${resolved}. Worker requires /tmp-scoped workspace.`);
  }
  return resolved;
}

async function heartbeat(jobId: string, leaseToken: string | null): Promise<void> {
  const updated = await query<{ id: string }>(
    `UPDATE git_jobs
     SET last_heartbeat_at = NOW(),
         lease_expires_at = NOW() + (($1::bigint || ' milliseconds')::interval),
         updated_at = NOW()
     WHERE id = $2
       AND ($3::text IS NULL OR lease_token = $3)
     RETURNING id`,
    [env.WORKER_LEASE_TIMEOUT_MS, jobId, leaseToken],
  );
  if (updated.length === 0) {
    throw new Error("Lease lost while heartbeating git job");
  }
}

async function setStage(
  jobId: string,
  stage: string,
  payloadPatch?: Record<string, unknown>,
  leaseToken?: string | null,
): Promise<void> {
  const updated = await query<{ id: string }>(
    `UPDATE git_jobs
     SET stage = $1,
         payload = COALESCE(payload, '{}'::jsonb) || COALESCE($2::jsonb, '{}'::jsonb),
         updated_at = NOW()
     WHERE id = $3
       AND ($4::text IS NULL OR lease_token = $4)
     RETURNING id`,
    [stage, payloadPatch ? JSON.stringify(payloadPatch) : null, jobId, leaseToken ?? null],
  );
  if (updated.length === 0) {
    throw new Error(`Lease lost while setting stage '${stage}'`);
  }
}

async function failJob(job: GitJobRow, rawMessage: string, klass: ErrorClass): Promise<void> {
  const message = rawMessage.slice(0, 2000);
  const retryable = klass === "transient" && job.attempt_count < job.max_attempts;
  const retryAfterMs = retryBackoffMs(job.attempt_count);
  await query(
    `UPDATE git_jobs
     SET status = CASE WHEN $1 THEN 'pending' ELSE 'failed' END,
         stage = CASE WHEN $1 THEN 'pending_retry' ELSE 'failed' END,
         retry_after = CASE
           WHEN $1 THEN NOW() + (($2::bigint || ' milliseconds')::interval)
           ELSE NULL
         END,
         last_error_classification = $3,
         error_message = $4,
         lease_token = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $5
       AND ($6::text IS NULL OR lease_token = $6)`,
    [retryable, retryAfterMs, klass, message, job.id, job.lease_token],
  );
}

export async function processGitJobById(jobId: string): Promise<void> {
  const job = await queryOne<GitJobRow>("SELECT * FROM git_jobs WHERE id = $1", [jobId]);
  if (!job || job.status !== "running") return;

  logWorkerEvent("job_claimed", {
    job_id: job.id,
    issue_id: job.issue_id,
    repo_id: job.repo_id,
    attempt: job.attempt_count,
    stage: job.stage,
    dry_run: env.WORKER_DRY_RUN,
  });

  await heartbeat(job.id, job.lease_token);

  const link = await getGitHubLinkForRepo(job.repo_id);
  if (!link) {
    await failJob(job, "Missing GitHub remote on repository (import with PAT)", "permanent");
    return;
  }

  let token: string | null;
  try {
    token = await getGitHubTokenForUser(job.user_id);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    await failJob(job, msg, classifyError(msg));
    return;
  }

  if (!token) {
    await failJob(
      job,
      "No GitHub personal access token for job user (PATCH /auth/github-api-key)",
      "permanent",
    );
    return;
  }

  const issue = await queryOne<{ title: string; body: string | null; scorecard: unknown }>(
    "SELECT title, body, scorecard FROM issues WHERE id = $1",
    [job.issue_id],
  );
  if (!issue) {
    await failJob(job, "Issue not found", "permanent");
    return;
  }

  const agent = await queryOne<{ ens_name: string }>(
    "SELECT ens_name FROM agents WHERE id = $1 LIMIT 1",
    [job.agent_id],
  );
  const agentEns = agent?.ens_name || job.agent_id;

  const bounty = await bountyService.getIssueBounty(job.issue_id);
  const tmpRoot = ensureTmpScopedPath(getTmpRoot());
  await fs.mkdir(tmpRoot, { recursive: true });
  const dirName = `job-${job.id}-attempt-${job.attempt_count}`;
  const workDir = path.join(tmpRoot, dirName);
  let cleaned = false;
  let finalBranchName: string | null = null;
  let finalPrNumber: number | null = null;
  let finalJudgeScore: number | null = null;
  let didSucceed = false;
  const dryRun = env.WORKER_DRY_RUN;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await rmrf(workDir);
    } catch {
      // noop
    }
  };

  try {
    const base = link.default_branch || job.base_branch;

    logWorkerEvent("planning_started", {
      job_id: job.id,
      issue_id: job.issue_id,
      repo_id: job.repo_id,
      base_branch: base,
      attempt: job.attempt_count,
      dry_run: dryRun,
    });

    const orchestrationBrief = buildOrchestrationExecutionBrief(job.payload);
    const planningIssueBody = [issue.body || "", orchestrationBrief]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .join("\n\n");

    await setStage(job.id, "planning", {
      issue_title: issue.title,
      issue_len: planningIssueBody.length,
      base_branch: base,
      orchestration_brief_len: orchestrationBrief.length,
    }, job.lease_token);

    await setStage(job.id, "cloning", undefined, job.lease_token);
    await heartbeat(job.id, job.lease_token);

    // Always start each attempt from a clean /tmp workspace.
    await rmrf(workDir);
    logWorkerEvent("workspace_reset", {
      job_id: job.id,
      work_dir: workDir,
      attempt: job.attempt_count,
    });

    const remote = `https://x-access-token:${token}@github.com/${link.github_owner}/${link.github_repo}.git`;
    const rootGit = simpleGit(tmpRoot);
    await rootGit.clone(remote, dirName, ["--depth", "1", "--branch", base]);
    logWorkerEvent("clone_completed", {
      job_id: job.id,
      work_dir: workDir,
      branch: base,
      dry_run: dryRun,
    });

    await setStage(job.id, "editing", undefined, job.lease_token);
    await heartbeat(job.id, job.lease_token);

    const git = simpleGit(workDir);
    const branchName =
      job.branch_name ||
      buildDefaultBranchName({
        jobId: job.id,
        issueId: job.issue_id,
        issueTitle: issue.title,
      });
    await git.checkoutBranch(branchName, base);
    logWorkerEvent("branch_created", {
      job_id: job.id,
      branch_name: branchName,
      base_branch: base,
      dry_run: dryRun,
    });

    const parsedHints = parseJobCliHints(job.payload);
    const contextHints = env.CLI_CONTEXT_HINTS_ENABLED
      ? await refineCliHintsForWorkspace({
          git,
          issueTitle: issue.title,
          issueBody: planningIssueBody,
          seedHints: parsedHints.contextHints,
          maxFiles: env.CLI_CONTEXT_HINTS_MAX_FILES,
          maxTests: env.CLI_CONTEXT_HINTS_MAX_TESTS,
          scanLimit: env.CLI_CONTEXT_HINTS_SCAN_LIMIT,
        })
      : parsedHints.contextHints;

    const requiredArtifacts = deriveRequiredArtifactsForJob({
      issueTitle: issue.title,
      issueBody: planningIssueBody,
      payload: job.payload,
      contextHints,
    });

    const hintedVerifyCommands = uniqCommands([
      ...toStringArray(parsedHints.verificationHints?.suggested_test_commands),
      ...toStringArray(contextHints?.command_suggestions.verify),
    ]);

    let autonomousPlan: ResolvedAutonomousPlan | null = null;
    const payloadEditActions = resolveEditActions(job.payload);
    const payloadEditCommands = resolveEditCommands(job.payload);
    const autonomousEditingAllowed =
      env.WORKER_AUTONOMOUS_EDITING_ENABLED && !isBooleanFalse(job.payload?.autonomous_editing);
    const autonomousRecoveryAllowed =
      env.WORKER_AUTONOMOUS_EDITING_ENABLED && !isBooleanFalse(job.payload?.autonomous_recovery);
    if (autonomousEditingAllowed && payloadEditActions.length === 0 && payloadEditCommands.length === 0) {
      try {
        const planned: AutonomousCliPlan = await generateAutonomousCliPlan({
          issueTitle: issue.title,
          issueBody: planningIssueBody,
          contextHints,
          verificationHints: parsedHints.verificationHints,
          requiredArtifacts,
          allowedCommands: Array.from(allowedToolCommands.values()).sort(),
          maxCommands: env.WORKER_TOOL_MAX_COMMANDS,
          maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
        });

        autonomousPlan = {
          ...planned,
          editCommands: filterExecutableCommands(planned.editCommands),
          ...(planned.editActionsV1 ? { editActionsV1: planned.editActionsV1 } : {}),
          verifyCommands: filterExecutableCommands(planned.verifyCommands),
          fixCommands: filterExecutableCommands(planned.fixCommands),
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        autonomousPlan = {
          source: "heuristic",
          summary: "autonomous plan failed before execution",
          error: truncateText(message, 500),
          editCommands: [],
          verifyCommands: [],
          fixCommands: [],
        };
      }
    }

    let kaizenPlanPath: string | null = null;
    let kaizenPlanPhases: Array<{ name: string; status: string }> | null = null;
    if (env.WORKER_KAIZEN_PLAN_ENABLED) {
      const plannedEditActionsForPlan = resolveEditActions(
        job.payload,
        autonomousPlan?.editActionsV1 ?? [],
      );
      const plannedEditCommandsForPlan = resolveEditCommands(
        job.payload,
        autonomousPlan?.editCommands ?? [],
        autonomousPlan?.editActionsV1 ?? [],
      );
      const plannedVerifyCommandsForPlan = resolveVerificationCommands({
        payload: job.payload,
        hintedVerifyCommands,
        autonomousVerifyCommands: autonomousPlan?.verifyCommands ?? [],
      });
      const plannedFixCommandsForPlan = resolveFixCommands(
        job.payload,
        autonomousPlan?.fixCommands ?? [],
      );
      const kaizenPlan = buildInitialKaizenPlan({
        issueTitle: issue.title,
        rankedFiles: (contextHints?.ranked_files || []).map((file) => file.path),
        rankedTests: (contextHints?.ranked_tests || []).map((test) => test.path),
        searchTerms: contextHints?.search_terms || [],
        verifyHints: hintedVerifyCommands,
        requiredArtifacts,
        implementSummary: autonomousPlan?.summary,
        editActionsV1: plannedEditActionsForPlan,
        editCommands: plannedEditCommandsForPlan,
        verifyCommands: plannedVerifyCommandsForPlan,
        fixCommands: plannedFixCommandsForPlan,
        autonomousPlanSource: autonomousPlan?.source ?? null,
      });
      kaizenPlanPath = await writeKaizenPlanArtifact(workDir, kaizenPlan);
      kaizenPlanPhases = summarizeKaizenPlanPhases(kaizenPlan);
    }

    await setStage(job.id, "editing", {
      context_hint_count: contextHints?.ranked_files.length ?? 0,
      test_hint_count: contextHints?.ranked_tests.length ?? 0,
      search_term_count: contextHints?.search_terms.length ?? 0,
      suggested_verify_count: hintedVerifyCommands.length,
      autonomous_editing_enabled: autonomousEditingAllowed,
      autonomous_recovery_enabled: autonomousRecoveryAllowed,
      autonomous_editing_source: autonomousPlan?.source ?? null,
      autonomous_editing_summary: autonomousPlan?.summary ?? null,
      autonomous_editing_model: autonomousPlan?.model ?? null,
      autonomous_editing_error: autonomousPlan?.error ?? null,
      autonomous_edit_action_count: autonomousPlan?.editActionsV1?.length ?? 0,
      autonomous_edit_command_count: autonomousPlan?.editCommands.length ?? 0,
      autonomous_verify_command_count: autonomousPlan?.verifyCommands.length ?? 0,
      autonomous_fix_command_count: autonomousPlan?.fixCommands.length ?? 0,
      required_artifact_count: requiredArtifacts.length,
      required_artifacts: requiredArtifacts,
      ...(kaizenPlanPath && kaizenPlanPhases
        ? {
            kaizen_plan_path: kaizenPlanPath,
            kaizen_plan_phases: kaizenPlanPhases,
          }
        : {}),
    }, job.lease_token);

    const strictCandidateCommands = resolveStrictCandidateCommands({
      contextHints,
      hintedVerifyCommands,
      autonomousVerifyCommands: autonomousPlan?.verifyCommands ?? [],
    });

    const agentNote = path.join(workDir, "KAIZEN_AGENT.md");
    const agentNoteContent = renderKaizenAgentNote({
      issueTitle: issue.title,
      issueBody: planningIssueBody,
      contextHints,
      verificationHints: parsedHints.verificationHints,
    });
    await fs.writeFile(
      agentNote,
      agentNoteContent,
      "utf8",
    );

    const editLoop = await runEditVerifyFixLoop({
      jobId: job.id,
      workDir,
      issueTitle: issue.title,
      issueBody: planningIssueBody,
      payload: job.payload,
      hintedVerifyCommands,
      strictCandidateCommands,
      autonomousPlan,
      enableAutonomousRecovery: autonomousRecoveryAllowed,
      leaseToken: job.lease_token,
    });

    await setStage(job.id, "editing", {
      edit_loop_passed: editLoop.passed,
      edit_loop_cycles: editLoop.cycles,
      edit_loop_edit_actions_v1: editLoop.editActionsV1 ?? [],
      edit_loop_edit_commands: editLoop.editCommands,
      edit_loop_verify_commands: editLoop.verifyCommands,
      edit_loop_fix_commands: editLoop.fixCommands,
      edit_loop_strict_candidate_commands: editLoop.strictCandidateCommands ?? [],
      edit_loop_verify_gate_decision: editLoop.verifyGateDecision ?? null,
      edit_loop_verify_gate_reason: editLoop.verifyGateReason ?? null,
      edit_loop_probe_only_verification: editLoop.probeOnlyVerification ?? null,
      edit_loop_recovery_count: editLoop.recoveryPlans.length,
      edit_loop_recovery_plans: editLoop.recoveryPlans,
      edit_loop_results: editLoop.commandResults.map(compactCommandResult),
    }, job.lease_token);

    if (!editLoop.passed) {
      const failed = editLoop.commandResults.find(
        (result) => result.blockedReason || result.timedOut || result.exitCode !== 0,
      );
      if (failed) {
        const blocked = failed.blockedReason ? `, blocked_reason=${failed.blockedReason}` : "";
        throw new Error(
          `${failed.phase} command failed after ${editLoop.cycles} cycle(s): ${failed.command} (exit=${failed.exitCode}, timed_out=${failed.timedOut}${blocked})`,
        );
      }
      throw new Error(`Edit/verify loop failed after ${editLoop.cycles} cycle(s)`);
    }

    const workspaceStatus = await git.status();
    if (workspaceStatus.files.length === 0) {
      throw new Error("Edit loop produced no file changes; refusing to open PR with empty diff.");
    }

    const allowNoteOnly = job.payload?.allow_note_only === true;
    let editLoopResult = editLoop;
    let softContinueCount = 0;
    const softContinueBudget = env.WORKER_POST_GATE_SOFT_CONTINUE;
    let softContinueUsed = false;
    let gateEvaluation = await evaluatePostLoopGatesForWorkspace({
      git,
      workDir,
      requiredArtifacts,
      allowNoteOnly,
      probeOnlyVerification: editLoopResult.probeOnlyVerification,
    });

    while (!gateEvaluation.gateResult.ok) {
      const gateFailure = gateEvaluation.gateResult;
      await setStage(
        job.id,
        "editing",
        {
          quality_gate_failure: gateFailure.failureType,
          quality_gate_reason: gateFailure.reason,
          ...(gateFailure.detail ?? {}),
        },
        job.lease_token,
      );

      if (
        softContinueCount >= softContinueBudget ||
        !autonomousRecoveryAllowed ||
        softContinueBudget <= 0
      ) {
        throw new Error(gateFailure.reason);
      }

      let recoveryPlan: AutonomousCliRecoveryPlan | null = null;
      try {
        recoveryPlan = await generateAutonomousCliRecoveryPlan({
          issueTitle: issue.title,
          issueBody: planningIssueBody,
          failedPhase: "quality_gate",
          failedCommand: gateFailure.failureType,
          failedExitCode: -1,
          failedTimedOut: false,
          failedBlockedReason: gateFailure.reason,
          failedStdout: "",
          failedStderr: gateFailure.detail
            ? `${gateFailure.reason}\n${JSON.stringify(gateFailure.detail)}`
            : gateFailure.reason,
          failedLogPath: editLoopResult.lastFailedVerifyLogPath,
          failedLogSummary: editLoopResult.lastFailedVerifyLogSummary,
          previousEditCommands: editLoopResult.editCommands,
          previousFixCommands: editLoopResult.fixCommands,
          allowedCommands: Array.from(allowedToolCommands.values()).sort(),
          maxCommands: env.WORKER_TOOL_MAX_COMMANDS,
          maxCommandLength: env.WORKER_COMMAND_MAX_LENGTH,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Post-loop quality gate failed (${gateFailure.failureType}) and recovery planning failed: ${message}`,
        );
      }

      const recoveryEditActions = recoveryPlan.editActionsV1 ?? [];
      const recoveryEditCommands = filterExecutableCommands(recoveryPlan.editCommands).slice(
        0,
        env.WORKER_TOOL_MAX_COMMANDS,
      );
      if (recoveryEditActions.length === 0 && recoveryEditCommands.length === 0) {
        throw new Error(gateFailure.reason);
      }

      softContinueCount += 1;
      softContinueUsed = true;
      await setStage(
        job.id,
        "editing",
        {
          soft_continue_used: true,
          soft_continue_count: softContinueCount,
          soft_continue_recovery_summary: recoveryPlan.summary,
        },
        job.lease_token,
      );

      editLoopResult = await runEditVerifyFixLoop({
        jobId: job.id,
        workDir,
        issueTitle: issue.title,
        issueBody: planningIssueBody,
        payload: job.payload,
        hintedVerifyCommands,
        strictCandidateCommands,
        autonomousPlan: null,
        enableAutonomousRecovery: true,
        leaseToken: job.lease_token,
        recoveryOnlyEditActions:
          recoveryEditActions.length > 0 ? recoveryEditActions : undefined,
        recoveryOnlyEditCommands:
          recoveryEditActions.length === 0 ? recoveryEditCommands : undefined,
      });

      if (!editLoopResult.passed) {
        const failed = editLoopResult.commandResults.find(
          (result) => result.blockedReason || result.timedOut || result.exitCode !== 0,
        );
        if (failed) {
          const blocked = failed.blockedReason ? `, blocked_reason=${failed.blockedReason}` : "";
          throw new Error(
            `Soft-continue edit/verify loop failed: ${failed.command} (exit=${failed.exitCode}, timed_out=${failed.timedOut}${blocked})`,
          );
        }
        throw new Error("Soft-continue edit/verify loop failed");
      }

      gateEvaluation = await evaluatePostLoopGatesForWorkspace({
        git,
        workDir,
        requiredArtifacts,
        allowNoteOnly,
        probeOnlyVerification: editLoopResult.probeOnlyVerification,
      });
    }

    const { implementationChanges, diffQuality } = gateEvaluation;

    if (env.WORKER_KAIZEN_PLAN_ENABLED && kaizenPlanPath) {
      await updateKaizenPlanArtifact(workDir, (plan) => ({
        ...plan,
        phases: plan.phases.map((phase) =>
          phase.name === "implement"
            ? {
                ...phase,
                status: editLoopResult.passed ? "completed" : "failed",
                edit_loop_cycles: editLoopResult.cycles,
                edit_loop_passed: editLoopResult.passed,
                edit_actions_v1: editLoopResult.editActionsV1 ?? phase.edit_actions_v1,
                edit_commands: editLoopResult.editCommands,
                verify_commands: editLoopResult.verifyCommands,
                fix_commands: editLoopResult.fixCommands,
              }
            : phase,
        ),
      }));
      kaizenPlanPhases = [
        { name: "explore", status: "completed" },
        {
          name: "implement",
          status: editLoopResult.passed ? "completed" : "failed",
        },
      ];
    }

    await setStage(job.id, "editing", {
      quality_gate_passed: true,
      soft_continue_used: softContinueUsed,
      ...(softContinueUsed ? { soft_continue_count: softContinueCount } : {}),
      ...(kaizenPlanPath && kaizenPlanPhases
        ? {
            kaizen_plan_path: kaizenPlanPath,
            kaizen_plan_phases: kaizenPlanPhases,
          }
        : {}),
      quality_added_substantive_chars: diffQuality.addedSubstantiveChars,
      quality_substantive_hunks: diffQuality.substantiveHunks,
      quality_placeholder_line_count: diffQuality.placeholderLineCount,
      quality_implementation_file_count: implementationChanges.length,
      quality_strict_verify_count: countStrictVerificationCommands(editLoopResult.verifyCommands),
      quality_strict_candidate_count: editLoopResult.strictCandidateCommands?.length ?? 0,
      quality_verify_gate_decision: editLoopResult.verifyGateDecision ?? null,
      quality_verify_gate_reason: editLoopResult.verifyGateReason ?? null,
      quality_probe_only_verification: editLoopResult.probeOnlyVerification ?? null,
      quality_required_artifact_count: requiredArtifacts.length,
      quality_required_artifacts: requiredArtifacts,
    }, job.lease_token);

    await setStage(job.id, "committing", { branch_name: branchName }, job.lease_token);
    await git.add(["-A"]);
    await git.commit(`feat: agent implementation for issue (${job.issue_id.slice(0, 8)})`);
    const committedStatus = await git.status();
    logWorkerEvent("commit_created", {
      job_id: job.id,
      branch_name: branchName,
      dry_run: dryRun,
      edited_file_count: committedStatus.files.length,
    });

    const scorecard = (issue.scorecard || {}) as Partial<Scorecard>;
    let cachedJudgeResult: JudgeResult | null = null;
    if (env.WORKER_PRE_PR_JUDGE_SELF_CHECK) {
      const prePrDiffText =
        (await git.diff([`${base}...HEAD`])) ||
        (await git.show(["--pretty=format:", "HEAD"])) ||
        "";
      cachedJudgeResult = await judgeGitDiffContext({
        issueTitle: issue.title,
        issueBody: issue.body || "",
        diffText: prePrDiffText,
        scorecard,
        knowledgeSnippets: contextHints?.knowledge_snippets || [],
        toolEvidence: editLoopResult.commandResults.map((result) => ({
          phase: result.phase,
          command: result.command,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          blocked_reason: result.blockedReason,
          stdout_tail: truncateText(result.stdout, 500),
          stderr_tail: truncateText(result.stderr, 500),
        })),
      });
      const prePrCheck = passesPrePrJudgeSelfCheck({
        enabled: true,
        score: cachedJudgeResult.verdict.code_quality_score,
        minScore: env.WORKER_JUDGE_MIN_SCORE_FOR_AWAITING_MERGE,
      });
      await setStage(
        job.id,
        "judging",
        {
          pre_pr_judge_self_check: true,
          pre_pr_judge_score: cachedJudgeResult.verdict.code_quality_score,
          pre_pr_judge_passed: prePrCheck.passed,
          pre_pr_judge_min_score: env.WORKER_JUDGE_MIN_SCORE_FOR_AWAITING_MERGE,
        },
        job.lease_token,
      );
      if (!prePrCheck.passed) {
        throw new Error(prePrCheck.reason || "Pre-PR judge self-check failed");
      }
      finalJudgeScore = cachedJudgeResult.verdict.code_quality_score;
    }

    if (!dryRun) {
      await setStage(job.id, "pushing", { branch_name: branchName }, job.lease_token);
      const pushResult = await pushBranchWithRecovery({
        git,
        branchName,
        onRecoveryStart: async ({ initialError }) => {
          logWorkerEvent("push_retrying", {
            job_id: job.id,
            branch_name: branchName,
            message: truncateText(initialError, 400),
          });
          await setStage(job.id, "pushing", {
            branch_name: branchName,
            push_retry_reason: "non_fast_forward",
            push_retry_message: truncateText(initialError, 600),
          }, job.lease_token);
          await heartbeat(job.id, job.lease_token);
        },
      });
      await heartbeat(job.id, job.lease_token);
      if (pushResult.recovered) {
        logWorkerEvent("push_recovered", {
          job_id: job.id,
          branch_name: branchName,
          recovery_strategy: pushResult.strategy,
        });
      }
      logWorkerEvent("push_completed", {
        job_id: job.id,
        branch_name: branchName,
        recovered_from_non_fast_forward: pushResult.recovered,
        recovery_strategy: pushResult.strategy,
      });
    } else {
      await setStage(job.id, "judging", {
        branch_name: branchName,
        dry_run: true,
      }, job.lease_token);
    }

    const octokit = new Octokit({ auth: token });
    let prNumber: number | null = null;
    if (!dryRun) {
      const existingOpenPr = await octokit.rest.pulls.list({
        owner: link.github_owner,
        repo: link.github_repo,
        head: `${link.github_owner}:${branchName}`,
        state: "open",
        per_page: 1,
      });

      if (existingOpenPr.data.length > 0) {
        prNumber = existingOpenPr.data[0].number;
      } else {
        const { data: prData } = await octokit.rest.pulls.create({
          owner: link.github_owner,
          repo: link.github_repo,
          title: `[Kaizen] ${issue.title}`,
          head: branchName,
          base: link.default_branch || job.base_branch,
          body: `Automated agent work for internal issue \`${job.issue_id}\` by \`${agentEns}\`.`,
        });
        prNumber = prData.number;
      }

      await setStage(job.id, "pr_opened", { github_pr_number: prNumber, branch_name: branchName }, job.lease_token);
      logWorkerEvent("pr_opened", {
        job_id: job.id,
        pr_number: prNumber,
        branch_name: branchName,
      });
    }

    const diffRange = `${base}...${branchName}`;
    const diffSummary = await git.diffSummary([diffRange]);
    const diffText =
      (await git.diff([diffRange])) || `Files changed: ${diffSummary.files.length}`;

    const diffUpdated = await query<{ id: string }>(
      `UPDATE git_jobs
       SET diff_summary_json = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2
         AND ($3::text IS NULL OR lease_token = $3)
       RETURNING id`,
      [
        JSON.stringify({
          changed_files: diffSummary.changed,
          insertions: diffSummary.insertions,
          deletions: diffSummary.deletions,
          files: diffSummary.files,
        }),
        job.id,
        job.lease_token,
      ],
    );
    if (diffUpdated.length === 0) {
      throw new Error("Lease lost while updating diff summary");
    }

    await setStage(job.id, "judging", undefined, job.lease_token);
    await heartbeat(job.id, job.lease_token);

    const judgeResult =
      cachedJudgeResult ??
      (await judgeGitDiffContext({
        issueTitle: issue.title,
        issueBody: issue.body || "",
        diffText,
        scorecard,
        knowledgeSnippets: contextHints?.knowledge_snippets || [],
        toolEvidence: editLoopResult.commandResults.map((result) => ({
          phase: result.phase,
          command: result.command,
          exit_code: result.exitCode,
          timed_out: result.timedOut,
          blocked_reason: result.blockedReason,
          stdout_tail: truncateText(result.stdout, 500),
          stderr_tail: truncateText(result.stderr, 500),
        })),
      }));

    logWorkerEvent("judge_completed", {
      job_id: job.id,
      score: judgeResult.verdict.code_quality_score,
      mock: judgeResult.is_mock,
      dry_run: dryRun,
    });
    finalJudgeScore = judgeResult.verdict.code_quality_score;

    const analysis =
      `## Judge (${judgeResult.is_mock ? "mock" : "LLM"})\n\n` +
      `<!-- kaizen-judge:${job.id} -->\n\n` +
      `**Score:** ${judgeResult.verdict.code_quality_score}/10\n\n` +
      `${judgeResult.verdict.reasoning}\n`;

    await storeJudgement(job.issue_id, job.agent_id, judgeResult, {
      prNumber: prNumber ?? null,
      commentBody: analysis,
    });

    if (!dryRun && prNumber != null) {
      const prBody = buildPullRequestWorkflowBody({
        job,
        issueTitle: issue.title,
        issueBody: issue.body || "",
        owner: link.github_owner,
        repo: link.github_repo,
        branchName,
        baseBranch: link.default_branch || job.base_branch,
        agentEns,
        autonomousPlan,
        editLoop: editLoopResult,
        diffSummary: {
          changed: diffSummary.changed,
          insertions: diffSummary.insertions,
          deletions: diffSummary.deletions,
          files: normalizeWorkflowDiffFiles(diffSummary.files),
        },
        diffText,
      });

      await octokit.rest.pulls.update({
        owner: link.github_owner,
        repo: link.github_repo,
        pull_number: prNumber,
        body: prBody,
      });
    }

    if (bounty && !dryRun) {
      await bountyService.persistGitHubJudgeOnBounty(
        bounty.id,
        judgeResult.verdict,
        judgeResult.verdict.code_quality_score,
        judgeResult.is_mock,
      );
      if (prNumber != null) {
        await bountyService.setBountyGithubPrNumber(bounty.id, prNumber);
      }
    }

    const compactLoopResults = editLoopResult.commandResults.map(compactCommandResult);
    const failedToolEvidence = editLoopResult.commandResults
      .filter((result) => result.blockedReason || result.timedOut || result.exitCode !== 0)
      .map((result) => {
        const note = result.blockedReason
          ? `blocked:${result.blockedReason}`
          : result.timedOut
            ? "timed_out"
            : `exit:${result.exitCode}`;
        return `${result.phase}:${result.command} (${note})`;
      })
      .slice(0, 4);
    const correctiveActions = uniqStrings([
      ...judgeResult.verdict.failed_tests.map((testName) => `Fix failing test path: ${testName}`),
      ...judgeResult.verdict.suggestions,
      ...failedToolEvidence.map((item) => `Resolve tool execution issue: ${item}`),
      "Re-run verification commands locally until all checks are green.",
    ]).slice(0, 8);
    const nextAttemptConstraints = uniqStrings([
      "Do not open/update PR until strict verification commands pass.",
      "Ensure source diffs include implementation changes beyond KAIZEN_AGENT.md.",
      ...correctiveActions.map((action) => `Constraint: ${action}`),
    ]).slice(0, 10);

    try {
      const memoryCommit = await commitWorkerMemory({
        jobId: job.id,
        branchName,
        message: `judge: code quality ${judgeResult.verdict.code_quality_score}/10 for issue ${job.issue_id.slice(0, 8)}`,
        content: JSON.stringify(
          {
            issue_id: job.issue_id,
            job_id: job.id,
            branch_name: branchName,
            pr_number: prNumber,
            scorecard,
            verdict: judgeResult.verdict,
            points_awarded: judgeResult.points_awarded,
            is_mock: judgeResult.is_mock,
            diff_summary: {
              changed_files: diffSummary.changed,
              insertions: diffSummary.insertions,
              deletions: diffSummary.deletions,
              files: diffSummary.files,
            },
            edit_loop: {
              passed: editLoopResult.passed,
              cycles: editLoopResult.cycles,
              verify_commands: editLoopResult.verifyCommands,
              fix_commands: editLoopResult.fixCommands,
              results: compactLoopResults,
            },
            generated_at: new Date().toISOString(),
          },
          null,
          2,
        ),
        knowledgeContext: {
          decisions: [
            `Judge score ${judgeResult.verdict.code_quality_score}/10`,
            `Loop cycles ${editLoopResult.cycles}`,
          ],
          next_steps:
            judgeResult.verdict.code_quality_score >= 7
              ? ["Await merge webhook settlement", "Monitor downstream integration feedback"]
              : ["Address failed tests and suggestions before merge", "Re-run verification loop with focused fixes"],
          handoff_summary: judgeResult.verdict.reasoning,
        },
        failureContext:
          judgeResult.verdict.code_quality_score < 7
            ? {
                failed: true,
                error_type: "quality_gate",
                error_detail: `Judge score ${judgeResult.verdict.code_quality_score}/10 below preferred threshold`,
                failed_approach: "initial edit loop",
                root_cause: judgeResult.verdict.reasoning,
                severity: judgeResult.verdict.code_quality_score < 5 ? "high" : "medium",
                corrective_actions: correctiveActions,
                next_attempt_constraints: nextAttemptConstraints,
                related_examples: failedToolEvidence,
              }
            : undefined,
        trace: {
          prompt: "worker-judge-memory-commit",
          context: {
            issue_id: job.issue_id,
            job_id: job.id,
            pr_number: prNumber,
            score: judgeResult.verdict.code_quality_score,
            edit_loop_cycles: editLoopResult.cycles,
          },
          tools: [
            {
              name: "judgeGitDiffContext",
              input: {
                issue_title: issue.title,
                issue_body_len: (issue.body || "").length,
                diff_range: diffRange,
              },
              output: {
                score: judgeResult.verdict.code_quality_score,
                is_mock: judgeResult.is_mock,
              },
            },
          ],
          result: `stored-judge-memory:${job.id}`,
        },
      });

      if (memoryCommit) {
        await setStage(job.id, "judging", {
          memory_commit_id: memoryCommit.commit_id,
          memory_commit_branch: memoryCommit.branch_name,
        }, job.lease_token);
      }
    } catch (memoryError: unknown) {
      const msg = memoryError instanceof Error ? memoryError.message : String(memoryError);
      await setStage(job.id, "judging", {
        memory_commit_error: truncateText(msg, 600),
      }, job.lease_token);
      logWorkerEvent("job_failed", {
        job_id: job.id,
        message: `memory_commit_non_fatal:${truncateText(msg, 240)}`,
        dry_run: dryRun,
      });
    }

    if (!dryRun && prNumber != null) {
      let commentId: number;
      if (job.judge_comment_id) {
        commentId = job.judge_comment_id;
      } else {
        const existingComments = await octokit.rest.issues.listComments({
          owner: link.github_owner,
          repo: link.github_repo,
          issue_number: prNumber,
          per_page: 100,
        });
        const dedupeMarker = `<!-- kaizen-judge:${job.id} -->`;
        const existingComment = existingComments.data.find((c) => (c.body || "").includes(dedupeMarker));

        if (existingComment) {
          commentId = existingComment.id;
        } else {
          const createdComment = await octokit.rest.issues.createComment({
            owner: link.github_owner,
            repo: link.github_repo,
            issue_number: prNumber,
            body: analysis,
          });
          commentId = createdComment.data.id;
        }
      }

      const commentUpdated = await query<{ id: string }>(
        `UPDATE git_jobs
         SET judge_comment_id = $1,
             updated_at = NOW()
         WHERE id = $2
           AND ($3::text IS NULL OR lease_token = $3)
         RETURNING id`,
        [commentId, job.id, job.lease_token],
      );
      if (commentUpdated.length === 0) {
        throw new Error("Lease lost while recording judge comment");
      }

      logWorkerEvent("comment_posted", {
        job_id: job.id,
        pr_number: prNumber,
        comment_id: commentId,
      });
      await setStage(job.id, "comment_posted", undefined, job.lease_token);
    }

    const minMergeScore = env.WORKER_JUDGE_MIN_SCORE_FOR_AWAITING_MERGE;
    if (!dryRun && minMergeScore > 0) {
      const scoreGatePassed = passesAwaitingMergeScoreGate({
        score: judgeResult.verdict.code_quality_score,
        minScore: minMergeScore,
      });
      await setStage(
        job.id,
        "judging",
        {
          judge_score_gate_min: minMergeScore,
          judge_score_gate_score: judgeResult.verdict.code_quality_score,
          judge_score_gate_passed: scoreGatePassed,
        },
        job.lease_token,
      );

      if (!scoreGatePassed) {
        throw new Error(
          `Judge score gate failed: ${judgeResult.verdict.code_quality_score}/10 is below required minimum ${minMergeScore}/10`,
        );
      }
    }

    finalBranchName = branchName;
    finalPrNumber = prNumber;
    didSucceed = true;
    if (dryRun) {
      logWorkerEvent("dry_run_completed", {
        job_id: job.id,
        branch_name: branchName,
        dry_run: true,
      });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logWorkerEvent("job_failed", {
      job_id: job.id,
      message: msg.slice(0, 500),
      dry_run: dryRun,
    });
    await failJob(job, msg, classifyError(msg));
  } finally {
    await cleanup();
    logWorkerEvent("cleanup_completed", {
      job_id: job.id,
      work_dir: workDir,
      dry_run: dryRun,
    });
    if (didSucceed) {
      if (dryRun) {
        await query(
          `UPDATE git_jobs
           SET status = 'completed',
               stage = 'completed',
               completed_at = COALESCE(completed_at, NOW()),
               lease_token = NULL,
               lease_owner = NULL,
               lease_expires_at = NULL,
               retry_after = NULL,
               updated_at = NOW(),
               error_message = NULL
           WHERE id = $1`,
          [jobId],
        );
        await setStage(job.id, "completed", { dry_run: true, branch_name: finalBranchName });
      } else {
        await query(
          `UPDATE git_jobs
           SET status = 'awaiting_merge',
               stage = 'awaiting_merge',
               branch_name = $1,
               github_pr_number = $2,
               lease_token = NULL,
               lease_owner = NULL,
               lease_expires_at = NULL,
               retry_after = NULL,
               updated_at = NOW(),
               error_message = NULL
           WHERE id = $3`,
          [finalBranchName, finalPrNumber, jobId],
        );
        await setStage(job.id, "awaiting_merge", {
          branch_name: finalBranchName,
          github_pr_number: finalPrNumber,
        });
      }
      logWorkerEvent("job_completed", {
        job_id: job.id,
        branch_name: finalBranchName,
        pr_number: finalPrNumber,
        judge_score: finalJudgeScore,
        dry_run: dryRun,
      });
    } else {
      await query(
        `UPDATE git_jobs
         SET payload = COALESCE(payload, '{}'::jsonb) || '{"cleanup_done": true}'::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [job.id],
      );
    }
  }
}

export async function claimNextPendingGitJob(): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id
       FROM git_jobs
       WHERE (
         status = 'pending' AND (retry_after IS NULL OR retry_after <= NOW())
       ) OR (
         status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= NOW()
       )
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const id = rows[0]?.id;
    if (!id) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `UPDATE git_jobs
       SET status = 'running',
           stage = 'leased',
           lease_token = uuid_generate_v4()::text,
           attempt = attempt + 1,
           attempt_count = attempt_count + 1,
           lease_owner = $2,
           lease_expires_at = NOW() + (($3::bigint || ' milliseconds')::interval),
           last_heartbeat_at = NOW(),
           retry_after = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [id, workerInstanceId, env.WORKER_LEASE_TIMEOUT_MS],
    );

    await client.query("COMMIT");
    return id;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
