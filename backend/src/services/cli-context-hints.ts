import type { Scorecard } from './judge';

export interface CliRankedPathHint {
  path: string;
  score: number;
  reasons: string[];
  source: 'historical' | 'lexical' | 'live' | 'seed';
}

export interface CliCommandSuggestions {
  discover: string[];
  inspect: string[];
  verify: string[];
}

export interface CliContextHints {
  search_terms: string[];
  ranked_files: CliRankedPathHint[];
  ranked_tests: CliRankedPathHint[];
  command_suggestions: CliCommandSuggestions;
  source: 'history' | 'issue_text';
  generated_at: string;
}

export interface BuildCliContextHintsParams {
  issueTitle: string;
  issueBody: string;
  scorecard?: Partial<Scorecard> | null;
  historicalPaths?: string[];
  topFileCount?: number;
  topTestCount?: number;
}

const TEST_PATH_RE = /(^|\/)(__tests__|tests?|testdata)(\/|$)|\.(test|spec)\.[^/]+$/i;

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'into',
  'need',
  'should',
  'would',
  'could',
  'issue',
  'repo',
  'task',
  'agent',
  'work',
  'use',
  'using',
  'add',
  'new',
  'fix',
  'update',
]);

const LANGUAGE_EXTENSION_MAP: Record<string, string[]> = {
  typescript: ['.ts', '.tsx'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  go: ['.go'],
  rust: ['.rs'],
  java: ['.java'],
  solidity: ['.sol'],
};

interface ScoreBreakdown {
  score: number;
  reasons: string[];
  termHits: number;
  testPath: boolean;
  languageMatch: boolean;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function normalizePath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/\\/g, '/');
  if (!normalized) return null;
  if (normalized.startsWith('.git/')) return null;
  return normalized;
}

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

function getLanguageExtensions(requiredLanguage: string | undefined): string[] {
  if (!requiredLanguage) return [];
  const key = requiredLanguage.toLowerCase().trim();
  return LANGUAGE_EXTENSION_MAP[key] || [];
}

function scoreHistoricalPath(path: string, searchTerms: string[], languageExtensions: string[]): ScoreBreakdown {
  const lower = path.toLowerCase();
  const reasons: string[] = [];
  const testPath = isTestPath(path);
  const languageMatch = languageExtensions.some((ext) => lower.endsWith(ext));

  let termHits = 0;
  for (const term of searchTerms) {
    if (lower.includes(term)) {
      termHits += 1;
      if (reasons.length < 4) reasons.push(`term:${term}`);
    }
  }

  let score = 0;
  if (termHits > 0) score += Math.min(0.55, termHits * 0.17);
  if (testPath) {
    score += 0.08;
    reasons.push('test-path');
  }
  if (languageMatch) {
    score += 0.12;
    reasons.push('language-match');
  }

  if (score > 0) {
    score = Math.min(1, score + 0.2);
    reasons.push('historical');
  }

  return {
    score,
    reasons,
    termHits,
    testPath,
    languageMatch,
  };
}

function buildCommandSuggestions(params: {
  searchTerms: string[];
  rankedFiles: CliRankedPathHint[];
  rankedTests: CliRankedPathHint[];
}): CliCommandSuggestions {
  const termPattern =
    params.searchTerms.length > 0
      ? params.searchTerms.slice(0, 8).map(escapeRegex).join('|')
      : 'TODO|FIXME|BUG';

  const inspect =
    params.rankedFiles.length > 0
      ? params.rankedFiles.slice(0, 3).map((hint) => `sed -n '1,200p' ${shellQuote(hint.path)}`)
      : ["sed -n '1,200p' <path-to-file>"];

  const verifyCommands: string[] = [
    `rg -n --ignore-case '${termPattern}' .`,
    'if [ -f package.json ]; then npm test -- --help || true; fi',
    'if [ -f bun.lockb ] || [ -f bun.lock ]; then bun test --help || true; fi',
    'if [ -f pyproject.toml ] || [ -f pytest.ini ]; then pytest -q || true; fi',
  ];

  if (params.rankedTests.length > 0) {
    verifyCommands.unshift(
      ...params.rankedTests
        .slice(0, 2)
        .map((hint) => `sed -n '1,200p' ${shellQuote(hint.path)}`),
    );
  }

  return {
    discover: [
      'rg --files',
      `rg -n --ignore-case '${termPattern}' .`,
      'find . -maxdepth 4 -type f | head -n 200',
    ],
    inspect,
    verify: verifyCommands,
  };
}

export function buildCliContextHints(params: BuildCliContextHintsParams): CliContextHints {
  const topFileCount = Math.max(1, Math.min(50, params.topFileCount ?? 8));
  const topTestCount = Math.max(1, Math.min(30, params.topTestCount ?? 5));

  const unitTestNames = Array.isArray(params.scorecard?.unit_tests)
    ? params.scorecard!.unit_tests
        .map((test) => (test && typeof test.name === 'string' ? test.name : ''))
        .filter((value) => value.length > 0)
    : [];

  const requiredLanguage =
    typeof params.scorecard?.required_language === 'string'
      ? params.scorecard.required_language
      : undefined;

  const searchTerms = uniq([
    ...tokenize(params.issueTitle),
    ...tokenize(params.issueBody || ''),
    ...tokenize(unitTestNames.join(' ')),
    ...(requiredLanguage ? tokenize(requiredLanguage) : []),
  ]).slice(0, 12);

  const historicalPaths = uniq((params.historicalPaths || []).map((value) => normalizePath(value) || '').filter(Boolean));
  const languageExtensions = getLanguageExtensions(requiredLanguage);

  const scoredCandidates: CliRankedPathHint[] = [];
  for (const path of historicalPaths) {
    const breakdown = scoreHistoricalPath(path, searchTerms, languageExtensions);
    if (breakdown.score <= 0) continue;

    // Keep low-signal candidates out unless they are tests or language-matching files.
    if (breakdown.termHits === 0 && !breakdown.testPath && !breakdown.languageMatch) continue;

    scoredCandidates.push({
      path,
      score: Number(breakdown.score.toFixed(3)),
      reasons: breakdown.reasons,
      source: 'historical',
    });
  }

  scoredCandidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  const rankedTests = scoredCandidates.filter((candidate) => isTestPath(candidate.path)).slice(0, topTestCount);
  const nonTestFiles = scoredCandidates.filter((candidate) => !isTestPath(candidate.path));
  const rankedFiles = (nonTestFiles.length > 0 ? nonTestFiles : scoredCandidates).slice(0, topFileCount);

  return {
    search_terms: searchTerms,
    ranked_files: rankedFiles,
    ranked_tests: rankedTests,
    command_suggestions: buildCommandSuggestions({
      searchTerms,
      rankedFiles,
      rankedTests,
    }),
    source: scoredCandidates.length > 0 ? 'history' : 'issue_text',
    generated_at: new Date().toISOString(),
  };
}

export function buildVerificationChecklist(params: {
  scorecard?: Partial<Scorecard> | null;
  contextHints: CliContextHints;
}): string[] {
  const checks: string[] = [];

  const unitTests = Array.isArray(params.scorecard?.unit_tests)
    ? params.scorecard!.unit_tests
        .map((test) => (test && typeof test.name === 'string' ? test.name.trim() : ''))
        .filter((name) => name.length > 0)
    : [];

  for (const testName of unitTests.slice(0, 5)) {
    checks.push(`Validate unit test intent: ${testName}`);
  }

  if (params.contextHints.ranked_tests.length > 0) {
    checks.push('Run focused checks for suggested test files before finalizing changes.');
  }

  checks.push('Keep modifications scoped to prioritized files unless new dependencies are necessary.');
  checks.push('Capture any assumptions or unresolved risks in the PR description.');

  return uniq(checks).slice(0, 8);
}