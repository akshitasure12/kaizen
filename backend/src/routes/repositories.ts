import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { query, queryOne } from '../db/client';
import { env } from '../env';
import { requireAuth } from '../middleware/auth';
import { getGitHubTokenForUser } from '../services/github-integration';
import { ensureKaizenPullRequestWebhook } from '../services/github-webhook-provision';

export async function repositoryRoutes(app: FastifyInstance) {
  /**
   * Create Kaizen repository row, link GitHub remote, and provision PR webhook (only supported webhook path).
   */
  app.post('/import-from-github', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      owner_ens?: string;
      github_owner?: string;
      github_repo?: string;
      github_default_branch?: string;
      name?: string;
      description?: string;
      repo_type?: 'general' | 'academia';
      academia_field?: string;
    };

    const ownerEns = body.owner_ens?.trim();
    const ghOwner = body.github_owner?.trim().toLowerCase();
    const ghRepo = body.github_repo?.trim().toLowerCase();
    if (!ownerEns || !ghOwner || !ghRepo) {
      return reply.status(400).send({
        error: 'owner_ens, github_owner, and github_repo are required',
        code: 'VALIDATION_ERROR',
      });
    }

    const callbackUrl = env.GITHUB_WEBHOOK_CALLBACK_URL?.trim();
    const secret = env.GITHUB_WEBHOOK_SECRET?.trim();
    if (!callbackUrl) {
      return reply.status(503).send({
        error: 'GITHUB_WEBHOOK_CALLBACK_URL is not configured',
        code: 'WEBHOOK_CALLBACK_URL_MISSING',
        message:
          'Set GITHUB_WEBHOOK_CALLBACK_URL to the full public URL of POST /integrations/github/webhook (e.g. https://api.example.com/integrations/github/webhook).',
      });
    }
    if (!secret) {
      return reply.status(503).send({
        error: 'GITHUB_WEBHOOK_SECRET not configured',
        code: 'WEBHOOK_SECRET_MISSING',
        message: 'Set GITHUB_WEBHOOK_SECRET to the webhook HMAC secret shared with GitHub.',
      });
    }

    const token = await getGitHubTokenForUser(req.user!.userId);
    if (!token) {
      return reply.status(403).send({
        error: 'GitHub token not configured',
        code: 'GITHUB_TOKEN_NOT_CONFIGURED',
        message: 'Set PAT with PATCH /auth/github-api-key before importing.',
      });
    }

    const agentOk = await queryOne<{ id: string }>(
      `SELECT id FROM agents WHERE lower(ens_name) = lower($1) AND user_id = $2`,
      [ownerEns, req.user!.userId],
    );
    if (!agentOk) {
      return reply.status(403).send({
        error: 'Agent not found or not linked to your account',
        code: 'AGENT_NOT_OWNED',
      });
    }

    const dup = await queryOne<{ id: string }>(
      `SELECT id FROM repositories
       WHERE lower(github_owner) = $1 AND lower(github_repo) = $2`,
      [ghOwner, ghRepo],
    );
    if (dup) {
      return reply.status(409).send({
        error: 'This GitHub repository is already imported',
        code: 'GITHUB_REMOTE_ALREADY_IMPORTED',
        repository_id: dup.id,
      });
    }

    const defaultBranch = body.github_default_branch?.trim() || 'main';
    const displayName = (body.name?.trim() || ghRepo) as string;
    const description = body.description != null ? String(body.description) : '';
    const repoType = body.repo_type === 'academia' ? 'academia' : 'general';
    const academiaField = body.academia_field?.trim();

    let createdId: string | null = null;
    try {
      const repo = await sdk.createRepository(
        displayName,
        ownerEns,
        description,
        'public',
        { repoType, academiaField: repoType === 'academia' ? academiaField : undefined },
      );
      createdId = repo.id;

      await query(
        `UPDATE repositories
         SET github_owner = $1,
             github_repo = $2,
             github_default_branch = $3
         WHERE id = $4`,
        [ghOwner, ghRepo, defaultBranch, repo.id],
      );
    } catch (e: unknown) {
      if (createdId) {
        await query('DELETE FROM repositories WHERE id = $1', [createdId]);
      }
      const pgCode =
        typeof e === 'object' && e !== null && 'code' in e
          ? String((e as { code: unknown }).code)
          : '';
      if (pgCode === '23505') {
        return reply.status(409).send({
          error: 'This GitHub repository is already imported',
          code: 'GITHUB_REMOTE_ALREADY_IMPORTED',
        });
      }
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(400).send({ error: msg, code: 'IMPORT_CREATE_FAILED' });
    }

    const result = await ensureKaizenPullRequestWebhook(token, ghOwner, ghRepo, callbackUrl, secret);
    if (!result.ok) {
      await query('DELETE FROM repositories WHERE id = $1', [createdId!]);
      return reply.status(result.status).send({
        error: result.message,
        code: result.code,
        github_status: result.github_status,
        github_message: result.github_message,
      });
    }

    await query(`UPDATE repositories SET github_hook_id = $1 WHERE id = $2`, [result.data.hook_id, createdId!]);

    const row = await queryOne<Record<string, unknown>>(
      `SELECT r.*, a.ens_name as owner_ens FROM repositories r
       JOIN agents a ON r.owner_agent_id = a.id WHERE r.id = $1`,
      [createdId!],
    );
    if (!row) {
      return reply.status(500).send({ error: 'Repository row missing after import', code: 'IMPORT_INCONSISTENT' });
    }

    return reply.status(201).send(
      Object.assign({}, row, {
        webhook: {
          action: result.data.action,
          hook_id: result.data.hook_id,
          callback_url: result.data.callback_url,
        },
      }),
    );
  });

  // Create repository (internal-only; no GitHub link — use import-from-github for GitHub + webhook)
  app.post('/', { preHandler: requireAuth }, async (req, reply) => {
    const { name, owner_ens, description } = req.body as Record<string, unknown>;
    if (!name || !owner_ens) return reply.status(400).send({ error: 'name and owner_ens are required' });
    try {
      const repo = await sdk.createRepository(
        String(name),
        String(owner_ens),
        description != null ? String(description) : ''
      );
      return reply.status(201).send(repo);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(400).send({ error: msg });
    }
  });

  // List all repositories (with owner ens + branch count + type filtering)
  app.get('/', async (req, reply) => {
    const params: any[] = [];
    const typeFilter = '';

    const repos = await query(
      `SELECT r.*, a.ens_name as owner_ens,
              (SELECT COUNT(*) FROM branches WHERE repo_id = r.id) as branch_count,
              (SELECT COUNT(*) FROM commits WHERE repo_id = r.id) as commit_count,
              (SELECT COUNT(*) FROM issues WHERE repo_id = r.id AND status = 'open') as open_issues
       FROM repositories r
       JOIN agents a ON r.owner_agent_id = a.id
       ${typeFilter}
       ORDER BY r.created_at DESC`,
      params
    );
    return repos;
  });

  /**
   * Update default branch only for a repository that was already imported from GitHub.
   */
  app.patch('/:id/github', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      github_owner?: string;
      github_repo?: string;
      github_default_branch?: string;
    };

    if (body.github_owner !== undefined || body.github_repo !== undefined) {
      return reply.status(400).send({
        error: 'Cannot change GitHub remote via PATCH; import is the only supported way to attach a remote and webhook.',
        code: 'GITHUB_REMOTE_IMMUTABLE',
      });
    }

    const br = body.github_default_branch?.trim();
    if (!br) {
      return reply.status(400).send({ error: 'github_default_branch is required' });
    }

    const row = await queryOne<{
      id: string;
      github_owner: string | null;
      github_repo: string | null;
    }>('SELECT id, github_owner, github_repo FROM repositories WHERE id = $1', [id]);
    if (!row) return reply.status(404).send({ error: 'Repository not found' });
    if (!row.github_owner?.trim() || !row.github_repo?.trim()) {
      return reply.status(400).send({
        error: 'Repository has no GitHub link',
        code: 'GITHUB_LINK_REQUIRED',
      });
    }

    await query(`UPDATE repositories SET github_default_branch = $1 WHERE id = $2`, [br, id]);

    const out = await queryOne(
      `SELECT r.*, a.ens_name as owner_ens FROM repositories r
       JOIN agents a ON r.owner_agent_id = a.id WHERE r.id = $1`,
      [id],
    );
    return out;
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

}
