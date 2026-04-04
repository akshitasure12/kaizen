import { Octokit } from "@octokit/rest";
import { query, queryOne } from "../db/client";

/** GitHub remote for a Kaizen repo (from `repositories.github_*` after PAT import). */
export interface GitHubLinkRow {
  repo_id: string;
  github_owner: string;
  github_repo: string;
  default_branch: string;
}

export async function repositoryHasGitHubLink(repoId: string): Promise<boolean> {
  const row = await queryOne<{ one: number }>(
    `SELECT 1 AS one
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
    id: string;
    github_owner: string | null;
    github_repo: string | null;
    github_default_branch: string | null;
  }>(
    `SELECT id,
            github_owner,
            github_repo,
            github_default_branch
     FROM repositories
     WHERE id = $1`,
    [repoId],
  );
  if (!row) return null;
  const owner = row.github_owner?.trim() ?? "";
  const name = row.github_repo?.trim() ?? "";
  if (!owner || !name) return null;
  return {
    repo_id: row.id,
    github_owner: owner,
    github_repo: name,
    default_branch: row.github_default_branch?.trim() || "main",
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

const GITHUB_PAT_VALIDATE_TIMEOUT_MS = 15_000;

async function githubPatFetch(url: string, token: string): Promise<Response> {
  const signal = AbortSignal.timeout(GITHUB_PAT_VALIDATE_TIMEOUT_MS);
  return fetch(url, {
    signal,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

function mapPatFetchFailure(err: unknown): {
  status: number;
  githubMessage: string;
  reason: "timeout" | "network";
} {
  if (err instanceof Error && err.name === "AbortError") {
    return {
      status: 504,
      reason: "timeout",
      githubMessage: "GitHub did not respond in time. Try again.",
    };
  }
  return {
    status: 503,
    reason: "network",
    githubMessage: "Could not reach GitHub. Check your network and try again.",
  };
}

async function readGitHubErrorMessage(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { message?: string };
    if (typeof j?.message === "string") return j.message;
  } catch {
    /* ignore */
  }
  return undefined;
}

export async function validateGitHubToken(
  token: string,
): Promise<
  | { ok: true }
  | { ok: false; status: number; githubMessage?: string; reason?: string }
> {
  try {
    // Step 1: Validate token is not expired/revoked by checking /user endpoint
    const userUrl = new URL("https://api.github.com/user");
    const userRes = await githubPatFetch(userUrl.toString(), token);

    if (!userRes.ok) {
      const githubMessage = await readGitHubErrorMessage(userRes);
      return { ok: false, status: userRes.status, githubMessage };
    }

    // Step 2: Verify repository access (fine-grained tokens without repo scope fail here)
    const reposUrl = new URL("https://api.github.com/user/repos");
    reposUrl.searchParams.set("per_page", "1");
    const reposRes = await githubPatFetch(reposUrl.toString(), token);

    if (reposRes.status === 403) {
      const githubMessage = await readGitHubErrorMessage(reposRes);
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
      const githubMessage = await readGitHubErrorMessage(reposRes);
      return { ok: false, status: reposRes.status, githubMessage };
    }

    return { ok: true };
  } catch (err) {
    const mapped = mapPatFetchFailure(err);
    return {
      ok: false,
      status: mapped.status,
      reason: mapped.reason,
      githubMessage: mapped.githubMessage,
    };
  }
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

export type CreateGitHubIssueOutcome =
  | { status: "created"; number: number }
  | { status: "skipped" }
  | { status: "error"; httpStatus: number; message: string };

async function octokitCreateIssue(
  owner: string,
  repo: string,
  title: string,
  body: string,
  token: string,
): Promise<number> {
  const octokit = new Octokit({ auth: token });
  const { data } = await octokit.rest.issues.create({
    owner,
    repo,
    title,
    body: body.trim() ? body : undefined,
    headers: { "x-github-api-version": "2022-11-28" },
  });
  return data.number;
}

function mapGithubCreateIssueError(err: unknown): { httpStatus: number; message: string } {
  if (err && typeof err === "object" && "status" in err) {
    const status = Number((err as { status: number }).status) || 502;
    let message = "GitHub API error";
    if ("message" in err && typeof (err as { message: unknown }).message === "string") {
      message = (err as { message: string }).message;
    }
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    return { httpStatus, message };
  }
  if (err instanceof Error) return { httpStatus: 502, message: err.message };
  return { httpStatus: 502, message: "Failed to create issue on GitHub" };
}

/**
 * Create an issue on GitHub for an imported repo (PAT on user + `repositories.github_*`).
 * Returns `skipped` when the repo has no GitHub remote — caller keeps Kaizen-only issues.
 */
export async function createGitHubIssueForImportedRepo(input: {
  repoId: string;
  userId: string;
  title: string;
  body: string;
}): Promise<CreateGitHubIssueOutcome> {
  const link = await getGitHubLinkForRepo(input.repoId);
  if (!link) {
    return { status: "skipped" };
  }

  const pat = await getGitHubTokenForUser(input.userId);
  if (!pat) {
    return {
      status: "error",
      httpStatus: 403,
      message:
        "Repository is linked to GitHub but no personal access token is configured. Set your token with PATCH /auth/github-api-key.",
    };
  }

  try {
    const n = await octokitCreateIssue(
      link.github_owner,
      link.github_repo,
      input.title,
      input.body,
      pat,
    );
    return { status: "created", number: n };
  } catch (err) {
    const m = mapGithubCreateIssueError(err);
    return { status: "error", httpStatus: m.httpStatus, message: m.message };
  }
}
