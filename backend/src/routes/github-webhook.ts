/**
 * GitHub webhook: pull_request closed → merged payout or refund.
 * Idempotency: issue_bounties.merge_webhook_delivery_id + payout_status only (no side table).
 */

import crypto from "crypto";
import { FastifyInstance, FastifyRequest } from "fastify";
import { queryOne } from "../db/client";
import { env } from "../env";
import * as bountyService from "../services/bounty";

type ReqRaw = FastifyRequest & { rawBody?: Buffer };

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
          }
        | undefined;
      const repository = body.repository as { name: string; owner: { login: string } } | undefined;

      if (!pr || !repository || action !== "closed") {
        return reply.status(204).send();
      }

      const owner = repository.owner.login;
      const repo = repository.name;

      const bounty = await bountyService.findIssueBountyByGithubPr(owner, repo, pr.number);
      if (!bounty) {
        return { ok: true, ignored: true };
      }

      if (pr.merged) {
        const row = await queryOne<{ assigned_agent_id: string | null }>(
          "SELECT assigned_agent_id FROM issues WHERE id = $1",
          [bounty.issue_id],
        );
        const winner = row?.assigned_agent_id;
        if (!winner) {
          return { ok: true, skipped: true };
        }
        const result = await bountyService.applyGitHubMergePayout({
          bountyId: bounty.id,
          winnerAgentId: winner,
          deliveryId,
        });
        return { ok: true, payout: result };
      }

      await bountyService.refundBountyOnGitHubCloseWithoutMerge(bounty.id, deliveryId);
      return { ok: true, refunded: true };
    },
  );
}
