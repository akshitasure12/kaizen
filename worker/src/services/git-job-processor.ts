import fs from "fs/promises";
import os from "os";
import path from "path";
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import { pool, query, queryOne } from "../db/client";
import { env } from "../env";
import { getGitHubLinkForRepo, getGitHubTokenForUser } from "./github-integration";
import * as bountyService from "./bounty";
import {
  parseJobCliHints,
  refineCliHintsForWorkspace,
  renderKaizenAgentNote,
} from "./cli-context-hints";
import { judgeGitDiffContext, storeJudgement, type Scorecard } from "./judge";
import { executeToolCommand, type ToolExecutionResult as CommandExecutionResult } from "./tool-execution";

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
  editCommands: string[];
  verifyCommands: string[];
  fixCommands: string[];
  commandResults: CommandExecutionResult[];
}

type ErrorClass = "transient" | "permanent";

const workerInstanceId = env.WORKER_INSTANCE_ID || `${os.hostname()}-${process.pid}`;
const allowedToolCommands = new Set(env.WORKER_ALLOWED_COMMANDS.map((value) => value.toLowerCase()));

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "issue"
  );
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

export function retryBackoffMs(attempt: number): number {
  const power = Math.max(0, attempt - 1);
  const value = env.WORKER_BASE_RETRY_MS * Math.pow(2, power);
  const capped = Math.min(env.WORKER_MAX_RETRY_MS, Math.floor(value));
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(capped * 0.2)));
  return Math.min(env.WORKER_MAX_RETRY_MS, capped + jitter);
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
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
  return c.includes("--help") || c.includes("|| true");
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

function compactCommandResult(result: CommandExecutionResult): Record<string, unknown> {
  return {
    phase: result.phase,
    cycle: result.cycle,
    command: result.command,
    command_bin: result.executable,
    command_args: result.args,
    exit_code: result.exitCode,
    signal: result.signal,
    duration_ms: result.durationMs,
    timed_out: result.timedOut,
    blocked_reason: result.blockedReason,
    stdout_tail: truncateText(result.stdout, 800),
    stderr_tail: truncateText(result.stderr, 800),
  };
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
        JSON.stringify(result.args),
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
}): string[] {
  const payloadCommands = toStringArray(params.payload?.verify_commands);
  const merged = uniqCommands([...payloadCommands, ...params.hintedVerifyCommands]);
  const strict = merged.filter((command) => !commandLooksLikeNonBlockingProbe(command));
  return (strict.length > 0 ? strict : merged).slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

export function resolveFixCommands(payload: Record<string, unknown> | null): string[] {
  return uniqCommands(toStringArray(payload?.fix_commands)).slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

export function resolveEditCommands(payload: Record<string, unknown> | null): string[] {
  return uniqCommands(toStringArray(payload?.edit_commands)).slice(0, env.WORKER_TOOL_MAX_COMMANDS);
}

async function runEditVerifyFixLoop(params: {
  jobId: string;
  workDir: string;
  payload: Record<string, unknown> | null;
  hintedVerifyCommands: string[];
  leaseToken: string | null;
}): Promise<EditLoopSummary> {
  const editCommands = resolveEditCommands(params.payload);
  const verifyCommands = resolveVerificationCommands({
    payload: params.payload,
    hintedVerifyCommands: params.hintedVerifyCommands,
  });
  const fixCommands = resolveFixCommands(params.payload);

  if (editCommands.length === 0 && verifyCommands.length === 0) {
    return {
      passed: true,
      cycles: 0,
      editCommands,
      verifyCommands,
      fixCommands,
      commandResults: [],
    };
  }

  const requestedCycles = toPositiveInt(params.payload?.loop_max_cycles);
  const maxCycles = Math.max(1, Math.min(6, requestedCycles ?? env.WORKER_LOOP_MAX_CYCLES));
  const commandResults: CommandExecutionResult[] = [];

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    await setStage(params.jobId, "editing", {
      edit_loop_cycle: cycle,
      edit_loop_max_cycles: maxCycles,
      edit_command_count: editCommands.length,
      verify_command_count: verifyCommands.length,
      fix_command_count: fixCommands.length,
    }, params.leaseToken);

    if (cycle === 1 && editCommands.length > 0) {
      for (const command of editCommands) {
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
          return {
            passed: false,
            cycles: cycle,
            editCommands,
            verifyCommands,
            fixCommands,
            commandResults,
          };
        }
      }
    }

    if (verifyCommands.length === 0) {
      return {
        passed: true,
        cycles: cycle,
        editCommands,
        verifyCommands,
        fixCommands,
        commandResults,
      };
    }

    let cyclePassed = true;
    for (const command of verifyCommands) {
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
      if (result.blockedReason || result.timedOut || result.exitCode !== 0) {
        cyclePassed = false;
        break;
      }
    }

    if (cyclePassed) {
      return {
        passed: true,
        cycles: cycle,
        editCommands,
        verifyCommands,
        fixCommands,
        commandResults,
      };
    }

    if (cycle >= maxCycles || fixCommands.length === 0) {
      break;
    }

    for (const command of fixCommands) {
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
      if (result.blockedReason || result.timedOut || result.exitCode !== 0) {
        break;
      }
    }
  }

  return {
    passed: false,
    cycles: maxCycles,
    editCommands,
    verifyCommands,
    fixCommands,
    commandResults,
  };
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

  const token = await getGitHubTokenForUser(job.user_id);
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

  const bounty = await bountyService.getIssueBounty(job.issue_id);
  const tmpRoot = ensureTmpScopedPath(getTmpRoot());
  await fs.mkdir(tmpRoot, { recursive: true });
  const dirName = `job-${job.id}-attempt-${job.attempt_count}`;
  const workDir = path.join(tmpRoot, dirName);
  let cleaned = false;
  let finalBranchName: string | null = null;
  let finalPrNumber: number | null = null;
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

    await setStage(job.id, "planning", {
      issue_title: issue.title,
      issue_len: (issue.body || "").length,
      base_branch: base,
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
    const branchName = job.branch_name || `agent/${job.issue_id.slice(0, 8)}-${slug(issue.title)}`;
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
          issueBody: issue.body || "",
          seedHints: parsedHints.contextHints,
          maxFiles: env.CLI_CONTEXT_HINTS_MAX_FILES,
          maxTests: env.CLI_CONTEXT_HINTS_MAX_TESTS,
          scanLimit: env.CLI_CONTEXT_HINTS_SCAN_LIMIT,
        })
      : parsedHints.contextHints;

    const hintedVerifyCommands = uniqCommands([
      ...toStringArray(parsedHints.verificationHints?.suggested_test_commands),
      ...toStringArray(contextHints?.command_suggestions.verify),
    ]);

    await setStage(job.id, "editing", {
      context_hint_count: contextHints?.ranked_files.length ?? 0,
      test_hint_count: contextHints?.ranked_tests.length ?? 0,
      search_term_count: contextHints?.search_terms.length ?? 0,
      suggested_verify_count: hintedVerifyCommands.length,
    }, job.lease_token);

    const agentNote = path.join(workDir, "KAIZEN_AGENT.md");
    const agentNoteContent = renderKaizenAgentNote({
      issueTitle: issue.title,
      issueBody: issue.body || "",
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
      payload: job.payload,
      hintedVerifyCommands,
      leaseToken: job.lease_token,
    });

    await setStage(job.id, "editing", {
      edit_loop_passed: editLoop.passed,
      edit_loop_cycles: editLoop.cycles,
      edit_loop_edit_commands: editLoop.editCommands,
      edit_loop_verify_commands: editLoop.verifyCommands,
      edit_loop_fix_commands: editLoop.fixCommands,
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

    const changedPaths = workspaceStatus.files.map((file) => file.path);
    const implementationChanges = changedPaths.filter((value) => value !== "KAIZEN_AGENT.md");
    const allowNoteOnly = job.payload?.allow_note_only === true;
    if (!allowNoteOnly && implementationChanges.length === 0) {
      throw new Error(
        "No implementation diff detected beyond KAIZEN_AGENT.md. Provide payload.edit_commands or fix commands that modify source files.",
      );
    }

    await setStage(job.id, "committing", { branch_name: branchName }, job.lease_token);
    await git.add(["-A"]);
    await git.commit(`feat: agent implementation for issue (${job.issue_id.slice(0, 8)})`);
    logWorkerEvent("commit_created", {
      job_id: job.id,
      branch_name: branchName,
      dry_run: dryRun,
      edited_file_count: workspaceStatus.files.length,
    });

    if (!dryRun) {
      await setStage(job.id, "pushing", { branch_name: branchName }, job.lease_token);
      await git.push("origin", branchName);
      await heartbeat(job.id, job.lease_token);
      logWorkerEvent("push_completed", {
        job_id: job.id,
        branch_name: branchName,
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
          body: `Automated agent work for internal issue \`${job.issue_id}\`.`,
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

    const scorecard = (issue.scorecard || {}) as Partial<Scorecard>;
    const judgeResult = await judgeGitDiffContext({
      issueTitle: issue.title,
      issueBody: issue.body || "",
      diffText,
      scorecard,
      toolEvidence: editLoop.commandResults.map((result) => ({
        phase: result.phase,
        command: result.command,
        exit_code: result.exitCode,
        timed_out: result.timedOut,
        blocked_reason: result.blockedReason,
        stdout_tail: truncateText(result.stdout, 500),
        stderr_tail: truncateText(result.stderr, 500),
      })),
    });

    logWorkerEvent("judge_completed", {
      job_id: job.id,
      score: judgeResult.verdict.code_quality_score,
      mock: judgeResult.is_mock,
      dry_run: dryRun,
    });

    const analysis =
      `## Judge (${judgeResult.is_mock ? "mock" : "LLM"})\n\n` +
      `<!-- kaizen-judge:${job.id} -->\n\n` +
      `**Score:** ${judgeResult.verdict.code_quality_score}/10\n\n` +
      `${judgeResult.verdict.reasoning}\n`;

    await storeJudgement(job.issue_id, job.agent_id, judgeResult, {
      prNumber: prNumber ?? null,
      commentBody: analysis,
    });

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

    const compactLoopResults = editLoop.commandResults.map(compactCommandResult);
    const failedToolEvidence = editLoop.commandResults
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
              passed: editLoop.passed,
              cycles: editLoop.cycles,
              verify_commands: editLoop.verifyCommands,
              fix_commands: editLoop.fixCommands,
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
            `Loop cycles ${editLoop.cycles}`,
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
            edit_loop_cycles: editLoop.cycles,
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
