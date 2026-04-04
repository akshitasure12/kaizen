import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { query, queryOne } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { parseListPagination, paginationMeta } from '../lib/pagination';
import * as bountyService from '../services/bounty';
import { createAgentBodySchema, formatZodError } from '../schemas/agent';

export async function agentRoutes(app: FastifyInstance) {
  // Register agent
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const parsed = createAgentBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: formatZodError(parsed.error) });
    }

    const { ens_name, role, capabilities } = parsed.data;
    try {
      const agent = await sdk.registerAgent(ens_name, role ?? 'agent', capabilities, {
        userId: req.user!.userId,
      });
      return reply.status(201).send(agent);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // List agents (paginated). Authenticated: current user's agents only (capabilities = memory).
  app.get('/', { preHandler: requireAuth }, async (req, reply) => {
    const { limit, offset } = parseListPagination(req.query as Record<string, unknown>, {
      limit: 20,
      maxLimit: 100,
    });
    const whereFinal = 'WHERE user_id = $1 AND lower(ens_name) <> \'kaizen.system\'';
    const paramsList: unknown[] = [req.user!.userId];
    const limitIdxL = paramsList.length + 1;
    const offsetIdxL = paramsList.length + 2;
    paramsList.push(limit, offset);
    const rows = await query(
      `SELECT * FROM agents ${whereFinal}
       ORDER BY reputation_score DESC
       LIMIT $${limitIdxL} OFFSET $${offsetIdxL}`,
      paramsList,
    );
    const countSql = `SELECT COUNT(*)::text as c FROM agents WHERE user_id = $1 AND lower(ens_name) <> 'kaizen.system'`;
    const countParams = [req.user!.userId];
    const countRow = await queryOne<{ c: string }>(countSql, countParams);
    const c = countRow?.c ?? '0';
    const total = parseInt(c, 10);
    return {
      data: rows,
      pagination: paginationMeta(total, limit, offset),
    };
  });

  // ─── Wallet (register before generic /:ens_name) ───────────────────────

  /**
   * Deposit tokens to an agent's wallet
   */
  app.post('/:ens_name/deposit', { preHandler: requireAuth }, async (req, reply) => {
    const { ens_name } = req.params as any;
    const { amount, note } = req.body as any;

    if (!amount || amount <= 0) {
      return reply.status(400).send({ error: 'amount must be a positive number' });
    }

    const agent = await sdk.getAgent(ens_name);
    if (!agent || agent.user_id !== req.user!.userId) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const tx = await bountyService.depositToWallet(agent.id, amount, note);
    const balance = await bountyService.getWalletBalance(agent.id);

    return reply.status(201).send({ transaction: tx, wallet_balance: balance });
  });

  /**
   * Get agent wallet info: balance, spending cap, recent transactions
   */
  app.get('/:ens_name/wallet', { preHandler: requireAuth }, async (req, reply) => {
    const { ens_name } = req.params as any;

    const agent = await sdk.getAgent(ens_name);
    if (!agent || agent.user_id !== req.user!.userId) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const [balance, spendingCap, totalSpent, transactions] = await Promise.all([
      bountyService.getWalletBalance(agent.id),
      bountyService.getSpendingCap(agent.id),
      bountyService.getTotalBountySpend(agent.id),
      bountyService.getWalletTransactions(agent.id, 20),
    ]);

    return {
      agent_id: agent.id,
      ens_name: agent.ens_name,
      wallet_balance: balance,
      spending_cap: spendingCap,
      total_bounty_spend: totalSpent,
      recent_transactions: transactions,
    };
  });

  /**
   * Set spending cap for an agent's wallet
   * Pass cap: null to remove the cap.
   */
  app.patch('/:ens_name/wallet', { preHandler: requireAuth }, async (req, reply) => {
    const { ens_name } = req.params as any;
    const { spending_cap } = req.body as any;

    if (spending_cap === undefined) {
      return reply.status(400).send({ error: 'spending_cap is required (number or null)' });
    }

    if (spending_cap !== null && (typeof spending_cap !== 'number' || spending_cap < 0)) {
      return reply.status(400).send({ error: 'spending_cap must be a non-negative number or null' });
    }

    const agent = await sdk.getAgent(ens_name);
    if (!agent || agent.user_id !== req.user!.userId) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    await bountyService.setSpendingCap(agent.id, spending_cap);

    return { ens_name, spending_cap };
  });

  // Update agent profile (owner only)
  app.patch('/:ens_name', { preHandler: requireAuth }, async (req, reply) => {
    const { ens_name } = req.params as { ens_name: string };
    const body = req.body as {
      role?: string;
      capabilities?: string[];
      max_bounty_spend?: number | null;
    };
    const agent = await sdk.getAgent(ens_name);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    if (agent.user_id !== req.user!.userId) {
      return reply.status(403).send({ error: 'Not allowed to update this agent' });
    }
    const updates: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (body.role !== undefined) {
      updates.push(`role = $${i++}`);
      vals.push(body.role);
    }
    if (body.capabilities !== undefined) {
      updates.push(`capabilities = $${i++}`);
      vals.push(body.capabilities);
    }
    if (body.max_bounty_spend !== undefined) {
      updates.push(`max_bounty_spend = $${i++}`);
      vals.push(body.max_bounty_spend);
    }
    if (updates.length === 0) {
      return reply.status(400).send({ error: 'No valid fields to update' });
    }
    vals.push(agent.id);
    const sql = `UPDATE agents SET ${updates.join(', ')} WHERE id = $${i} RETURNING *`;
    const row = await queryOne<Record<string, unknown>>(sql, vals);
    if (!row) return reply.status(500).send({ error: 'Update failed' });
    return row;
  });

  // Get agent by ENS name (owner only — hides others' agents and earnings)
  app.get('/:ens_name', { preHandler: requireAuth }, async (req, reply) => {
    const { ens_name } = req.params as any;
    const agent = await sdk.getAgent(ens_name);
    if (!agent || agent.user_id !== req.user!.userId) {
      return reply.status(404).send({ error: 'Agent not found' });
    }
    const earnings = await bountyService.getAgentEarnings(agent.id);
    return { ...agent, earnings };
  });
}
