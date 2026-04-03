/**
 * AutoResearch Judge Service
 * 
 * Uses OpenAI GPT-4o with structured output to evaluate agent submissions.
 * Gracefully degrades to deterministic mock scoring if OPENAI_API_KEY is not set.
 */

import OpenAI from 'openai';
import { query, queryOne } from '../db/client';

const apiKey = process.env.OPENAI_API_KEY;
const openai = apiKey ? new OpenAI({ apiKey }) : null;

const JUDGE_MODEL = process.env.OPENAI_JUDGE_MODEL || 'gpt-4o';

export interface Scorecard {
  difficulty: 'easy' | 'medium' | 'hard' | 'expert';
  base_points: number;
  unit_tests: Array<{ name: string; points: number; description?: string }>;
  bonus_criteria: string[];
  bonus_points_per_criterion: number;
  time_limit_hours: number;
  required_language?: string;
}

export interface Verdict {
  passed_tests: string[];
  failed_tests: string[];
  bonus_achieved: string[];
  bonus_missed: string[];
  code_quality_score: number; // 1-10
  reasoning: string;
  suggestions: string[];
}

export interface JudgeResult {
  verdict: Verdict;
  points_awarded: number;
  is_mock: boolean;
}

// ─── Main Judge Function ──────────────────────────────────────────────────────

/**
 * Judge an agent's submission against an issue's scorecard
 */
/**
 * Judge using local git diff + issue text (Git worker path; same clone as agent).
 */
export async function judgeGitDiffContext(params: {
  issueTitle: string;
  issueBody: string;
  diffText: string;
  scorecard: Scorecard;
}): Promise<JudgeResult> {
  const blob = `## Issue\n${params.issueTitle}\n\n${params.issueBody || ""}\n\n## Proposed changes (git diff)\n\`\`\`diff\n${params.diffText.slice(0, 12000)}\n\`\`\``;
  return judgeSubmission("", "", blob, params.scorecard);
}

export async function judgeSubmission(
  issueId: string,
  agentId: string,
  submissionContent: string,
  scorecard: Scorecard
): Promise<JudgeResult> {
  // Try OpenAI judge first, fall back to mock
  if (openai) {
    try {
      return await judgeWithOpenAI(submissionContent, scorecard);
    } catch (error: any) {
      console.error('OpenAI judge failed, falling back to mock:', error.message);
    }
  }

  return mockJudge(submissionContent, scorecard);
}

/**
 * Judge using OpenAI GPT-4o with structured output
 */
async function judgeWithOpenAI(
  submissionContent: string,
  scorecard: Scorecard
): Promise<JudgeResult> {
  const systemPrompt = `You are an expert code reviewer and judge for AI agent submissions. 
Your task is to evaluate a submission against a scorecard and provide a detailed verdict.

Scorecard:
- Difficulty: ${scorecard.difficulty}
- Base Points: ${scorecard.base_points}
- Unit Tests: ${JSON.stringify(scorecard.unit_tests)}
- Bonus Criteria: ${JSON.stringify(scorecard.bonus_criteria)}
- Bonus Points per Criterion: ${scorecard.bonus_points_per_criterion}
${scorecard.required_language ? `- Required Language: ${scorecard.required_language}` : ''}

Evaluate the submission and respond with a JSON object containing:
{
  "passed_tests": ["list of test names that passed"],
  "failed_tests": ["list of test names that failed"],
  "bonus_achieved": ["list of bonus criteria achieved"],
  "bonus_missed": ["list of bonus criteria not achieved"],
  "code_quality_score": <1-10 integer>,
  "reasoning": "detailed explanation of your evaluation",
  "suggestions": ["list of improvement suggestions"]
}

Be fair but rigorous. Only mark tests as passed if the code clearly implements the required functionality.
For bonus criteria, require clear evidence of implementation.`;

  const response = await openai!.chat.completions.create({
    model: JUDGE_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Please evaluate this submission:\n\n${submissionContent.slice(0, 8000)}` }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 1000,
    temperature: 0.2,
  });

  const verdict = JSON.parse(response.choices[0].message.content || '{}') as Verdict;
  
  // Validate and sanitize verdict
  verdict.passed_tests = Array.isArray(verdict.passed_tests) ? verdict.passed_tests : [];
  verdict.failed_tests = Array.isArray(verdict.failed_tests) ? verdict.failed_tests : [];
  verdict.bonus_achieved = Array.isArray(verdict.bonus_achieved) ? verdict.bonus_achieved : [];
  verdict.bonus_missed = Array.isArray(verdict.bonus_missed) ? verdict.bonus_missed : [];
  verdict.code_quality_score = Math.min(10, Math.max(1, verdict.code_quality_score || 5));
  verdict.reasoning = verdict.reasoning || 'Evaluation completed.';
  verdict.suggestions = Array.isArray(verdict.suggestions) ? verdict.suggestions : [];

  const points_awarded = calculatePoints(verdict, scorecard);

  return { verdict, points_awarded, is_mock: false };
}

/**
 * Mock judge for when OpenAI is not available
 * Uses deterministic scoring based on content analysis
 */
function mockJudge(submissionContent: string, scorecard: Scorecard): JudgeResult {
  const content = (submissionContent || '').toLowerCase();

  // Normalize unit_tests to array of objects with name/points
  const unitTests = Array.isArray(scorecard.unit_tests)
    ? scorecard.unit_tests
        .map((t: any) =>
          typeof t === 'string'
            ? { name: t, points: 10 }
            : { name: t?.name ?? 'test', points: typeof t?.points === 'number' ? t.points : 10 }
        )
    : [];

  const bonusCriteria = Array.isArray(scorecard.bonus_criteria)
    ? scorecard.bonus_criteria.map((c: any) => String(c || ''))
    : [];
  
  // Simulate test passing based on content keywords
  const passed_tests: string[] = [];
  const failed_tests: string[] = [];

  for (const test of unitTests) {
    // Simple heuristic: test passes if submission mentions related keywords
    const testName = test.name.toLowerCase();
    const keywords = testName.split(/[\s_-]+/);
    const hasKeywords = keywords.some((kw: string) => content.includes(kw) && kw.length > 2);
    
    if (hasKeywords && Math.random() > 0.3) {
      passed_tests.push(test.name);
    } else {
      failed_tests.push(test.name);
    }
  }

  // Simulate bonus criteria
  const bonus_achieved: string[] = [];
  const bonus_missed: string[] = [];

  for (const criterion of bonusCriteria) {
    const criterionLower = criterion.toLowerCase();
    if (content.includes(criterionLower.split(' ')[0]) && Math.random() > 0.5) {
      bonus_achieved.push(criterion);
    } else {
      bonus_missed.push(criterion);
    }
  }

  // Calculate code quality based on content length and structure
  const hasComments = content.includes('//') || content.includes('/*') || content.includes('#');
  const hasErrorHandling = content.includes('try') || content.includes('catch') || content.includes('require(');
  const hasTests = content.includes('test') || content.includes('describe') || content.includes('it(');
  
  let code_quality_score = 5;
  if (hasComments) code_quality_score += 1;
  if (hasErrorHandling) code_quality_score += 2;
  if (hasTests) code_quality_score += 1;
  if (content.length > 500) code_quality_score += 1;
  code_quality_score = Math.min(10, code_quality_score);

  const verdict: Verdict = {
    passed_tests,
    failed_tests,
    bonus_achieved,
    bonus_missed,
    code_quality_score,
    reasoning: `[Mock Judge] Evaluated submission of ${submissionContent.length} characters. ` +
      `Passed ${passed_tests.length}/${unitTests.length} tests. ` +
      `Achieved ${bonus_achieved.length}/${bonusCriteria.length} bonus criteria.`,
    suggestions: [
      'Add more comprehensive error handling',
      'Include inline documentation',
      'Consider edge cases in your implementation'
    ]
  };

  const points_awarded = calculatePoints(verdict, scorecard);

  return { verdict, points_awarded, is_mock: true };
}

/**
 * Calculate total points from verdict and scorecard
 */
function calculatePoints(verdict: Verdict, scorecard: Scorecard): number {
  let points = 0;

  // Base points for attempt
  points += Math.floor(scorecard.base_points * 0.2);

  // Points for passed tests
  for (const testName of verdict.passed_tests) {
    const test = scorecard.unit_tests.find(t => t.name === testName);
    if (test) {
      points += test.points;
    }
  }

  // Bonus points
  points += verdict.bonus_achieved.length * scorecard.bonus_points_per_criterion;

  // Code quality bonus (up to 10% of base points)
  const qualityBonus = Math.floor((verdict.code_quality_score / 10) * scorecard.base_points * 0.1);
  points += qualityBonus;

  return points;
}

// ─── Database Operations ──────────────────────────────────────────────────────

/**
 * Store judgement result in database
 */
export async function storeJudgement(
  issueId: string,
  agentId: string,
  result: JudgeResult
): Promise<void> {
  // Insert judgement
  await query(
    `INSERT INTO issue_judgements (issue_id, agent_id, verdict, points_awarded)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (issue_id, agent_id) 
     DO UPDATE SET verdict = $3, points_awarded = $4, judged_at = NOW()`,
    [issueId, agentId, JSON.stringify(result.verdict), result.points_awarded]
  );

  // Upsert agent score
  await query(
    `INSERT INTO agent_scores (agent_id, issue_id, points)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, issue_id)
     DO UPDATE SET points = $3`,
    [agentId, issueId, result.points_awarded]
  );

  // Update agent reputation
  const reputationBoost = Math.floor(result.points_awarded / 10);
  await query(
    `UPDATE agents SET reputation_score = reputation_score + $1 WHERE id = $2`,
    [reputationBoost, agentId]
  );
}

/**
 * Get judgement for an issue and agent
 */
export async function getJudgement(
  issueId: string,
  agentId: string
): Promise<{ verdict: Verdict; points_awarded: number } | null> {
  return queryOne<{ verdict: Verdict; points_awarded: number }>(
    `SELECT verdict, points_awarded FROM issue_judgements WHERE issue_id = $1 AND agent_id = $2`,
    [issueId, agentId]
  );
}

/**
 * Check if judge is using real OpenAI
 */
export function isRealJudge(): boolean {
  return openai !== null;
}

// ─── Competitive Bounty Judging (v3) ─────────────────────────────────────────

/**
 * Judge all submissions for a competitive bounty.
 * Scores each submission, updates verdict in bounty_submissions,
 * and returns the winner (highest points_awarded).
 */
export async function judgeAllSubmissions(
  bountyId: string,
  scorecard: Scorecard
): Promise<{
  results: Array<{ agent_id: string; points_awarded: number; verdict: Verdict; is_mock: boolean }>;
  winner: { agent_id: string; points_awarded: number } | null;
}> {
  // Get all submissions
  const submissions = await query<{
    id: string;
    agent_id: string;
    content: string;
  }>(
    'SELECT id, agent_id, content FROM bounty_submissions WHERE bounty_id = $1 ORDER BY submitted_at ASC',
    [bountyId]
  );

  if (submissions.length === 0) {
    return { results: [], winner: null };
  }

  // Update bounty status to judging
  await query(`UPDATE issue_bounties SET status = 'judging' WHERE id = $1`, [bountyId]);

  const results: Array<{ agent_id: string; points_awarded: number; verdict: Verdict; is_mock: boolean; submission_id: string }> = [];

  // Judge each submission
  for (const sub of submissions) {
    const result = await judgeSubmission(bountyId, sub.agent_id, sub.content, scorecard);

    // Store verdict on the bounty_submission row
    await query(
      `UPDATE bounty_submissions SET judge_verdict = $1, points_awarded = $2
       WHERE id = $3`,
      [JSON.stringify(result.verdict), result.points_awarded, sub.id]
    );

    results.push({
      agent_id: sub.agent_id,
      points_awarded: result.points_awarded,
      verdict: result.verdict,
      is_mock: result.is_mock,
      submission_id: sub.id,
    });
  }

  // Find winner (highest points)
  const sorted = [...results].sort((a, b) => b.points_awarded - a.points_awarded);
  const winner = sorted[0].points_awarded > 0 ? { agent_id: sorted[0].agent_id, points_awarded: sorted[0].points_awarded } : null;

  return {
    results: results.map(r => ({
      agent_id: r.agent_id,
      points_awarded: r.points_awarded,
      verdict: r.verdict,
      is_mock: r.is_mock,
    })),
    winner,
  };
}
