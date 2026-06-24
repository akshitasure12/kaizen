import type { Scorecard } from "./judge";

export type DecompositionAllocationStrategy =
  | "difficulty"
  | "effort"
  | "equal"
  | "difficulty_effort";

export interface DecompositionAllocationChild {
  estimated_effort?: number;
  scorecard?: Partial<Scorecard> | null;
}

const DIFFICULTY_WEIGHT: Record<Scorecard["difficulty"], number> = {
  easy: 1,
  medium: 2,
  hard: 3,
  expert: 4,
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function safePositive(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, numeric);
}

function difficultyWeight(scorecard: Partial<Scorecard> | null | undefined): number {
  const difficulty = scorecard?.difficulty;
  if (!difficulty || !(difficulty in DIFFICULTY_WEIGHT)) {
    return DIFFICULTY_WEIGHT.medium;
  }
  return DIFFICULTY_WEIGHT[difficulty];
}

function weightForChild(
  child: DecompositionAllocationChild,
  strategy: DecompositionAllocationStrategy,
): number {
  const effort = Math.max(1, Math.round(safePositive(child.estimated_effort || 1)));
  const difficulty = difficultyWeight(child.scorecard);

  if (strategy === "equal") return 1;
  if (strategy === "effort") return effort;
  if (strategy === "difficulty_effort") return effort * difficulty;
  return difficulty;
}

export function normalizeDecompositionAllocationStrategy(
  value: unknown,
): DecompositionAllocationStrategy {
  if (value === "equal") return "equal";
  if (value === "effort") return "effort";
  if (value === "difficulty_effort") return "difficulty_effort";
  return "difficulty";
}

export function allocateChildBounties(params: {
  total: number;
  children: DecompositionAllocationChild[];
  strategy: DecompositionAllocationStrategy;
}): number[] {
  const roundedTotal = round4(Math.max(0, Number(params.total || 0)));
  if (roundedTotal <= 0 || params.children.length === 0) {
    return params.children.map(() => 0);
  }

  const weights = params.children.map((child) =>
    Math.max(0.0001, weightForChild(child, params.strategy)),
  );
  const totalWeight = weights.reduce((acc, value) => acc + value, 0);
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    return params.children.map(() => 0);
  }

  const allocations = weights.map((weight) => round4(roundedTotal * (weight / totalWeight)));
  const allocatedTotal = round4(allocations.reduce((acc, value) => acc + value, 0));
  const delta = round4(roundedTotal - allocatedTotal);
  allocations[allocations.length - 1] = round4(
    Math.max(0, allocations[allocations.length - 1] + delta),
  );

  return allocations;
}

export function withIssueHierarchyPrefix(
  title: string,
  parentDepth: number,
  childIndex: number,
): string {
  const childDepth = Math.max(1, parentDepth + 1);
  const index = Math.max(1, childIndex);
  const prefix = `[D${childDepth}.${index}]`;
  const trimmed = title.trim();
  if (!trimmed) return prefix;
  if (trimmed.startsWith(`${prefix} `) || trimmed === prefix) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`;
}
