import crypto from "crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { pool, queryOne } from "../db/client";
import { env } from "../env";
import * as sdk from "../sdk";
import {
  applyGitHubMergePayoutInTransaction,
  findIssueBountyByGithubPr,
  payoutFractionFromCodeQuality,
  refundBountyOnGitHubCloseWithoutMergeInTransaction,
} from "../services/bounty";
import { deriveCorrectiveActionsForOutcome, recordAgentOutcomeInTransaction } from "../services/agent-outcomes";
import { finalizeIssueLifecycleAfterSettlement } from "../services/issue-lifecycle";

type ReqRaw = FastifyRequest & { rawBody?: Buffer };

const SETTLEABLE_GIT_JOB_STATUSES = new Set(["awaiting_merge", "completed"]);

export function isGitJobSettleable(params: {
  status: string;
  githubPrNumber: number | null;
  mergedPrNumber: number;
}): boolean {
  const statusOk = SETTLEABLE_GIT_JOB_STATUSES.has(params.status);
  const prOk = params.githubPrNumber == null || params.githubPrNumber === params.mergedPrNumber;
  return statusOk && prOk;
}

export function buildMergeSemanticKey(owner: string, repo: string, prNumber: number, merged: boolean, mergeCommitSha?: string): string {
  const ref = merged ? (mergeCommitSha || "merged") : "closed_without_merge";
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}:${ref}`;
}

function verifyGithubSignature(secret: string, payload: Buffer, signature: string | undefined): boolean {
  if (!signature || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const sig = signature.trim();
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

function toNormalizedJudgeScore(verdict: unknown): number | null {
  if (!verdict || typeof verdict !== "object") return null;
  const score = (verdict as { code_quality_score?: unknown }).code_quality_score;
  if (typeof score !== "number") return null;
  return Math.min(1, Math.max(0, (score - 1) / 9));
}

function uniqueStrings(values: string[]): string[] {
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

function buildNextAttemptConstraints(correctiveActions: string[]): string[] {
  return uniqueStrings([
    "Run strict verification commands and ensure zero failed tests before requesting merge.",
    "Address reviewer comments within one iteration and keep the PR active until settlement.",
    "Document root cause and recovery steps in KAIZEN_AGENT.md before retry.",
    ...correctiveActions.map((action) => `Follow-up action: ${action}`),
  ]).slice(0, 10);
}

async function persistLossReflectionMemory(params: {
  repoId: string;
  issueId: string;
  bountyId: string;
  agentId: string;
  gitJobId?: string | null;
  settlementKey: string;
  reason: string;
  failureCategory?: string | null;
  judgeVerdict?: unknown;
  payoutFraction: number;
}): Promise<void> {
  const agent = await queryOne<{ ens_name: string }>(
    "SELECT ens_name FROM agents WHERE id = $1",
    [params.agentId],
  );
  if (!agent) return;

  const job = params.gitJobId
    ? await queryOne<{ branch_name: string | null; base_branch: string | null }>(
        "SELECT branch_name, base_branch FROM git_jobs WHERE id = $1",
        [params.gitJobId],
      )
    : null;

  const branchName = (job?.branch_name || `agent/${params.issueId.slice(0, 8)}-loss-reflection`).trim();
  if (!branchName) return;

  const branchExists = await queryOne<{ id: string }>(
    "SELECT id FROM branches WHERE repo_id = $1 AND name = $2",
    [params.repoId, branchName],
  );

  if (!branchExists) {
    const requestedBase = (job?.base_branch || "main").trim() || "main";
    const baseExists = await queryOne<{ id: string }>(
      "SELECT id FROM branches WHERE repo_id = $1 AND name = $2",
      [params.repoId, requestedBase],
    );
    const baseBranch = baseExists ? requestedBase : "main";
    await sdk.createBranch(params.repoId, branchName, baseBranch, agent.ens_name);
  }

  const correctiveActions = deriveCorrectiveActionsForOutcome({
    merged: false,
    payoutFraction: params.payoutFraction,
    failureCategory: params.failureCategory,
    judgeVerdict: params.judgeVerdict,
  });
  const constraints = buildNextAttemptConstraints(correctiveActions);

  await sdk.commitMemory(
    params.repoId,
    branchName,
    JSON.stringify(
      {
        issue_id: params.issueId,
        bounty_id: params.bountyId,
        settlement_key: params.settlementKey,
        reason: params.reason,
        failure_category: params.failureCategory || "closed_without_merge",
        corrective_actions: correctiveActions,
        next_attempt_constraints: constraints,
        generated_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    `loss reflection: issue ${params.issueId.slice(0, 8)} settled without payout`,
    agent.ens_name,
    {
      skipSemantics: true,
      reasoningType: "conclusion",
      knowledgeContext: {
        decisions: [
          `Loss event captured for bounty ${params.bountyId}`,
          `Failure category: ${params.failureCategory || "closed_without_merge"}`,
        ],
        next_steps: correctiveActions,
        handoff_summary:
          "Apply the corrective actions and constraints before accepting the next similar assignment.",
      },
      failureContext: {
        failed: true,
        error_type: "bounty_loss",
        error_detail: params.reason,
        failed_approach: "Previous bounty attempt failed to settle successfully",
        root_cause: params.failureCategory || params.reason,
        severity: "high",
        corrective_actions: correctiveActions,
        next_attempt_constraints: constraints,
      },
    },
  );
}

export async function githubWebhookRoutes(app: FastifyInstance) {
  app.post(
    "/github/webhook",
    {
      config: {
        rawBody: true,
      } as Record<string, unknown>,
    },
    async (req, reply) => {
      const secret = env.GITHUB_WEBHOOK_SECRET;
      if (!secret) {
        return reply.status(503).send({ error: "GITHUB_WEBHOOK_SECRET not configured" });
      }

      const raw = (req as ReqRaw).rawBody;
      if (!raw || !Buffer.isBuffer(raw)) {
        return reply.status(400).send({ error: "rawBody required (enable fastify-raw-body for this route)" });
      }

      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyGithubSignature(secret, raw, sig)) {
        return reply.status(401).send({ error: "invalid signature" });
      }

      const deliveryId = (req.headers["x-github-delivery"] as string) || `adhoc-${Date.now()}`;
      const event = req.headers["x-github-event"] as string;

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.status(400).send({ error: "invalid json" });
      }

      if (event !== "pull_request") {
        return reply.status(204).send();
      }

      const action = body.action as string;
      if (action !== "closed") {
        return reply.status(204).send();
      }

      const pr = body.pull_request as
        | {
            number: number;
            merged: boolean;
            merge_commit_sha?: string;
          }
        | undefined;
      const repository = body.repository as { name: string; owner: { login: string } } | undefined;
      if (!pr || !repository) {
        return reply.status(204).send();
      }

      const owner = repository.owner.login;
      const repo = repository.name;
      const bounty = await findIssueBountyByGithubPr(owner, repo, pr.number);
      if (!bounty) {
        return { ok: true, ignored: true };
      }

      const mergeEventKey = deliveryId;
      const mergeSemanticKey = buildMergeSemanticKey(owner, repo, pr.number, pr.merged, pr.merge_commit_sha);
      const settlementKey = `${bounty.id}:${mergeSemanticKey}`;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const issueRes = await client.query<{ repo_id: string; assigned_agent_id: string | null; git_job_id: string | null }>(
          `SELECT repo_id, assigned_agent_id, git_job_id
           FROM issues
           WHERE id = $1
           FOR UPDATE`,
          [bounty.issue_id],
        );
        if (issueRes.rows.length === 0) {
          await client.query("ROLLBACK");
          return { ok: true, ignored: true };
        }

        const issue = issueRes.rows[0];
        const judgeScoreNormalized = toNormalizedJudgeScore(bounty.github_judge_verdict);

        const existingRes = await client.query<{
          id: string;
          payout_status: string;
          outcome_status: string;
          settlement_key: string;
        }>(
          `SELECT id, payout_status, outcome_status, settlement_key
           FROM merge_settlement_events
           WHERE merge_event_key = $1
              OR merge_semantic_key = $2
              OR settlement_key = $3
           ORDER BY created_at DESC
           LIMIT 1
           FOR UPDATE`,
          [mergeEventKey, mergeSemanticKey, settlementKey],
        );

        let eventId: string;
        const existing = existingRes.rows[0];
        if (existing) {
          if (
            existing.payout_status === "paid" ||
            existing.payout_status === "failed_non_merge" ||
            existing.outcome_status === "applied"
          ) {
            await client.query("COMMIT");
            return { ok: true, deduped: true };
          }

          eventId = existing.id;
          await client.query(
            `UPDATE merge_settlement_events
             SET merge_event_key = $1,
                 github_delivery_id = $1,
                 updated_at = NOW()
             WHERE id = $2`,
            [mergeEventKey, eventId],
          );
        } else {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO merge_settlement_events (
               repository_id,
               issue_id,
               bounty_id,
               pr_number,
               merge_commit_sha,
               github_delivery_id,
               merge_event_key,
               merge_semantic_key,
               settlement_key,
               payout_status,
               outcome_status
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'pending')
             RETURNING id`,
            [
              issue.repo_id,
              bounty.issue_id,
              bounty.id,
              pr.number,
              pr.merge_commit_sha ?? null,
              deliveryId,
              mergeEventKey,
              mergeSemanticKey,
              settlementKey,
            ],
          );
          eventId = inserted.rows[0].id;
        }

        if (!pr.merged) {
          await refundBountyOnGitHubCloseWithoutMergeInTransaction(client, bounty.id, deliveryId);

          let outcomeStatus = "pending";
          if (issue.assigned_agent_id) {
            const outcome = await recordAgentOutcomeInTransaction(client, {
              agentId: issue.assigned_agent_id,
              issueId: bounty.issue_id,
              bountyId: bounty.id,
              mergeEventId: deliveryId,
              settlementKey,
              merged: false,
              payoutFraction: 0,
              payoutAmount: 0,
              judgeScore: judgeScoreNormalized,
              failureCategory: "closed_without_merge",
            });
            outcomeStatus = outcome.skipped ? "applied" : "applied";
          }

          await client.query(
            `UPDATE issue_bounties
             SET settlement_key = $1,
                 payout_status = 'failed_non_merge'
             WHERE id = $2`,
            [settlementKey, bounty.id],
          );

          await client.query(
            `UPDATE merge_settlement_events
             SET payout_status = 'failed_non_merge',
                 outcome_status = $1,
                 processed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $2`,
            [outcomeStatus, eventId],
          );

          await finalizeIssueLifecycleAfterSettlement({
            issueId: bounty.issue_id,
            merged: false,
            mergedPrNumber: pr.number,
            gitJobId: issue.git_job_id,
            client,
          });

          await client.query("COMMIT");

          if (issue.assigned_agent_id) {
            try {
              await persistLossReflectionMemory({
                repoId: issue.repo_id,
                issueId: bounty.issue_id,
                bountyId: bounty.id,
                agentId: issue.assigned_agent_id,
                gitJobId: issue.git_job_id,
                settlementKey,
                reason: "Pull request closed without merge; bounty settled as failed_non_merge.",
                failureCategory: "closed_without_merge",
                judgeVerdict: bounty.github_judge_verdict,
                payoutFraction: 0,
              });
            } catch (reflectionError) {
              req.log.error(
                {
                  err: reflectionError,
                  issueId: bounty.issue_id,
                  bountyId: bounty.id,
                  settlementKey,
                },
                "Failed to persist loss reflection memory",
              );
            }
          }

          return { ok: true, refunded: true };
        }

        if (issue.git_job_id) {
          const jobRes = await client.query<{ status: string; github_pr_number: number | null }>(
            `SELECT status, github_pr_number
             FROM git_jobs
             WHERE id = $1
             FOR UPDATE`,
            [issue.git_job_id],
          );

          const linkedJob = jobRes.rows[0];
          const settleable =
            linkedJob != null &&
            isGitJobSettleable({
              status: linkedJob.status,
              githubPrNumber: linkedJob.github_pr_number,
              mergedPrNumber: pr.number,
            });

          if (!settleable) {
            const holdReason = linkedJob ? "git_job_not_settleable" : "git_job_missing";

            await client.query(
              `UPDATE issue_bounties
               SET settlement_key = $1,
                   payout_status = 'hold'
               WHERE id = $2`,
              [settlementKey, bounty.id],
            );

            await client.query(
              `UPDATE merge_settlement_events
               SET payout_status = 'hold',
                   outcome_status = 'pending',
                   error_message = $1,
                   updated_at = NOW()
               WHERE id = $2`,
              [holdReason, eventId],
            );

            await client.query("COMMIT");
            return { ok: true, hold: true };
          }
        }

        if (!issue.assigned_agent_id) {
          await finalizeIssueLifecycleAfterSettlement({
            issueId: bounty.issue_id,
            merged: true,
            mergedPrNumber: pr.number,
            gitJobId: issue.git_job_id,
            client,
          });

          await client.query(
            `UPDATE merge_settlement_events
             SET payout_status = 'failed',
                 outcome_status = 'pending',
                 error_message = 'winner_agent_missing',
                 processed_at = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [eventId],
          );
          await client.query("COMMIT");
          return { ok: true, skipped: true };
        }

        const codeQualityScore = (bounty.github_judge_verdict as { code_quality_score?: unknown } | null)
          ?.code_quality_score;
        const isMockJudge = Boolean(bounty.is_mock_judge);
        let payoutFractionForOutcome = isMockJudge ? 0 : Number(bounty.judge_payout_fraction ?? 0);
        if (!isMockJudge && typeof codeQualityScore === "number") {
          payoutFractionForOutcome = payoutFractionFromCodeQuality(codeQualityScore);
          await client.query(
            `UPDATE issue_bounties
             SET judge_payout_fraction = $1
             WHERE id = $2`,
            [payoutFractionForOutcome, bounty.id],
          );
        }

        const payout = await applyGitHubMergePayoutInTransaction(client, {
          bountyId: bounty.id,
          winnerAgentId: issue.assigned_agent_id,
          deliveryId,
        });

        const payoutStatus = payout.reason === "blocked_mock_judge" ? "blocked_mock_judge" : "paid";
        const failureCategory = payout.reason === "blocked_mock_judge" ? "blocked_mock_judge" : null;

        const outcome = await recordAgentOutcomeInTransaction(client, {
          agentId: issue.assigned_agent_id,
          issueId: bounty.issue_id,
          bountyId: bounty.id,
          mergeEventId: deliveryId,
          settlementKey,
          merged: true,
          payoutFraction: payoutFractionForOutcome,
          payoutAmount: payout.paid,
          judgeScore: judgeScoreNormalized,
          failureCategory,
        });

        await client.query(
          `UPDATE issue_bounties
           SET settlement_key = $1,
               payout_status = $2
           WHERE id = $3`,
          [settlementKey, payoutStatus, bounty.id],
        );

        await client.query(
          `UPDATE merge_settlement_events
           SET payout_status = $1,
               outcome_status = $2,
               processed_at = NOW(),
               updated_at = NOW()
           WHERE id = $3`,
          [payoutStatus, outcome.skipped ? "applied" : "applied", eventId],
        );

        await finalizeIssueLifecycleAfterSettlement({
          issueId: bounty.issue_id,
          merged: true,
          mergedPrNumber: pr.number,
          gitJobId: issue.git_job_id,
          client,
        });

        await client.query("COMMIT");
        return { ok: true, payout };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  );
}
