import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
  fetchGitHubUserReposPage,
  getGitHubTokenForUser,
} from "../services/github-integration";

const reposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
});

export async function githubIntegrationRoutes(app: FastifyInstance) {
  app.get("/github/repos", { preHandler: requireAuth }, async (req, reply) => {
    const parsed = reposQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid query",
        code: "INVALID_QUERY",
        details: parsed.error.flatten(),
      });
    }
    const { page, per_page } = parsed.data;

    const accessToken = await getGitHubTokenForUser(req.user!.userId);
    if (!accessToken) {
      return reply.status(403).send({
        error: "GitHub token not configured",
        code: "GITHUB_TOKEN_NOT_CONFIGURED",
        message:
          'No personal access token on file for this user. Set one with PATCH /auth/github-api-key (body: { "github_api_key": "..." }) before listing GitHub repositories.',
      });
    }

    const gh = await fetchGitHubUserReposPage(accessToken, { page, per_page });
    if (!gh.ok) {
      if (gh.status === 401) {
        return reply.status(401).send({
          error: "GitHub rejected the token",
          code: "GITHUB_TOKEN_INVALID",
          message:
            gh.githubMessage ??
            "The stored token is invalid or expired. Update it with PATCH /auth/github-api-key.",
        });
      }
      if (gh.status === 403) {
        return reply.status(502).send({
          error: "GitHub API forbidden",
          code: "GITHUB_API_FORBIDDEN",
          message:
            gh.githubMessage ??
            "Insufficient scopes or rate limit; check the token and GitHub status.",
          github_status: gh.status,
        });
      }
      return reply.status(502).send({
        error: "GitHub API error",
        code: "GITHUB_UPSTREAM_ERROR",
        message: gh.githubMessage,
        github_status: gh.status,
      });
    }

    return gh.data;
  });
}
