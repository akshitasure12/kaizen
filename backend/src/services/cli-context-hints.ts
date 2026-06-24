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

export interface CliKnowledgeSnippet {
  document_id: string;
  chunk_id: string;
  title: string;
  source_filename: string | null;
  content: string;
  score: number;
}

export interface CliContextHints {
  search_terms: string[];
  ranked_files: CliRankedPathHint[];
  ranked_tests: CliRankedPathHint[];
  knowledge_snippets: CliKnowledgeSnippet[];
  command_suggestions: CliCommandSuggestions;
  source: 'history' | 'issue_text';
  generated_at: string;
}

export interface BuildCliContextHintsParams {
  issueTitle: string;
  issueBody: string;
  scorecard?: Partial<Scorecard> | null;
  historicalPaths?: string[];
  knowledgeSnippets?: CliKnowledgeSnippet[];
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

function sanitizeKnowledgeSnippets(value: unknown): CliKnowledgeSnippet[] {
  if (!Array.isArray(value)) return [];

  const snippets: CliKnowledgeSnippet[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Partial<CliKnowledgeSnippet>;
    if (typeof item.document_id !== 'string' || !item.document_id.trim()) continue;
    if (typeof item.chunk_id !== 'string' || !item.chunk_id.trim()) continue;
    if (typeof item.title !== 'string' || !item.title.trim()) continue;
    if (typeof item.content !== 'string' || !item.content.trim()) continue;

    const score =
      typeof item.score === 'number' && Number.isFinite(item.score)
        ? Math.min(1, Math.max(0, item.score))
        : 0;

    snippets.push({
      document_id: item.document_id.trim(),
      chunk_id: item.chunk_id.trim(),
      title: item.title.trim(),
      source_filename:
        typeof item.source_filename === 'string' && item.source_filename.trim()
          ? item.source_filename.trim()
          : null,
      content: item.content.trim(),
      score: Number(score.toFixed(4)),
    });
  }

  return snippets.slice(0, 20);
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
    'find . -maxdepth 4 -type f',
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
  const knowledgeSnippets = sanitizeKnowledgeSnippets(params.knowledgeSnippets ?? []);

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
    knowledge_snippets: knowledgeSnippets,
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