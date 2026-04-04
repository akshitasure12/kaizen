import { Octokit } from "@octokit/rest";
import { query, queryOne } from "../db/client";
import {
  getGitHubLinkForRepo,
  getGitHubTokenForUser,
} from "./github-integration";

export interface SyncGitHubIssuesStats {
  fetched: number;
  inserted: number;
  updated: number;
}

const DEFAULT_SCORECARD = {
  difficulty: "medium" as const,
  base_points: 100,
  unit_tests: [] as [],
  bonus_criteria: [] as [],
  bonus_points_per_criterion: 10,
  time_limit_hours: 24,
};

function truncateTitle(t: string, max = 255): string {
  const s = t.trim() || "(no title)";
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function isPullRequestItem(row: { pull_request?: unknown | null }): boolean {
  return row.pull_request != null;
}

/** When GitHub is open, preserve Kaizen workflow states that GitHub does not model. */
function kaizenStatusWhenGitHubOpen(
  current: string | null | undefined,
): "open" | "in_progress" | "cancelled" {
  if (current === "in_progress") return "in_progress";
  if (current === "cancelled") return "cancelled";
  return "open";
}

function parseClosedAt(closedAt: string | null | undefined): string | null {
  if (!closedAt) return null;
  const d = new Date(closedAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

export async function syncGitHubIssuesForRepo(
  repoId: string,
  userId: string,
): Promise<SyncGitHubIssuesStats> {
  const link = await getGitHubLinkForRepo(repoId);
  if (!link) {
    return { fetched: 0, inserted: 0, updated: 0 };
  }

  const token = await getGitHubTokenForUser(userId);
  if (!token) {
    throw new Error(
      "GitHub token not configured; set PAT via PATCH /auth/github-api-key to sync issues.",
    );
  }

  const octokit = new Octokit({ auth: token });
  const stats: SyncGitHubIssuesStats = {
    fetched: 0,
    inserted: 0,
    updated: 0,
  };

  const scorecardJson = JSON.stringify(DEFAULT_SCORECARD);

  for await (const resp of octokit.paginate.iterator(
    octokit.rest.issues.listForRepo,
    {
      owner: link.github_owner,
      repo: link.github_repo,
      state: "all",
      per_page: 100,
      headers: { "x-github-api-version": "2022-11-28" },
    },
  )) {
    for (const gh of resp.data) {
      if (isPullRequestItem(gh)) continue;

      stats.fetched += 1;
      const ghNumber = gh.number;
      const title = truncateTitle(gh.title ?? "");
      const body = typeof gh.body === "string" ? gh.body : "";

      const existing = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM issues WHERE repo_id = $1 AND github_issue_number = $2`,
        [repoId, ghNumber],
      );

      if (gh.state === "closed") {
        const closedAt = parseClosedAt(gh.closed_at);
        if (!existing) {
          try {
            await query(
              `INSERT INTO issues (repo_id, title, body, scorecard, created_by, github_issue_number, status, closed_at)
               VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'closed', $7::timestamptz)`,
              [repoId, title, body, scorecardJson, userId, ghNumber, closedAt],
            );
            stats.inserted += 1;
          } catch (e) {
            if (!isUniqueViolation(e)) throw e;
            const row = await queryOne<{ id: string }>(
              `SELECT id FROM issues WHERE repo_id = $1 AND github_issue_number = $2`,
              [repoId, ghNumber],
            );
            if (!row) throw e;
            await query(
              `UPDATE issues
               SET title = $1,
                   body = $2,
                   status = 'closed',
                   closed_at = COALESCE(closed_at, $3::timestamptz)
               WHERE id = $4`,
              [title, body, closedAt, row.id],
            );
            stats.updated += 1;
          }
        } else {
          await query(
            `UPDATE issues
             SET title = $1,
                 body = $2,
                 status = 'closed',
                 closed_at = COALESCE(closed_at, $3::timestamptz)
             WHERE id = $4`,
            [title, body, closedAt, existing.id],
          );
          stats.updated += 1;
        }
        continue;
      }

      // GitHub: open
      const nextStatus = existing
        ? kaizenStatusWhenGitHubOpen(existing.status)
        : "open";

      if (!existing) {
        try {
          await query(
            `INSERT INTO issues (repo_id, title, body, scorecard, created_by, github_issue_number, status, closed_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, NULL)`,
            [repoId, title, body, scorecardJson, userId, ghNumber, nextStatus],
          );
          stats.inserted += 1;
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          const row = await queryOne<{ id: string; status: string }>(
            `SELECT id, status FROM issues WHERE repo_id = $1 AND github_issue_number = $2`,
            [repoId, ghNumber],
          );
          if (!row) throw e;
          const resolved = kaizenStatusWhenGitHubOpen(row.status);
          await query(
            `UPDATE issues
             SET title = $1, body = $2, status = $3, closed_at = NULL
             WHERE id = $4`,
            [title, body, resolved, row.id],
          );
          stats.updated += 1;
        }
      } else {
        await query(
          `UPDATE issues
           SET title = $1, body = $2, status = $3, closed_at = NULL
           WHERE id = $4`,
          [title, body, nextStatus, existing.id],
        );
        stats.updated += 1;
      }
    }
  }

  return stats;
}
