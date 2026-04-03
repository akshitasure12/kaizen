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
