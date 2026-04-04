import { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../middleware/auth";
import {
  fetchGitHubUserReposPage,
  getGitHubTokenForUser,
  upsertGithubInstallation,
} from "../services/github-integration";

const reposQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(30),
});

export async function githubIntegrationRoutes(app: FastifyInstance) {
  app.post(
    "/github/app/callback",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as {
        installation_id?: number;
        account_login?: string;
        app_id?: number;
        pem_encrypted?: string;
        webhook_secret?: string;
      };

      const installationId = Number(body.installation_id);
      const accountLogin = body.account_login?.trim();
      const appId = Number(body.app_id || process.env.GITHUB_APP_ID || 0);
      const pemEncrypted = body.pem_encrypted?.trim() || "configured-via-env";
      const webhookSecret =
        body.webhook_secret?.trim() || process.env.GITHUB_WEBHOOK_SECRET || "";

      if (!Number.isFinite(installationId) || installationId <= 0) {
        return reply.status(400).send({ error: "installation_id is required" });
      }
      if (!accountLogin) {
        return reply.status(400).send({ error: "account_login is required" });
      }
      if (!Number.isFinite(appId) || appId <= 0) {
        return reply.status(400).send({ error: "app_id is required" });
      }
      if (!webhookSecret) {
        return reply.status(400).send({ error: "webhook_secret is required" });
      }

      await upsertGithubInstallation({
        installationId,
        accountLogin,
        appId,
        pemEncrypted,
        webhookSecret,
      });

      return {
        ok: true,
        installation_id: installationId,
        account_login: accountLogin,
      };
    },
  );

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
