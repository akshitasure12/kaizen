import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { query } from '../db/client';
import { requireAuth } from '../middleware/auth';

export async function pullRequestRoutes(app: FastifyInstance) {
  // Open pull request
  app.post('/:repoId/pulls', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId } = req.params as any;
    const { source_branch, target_branch, description, author_ens, bounty_amount } = req.body as any;
    if (!source_branch || !target_branch || !author_ens)
      return reply.status(400).send({ error: 'source_branch, target_branch, and author_ens are required' });
    if (Number(bounty_amount ?? 0) > 0) {
      return reply.status(400).send({
        error: 'Repository-level PR bounty_amount is no longer supported. Use issue bounty endpoints instead.',
      });
    }

    try {
      const pr = await sdk.openPullRequest(
        repoId, source_branch, target_branch, description ?? '', author_ens
      );
      return reply.status(201).send(pr);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // List PRs for a repo
  app.get('/:repoId/pulls', async (req, reply) => {
    const { repoId } = req.params as any;
    const { status } = req.query as any;
    const params: any[] = [repoId];
    let statusFilter = '';
    if (status) {
      params.push(status);
      statusFilter = `AND pr.status = $${params.length}`;
    }
    const prs = await query(
      `SELECT pr.*,
              a.ens_name as author_ens,
              r.ens_name as reviewer_ens,
              sb.name as source_branch_name,
              tb.name as target_branch_name
       FROM pull_requests pr
       JOIN agents a ON pr.author_agent_id = a.id
       LEFT JOIN agents r ON pr.reviewer_agent_id = r.id
       JOIN branches sb ON pr.source_branch_id = sb.id
       JOIN branches tb ON pr.target_branch_id = tb.id
       WHERE pr.repo_id = $1 ${statusFilter}
       ORDER BY pr.created_at DESC`,
      params
    );
    return prs;
  });

  // Get single PR
  app.get('/:repoId/pulls/:prId', async (req, reply) => {
    const { repoId, prId } = req.params as any;
    const [pr] = await query(
      `SELECT pr.*,
              a.ens_name as author_ens,
              r.ens_name as reviewer_ens,
              sb.name as source_branch_name,
              tb.name as target_branch_name
       FROM pull_requests pr
       JOIN agents a ON pr.author_agent_id = a.id
       LEFT JOIN agents r ON pr.reviewer_agent_id = r.id
       JOIN branches sb ON pr.source_branch_id = sb.id
       JOIN branches tb ON pr.target_branch_id = tb.id
       WHERE pr.repo_id = $1 AND pr.id = $2`,
      [repoId, prId]
    );
    if (!pr) return reply.status(404).send({ error: 'Pull request not found' });
    return pr;
  });

  // Merge pull request
  app.post('/:repoId/pulls/:prId/merge', { preHandler: requireAuth }, async (req, reply) => {
    const { prId } = req.params as any;
    const { reviewer_ens } = req.body as any;
    if (!reviewer_ens) return reply.status(400).send({ error: 'reviewer_ens is required' });
    try {
      const merged = await sdk.mergePullRequest(prId, reviewer_ens);
      return merged;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // Reject pull request
  app.post('/:repoId/pulls/:prId/reject', { preHandler: requireAuth }, async (req, reply) => {
    const { prId } = req.params as any;
    const { reviewer_ens } = req.body as any;
    if (!reviewer_ens) return reply.status(400).send({ error: 'reviewer_ens is required' });
    try {
      const reviewer = await sdk.getAgent(reviewer_ens);
      if (!reviewer) return reply.status(404).send({ error: 'Reviewer agent not found' });
      const [pr] = await query(
        `UPDATE pull_requests SET status = 'rejected', reviewer_agent_id = $1 WHERE id = $2 AND status = 'open' RETURNING *`,
        [reviewer.id, prId]
      );
      if (!pr) return reply.status(400).send({ error: 'PR not found or already closed' });
      return pr;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });
}
