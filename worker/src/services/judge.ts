import { GoogleGenAI } from "@google/genai";
import { query } from "../db/client";
import {
  buildGeminiThinkingConfig,
  getReasoningLevel,
  pickGeminiModel,
} from "./gemini-orchestration";

const geminiApiKey = process.env.GEMINI_API_KEY;
const gemini = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

export interface Scorecard {
  difficulty: "easy" | "medium" | "hard" | "expert";
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
  code_quality_score: number;
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
    if (typeof value !== "string") continue;
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

function normalizeScorecard(raw: Partial<Scorecard> | null | undefined): Scorecard {
  return {
    difficulty: (raw?.difficulty as Scorecard["difficulty"]) || "medium",
    base_points: Number(raw?.base_points ?? 100),
    unit_tests: Array.isArray(raw?.unit_tests) ? raw!.unit_tests : [],
    bonus_criteria: Array.isArray(raw?.bonus_criteria) ? raw!.bonus_criteria : [],
    bonus_points_per_criterion: Number(raw?.bonus_points_per_criterion ?? 10),
    time_limit_hours: Number(raw?.time_limit_hours ?? 24),
    required_language: raw?.required_language,
  };
}

export async function judgeGitDiffContext(params: {
  issueTitle: string;
  issueBody: string;
  diffText: string;
  scorecard: Partial<Scorecard>;
  toolEvidence?: Array<{
    phase: string;
    command: string;
    exit_code: number | null;
    timed_out: boolean;
    blocked_reason?: string | null;
    stdout_tail?: string;
    stderr_tail?: string;
  }>;
}): Promise<JudgeResult> {
  const blob =
    `## Issue\n${params.issueTitle}\n\n${params.issueBody || ""}` +
    `\n\n## Proposed changes (git diff)\n\`\`\`diff\n${params.diffText.slice(0, 12000)}\n\`\`\`` +
    `\n\n## Tool execution evidence\n\`\`\`json\n${JSON.stringify(params.toolEvidence || [], null, 2).slice(0, 5000)}\n\`\`\``;
  return judgeSubmission(blob, normalizeScorecard(params.scorecard));
}

async function judgeSubmission(submissionContent: string, scorecard: Scorecard): Promise<JudgeResult> {
  if (!gemini) {
    throw new Error("gemini_unavailable: GEMINI_API_KEY is required for worker judging");
  }

  try {
    return await judgeWithGemini(submissionContent, scorecard);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`gemini_unavailable: ${msg}`);
  }
}

async function judgeWithGemini(submissionContent: string, scorecard: Scorecard): Promise<JudgeResult> {
  const reasoningLevel = getReasoningLevel({
    difficulty: scorecard.difficulty,
    inputChars: submissionContent.length,
  });
  const model = pickGeminiModel(reasoningLevel);
  const thinkingConfig = buildGeminiThinkingConfig(model, reasoningLevel);

  const systemPrompt = [
    "You are an expert code judge for agentic software tasks.",
    "Follow these rules strictly:",
    "1) Evaluate only using evidence in the provided submission content and scorecard.",
    "2) Use conservative pass/fail decisions for listed tests.",
    "3) Keep reasoning concrete and action-oriented.",
    "4) Return valid JSON matching the schema; do not include markdown.",
  ].join("\n");

  const evaluationPrompt = [
    "<scorecard>",
    `difficulty: ${scorecard.difficulty}`,
    `base_points: ${scorecard.base_points}`,
    `unit_tests: ${JSON.stringify(scorecard.unit_tests)}`,
    `bonus_criteria: ${JSON.stringify(scorecard.bonus_criteria)}`,
    `bonus_points_per_criterion: ${scorecard.bonus_points_per_criterion}`,
    scorecard.required_language
      ? `required_language: ${scorecard.required_language}`
      : "required_language: none",
    "</scorecard>",
    "<submission>",
    submissionContent.slice(0, 12000),
    "</submission>",
  ].join("\n");

  const response = await gemini!.models.generateContent({
    model,
    contents: evaluationPrompt,
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          passed_tests: { type: "array", items: { type: "string" } },
          failed_tests: { type: "array", items: { type: "string" } },
          bonus_achieved: { type: "array", items: { type: "string" } },
          bonus_missed: { type: "array", items: { type: "string" } },
          code_quality_score: { type: "integer", minimum: 1, maximum: 10 },
          reasoning: { type: "string" },
          suggestions: { type: "array", items: { type: "string" } },
        },
        required: [
          "passed_tests",
          "failed_tests",
          "bonus_achieved",
          "bonus_missed",
          "code_quality_score",
          "reasoning",
          "suggestions",
        ],
      },
    },
  });

  const verdict = JSON.parse((response.text || "{}") as string) as Verdict;
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
  verdict.reasoning = verdict.reasoning || "Evaluation completed.";
  verdict.suggestions = uniqueStrings(Array.isArray(verdict.suggestions) ? verdict.suggestions : []);

  const points_awarded = calculatePoints(verdict, scorecard);
  return { verdict, points_awarded, is_mock: false };
}

function mockJudge(submissionContent: string, scorecard: Scorecard): JudgeResult {
  const content = (submissionContent || "").toLowerCase();

  const unitTests = Array.isArray(scorecard.unit_tests)
    ? scorecard.unit_tests
        .map((t: unknown) => {
          const tt = t as { name?: string; points?: number };
          return {
            name: typeof tt?.name === "string" ? tt.name : "test",
            points: typeof tt?.points === "number" ? tt.points : 10,
          };
        })
    : [];

  const bonusCriteria = Array.isArray(scorecard.bonus_criteria)
    ? scorecard.bonus_criteria.map((c) => String(c || ""))
    : [];

  const passed_tests: string[] = [];
  const failed_tests: string[] = [];
  for (const test of unitTests) {
    const testName = test.name.toLowerCase();
    const keywords = testName.split(/[\s_-]+/);
    const hasKeywords = keywords.some((kw) => content.includes(kw) && kw.length > 2);
    if (hasKeywords && deterministicRatio(`${test.name}:${submissionContent.length}`) > 0.3) {
      passed_tests.push(test.name);
    }
    else failed_tests.push(test.name);
  }

  const bonus_achieved: string[] = [];
  const bonus_missed: string[] = [];
  for (const criterion of bonusCriteria) {
    const firstWord = criterion.toLowerCase().split(" ")[0] || "";
    if (
      firstWord &&
      content.includes(firstWord) &&
      deterministicRatio(`${criterion}:${submissionContent.length}`) > 0.5
    ) {
      bonus_achieved.push(criterion);
    }
    else bonus_missed.push(criterion);
  }

  const hasComments = content.includes("//") || content.includes("/*") || content.includes("#");
  const hasErrorHandling = content.includes("try") || content.includes("catch") || content.includes("require(");
  const hasTests = content.includes("test") || content.includes("describe") || content.includes("it(");

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
    reasoning:
      `[Mock Judge] Evaluated submission of ${submissionContent.length} characters. ` +
      `Passed ${passed_tests.length}/${unitTests.length} tests. ` +
      `Achieved ${bonus_achieved.length}/${bonusCriteria.length} bonus criteria.`,
    suggestions: [
      "Add more comprehensive error handling",
      "Include inline documentation",
      "Consider edge cases in your implementation",
    ],
  };

  const points_awarded = calculatePoints(verdict, scorecard);
  return { verdict, points_awarded, is_mock: true };
}

function calculatePoints(verdict: Verdict, scorecard: Scorecard): number {
  let points = 0;
  const passedSet = new Set(verdict.passed_tests);
  const bonusSet = new Set(verdict.bonus_achieved);
  points += Math.floor(scorecard.base_points * 0.2);

  for (const testName of passedSet) {
    const test = scorecard.unit_tests.find((t) => t.name === testName);
    if (test) points += test.points;
  }

  points += bonusSet.size * scorecard.bonus_points_per_criterion;
  const qualityBonus = Math.floor((verdict.code_quality_score / 10) * scorecard.base_points * 0.1);
  points += qualityBonus;
  return points;
}

export async function storeJudgement(
  issueId: string,
  agentId: string,
  result: JudgeResult,
  options?: { prNumber?: number | null; commentBody?: string | null },
): Promise<void> {
  // Judge remains neutral: persist verdict only. Incentives are merge-settlement driven.
  await query(
    `INSERT INTO issue_judgements (issue_id, agent_id, verdict, points_awarded)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (issue_id, agent_id)
     DO UPDATE SET verdict = $3, points_awarded = $4, judged_at = NOW()`,
    [issueId, agentId, JSON.stringify(result.verdict), result.points_awarded],
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
}
