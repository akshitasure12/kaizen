import type { Scorecard } from './judge';
import {
  cosineSimilarity,
  generateEmbedding,
  isEmbeddingsEnabled,
} from './embeddings';

export type ResolvePlanPath = 'single_agent' | 'reuse_children' | 'new_children';

export interface PlannedChildWork {
  title: string;
  body: string;
  estimated_effort: number;
  scorecard: Scorecard;
  agent_ens?: string;
}

export interface ResolveIssueContext {
  title: string;
  body: string;
  scorecard: Scorecard;
  existing_child_count: number;
}

export interface ResolvePlanningOptions {
  requested_children?: PlannedChildWork[];
}

export interface ResolvePlan {
  path: ResolvePlanPath;
  decision: 'single_agent' | 'decompose';
  complexity_score: number;
  complexity_reasons: string[];
  suggested_agent_ens: string | null;
  children: PlannedChildWork[];
}

const DIFFICULTY_WEIGHT: Record<Scorecard['difficulty'], number> = {
  easy: 0.2,
  medium: 0.45,
  hard: 0.72,
  expert: 0.9,
};

const CROSS_CUTTING_KEYWORDS = [
  'backend',
  'frontend',
  'database',
  'migration',
  'security',
  'auth',
  'api',
  'worker',
  'ci',
  'test',
  'integration',
  'webhook',
];

const SEMANTIC_SCOPE_MARKERS = [
  'full stack',
  'full-stack',
  'end-to-end',
  'platform',
  'system',
  'architecture',
  'architect',
  'from scratch',
  'production-ready',
  'launch-ready',
  'full game',
  'complete game',
  'full application',
  'complete application',
];

const SEMANTIC_IMPLEMENTATION_INTENT_MARKERS = [
  'implement the full',
  'build the full',
  'implement full',
  'build full',
  'from scratch',
  'complete implementation',
  'full game',
  'complete game',
];

const SEMANTIC_SINGLE_DOMAIN_BUILD_MARKERS = [
  'html',
  'css',
  'javascript',
  ' js ',
  'browser',
  'canvas',
  'game',
  'ui',
  'frontend',
  'animation',
];

const SEMANTIC_COMPLEXITY_MARKERS = [
  'integrate',
  'orchestrate',
  'refactor',
  'idempotent',
  'concurrency',
  'transaction',
  'rollback',
  'migration',
  'ci',
  'deployment',
  'observability',
  'performance',
  'scalable',
  'distributed',
  'multi-tenant',
];

const SEMANTIC_CONSTRAINT_MARKERS = [
  'must',
  'required',
  'without breaking',
  'backward compatible',
  'acceptance criteria',
  'edge case',
  'safe',
  'reliable',
  'secure',
];

const SEMANTIC_DOMAIN_MARKERS = [
  ...CROSS_CUTTING_KEYWORDS,
  'payments',
  'dashboard',
  'analytics',
  'admin',
  'monitoring',
  'infra',
  'deployment',
  'release',
  'html',
  'css',
  'javascript',
  'game',
  'browser',
  'canvas',
  'ui',
];

const COMPLEXITY_POSITIVE_PROTOTYPES = [
  'Build an end-to-end full stack platform with backend APIs, frontend application, database migrations, worker orchestration, CI/CD, observability, and security hardening.',
  'Design and implement a production-ready multi-service workflow spanning auth, webhook handling, retries, idempotency, monitoring, and rollback safety.',
  'Coordinate cross-domain delivery that includes architecture changes, integration tests, deployment updates, and backward-compatible migration strategy.',
];

const COMPLEXITY_NEGATIVE_PROTOTYPES = [
  'Fix a typo in one response field.',
  'Update a single docs sentence.',
  'Change one small UI label without backend changes.',
];

let semanticPrototypeEmbeddingsPromise: Promise<
  { positive: number[][]; negative: number[][] } | null
> | null = null;

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCosineScore(score: number): number {
  return clamp01((score + 1) / 2);
}

function checklistCount(text: string): number {
  if (!text) return 0;
  const bulletMatches = text.match(/(^|\n)\s*(-|\*|\d+\.)\s+/g);
  return bulletMatches ? bulletMatches.length : 0;
}

function keywordCoverage(text: string): number {
  const lower = text.toLowerCase();
  const hitCount = CROSS_CUTTING_KEYWORDS.filter((keyword) => lower.includes(keyword)).length;
  return clamp01(hitCount / 5);
}

function markerHits(text: string, markers: readonly string[]): number {
  return markers.reduce((count, marker) => (text.includes(marker) ? count + 1 : count), 0);
}

function semanticLexicalScore(issue: ResolveIssueContext): {
  score: number;
  reasons: string[];
  multiDomainSignal: boolean;
  fullImplementationSignal: boolean;
} {
  const text = `${issue.title} ${issue.body || ''}`.toLowerCase();
  const scopeHits = markerHits(text, SEMANTIC_SCOPE_MARKERS);
  const complexityHits = markerHits(text, SEMANTIC_COMPLEXITY_MARKERS);
  const constraintHits = markerHits(text, SEMANTIC_CONSTRAINT_MARKERS);
  const domainHits = markerHits(text, SEMANTIC_DOMAIN_MARKERS);
  const implementationIntentHits = markerHits(text, SEMANTIC_IMPLEMENTATION_INTENT_MARKERS);
  const singleDomainBuildHits = markerHits(text, SEMANTIC_SINGLE_DOMAIN_BUILD_MARKERS);
  const categoryCoverage = [
    scopeHits > 0,
    complexityHits > 0,
    constraintHits > 0,
    domainHits >= 2,
  ].filter(Boolean).length;

  const scopeScore = clamp01(scopeHits / 4);
  const complexityScore = clamp01(complexityHits / 5);
  const constraintScore = clamp01(constraintHits / 4);
  const domainScore = clamp01(domainHits / 6);
  const coverageScore = clamp01(categoryCoverage / 4);
  const implementationIntentScore = clamp01(implementationIntentHits / 2);
  const singleDomainBuildScore = clamp01(singleDomainBuildHits / 4);

  const fullImplementationSignal =
    implementationIntentHits > 0 &&
    (domainHits >= 2 || singleDomainBuildHits >= 3);

  const score = clamp01(
    0.2 * scopeScore +
      0.24 * complexityScore +
      0.12 * constraintScore +
      0.18 * domainScore +
      0.08 * coverageScore +
      0.1 * implementationIntentScore +
      0.08 * singleDomainBuildScore,
  );

  const reasons: string[] = [];
  if (scopeHits > 0) {
    reasons.push('semantic_scope_markers');
  }
  if (complexityHits >= 2) {
    reasons.push('semantic_delivery_complexity');
  }
  if (constraintHits >= 2) {
    reasons.push('semantic_constraints_present');
  }
  if (domainHits >= 3) {
    reasons.push('semantic_cross_domain_scope');
  }
  if (fullImplementationSignal) {
    reasons.push('semantic_full_implementation_scope');
  }

  return {
    score,
    reasons,
    multiDomainSignal: domainHits >= 4 && (scopeHits >= 1 || complexityHits >= 2),
    fullImplementationSignal,
  };
}

async function getSemanticPrototypeEmbeddings(): Promise<
  { positive: number[][]; negative: number[][] } | null
> {
  if (!isEmbeddingsEnabled()) {
    return null;
  }

  if (!semanticPrototypeEmbeddingsPromise) {
    semanticPrototypeEmbeddingsPromise = (async () => {
      const [positiveEmbeddings, negativeEmbeddings] = await Promise.all([
        Promise.all(COMPLEXITY_POSITIVE_PROTOTYPES.map((text) => generateEmbedding(text))),
        Promise.all(COMPLEXITY_NEGATIVE_PROTOTYPES.map((text) => generateEmbedding(text))),
      ]);

      const positive = positiveEmbeddings.filter((embedding): embedding is number[] =>
        Array.isArray(embedding) && embedding.length > 0,
      );
      const negative = negativeEmbeddings.filter((embedding): embedding is number[] =>
        Array.isArray(embedding) && embedding.length > 0,
      );

      if (positive.length === 0 || negative.length === 0) {
        return null;
      }

      return { positive, negative };
    })().catch(() => null);
  }

  return semanticPrototypeEmbeddingsPromise;
}

async function semanticEmbeddingScore(issue: ResolveIssueContext): Promise<number | null> {
  if (!isEmbeddingsEnabled()) {
    return null;
  }

  const issueText = `${issue.title}\n${issue.body || ''}`;
  const [issueEmbedding, prototypes] = await Promise.all([
    generateEmbedding(issueText),
    getSemanticPrototypeEmbeddings(),
  ]);

  if (!issueEmbedding || !prototypes) {
    return null;
  }

  const positiveMatch = Math.max(
    ...prototypes.positive.map((embedding) => normalizeCosineScore(cosineSimilarity(issueEmbedding, embedding))),
  );
  const negativeMatch = Math.max(
    ...prototypes.negative.map((embedding) => normalizeCosineScore(cosineSimilarity(issueEmbedding, embedding))),
  );

  return clamp01(0.78 * positiveMatch + 0.22 * (1 - negativeMatch));
}

function downshiftDifficulty(difficulty: Scorecard['difficulty']): Scorecard['difficulty'] {
  if (difficulty === 'expert') return 'hard';
  if (difficulty === 'hard') return 'medium';
  return difficulty;
}

function deriveChildScorecard(parent: Scorecard, basePointRatio: number): Scorecard {
  const points = Math.max(20, Math.round(parent.base_points * basePointRatio));
  return {
    difficulty: downshiftDifficulty(parent.difficulty),
    base_points: points,
    unit_tests: [],
    bonus_criteria: [],
    bonus_points_per_criterion: parent.bonus_points_per_criterion,
    time_limit_hours: parent.time_limit_hours,
    required_language: parent.required_language,
  };
}

function buildDefaultChildren(issue: ResolveIssueContext): PlannedChildWork[] {
  const cleanTitle = normalizeWhitespace(issue.title);
  const coreBody = normalizeWhitespace(issue.body || '');

  return [
    {
      title: `Plan and scope ${cleanTitle}`,
      body: `Create an implementation plan, constraints checklist, and risk notes for: ${coreBody}`,
      estimated_effort: 2,
      scorecard: deriveChildScorecard(issue.scorecard, 0.25),
    },
    {
      title: `Implement ${cleanTitle}`,
      body: `Deliver the primary code changes and integration work for: ${coreBody}`,
      estimated_effort: 5,
      scorecard: deriveChildScorecard(issue.scorecard, 0.55),
    },
    {
      title: `Validate and document ${cleanTitle}`,
      body: `Add verification tests, edge-case handling, and concise release notes for: ${coreBody}`,
      estimated_effort: 3,
      scorecard: deriveChildScorecard(issue.scorecard, 0.2),
    },
  ];
}

async function scoreComplexity(issue: ResolveIssueContext): Promise<{
  score: number;
  reasons: string[];
  structuralScore: number;
  semanticScore: number;
  semanticMultiDomainSignal: boolean;
  semanticFullImplementationSignal: boolean;
}> {
  const body = issue.body || '';
  const bodyChars = body.length;
  const checklists = checklistCount(body);
  const keywordScore = keywordCoverage(`${issue.title} ${body}`);
  const difficultyScore = DIFFICULTY_WEIGHT[issue.scorecard.difficulty] ?? 0.45;
  const lengthScore = clamp01(bodyChars / 3500);
  const checklistScore = clamp01(checklists / 8);

  const structuralScore = clamp01(
    0.5 * difficultyScore +
      0.2 * lengthScore +
      0.15 * checklistScore +
      0.15 * keywordScore,
  );

  const lexicalSemantic = semanticLexicalScore(issue);
  const embeddingScore = await semanticEmbeddingScore(issue);
  const semanticScore =
    embeddingScore == null
      ? lexicalSemantic.score
      : clamp01(0.68 * lexicalSemantic.score + 0.32 * embeddingScore);

  const score = clamp01(
    0.64 * structuralScore + 0.36 * semanticScore,
  );

  const reasons: string[] = [];
  if (issue.scorecard.difficulty === 'hard' || issue.scorecard.difficulty === 'expert') {
    reasons.push(`difficulty=${issue.scorecard.difficulty}`);
  }
  if (bodyChars > 1200) {
    reasons.push(`long_spec(${bodyChars}_chars)`);
  }
  if (checklists >= 4) {
    reasons.push(`many_acceptance_items(${checklists})`);
  }
  if (keywordScore >= 0.4) {
    reasons.push('cross_cutting_scope');
  }
  reasons.push(...lexicalSemantic.reasons);
  if (semanticScore >= 0.6) {
    reasons.push('semantic_complexity_high');
  }
  if (embeddingScore != null && embeddingScore >= 0.7) {
    reasons.push('semantic_embedding_match');
  }
  if (bodyChars <= 280 && semanticScore >= 0.56) {
    reasons.push('short_but_semantically_broad');
  }

  return {
    score,
    reasons,
    structuralScore,
    semanticScore,
    semanticMultiDomainSignal: lexicalSemantic.multiDomainSignal,
    semanticFullImplementationSignal: lexicalSemantic.fullImplementationSignal,
  };
}

function normalizeRequestedChildren(children: PlannedChildWork[] | undefined): PlannedChildWork[] {
  if (!Array.isArray(children)) return [];
  return children
    .filter((child) => child && typeof child.title === 'string' && child.title.trim().length > 0)
    .map((child) => ({
      title: normalizeWhitespace(child.title),
      body: normalizeWhitespace(child.body || ''),
      estimated_effort: Math.max(1, Math.round(Number(child.estimated_effort || 1))),
      scorecard: child.scorecard,
      agent_ens: child.agent_ens?.trim() || undefined,
    }));
}

export async function buildResolvePlan(
  issue: ResolveIssueContext,
  options: ResolvePlanningOptions = {},
): Promise<ResolvePlan> {
  const requestedChildren = normalizeRequestedChildren(options.requested_children);
  const complexity = await scoreComplexity(issue);

  if (issue.existing_child_count > 0) {
    return {
      path: 'reuse_children',
      decision: 'decompose',
      complexity_score: Math.max(complexity.score, 0.65),
      complexity_reasons: ['existing_children_present', ...complexity.reasons],
      suggested_agent_ens: null,
      children: [],
    };
  }

  if (requestedChildren.length >= 2) {
    return {
      path: 'new_children',
      decision: 'decompose',
      complexity_score: Math.max(complexity.score, 0.6),
      complexity_reasons: ['explicit_decomposition_requested', ...complexity.reasons],
      suggested_agent_ens: null,
      children: requestedChildren,
    };
  }

  const shouldDecompose =
    complexity.score >= 0.58 ||
    complexity.semanticScore >= 0.72 ||
    (complexity.semanticMultiDomainSignal && complexity.semanticScore >= 0.52) ||
    (complexity.semanticFullImplementationSignal && complexity.semanticScore >= 0.3);
  if (shouldDecompose) {
    return {
      path: 'new_children',
      decision: 'decompose',
      complexity_score: complexity.score,
      complexity_reasons: complexity.reasons.length > 0 ? complexity.reasons : ['complexity_threshold_met'],
      suggested_agent_ens: null,
      children: buildDefaultChildren(issue),
    };
  }

  return {
    path: 'single_agent',
    decision: 'single_agent',
    complexity_score: complexity.score,
    complexity_reasons: complexity.reasons,
    suggested_agent_ens: null,
    children: [],
  };
}
