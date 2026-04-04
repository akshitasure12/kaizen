/**
 * AutoResearch Judge Service
 * 
 * Uses Gemini with structured output to evaluate agent submissions.
 * Gracefully degrades to deterministic mock scoring if GEMINI_API_KEY is not set.
 */

import { GoogleGenAI } from '@google/genai';
import { query, queryOne } from '../db/client';
import {
  buildGeminiThinkingConfig,
  getReasoningLevel,
  pickGeminiModel,
} from './gemini-orchestration';

const geminiApiKey = process.env.GEMINI_API_KEY;
const gemini = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

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

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function deterministicRatio(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 1000003;
  }
  return (hash % 1000) / 1000;
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
  // Try Gemini judge first, fall back to mock.
  if (gemini) {
    try {
      return await judgeWithGemini(submissionContent, scorecard);
    } catch (error: any) {
      console.error('Gemini judge failed, falling back to mock:', error.message);
    }
  }

  return mockJudge(submissionContent, scorecard);
}

/**
 * Judge using Gemini with structured output and configurable reasoning depth.
 */
async function judgeWithGemini(
  submissionContent: string,
  scorecard: Scorecard
): Promise<JudgeResult> {
  const reasoningLevel = getReasoningLevel({
    difficulty: scorecard.difficulty,
    inputChars: submissionContent.length,
  });
  const model = pickGeminiModel(reasoningLevel);
  const thinkingConfig = buildGeminiThinkingConfig(model, reasoningLevel);

  const systemPrompt = [
    'You are an expert code judge for agentic software tasks.',
    'Follow these rules strictly:',
    '1) Evaluate only using evidence in the provided submission content and scorecard.',
    '2) Use conservative pass/fail decisions for listed tests.',
    '3) Keep reasoning concrete and action-oriented.',
    '4) Return valid JSON matching the schema; do not include markdown.'
  ].join('\n');

  const evaluationPrompt = [
    '<scorecard>',
    `difficulty: ${scorecard.difficulty}`,
    `base_points: ${scorecard.base_points}`,
    `unit_tests: ${JSON.stringify(scorecard.unit_tests)}`,
    `bonus_criteria: ${JSON.stringify(scorecard.bonus_criteria)}`,
    `bonus_points_per_criterion: ${scorecard.bonus_points_per_criterion}`,
    scorecard.required_language ? `required_language: ${scorecard.required_language}` : 'required_language: none',
    '</scorecard>',
    '<submission>',
    submissionContent.slice(0, 12000),
    '</submission>',
  ].join('\n');

  const response = await gemini!.models.generateContent({
    model,
    contents: evaluationPrompt,
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: {
          passed_tests: { type: 'array', items: { type: 'string' } },
          failed_tests: { type: 'array', items: { type: 'string' } },
          bonus_achieved: { type: 'array', items: { type: 'string' } },
          bonus_missed: { type: 'array', items: { type: 'string' } },
          code_quality_score: { type: 'integer', minimum: 1, maximum: 10 },
          reasoning: { type: 'string' },
          suggestions: { type: 'array', items: { type: 'string' } },
        },
        required: [
          'passed_tests',
          'failed_tests',
          'bonus_achieved',
          'bonus_missed',
          'code_quality_score',
          'reasoning',
          'suggestions',
        ],
      },
    },
  });

  const verdict = JSON.parse(response.text || '{}') as Verdict;
  
  // Validate and sanitize verdict
  const allowedTests = new Set(scorecard.unit_tests.map((t) => t.name));
  const allowedBonus = new Set(scorecard.bonus_criteria);
  const passed = uniqueStrings(Array.isArray(verdict.passed_tests) ? verdict.passed_tests : [])
    .filter((testName) => allowedTests.has(testName));
  const failed = uniqueStrings(Array.isArray(verdict.failed_tests) ? verdict.failed_tests : [])
    .filter((testName) => allowedTests.has(testName) && !passed.includes(testName));
  const bonusAchieved = uniqueStrings(Array.isArray(verdict.bonus_achieved) ? verdict.bonus_achieved : [])
    .filter((criterion) => allowedBonus.has(criterion));
  const bonusMissed = uniqueStrings(Array.isArray(verdict.bonus_missed) ? verdict.bonus_missed : [])
    .filter((criterion) => allowedBonus.has(criterion) && !bonusAchieved.includes(criterion));

  verdict.passed_tests = passed;
  verdict.failed_tests = failed;
  verdict.bonus_achieved = bonusAchieved;
  verdict.bonus_missed = bonusMissed;
  verdict.code_quality_score = Math.min(10, Math.max(1, verdict.code_quality_score || 5));
  verdict.reasoning = verdict.reasoning || 'Evaluation completed.';
  verdict.suggestions = uniqueStrings(Array.isArray(verdict.suggestions) ? verdict.suggestions : []);

  const points_awarded = calculatePoints(verdict, scorecard);

  return { verdict, points_awarded, is_mock: false };
}

/**
 * Mock judge for when Gemini is not available
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
    
    if (hasKeywords && deterministicRatio(`${test.name}:${submissionContent.length}`) > 0.3) {
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
    if (
      content.includes(criterionLower.split(' ')[0]) &&
      deterministicRatio(`${criterion}:${submissionContent.length}`) > 0.5
    ) {
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
  const passedSet = new Set(verdict.passed_tests);
  const bonusSet = new Set(verdict.bonus_achieved);

  // Base points for attempt
  points += Math.floor(scorecard.base_points * 0.2);

  // Points for passed tests
  for (const testName of passedSet) {
    const test = scorecard.unit_tests.find(t => t.name === testName);
    if (test) {
      points += test.points;
    }
  }

  // Bonus points
  points += bonusSet.size * scorecard.bonus_points_per_criterion;

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
  result: JudgeResult,
  options?: { prNumber?: number | null; commentBody?: string | null },
): Promise<void> {
  // Judge remains neutral: persist evaluation only, no incentive updates here.
  await query(
    `INSERT INTO issue_judgements (issue_id, agent_id, verdict, points_awarded)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (issue_id, agent_id) 
     DO UPDATE SET verdict = $3, points_awarded = $4, judged_at = NOW()`,
    [issueId, agentId, JSON.stringify(result.verdict), result.points_awarded]
  );

  await query(
    `INSERT INTO judge_results (issue_id, agent_id, pr_number, verdict_json, score_numeric, comment_body)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6)
     ON CONFLICT (issue_id, agent_id, pr_number)
     DO UPDATE SET
       verdict_json = EXCLUDED.verdict_json,
       score_numeric = EXCLUDED.score_numeric,
       comment_body = EXCLUDED.comment_body,
       created_at = NOW()`,
    [
      issueId,
      agentId,
      options?.prNumber ?? null,
      JSON.stringify(result.verdict),
      result.verdict.code_quality_score,
      options?.commentBody ?? null,
    ],
  );

  await query(
    `INSERT INTO agent_scores (agent_id, issue_id, points)
     VALUES ($1, $2, $3)
     ON CONFLICT (agent_id, issue_id)
     DO UPDATE SET points = EXCLUDED.points`,
    [agentId, issueId, result.points_awarded],
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
 * Check if judge is using real Gemini
 */
export function isRealJudge(): boolean {
  return gemini !== null;
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
  has_mock_judging: boolean;
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
    return { results: [], winner: null, has_mock_judging: false };
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
  const hasMockJudging = results.some((r) => r.is_mock);
  const sorted = [...results].sort((a, b) => b.points_awarded - a.points_awarded);
  const winner = hasMockJudging
    ? null
    : sorted[0].points_awarded > 0
      ? { agent_id: sorted[0].agent_id, points_awarded: sorted[0].points_awarded }
      : null;

  return {
    results: results.map(r => ({
      agent_id: r.agent_id,
      points_awarded: r.points_awarded,
      verdict: r.verdict,
      is_mock: r.is_mock,
    })),
    winner,
    has_mock_judging: hasMockJudging,
  };
}
