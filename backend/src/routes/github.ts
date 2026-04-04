import { FastifyInstance } from "fastify";
import { Octokit } from "@octokit/rest";
import { requireAuth } from "../middleware/auth";
import {
  getGitHubAppInstallationToken,
  getGitHubTokenForUser,
  setUserGithubApiKey,
  upsertGithubInstallation,
  upsertGithubRepoLink,
} from "../services/github-integration";
import { env } from "../env";
import { queryOne } from "../db/client";

function sanitizeRepoName(value: string): string {
  return value.trim().toLowerCase();
}

function sanitizeOwner(value: string): string {
  return value.trim().toLowerCase();
}

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
      const appId = Number(body.app_id || env.GITHUB_APP_ID || 0);
      const pemEncrypted = body.pem_encrypted?.trim() || "configured-via-env";
      const webhookSecret = body.webhook_secret?.trim() || env.GITHUB_WEBHOOK_SECRET || "";

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

      return { ok: true, installation_id: installationId, account_login: accountLogin };
    },
  );

  app.get(
    "/github/repos",
    { preHandler: requireAuth },
    async (req, reply) => {
      const installationIdRaw = (req.query as { installation_id?: string }).installation_id;

      if (installationIdRaw) {
        const installationId = Number(installationIdRaw);
        if (!Number.isFinite(installationId) || installationId <= 0) {
          return reply.status(400).send({ error: "installation_id must be a positive integer" });
        }

        const token = await getGitHubAppInstallationToken(installationId);
        const octokit = new Octokit({ auth: token });
        const { data } = await octokit.request("GET /installation/repositories", {
          per_page: 100,
          headers: {
            "x-github-api-version": "2022-11-28",
          },
        });

        const repos = data.repositories || [];

        return repos.map((r) => ({
          id: r.id,
          owner: r.owner.login,
          name: r.name,
          full_name: r.full_name,
          default_branch: r.default_branch,
          private: r.private,
          installation_id: installationId,
        }));
      }

      const accessToken = await getGitHubTokenForUser(req.user!.userId);
      if (!accessToken) {
        return reply.status(400).send({
          error: "Provide installation_id for App auth, or set a GitHub API key with PATCH /auth/github-api-key",
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

      const data = (await res.json()) as Array<{
        id: number;
        name: string;
        full_name: string;
        default_branch: string;
        private: boolean;
        owner: { login: string };
      }>;

      return data.map((r) => ({
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        full_name: r.full_name,
        default_branch: r.default_branch,
        private: r.private,
      }));
    },
  );

  app.post(
    "/github/link",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as {
        repository_id?: string;
        installation_id?: number;
        owner?: string;
        name?: string;
        default_branch?: string;
      };

      const repositoryId = body.repository_id?.trim();
      const owner = body.owner ? sanitizeOwner(body.owner) : "";
      const repoName = body.name ? sanitizeRepoName(body.name) : "";
      const installationId = Number(body.installation_id);
      const defaultBranch = body.default_branch?.trim() || "main";

      if (!repositoryId) {
        return reply.status(400).send({ error: "repository_id is required" });
      }
      if (!owner || !repoName) {
        return reply.status(400).send({ error: "owner and name are required" });
      }
      if (!Number.isFinite(installationId) || installationId <= 0) {
        return reply.status(400).send({ error: "installation_id is required" });
      }

      const exists = await queryOne<{ id: string }>("SELECT id FROM repositories WHERE id = $1", [repositoryId]);
      if (!exists) {
        return reply.status(404).send({ error: "Repository not found" });
      }

      const installation = await queryOne<{ id: string }>(
        "SELECT id::text AS id FROM github_installations WHERE id = $1",
        [installationId],
      );
      if (!installation) {
        return reply.status(400).send({
          error: "Unknown installation_id. Call POST /integrations/github/app/callback first.",
        });
      }

      const installToken = await getGitHubAppInstallationToken(installationId);
      const octokit = new Octokit({ auth: installToken });
      let remoteDefaultBranch = defaultBranch;
      try {
        const { data: remoteRepo } = await octokit.rest.repos.get({
          owner,
          repo: repoName,
        });
        remoteDefaultBranch = remoteRepo.default_branch || defaultBranch;
      } catch {
        // Keep caller-provided default branch when repo lookup cannot be verified.
      }

      await upsertGithubRepoLink({
        repositoryId,
        installationId,
        owner,
        name: repoName,
        defaultBranch: remoteDefaultBranch,
      });

      return {
        ok: true,
        repository_id: repositoryId,
        installation_id: installationId,
        owner,
        name: repoName,
        default_branch: remoteDefaultBranch,
      };
    },
  );

  app.patch(
    "/github/pat",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { github_api_key } = req.body as { github_api_key?: string | null };
      if (github_api_key === undefined) {
        return reply.status(400).send({ error: "github_api_key is required (use null to clear)" });
      }
      const value = github_api_key === null || github_api_key === "" ? null : github_api_key.trim();
      await setUserGithubApiKey(req.user!.userId, value);
      return { ok: true, api_key_configured: Boolean(value) };
    },
  );
}
