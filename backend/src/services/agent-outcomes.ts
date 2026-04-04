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

export interface DeterministicPenaltyResult {
  penaltyScore: number;
  components: {
    noMerge: number;
    lowPayout: number;
    lowJudge: number;
    retry: number;
    failureCategory: number;
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
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

export function computeDeterministicPenalty(input: {
  merged: boolean;
  payoutFraction: number;
  judgeScore: number | null;
  retryCount?: number;
  failureCategory?: string | null;
}): DeterministicPenaltyResult {
  const payout = clamp01(input.payoutFraction);
  const judge = input.judgeScore == null ? null : clamp01(input.judgeScore);

  const noMerge = input.merged ? 0 : clamp01(env.REPUTATION_NO_MERGE_PENALTY);
  const lowPayout = input.merged ? Math.max(0, 0.35 - payout) * 0.35 : 0;
  const lowJudge = judge == null ? 0 : Math.max(0, 0.55 - judge) * 0.45;
  const retry = Math.min(0.18, Math.max(0, input.retryCount ?? 0) * 0.03);
  const failureCategory = input.failureCategory
    ? input.failureCategory === "closed_without_merge"
      ? 0.08
      : 0.04
    : 0;

  const penaltyScore = round4(clamp01(noMerge + lowPayout + lowJudge + retry + failureCategory));

  return {
    penaltyScore,
    components: {
      noMerge: round4(noMerge),
      lowPayout: round4(lowPayout),
      lowJudge: round4(lowJudge),
      retry: round4(retry),
      failureCategory: round4(failureCategory),
    },
  };
}

export function deriveCorrectiveActionsForOutcome(input: {
  merged: boolean;
  payoutFraction: number;
  failureCategory?: string | null;
  judgeVerdict?: unknown;
}): string[] {
  const verdict = input.judgeVerdict && typeof input.judgeVerdict === "object"
    ? (input.judgeVerdict as { suggestions?: unknown })
    : null;
  const actions: string[] = [];

  actions.push(...asStringArray(verdict?.suggestions));

  if (!input.merged || input.failureCategory === "closed_without_merge") {
    actions.push("Keep the pull request active until reviewer feedback is addressed and settlement is complete.");
    actions.push("Respond to review comments within one iteration and push a follow-up verification run.");
  }

  if (input.payoutFraction < 0.5) {
    actions.push("Increase scorecard alignment: satisfy required tests and at least one bonus criterion before merge.");
  }

  actions.push("Summarize root cause and corrected approach in KAIZEN_AGENT.md before the next attempt.");

  const deduped = uniqueStrings(actions);
  return deduped.length > 0
    ? deduped.slice(0, 8)
    : [
        "Run full verification before requesting merge.",
        "Document root cause and corrective steps for the next attempt.",
      ];
}

interface DbClientLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

async function recordAgentOutcomeWithClient(
  client: DbClientLike,
  input: RecordAgentOutcomeInput,
): Promise<RecordAgentOutcomeResult> {
  const existing = await client.query<{ id: string }>(
    input.settlementKey
      ? "SELECT id FROM agent_outcomes WHERE settlement_key = $1 OR merge_event_id = $2 LIMIT 1"
      : "SELECT id FROM agent_outcomes WHERE merge_event_id = $1 LIMIT 1",
    input.settlementKey ? [input.settlementKey, input.mergeEventId] : [input.mergeEventId],
  );
  if (existing.rows.length > 0) {
    return { outcomeId: existing.rows[0].id, previousScore: null, nextScore: null, skipped: true, reason: "duplicate_event" };
  }

  const agentRow = await client.query<{ reputation_score: number | null }>(
    "SELECT reputation_score FROM agents WHERE id = $1 FOR UPDATE",
    [input.agentId],
  );
  if (agentRow.rows.length === 0) {
    return { outcomeId: null, previousScore: null, nextScore: null, skipped: true, reason: "agent_not_found" };
  }

  const alpha = env.REPUTATION_EWMA_ALPHA;
  const previousScore = Number(agentRow.rows[0].reputation_score ?? 0);
  const deterministicPenalty = computeDeterministicPenalty({
    merged: input.merged,
    payoutFraction: input.payoutFraction,
    judgeScore: input.judgeScore,
    retryCount: input.retryCount,
    failureCategory: input.failureCategory,
  });
  const positiveOutcome = clamp01(input.payoutFraction);
  const outcomeScore = input.merged
    ? clamp01(positiveOutcome - deterministicPenalty.penaltyScore)
    : -deterministicPenalty.penaltyScore;
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

  return {
    outcomeId: inserted.rows[0].id,
    previousScore,
    nextScore,
    skipped: false,
  };
}

export async function recordAgentOutcomeInTransaction(
  client: DbClientLike,
  input: RecordAgentOutcomeInput,
): Promise<RecordAgentOutcomeResult> {
  return recordAgentOutcomeWithClient(client, input);
}

export async function recordAgentOutcome(input: RecordAgentOutcomeInput): Promise<RecordAgentOutcomeResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await recordAgentOutcomeWithClient(client, input);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
