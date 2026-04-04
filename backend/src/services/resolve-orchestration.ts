import type { Scorecard } from './judge';

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
  fanout_children?: boolean;
}

export interface ResolvePlan {
  path: ResolvePlanPath;
  decision: 'single_agent' | 'decompose';
  complexity_score: number;
  complexity_reasons: string[];
  fanout_children: boolean;
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

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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

function scoreComplexity(issue: ResolveIssueContext): { score: number; reasons: string[] } {
  const body = issue.body || '';
  const bodyChars = body.length;
  const checklists = checklistCount(body);
  const keywordScore = keywordCoverage(`${issue.title} ${body}`);
  const difficultyScore = DIFFICULTY_WEIGHT[issue.scorecard.difficulty] ?? 0.45;
  const lengthScore = clamp01(bodyChars / 3500);
  const checklistScore = clamp01(checklists / 8);

  const score = clamp01(
    0.5 * difficultyScore +
      0.2 * lengthScore +
      0.15 * checklistScore +
      0.15 * keywordScore,
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

  return {
    score,
    reasons,
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

export function buildResolvePlan(
  issue: ResolveIssueContext,
  options: ResolvePlanningOptions = {},
): ResolvePlan {
  const requestedChildren = normalizeRequestedChildren(options.requested_children);
  const complexity = scoreComplexity(issue);

  if (issue.existing_child_count > 0) {
    return {
      path: 'reuse_children',
      decision: 'decompose',
      complexity_score: Math.max(complexity.score, 0.65),
      complexity_reasons: ['existing_children_present', ...complexity.reasons],
      fanout_children: options.fanout_children !== false,
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
      fanout_children: options.fanout_children !== false,
      suggested_agent_ens: null,
      children: requestedChildren,
    };
  }

  const shouldDecompose = complexity.score >= 0.58;
  if (shouldDecompose) {
    return {
      path: 'new_children',
      decision: 'decompose',
      complexity_score: complexity.score,
      complexity_reasons: complexity.reasons.length > 0 ? complexity.reasons : ['complexity_threshold_met'],
      fanout_children: options.fanout_children !== false,
      suggested_agent_ens: null,
      children: buildDefaultChildren(issue),
    };
  }

  return {
    path: 'single_agent',
    decision: 'single_agent',
    complexity_score: complexity.score,
    complexity_reasons: complexity.reasons,
    fanout_children: false,
    suggested_agent_ens: null,
    children: [],
  };
}
