/**
 * GitHub API helpers (repos list). Auth: users.github_api_key via PATCH /auth/github-api-key.
 */

import { FastifyInstance } from "fastify";
import { requireAuth } from "../middleware/auth";
import { getGitHubTokenForUser } from "../services/github-integration";

export async function githubIntegrationRoutes(app: FastifyInstance) {
  app.get(
    "/github/repos",
    { preHandler: requireAuth },
    async (req, reply) => {
      const accessToken = await getGitHubTokenForUser(req.user!.userId);
      if (!accessToken) {
        return reply.status(400).send({
          error: "Set a GitHub API key with PATCH /auth/github-api-key",
        });
      }
      const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) {
        return reply.status(502).send({ error: "GitHub API error", status: res.status });
      }
      const data = (await res.json()) as Array<{ full_name: string; default_branch: string; private: boolean }>;
      return data.map((r) => ({
        full_name: r.full_name,
        default_branch: r.default_branch,
        private: r.private,
      }));
    },
  );
}
