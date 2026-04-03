/**
 * Enqueue git worker jobs (clone → agent commit → PR → judge → comment → cleanup).
 */

import { FastifyInstance } from "fastify";
import { query, queryOne } from "../db/client";
import { requireAuth } from "../middleware/auth";
import { getGitHubLinkForRepo, getGitHubTokenForUser } from "../services/github-integration";

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
      };
      const { issue_id, agent_ens, base_branch } = body;
      if (!issue_id || !agent_ens) {
        return reply.status(400).send({ error: "issue_id and agent_ens required" });
      }

      const link = await getGitHubLinkForRepo(repoId);
      const tok = await getGitHubTokenForUser(req.user!.userId);
      if (!link || !tok) {
        return reply
          .status(400)
          .send({
            error:
              "Set repository GitHub remote (PATCH /repositories/:id/github) and user PAT (PATCH /auth/github-api-key)",
          });
      }

      const agent = await queryOne<{ id: string }>(
        "SELECT id FROM agents WHERE lower(ens_name) = lower($1)",
        [agent_ens],
      );
      if (!agent) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const issue = await queryOne<{ id: string; repo_id: string }>(
        "SELECT id, repo_id FROM issues WHERE id = $1",
        [issue_id],
      );
      if (!issue || issue.repo_id !== repoId) {
        return reply.status(404).send({ error: "Issue not found in this repository" });
      }

      const [job] = await query<{ id: string }>(
        `INSERT INTO git_jobs (issue_id, repo_id, user_id, agent_id, base_branch, status, payload)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb) RETURNING id`,
        [
          issue_id,
          repoId,
          req.user!.userId,
          agent.id,
          base_branch ?? link.default_branch ?? "main",
          JSON.stringify({}),
        ],
      );

      await query(`UPDATE issues SET git_job_id = $1 WHERE id = $2`, [job.id, issue_id]);

      return reply.status(201).send({ id: job.id, status: "pending" });
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
}
