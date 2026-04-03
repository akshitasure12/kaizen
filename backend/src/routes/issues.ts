/**
 * Issues Routes
 * 
 * CRUD for issues with scorecard support and judge integration.
 * v3: Competitive issue bounty endpoints.
 */

import { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { judgeSubmission, storeJudgement, judgeAllSubmissions, Scorecard } from '../services/judge';
import * as sdk from '../sdk';
import * as bountyService from '../services/bounty';

interface Issue {
  id: string;
  repo_id: string;
  title: string;
  body: string;
  status: 'open' | 'in_progress' | 'closed' | 'cancelled';
  scorecard: Scorecard;
  assigned_agent_id: string | null;
  created_by: string;
  closed_at: string | null;
  created_at: string;
}

export async function issueRoutes(app: FastifyInstance) {
  /**
   * Create a new issue
   */
  app.post('/:repoId/issues', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId } = req.params as any;
    const { title, body, scorecard, parent_issue_id } = req.body as any;

    if (!title) {
      return reply.status(400).send({ error: 'Title is required' });
    }

    // Verify repo exists
    const repo = await queryOne('SELECT id FROM repositories WHERE id = $1', [repoId]);
    if (!repo) {
      return reply.status(404).send({ error: 'Repository not found' });
    }

    let rootIssueId: string | null = null;
    let parentId: string | null = null;
    if (parent_issue_id) {
      const parent = await queryOne<{ id: string; repo_id: string; root_issue_id: string | null }>(
        'SELECT id, repo_id, root_issue_id FROM issues WHERE id = $1',
        [parent_issue_id],
      );
      if (!parent || parent.repo_id !== repoId) {
        return reply.status(400).send({ error: 'Invalid parent_issue_id' });
      }
      parentId = parent.id;
      rootIssueId = parent.root_issue_id || parent.id;
    }

    // Validate scorecard if provided
    const validScorecard = validateScorecard(scorecard);

    const [issue] = await query<Issue>(
      `INSERT INTO issues (repo_id, title, body, scorecard, created_by, parent_issue_id, root_issue_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [repoId, title, body || '', validScorecard, req.user!.userId, parentId, rootIssueId]
    );

    return reply.status(201).send(issue);
  });

  /**
   * List issues for a repository
   */
  app.get('/:repoId/issues', async (req, reply) => {
    const { repoId } = req.params as any;
    const { status } = req.query as any;

    let whereClause = 'WHERE i.repo_id = $1';
    const params: any[] = [repoId];

    if (status) {
      params.push(status);
      whereClause += ` AND i.status = $${params.length}`;
    }

    const issues = await query(
      `SELECT i.*, u.username as created_by_username, 
              a.ens_name as assigned_agent_ens
       FROM issues i
       JOIN users u ON i.created_by = u.id
       LEFT JOIN agents a ON i.assigned_agent_id = a.id
       ${whereClause}
       ORDER BY i.created_at DESC`
      , params
    );

    return issues;
  });

  /**
   * Get single issue with judgements
   */
  app.get('/:repoId/issues/:issueId', async (req, reply) => {
    const { repoId, issueId } = req.params as any;

    const issue = await queryOne<Issue>(
      `SELECT i.*, u.username as created_by_username,
              a.ens_name as assigned_agent_ens
       FROM issues i
       JOIN users u ON i.created_by = u.id
       LEFT JOIN agents a ON i.assigned_agent_id = a.id
       WHERE i.id = $1 AND i.repo_id = $2`,
      [issueId, repoId]
    );

    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    // Get all judgements for this issue
    const judgements = await query(
      `SELECT j.*, a.ens_name as agent_ens
       FROM issue_judgements j
       JOIN agents a ON j.agent_id = a.id
       WHERE j.issue_id = $1
       ORDER BY j.points_awarded DESC`,
      [issueId]
    );

    return { ...issue, judgements };
  });

  /**
   * Update issue
   */
  app.patch('/:repoId/issues/:issueId', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { title, body, status, scorecard } = req.body as any;

    const issue = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId]
    );

    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    // Build update query
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(title);
    }
    if (body !== undefined) {
      updates.push(`body = $${paramIndex++}`);
      values.push(body);
    }
    if (status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(status);
      if (status === 'closed') {
        updates.push(`closed_at = NOW()`);
      }
    }
    if (scorecard !== undefined) {
      updates.push(`scorecard = $${paramIndex++}`);
      values.push(validateScorecard(scorecard));
    }

    if (updates.length === 0) {
      return reply.status(400).send({ error: 'No fields to update' });
    }

    values.push(issueId);

    const [updated] = await query<Issue>(
      `UPDATE issues SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    return updated;
  });

  /**
   * Assign agent to issue
   */
  app.post('/:repoId/issues/:issueId/assign', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { agent_ens } = req.body as any;

    if (!agent_ens) {
      return reply.status(400).send({ error: 'agent_ens is required' });
    }

    const agent = await sdk.getAgent(agent_ens);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const [issue] = await query<Issue>(
      `UPDATE issues SET assigned_agent_id = $1, status = 'in_progress'
       WHERE id = $2 AND repo_id = $3
       RETURNING *`,
      [agent.id, issueId, repoId]
    );

    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    return issue;
  });

  /**
   * Close issue and trigger judge
   * 
   * The judge evaluates the assigned agent's submissions (commits)
   * and awards points based on the scorecard.
   */
  app.post('/:repoId/issues/:issueId/close', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { submission_content } = req.body as any;

    const issue = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId]
    );

    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    if (issue.status === 'closed') {
      return reply.status(400).send({ error: 'Issue is already closed' });
    }

    if (!issue.assigned_agent_id) {
      return reply.status(400).send({ error: 'No agent assigned to this issue' });
    }

    // Get submission content - either from request body or from agent's commits
    let content = submission_content;

    if (!content) {
      // Get agent's commits on this repo as submission
      const commits = await query(
        `SELECT c.message, c.content_ref FROM commits c
         WHERE c.repo_id = $1 AND c.author_agent_id = $2
         ORDER BY c.created_at DESC LIMIT 10`,
        [repoId, issue.assigned_agent_id]
      );

      content = commits.map((c: any) => `${c.message}\n${c.content_ref}`).join('\n\n---\n\n');
    }

    if (!content) {
      return reply.status(400).send({ error: 'No submission content found' });
    }

    // Parse scorecard
    const scorecard = issue.scorecard as Scorecard;

    // Run judge
    const result = await judgeSubmission(
      issueId,
      issue.assigned_agent_id,
      content,
      scorecard
    );

    // Store judgement
    await storeJudgement(issueId, issue.assigned_agent_id, result);

    // Close issue
    const [closed] = await query<Issue>(
      `UPDATE issues SET status = 'closed', closed_at = NOW()
       WHERE id = $1 RETURNING *`,
      [issueId]
    );

    return {
      issue: closed,
      judgement: {
        verdict: result.verdict,
        points_awarded: result.points_awarded,
        is_mock: result.is_mock,
      },
    };
  });

  /**
   * Submit solution for issue (by agent)
   */
  app.post('/:repoId/issues/:issueId/submit', async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { agent_ens, content } = req.body as any;

    if (!agent_ens || !content) {
      return reply.status(400).send({ error: 'agent_ens and content are required' });
    }

    const agent = await sdk.getAgent(agent_ens);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const issue = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId]
    );

    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    if (issue.status === 'closed') {
      return reply.status(400).send({ error: 'Issue is already closed' });
    }

    // Run judge
    const scorecard = issue.scorecard as Scorecard;
    const result = await judgeSubmission(issueId, agent.id, content, scorecard);

    // Store judgement
    await storeJudgement(issueId, agent.id, result);

    return {
      judgement: {
        verdict: result.verdict,
        points_awarded: result.points_awarded,
        is_mock: result.is_mock,
      },
    };
  });

  // ─── Competitive Issue Bounty Endpoints (v3) ──────────────────────────────

  /**
   * Post a bounty on an issue
   * An agent locks tokens from their wallet on an issue.
   * Other agents compete to solve it within the deadline.
   */
  app.post('/:repoId/issues/:issueId/bounty', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { agent_ens, amount, deadline_hours, max_submissions } = req.body as any;

    if (!agent_ens || !amount || !deadline_hours) {
      return reply.status(400).send({ error: 'agent_ens, amount, and deadline_hours are required' });
    }

    if (amount <= 0) {
      return reply.status(400).send({ error: 'amount must be positive' });
    }

    if (deadline_hours <= 0) {
      return reply.status(400).send({ error: 'deadline_hours must be positive' });
    }

    // Verify issue exists and is open
    const issue = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId]
    );
    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }
    if (issue.status === 'closed' || issue.status === 'cancelled') {
      return reply.status(400).send({ error: 'Cannot post bounty on a closed/cancelled issue' });
    }

    // Verify agent exists
    const agent = await sdk.getAgent(agent_ens);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    // Calculate deadline
    const deadline = new Date(Date.now() + deadline_hours * 60 * 60 * 1000);

    try {
      const bounty = await bountyService.postIssueBounty(
        issueId,
        agent.id,
        amount,
        deadline,
        max_submissions ?? 5
      );
      return reply.status(201).send(bounty);
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  /**
   * Get the active bounty for an issue
   */
  app.get('/:repoId/issues/:issueId/bounty', async (req, reply) => {
    const { issueId } = req.params as any;

    const bounty = await bountyService.getIssueBounty(issueId);
    if (!bounty) {
      return reply.status(404).send({ error: 'No bounty found for this issue' });
    }

    // Check for lazy expiry
    if (bounty.status === 'funded') {
      const expiryStatus = await bountyService.checkBountyExpiry(bounty.id);
      if (expiryStatus === 'needs_refund') {
        await bountyService.refundIssueBounty(bounty.id);
        const updated = await bountyService.getIssueBountyById(bounty.id);
        return { ...updated, submissions: [] };
      }
    }

    const submissions = await bountyService.getIssueBountySubmissions(bounty.id);
    return { ...bounty, submissions, submission_count: submissions.length };
  });

  /**
   * Submit a solution for a bounty
   * Any agent (except the poster) can submit within the deadline and max_submissions cap.
   */
  app.post('/:repoId/issues/:issueId/bounty-submit', async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { agent_ens, content } = req.body as any;

    if (!agent_ens || !content) {
      return reply.status(400).send({ error: 'agent_ens and content are required' });
    }

    const agent = await sdk.getAgent(agent_ens);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const bounty = await bountyService.getIssueBounty(issueId);
    if (!bounty) {
      return reply.status(404).send({ error: 'No bounty found for this issue' });
    }

    if (bounty.status !== 'funded') {
      return reply.status(400).send({ error: `Bounty is not accepting submissions (status: ${bounty.status})` });
    }

    // Check deadline
    const now = new Date();
    const deadline = new Date(bounty.deadline);
    if (now > deadline) {
      return reply.status(400).send({ error: 'Bounty deadline has passed' });
    }

    // Poster cannot submit to their own bounty
    if (agent.id === bounty.poster_agent_id) {
      return reply.status(400).send({ error: 'Bounty poster cannot submit to their own bounty' });
    }

    // Check max submissions
    const currentCount = await bountyService.getBountySubmissionCount(bounty.id);
    if (currentCount >= bounty.max_submissions) {
      return reply.status(400).send({ error: 'Maximum submissions reached for this bounty' });
    }

    try {
      const submission = await bountyService.submitToBounty(bounty.id, agent.id, content);

      // Auto-trigger judging if max submissions reached
      const newCount = currentCount + 1;
      let judgingTriggered = false;
      if (newCount >= bounty.max_submissions) {
        judgingTriggered = true;
        // Trigger judging asynchronously (don't block response)
        const issue = await queryOne<Issue>(
          'SELECT * FROM issues WHERE id = $1',
          [issueId]
        );
        if (issue) {
          const scorecard = issue.scorecard as Scorecard;
          triggerBountyJudging(bounty.id, issueId, scorecard).catch(err => {
            console.error('Auto-judging failed:', err.message);
          });
        }
      }

      return reply.status(201).send({
        submission,
        submission_count: newCount,
        max_submissions: bounty.max_submissions,
        judging_triggered: judgingTriggered,
      });
    } catch (err: any) {
      if (err.message?.includes('unique') || err.message?.includes('duplicate')) {
        return reply.status(409).send({ error: 'Agent has already submitted to this bounty' });
      }
      return reply.status(400).send({ error: err.message });
    }
  });

  /**
   * Trigger judging for a bounty (manually or on deadline/max_submissions).
   * Scores all submissions and awards the bounty to the best submission.
   */
  app.post('/:repoId/issues/:issueId/bounty-judge', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;

    const bounty = await bountyService.getIssueBounty(issueId);
    if (!bounty) {
      return reply.status(404).send({ error: 'No bounty found for this issue' });
    }

    if (bounty.status !== 'funded' && bounty.status !== 'judging') {
      return reply.status(400).send({ error: `Cannot judge bounty with status: ${bounty.status}` });
    }

    const submissionCount = await bountyService.getBountySubmissionCount(bounty.id);
    if (submissionCount === 0) {
      // No submissions — refund
      await bountyService.refundIssueBounty(bounty.id);
      return { message: 'No submissions. Bounty refunded to poster.', status: 'refunded' };
    }

    const issue = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId]
    );
    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    const scorecard = issue.scorecard as Scorecard;
    const result = await triggerBountyJudging(bounty.id, issueId, scorecard);

    return result;
  });

  /**
   * Cancel a bounty (only poster, only if no submissions yet).
   */
  app.delete('/:repoId/issues/:issueId/bounty', { preHandler: requireAuth }, async (req, reply) => {
    const { issueId } = req.params as any;
    const { agent_ens } = req.body as any;

    if (!agent_ens) {
      return reply.status(400).send({ error: 'agent_ens is required' });
    }

    const agent = await sdk.getAgent(agent_ens);
    if (!agent) {
      return reply.status(404).send({ error: 'Agent not found' });
    }

    const bounty = await bountyService.getIssueBounty(issueId);
    if (!bounty) {
      return reply.status(404).send({ error: 'No bounty found for this issue' });
    }

    if (bounty.poster_agent_id !== agent.id) {
      return reply.status(403).send({ error: 'Only the bounty poster can cancel' });
    }

    if (bounty.status !== 'funded') {
      return reply.status(400).send({ error: `Cannot cancel bounty with status: ${bounty.status}` });
    }

    const submissionCount = await bountyService.getBountySubmissionCount(bounty.id);
    if (submissionCount > 0) {
      return reply.status(400).send({ error: 'Cannot cancel bounty with existing submissions' });
    }

    await bountyService.refundIssueBounty(bounty.id);
    return { message: 'Bounty cancelled and refunded', status: 'cancelled' };
  });
}

/**
 * Helper: trigger bounty judging for all submissions.
 * Scores each submission via the judge service, picks the winner,
 * and awards the bounty (or refunds if no valid submissions).
 */
async function triggerBountyJudging(
  bountyId: string,
  issueId: string,
  scorecard: Scorecard
): Promise<{
  status: string;
  results: Array<{ agent_id: string; points_awarded: number; is_mock: boolean }>;
  winner: { agent_id: string; points_awarded: number } | null;
}> {
  const judgeResult = await judgeAllSubmissions(bountyId, scorecard);

  if (judgeResult.winner) {
    // Get bounty to know the amount
    const bounty = await bountyService.getIssueBountyById(bountyId);
    if (bounty) {
      await bountyService.awardIssueBounty(bountyId, judgeResult.winner.agent_id, Number(bounty.amount));
    }
    return {
      status: 'awarded',
      results: judgeResult.results.map(r => ({
        agent_id: r.agent_id,
        points_awarded: r.points_awarded,
        is_mock: r.is_mock,
      })),
      winner: judgeResult.winner,
    };
  } else {
    // No winner (all scored 0 or empty) — refund
    await bountyService.refundIssueBounty(bountyId);
    return {
      status: 'refunded',
      results: judgeResult.results.map(r => ({
        agent_id: r.agent_id,
        points_awarded: r.points_awarded,
        is_mock: r.is_mock,
      })),
      winner: null,
    };
  }
}

/**
 * Validate and normalize scorecard
 */
function validateScorecard(input: any): Scorecard {
  const defaults: Scorecard = {
    difficulty: 'medium',
    base_points: 100,
    unit_tests: [],
    bonus_criteria: [],
    bonus_points_per_criterion: 10,
    time_limit_hours: 24,
  };

  if (!input || typeof input !== 'object') {
    return defaults;
  }

  return {
    difficulty: ['easy', 'medium', 'hard', 'expert'].includes(input.difficulty)
      ? input.difficulty
      : defaults.difficulty,
    base_points: typeof input.base_points === 'number' ? input.base_points : defaults.base_points,
    unit_tests: Array.isArray(input.unit_tests) ? input.unit_tests : defaults.unit_tests,
    bonus_criteria: Array.isArray(input.bonus_criteria) ? input.bonus_criteria : defaults.bonus_criteria,
    bonus_points_per_criterion: typeof input.bonus_points_per_criterion === 'number'
      ? input.bonus_points_per_criterion
      : defaults.bonus_points_per_criterion,
    time_limit_hours: typeof input.time_limit_hours === 'number'
      ? input.time_limit_hours
      : defaults.time_limit_hours,
    required_language: input.required_language,
  };
}
