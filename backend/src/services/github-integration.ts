import { query, queryOne } from "../db/client";

export async function repositoryHasGitHubLink(repoId: string): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one FROM repositories
     WHERE id = $1 AND github_owner IS NOT NULL AND trim(github_owner) <> ''
       AND github_repo IS NOT NULL AND trim(github_repo) <> ''`,
    [repoId],
  );
  return row != null;
}

export interface GitHubLinkRow {
  repo_id: string;
  github_owner: string;
  github_repo: string;
  default_branch: string;
}

export async function getGitHubLinkForRepo(repoId: string): Promise<GitHubLinkRow | null> {
  const row = await queryOne<{
    repo_id: string;
    github_owner: string;
    github_repo: string;
    github_default_branch: string | null;
  }>(
    `SELECT id AS repo_id, github_owner, github_repo, github_default_branch
     FROM repositories
     WHERE id = $1`,
    [repoId],
  );
  if (!row?.github_owner?.trim() || !row.github_repo?.trim()) return null;
  const br = row.github_default_branch?.trim();
  return {
    repo_id: row.repo_id,
    github_owner: row.github_owner.trim(),
    github_repo: row.github_repo.trim(),
    default_branch: br && br.length > 0 ? br : "main",
  };
}

export async function getGitHubTokenForUser(userId: string): Promise<string | null> {
  const u = await queryOne<{ github_api_key: string | null }>(
    "SELECT github_api_key FROM users WHERE id = $1",
    [userId],
  );
  const key = u?.github_api_key?.trim();
  return key || null;
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
