import type { SimpleGit } from 'simple-git';

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
  source: 'history' | 'issue_text' | 'seed+live' | 'live' | 'seed';
  generated_at: string;
}

export interface VerificationHints {
  checklist: string[];
  suggested_test_commands: string[];
}

export interface ParsedJobHints {
  contextHints: CliContextHints | null;
  verificationHints: VerificationHints | null;
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
  'issue',
  'task',
  'agent',
]);

interface MutableCandidate {
  path: string;
  score: number;
  reasons: Set<string>;
  sources: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values));
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0);
}

function toHintArray(value: unknown): CliRankedPathHint[] {
  if (!Array.isArray(value)) return [];
  const hints: CliRankedPathHint[] = [];

  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = typeof item.path === 'string' ? normalizePath(item.path) : '';
    if (!path) continue;
    const score = typeof item.score === 'number' ? clamp01(item.score) : 0;
    const reasons = toStringArray(item.reasons);
    const source =
      item.source === 'historical' || item.source === 'lexical' || item.source === 'live' || item.source === 'seed'
        ? item.source
        : 'seed';
    hints.push({
      path,
      score,
      reasons,
      source,
    });
  }

  return hints;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\-/\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function buildDefaultCommandSuggestions(params: {
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

  const verify: string[] = [
    `rg -n --ignore-case '${termPattern}' .`,
    'if [ -f package.json ]; then npm test -- --help || true; fi',
    'if [ -f bun.lockb ] || [ -f bun.lock ]; then bun test --help || true; fi',
    'if [ -f pyproject.toml ] || [ -f pytest.ini ]; then pytest -q || true; fi',
  ];

  if (params.rankedTests.length > 0) {
    verify.unshift(
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
    verify,
  };
}

export function parseJobCliHints(payload: Record<string, unknown> | null): ParsedJobHints {
  if (!isRecord(payload)) {
    return {
      contextHints: null,
      verificationHints: null,
    };
  }

  const contextValue = payload.context_hints;
  let contextHints: CliContextHints | null = null;
  if (isRecord(contextValue)) {
    const searchTerms = toStringArray(contextValue.search_terms);
    const rankedFiles = toHintArray(contextValue.ranked_files);
    const rankedTests = toHintArray(contextValue.ranked_tests);

    const commands = isRecord(contextValue.command_suggestions)
      ? {
          discover: toStringArray(contextValue.command_suggestions.discover),
          inspect: toStringArray(contextValue.command_suggestions.inspect),
          verify: toStringArray(contextValue.command_suggestions.verify),
        }
      : {
          discover: [],
          inspect: [],
          verify: [],
        };

    const source =
      contextValue.source === 'history' || contextValue.source === 'issue_text'
        ? contextValue.source
        : 'history';

    contextHints = {
      search_terms: searchTerms,
      ranked_files: rankedFiles,
      ranked_tests: rankedTests,
      command_suggestions: commands,
      source,
      generated_at:
        typeof contextValue.generated_at === 'string' ? contextValue.generated_at : new Date().toISOString(),
    };
  }

  const verificationValue = payload.verification_hints;
  let verificationHints: VerificationHints | null = null;
  if (isRecord(verificationValue)) {
    const checklist = toStringArray(verificationValue.checklist);
    const suggested = toStringArray(verificationValue.suggested_test_commands);
    if (checklist.length > 0 || suggested.length > 0) {
      verificationHints = {
        checklist,
        suggested_test_commands: suggested,
      };
    }
  }

  return {
    contextHints,
    verificationHints,
  };
}

export async function refineCliHintsForWorkspace(params: {
  git: SimpleGit;
  issueTitle: string;
  issueBody: string;
  seedHints: CliContextHints | null;
  maxFiles: number;
  maxTests: number;
  scanLimit: number;
}): Promise<CliContextHints | null> {
  const trackedRaw = await params.git.raw(['ls-files']);
  const trackedFiles = trackedRaw
    .split('\n')
    .map((line) => normalizePath(line))
    .filter((line) => line.length > 0)
    .slice(0, Math.max(100, params.scanLimit));

  const searchTerms = uniq([
    ...(params.seedHints?.search_terms || []),
    ...tokenize(`${params.issueTitle} ${params.issueBody || ''}`),
  ]).slice(0, 12);

  const candidates = new Map<string, MutableCandidate>();
  const addCandidate = (path: string, score: number, reason: string, source: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return;
    const normalizedScore = clamp01(score);

    const existing = candidates.get(normalizedPath);
    if (existing) {
      existing.score = Math.max(existing.score, normalizedScore);
      if (reason) existing.reasons.add(reason);
      if (source) existing.sources.add(source);
      return;
    }

    candidates.set(normalizedPath, {
      path: normalizedPath,
      score: normalizedScore,
      reasons: reason ? new Set([reason]) : new Set<string>(),
      sources: source ? new Set([source]) : new Set<string>(),
    });
  };

  if (params.seedHints) {
    for (const hint of params.seedHints.ranked_files) {
      addCandidate(hint.path, Math.max(0.3, hint.score), 'seed-file', 'seed');
    }
    for (const hint of params.seedHints.ranked_tests) {
      addCandidate(hint.path, Math.max(0.35, hint.score), 'seed-test', 'seed');
    }
  }

  for (const path of trackedFiles) {
    const lower = path.toLowerCase();
    const testPath = isTestPath(path);
    let hits = 0;
    for (const term of searchTerms) {
      if (lower.includes(term)) {
        hits += 1;
      }
    }

    if (hits === 0 && !testPath) continue;

    const score = clamp01(0.16 + Math.min(0.56, hits * 0.16) + (testPath ? 0.08 : 0));
    addCandidate(path, score, hits > 0 ? `term-hits:${hits}` : 'test-path', 'live');
  }

  const ranked = Array.from(candidates.values())
    .map<CliRankedPathHint>((candidate) => ({
      path: candidate.path,
      score: Number(candidate.score.toFixed(3)),
      reasons: Array.from(candidate.reasons),
      source: candidate.sources.has('live') ? 'live' : 'seed',
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path);
    });

  const rankedTests = ranked.filter((hint) => isTestPath(hint.path)).slice(0, Math.max(1, params.maxTests));
  const nonTestFiles = ranked.filter((hint) => !isTestPath(hint.path));
  const rankedFiles = (nonTestFiles.length > 0 ? nonTestFiles : ranked).slice(0, Math.max(1, params.maxFiles));

  if (!params.seedHints && rankedFiles.length === 0 && rankedTests.length === 0) {
    return null;
  }

  const commandSuggestions =
    params.seedHints &&
    (params.seedHints.command_suggestions.discover.length > 0 ||
      params.seedHints.command_suggestions.inspect.length > 0 ||
      params.seedHints.command_suggestions.verify.length > 0)
      ? params.seedHints.command_suggestions
      : buildDefaultCommandSuggestions({
          searchTerms,
          rankedFiles,
          rankedTests,
        });

  return {
    search_terms: searchTerms,
    ranked_files: rankedFiles,
    ranked_tests: rankedTests,
    command_suggestions: commandSuggestions,
    source: params.seedHints ? 'seed+live' : 'live',
    generated_at: new Date().toISOString(),
  };
}

function pushCommandSection(lines: string[], title: string, commands: string[]): void {
  if (commands.length === 0) return;
  lines.push(`### ${title}`);
  lines.push('```bash');
  for (const command of commands) {
    lines.push(command);
  }
  lines.push('```');
  lines.push('');
}

export function renderKaizenAgentNote(params: {
  issueTitle: string;
  issueBody: string;
  contextHints: CliContextHints | null;
  verificationHints: VerificationHints | null;
}): string {
  const lines: string[] = ['# Agent proposal', '', `**Issue:** ${params.issueTitle}`, ''];

  lines.push(params.issueBody?.trim() || '_No issue body provided._');
  lines.push('');

  if (params.contextHints) {
    lines.push('## CLI context hints');
    lines.push('');

    if (params.contextHints.ranked_files.length > 0) {
      lines.push('### Prioritized files');
      for (const hint of params.contextHints.ranked_files) {
        lines.push(`- ${hint.path} (score ${hint.score.toFixed(2)})`);
      }
      lines.push('');
    }

    if (params.contextHints.ranked_tests.length > 0) {
      lines.push('### Prioritized tests');
      for (const hint of params.contextHints.ranked_tests) {
        lines.push(`- ${hint.path} (score ${hint.score.toFixed(2)})`);
      }
      lines.push('');
    }

    pushCommandSection(lines, 'Discovery commands', params.contextHints.command_suggestions.discover);
    pushCommandSection(lines, 'Inspection commands', params.contextHints.command_suggestions.inspect);
    pushCommandSection(lines, 'Verification commands', params.contextHints.command_suggestions.verify);
  }

  const checklist = params.verificationHints?.checklist || [];
  if (checklist.length > 0) {
    lines.push('## Verification checklist');
    for (const item of checklist) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  const suggestedCommands = params.verificationHints?.suggested_test_commands || [];
  if (suggestedCommands.length > 0) {
    pushCommandSection(lines, 'Suggested test commands', suggestedCommands);
  }

  lines.push(`_Updated ${new Date().toISOString()}_`);
  lines.push('');
  return lines.join('\n');
}