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
import { rankAgentsForIssue } from '../services/agent-assignment';
import { enqueueGitJob } from '../services/git-job-enqueue';
import { getGitHubLinkForRepo } from '../services/github-integration';
import { buildResolvePlan, PlannedChildWork } from '../services/resolve-orchestration';

interface Issue {
  id: string;
  repo_id: string;
  title: string;
  body: string;
  status: 'open' | 'in_progress' | 'closed' | 'cancelled';
  scorecard: Scorecard;
  assigned_agent_id: string | null;
  parent_issue_id?: string | null;
  root_issue_id?: string | null;
  created_by: string;
  closed_at: string | null;
  created_at: string;
}

interface ResolvedAgent {
  id: string;
  ens_name: string;
}

interface IssueWithAssignedEns extends Issue {
  assigned_agent_ens: string | null;
}

interface ChildIssueRow {
  id: string;
  title: string;
  body: string;
  status: Issue['status'];
  scorecard: Scorecard;
  assigned_agent_id: string | null;
  assigned_agent_ens: string | null;
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

  app.get('/:repoId/issues/:issueId/children', async (req, reply) => {
    const { repoId, issueId } = req.params as any;

    const parent = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId],
    );
    if (!parent) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    const children = await query<Issue>(
      `SELECT * FROM issues
       WHERE parent_issue_id = $1
       ORDER BY created_at ASC`,
      [issueId],
    );

    const counts = {
      total: children.length,
      open: children.filter((c) => c.status === 'open').length,
      in_progress: children.filter((c) => c.status === 'in_progress').length,
      closed: children.filter((c) => c.status === 'closed').length,
      cancelled: children.filter((c) => c.status === 'cancelled').length,
    };

    return {
      parent_issue_id: issueId,
      parent_status: parent.status,
      counts,
      children,
    };
  });

  app.post('/:repoId/issues/:issueId/decompose', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const body = (req.body || {}) as {
      children?: Array<{
        title: string;
        body?: string;
        scorecard?: unknown;
        estimated_effort?: number;
        agent_ens?: string;
        bounty_amount?: number;
      }>;
      allocation_strategy?: 'effort' | 'equal';
      total_bounty_amount?: number;
      poster_agent_ens?: string;
      deadline_hours?: number;
      max_submissions?: number;
    };

    const parent = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId],
    );
    if (!parent) {
      return reply.status(404).send({ error: 'Issue not found' });
    }
    if (parent.status === 'closed' || parent.status === 'cancelled') {
      return reply.status(400).send({ error: 'Cannot decompose a closed/cancelled issue' });
    }
    if (parent.parent_issue_id) {
      return reply.status(400).send({ error: 'Only top-level parent issues can be decomposed' });
    }

    const existingChildren = await queryOne<{ cnt: string }>(
      'SELECT COUNT(*)::text as cnt FROM issues WHERE parent_issue_id = $1',
      [issueId],
    );
    if (Number(existingChildren?.cnt || '0') > 0) {
      return reply.status(409).send({ error: 'Issue already has child issues' });
    }

    const parentBounty = await bountyService.getIssueBounty(issueId);
    if (parentBounty && ['funded', 'judging'].includes(parentBounty.status)) {
      return reply.status(400).send({ error: 'Parent issue cannot keep direct active bounty when decomposed' });
    }

    const childSpecs = Array.isArray(body.children) ? body.children : [];
    if (childSpecs.length < 2) {
      return reply.status(400).send({ error: 'Provide at least two child issues for decomposition' });
    }
    if (childSpecs.some((c) => !c.title || !c.title.trim())) {
      return reply.status(400).send({ error: 'Each child issue requires a title' });
    }

    const totalBounty = Number(body.total_bounty_amount || 0);
    const hasPerChildBounty = childSpecs.some((c) => Number(c.bounty_amount || 0) > 0);
    if (totalBounty > 0 && hasPerChildBounty) {
      return reply.status(400).send({
        error: 'Use either total_bounty_amount or per-child bounty_amount values, not both',
      });
    }

    const willCreateBounties = totalBounty > 0 || hasPerChildBounty;

    let posterAgentId: string | null = null;
    if (willCreateBounties) {
      if (!body.poster_agent_ens) {
        return reply.status(400).send({ error: 'poster_agent_ens is required when bounty allocation is requested' });
      }
      const poster = await sdk.getAgent(body.poster_agent_ens);
      if (!poster) {
        return reply.status(404).send({ error: 'Poster agent not found' });
      }
      posterAgentId = poster.id;
    }

    const strategy = body.allocation_strategy === 'equal' ? 'equal' : 'effort';
    const bountyAllocations = totalBounty > 0
      ? allocateChildBounties(totalBounty, childSpecs, strategy)
      : childSpecs.map((c) => Math.max(0, Number(c.bounty_amount || 0)));

    const requestedTotalBounty = bountyAllocations.reduce((acc, amount) => acc + amount, 0);
    if (willCreateBounties && requestedTotalBounty <= 0) {
      return reply.status(400).send({ error: 'Bounty allocation must be greater than zero' });
    }

    const childAgentByEns = new Map<string, { id: string; ens_name: string }>();
    const requestedChildAgents = Array.from(
      new Set(
        childSpecs
          .map((c) => (typeof c.agent_ens === 'string' ? c.agent_ens.trim() : ''))
          .filter((ens) => ens.length > 0),
      ),
    );
    for (const childEns of requestedChildAgents) {
      const childAgent = await sdk.getAgent(childEns);
      if (!childAgent) {
        return reply.status(404).send({ error: `Child agent not found: ${childEns}` });
      }
      childAgentByEns.set(childAgent.ens_name.toLowerCase(), childAgent);
    }

    if (willCreateBounties && posterAgentId) {
      const balance = await bountyService.getWalletBalance(posterAgentId);
      if (balance < requestedTotalBounty) {
        return reply.status(400).send({
          error: `Insufficient wallet balance: have ${balance}, need ${requestedTotalBounty}`,
        });
      }

      const cap = await bountyService.getSpendingCap(posterAgentId);
      if (cap !== null) {
        const spent = await bountyService.getTotalBountySpend(posterAgentId);
        if (spent + requestedTotalBounty > cap) {
          return reply.status(400).send({
            error: `Bounty would exceed spending cap: spent ${spent}, cap ${cap}, requested ${requestedTotalBounty}`,
          });
        }
      }
    }

    const deadlineHours = body.deadline_hours && body.deadline_hours > 0 ? body.deadline_hours : 24;
    const maxSubmissions = body.max_submissions && body.max_submissions > 0 ? body.max_submissions : 5;
    const deadline = new Date(Date.now() + deadlineHours * 60 * 60 * 1000);

    const createdChildren: Array<{
      issue: Issue;
      assigned_agent_ens: string | null;
      bounty_amount: number;
    }> = [];
    const createdChildIssueIds: string[] = [];
    const createdBountyIds: string[] = [];
    try {
      for (let i = 0; i < childSpecs.length; i += 1) {
        const spec = childSpecs[i]!;
        const [child] = await query<Issue>(
          `INSERT INTO issues (repo_id, title, body, scorecard, created_by, parent_issue_id, root_issue_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            repoId,
            spec.title.trim(),
            spec.body || '',
            validateScorecard(spec.scorecard),
            req.user!.userId,
            issueId,
            parent.root_issue_id || parent.id,
          ],
        );
        createdChildIssueIds.push(child.id);

        let assignedEns: string | null = null;
        const childAgentEns = typeof spec.agent_ens === 'string' ? spec.agent_ens.trim().toLowerCase() : '';
        if (childAgentEns) {
          const childAgent = childAgentByEns.get(childAgentEns)!;
          await query(
            `UPDATE issues
             SET assigned_agent_id = $1, status = 'in_progress'
             WHERE id = $2`,
            [childAgent.id, child.id],
          );
          child.assigned_agent_id = childAgent.id;
          child.status = 'in_progress';
          assignedEns = childAgent.ens_name;
        }

        const allocation = Math.max(0, bountyAllocations[i] || 0);
        if (allocation > 0 && posterAgentId) {
          const bounty = await bountyService.postIssueBounty(
            child.id,
            posterAgentId,
            allocation,
            deadline,
            maxSubmissions,
          );
          createdBountyIds.push(bounty.id);
        }

        createdChildren.push({
          issue: child,
          assigned_agent_ens: assignedEns,
          bounty_amount: allocation,
        });
      }
    } catch (err) {
      for (const bountyId of createdBountyIds) {
        try {
          await bountyService.refundIssueBounty(bountyId);
        } catch (refundErr) {
          req.log.error({ err: refundErr, bountyId }, 'Failed to rollback child bounty during decomposition');
        }
      }

      if (createdChildIssueIds.length > 0) {
        await query(
          'DELETE FROM issues WHERE id = ANY($1::uuid[])',
          [createdChildIssueIds],
        );
      }
      throw err;
    }

    await query(
      `UPDATE issues
       SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
       WHERE id = $1`,
      [issueId],
    );

    return reply.status(201).send({
      parent_issue_id: issueId,
      strategy: totalBounty > 0 ? strategy : 'manual_or_zero',
      total_bounty_amount: totalBounty > 0 ? totalBounty : bountyAllocations.reduce((a, b) => a + b, 0),
      children: createdChildren,
    });
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

    if (status !== undefined) {
      await rollupParentIssueStatus(issueId);
    }

    return updated;
  });

  /**
   * Assign agent to issue
   */
  app.post('/:repoId/issues/:issueId/assign', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const { agent_ens } = req.body as any;

    const issueForAssignment = await queryOne<Issue>(
      'SELECT * FROM issues WHERE id = $1 AND repo_id = $2',
      [issueId, repoId],
    );
    if (!issueForAssignment) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    let agentId: string | null = null;
    let selectedEns: string | null = null;
    let assignmentMeta: Record<string, unknown> | undefined;

    if (agent_ens) {
      const agent = await sdk.getAgent(agent_ens);
      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' });
      }
      agentId = agent.id;
      selectedEns = agent.ens_name;
    } else {
      const ranked = await rankAgentsForIssue({
        issueTitle: issueForAssignment.title,
        issueBody: issueForAssignment.body || '',
        limit: 3,
      });
      const winner = ranked[0];
      if (!winner) {
        return reply.status(400).send({ error: 'No agents available for assignment' });
      }
      agentId = winner.id;
      selectedEns = winner.ens_name;
      assignmentMeta = {
        strategy: 'auto_ranked',
        winner_score: winner.assignment_score,
        top_candidates: ranked,
      };
    }

    const [issue] = await query<Issue>(
      `UPDATE issues SET assigned_agent_id = $1, status = 'in_progress'
       WHERE id = $2 AND repo_id = $3
       RETURNING *`,
      [agentId, issueId, repoId]
    );

    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    return {
      ...issue,
      assigned_agent_ens: selectedEns,
      assignment: assignmentMeta ?? { strategy: 'manual' },
    };
  });

  app.get('/:repoId/issues/:issueId/assignment-suggestions', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const issue = await queryOne<Issue>('SELECT * FROM issues WHERE id = $1 AND repo_id = $2', [issueId, repoId]);
    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }

    const suggestions = await rankAgentsForIssue({
      issueTitle: issue.title,
      issueBody: issue.body || '',
      limit: 5,
    });
    return { issue_id: issue.id, suggestions };
  });

  app.post('/:repoId/issues/:issueId/resolve', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId, issueId } = req.params as any;
    const body = (req.body || {}) as {
      mode?: 'plan_only' | 'execute';
      agent_ens?: string;
      base_branch?: string;
      fanout_children?: boolean;
      idempotency_key?: string;
      max_attempts?: number;
      decomposition?: {
        children?: Array<{
          title?: string;
          body?: string;
          scorecard?: unknown;
          estimated_effort?: number;
          agent_ens?: string;
        }>;
      };
    };

    const mode = body.mode === 'plan_only' ? 'plan_only' : 'execute';

    const issue = await queryOne<IssueWithAssignedEns>(
      `SELECT i.*, a.ens_name as assigned_agent_ens
       FROM issues i
       LEFT JOIN agents a ON i.assigned_agent_id = a.id
       WHERE i.id = $1 AND i.repo_id = $2`,
      [issueId, repoId],
    );
    if (!issue) {
      return reply.status(404).send({ error: 'Issue not found' });
    }
    if (issue.status === 'closed' || issue.status === 'cancelled') {
      return reply.status(400).send({ error: 'Cannot resolve a closed/cancelled issue' });
    }

    const requestedChildren = normalizeRequestedChildren(
      body.decomposition?.children,
      validateScorecard(issue.scorecard),
    );
    if (Array.isArray(body.decomposition?.children) && body.decomposition.children.length === 1) {
      return reply.status(400).send({ error: 'Provide at least two child specs for decomposition' });
    }

    const children = await query<ChildIssueRow>(
      `SELECT c.id,
              c.title,
              c.body,
              c.status,
              c.scorecard,
              c.assigned_agent_id,
              a.ens_name as assigned_agent_ens
       FROM issues c
       LEFT JOIN agents a ON c.assigned_agent_id = a.id
       WHERE c.parent_issue_id = $1
       ORDER BY c.created_at ASC`,
      [issueId],
    );

    const agentCache = new Map<string, ResolvedAgent>();
    let selectedAgent: ResolvedAgent | null = null;

    if (body.agent_ens && body.agent_ens.trim().length > 0) {
      selectedAgent = await resolveAgentByEns(body.agent_ens.trim(), agentCache);
      if (!selectedAgent) {
        return reply.status(404).send({ error: `Agent not found: ${body.agent_ens}` });
      }
    } else if (issue.assigned_agent_id && issue.assigned_agent_ens) {
      selectedAgent = {
        id: issue.assigned_agent_id,
        ens_name: issue.assigned_agent_ens,
      };
      agentCache.set(issue.assigned_agent_ens.toLowerCase(), selectedAgent);
    } else {
      selectedAgent = await pickTopAgentForIssue(issue.title, issue.body || '');
      if (selectedAgent) {
        agentCache.set(selectedAgent.ens_name.toLowerCase(), selectedAgent);
      }
    }

    const plan = buildResolvePlan(
      {
        title: issue.title,
        body: issue.body || '',
        scorecard: validateScorecard(issue.scorecard),
        existing_child_count: children.length,
      },
      {
        requested_children: requestedChildren,
        fanout_children: body.fanout_children,
      },
    );
    const resolvedPlan = {
      ...plan,
      suggested_agent_ens: selectedAgent?.ens_name || null,
    };

    if (mode === 'plan_only') {
      return {
        mode,
        issue_id: issue.id,
        plan: resolvedPlan,
      };
    }

    const link = await getGitHubLinkForRepo(repoId);
    if (!link) {
      return reply.status(400).send({
        error: 'Repository is not linked to a GitHub App installation. Use POST /integrations/github/link first.',
      });
    }

    const baseBranch = body.base_branch?.trim() || link.default_branch || 'main';
    const maxAttempts = body.max_attempts && body.max_attempts > 0 ? body.max_attempts : undefined;

    if (resolvedPlan.path === 'single_agent') {
      if (!selectedAgent) {
        return reply.status(400).send({ error: 'No available agent found for assignment' });
      }

      await assignIssueToAgent(issue.id, selectedAgent.id);
      const job = await enqueueGitJob({
        issue_id: issue.id,
        repo_id: repoId,
        user_id: req.user!.userId,
        agent_id: selectedAgent.id,
        base_branch: baseBranch,
        max_attempts: maxAttempts,
        idempotency_key: body.idempotency_key ?? null,
        payload: {
          orchestration: {
            mode: 'single_agent',
            plan_complexity_score: resolvedPlan.complexity_score,
          },
        },
      });

      return reply.status(job.deduped ? 200 : 201).send({
        mode,
        issue_id: issue.id,
        plan: resolvedPlan,
        jobs: [
          {
            issue_id: issue.id,
            job_id: job.id,
            status: job.status,
            deduped: job.deduped,
            agent_ens: selectedAgent.ens_name,
          },
        ],
      });
    }

    if (resolvedPlan.path === 'reuse_children') {
      const jobs: Array<{ issue_id: string; job_id: string; status: string; deduped: boolean; agent_ens: string }> = [];

      for (const child of children) {
        const assigned = await pickAgentForChildIssue(child, selectedAgent, agentCache);
        if (!assigned) {
          return reply.status(400).send({
            error: `No available agent found for child issue ${child.id}`,
          });
        }

        await assignIssueToAgent(child.id, assigned.id);
        const childKey = body.idempotency_key ? `${body.idempotency_key}:${child.id}` : null;
        const job = await enqueueGitJob({
          issue_id: child.id,
          repo_id: repoId,
          user_id: req.user!.userId,
          agent_id: assigned.id,
          base_branch: baseBranch,
          max_attempts: maxAttempts,
          idempotency_key: childKey,
          payload: {
            orchestration: {
              mode: 'reuse_children',
              parent_issue_id: issue.id,
              plan_complexity_score: resolvedPlan.complexity_score,
            },
          },
        });

        jobs.push({
          issue_id: child.id,
          job_id: job.id,
          status: job.status,
          deduped: job.deduped,
          agent_ens: assigned.ens_name,
        });
      }

      await query(
        `UPDATE issues
         SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
         WHERE id = $1`,
        [issue.id],
      );

      return reply.status(201).send({
        mode,
        issue_id: issue.id,
        plan: resolvedPlan,
        jobs,
      });
    }

    const createdChildren: Array<{
      issue_id: string;
      title: string;
      agent_ens: string;
      job_id: string | null;
      deduped: boolean;
      status: string | null;
    }> = [];

    for (let i = 0; i < resolvedPlan.children.length; i += 1) {
      const childPlan = resolvedPlan.children[i]!;
      const [created] = await query<Issue>(
        `INSERT INTO issues (repo_id, title, body, scorecard, created_by, parent_issue_id, root_issue_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          repoId,
          childPlan.title,
          childPlan.body,
          validateScorecard(childPlan.scorecard),
          req.user!.userId,
          issue.id,
          issue.root_issue_id || issue.id,
        ],
      );

      const assigned = await pickAgentForPlannedChild(childPlan, selectedAgent, agentCache);
      if (!assigned) {
        return reply.status(400).send({
          error: `No available agent found for child issue plan: ${childPlan.title}`,
        });
      }

      await assignIssueToAgent(created.id, assigned.id);

      let jobId: string | null = null;
      let deduped = false;
      let jobStatus: string | null = null;
      if (resolvedPlan.fanout_children) {
        const childKey = body.idempotency_key ? `${body.idempotency_key}:${created.id}` : null;
        const job = await enqueueGitJob({
          issue_id: created.id,
          repo_id: repoId,
          user_id: req.user!.userId,
          agent_id: assigned.id,
          base_branch: baseBranch,
          max_attempts: maxAttempts,
          idempotency_key: childKey,
          payload: {
            orchestration: {
              mode: 'new_children',
              parent_issue_id: issue.id,
              child_index: i,
              plan_complexity_score: resolvedPlan.complexity_score,
            },
          },
        });
        jobId = job.id;
        deduped = job.deduped;
        jobStatus = job.status;
      }

      createdChildren.push({
        issue_id: created.id,
        title: created.title,
        agent_ens: assigned.ens_name,
        job_id: jobId,
        deduped,
        status: jobStatus,
      });
    }

    await query(
      `UPDATE issues
       SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
       WHERE id = $1`,
      [issue.id],
    );

    return reply.status(201).send({
      mode,
      issue_id: issue.id,
      plan: resolvedPlan,
      created_children: createdChildren,
    });
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

    await rollupParentIssueStatus(issueId);

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
  app.post('/:repoId/issues/:issueId/submit', { preHandler: requireAuth }, async (req, reply) => {
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
    if (!issue.parent_issue_id) {
      const childCount = await queryOne<{ count: string }>(
        'SELECT COUNT(*)::text as count FROM issues WHERE parent_issue_id = $1',
        [issueId],
      );
      if (Number(childCount?.count || '0') > 0) {
        return reply.status(400).send({
          error: 'Parent issue has child issues; post bounties on child issues only',
        });
      }
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
  app.post('/:repoId/issues/:issueId/bounty-submit', { preHandler: requireAuth }, async (req, reply) => {
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

function allocateChildBounties(
  total: number,
  children: Array<{ estimated_effort?: number }>,
  strategy: 'effort' | 'equal',
): number[] {
  const roundedTotal = Math.max(0, Math.round(total * 10000) / 10000);
  if (roundedTotal <= 0 || children.length === 0) return children.map(() => 0);

  const effortWeights = children.map((c) => Math.max(0, Number(c.estimated_effort || 0)));
  const sumEffort = effortWeights.reduce((acc, v) => acc + v, 0);
  const useEffort = strategy === 'effort' && sumEffort > 0;
  const baseWeights = useEffort ? effortWeights : children.map(() => 1);
  const weightSum = baseWeights.reduce((acc, v) => acc + v, 0);

  const allocations = baseWeights.map((w) => Math.round((roundedTotal * (w / weightSum)) * 10000) / 10000);
  const current = allocations.reduce((a, b) => a + b, 0);
  const delta = Math.round((roundedTotal - current) * 10000) / 10000;
  allocations[allocations.length - 1] = Math.max(
    0,
    Math.round((allocations[allocations.length - 1] + delta) * 10000) / 10000,
  );

  return allocations;
}

function normalizeRequestedChildren(
  rawChildren: Array<{
    title?: string;
    body?: string;
    scorecard?: unknown;
    estimated_effort?: number;
    agent_ens?: string;
  }> | undefined,
  fallbackScorecard: Scorecard,
): PlannedChildWork[] {
  if (!Array.isArray(rawChildren)) return [];

  return rawChildren
    .filter((child) => child && typeof child.title === 'string' && child.title.trim().length > 0)
    .map((child) => ({
      title: child.title!.trim(),
      body: child.body?.trim() || '',
      estimated_effort: Math.max(1, Math.round(Number(child.estimated_effort || 1))),
      scorecard: validateScorecard(child.scorecard ?? fallbackScorecard),
      agent_ens: child.agent_ens?.trim() || undefined,
    }));
}

async function resolveAgentByEns(
  ensName: string,
  cache: Map<string, ResolvedAgent>,
): Promise<ResolvedAgent | null> {
  const key = ensName.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const agent = await sdk.getAgent(ensName);
  if (!agent) return null;
  const resolved: ResolvedAgent = {
    id: agent.id,
    ens_name: agent.ens_name,
  };
  cache.set(key, resolved);
  return resolved;
}

async function pickTopAgentForIssue(issueTitle: string, issueBody: string): Promise<ResolvedAgent | null> {
  const ranked = await rankAgentsForIssue({
    issueTitle,
    issueBody,
    limit: 1,
  });
  if (!ranked[0]) return null;
  return {
    id: ranked[0].id,
    ens_name: ranked[0].ens_name,
  };
}

async function pickAgentForChildIssue(
  child: ChildIssueRow,
  fallback: ResolvedAgent | null,
  cache: Map<string, ResolvedAgent>,
): Promise<ResolvedAgent | null> {
  if (child.assigned_agent_id && child.assigned_agent_ens) {
    const key = child.assigned_agent_ens.toLowerCase();
    const existing: ResolvedAgent = {
      id: child.assigned_agent_id,
      ens_name: child.assigned_agent_ens,
    };
    cache.set(key, existing);
    return existing;
  }

  if (fallback) return fallback;
  return pickTopAgentForIssue(child.title, child.body || '');
}

async function pickAgentForPlannedChild(
  childPlan: PlannedChildWork,
  fallback: ResolvedAgent | null,
  cache: Map<string, ResolvedAgent>,
): Promise<ResolvedAgent | null> {
  if (childPlan.agent_ens) {
    const explicit = await resolveAgentByEns(childPlan.agent_ens, cache);
    if (explicit) return explicit;
  }
  if (fallback) return fallback;
  return pickTopAgentForIssue(childPlan.title, childPlan.body || '');
}

async function assignIssueToAgent(issueId: string, agentId: string): Promise<void> {
  await query(
    `UPDATE issues
     SET assigned_agent_id = $1,
         status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END
     WHERE id = $2`,
    [agentId, issueId],
  );
}

async function rollupParentIssueStatus(issueId: string): Promise<void> {
  let cursorIssueId: string | null = issueId;

  while (cursorIssueId) {
    const relation: { parent_issue_id: string | null } | null = await queryOne<{ parent_issue_id: string | null }>(
      'SELECT parent_issue_id FROM issues WHERE id = $1',
      [cursorIssueId],
    );
    const parentId: string | null = relation?.parent_issue_id ?? null;
    if (!parentId) return;

    const parent = await queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM issues WHERE id = $1',
      [parentId],
    );
    if (!parent) {
      cursorIssueId = parentId;
      continue;
    }

    const children = await query<{ status: string }>(
      'SELECT status FROM issues WHERE parent_issue_id = $1',
      [parentId],
    );
    if (children.length === 0) {
      cursorIssueId = parentId;
      continue;
    }

    const allTerminal = children.every((c) => c.status === 'closed' || c.status === 'cancelled');
    const anyStarted = children.some(
      (c) => c.status === 'in_progress' || c.status === 'closed' || c.status === 'cancelled',
    );
    const nextStatus: 'open' | 'in_progress' | 'closed' = allTerminal
      ? 'closed'
      : anyStarted
        ? 'in_progress'
        : 'open';

    if (parent.status !== 'cancelled' && nextStatus !== parent.status) {
      await query(
        `UPDATE issues
         SET status = $1,
             closed_at = CASE WHEN $1 = 'closed' THEN NOW() ELSE NULL END
         WHERE id = $2`,
        [nextStatus, parentId],
      );
    }

    cursorIssueId = parentId;
  }
}
