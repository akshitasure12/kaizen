import { query } from "../db/client";

interface QueryClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type IssueTerminalStatus = "closed" | "cancelled";

export function issueTerminalStatusFromMerge(merged: boolean): IssueTerminalStatus {
  return merged ? "closed" : "cancelled";
}

export function gitJobTerminalStateFromMerge(merged: boolean): {
  status: "completed" | "cancelled";
  stage: "completed" | "cancelled";
} {
  return merged
    ? { status: "completed", stage: "completed" }
    : { status: "cancelled", stage: "cancelled" };
}

async function runQuery<T>(
  text: string,
  params: unknown[] | undefined,
  client?: QueryClient,
): Promise<T[]> {
  if (client) {
    const res = await client.query<T>(text, params);
    return res.rows;
  }
  return query<T>(text, params);
}

async function runQueryOne<T>(
  text: string,
  params: unknown[] | undefined,
  client?: QueryClient,
): Promise<T | null> {
  const rows = await runQuery<T>(text, params, client);
  return rows[0] ?? null;
}

export async function rollupParentIssueStatus(
  issueId: string,
  client?: QueryClient,
): Promise<void> {
  let cursorIssueId: string | null = issueId;

  while (cursorIssueId) {
    const relation: { parent_issue_id: string | null } | null = await runQueryOne<{ parent_issue_id: string | null }>(
      "SELECT parent_issue_id FROM issues WHERE id = $1",
      [cursorIssueId],
      client,
    );
    const parentId: string | null = relation?.parent_issue_id ?? null;
    if (!parentId) return;

    const parent = await runQueryOne<{ id: string; status: string }>(
      "SELECT id, status FROM issues WHERE id = $1",
      [parentId],
      client,
    );
    if (!parent) {
      cursorIssueId = parentId;
      continue;
    }

    const children = await runQuery<{ status: string }>(
      "SELECT status FROM issues WHERE parent_issue_id = $1",
      [parentId],
      client,
    );
    if (children.length === 0) {
      cursorIssueId = parentId;
      continue;
    }

    const allTerminal = children.every((c) => c.status === "closed" || c.status === "cancelled");
    const anyStarted = children.some(
      (c) => c.status === "in_progress" || c.status === "closed" || c.status === "cancelled",
    );
    const nextStatus: "open" | "in_progress" | "closed" = allTerminal
      ? "closed"
      : anyStarted
        ? "in_progress"
        : "open";

    if (parent.status !== "cancelled" && nextStatus !== parent.status) {
      await runQuery(
        `UPDATE issues
         SET status = $1,
             closed_at = CASE WHEN $1 = 'closed' THEN COALESCE(closed_at, NOW()) ELSE NULL END
         WHERE id = $2`,
        [nextStatus, parentId],
        client,
      );
    }

    cursorIssueId = parentId;
  }
}

export async function finalizeIssueLifecycleAfterSettlement(params: {
  issueId: string;
  merged: boolean;
  mergedPrNumber: number;
  gitJobId?: string | null;
  client?: QueryClient;
}): Promise<void> {
  const finalJobState = gitJobTerminalStateFromMerge(params.merged);

  if (params.merged) {
    await runQuery(
      `UPDATE issues
       SET status = 'closed',
           closed_at = COALESCE(closed_at, NOW()),
           settlement_finalized_at = NOW()
       WHERE id = $1`,
      [params.issueId],
      params.client,
    );
  } else {
    await runQuery(
      `UPDATE issues
       SET status = CASE WHEN status = 'closed' THEN status ELSE 'cancelled' END,
           closed_at = COALESCE(closed_at, NOW()),
           settlement_finalized_at = NOW()
       WHERE id = $1`,
      [params.issueId],
      params.client,
    );
  }

  if (params.gitJobId) {
    await runQuery(
      `UPDATE git_jobs
       SET status = $1,
           stage = $2,
           github_pr_number = COALESCE(github_pr_number, $3),
           completed_at = COALESCE(completed_at, NOW()),
           settlement_finalized_at = NOW(),
           lease_token = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL,
           retry_after = NULL,
           updated_at = NOW()
       WHERE id = $4`,
      [finalJobState.status, finalJobState.stage, params.mergedPrNumber, params.gitJobId],
      params.client,
    );
  }

  await rollupParentIssueStatus(params.issueId, params.client);
}
