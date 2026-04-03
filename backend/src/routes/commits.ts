/**
 * Commit Routes (v5)
 * 
 * Includes semantic search, reasoning graph, replay trace,
 * knowledge context handoff, failure memory search, and
 * workflow run endpoints for multi-agent collaboration.
 */

import { FastifyInstance } from 'fastify';
import * as sdk from '../sdk';
import { CommitOptions } from '../sdk';
import { runCommitHooks, getWorkflowRuns, getWorkflowRunForCommit } from '../services/hooks';
import { requireAuth } from '../middleware/auth';

export async function commitRoutes(app: FastifyInstance) {
  /**
   * Commit memory (v5 - with semantic features + knowledge context + failure memory)
   */
  app.post('/:repoId/commits', { preHandler: requireAuth }, async (req, reply) => {
    const { repoId } = req.params as any;
    const {
      branch,
      content,
      message,
      author_ens,
      content_type,
      reasoning_type,
      trace,
      skip_semantics,
      knowledge_context,
      failure_context,
    } = req.body as any;

    if (!branch || !content || !message || !author_ens) {
      return reply.status(400).send({
        error: 'branch, content, message, and author_ens are required',
      });
    }

    // Build commit options
    const options: CommitOptions = {
      contentType: content_type ?? 'text',
      reasoningType: reasoning_type,
      skipSemantics: skip_semantics ?? false,
    };

    // Parse trace data if provided
    if (trace) {
      options.trace = {
        prompt: trace.prompt || '',
        context: trace.context || {},
        tools: trace.tools || [],
        result: trace.result || '',
      };
    }

    // Parse knowledge context if provided
    if (knowledge_context) {
      options.knowledgeContext = {
        decisions: knowledge_context.decisions || [],
        architecture: knowledge_context.architecture || undefined,
        libraries: knowledge_context.libraries || [],
        open_questions: knowledge_context.open_questions || [],
        next_steps: knowledge_context.next_steps || [],
        dependencies: knowledge_context.dependencies || [],
        handoff_summary: knowledge_context.handoff_summary || undefined,
      };
    }

    // Parse failure context if provided (v5)
    if (failure_context) {
      options.failureContext = {
        failed: failure_context.failed ?? true,
        error_type: failure_context.error_type || undefined,
        error_detail: failure_context.error_detail || undefined,
        failed_approach: failure_context.failed_approach || undefined,
        root_cause: failure_context.root_cause || undefined,
        severity: failure_context.severity || undefined,
      };
    }

    try {
      const commit = await sdk.commitMemory(repoId, branch, content, message, author_ens, options);

      // Fire-and-forget: run async workflow hooks (never blocks the response)
      runCommitHooks({
        repoId,
        commitId: commit.id,
        content,
        message,
        knowledgeContext: knowledge_context || null,
      }).catch(() => {}); // swallow — hooks never break commit flow

      return reply.status(201).send(commit);
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Read memory (permission-filtered)
   */
  app.get('/:repoId/commits', async (req, reply) => {
    const { repoId } = req.params as any;
    const { agent_ens, branch } = req.query as any;

    if (!agent_ens) {
      return reply.status(400).send({ error: 'agent_ens query param is required' });
    }

    try {
      const commits = await sdk.readMemory(repoId, agent_ens, branch);
      return commits;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Semantic search commits
   */
  app.get('/:repoId/commits/search', async (req, reply) => {
    const { repoId } = req.params as any;
    const { q, limit } = req.query as any;

    if (!q) {
      return reply.status(400).send({ error: 'q query param is required' });
    }

    try {
      const results = await sdk.searchCommits(repoId, q, parseInt(limit) || 10);
      return results;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Get reasoning graph for repository
   */
  app.get('/:repoId/commits/graph', async (req, reply) => {
    const { repoId } = req.params as any;
    const { root } = req.query as any;

    try {
      const graph = await sdk.getCommitGraph(repoId, root);
      return graph;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Get single commit with replay trace
   */
  app.get('/:repoId/commits/:commitId', async (req, reply) => {
    const { commitId } = req.params as any;

    try {
      const result = await sdk.getCommitReplay(commitId);
      return result;
    } catch (e: any) {
      if (e.message.includes('not found')) {
        return reply.status(404).send({ error: e.message });
      }
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Get replay trace for a commit
   */
  app.get('/:repoId/commits/:commitId/replay', async (req, reply) => {
    const { commitId } = req.params as any;

    try {
      const result = await sdk.getCommitReplay(commitId);
      return {
        commit_id: result.commit.id,
        message: result.commit.message,
        reasoning_type: result.commit.reasoning_type,
        trace: result.trace,
        reasoning_chain: result.reasoningChain.map(c => ({
          id: c.id,
          message: c.message,
          reasoning_type: c.reasoning_type,
          author_ens: c.author_ens,
          created_at: c.created_at,
        })),
      };
    } catch (e: any) {
      if (e.message.includes('not found')) {
        return reply.status(404).send({ error: e.message });
      }
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Get context chain for a repository (v3)
   * Shows all commits grouped by agent handoffs — how agents build on each other's work.
   */
  app.get('/:repoId/context-chain', async (req, reply) => {
    const { repoId } = req.params as any;
    const { branch } = req.query as any;

    try {
      const chain = await sdk.getContextChain(repoId, branch);
      return chain;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // ─── Failure Memory (v5) ────────────────────────────────────────────────────

  /**
   * Search commits tagged as failures.
   * Helps agents learn from past failed approaches.
   */
  app.get('/:repoId/commits/failures', async (req, reply) => {
    const { repoId } = req.params as any;
    const { error_type, severity, limit } = req.query as any;

    try {
      const failures = await sdk.searchFailures(repoId, {
        errorType: error_type,
        severity,
        limit: parseInt(limit) || 20,
      });
      return failures;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  // ─── Workflow Runs (v5) ─────────────────────────────────────────────────────

  /**
   * Get workflow runs for a repository.
   * Returns hook check results (security scan, content quality, etc.)
   */
  app.get('/:repoId/workflow-runs', async (req, reply) => {
    const { repoId } = req.params as any;
    const { limit } = req.query as any;

    try {
      const runs = await getWorkflowRuns(repoId, parseInt(limit) || 50);
      return runs;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });

  /**
   * Get workflow run for a specific commit.
   */
  app.get('/:repoId/commits/:commitId/workflow', async (req, reply) => {
    const { commitId } = req.params as any;

    try {
      const run = await getWorkflowRunForCommit(commitId);
      if (!run) {
        return reply.status(404).send({ error: 'No workflow run found for this commit' });
      }
      return run;
    } catch (e: any) {
      return reply.status(400).send({ error: e.message });
    }
  });
}
