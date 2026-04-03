import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { query } from '../db/client';
import { requireAuth } from '../middleware/auth';

export async function branchRoutes(app: FastifyInstance) {
  // Create branch
  app.post('/:repoId/branches', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId } = req.params as any;
    const { name, base_branch, creator_ens } = req.body as any;
    if (!name || !base_branch || !creator_ens)
      return reply.status(400).send({ error: 'name, base_branch, and creator_ens are required' });
    try {
      const branch = await sdk.createBranch(repoId, name, base_branch, creator_ens);
      return reply.status(201).send(branch);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // List branches for a repo
  app.get('/:repoId/branches', async (req, reply) => {
    const { repoId } = req.params as any;
    const branches = await query(
      `SELECT b.*, a.ens_name as created_by_ens,
              (SELECT COUNT(*) FROM commits WHERE branch_id = b.id) as commit_count
       FROM branches b
       JOIN agents a ON b.created_by = a.id
       WHERE b.repo_id = $1
       ORDER BY b.created_at ASC`,
      [repoId]
    );
    return branches;
  });
}
