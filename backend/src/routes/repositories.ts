import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { query, queryOne } from '../db/client';
import { getLedger } from '../services/bounty';
import { deposit } from '../services/bounty';
import { requireAuth } from '../middleware/auth';
import { getGitHubTokenForUser } from '../services/github-integration';

export async function repositoryRoutes(app: FastifyInstance) {
  // Create repository
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const { name, owner_ens, description, repo_type, academia_field } = req.body as Record<string, unknown>;
    if (!name || !owner_ens) return reply.status(400).send({ error: 'name and owner_ens are required' });
    try {
      const repo = await sdk.createRepository(
        String(name),
        String(owner_ens),
        description != null ? String(description) : '',
        'public',
        { repoType: repo_type as 'general' | 'academia' | undefined, academiaField: academia_field as string | undefined }
      );
      return reply.status(201).send(repo);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(400).send({ error: msg });
    }
  });

  // List all repositories (with owner ens + branch count + type filtering)
  app.get('/', async (req, reply) => {
    const { type } = req.query as any;

    let typeFilter = '';
    const params: any[] = [];
    if (type && (type === 'general' || type === 'academia')) {
      params.push(type);
      typeFilter = `WHERE r.repo_type = $1`;
    }

    const repos = await query(
      `SELECT r.*, a.ens_name as owner_ens,
              (SELECT COUNT(*) FROM branches WHERE repo_id = r.id) as branch_count,
              (SELECT COUNT(*) FROM commits WHERE repo_id = r.id) as commit_count
       FROM repositories r
       JOIN agents a ON r.owner_agent_id = a.id
       ${typeFilter}
       ORDER BY r.created_at DESC`,
      params
    );
    return repos;
  });

  /**
   * Attach GitHub remote (owner/repo + default branch) to an internal repository row.
   */
  app.patch('/:id/github', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      github_owner?: string;
      github_repo?: string;
      github_default_branch?: string;
    };
    const { github_owner, github_repo, github_default_branch } = body;
    if (!github_owner?.trim() || !github_repo?.trim()) {
      return reply.status(400).send({ error: 'github_owner and github_repo are required' });
    }

    const token = await getGitHubTokenForUser(req.user!.userId);
    if (!token) {
      return reply.status(400).send({ error: 'Set GitHub API key via PATCH /auth/github-api-key first' });
    }

    const exists = await queryOne<{ id: string }>('SELECT id FROM repositories WHERE id = $1', [id]);
    if (!exists) return reply.status(404).send({ error: 'Repository not found' });

    await query(
      `UPDATE repositories
       SET github_owner = $1,
           github_repo = $2,
           github_default_branch = COALESCE($3, github_default_branch, 'main')
       WHERE id = $4`,
      [
        github_owner.trim().toLowerCase(),
        github_repo.trim().toLowerCase(),
        github_default_branch?.trim() || null,
        id,
      ],
    );

    const row = await queryOne(
      `SELECT r.*, a.ens_name as owner_ens FROM repositories r
       JOIN agents a ON r.owner_agent_id = a.id WHERE r.id = $1`,
      [id],
    );
    return row;
  });

  // Get single repository
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as any;
    const repo = await queryOne(
      `SELECT r.*, a.ens_name as owner_ens FROM repositories r
       JOIN agents a ON r.owner_agent_id = a.id WHERE r.id = $1`,
      [id]
    );
    if (!repo) return reply.status(404).send({ error: 'Repository not found' });
    return repo;
  });

  // Deposit bounty into repo
  app.post('/:id/deposit', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as any;
    const { agent_ens, amount, note } = req.body as any;
    if (!agent_ens || !amount) return reply.status(400).send({ error: 'agent_ens and amount are required' });
    try {
      const agent = await sdk.getAgent(agent_ens);
      if (!agent) return reply.status(404).send({ error: 'Agent not found' });
      const entry = await deposit(id, agent.id, amount, note);
      return reply.status(201).send(entry);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // Get bounty ledger for repo
  app.get('/:id/bounty', async (req, reply) => {
    const { id } = req.params as any;
    const ledger = await getLedger(id);
    return ledger;
  });
}
