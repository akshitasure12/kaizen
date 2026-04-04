/**
 * Enqueue git worker jobs (clone → agent commit → PR → judge → comment → cleanup).
 */

import { FastifyInstance } from "fastify";
import { query, queryOne } from "../db/client";
import { env } from "../env";
import { requireAuth } from "../middleware/auth";
import { enqueueGitJob } from "../services/git-job-enqueue";
import { getGitHubLinkForRepo } from "../services/github-integration";
import * as sdk from "../sdk";

function hasInternalAccess(headerValue: string | string[] | undefined): boolean {
  if (!env.INTERNAL_SERVICE_SECRET) return false;
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return value === env.INTERNAL_SERVICE_SECRET;
}

function requireInternal(req: { headers: Record<string, unknown> }): boolean {
  return hasInternalAccess(req.headers["x-internal-service-secret"] as string | string[] | undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function gitJobRoutes(app: FastifyInstance) {
  app.post(
    "/repositories/:repoId/git-jobs",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { repoId } = req.params as { repoId: string };
      const body = req.body as {
        issue_id?: string;
        agent_ens?: string;
        base_branch?: string;
        idempotency_key?: string;
        max_attempts?: number;
        fanout_children?: boolean;
      };
      const { issue_id, agent_ens, base_branch, idempotency_key, max_attempts, fanout_children } = body;
      if (!issue_id) {
        return reply.status(400).send({ error: "issue_id required" });
      }

      if (idempotency_key) {
        const existing = await queryOne<{ id: string; status: string }>(
          `SELECT id, status
           FROM git_jobs
           WHERE idempotency_key = $1
           LIMIT 1`,
          [idempotency_key],
        );
        if (existing) {
          return reply.status(200).send({ id: existing.id, status: existing.status, deduped: true });
        }
      }

      const link = await getGitHubLinkForRepo(repoId);
      if (!link) {
        return reply
          .status(400)
          .send({
            error: "Repository is not linked to a GitHub App installation. Use POST /integrations/github/link first.",
          });
      }

      const issue = await queryOne<{ id: string; repo_id: string }>(
        "SELECT id, repo_id FROM issues WHERE id = $1",
        [issue_id],
      );
      if (!issue || issue.repo_id !== repoId) {
        return reply.status(404).send({ error: "Issue not found in this repository" });
      }

      const children = await query<{ id: string; assigned_agent_id: string | null }>(
        `SELECT id, assigned_agent_id
         FROM issues
         WHERE parent_issue_id = $1
         ORDER BY created_at ASC`,
        [issue_id],
      );

      const shouldFanout = children.length > 0 && fanout_children !== false;

      const resolvedAgent = agent_ens
        ? await queryOne<{ id: string; ens_name: string }>(
            "SELECT id, ens_name FROM agents WHERE lower(ens_name) = lower($1)",
            [agent_ens],
          )
        : null;

      if (!shouldFanout && !resolvedAgent) {
        return reply.status(400).send({ error: "agent_ens required for non-fanout job" });
      }
      if (agent_ens && !resolvedAgent) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const createJob = async (targetIssueId: string, targetAgentId: string, dedupeKey: string | null) => {
        return enqueueGitJob({
          issue_id: targetIssueId,
          repo_id: repoId,
          user_id: req.user!.userId,
          agent_id: targetAgentId,
          base_branch: base_branch ?? link.default_branch ?? "main",
          max_attempts: max_attempts && max_attempts > 0 ? Math.floor(max_attempts) : env.WORKER_MAX_ATTEMPTS,
          idempotency_key: dedupeKey,
          payload: {},
        });
      };

      if (shouldFanout) {
        const parentBounty = await queryOne<{ id: string }>(
          `SELECT id
           FROM issue_bounties
           WHERE issue_id = $1 AND status IN ('funded', 'judging')
           LIMIT 1`,
          [issue_id],
        );
        if (parentBounty) {
          return reply.status(400).send({
            error: "Parent issue has direct active bounty; decomposition requires child-only bounty allocation",
          });
        }

        if (!resolvedAgent && children.some((c) => !c.assigned_agent_id)) {
          return reply.status(400).send({
            error: "agent_ens required when one or more child issues are unassigned",
          });
        }

        const jobs: Array<{ child_issue_id: string; id: string; status: string; deduped: boolean }> = [];
        for (const child of children) {
          const childAgentId = child.assigned_agent_id || resolvedAgent!.id;
          const childKey = idempotency_key ? `${idempotency_key}:${child.id}` : null;
          const job = await createJob(child.id, childAgentId, childKey);
          jobs.push({
            child_issue_id: child.id,
            id: job.id,
            status: job.status,
            deduped: job.deduped,
          });
        }

        return reply.status(201).send({
          parent_issue_id: issue_id,
          fanout: true,
          jobs,
        });
      }

      const single = await createJob(issue_id, resolvedAgent!.id, idempotency_key ?? null);
      const code = single.deduped ? 200 : 201;
      return reply.status(code).send({
        id: single.id,
        status: single.status,
        deduped: single.deduped,
      });
    },
  );

  app.get("/git-jobs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await queryOne(
      `SELECT gj.*, i.title as issue_title
       FROM git_jobs gj
       JOIN issues i ON i.id = gj.issue_id
       WHERE gj.id = $1`,
      [id],
    );
    if (!row) return reply.status(404).send({ error: "Job not found" });
    return row;
  });

  app.post("/internal/git-jobs/:id/heartbeat", async (req, reply) => {
    if (!requireInternal(req as { headers: Record<string, unknown> })) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { id } = req.params as { id: string };
    const body = (req.body as { lease_timeout_ms?: number } | undefined) ?? {};
    const timeoutMs =
      body.lease_timeout_ms && body.lease_timeout_ms > 0
        ? Math.floor(body.lease_timeout_ms)
        : env.WORKER_LEASE_TIMEOUT_MS;
    const [row] = await query<{ id: string; lease_expires_at: string }>(
      `UPDATE git_jobs
       SET last_heartbeat_at = NOW(),
           lease_expires_at = NOW() + (($1::bigint || ' milliseconds')::interval),
           updated_at = NOW()
       WHERE id = $2
       RETURNING id, lease_expires_at`,
      [timeoutMs, id],
    );
    if (!row) return reply.status(404).send({ error: "Job not found" });
    return row;
  });

  app.post("/internal/git-jobs/:id/stage", async (req, reply) => {
    if (!requireInternal(req as { headers: Record<string, unknown> })) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { id } = req.params as { id: string };
    const body = req.body as { stage?: string; payload?: unknown };
    if (!body.stage) return reply.status(400).send({ error: "stage is required" });
    const [row] = await query<{ id: string; stage: string }>(
      `UPDATE git_jobs
       SET stage = $1,
           payload = COALESCE(payload, '{}'::jsonb) || COALESCE($2::jsonb, '{}'::jsonb),
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, stage`,
      [body.stage, body.payload ? JSON.stringify(body.payload) : null, id],
    );
    if (!row) return reply.status(404).send({ error: "Job not found" });
    return row;
  });

  app.post("/internal/git-jobs/:id/complete", async (req, reply) => {
    if (!requireInternal(req as { headers: Record<string, unknown> })) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { id } = req.params as { id: string };
    const body = (req.body as { branch_name?: string; github_pr_number?: number } | undefined) ?? {};
    const [row] = await query<{ id: string; status: string; stage: string }>(
      `UPDATE git_jobs
       SET status = 'completed',
           stage = 'completed',
           branch_name = COALESCE($1, branch_name),
           github_pr_number = COALESCE($2, github_pr_number),
           lease_token = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           retry_after = NULL,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = $3
       RETURNING id, status, stage`,
      [body.branch_name ?? null, body.github_pr_number ?? null, id],
    );
    if (!row) return reply.status(404).send({ error: "Job not found" });
    return row;
  });

  app.post("/internal/git-jobs/:id/fail", async (req, reply) => {
    if (!requireInternal(req as { headers: Record<string, unknown> })) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
    const { id } = req.params as { id: string };
    const body =
      (req.body as
        | {
            error_message?: string;
            classification?: string;
            retryable?: boolean;
            retry_after_ms?: number;
          }
        | undefined) ?? {};

    const retryAfterMs =
      body.retry_after_ms && body.retry_after_ms > 0
        ? Math.floor(body.retry_after_ms)
        : env.WORKER_BASE_RETRY_MS;

    const [row] = await query<{ id: string; status: string; stage: string; attempt_count: number; max_attempts: number }>(
      `UPDATE git_jobs
       SET status = CASE
             WHEN COALESCE($1, false) = true AND attempt_count < max_attempts THEN 'pending'
             ELSE 'failed'
           END,
           stage = CASE
             WHEN COALESCE($1, false) = true AND attempt_count < max_attempts THEN 'pending_retry'
             ELSE 'failed'
           END,
           last_error_classification = COALESCE($2, last_error_classification),
           error_message = COALESCE($3, error_message),
           retry_after = CASE
             WHEN COALESCE($1, false) = true AND attempt_count < max_attempts
             THEN NOW() + (($4::bigint || ' milliseconds')::interval)
             ELSE NULL
           END,
           lease_token = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $5
       RETURNING id, status, stage, attempt_count, max_attempts`,
      [body.retryable ?? false, body.classification ?? null, body.error_message ?? null, retryAfterMs, id],
    );
    if (!row) return reply.status(404).send({ error: "Job not found" });
    return row;
  });

  app.post("/internal/git-jobs/:id/memory-commit", async (req, reply) => {
    if (!requireInternal(req as { headers: Record<string, unknown> })) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const { id } = req.params as { id: string };
    const body = (req.body || {}) as {
      branch_name?: string;
      message?: string;
      content?: string;
      skip_semantics?: boolean;
      reasoning_type?: "knowledge" | "hypothesis" | "experiment" | "conclusion" | "trace";
      trace?: unknown;
      knowledge_context?: unknown;
      failure_context?: unknown;
    };

    if (!body.message || !body.content) {
      return reply.status(400).send({ error: "message and content are required" });
    }

    const job = await queryOne<{
      id: string;
      issue_id: string;
      repo_id: string;
      agent_id: string;
      base_branch: string;
      branch_name: string | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT id, issue_id, repo_id, agent_id, base_branch, branch_name, payload
       FROM git_jobs
       WHERE id = $1`,
      [id],
    );
    if (!job) {
      return reply.status(404).send({ error: "Job not found" });
    }

    const agent = await queryOne<{ ens_name: string }>(
      `SELECT ens_name FROM agents WHERE id = $1`,
      [job.agent_id],
    );
    if (!agent) {
      return reply.status(404).send({ error: "Agent not found" });
    }

    if (isRecord(job.payload) && typeof job.payload.memory_commit_id === "string") {
      return {
        commit_id: job.payload.memory_commit_id,
        branch_name:
          typeof job.payload.memory_commit_branch === "string"
            ? job.payload.memory_commit_branch
            : body.branch_name || job.branch_name || null,
        author_ens: agent.ens_name,
        deduped: true,
      };
    }

    const branchName = (body.branch_name || job.branch_name || `agent/${job.issue_id.slice(0, 8)}-memory`).trim();
    if (!branchName) {
      return reply.status(400).send({ error: "Unable to resolve branch name" });
    }

    const branchExists = await queryOne<{ id: string }>(
      `SELECT id FROM branches WHERE repo_id = $1 AND name = $2`,
      [job.repo_id, branchName],
    );
    if (!branchExists) {
      const requestedBase = job.base_branch || "main";
      const baseBranch =
        (await queryOne<{ id: string }>(
          `SELECT id FROM branches WHERE repo_id = $1 AND name = $2`,
          [job.repo_id, requestedBase],
        )) != null
          ? requestedBase
          : "main";

      await sdk.createBranch(job.repo_id, branchName, baseBranch, agent.ens_name);
    }

    const options: sdk.CommitOptions = {
      skipSemantics: body.skip_semantics ?? true,
      reasoningType: body.reasoning_type,
    };

    if (isRecord(body.trace)) {
      options.trace = {
        prompt: typeof body.trace.prompt === "string" ? body.trace.prompt : "",
        context: isRecord(body.trace.context) ? body.trace.context : {},
        tools: Array.isArray(body.trace.tools) ? body.trace.tools as Array<{ name: string; input: any; output: any }> : [],
        result: typeof body.trace.result === "string" ? body.trace.result : "",
      };
    }

    if (isRecord(body.knowledge_context)) {
      options.knowledgeContext = body.knowledge_context as sdk.KnowledgeContext;
    }
    if (isRecord(body.failure_context)) {
      options.failureContext = body.failure_context as sdk.FailureContext;
    }

    const commit = await sdk.commitMemory(
      job.repo_id,
      branchName,
      body.content,
      body.message,
      agent.ens_name,
      options,
    );

    await query(
      `UPDATE git_jobs
       SET payload = COALESCE(payload, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2`,
      [
        JSON.stringify({
          memory_commit_id: commit.id,
          memory_commit_branch: branchName,
          memory_commit_created_at: new Date().toISOString(),
        }),
        id,
      ],
    );

    return {
      commit_id: commit.id,
      branch_name: branchName,
      author_ens: agent.ens_name,
    };
  });
}
