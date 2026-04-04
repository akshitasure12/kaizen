import { query, queryOne } from '../db/client';
import { env } from '../env';
import { buildCliContextHints, buildVerificationChecklist } from './cli-context-hints';
import type { Scorecard } from './judge';

export interface EnqueueGitJobParams {
  issue_id: string;
  repo_id: string;
  user_id: string;
  agent_id: string;
  base_branch: string;
  max_attempts?: number;
  idempotency_key?: string | null;
  payload?: Record<string, unknown>;
}

export interface EnqueuedGitJob {
  id: string;
  status: string;
  deduped: boolean;
}

interface IssueContextRow {
  title: string;
  body: string | null;
  scorecard: unknown;
}

interface DiffSummaryRow {
  diff_summary_json: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asPartialScorecard(value: unknown): Partial<Scorecard> | null {
  if (!isRecord(value)) return null;
  return value as Partial<Scorecard>;
}

function extractHistoricalPaths(diffSummary: unknown): string[] {
  if (!isRecord(diffSummary)) return [];
  const files = diffSummary.files;
  if (!Array.isArray(files)) return [];

  const paths: string[] = [];
  for (const entry of files) {
    if (!isRecord(entry)) continue;
    if (typeof entry.file !== 'string') continue;
    const normalized = entry.file.trim().replace(/\\/g, '/');
    if (!normalized) continue;
    paths.push(normalized);
  }
  return paths;
}

async function buildPayloadWithCliHints(params: EnqueueGitJobParams): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = { ...(params.payload || {}) };
  if (!env.CLI_CONTEXT_HINTS_ENABLED) {
    return payload;
  }

  const issue = await queryOne<IssueContextRow>(
    `SELECT title, body, scorecard
     FROM issues
     WHERE id = $1
     LIMIT 1`,
    [params.issue_id],
  );

  if (!issue) {
    return payload;
  }

  const historyRows = await query<DiffSummaryRow>(
    `SELECT diff_summary_json
     FROM git_jobs
     WHERE repo_id = $1
       AND diff_summary_json IS NOT NULL
     ORDER BY updated_at DESC
     LIMIT $2`,
    [params.repo_id, env.CLI_CONTEXT_HINTS_HISTORY_LIMIT],
  );

  const historicalPaths = historyRows.flatMap((row) => extractHistoricalPaths(row.diff_summary_json));
  const scorecard = asPartialScorecard(issue.scorecard);

  const contextHints = buildCliContextHints({
    issueTitle: issue.title,
    issueBody: issue.body || '',
    scorecard,
    historicalPaths,
    topFileCount: env.CLI_CONTEXT_HINTS_TOP_FILES,
    topTestCount: env.CLI_CONTEXT_HINTS_TOP_TESTS,
  });

  if (!isRecord(payload.context_hints)) {
    payload.context_hints = contextHints;
  }

  if (!isRecord(payload.verification_hints)) {
    payload.verification_hints = {
      checklist: buildVerificationChecklist({
        scorecard,
        contextHints,
      }),
      suggested_test_commands: contextHints.command_suggestions.verify.slice(0, 4),
      generated_at: contextHints.generated_at,
    };
  }

  return payload;
}

export async function enqueueGitJob(params: EnqueueGitJobParams): Promise<EnqueuedGitJob> {
  const dedupeKey = params.idempotency_key?.trim() || null;
  if (dedupeKey) {
    const existing = await queryOne<{ id: string; status: string }>(
      `SELECT id, status
       FROM git_jobs
       WHERE idempotency_key = $1 AND user_id = $2
       LIMIT 1`,
      [dedupeKey, params.user_id],
    );
    if (existing) {
      return {
        id: existing.id,
        status: existing.status,
        deduped: true,
      };
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = await buildPayloadWithCliHints(params);
  } catch (error) {
    console.error('[git-job-enqueue] failed to build CLI context hints', error);
    payload = { ...(params.payload || {}) };
  }

  const [created] = await query<{ id: string }>(
    `INSERT INTO git_jobs (
       issue_id,
       repo_id,
       user_id,
       agent_id,
       base_branch,
       status,
       stage,
       payload,
       max_attempts,
       idempotency_key
     )
     VALUES ($1, $2, $3, $4, $5, 'pending', 'pending', $6::jsonb, $7, $8)
     RETURNING id`,
    [
      params.issue_id,
      params.repo_id,
      params.user_id,
      params.agent_id,
      params.base_branch,
      JSON.stringify(payload),
      params.max_attempts && params.max_attempts > 0
        ? Math.floor(params.max_attempts)
        : env.WORKER_MAX_ATTEMPTS,
      dedupeKey,
    ],
  );

  await query('UPDATE issues SET git_job_id = $1 WHERE id = $2', [created.id, params.issue_id]);

  return {
    id: created.id,
    status: 'pending',
    deduped: false,
  };
}
