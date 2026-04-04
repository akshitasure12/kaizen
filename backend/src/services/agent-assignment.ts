import { query } from '../db/client';
import { env } from '../env';

interface AgentRow {
  id: string;
  ens_name: string;
  role: string | null;
  capabilities: string[] | null;
  reputation_score: number | null;
}

interface OutcomeAggRow {
  agent_id: string;
  total_count: string;
  merged_count: string;
  avg_payout_fraction: string | null;
  avg_outcome_score: string | null;
}

interface RecentPenaltyRow {
  agent_id: string;
  recent_closed_without_merge_count: string;
  recent_failure_count: string;
  recent_penalty_score: string | null;
  reflection_required_count: string;
}

export interface RankedAgent {
  id: string;
  ens_name: string;
  assignment_score: number;
  relevance_score: number;
  performance_score: number;
  merge_rate: number;
  quality_score: number;
  penalty_score: number;
  reflection_load: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function overlapScore(issueTokens: Set<string>, agentTokens: Set<string>): number {
  if (issueTokens.size === 0 || agentTokens.size === 0) return 0;
  let hit = 0;
  issueTokens.forEach((t) => {
    if (agentTokens.has(t)) hit += 1;
  });
  return clamp01(hit / issueTokens.size);
}

export async function rankAgentsForIssue(params: {
  issueTitle: string;
  issueBody: string;
  limit?: number;
}): Promise<RankedAgent[]> {
  const [agents, outcomes] = await Promise.all([
    query<AgentRow>(
      `SELECT id, ens_name, role, capabilities, reputation_score
       FROM agents`,
    ),
    query<OutcomeAggRow>(
      `SELECT agent_id,
              COUNT(*)::text as total_count,
              COUNT(*) FILTER (WHERE merged = true)::text as merged_count,
              AVG(payout_fraction)::text as avg_payout_fraction,
              AVG(outcome_score)::text as avg_outcome_score
       FROM agent_outcomes
       GROUP BY agent_id`,
    ),
  ]);

  const recentPenalties = await query<RecentPenaltyRow>(
    `SELECT agent_id,
            COUNT(*) FILTER (
              WHERE merged = false
                AND (failure_category = 'closed_without_merge' OR failure_category IS NULL)
            )::text AS recent_closed_without_merge_count,
            COUNT(*) FILTER (WHERE merged = false)::text AS recent_failure_count,
            AVG(
              CASE
                WHEN outcome_score < 0 THEN ABS(outcome_score)
                WHEN merged = true THEN GREATEST(0, 0.35 - payout_fraction) * 0.5
                ELSE 0
              END
            )::text AS recent_penalty_score,
            COUNT(*) FILTER (
              WHERE outcome_score < 0
                 OR payout_fraction < 0.35
                 OR failure_category IS NOT NULL
            )::text AS reflection_required_count
     FROM agent_outcomes
     WHERE created_at >= NOW() - INTERVAL '30 days'
     GROUP BY agent_id`,
  );

  const outcomeMap = new Map(outcomes.map((o) => [o.agent_id, o]));
  const penaltyMap = new Map(recentPenalties.map((row) => [row.agent_id, row]));
  const issueTokens = new Set(tokenize(`${params.issueTitle} ${params.issueBody || ''}`));

  const ranked = agents.map<RankedAgent>((agent) => {
    const cap = Array.isArray(agent.capabilities) ? agent.capabilities.join(' ') : '';
    const agentTokens = new Set(tokenize(`${agent.ens_name} ${agent.role || ''} ${cap}`));
    const relevance = overlapScore(issueTokens, agentTokens);

    const outcome = outcomeMap.get(agent.id);
    const penalty = penaltyMap.get(agent.id);
    const total = outcome ? Number(outcome.total_count) : 0;
    const merged = outcome ? Number(outcome.merged_count) : 0;
    const mergeRate = total > 0 ? clamp01(merged / total) : 0.5;
    const quality = outcome?.avg_payout_fraction != null ? clamp01(Number(outcome.avg_payout_fraction)) : 0.5;
    const avgOutcomeScore = outcome?.avg_outcome_score != null ? Number(outcome.avg_outcome_score) : 0.25;
    const outcomeReliability = clamp01((avgOutcomeScore + 1) / 2);
    const repNorm = clamp01(Number(agent.reputation_score ?? 0) / 100);
    const recentClosedWithoutMerge = penalty ? Number(penalty.recent_closed_without_merge_count) : 0;
    const recentFailures = penalty ? Number(penalty.recent_failure_count) : 0;
    const directPenalty = penalty?.recent_penalty_score != null ? clamp01(Number(penalty.recent_penalty_score)) : 0;
    const reflectionLoad = penalty
      ? Math.min(0.2, Number(penalty.reflection_required_count || "0") * 0.02)
      : 0;

    const penaltyUnit = env.REPUTATION_NO_MERGE_PENALTY;
    const countPenalty = clamp01(
      Math.min(0.4, recentClosedWithoutMerge * penaltyUnit + recentFailures * (penaltyUnit / 3)),
    );
    const penaltyScore = clamp01(Math.min(0.75, directPenalty + reflectionLoad + countPenalty));

    const rawPerformance = clamp01(
      0.32 * repNorm +
      0.24 * mergeRate +
      0.24 * quality +
      0.2 * outcomeReliability -
      penaltyScore,
    );
    const performance = Math.min(
      env.ASSIGNMENT_PERF_CAP,
      Math.max(env.ASSIGNMENT_PERF_FLOOR, rawPerformance),
    );
    const assignment = clamp01(0.55 * relevance + 0.45 * performance);

    return {
      id: agent.id,
      ens_name: agent.ens_name,
      assignment_score: assignment,
      relevance_score: relevance,
      performance_score: performance,
      merge_rate: mergeRate,
      quality_score: quality,
      penalty_score: penaltyScore,
      reflection_load: reflectionLoad,
    };
  });

  ranked.sort((a, b) => b.assignment_score - a.assignment_score);
  return ranked.slice(0, params.limit ?? 5);
}
