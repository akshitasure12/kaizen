import { env } from "../env";
import { query, queryOne } from "../db/client";

export interface IssueBounty {
  id: string;
  issue_id: string;
  poster_agent_id: string;
  amount: number;
  status: string;
  winner_agent_id: string | null;
  judge_payout_fraction?: number | null;
  github_judge_verdict?: unknown;
  payout_status?: string | null;
  github_pr_number?: number | null;
  merge_webhook_delivery_id?: string | null;
}

export async function getIssueBounty(issueId: string): Promise<IssueBounty | null> {
  return queryOne<IssueBounty>(
    `SELECT *
     FROM issue_bounties
     WHERE issue_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [issueId],
  );
}

export function payoutFractionFromNormalizedScore(score: number): number {
  const s = Math.min(1, Math.max(0, score));
  const floor = env.PAYOUT_SCORE_FLOOR;
  if (s < floor) return 0;

  const normalized = (s - floor) / Math.max(1e-9, 1 - floor);
  const fraction =
    env.PAYOUT_MIN_ABOVE_FLOOR +
    (1 - env.PAYOUT_MIN_ABOVE_FLOOR) * Math.pow(normalized, env.PAYOUT_EXPONENT);
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.round(clamped * 100) / 100;
}

export function payoutFractionFromCodeQuality(codeQualityScore: number): number {
  const s = Math.min(10, Math.max(1, codeQualityScore));
  const normalized = (s - 1) / 9;
  return payoutFractionFromNormalizedScore(normalized);
}

export async function persistGitHubJudgeOnBounty(
  bountyId: string,
  verdict: unknown,
  codeQualityScore: number,
): Promise<void> {
  const fraction = payoutFractionFromCodeQuality(codeQualityScore);
  await query(
    `UPDATE issue_bounties
     SET github_judge_verdict = $1::jsonb,
         judge_payout_fraction = $2,
         status = 'judging',
         payout_status = 'awaiting_merge'
     WHERE id = $3`,
    [verdict as object, fraction, bountyId],
  );
}

export async function setBountyGithubPrNumber(bountyId: string, prNumber: number): Promise<void> {
  await query(
    `UPDATE issue_bounties
     SET github_pr_number = $1,
         payout_status = COALESCE(payout_status, 'awaiting_merge')
     WHERE id = $2`,
    [prNumber, bountyId],
  );
}
