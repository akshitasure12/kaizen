/**
 * GitHub webhook: pull_request closed → merged payout or refund.
 * Idempotency: issue_bounties.merge_webhook_delivery_id + payout_status only (no side table).
 */

import crypto from "crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { query, queryOne } from "../db/client";
import { env } from "../env";
import * as bountyService from "../services/bounty";
import { recordAgentOutcome } from "../services/agent-outcomes";

type ReqRaw = FastifyRequest & { rawBody?: Buffer };

function buildMergeSemanticKey(owner: string, repo: string, prNumber: number, merged: boolean, mergeCommitSha?: string): string {
  const ref = merged ? (mergeCommitSha || "merged") : "closed_no_merge";
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${prNumber}:${ref}`;
}

function verifyGithubSignature(secret: string, payload: Buffer, signature: string | undefined): boolean {
  if (!signature || !secret) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const sig = signature.trim();
  if (sig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
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
      const pr = body.pull_request as
        | {
            number: number;
            merged: boolean;
            merge_commit_sha?: string;
          }
        | undefined;
      const repository = body.repository as { name: string; owner: { login: string } } | undefined;

      if (!pr || !repository || action !== "closed") {
        return reply.status(204).send();
      }

      const owner = repository.owner.login;
      const repo = repository.name;
      const mergeCommitSha = pr.merge_commit_sha;

      const bounty = await bountyService.findIssueBountyByGithubPr(owner, repo, pr.number);
      if (!bounty) {
        return { ok: true, ignored: true };
      }

      const issueRow = await queryOne<{ repo_id: string }>(
        "SELECT repo_id FROM issues WHERE id = $1",
        [bounty.issue_id],
      );
      if (!issueRow) {
        return { ok: true, ignored: true };
      }

      const mergeEventKey = deliveryId;
      const mergeSemanticKey = buildMergeSemanticKey(owner, repo, pr.number, pr.merged, mergeCommitSha);
      const settlementKey = `${bounty.id}:${mergeSemanticKey}`;

      const existingEvent = await queryOne<{
        id: string;
        payout_status: string;
        outcome_status: string;
      }>(
        `SELECT id, payout_status, outcome_status
         FROM merge_settlement_events
         WHERE merge_event_key = $1 OR merge_semantic_key = $2 OR settlement_key = $3
         ORDER BY created_at DESC
         LIMIT 1`,
        [mergeEventKey, mergeSemanticKey, settlementKey],
      );

      if (existingEvent) {
        const payoutStatus = existingEvent.payout_status || "pending";
        const outcomeStatus = existingEvent.outcome_status || "pending";
        if (payoutStatus === "paid" || payoutStatus === "failed_non_merge" || outcomeStatus === "applied") {
          return { ok: true, deduped: true };
        }

        await query(
          `UPDATE merge_settlement_events
           SET merge_event_key = $1,
               github_delivery_id = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [mergeEventKey, existingEvent.id],
        );
      } else {
        await query(
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
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'pending')`,
          [
            issueRow.repo_id,
            bounty.issue_id,
            bounty.id,
            pr.number,
            mergeCommitSha ?? null,
            deliveryId,
            mergeEventKey,
            mergeSemanticKey,
            settlementKey,
          ],
        );
      }

      const row = await queryOne<{ assigned_agent_id: string | null }>(
        "SELECT assigned_agent_id FROM issues WHERE id = $1",
        [bounty.issue_id],
      );
      const winner = row?.assigned_agent_id;

      const verdict = bounty.github_judge_verdict as { code_quality_score?: unknown } | null;
      const judgeScoreRaw = verdict?.code_quality_score;
      const judgeScoreNormalized =
        typeof judgeScoreRaw === "number"
          ? Math.min(1, Math.max(0, (judgeScoreRaw - 1) / 9))
          : null;

      if (pr.merged) {
        if (!winner) {
          await query(
            `UPDATE merge_settlement_events
             SET payout_status = 'failed',
                 error_message = 'winner_agent_missing',
                 processed_at = NOW(),
                 updated_at = NOW()
             WHERE settlement_key = $1`,
            [settlementKey],
          );
          return { ok: true, skipped: true };
        }
        const result = await bountyService.applyGitHubMergePayout({
          bountyId: bounty.id,
          winnerAgentId: winner,
          deliveryId,
        });

        await recordAgentOutcome({
          agentId: winner,
          issueId: bounty.issue_id,
          bountyId: bounty.id,
          mergeEventId: deliveryId,
          settlementKey,
          merged: true,
          payoutFraction: Number(bounty.judge_payout_fraction ?? 0),
          payoutAmount: result.paid,
          judgeScore: judgeScoreNormalized,
          failureCategory: null,
        });

        await query(
          `UPDATE merge_settlement_events
           SET payout_status = 'paid',
               outcome_status = 'applied',
               processed_at = NOW(),
               updated_at = NOW()
           WHERE settlement_key = $1`,
          [settlementKey],
        );

        await query(
          `UPDATE issue_bounties
           SET settlement_key = $1,
               settlement_status = 'paid'
           WHERE id = $2`,
          [settlementKey, bounty.id],
        );
        return { ok: true, payout: result };
      }

      await bountyService.refundBountyOnGitHubCloseWithoutMerge(bounty.id, deliveryId);

      await query(
        `UPDATE merge_settlement_events
         SET payout_status = 'failed_non_merge',
             outcome_status = 'pending',
             processed_at = NOW(),
             updated_at = NOW()
         WHERE settlement_key = $1`,
        [settlementKey],
      );

      await query(
        `UPDATE issue_bounties
         SET settlement_key = $1,
             settlement_status = 'failed_non_merge'
         WHERE id = $2`,
        [settlementKey, bounty.id],
      );

      if (winner) {
        await recordAgentOutcome({
          agentId: winner,
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
      }
      return { ok: true, refunded: true };
    },
  );
}
