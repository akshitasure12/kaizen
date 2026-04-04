import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import { pool, query, queryOne } from "../db/client";
import { env } from "../env";
import { getGitHubLinkForRepo, getGitHubTokenForUser } from "./github-integration";
import * as bountyService from "./bounty";
import { judgeGitDiffContext, storeJudgement, type Scorecard } from "./judge";

interface GitJobRow {
  id: string;
  issue_id: string;
  repo_id: string;
  user_id: string;
  agent_id: string;
  base_branch: string;
  status: string;
  stage: string;
  attempt_count: number;
  max_attempts: number;
  branch_name: string | null;
  github_pr_number: number | null;
  plan_hash: string | null;
  armoriq_intent_id: string | null;
  payload: Record<string, unknown> | null;
}

type ErrorClass = "transient" | "permanent";

const workerInstanceId = env.WORKER_INSTANCE_ID || `${os.hostname()}-${process.pid}`;

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

function classifyError(message: string): ErrorClass {
  const m = message.toLowerCase();
  if (
    m.includes("rate limit") ||
    m.includes("timeout") ||
    m.includes("temporar") ||
    m.includes("econnreset") ||
    m.includes("enotfound") ||
    m.includes("network")
  ) {
    return "transient";
  }
  return "permanent";
}

function retryBackoffMs(attempt: number): number {
  const power = Math.max(0, attempt - 1);
  const value = env.WORKER_BASE_RETRY_MS * Math.pow(2, power);
  return Math.min(env.WORKER_MAX_RETRY_MS, Math.floor(value));
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

type WorkerEvent =
  | "job_claimed"
  | "planning_started"
  | "intent_recorded"
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

async function heartbeat(jobId: string): Promise<void> {
  await query(
    `UPDATE git_jobs
     SET last_heartbeat_at = NOW(),
         lease_expires_at = NOW() + (($1::bigint || ' milliseconds')::interval),
         updated_at = NOW()
     WHERE id = $2`,
    [env.WORKER_LEASE_TIMEOUT_MS, jobId],
  );
}

async function setStage(jobId: string, stage: string, payloadPatch?: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE git_jobs
     SET stage = $1,
         payload = COALESCE(payload, '{}'::jsonb) || COALESCE($2::jsonb, '{}'::jsonb),
         updated_at = NOW()
     WHERE id = $3`,
    [stage, payloadPatch ? JSON.stringify(payloadPatch) : null, jobId],
  );
}

async function recordInvocationReceipt(params: {
  jobId: string;
  stageName: string;
  stageSeq: number;
  actionName: string;
  planHash: string;
  success?: boolean;
  requestPayload?: unknown;
  responsePayload?: unknown;
}): Promise<void> {
  const requestJson = params.requestPayload == null ? "" : JSON.stringify(params.requestPayload);
  const responseJson = params.responsePayload == null ? "" : JSON.stringify(params.responsePayload);
  await query(
    `INSERT INTO armoriq_invocation_receipts (
       git_job_id,
       stage_name,
       stage_seq,
       action_name,
       mcp_name,
       plan_hash,
       proof_digest,
       request_digest,
       response_digest,
       success,
       execution_time_ms
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0)
     ON CONFLICT (git_job_id, stage_name, stage_seq)
     DO UPDATE SET
       action_name = EXCLUDED.action_name,
       plan_hash = EXCLUDED.plan_hash,
       proof_digest = EXCLUDED.proof_digest,
       request_digest = EXCLUDED.request_digest,
       response_digest = EXCLUDED.response_digest,
       success = EXCLUDED.success,
       occurred_at = NOW()`,
    [
      params.jobId,
      params.stageName,
      params.stageSeq,
      params.actionName,
      "worker-runtime",
      params.planHash,
      sha256Hex(`${params.stageName}:${params.stageSeq}:${params.actionName}:${params.planHash}`),
      requestJson ? sha256Hex(requestJson) : null,
      responseJson ? sha256Hex(responseJson) : null,
      params.success ?? true,
    ],
  );

  await query(
    `UPDATE git_jobs
     SET verification_status = CASE WHEN $1 THEN 'verified' ELSE 'failed' END,
         last_verified_stage = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [params.success ?? true, params.stageName, params.jobId],
  );
}

async function recordStageEvidence(params: {
  jobId: string;
  stageName: string;
  evidenceType: string;
  evidenceUrl?: string | null;
  evidencePayload?: unknown;
}): Promise<void> {
  const payload = params.evidencePayload == null ? "" : JSON.stringify(params.evidencePayload);
  await query(
    `INSERT INTO stage_evidence_links (git_job_id, stage_name, evidence_type, evidence_url, evidence_digest)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      params.jobId,
      params.stageName,
      params.evidenceType,
      params.evidenceUrl ?? null,
      payload ? sha256Hex(payload) : null,
    ],
  );
}

async function ensureJobIntent(params: {
  job: GitJobRow;
  issueTitle: string;
  issueBody: string;
  baseBranch: string;
}): Promise<{ planHash: string; intentId: string }> {
  if (params.job.plan_hash && params.job.armoriq_intent_id) {
    return { planHash: params.job.plan_hash, intentId: params.job.armoriq_intent_id };
  }

  const canonicalPlan = {
    issue_id: params.job.issue_id,
    agent_id: params.job.agent_id,
    repo_id: params.job.repo_id,
    base_branch: params.baseBranch,
    issue_title: params.issueTitle,
    issue_body: params.issueBody,
    stages: [
      "planning",
      "cloning",
      "editing",
      "committing",
      "pushing",
      "pr_opened",
      "judging",
      "comment_posted",
      "cleanup_done",
      "awaiting_merge",
    ],
  };
  const canonicalJson = JSON.stringify(canonicalPlan);
  const planHash = sha256Hex(canonicalJson);
  const merkleRoot = sha256Hex(`${planHash}:merkle`);
  const tokenJwtHash = sha256Hex(`${planHash}:${params.job.id}:intent`);

  const inserted = await query<{ id: string }>(
    `INSERT INTO armoriq_intents (
       git_job_id,
       plan_hash,
       merkle_root,
       canonical_version,
       token_jwt_hash,
       token_issued_at,
       token_policy_digest,
       token_identity_json
     ) VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7::jsonb)
     ON CONFLICT (git_job_id, plan_hash)
     DO UPDATE SET
       merkle_root = EXCLUDED.merkle_root,
       canonical_version = EXCLUDED.canonical_version,
       token_jwt_hash = EXCLUDED.token_jwt_hash,
       token_policy_digest = EXCLUDED.token_policy_digest,
       token_identity_json = EXCLUDED.token_identity_json
     RETURNING id`,
    [
      params.job.id,
      planHash,
      merkleRoot,
      "v1",
      tokenJwtHash,
      sha256Hex(canonicalJson),
      JSON.stringify({ runtime: "worker", mode: "mvp-overlay" }),
    ],
  );

  const intentId = inserted[0].id;
  await query(
    `UPDATE git_jobs
     SET plan_hash = $1,
         armoriq_intent_id = $2,
         verification_status = 'tokenized',
         updated_at = NOW()
     WHERE id = $3`,
    [planHash, intentId, params.job.id],
  );

  return { planHash, intentId };
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
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $5`,
    [retryable, retryAfterMs, klass, message, job.id],
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

  await heartbeat(job.id);

  const link = await getGitHubLinkForRepo(job.repo_id);
  const token = await getGitHubTokenForUser(job.user_id);
  if (!link || !token) {
    await failJob(job, "Missing GitHub remote on repository or GitHub API key on user", "permanent");
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
  let planHash = job.plan_hash ?? "";
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
    });
    const intent = await ensureJobIntent({
      job,
      issueTitle: issue.title,
      issueBody: issue.body || "",
      baseBranch: base,
    });
    planHash = intent.planHash;
    logWorkerEvent("intent_recorded", {
      job_id: job.id,
      intent_id: intent.intentId,
      plan_hash: planHash,
      dry_run: dryRun,
    });
    await recordInvocationReceipt({
      jobId: job.id,
      stageName: "planning",
      stageSeq: 1,
      actionName: "capture_plan",
      planHash,
      requestPayload: { issue_id: job.issue_id, repo_id: job.repo_id },
      responsePayload: { intent_id: intent.intentId, plan_hash: intent.planHash },
    });

    await setStage(job.id, "cloning");
    await heartbeat(job.id);

    // Always start each attempt from a clean /tmp workspace.
    await rmrf(workDir);
    logWorkerEvent("workspace_reset", {
      job_id: job.id,
      work_dir: workDir,
      attempt: job.attempt_count,
    });
    await recordStageEvidence({
      jobId: job.id,
      stageName: "cloning",
      evidenceType: "workspace",
      evidencePayload: {
        tmp_root: tmpRoot,
        work_dir: workDir,
        attempt: job.attempt_count,
        strategy: job.attempt_count > 1 ? "fresh-retry" : "initial",
      },
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
    await recordInvocationReceipt({
      jobId: job.id,
      stageName: "cloning",
      stageSeq: 2,
      actionName: "git_clone",
      planHash,
      requestPayload: { base_branch: base, work_dir: workDir, attempt: job.attempt_count },
    });

    await setStage(job.id, "editing");
    await heartbeat(job.id);

    const git = simpleGit(workDir);
    const branchName = job.branch_name || `agent/${job.issue_id.slice(0, 8)}-${slug(issue.title)}`;
    await git.checkoutBranch(branchName, base);
    logWorkerEvent("branch_created", {
      job_id: job.id,
      branch_name: branchName,
      base_branch: base,
      dry_run: dryRun,
    });

    const agentNote = path.join(workDir, "KAIZEN_AGENT.md");
    await fs.writeFile(
      agentNote,
      `# Agent proposal\n\n**Issue:** ${issue.title}\n\n${issue.body || ""}\n\n_Updated ${new Date().toISOString()}_\n`,
      "utf8",
    );

    await setStage(job.id, "committing", { branch_name: branchName });
    await git.add(["KAIZEN_AGENT.md"]);
    await git.commit(`chore: agent proposal for issue (${job.issue_id.slice(0, 8)})`);
    logWorkerEvent("commit_created", {
      job_id: job.id,
      branch_name: branchName,
      dry_run: dryRun,
    });
    await recordInvocationReceipt({
      jobId: job.id,
      stageName: "committing",
      stageSeq: 3,
      actionName: "git_commit",
      planHash,
      requestPayload: { branch_name: branchName },
    });

    if (!dryRun) {
      await setStage(job.id, "pushing", { branch_name: branchName });
      await git.push("origin", branchName);
      await heartbeat(job.id);
      logWorkerEvent("push_completed", {
        job_id: job.id,
        branch_name: branchName,
      });
      await recordInvocationReceipt({
        jobId: job.id,
        stageName: "pushing",
        stageSeq: 4,
        actionName: "git_push",
        planHash,
        requestPayload: { branch_name: branchName },
      });
    } else {
      await setStage(job.id, "judging", {
        branch_name: branchName,
        dry_run: true,
      });
      await recordInvocationReceipt({
        jobId: job.id,
        stageName: "pushing",
        stageSeq: 4,
        actionName: "dry_run_skip_git_push",
        planHash,
        requestPayload: { branch_name: branchName },
        responsePayload: { skipped: true, reason: "worker dry-run" },
      });
    }

    const octokit = new Octokit({ auth: token });
    let prNumber: number | null = null;
    let prUrl: string | undefined;
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
        prUrl = existingOpenPr.data[0].html_url;
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
        prUrl = prData.html_url;
      }

      await setStage(job.id, "pr_opened", { github_pr_number: prNumber, branch_name: branchName });
      logWorkerEvent("pr_opened", {
        job_id: job.id,
        pr_number: prNumber,
        branch_name: branchName,
      });
      await recordInvocationReceipt({
        jobId: job.id,
        stageName: "pr_opened",
        stageSeq: 5,
        actionName: "github_pr_open_or_resume",
        planHash,
        responsePayload: { pr_number: prNumber },
      });
      await recordStageEvidence({
        jobId: job.id,
        stageName: "pr_opened",
        evidenceType: "pull_request",
        evidenceUrl: prUrl,
        evidencePayload: { pr_number: prNumber, branch_name: branchName },
      });
    }

    const diffRange = `${base}...${branchName}`;
    const diffSummary = await git.diffSummary([diffRange]);
    const diffText =
      (await git.diff([diffRange])) || `Files changed: ${diffSummary.files.length}`;

    await setStage(job.id, "judging");
    await heartbeat(job.id);

    const scorecard = (issue.scorecard || {}) as Partial<Scorecard>;
    const judgeResult = await judgeGitDiffContext({
      issueTitle: issue.title,
      issueBody: issue.body || "",
      diffText,
      scorecard,
    });

    logWorkerEvent("judge_completed", {
      job_id: job.id,
      score: judgeResult.verdict.code_quality_score,
      mock: judgeResult.is_mock,
      dry_run: dryRun,
    });

    await storeJudgement(job.issue_id, job.agent_id, judgeResult);
    await recordInvocationReceipt({
      jobId: job.id,
      stageName: "judging",
      stageSeq: 6,
      actionName: "judge_diff",
      planHash,
      responsePayload: {
        score: judgeResult.verdict.code_quality_score,
        is_mock: judgeResult.is_mock,
      },
    });

    if (bounty && !dryRun) {
      await bountyService.persistGitHubJudgeOnBounty(
        bounty.id,
        judgeResult.verdict,
        judgeResult.verdict.code_quality_score,
      );
      if (prNumber != null) {
        await bountyService.setBountyGithubPrNumber(bounty.id, prNumber);
      }
    }

    if (!dryRun && prNumber != null) {
      const analysis =
        `## Judge (${judgeResult.is_mock ? "mock" : "LLM"})\n\n` +
        `<!-- kaizen-judge:${job.id} -->\n\n` +
        `**Score:** ${judgeResult.verdict.code_quality_score}/10\n\n` +
        `${judgeResult.verdict.reasoning}\n`;
      const existingComments = await octokit.rest.issues.listComments({
        owner: link.github_owner,
        repo: link.github_repo,
        issue_number: prNumber,
        per_page: 100,
      });
      const dedupeMarker = `<!-- kaizen-judge:${job.id} -->`;
      const existingComment = existingComments.data.find((c) => (c.body || "").includes(dedupeMarker));

      let commentId: number;
      let commentUrl: string | undefined;
      if (existingComment) {
        commentId = existingComment.id;
        commentUrl = existingComment.html_url;
      } else {
        const createdComment = await octokit.rest.issues.createComment({
          owner: link.github_owner,
          repo: link.github_repo,
          issue_number: prNumber,
          body: analysis,
        });
        commentId = createdComment.data.id;
        commentUrl = createdComment.data.html_url;
      }

      logWorkerEvent("comment_posted", {
        job_id: job.id,
        pr_number: prNumber,
        comment_id: commentId,
      });

      await recordInvocationReceipt({
        jobId: job.id,
        stageName: "comment_posted",
        stageSeq: 7,
        actionName: "github_pr_comment_dedupe",
        planHash,
        responsePayload: { comment_id: commentId },
      });
      await recordStageEvidence({
        jobId: job.id,
        stageName: "comment_posted",
        evidenceType: "judge_comment",
        evidenceUrl: commentUrl,
        evidencePayload: { comment_id: commentId, pr_number: prNumber },
      });
      await setStage(job.id, "comment_posted");
    } else {
      await recordInvocationReceipt({
        jobId: job.id,
        stageName: "comment_posted",
        stageSeq: 7,
        actionName: "dry_run_skip_pr_comment",
        planHash,
        responsePayload: { skipped: true, reason: "worker dry-run" },
      });
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
    if (planHash) {
      await recordInvocationReceipt({
        jobId: job.id,
        stageName: job.stage || "failed",
        stageSeq: 999,
        actionName: "execution_failure",
        planHash,
        success: false,
        responsePayload: { error: msg.slice(0, 500) },
      });
    }
  } finally {
    await cleanup();
    logWorkerEvent("cleanup_completed", {
      job_id: job.id,
      work_dir: workDir,
      dry_run: dryRun,
    });
    if (didSucceed) {
      await recordInvocationReceipt({
        jobId: job.id,
        stageName: "cleanup_done",
        stageSeq: 8,
        actionName: "cleanup_temp_clone",
        planHash,
      });
      if (dryRun) {
        await query(
          `UPDATE git_jobs
           SET status = 'done',
               stage = 'completed',
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
           SET status = 'done',
               stage = 'awaiting_merge',
               branch_name = $1,
               github_pr_number = $2,
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
      await setStage(job.id, "cleanup_done");
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
