import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { env } from "../env";
import { query, queryOne } from "../db/client";

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

export async function repositoryHasGitHubLink(repoId: string): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one
     FROM github_repo_links
     WHERE repository_id = $1
     UNION ALL
     SELECT 1 AS one
     FROM repositories
     WHERE id = $1
       AND github_owner IS NOT NULL
       AND trim(github_owner) <> ''
       AND github_repo IS NOT NULL
       AND trim(github_repo) <> ''
     LIMIT 1`,
    [repoId],
  );
  return row != null;
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

  if (!row) {
    return null;
  }

  const owner = row.owner.trim();
  const repo = row.name.trim();
  const defaultBranch = row.default_branch?.trim() || "main";
  if (!owner || !repo) {
    return null;
  }

  return {
    repo_id: row.repo_id,
    github_owner: owner,
    github_repo: repo,
    default_branch: defaultBranch,
    installation_id: row.installation_id,
  };
}

export async function getUserGitHubAuthFlags(userId: string): Promise<{ api_key_configured: boolean }> {
  const u = await queryOne<{ github_api_key: string | null }>(
    "SELECT github_api_key FROM users WHERE id = $1",
    [userId],
  );
  return { api_key_configured: Boolean(u?.github_api_key?.trim()) };
}

export async function setUserGithubApiKey(userId: string, apiKey: string | null): Promise<void> {
  const v = apiKey?.trim() || null;
  await query("UPDATE users SET github_api_key = $1 WHERE id = $2", [v, userId]);
}

export async function getGitHubTokenForUser(userId: string): Promise<string | null> {
  const u = await queryOne<{ github_api_key: string | null }>(
    "SELECT github_api_key FROM users WHERE id = $1",
    [userId],
  );
  const key = u?.github_api_key?.trim();
  return key || null;
}

export async function upsertGithubInstallation(input: {
  installationId: number;
  accountLogin: string;
  appId: number;
  pemEncrypted: string;
  webhookSecret: string;
}): Promise<void> {
  await query(
    `INSERT INTO github_installations (id, account_login, app_id, pem_encrypted, webhook_secret)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id)
     DO UPDATE SET
       account_login = EXCLUDED.account_login,
       app_id = EXCLUDED.app_id,
       pem_encrypted = EXCLUDED.pem_encrypted,
       webhook_secret = EXCLUDED.webhook_secret`,
    [
      input.installationId,
      input.accountLogin,
      input.appId,
      input.pemEncrypted,
      input.webhookSecret,
    ],
  );
}

export async function upsertGithubRepoLink(input: {
  repositoryId: string;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch: string;
}): Promise<void> {
  await query(
    `INSERT INTO github_repo_links (repository_id, installation_id, owner, name, default_branch)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (repository_id)
     DO UPDATE SET
       installation_id = EXCLUDED.installation_id,
       owner = EXCLUDED.owner,
       name = EXCLUDED.name,
       default_branch = EXCLUDED.default_branch`,
    [
      input.repositoryId,
      input.installationId,
      input.owner,
      input.name,
      input.defaultBranch,
    ],
  );

  await query(
    `UPDATE repositories
     SET github_owner = $1,
         github_repo = $2,
         github_default_branch = $3
     WHERE id = $4`,
    [input.owner, input.name, input.defaultBranch, input.repositoryId],
  );
}

export async function validateGitHubToken(
  token: string,
): Promise<
  | { ok: true }
  | { ok: false; status: number; githubMessage?: string; reason?: string }
> {
  // Step 1: Validate token is not expired/revoked by checking /user endpoint
  const userUrl = new URL("https://api.github.com/user");
  const userRes = await fetch(userUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!userRes.ok) {
    let githubMessage: string | undefined;
    try {
      const j = (await userRes.json()) as { message?: string };
      if (typeof j?.message === "string") githubMessage = j.message;
    } catch {
      /* ignore */
    }
    return { ok: false, status: userRes.status, githubMessage };
  }

  // Step 2: Verify token has repository and issues access by testing a basic API call
  // Try to fetch user repos - this tests repository access
  const reposUrl = new URL("https://api.github.com/user/repos");
  reposUrl.searchParams.set("per_page", "1");
  const reposRes = await fetch(reposUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (reposRes.status === 403) {
    let githubMessage: string | undefined;
    try {
      const j = (await reposRes.json()) as { message?: string };
      if (typeof j?.message === "string") githubMessage = j.message;
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      status: 403,
      reason: "insufficient_permissions",
      githubMessage:
        githubMessage ??
        "Token lacks required permissions. Ensure your fine-grained token has necessary permissions.",
    };
  }

  if (!reposRes.ok) {
    let githubMessage: string | undefined;
    try {
      const j = (await reposRes.json()) as { message?: string };
      if (typeof j?.message === "string") githubMessage = j.message;
    } catch {
      /* ignore */
    }
    return { ok: false, status: reposRes.status, githubMessage };
  }

  return { ok: true };
}

/** Parsed `Link` header from GitHub pagination (e.g. rel="next"). */
export function parseGitHubLinkHeader(linkHeader: string | null): {
  next?: string;
  prev?: string;
  first?: string;
  last?: string;
} {
  if (!linkHeader?.trim()) return {};
  const out: Record<string, string> = {};
  for (const part of linkHeader.split(",")) {
    const section = part.trim();
    const urlMatch = section.match(/^<([^>]+)>/);
    const relMatch = section.match(/rel="([^"]+)"/);
    if (urlMatch && relMatch) out[relMatch[1]] = urlMatch[1];
  }
  return out;
}

export interface GitHubAccessibleRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
}

export interface GitHubUserReposPage {
  items: GitHubAccessibleRepo[];
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

/**
 * One page of repos the token can access (`GET /user/repos`).
 */
export async function fetchGitHubUserReposPage(
  accessToken: string,
  opts: { page: number; per_page: number },
): Promise<
  | { ok: true; data: GitHubUserReposPage }
  | { ok: false; status: number; githubMessage?: string }
> {
  const { page, per_page } = opts;
  const url = new URL("https://api.github.com/user/repos");
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(per_page));
  url.searchParams.set("sort", "updated");

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const link = parseGitHubLinkHeader(res.headers.get("link"));

  if (!res.ok) {
    let githubMessage: string | undefined;
    try {
      const j = (await res.json()) as { message?: string };
      if (typeof j?.message === "string") githubMessage = j.message;
    } catch {
      /* ignore */
    }
    return { ok: false, status: res.status, githubMessage };
  }

  const raw = (await res.json()) as Array<{
    id: number;
    name: string;
    full_name: string;
    default_branch: string | null;
    private: boolean;
    html_url?: string;
  }>;

  const items: GitHubAccessibleRepo[] = raw.map((r) => ({
    id: r.id,
    name: r.name,
    full_name: r.full_name,
    default_branch: r.default_branch?.trim() || "main",
    private: r.private,
    html_url: typeof r.html_url === "string" ? r.html_url : `https://github.com/${r.full_name}`,
  }));

  return {
    ok: true,
    data: {
      items,
      page,
      per_page,
      has_next: Boolean(link.next),
      has_prev: Boolean(link.prev),
    },
  };
}
