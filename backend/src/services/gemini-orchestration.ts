import { env } from '../env';
import { ThinkingLevel, type ThinkingConfig } from '@google/genai';

export type ReasoningLevel = 'low' | 'medium' | 'high';

const DIFFICULTY_SCORE: Record<string, number> = {
  easy: 0.18,
  medium: 0.45,
  hard: 0.82,
  expert: 0.92,
};

const DEFAULT_DIFFICULTY_SCORE = 0.38;

const CROSS_CUTTING_MARKERS = [
  'backend',
  'frontend',
  'database',
  'migration',
  'schema',
  'api',
  'worker',
  'queue',
  'webhook',
  'auth',
  'security',
  'integration',
  'ci',
  'deployment',
  'infra',
];

const COMPLEXITY_MARKERS = [
  'refactor',
  'idempotent',
  'concurrency',
  'race condition',
  'transaction',
  'rollback',
  'backward compatible',
  'pagination',
  'performance',
  'caching',
  'retry',
  'timeout',
  'observability',
  'distributed',
  'consistency',
];

const CONSTRAINT_MARKERS = [
  'must',
  'should',
  'required',
  'ensure',
  'without breaking',
  'cannot',
  'do not',
  'edge case',
  'acceptance criteria',
  'non-functional',
];

function isGemini3Model(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized.startsWith('gemini-3') || normalized.includes('/gemini-3');
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function countKeywordHits(text: string, markers: readonly string[]): number {
  return markers.reduce((count, marker) => (text.includes(marker) ? count + 1 : count), 0);
}

function countRegexMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

function countChecklistItems(text: string): number {
  return countRegexMatches(text, /(^|\n)\s*(?:[-*+]|\d+\.)\s+/g);
}

function countUnitTests(unitTests?: Array<{ name?: string } | string>): number {
  if (!Array.isArray(unitTests)) return 0;
  return unitTests.reduce((count, test) => {
    if (typeof test === 'string') {
      return test.trim().length > 0 ? count + 1 : count;
    }
    if (typeof test?.name === 'string' && test.name.trim().length > 0) {
      return count + 1;
    }
    return count;
  }, 0);
}

export function getReasoningLevel(params: {
  difficulty?: string;
  inputChars?: number;
  issueTitle?: string;
  issueBody?: string;
  submissionContent?: string;
  requiredLanguage?: string;
  unitTests?: Array<{ name?: string } | string>;
  bonusCriteria?: string[];
  checklistCount?: number;
  verifyHintCount?: number;
  rankedFileCount?: number;
  rankedTestCount?: number;
}): ReasoningLevel {
  const d = (params.difficulty || '').toLowerCase();
  if (d === 'expert' || d === 'hard') return 'high';

  const textParts = [
    params.issueTitle,
    params.issueBody,
    params.submissionContent,
    params.requiredLanguage,
  ].filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  const rawText = textParts.join('\n');
  const normalizedText = normalizeText(rawText);

  const scopeScore = clamp01(countKeywordHits(normalizedText, CROSS_CUTTING_MARKERS) / 5);
  const complexityScore = clamp01(countKeywordHits(normalizedText, COMPLEXITY_MARKERS) / 6);
  const constraintScore = clamp01(
    (countKeywordHits(normalizedText, CONSTRAINT_MARKERS) +
      countRegexMatches(normalizedText, /\b(must|should|required?|ensure|without|cannot|need to)\b/g)) /
      8,
  );
  const semanticScore = clamp01(
    0.45 * complexityScore + 0.35 * scopeScore + 0.2 * constraintScore,
  );

  const checklistSignals = Math.max(params.checklistCount ?? 0, countChecklistItems(rawText));
  const unitTestSignals = countUnitTests(params.unitTests);
  const bonusSignals = Array.isArray(params.bonusCriteria) ? params.bonusCriteria.length : 0;
  const verifySignals = params.verifyHintCount ?? 0;
  const validationScore = clamp01(
    (checklistSignals + unitTestSignals + bonusSignals + verifySignals) / 10,
  );

  const contextSpreadScore = clamp01(
    ((params.rankedFileCount ?? 0) + (params.rankedTestCount ?? 0)) / 12,
  );

  const chars = params.inputChars ?? rawText.length;
  const lengthScore = clamp01(chars / 12000);
  const difficultyScore = DIFFICULTY_SCORE[d] ?? DEFAULT_DIFFICULTY_SCORE;

  const combinedScore = clamp01(
    0.38 * difficultyScore +
      0.3 * semanticScore +
      0.2 * validationScore +
      0.07 * contextSpreadScore +
      0.05 * lengthScore,
  );

  if (combinedScore >= 0.6) return 'high';
  if (combinedScore >= 0.28) return 'medium';
  if (d === 'medium' && combinedScore >= 0.22) return 'medium';
  if (semanticScore >= 0.26 || validationScore >= 0.3) return 'medium';
  if (lengthScore >= 0.8 && (semanticScore >= 0.15 || validationScore >= 0.2 || contextSpreadScore >= 0.3)) {
    return 'medium';
  }

  return 'low';
}

export function pickGeminiModel(level: ReasoningLevel): string {
  if (level === 'high') return env.GEMINI_MODEL_COMPLEX;
  if (level === 'medium') return env.GEMINI_MODEL_BALANCED;
  return env.GEMINI_MODEL_FAST;
}

export function buildGeminiThinkingConfig(model: string, level: ReasoningLevel): ThinkingConfig {
  if (isGemini3Model(model)) {
    const map: Record<ReasoningLevel, ThinkingLevel> = {
      low: ThinkingLevel.LOW,
      medium: ThinkingLevel.MEDIUM,
      high: ThinkingLevel.HIGH,
    };
    return { thinkingLevel: map[level] };
  }

  const budgetMap: Record<ReasoningLevel, number> = {
    low: env.GEMINI_THINKING_BUDGET_LOW,
    medium: env.GEMINI_THINKING_BUDGET_MEDIUM,
    high: env.GEMINI_THINKING_BUDGET_HIGH,
  };

  return { thinkingBudget: budgetMap[level] };
}
