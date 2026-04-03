import fs from "fs/promises";
import os from "os";
import path from "path";
import { Octokit } from "@octokit/rest";
import simpleGit from "simple-git";
import { pool, query, queryOne } from "../db/client";
import { env } from "../env";
import {
  getGitHubLinkForRepo,
  getGitHubTokenForUser,
} from "./github-integration";
import * as bountyService from "./bounty";
import { judgeGitDiffContext, storeJudgement } from "./judge";
import type { Scorecard } from "./judge";

interface GitJobRow {
  id: string;
  issue_id: string;
  repo_id: string;
  user_id: string;
  agent_id: string;
  base_branch: string;
  status: string;
  branch_name: string | null;
  github_pr_number: number | null;
  payload: Record<string, unknown> | null;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "issue";
}

async function rmrf(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function processGitJobById(jobId: string): Promise<void> {
  const job = await queryOne<GitJobRow>("SELECT * FROM git_jobs WHERE id = $1", [jobId]);
  if (!job || job.status !== "running") return;

  const link = await getGitHubLinkForRepo(job.repo_id);
  const token = await getGitHubTokenForUser(job.user_id);
  if (!link || !token) {
    await query(
      `UPDATE git_jobs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      ["Missing GitHub remote on repository or GitHub API key on user", jobId],
    );
    return;
  }

  const issue = await queryOne<{ title: string; body: string | null; scorecard: unknown }>(
    "SELECT title, body, scorecard FROM issues WHERE id = $1",
    [job.issue_id],
  );
  if (!issue) {
    await query(
      `UPDATE git_jobs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      ["Issue not found", jobId],
    );
    return;
  }

  const bounty = await bountyService.getIssueBounty(job.issue_id);
  const tmpRoot = env.GIT_TMP_ROOT || path.join(os.tmpdir(), "kaizen-git-jobs");
  await fs.mkdir(tmpRoot, { recursive: true });
  const dirName = `job-${job.id}`;
  const workDir = path.join(tmpRoot, dirName);
  let cleaned = false;

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await rmrf(workDir);
    } catch {
      /* ignore */
    }
  };

  try {
    const remote = `https://x-access-token:${token}@github.com/${link.github_owner}/${link.github_repo}.git`;
    const base = link.default_branch || job.base_branch;
    const rootGit = simpleGit(tmpRoot);
    await rootGit.clone(remote, dirName, ["--depth", "1", "--branch", base]);

    const git = simpleGit(workDir);
    const branchName = `agent/${job.issue_id.slice(0, 8)}-${slug(issue.title)}`;
    await git.checkoutBranch(branchName, base);

    const agentNote = path.join(workDir, "KAIZEN_AGENT.md");
    await fs.writeFile(
      agentNote,
      `# Agent proposal\n\n**Issue:** ${issue.title}\n\n${issue.body || ""}\n\n_Updated ${new Date().toISOString()}_\n`,
      "utf8",
    );
    await git.add(["KAIZEN_AGENT.md"]);
    await git.commit(`chore: agent proposal for issue (${job.issue_id.slice(0, 8)})`);
    await git.push("origin", branchName);

    const octokit = new Octokit({ auth: token });
    const { data: prData } = await octokit.rest.pulls.create({
      owner: link.github_owner,
      repo: link.github_repo,
      title: `[Kaizen] ${issue.title}`,
      head: branchName,
      base: link.default_branch || job.base_branch,
      body: `Automated agent work for internal issue \`${job.issue_id}\`.`,
    });

    const prNumber = prData.number;
    const diffRange = `${base}...${branchName}`;
    const diffSummary = await git.diffSummary([diffRange]);
    const diffText =
      (await git.diff([diffRange])) || `Files changed: ${diffSummary.files.length}`;

    const scorecard = (issue.scorecard || {}) as Scorecard;
    const judgeResult = await judgeGitDiffContext({
      issueTitle: issue.title,
      issueBody: issue.body || "",
      diffText,
      scorecard,
    });

    await storeJudgement(job.issue_id, job.agent_id, judgeResult);

    if (bounty) {
      await bountyService.persistGitHubJudgeOnBounty(
        bounty.id,
        judgeResult.verdict,
        judgeResult.verdict.code_quality_score,
      );
      await bountyService.setBountyGithubPrNumber(bounty.id, prNumber);
    }

    const analysis = `## Judge (${judgeResult.is_mock ? "mock" : "LLM"})\n\n**Score:** ${judgeResult.verdict.code_quality_score}/10\n\n${judgeResult.verdict.reasoning}\n`;

    await octokit.rest.issues.createComment({
      owner: link.github_owner,
      repo: link.github_repo,
      issue_number: prNumber,
      body: analysis,
    });

    await query(
      `UPDATE git_jobs SET status = 'done', branch_name = $1, github_pr_number = $2, updated_at = NOW(), error_message = NULL WHERE id = $3`,
      [branchName, prNumber, jobId],
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    await query(
      `UPDATE git_jobs SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2`,
      [msg.slice(0, 2000), jobId],
    );
  } finally {
    await cleanup();
  }
}

export async function claimNextPendingGitJob(): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM git_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const id = rows[0]?.id;
    if (!id) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(`UPDATE git_jobs SET status = 'running', updated_at = NOW() WHERE id = $1`, [id]);
    await client.query("COMMIT");
    return id;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
