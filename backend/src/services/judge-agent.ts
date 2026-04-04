export interface JudgeScorecardView {
  difficulty: "easy" | "medium" | "hard" | "expert";
  base_points: number;
  unit_tests: Array<{ name: string; points: number; description?: string }>;
  bonus_criteria: string[];
  bonus_points_per_criterion: number;
  time_limit_hours: number;
  required_language?: string;
}

export interface JudgeAgentDefinition {
  id: string;
  version: string;
  mission: string;
  principles: string[];
  rubric: string[];
  output_contract: string[];
}

export const KAIZEN_JUDGE_AGENT: JudgeAgentDefinition = {
  id: "kaizen-code-judge",
  version: "2026-04-04",
  mission:
    "Evaluate code submissions for bounty and issue resolution with grounded, conservative, and reproducible grading.",
  principles: [
    "Use only evidence from the provided submission, scorecard, and tool outputs.",
    "Do not use external knowledge, assumptions, or inferred hidden tests.",
    "Prefer correctness and requirement coverage over style and verbosity.",
    "Treat missing evidence as uncertainty; fail conservatively when proof is absent.",
    "Never reward longer answers by default; penalize fluff and unsupported claims.",
    "Keep reasoning concrete, auditable, and actionable.",
  ],
  rubric: [
    "Requirement and test alignment (40%): map claimed behavior to listed tests and constraints.",
    "Correctness and logic (30%): validate implementation reasoning against provided evidence.",
    "Reliability and safety (20%): check error handling, edge-case discipline, and secure defaults.",
    "Maintainability and clarity (10%): assess readability, structure, and change hygiene.",
  ],
  output_contract: [
    "Return strict JSON only; never return markdown.",
    "Populate only scorecard test names in passed_tests and failed_tests.",
    "Keep code_quality_score as integer from 1 to 10.",
    "Provide concise reasoning and actionable suggestions tied to observed evidence.",
  ],
};

export const JUDGE_VERDICT_JSON_SCHEMA = {
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
} as const;

export function buildJudgeSystemPrompt(): string {
  return [
    `You are ${KAIZEN_JUDGE_AGENT.id} (${KAIZEN_JUDGE_AGENT.version}).`,
    KAIZEN_JUDGE_AGENT.mission,
    "",
    "Core principles:",
    ...KAIZEN_JUDGE_AGENT.principles.map((line, idx) => `${idx + 1}) ${line}`),
    "",
    "Scoring rubric:",
    ...KAIZEN_JUDGE_AGENT.rubric.map((line, idx) => `${idx + 1}) ${line}`),
    "",
    "Output contract:",
    ...KAIZEN_JUDGE_AGENT.output_contract.map((line, idx) => `${idx + 1}) ${line}`),
  ].join("\n");
}

export function buildJudgeEvaluationPrompt(params: {
  scorecard: JudgeScorecardView;
  submissionContent: string;
  maxSubmissionChars?: number;
}): string {
  const maxSubmissionChars = params.maxSubmissionChars ?? 12000;
  const scorecard = params.scorecard;

  return [
    "<task>",
    "Evaluate the submission against the scorecard using the judge rubric.",
    "Ground every major claim in observed evidence from the submission.",
    "If evidence is insufficient for a test or bonus criterion, treat it as not achieved.",
    "</task>",
    "<scorecard>",
    `difficulty: ${scorecard.difficulty}`,
    `base_points: ${scorecard.base_points}`,
    `unit_tests: ${JSON.stringify(scorecard.unit_tests)}`,
    `bonus_criteria: ${JSON.stringify(scorecard.bonus_criteria)}`,
    `bonus_points_per_criterion: ${scorecard.bonus_points_per_criterion}`,
    scorecard.required_language
      ? `required_language: ${scorecard.required_language}`
      : "required_language: none",
    `time_limit_hours: ${scorecard.time_limit_hours}`,
    "</scorecard>",
    "<submission>",
    params.submissionContent.slice(0, maxSubmissionChars),
    "</submission>",
  ].join("\n");
}
