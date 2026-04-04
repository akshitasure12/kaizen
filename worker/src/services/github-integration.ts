import { queryOne } from "../db/client";

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
