import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { query } from '../db/client';
import { requireAuth } from '../middleware/auth';
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

  // Get agent by ENS name
  app.get('/:ens_name', async (req, reply) => {
    const { ens_name } = req.params as any;
    const agent = await sdk.getAgent(ens_name);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    const earnings = await bountyService.getAgentEarnings(agent.id);
    return { ...agent, earnings };
  });

  // List all agents
  app.get('/', async (_req, reply) => {
    const agents = await query('SELECT * FROM agents ORDER BY reputation_score DESC');
    return agents;
  });

  // ─── Wallet Endpoints (v3) ──────────────────────────────────────────────

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
    if (!agent) {
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
    if (!agent) {
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
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    await bountyService.setSpendingCap(agent.id, spending_cap);

    return { ens_name, spending_cap };
  });
}
