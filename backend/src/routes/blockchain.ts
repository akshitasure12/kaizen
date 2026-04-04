/**
 * Blockchain status + mock deposit verification (no BitGo in this package).
 */

import { FastifyInstance } from "fastify";
import { query, queryOne } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { parseListPagination, paginationMeta } from "../lib/pagination";
import { env } from "../env";
import {
  verifyDepositTransaction,
  isBlockchainEnabled,
  getTokenInfo,
  getRequiredDeposit,
  getTreasuryAddress,
  generateMockTxHash,
  getBlockchainConfig,
} from "../services/blockchain";

interface AgentRow {
  id: string;
  ens_name: string;
  user_id: string | null;
  deposit_tx_hash: string | null;
  deposit_verified: boolean;
}

export async function blockchainRoutes(app: FastifyInstance) {
  app.get("/config", async () => ({
    ...getBlockchainConfig(),
    token: await getTokenInfo(),
  }));

  app.post(
    "/register-agent",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as {
        ens_name?: string;
        role?: string;
        capabilities?: string[];
        deposit_tx_hash?: string;
      };
      const {
        ens_name,
        role = "contributor",
        capabilities = [],
        deposit_tx_hash,
      } = body;

      if (!ens_name || !validateEnsName(ens_name)) {
        return reply.status(400).send({ error: "Invalid ens_name" });
      }

      const existing = await queryOne<AgentRow>(
        "SELECT * FROM agents WHERE ens_name = $1",
        [ens_name.toLowerCase()],
      );
      if (existing) {
        return reply.status(409).send({ error: "Agent already registered" });
      }

      let txHash = deposit_tx_hash;
      if (!isBlockchainEnabled()) {
        txHash = generateMockTxHash();
      }
      if (!txHash) {
        return reply
          .status(400)
          .send({ error: "deposit_tx_hash required when chain enabled" });
      }

      const verification = await verifyDepositTransaction(txHash, {
        ensName: ens_name.toLowerCase(),
      });
      if (!verification.valid) {
        return reply
          .status(400)
          .send({ error: verification.reason ?? "verify_failed" });
      }

      const [agent] = await query<AgentRow>(
        `INSERT INTO agents (ens_name, role, capabilities, user_id, deposit_tx_hash, deposit_verified)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          ens_name.toLowerCase(),
          role,
          capabilities,
          req.user!.userId,
          txHash,
          true,
        ],
      );

      return reply.status(201).send({ agent });
    },
  );

  app.get("/treasury", async () => ({
    address: await getTreasuryAddress(),
    required_deposit: (await getRequiredDeposit()).toString(),
  }));

  /**
   * Indexed on-chain events visible when tied to the user's agents or imported repos.
   */
  app.get("/onchain-events", { preHandler: requireAuth }, async (req, reply) => {
    if (!env.DATABASE_URL) {
      return reply.status(503).send({ error: "Database not configured" });
    }
    const { limit, offset } = parseListPagination(req.query as Record<string, unknown>, {
      limit: 30,
      maxLimit: 100,
    });
    const q = req.query as { event_name?: string };
    const eventName =
      typeof q.event_name === "string" && q.event_name.trim() !== ""
        ? q.event_name.trim()
        : null;
    const chainId = env.ONCHAIN_CHAIN_ID;
    const userId = req.user!.userId;

    const visibility = `(
      (a.user_id IS NOT NULL AND a.user_id = $1::uuid)
      OR (r.imported_by_user_id IS NOT NULL AND r.imported_by_user_id = $1::uuid)
      OR (
        e.ens_name IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM agents a2
          WHERE lower(a2.ens_name) = lower(e.ens_name) AND a2.user_id = $1::uuid
        )
      )
    )`;

    const listSql = `
      SELECT e.id, e.chain_id, e.block_number, e.tx_hash, e.log_index, e.contract_address,
             e.event_name, e.payload, e.bounty_id, e.ens_name, e.issue_id, e.agent_id, e.created_at
      FROM onchain_events e
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN issues i ON e.issue_id = i.id
      LEFT JOIN repositories r ON i.repo_id = r.id
      WHERE e.chain_id = $4::bigint
        AND ${visibility}
        AND ($5::text IS NULL OR e.event_name = $5)
      ORDER BY e.block_number DESC, e.log_index DESC
      LIMIT $2 OFFSET $3`;
    const listParams: unknown[] = [userId, limit, offset, chainId, eventName];

    const countSql = `
      SELECT COUNT(*)::text AS c
      FROM onchain_events e
      LEFT JOIN agents a ON e.agent_id = a.id
      LEFT JOIN issues i ON e.issue_id = i.id
      LEFT JOIN repositories r ON i.repo_id = r.id
      WHERE e.chain_id = $2::bigint
        AND ${visibility}
        AND ($3::text IS NULL OR e.event_name = $3)`;
    const countParams: unknown[] = [userId, chainId, eventName];

    const rows = await query<Record<string, unknown>>(listSql, listParams);
    const countRow = await queryOne<{ c: string }>(countSql, countParams);
    const total = parseInt(countRow?.c ?? "0", 10);

    return {
      data: rows,
      pagination: paginationMeta(total, limit, offset),
    };
  });
}
function validateEnsName(ens_name: string): boolean {
  const value = ens_name.trim().toLowerCase();

  // Basic size/syntax checks
  if (value.length < 3 || value.length > 255) return false;
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) {
    return false;
  }

  // This route expects ENS-style names
  if (!value.endsWith(".eth")) return false;

  const labels = value.split(".");
  for (const label of labels) {
    if (label.length < 1 || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }

  return true;
}

