/**
 * Blockchain status + mock deposit verification (no BitGo in this package).
 */

import { FastifyInstance } from "fastify";
import { query, queryOne } from "../db/client";
import { requireAuth } from "../middleware/auth";
import {
  verifyDepositTransaction,
  isBlockchainEnabled,
  getTokenInfo,
  getRequiredDeposit,
  getTreasuryAddress,
  generateMockTxHash,
  getBlockchainConfig,
} from "../services/blockchain";
import {
  blockchainRegisterAgentBodySchema,
  formatZodError,
} from "../schemas/agent";

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
}
