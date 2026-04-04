import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { queryOne } from "../db/client";
import { env } from "../env";

export interface GitHubLinkRow {
  repo_id: string;
  github_owner: string;
  github_repo: string;
  default_branch: string;
  installation_id: string;
}

interface InstallationAccessToken {
  token: string;
  expiresAt: Date;
}

const installationTokenCache = new Map<string, InstallationAccessToken>();

function requireGithubAppConfig(): { appId: string; privateKeyPem: string } {
  const appId = env.GITHUB_APP_ID?.trim();
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (!appId || !privateKeyPem) {
    throw new Error("GitHub App credentials are not configured");
  }
  return { appId, privateKeyPem };
}

function toBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function buildGithubAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const body = `${encodedHeader}.${encodedPayload}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(body);
  signer.end();
  const signature = signer.sign(privateKeyPem);
  return `${body}.${toBase64Url(signature)}`;
}

function isFresh(cached: InstallationAccessToken | undefined): cached is InstallationAccessToken {
  if (!cached) return false;
  return cached.expiresAt.getTime() - Date.now() > 30_000;
}

export async function getGitHubAppInstallationToken(installationId: number | string): Promise<string> {
  const installationKey = String(installationId);
  const cached = installationTokenCache.get(installationKey);
  if (isFresh(cached)) {
    return cached.token;
  }

  const { appId, privateKeyPem } = requireGithubAppConfig();
  const jwt = buildGithubAppJwt(appId, privateKeyPem);
  const octokit = new Octokit({ auth: jwt });
  const { data } = await octokit.request("POST /app/installations/{installation_id}/access_tokens", {
    installation_id: Number(installationKey),
    headers: {
      "x-github-api-version": "2022-11-28",
    },
  });

  installationTokenCache.set(installationKey, {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  });
  return data.token;
}

export async function getGitHubLinkForRepo(repoId: string): Promise<GitHubLinkRow | null> {
  const row = await queryOne<{
    repo_id: string;
    owner: string;
    name: string;
    default_branch: string | null;
    installation_id: string;
  }>(
    `SELECT grl.repository_id AS repo_id,
            grl.owner,
            grl.name,
            grl.default_branch,
            grl.installation_id::text AS installation_id
     FROM github_repo_links grl
     WHERE grl.repository_id = $1`,
    [repoId],
  );

  if (!row) return null;
  const owner = row.owner.trim();
  const repo = row.name.trim();
  const defaultBranch = row.default_branch?.trim() || "main";
  if (!owner || !repo) return null;

  return {
    repo_id: row.repo_id,
    github_owner: owner,
    github_repo: repo,
    default_branch: defaultBranch,
    installation_id: row.installation_id,
  };
}
