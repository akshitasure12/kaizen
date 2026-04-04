import { pool } from "../db/client";
import { env } from "../env";

export interface RecordAgentOutcomeInput {
  agentId: string;
  issueId: string;
  bountyId: string;
  mergeEventId: string;
  settlementKey?: string;
  merged: boolean;
  payoutFraction: number;
  payoutAmount: number;
  judgeScore: number | null;
  failureCategory?: string | null;
  retryCount?: number;
  latencyMs?: number;
}

export interface RecordAgentOutcomeResult {
  outcomeId: string | null;
  previousScore: number | null;
  nextScore: number | null;
  skipped: boolean;
  reason?: "duplicate_event" | "agent_not_found";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export async function recordAgentOutcome(input: RecordAgentOutcomeInput): Promise<RecordAgentOutcomeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string }>(
      input.settlementKey
        ? "SELECT id FROM agent_outcomes WHERE settlement_key = $1 OR merge_event_id = $2 LIMIT 1"
        : "SELECT id FROM agent_outcomes WHERE merge_event_id = $1 LIMIT 1",
      input.settlementKey ? [input.settlementKey, input.mergeEventId] : [input.mergeEventId],
    );
    if (existing.rows.length > 0) {
      await client.query("ROLLBACK");
      return { outcomeId: existing.rows[0].id, previousScore: null, nextScore: null, skipped: true, reason: "duplicate_event" };
    }

    const agentRow = await client.query<{ reputation_score: number | null }>(
      "SELECT reputation_score FROM agents WHERE id = $1 FOR UPDATE",
      [input.agentId],
    );
    if (agentRow.rows.length === 0) {
      await client.query("ROLLBACK");
      return { outcomeId: null, previousScore: null, nextScore: null, skipped: true, reason: "agent_not_found" };
    }

    const alpha = env.REPUTATION_EWMA_ALPHA;
    const previousScore = Number(agentRow.rows[0].reputation_score ?? 0);
    const positiveOutcome = clamp01(input.payoutFraction);
    const outcomeScore = input.merged
      ? positiveOutcome
      : -clamp01(env.REPUTATION_NO_MERGE_PENALTY);
    const nextScore = round4((1 - alpha) * previousScore + alpha * (outcomeScore * 100));

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO agent_outcomes (
         agent_id,
         issue_id,
         bounty_id,
         merge_event_id,
         merged,
         payout_fraction,
         payout_amount,
         judge_score,
         outcome_score,
         retry_count,
         latency_ms,
         failure_category,
         settlement_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        input.agentId,
        input.issueId,
        input.bountyId,
        input.mergeEventId,
        input.merged,
        clamp01(input.payoutFraction),
        Math.max(0, input.payoutAmount),
        input.judgeScore == null ? null : clamp01(input.judgeScore),
        outcomeScore,
        input.retryCount ?? 0,
        input.latencyMs ?? null,
        input.failureCategory ?? null,
        input.settlementKey ?? null,
      ],
    );

    await client.query("UPDATE agents SET reputation_score = $1 WHERE id = $2", [Math.round(nextScore), input.agentId]);
    await client.query(
      `INSERT INTO agent_reputation_snapshots (agent_id, outcome_id, previous_score, next_score, ewma_alpha)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.agentId, inserted.rows[0].id, previousScore, nextScore, alpha],
    );

    await client.query("COMMIT");
    return {
      outcomeId: inserted.rows[0].id,
      previousScore,
      nextScore,
      skipped: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
