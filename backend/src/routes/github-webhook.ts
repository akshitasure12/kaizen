import crypto from "crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "../db/client";
import { env } from "../env";
import {
  applyGitHubMergePayoutInTransaction,
  findIssueBountyByGithubPr,
  payoutFractionFromCodeQuality,
  refundBountyOnGitHubCloseWithoutMergeInTransaction,
} from "../services/bounty";
import { recordAgentOutcomeInTransaction } from "../services/agent-outcomes";

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
                 settlement_status = 'failed_non_merge'
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

          await client.query("COMMIT");
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
                   settlement_status = 'hold'
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
        let payoutFractionForOutcome = Number(bounty.judge_payout_fraction ?? 0);
        if (typeof codeQualityScore === "number") {
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
          failureCategory: null,
        });

        await client.query(
          `UPDATE issue_bounties
           SET settlement_key = $1,
               settlement_status = 'paid'
           WHERE id = $2`,
          [settlementKey, bounty.id],
        );

        await client.query(
          `UPDATE merge_settlement_events
           SET payout_status = 'paid',
               outcome_status = $1,
               processed_at = NOW(),
               updated_at = NOW()
           WHERE id = $2`,
          [outcome.skipped ? "applied" : "applied", eventId],
        );

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
