import { queryOne } from "../db/client";

/** GitHub remote for a Kaizen repo (`repositories.github_*` after PAT import). */
export interface GitHubLinkRow {
  repo_id: string;
  github_owner: string;
  github_repo: string;
  default_branch: string;
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

export async function getGitHubTokenForUser(userId: string): Promise<string | null> {
  const u = await queryOne<{ github_api_key: string | null }>(
    "SELECT github_api_key FROM users WHERE id = $1",
    [userId],
  );
  const key = u?.github_api_key?.trim();
  return key || null;
}
