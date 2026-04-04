import fs from "fs/promises";
import os from "os";
import path from "path";
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import { pool, query, queryOne } from "../db/client";
import { env } from "../env";
import { getGitHubAppInstallationToken, getGitHubLinkForRepo } from "./github-integration";
import * as bountyService from "./bounty";
import {
  parseJobCliHints,
  refineCliHintsForWorkspace,
  renderKaizenAgentNote,
} from "./cli-context-hints";
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

function retryBackoffMs(attempt: number): number {
  const power = Math.max(0, attempt - 1);
  const value = env.WORKER_BASE_RETRY_MS * Math.pow(2, power);
  const capped = Math.min(env.WORKER_MAX_RETRY_MS, Math.floor(value));
  const jitter = Math.floor(Math.random() * Math.max(250, Math.floor(capped * 0.2)));
  return Math.min(env.WORKER_MAX_RETRY_MS, capped + jitter);
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
  if (!link) {
    await failJob(job, "Missing GitHub repository link for git job", "permanent");
    return;
  }

  let token: string;
  try {
    token = await getGitHubAppInstallationToken(link.installation_id);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(job, `Failed to derive installation token: ${msg}`, classifyError(msg));
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

    const remote = `https://x-access-token:${token}@github.com/${link.github_owner}/${link.github_repo}.git`;
    const rootGit = simpleGit(tmpRoot);
    await rootGit.clone(remote, dirName, ["--depth", "1", "--branch", base]);
    logWorkerEvent("clone_completed", {
      job_id: job.id,
      work_dir: workDir,
      branch: base,
      dry_run: dryRun,
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

    await setStage(job.id, "editing", {
      context_hint_count: contextHints?.ranked_files.length ?? 0,
      test_hint_count: contextHints?.ranked_tests.length ?? 0,
      search_term_count: contextHints?.search_terms.length ?? 0,
    });

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

    await setStage(job.id, "committing", { branch_name: branchName });
    await git.add(["KAIZEN_AGENT.md"]);
    await git.commit(`chore: agent proposal for issue (${job.issue_id.slice(0, 8)})`);
    logWorkerEvent("commit_created", {
      job_id: job.id,
      branch_name: branchName,
      dry_run: dryRun,
    });

    if (!dryRun) {
      await setStage(job.id, "pushing", { branch_name: branchName });
      await git.push("origin", branchName);
      await heartbeat(job.id);
      logWorkerEvent("push_completed", {
        job_id: job.id,
        branch_name: branchName,
      });
    } else {
      await setStage(job.id, "judging", {
        branch_name: branchName,
        dry_run: true,
      });
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

      await setStage(job.id, "pr_opened", { github_pr_number: prNumber, branch_name: branchName });
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

    await query(
      `UPDATE git_jobs
       SET diff_summary_json = $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [
        JSON.stringify({
          changed_files: diffSummary.changed,
          insertions: diffSummary.insertions,
          deletions: diffSummary.deletions,
          files: diffSummary.files,
        }),
        job.id,
      ],
    );

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
      );
      if (prNumber != null) {
        await bountyService.setBountyGithubPrNumber(bounty.id, prNumber);
      }
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

      await query(
        `UPDATE git_jobs
         SET judge_comment_id = $1,
             updated_at = NOW()
         WHERE id = $2`,
        [commentId, job.id],
      );

      logWorkerEvent("comment_posted", {
        job_id: job.id,
        pr_number: prNumber,
        comment_id: commentId,
      });
      await setStage(job.id, "comment_posted");
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
