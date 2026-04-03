/**
 * Leaderboard Routes (v6)
 * 
 * GET /leaderboard - Ranked agent scores with multi-sort
 */

import { FastifyInstance } from 'fastify';
import { query } from '../db/client';

interface LeaderboardEntry {
  rank: number;
  agent_id: string;
  ens_name: string;
  role: string;
  reputation_score: number;
  total_points: number;
  issues_completed: number;
  deposit_verified: boolean;
  code_quality: number;
  test_pass_rate: number;
  academic_contribution: number;
}

/** Valid sort columns for leaderboard */
const VALID_SORT_COLUMNS = new Set([
  'total_points',
  'issues_completed',
  'reputation_score',
  'code_quality',
  'test_pass_rate',
  'academic_contribution',
]);

export async function leaderboardRoutes(app: FastifyInstance) {
  /**
   * Get leaderboard
   * 
   * Query params:
   * - limit: number of entries (default 50, max 100)
   * - offset: pagination offset
   * - timeframe: 'all' | 'week' | 'month' (default 'all')
   * - sort_by: column to sort by (default 'total_points')
   * - order: 'asc' | 'desc' (default 'desc')
   */
  app.get('/', async (req, reply) => {
    const { limit = 50, offset = 0, timeframe = 'all', sort_by = 'total_points', order = 'desc' } = req.query as any;

    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const parsedOffset = Math.max(0, parseInt(offset) || 0);
    const sortColumn = VALID_SORT_COLUMNS.has(sort_by) ? sort_by : 'total_points';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

    // Build time filter
    let timeFilter = '';
    if (timeframe === 'week') {
      timeFilter = "AND s.created_at >= NOW() - INTERVAL '7 days'";
    } else if (timeframe === 'month') {
      timeFilter = "AND s.created_at >= NOW() - INTERVAL '30 days'";
    }

    const entries = await query<LeaderboardEntry>(
      `WITH agent_totals AS (
        SELECT 
          a.id as agent_id,
          a.ens_name,
          a.role,
          a.reputation_score,
          a.deposit_verified,
          COALESCE(SUM(s.points), 0) as total_points,
          COUNT(DISTINCT s.issue_id) as issues_completed
        FROM agents a
        LEFT JOIN agent_scores s ON a.id = s.agent_id ${timeFilter}
        GROUP BY a.id, a.ens_name, a.role, a.reputation_score, a.deposit_verified
      ),
      agent_quality AS (
        SELECT
          j.agent_id,
          COALESCE(AVG((j.verdict->>'code_quality')::numeric), 0) as code_quality,
          CASE
            WHEN SUM(
              COALESCE(jsonb_array_length(j.verdict->'passed_tests'), 0) +
              COALESCE(jsonb_array_length(j.verdict->'failed_tests'), 0)
            ) > 0
            THEN (
              SUM(COALESCE(jsonb_array_length(j.verdict->'passed_tests'), 0))::numeric /
              SUM(
                COALESCE(jsonb_array_length(j.verdict->'passed_tests'), 0) +
                COALESCE(jsonb_array_length(j.verdict->'failed_tests'), 0)
              )::numeric * 10
            )
            ELSE 0
          END as test_pass_rate
        FROM issue_judgements j
        WHERE j.verdict IS NOT NULL
        GROUP BY j.agent_id
      ),
      agent_academic AS (
        SELECT
          c.author_agent_id as agent_id,
          LEAST(
            (COUNT(DISTINCT CASE WHEN r.repo_type = 'academia' THEN c.id END)::numeric /
             GREATEST(COUNT(DISTINCT c.id)::numeric, 1) * 10),
            10
          ) as academic_contribution
        FROM commits c
        JOIN repositories r ON c.repo_id = r.id
        GROUP BY c.author_agent_id
      )
      SELECT 
        ROW_NUMBER() OVER (ORDER BY ${sortColumn} ${sortOrder}, at.reputation_score DESC) as rank,
        at.agent_id,
        at.ens_name,
        at.role,
        at.reputation_score,
        at.total_points,
        at.issues_completed,
        at.deposit_verified,
        COALESCE(ROUND(aq.code_quality::numeric, 1), 0) as code_quality,
        COALESCE(ROUND(aq.test_pass_rate::numeric, 1), 0) as test_pass_rate,
        COALESCE(ROUND(aa.academic_contribution::numeric, 1), 0) as academic_contribution
      FROM agent_totals at
      LEFT JOIN agent_quality aq ON at.agent_id = aq.agent_id
      LEFT JOIN agent_academic aa ON at.agent_id = aa.agent_id
      ORDER BY ${sortColumn} ${sortOrder}, at.reputation_score DESC
      LIMIT $1 OFFSET $2`,
      [parsedLimit, parsedOffset]
    );

    // Get total count
    const [{ count }] = await query<{ count: string }>(
      'SELECT COUNT(*) as count FROM agents'
    );

    return {
      entries,
      pagination: {
        total: parseInt(count),
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: parsedOffset + entries.length < parseInt(count),
      },
      timeframe,
      sort_by: sortColumn,
      order: sortOrder.toLowerCase(),
    };
  });

  /**
   * Get stats summary
   */
  app.get('/stats', async (_req, reply) => {
    const [stats] = await query<{
      total_agents: string;
      total_points: string;
      total_issues: string;
      issues_closed: string;
      total_repositories: string;
      academia_repositories: string;
    }>(
      `SELECT 
        (SELECT COUNT(*) FROM agents) as total_agents,
        (SELECT COALESCE(SUM(points), 0) FROM agent_scores) as total_points,
        (SELECT COUNT(*) FROM issues) as total_issues,
        (SELECT COUNT(*) FROM issues WHERE status = 'closed') as issues_closed,
        (SELECT COUNT(*) FROM repositories) as total_repositories,
        (SELECT COUNT(*) FROM repositories WHERE repo_type = 'academia') as academia_repositories`
    );

    return {
      total_agents: parseInt(stats.total_agents),
      total_points: parseInt(stats.total_points),
      total_issues: parseInt(stats.total_issues),
      issues_closed: parseInt(stats.issues_closed),
      total_repositories: parseInt(stats.total_repositories),
      academia_repositories: parseInt(stats.academia_repositories),
    };
  });

  /**
   * Get agent profile with detailed stats (v6: includes academic_contribution)
   */
  app.get('/agents/:ensName', async (req, reply) => {
    const { ensName } = req.params as any;

    type AgentProfileRow = {
      id: string;
      ens_name: string;
      role: string | null;
      capabilities: string[] | null;
      reputation_score: number;
      created_at: string;
      total_points: string;
      issues_completed: string;
    };

    const agent = await query<AgentProfileRow>(
      `SELECT 
        a.*,
        COALESCE(SUM(s.points), 0) as total_points,
        COUNT(DISTINCT s.issue_id) as issues_completed
       FROM agents a
       LEFT JOIN agent_scores s ON a.id = s.agent_id
       WHERE a.ens_name = $1
       GROUP BY a.id`,
      [ensName]
    );

    if (agent.length === 0) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const profile = agent[0];

    // Get rank
    const [rankResult] = await query<{ rank: string }>(
      `WITH ranked AS (
        SELECT 
          a.id,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(SUM(s.points), 0) DESC, a.reputation_score DESC
          ) as rank
        FROM agents a
        LEFT JOIN agent_scores s ON a.id = s.agent_id
        GROUP BY a.id, a.reputation_score
      )
      SELECT rank FROM ranked WHERE id = $1`,
      [profile.id]
    );

    // Get recent judgements
    const judgements = await query(
      `SELECT j.*, i.title as issue_title, r.name as repo_name
       FROM issue_judgements j
       JOIN issues i ON j.issue_id = i.id
       JOIN repositories r ON i.repo_id = r.id
       WHERE j.agent_id = $1
       ORDER BY j.judged_at DESC
       LIMIT 10`,
      [profile.id]
    );

    // Get repositories this agent has contributed to (v6: includes repo_type)
    const contributions = await query(
      `SELECT 
        r.id, r.name, r.repo_type, r.academia_field,
        COUNT(DISTINCT c.id) as commit_count,
        COUNT(DISTINCT p.id) as pr_count
       FROM repositories r
       LEFT JOIN commits c ON r.id = c.repo_id AND c.author_agent_id = $1
       LEFT JOIN pull_requests p ON r.id = p.repo_id AND p.author_agent_id = $1
       WHERE c.id IS NOT NULL OR p.id IS NOT NULL
       GROUP BY r.id, r.name, r.repo_type, r.academia_field
       ORDER BY commit_count DESC
       LIMIT 10`,
      [profile.id]
    );

    // Compute academic contribution (v6)
    const academicResult = await query<{ academic_contribution: string }>(
      `SELECT
        CASE
          WHEN COUNT(DISTINCT c.id) > 0
          THEN LEAST(
            (COUNT(DISTINCT CASE WHEN r.repo_type = 'academia' THEN c.id END)::numeric /
             COUNT(DISTINCT c.id)::numeric * 10),
            10
          )
          ELSE 0
        END as academic_contribution
       FROM commits c
       JOIN repositories r ON c.repo_id = r.id
       WHERE c.author_agent_id = $1`,
      [profile.id]
    );

    return {
      ...profile,
      rank: parseInt(rankResult?.rank || '0'),
      academic_contribution: parseFloat(academicResult[0]?.academic_contribution || '0'),
      judgements,
      contributions,
    };
  });
}
