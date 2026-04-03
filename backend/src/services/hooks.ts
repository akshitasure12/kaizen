/**
 * Workflow Hooks Service
 *
 * Lightweight async hooks that run after commit/PR events.
 * Each hook performs a predefined check and logs results to workflow_runs.
 *
 * Checks:
 * - security_scan: regex-based secret/vulnerability detection
 * - content_quality: validates commit content length and structure
 * - knowledge_completeness: checks if knowledge_context has key fields
 */

import { query, queryOne } from '../db/client';
import { runSecurityScan, SecurityScanResult } from './security';

export type CheckStatus = 'passed' | 'failed' | 'warning' | 'skipped';
export type EventType = 'commit' | 'pr_open' | 'pr_merge';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  details?: Record<string, any>;
}

export interface WorkflowRun {
  id: string;
  repo_id: string;
  commit_id: string | null;
  pr_id: string | null;
  event_type: EventType;
  status: string;
  checks: CheckResult[];
  summary: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

// ─── Individual Check Functions ─────────────────────────────────────────────

function checkSecurityScan(content: string): CheckResult {
  const result: SecurityScanResult = runSecurityScan(content);

  return {
    name: 'security_scan',
    status: result.status === 'clean' ? 'passed' : result.status === 'critical' ? 'failed' : 'warning',
    severity: result.status === 'critical' ? 'critical' : result.status === 'warning' ? 'warning' : 'info',
    message: result.summary,
    details: {
      findings: result.findings,
      total_findings: result.findings.length,
    },
  };
}

function checkContentQuality(content: string, message: string): CheckResult {
  const issues: string[] = [];

  if (content.length < 10) {
    issues.push('Content is very short (< 10 chars)');
  }
  if (message.length < 5) {
    issues.push('Commit message is too short (< 5 chars)');
  }
  if (message.length > 200) {
    issues.push('Commit message is very long (> 200 chars)');
  }
  if (content.length > 100000) {
    issues.push('Content is very large (> 100KB)');
  }

  if (issues.length === 0) {
    return {
      name: 'content_quality',
      status: 'passed',
      severity: 'info',
      message: 'Content quality checks passed',
    };
  }

  return {
    name: 'content_quality',
    status: 'warning',
    severity: 'warning',
    message: `Content quality issues: ${issues.join('; ')}`,
    details: { issues },
  };
}

function checkKnowledgeCompleteness(
  knowledgeContext: Record<string, any> | null | undefined
): CheckResult {
  if (!knowledgeContext) {
    return {
      name: 'knowledge_completeness',
      status: 'skipped',
      severity: 'info',
      message: 'No knowledge context provided (optional)',
    };
  }

  const missing: string[] = [];
  const keyFields = ['decisions', 'next_steps', 'handoff_summary'];

  for (const field of keyFields) {
    const value = knowledgeContext[field];
    if (!value || (Array.isArray(value) && value.length === 0)) {
      missing.push(field);
    }
  }

  if (missing.length === 0) {
    return {
      name: 'knowledge_completeness',
      status: 'passed',
      severity: 'info',
      message: 'Knowledge context is complete',
    };
  }

  return {
    name: 'knowledge_completeness',
    status: 'warning',
    severity: 'info',
    message: `Knowledge context missing recommended fields: ${missing.join(', ')}`,
    details: { missing_fields: missing },
  };
}

// ─── Main Hook Runner ───────────────────────────────────────────────────────

/**
 * Run all hooks for a commit event asynchronously.
 * Stores results in workflow_runs table.
 * This function does NOT throw — errors are caught and logged.
 */
export async function runCommitHooks(params: {
  repoId: string;
  commitId: string;
  content: string;
  message: string;
  knowledgeContext?: Record<string, any> | null;
}): Promise<void> {
  const { repoId, commitId, content, message, knowledgeContext } = params;

  try {
    // Create a workflow run record in "running" state
    const [run] = await query<WorkflowRun>(
      `INSERT INTO workflow_runs (repo_id, commit_id, event_type, status, checks)
       VALUES ($1, $2, 'commit', 'running', '[]'::jsonb)
       RETURNING *`,
      [repoId, commitId]
    );

    // Run all checks
    const checks: CheckResult[] = [
      checkSecurityScan(content),
      checkContentQuality(content, message),
      checkKnowledgeCompleteness(knowledgeContext),
    ];

    // Determine overall status
    const hasFailed = checks.some(c => c.status === 'failed');
    const hasWarning = checks.some(c => c.status === 'warning');
    const overallStatus = hasFailed ? 'failed' : hasWarning ? 'warning' : 'passed';

    const passedCount = checks.filter(c => c.status === 'passed').length;
    const summary = `${passedCount}/${checks.length} checks passed` +
      (hasFailed ? ' (security issues found)' : hasWarning ? ' (warnings)' : '');

    // Update the workflow run with results
    await query(
      `UPDATE workflow_runs
       SET status = $1, checks = $2, summary = $3, completed_at = NOW()
       WHERE id = $4`,
      [overallStatus, JSON.stringify(checks), summary, run.id]
    );
  } catch (error) {
    // Hooks should never break the commit flow
    console.error('[hooks] Failed to run commit hooks:', error);
  }
}

/**
 * Run hooks for a PR event (open or merge).
 */
export async function runPRHooks(params: {
  repoId: string;
  prId: string;
  eventType: 'pr_open' | 'pr_merge';
  description: string;
}): Promise<void> {
  const { repoId, prId, eventType, description } = params;

  try {
    const [run] = await query<WorkflowRun>(
      `INSERT INTO workflow_runs (repo_id, pr_id, event_type, status, checks)
       VALUES ($1, $2, $3, 'running', '[]'::jsonb)
       RETURNING *`,
      [repoId, prId, eventType]
    );

    const checks: CheckResult[] = [
      checkSecurityScan(description),
      checkContentQuality(description, `PR ${eventType}`),
    ];

    const hasFailed = checks.some(c => c.status === 'failed');
    const hasWarning = checks.some(c => c.status === 'warning');
    const overallStatus = hasFailed ? 'failed' : hasWarning ? 'warning' : 'passed';

    const passedCount = checks.filter(c => c.status === 'passed').length;
    const summary = `${passedCount}/${checks.length} checks passed`;

    await query(
      `UPDATE workflow_runs
       SET status = $1, checks = $2, summary = $3, completed_at = NOW()
       WHERE id = $4`,
      [overallStatus, JSON.stringify(checks), summary, run.id]
    );
  } catch (error) {
    console.error('[hooks] Failed to run PR hooks:', error);
  }
}

// ─── Query Functions ────────────────────────────────────────────────────────

/**
 * Get workflow runs for a repository, newest first.
 */
export async function getWorkflowRuns(
  repoId: string,
  limit: number = 50
): Promise<WorkflowRun[]> {
  return query<WorkflowRun>(
    `SELECT * FROM workflow_runs
     WHERE repo_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [repoId, limit]
  );
}

/**
 * Get the workflow run for a specific commit.
 */
export async function getWorkflowRunForCommit(
  commitId: string
): Promise<WorkflowRun | null> {
  return queryOne<WorkflowRun>(
    `SELECT * FROM workflow_runs
     WHERE commit_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [commitId]
  );
}
