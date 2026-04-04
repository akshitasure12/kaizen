/**
 * Bounty Service (issue-bounty + wallet model)
 *
 * v3 operations:
 * - depositToWallet: add funds to agent wallet
 * - getWalletBalance: get agent wallet balance
 * - setSpendingCap: set per-agent max bounty spend
 * - postIssueBounty: agent posts bounty on issue (escrows from wallet)
 * - awardIssueBounty: pay winning agent
 * - refundIssueBounty: return funds to poster
 * - getIssueBounty: get active bounty for an issue
 * - getIssueBountySubmissions: get all submissions for a bounty
 * - submitToBounty: record a bounty submission
 * - getWalletTransactions: get wallet ledger for agent
 */

import { query, queryOne } from '../db/client';
import { env } from '../env';

export type WalletTxType = 'deposit' | 'bounty_post' | 'bounty_win' | 'bounty_refund' | 'earning';

export interface IssueBounty {
  id: string;
  issue_id: string;
  poster_agent_id: string;
  amount: number;
  deadline: string;
  max_submissions: number;
  status: 'funded' | 'judging' | 'awarded' | 'expired' | 'cancelled';
  winner_agent_id: string | null;
  created_at: string;
  github_pr_number?: number | null;
  judge_payout_fraction?: number | null;
  github_judge_verdict?: unknown;
  is_mock_judge?: boolean | null;
  payout_status?: string | null;
  merge_webhook_delivery_id?: string | null;
}

export interface BountySubmission {
  id: string;
  bounty_id: string;
  agent_id: string;
  content: string;
  submitted_at: string;
  judge_verdict: any;
  points_awarded: number;
}

export interface WalletTransaction {
  id: string;
  agent_id: string;
  amount: number;
  tx_type: WalletTxType;
  reference_id: string | null;
  note: string | null;
  created_at: string;
}

interface DbClientLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export async function getAgentEarnings(agentId: string): Promise<number> {
  const result = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM wallet_transactions
     WHERE agent_id = $1
       AND tx_type IN ('bounty_win', 'earning')`,
    [agentId]
  );
  return parseFloat(result?.total ?? '0');
}

// ─── Agent Wallet Operations (v3) ─────────────────────────────────────────────

/**
 * Deposit tokens to an agent's wallet balance
 */
export async function depositToWallet(agentId: string, amount: number, note?: string): Promise<WalletTransaction> {
  // Update agent wallet balance
  await query('UPDATE agents SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2', [amount, agentId]);

  const [tx] = await query<WalletTransaction>(
    `INSERT INTO wallet_transactions (agent_id, amount, tx_type, note)
     VALUES ($1, $2, 'deposit', $3) RETURNING *`,
    [agentId, amount, note ?? `Wallet deposit of ${amount}`]
  );
  return tx;
}

/**
 * Get an agent's current wallet balance
 */
export async function getWalletBalance(agentId: string): Promise<number> {
  const result = await queryOne<{ wallet_balance: string }>(
    'SELECT COALESCE(wallet_balance, 0) as wallet_balance FROM agents WHERE id = $1',
    [agentId]
  );
  return parseFloat(result?.wallet_balance ?? '0');
}

/**
 * Set the per-agent max bounty spending cap (null = no limit)
 */
export async function setSpendingCap(agentId: string, cap: number | null): Promise<void> {
  await query('UPDATE agents SET max_bounty_spend = $1 WHERE id = $2', [cap, agentId]);
}

/**
 * Get the per-agent spending cap
 */
export async function getSpendingCap(agentId: string): Promise<number | null> {
  const result = await queryOne<{ max_bounty_spend: string | null }>(
    'SELECT max_bounty_spend FROM agents WHERE id = $1',
    [agentId]
  );
  return result?.max_bounty_spend ? parseFloat(result.max_bounty_spend) : null;
}

/**
 * Get agent's total bounty spending (sum of all bounty_post transactions)
 */
export async function getTotalBountySpend(agentId: string): Promise<number> {
  const result = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM wallet_transactions
     WHERE agent_id = $1 AND tx_type = 'bounty_post'`,
    [agentId]
  );
  return parseFloat(result?.total ?? '0');
}

/**
 * Get wallet transaction history for an agent
 */
export async function getWalletTransactions(agentId: string, limit: number = 50): Promise<WalletTransaction[]> {
  return query<WalletTransaction>(
    `SELECT * FROM wallet_transactions
     WHERE agent_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [agentId, limit]
  );
}

// ─── Issue Bounty Operations (v3) ─────────────────────────────────────────────

/**
 * Post a bounty on an issue — escrows funds from the poster agent's wallet.
 *
 * Validates:
 * - Agent has sufficient wallet balance
 * - Agent's spending cap is not exceeded
 * - No existing active bounty on this issue
 */
export async function postIssueBounty(
  issueId: string,
  posterAgentId: string,
  amount: number,
  deadline: Date,
  maxSubmissions: number = 5
): Promise<IssueBounty> {
  // Check wallet balance
  const balance = await getWalletBalance(posterAgentId);
  if (balance < amount) {
    throw new Error(`Insufficient wallet balance: have ${balance}, need ${amount}`);
  }

  // Check spending cap
  const cap = await getSpendingCap(posterAgentId);
  if (cap !== null) {
    const totalSpent = await getTotalBountySpend(posterAgentId);
    if (totalSpent + amount > cap) {
      throw new Error(`Bounty would exceed spending cap: spent ${totalSpent}, cap ${cap}, requested ${amount}`);
    }
  }

  // Check no existing active bounty on this issue
  const existing = await getIssueBounty(issueId);
  if (existing && ['funded', 'judging'].includes(existing.status)) {
    throw new Error('An active bounty already exists on this issue');
  }

  // Deduct from wallet
  await query('UPDATE agents SET wallet_balance = wallet_balance - $1 WHERE id = $2', [amount, posterAgentId]);

  // Create the bounty
  const [bounty] = await query<IssueBounty>(
    `INSERT INTO issue_bounties (issue_id, poster_agent_id, amount, deadline, max_submissions, status)
     VALUES ($1, $2, $3, $4, $5, 'funded') RETURNING *`,
    [issueId, posterAgentId, amount, deadline.toISOString(), maxSubmissions]
  );

  // Record wallet transaction
  await query(
    `INSERT INTO wallet_transactions (agent_id, amount, tx_type, reference_id, note)
     VALUES ($1, $2, 'bounty_post', $3, $4)`,
    [posterAgentId, -amount, bounty.id, `Posted bounty of ${amount} on issue`]
  );

  return bounty;
}

/**
 * Get the active bounty for an issue (most recent)
 */
export async function getIssueBounty(issueId: string): Promise<IssueBounty | null> {
  return queryOne<IssueBounty>(
    `SELECT ib.*, a.ens_name as poster_ens,
            wa.ens_name as winner_ens
     FROM issue_bounties ib
     JOIN agents a ON ib.poster_agent_id = a.id
     LEFT JOIN agents wa ON ib.winner_agent_id = wa.id
     WHERE ib.issue_id = $1
     ORDER BY ib.created_at DESC
     LIMIT 1`,
    [issueId]
  );
}

/**
 * Get bounty by ID
 */
export async function getIssueBountyById(bountyId: string): Promise<IssueBounty | null> {
  return queryOne<IssueBounty>(
    'SELECT * FROM issue_bounties WHERE id = $1',
    [bountyId]
  );
}

/**
 * Submit a solution for a bounty
 */
export async function submitToBounty(
  bountyId: string,
  agentId: string,
  content: string
): Promise<BountySubmission> {
  const [submission] = await query<BountySubmission>(
    `INSERT INTO bounty_submissions (bounty_id, agent_id, content)
     VALUES ($1, $2, $3) RETURNING *`,
    [bountyId, agentId, content]
  );
  return submission;
}

/**
 * Get all submissions for a bounty
 */
export async function getIssueBountySubmissions(bountyId: string): Promise<BountySubmission[]> {
  return query<BountySubmission>(
    `SELECT bs.*, a.ens_name as agent_ens
     FROM bounty_submissions bs
     JOIN agents a ON bs.agent_id = a.id
     WHERE bs.bounty_id = $1
     ORDER BY bs.submitted_at ASC`,
    [bountyId]
  );
}

/**
 * Get submission count for a bounty
 */
export async function getBountySubmissionCount(bountyId: string): Promise<number> {
  const result = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM bounty_submissions WHERE bounty_id = $1',
    [bountyId]
  );
  return parseInt(result?.count ?? '0', 10);
}

/**
 * Update a bounty submission's judge results
 */
export async function updateSubmissionVerdict(
  submissionId: string,
  verdict: any,
  pointsAwarded: number
): Promise<void> {
  await query(
    `UPDATE bounty_submissions SET judge_verdict = $1, points_awarded = $2
     WHERE id = $3`,
    [JSON.stringify(verdict), pointsAwarded, submissionId]
  );
}

/**
 * Award bounty to the winning agent.
 * Transfers escrowed amount to winner's wallet_balance.
 */
export async function awardIssueBounty(
  bountyId: string,
  winnerAgentId: string,
  amount: number
): Promise<void> {
  // Credit winner wallet
  await query(
    'UPDATE agents SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
    [amount, winnerAgentId]
  );

  // Update bounty status
  await query(
    `UPDATE issue_bounties SET status = 'awarded', winner_agent_id = $1
     WHERE id = $2`,
    [winnerAgentId, bountyId]
  );

  // Record wallet transaction for winner
  await query(
    `INSERT INTO wallet_transactions (agent_id, amount, tx_type, reference_id, note)
     VALUES ($1, $2, 'bounty_win', $3, $4)`,
    [winnerAgentId, amount, bountyId, `Won bounty of ${amount}`]
  );

  // Bump winner reputation
  await query(
    'UPDATE agents SET reputation_score = reputation_score + 15 WHERE id = $1',
    [winnerAgentId]
  );
}

/**
 * Refund bounty to poster (on expiry or cancellation).
 * Returns escrowed amount to poster's wallet_balance.
 */
export async function refundIssueBounty(bountyId: string): Promise<void> {
  const bounty = await getIssueBountyById(bountyId);
  if (!bounty) throw new Error('Bounty not found');

  // Credit poster wallet
  await query(
    'UPDATE agents SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
    [bounty.amount, bounty.poster_agent_id]
  );

  // Update bounty status
  const newStatus = bounty.status === 'funded' ? 'cancelled' : 'expired';
  await query(
    `UPDATE issue_bounties SET status = $1 WHERE id = $2`,
    [newStatus, bountyId]
  );

  // Record wallet transaction
  await query(
    `INSERT INTO wallet_transactions (agent_id, amount, tx_type, reference_id, note)
     VALUES ($1, $2, 'bounty_refund', $3, $4)`,
    [bounty.poster_agent_id, bounty.amount, bountyId, `Bounty refund of ${bounty.amount}`]
  );
}

/**
 * Check if a bounty has expired (deadline passed). If so and has submissions,
 * returns 'needs_judging'. If expired with no submissions, returns 'needs_refund'.
 * Otherwise returns 'active' or the current non-funded status.
 */
export async function checkBountyExpiry(bountyId: string): Promise<'active' | 'needs_judging' | 'needs_refund' | string> {
  const bounty = await getIssueBountyById(bountyId);
  if (!bounty) return 'not_found';

  if (bounty.status !== 'funded') return bounty.status;

  const now = new Date();
  const deadline = new Date(bounty.deadline);

  if (now <= deadline) return 'active';

  const submissionCount = await getBountySubmissionCount(bountyId);
  return submissionCount > 0 ? 'needs_judging' : 'needs_refund';
}

// ─── GitHub merge–gated payouts (plan Phase 1b) ───────────────────────────────

/** Map normalized score [0,1] to payout fraction using configurable non-linear curve. */
export function payoutFractionFromNormalizedScore(score: number): number {
  const s = Math.min(1, Math.max(0, score));
  const floor = env.PAYOUT_SCORE_FLOOR;
  if (s < floor) return 0;

  const normalized = (s - floor) / Math.max(1e-9, 1 - floor);
  const fraction = env.PAYOUT_MIN_ABOVE_FLOOR + (1 - env.PAYOUT_MIN_ABOVE_FLOOR) * Math.pow(normalized, env.PAYOUT_EXPONENT);
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * 100) / 100;
}

/** Map judge code_quality_score (1–10) to payout fraction with non-linear scaling. */
export function payoutFractionFromCodeQuality(codeQualityScore: number): number {
  const s = Math.min(10, Math.max(1, codeQualityScore));
  const normalized = (s - 1) / 9;
  return payoutFractionFromNormalizedScore(normalized);
}

export async function findIssueBountyByGithubPr(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<IssueBounty | null> {
  return queryOne<IssueBounty>(
    `SELECT ib.*
     FROM issue_bounties ib
     JOIN issues i ON i.id = ib.issue_id
     JOIN repositories r ON r.id = i.repo_id
     WHERE lower(r.github_owner) = lower($1)
       AND lower(r.github_repo) = lower($2)
       AND ib.github_pr_number = $3
     ORDER BY ib.created_at DESC
     LIMIT 1`,
    [owner, repo, prNumber],
  );
}

export async function persistGitHubJudgeOnBounty(
  bountyId: string,
  verdict: unknown,
  codeQualityScore: number,
  isMockJudge: boolean,
): Promise<void> {
  const fraction = isMockJudge ? 0 : payoutFractionFromCodeQuality(codeQualityScore);
  await query(
    `UPDATE issue_bounties
     SET github_judge_verdict = $1::jsonb,
         judge_payout_fraction = $2,
         is_mock_judge = $3,
         status = 'judging',
         payout_status = 'awaiting_merge'
     WHERE id = $4`,
    [verdict as object, fraction, isMockJudge, bountyId],
  );
}

export async function setBountyGithubPrNumber(bountyId: string, prNumber: number): Promise<void> {
  await query(
    `UPDATE issue_bounties SET github_pr_number = $1, payout_status = COALESCE(payout_status, 'awaiting_merge') WHERE id = $2`,
    [prNumber, bountyId],
  );
}

/**
 * After GitHub reports merged=true — pay winner (assigned agent) partial/full from stored fraction.
 */
export async function applyGitHubMergePayout(params: {
  bountyId: string;
  winnerAgentId: string;
  deliveryId: string;
}): Promise<{ paid: number; skipped: boolean; reason?: string }> {
  return applyGitHubMergePayoutInTransaction(null, params);
}

async function getIssueBountyByIdTx(
  client: DbClientLike | null,
  bountyId: string,
): Promise<IssueBounty | null> {
  if (client) {
    const res = await client.query<IssueBounty>(
      'SELECT * FROM issue_bounties WHERE id = $1 FOR UPDATE',
      [bountyId],
    );
    return res.rows[0] ?? null;
  }
  return getIssueBountyById(bountyId);
}

export async function applyGitHubMergePayoutInTransaction(
  client: DbClientLike | null,
  params: {
    bountyId: string;
    winnerAgentId: string;
    deliveryId: string;
  },
): Promise<{ paid: number; skipped: boolean; reason?: string }> {
  const tx = client;
  const bounty = await getIssueBountyByIdTx(tx, params.bountyId);
  if (!bounty) return { paid: 0, skipped: true, reason: 'bounty_not_found' };

  if (bounty.payout_status === 'paid') {
    return { paid: 0, skipped: true, reason: 'already_paid' };
  }
  if (bounty.merge_webhook_delivery_id === params.deliveryId) {
    return { paid: 0, skipped: true, reason: 'replay' };
  }
  if (bounty.merge_webhook_delivery_id) {
    return { paid: 0, skipped: true, reason: 'already_processed' };
  }

  if (bounty.is_mock_judge) {
    if (tx) {
      await tx.query(
        `UPDATE issue_bounties
         SET merge_webhook_delivery_id = $1,
             payout_status = 'blocked_mock_judge'
         WHERE id = $2`,
        [params.deliveryId, params.bountyId],
      );
    } else {
      await query(
        `UPDATE issue_bounties
         SET merge_webhook_delivery_id = $1,
             payout_status = 'blocked_mock_judge'
         WHERE id = $2`,
        [params.deliveryId, params.bountyId],
      );
    }
    return { paid: 0, skipped: true, reason: 'blocked_mock_judge' };
  }

  const fraction =
    bounty.judge_payout_fraction != null ? Number(bounty.judge_payout_fraction) : 0;
  const payAmount = Math.round(Number(bounty.amount) * fraction * 100) / 100;
  if (payAmount <= 0) {
    if (tx) {
      await tx.query(
        `UPDATE issue_bounties SET merge_webhook_delivery_id = $1, payout_status = 'paid' WHERE id = $2`,
        [params.deliveryId, params.bountyId],
      );
    } else {
      await query(
        `UPDATE issue_bounties SET merge_webhook_delivery_id = $1, payout_status = 'paid' WHERE id = $2`,
        [params.deliveryId, params.bountyId],
      );
    }
    return { paid: 0, skipped: true, reason: 'zero_payout' };
  }

  const exec = async (text: string, values?: unknown[]) => {
    if (tx) {
      await tx.query(text, values);
      return;
    }
    await query(text, values);
  };

  await exec(
    'UPDATE agents SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
    [payAmount, params.winnerAgentId],
  );
  await exec(
    `UPDATE issue_bounties
     SET status = 'awarded', winner_agent_id = $1, merge_webhook_delivery_id = $2, payout_status = 'paid'
     WHERE id = $3`,
    [params.winnerAgentId, params.deliveryId, params.bountyId],
  );
  await exec(
    `INSERT INTO wallet_transactions (agent_id, amount, tx_type, reference_id, note)
     VALUES ($1, $2, 'bounty_win', $3, $4)`,
    [params.winnerAgentId, payAmount, bounty.id, `GitHub merge payout (${fraction * 100}%)`],
  );
  await exec(
    'UPDATE agents SET reputation_score = reputation_score + 15 WHERE id = $1',
    [params.winnerAgentId],
  );

  const refund = Number(bounty.amount) - payAmount;
  if (refund > 0) {
    await exec(
      'UPDATE agents SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
      [refund, bounty.poster_agent_id],
    );
    await exec(
      `INSERT INTO wallet_transactions (agent_id, amount, tx_type, reference_id, note)
       VALUES ($1, $2, 'bounty_refund', $3, $4)`,
      [bounty.poster_agent_id, refund, bounty.id, 'GitHub merge: remainder to poster after partial payout'],
    );
  }

  return { paid: payAmount, skipped: false };
}

/** PR closed without merge — no agent payout; escrow returns to poster. */
export async function refundBountyOnGitHubCloseWithoutMerge(
  bountyId: string,
  deliveryId: string,
): Promise<void> {
  await refundBountyOnGitHubCloseWithoutMergeInTransaction(null, bountyId, deliveryId);
}

export async function refundBountyOnGitHubCloseWithoutMergeInTransaction(
  client: DbClientLike | null,
  bountyId: string,
  deliveryId: string,
): Promise<void> {
  const bounty = await getIssueBountyByIdTx(client, bountyId);
  if (!bounty) return;
  if (bounty.merge_webhook_delivery_id) return;

  const exec = async (text: string, values?: unknown[]) => {
    if (client) {
      await client.query(text, values);
      return;
    }
    await query(text, values);
  };

  await exec(
    `UPDATE issue_bounties
     SET merge_webhook_delivery_id = $1,
         payout_status = 'failed_non_merge'
     WHERE id = $2`,
    [deliveryId, bountyId],
  );

  await exec(
    'UPDATE agents SET wallet_balance = COALESCE(wallet_balance, 0) + $1 WHERE id = $2',
    [bounty.amount, bounty.poster_agent_id],
  );
  const newStatus = bounty.status === 'funded' ? 'cancelled' : 'expired';
  await exec(
    `UPDATE issue_bounties
     SET status = $1
     WHERE id = $2`,
    [newStatus, bountyId],
  );
  await exec(
    `INSERT INTO wallet_transactions (agent_id, amount, tx_type, reference_id, note)
     VALUES ($1, $2, 'bounty_refund', $3, $4)`,
    [bounty.poster_agent_id, bounty.amount, bountyId, `Bounty refund of ${bounty.amount}`],
  );
}
