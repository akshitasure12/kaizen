/**
 * AgentBranch SDK v6
 *
 * Core functions for AI agents to interact with the version control system.
 * v2 adds: semantic commits, reasoning graph, replay traces
 * v3 adds: knowledge context for multi-agent collaboration handoffs
 * v5 adds: failure memory, workflow hooks, security scanning
 * v6 adds: multi-sort leaderboard
 */

import { query, queryOne } from '../db/client';
import { storeContent, retrieveContent } from '../services/fileverse';
import { validateEnsName } from '../services/ens';
import { processCommitSemantics, generateEmbedding, isEmbeddingsEnabled } from '../services/embeddings';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Agent {
  id: string;
  ens_name: string;
  role: string;
  capabilities: string[];
  reputation_score: number;
  user_id?: string;
  deposit_tx_hash?: string;
  deposit_verified?: boolean;
  created_at: string;
}

export interface Repository {
  id: string;
  name: string;
  description: string;
  owner_agent_id: string;
  bounty_pool: number;
  created_at: string;
}

export interface Branch {
  id: string;
  repo_id: string;
  name: string;
  base_branch_id: string | null;
  created_by: string;
  created_at: string;
}

export type ReasoningType = 'knowledge' | 'hypothesis' | 'experiment' | 'conclusion' | 'trace';

export interface TraceData {
  prompt: string;
  context: Record<string, any>;
  tools: Array<{ name: string; input: any; output: any }>;
  result: string;
}

/**
 * Structured knowledge context for agent-to-agent handoff.
 * Captures everything the next agent needs to continue the work.
 */
export interface KnowledgeContext {
  /** Key decisions made during this work (e.g., "Chose React for UI") */
  decisions?: string[];
  /** Architecture overview or notes */
  architecture?: string;
  /** Libraries/tools selected or used */
  libraries?: string[];
  /** Unresolved questions for the next agent */
  open_questions?: string[];
  /** Recommended next steps */
  next_steps?: string[];
  /** IDs of commits this work depends on */
  dependencies?: string[];
  /** Free-form summary for the next agent taking over */
  handoff_summary?: string;
}

/**
 * Structured failure context for AI failure memory (v5).
 * Tags commits with information about failed approaches so agents can learn
 * from past mistakes and avoid repeating them.
 */
export interface FailureContext {
  /** Whether this commit represents a failed approach */
  failed: boolean;
  /** Category of the error (e.g., "runtime", "logic", "dependency", "timeout") */
  error_type?: string;
  /** Human/agent-readable error description */
  error_detail?: string;
  /** What approach was tried and failed */
  failed_approach?: string;
  /** Root cause analysis (why it failed) */
  root_cause?: string;
  /** Severity: low = minor inconvenience, medium = blocks progress, high = critical failure */
  severity?: 'low' | 'medium' | 'high';
  /** Concrete, actionable fixes that should be attempted next */
  corrective_actions?: string[];
  /** Hard constraints for the next attempt generated from this failure */
  next_attempt_constraints?: string[];
  /** Optional short examples/snippets from failing evidence */
  related_examples?: string[];
}

export interface Commit {
  id: string;
  repo_id: string;
  branch_id: string;
  author_agent_id: string;
  message: string;
  content_ref: string;
  content_type: string;
  parent_commit_id: string | null;
  created_at: string;
  // Semantic fields (v2)
  embedding?: number[];
  semantic_summary?: string;
  tags?: string[];
  // Reasoning graph fields (v2)
  reasoning_type?: ReasoningType;
  // Replay trace fields (v2)
  trace_prompt?: string;
  trace_context?: Record<string, any>;
  trace_tools?: Array<{ name: string; input: any; output: any }>;
  trace_result?: string;
  // Knowledge handoff (v3)
  knowledge_context?: KnowledgeContext;
  // Failure memory (v5)
  failure_context?: FailureContext;
  // Populated by readMemory
  content?: string;
  author_ens?: string;
  branch_name?: string;
}

export interface PullRequest {
  id: string;
  repo_id: string;
  source_branch_id: string;
  target_branch_id: string;
  author_agent_id: string;
  reviewer_agent_id: string | null;
  description: string;
  status: 'open' | 'approved' | 'merged' | 'rejected';
  bounty_amount: number;
  created_at: string;
  merged_at: string | null;
}

export type PermissionLevel = 'public' | 'team' | 'restricted' | 'encrypted';

export interface CommitOptions {
  contentType?: string;
  reasoningType?: ReasoningType;
  trace?: TraceData;
  skipSemantics?: boolean;
  /** Structured knowledge handoff for the next agent */
  knowledgeContext?: KnowledgeContext;
  /** Failure memory — tag this commit as a failed approach (v5) */
  failureContext?: FailureContext;
}

export interface SearchResult {
  commit: Commit;
  similarity: number;
}

export interface GraphNode {
  commit: Commit;
  children: GraphNode[];
}

// ─── Agent ────────────────────────────────────────────────────────────────────

export async function registerAgent(
  ensName: string,
  role: string,
  capabilities: string[] = [],
  opts: { userId?: string } = {}
): Promise<Agent> {
  if (!validateEnsName(ensName)) {
    throw new Error(`Invalid ENS name: "${ensName}". Must match pattern agent.eth`);
  }

  const key = ensName.toLowerCase();
  const existing = await queryOne<Agent>('SELECT * FROM agents WHERE ens_name = $1', [key]);
  if (existing) return existing;

  const [agent] = await query<Agent>(
    `INSERT INTO agents (ens_name, role, capabilities, user_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [key, role, capabilities, opts.userId ?? null]
  );
  return agent;
}

export async function getAgent(ensName: string): Promise<Agent | null> {
  return queryOne<Agent>('SELECT * FROM agents WHERE ens_name = $1', [ensName.toLowerCase()]);
}

// ─── Repository ───────────────────────────────────────────────────────────────

export async function createRepository(
  name: string,
  ownerEns: string,
  description: string = '',
  _initialPermissionIgnored: PermissionLevel = 'public'
): Promise<Repository> {
  const owner = await getAgent(ownerEns);
  if (!owner) throw new Error(`Agent not found: ${ownerEns}`);

  const [repo] = await query<Repository>(
    `INSERT INTO repositories (name, description, owner_agent_id, bounty_pool)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, description, owner.id, 0]
  );

  // Automatically create the main branch
  await query(
    `INSERT INTO branches (repo_id, name, base_branch_id, created_by)
     VALUES ($1, 'main', NULL, $2)`,
    [repo.id, owner.id]
  );

  return repo;
}

// ─── Branch ───────────────────────────────────────────────────────────────────

export async function createBranch(
  repoId: string,
  branchName: string,
  baseBranchName: string,
  creatorEns: string
): Promise<Branch> {
  const creator = await getAgent(creatorEns);
  if (!creator) throw new Error(`Agent not found: ${creatorEns}`);

  const base = await queryOne<Branch>(
    'SELECT * FROM branches WHERE repo_id = $1 AND name = $2',
    [repoId, baseBranchName]
  );
  if (!base) throw new Error(`Base branch "${baseBranchName}" not found in repo ${repoId}`);

  const existing = await queryOne<Branch>(
    'SELECT * FROM branches WHERE repo_id = $1 AND name = $2',
    [repoId, branchName]
  );
  if (existing) return existing;

  const [branch] = await query<Branch>(
    `INSERT INTO branches (repo_id, name, base_branch_id, created_by)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [repoId, branchName, base.id, creator.id]
  );
  return branch;
}

// ─── Commit (v2 with semantic features) ───────────────────────────────────────

export async function commitMemory(
  repoId: string,
  branchName: string,
  content: string,
  message: string,
  authorEns: string,
  options: CommitOptions = {}
): Promise<Commit> {
  const { contentType = 'text', reasoningType, trace, skipSemantics = false, knowledgeContext, failureContext } = options;

  const author = await getAgent(authorEns);
  if (!author) throw new Error(`Agent not found: ${authorEns}`);

  const branch = await queryOne<Branch>(
    'SELECT * FROM branches WHERE repo_id = $1 AND name = $2',
    [repoId, branchName]
  );
  if (!branch) throw new Error(`Branch "${branchName}" not found in repo ${repoId}`);

  // Find parent commit
  const parent = await queryOne<Commit>(
    'SELECT id FROM commits WHERE branch_id = $1 ORDER BY created_at DESC LIMIT 1',
    [branch.id]
  );

  // Store content in Fileverse
  const contentRef = await storeContent(content);

  // Process semantic features (unless skipped)
  let embedding: number[] | null = null;
  let semanticSummary: string | null = null;
  let tags: string[] = [];

  if (!skipSemantics && isEmbeddingsEnabled()) {
    try {
      const semantics = await processCommitSemantics(content, message);
      embedding = semantics.embedding;
      semanticSummary = semantics.summary;
      tags = semantics.tags;
    } catch (error) {
      console.error('Semantic processing failed:', error);
    }
  }

  // Build insert query with all v2+v3+v5 fields
  const [commit] = await query<Commit>(
    `INSERT INTO commits (
      repo_id, branch_id, author_agent_id, message, content_ref, content_type,
      parent_commit_id, embedding, semantic_summary, tags, reasoning_type,
      trace_prompt, trace_context, trace_tools, trace_result, knowledge_context,
      failure_context
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *`,
    [
      repoId,
      branch.id,
      author.id,
      message,
      contentRef,
      contentType,
      parent?.id ?? null,
      embedding ? `[${embedding.join(',')}]` : null,
      semanticSummary,
      tags,
      reasoningType ?? null,
      trace?.prompt ?? null,
      trace?.context ? JSON.stringify(trace.context) : null,
      trace?.tools ? JSON.stringify(trace.tools) : null,
      trace?.result ?? null,
      knowledgeContext ? JSON.stringify(knowledgeContext) : null,
      failureContext ? JSON.stringify(failureContext) : null,
    ]
  );

  return commit;
}

// ─── Read Memory ──────────────────────────────────────────────────────────────

export async function readMemory(
  repoId: string,
  _agentEns: string,
  branchName?: string
): Promise<Commit[]> {
  let branchFilter = '';
  const params: unknown[] = [repoId];

  if (branchName) {
    const branch = await queryOne<Branch>(
      'SELECT id FROM branches WHERE repo_id = $1 AND name = $2',
      [repoId, branchName]
    );
    if (branch) {
      params.push(branch.id);
      branchFilter = `AND c.branch_id = $${params.length}`;
    }
  }

  const commits = await query<Commit>(
    `SELECT c.*, a.ens_name as author_ens, b.name as branch_name
     FROM commits c
     JOIN agents a ON c.author_agent_id = a.id
     JOIN branches b ON c.branch_id = b.id
     WHERE c.repo_id = $1 ${branchFilter}
     ORDER BY c.created_at DESC`,
    params
  );

  for (const commit of commits) {
    commit.content = (await retrieveContent(commit.content_ref)) ?? '[content not found]';
  }

  return commits;
}

// ─── Semantic Search (v2) ─────────────────────────────────────────────────────

export async function searchCommits(
  repoId: string,
  queryText: string,
  limit: number = 10
): Promise<SearchResult[]> {
  // Try vector similarity search first
  if (isEmbeddingsEnabled()) {
    const queryEmbedding = await generateEmbedding(queryText);

    if (queryEmbedding) {
      const results = await query<Commit & { similarity: number }>(
        `SELECT c.*, a.ens_name as author_ens, b.name as branch_name,
                1 - (c.embedding <=> $1::vector) as similarity
         FROM commits c
         JOIN agents a ON c.author_agent_id = a.id
         JOIN branches b ON c.branch_id = b.id
         WHERE c.repo_id = $2 AND c.embedding IS NOT NULL
         ORDER BY c.embedding <=> $1::vector
         LIMIT $3`,
        [`[${queryEmbedding.join(',')}]`, repoId, limit]
      );

      return results.map(r => ({
        commit: r,
        similarity: r.similarity,
      }));
    }
  }

  // Fallback to full-text search
  const results = await query<Commit & { rank: number }>(
    `SELECT c.*, a.ens_name as author_ens, b.name as branch_name,
            ts_rank(c.search_vector, plainto_tsquery('english', $1)) as rank
     FROM commits c
     JOIN agents a ON c.author_agent_id = a.id
     JOIN branches b ON c.branch_id = b.id
     WHERE c.repo_id = $2 AND c.search_vector @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC
     LIMIT $3`,
    [queryText, repoId, limit]
  );

  return results.map(r => ({
    commit: r,
    similarity: Math.min(1, r.rank / 10), // Normalize rank to 0-1
  }));
}

// ─── Failure Memory Search (v5) ───────────────────────────────────────────────

/**
 * Search for commits tagged with failure context.
 * Helps agents learn from past failed approaches and avoid repeating them.
 */
export async function searchFailures(
  repoId: string,
  options: {
    errorType?: string;
    severity?: 'low' | 'medium' | 'high';
    limit?: number;
  } = {}
): Promise<Commit[]> {
  const { errorType, severity, limit = 20 } = options;

  let whereClause = 'WHERE c.repo_id = $1 AND c.failure_context IS NOT NULL AND (c.failure_context->>\'failed\')::boolean = true';
  const params: any[] = [repoId];

  if (errorType) {
    params.push(errorType);
    whereClause += ` AND c.failure_context->>'error_type' = $${params.length}`;
  }

  if (severity) {
    params.push(severity);
    whereClause += ` AND c.failure_context->>'severity' = $${params.length}`;
  }

  params.push(limit);

  const results = await query<Commit>(
    `SELECT c.*, a.ens_name as author_ens, b.name as branch_name
     FROM commits c
     JOIN agents a ON c.author_agent_id = a.id
     JOIN branches b ON c.branch_id = b.id
     ${whereClause}
     ORDER BY c.created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return results;
}

// ─── Reasoning Graph (v2) ─────────────────────────────────────────────────────

export async function getCommitGraph(
  repoId: string,
  rootCommitId?: string
): Promise<GraphNode[]> {
  // Get all commits with reasoning types
  const commits = await query<Commit>(
    `SELECT c.*, a.ens_name as author_ens, b.name as branch_name
     FROM commits c
     JOIN agents a ON c.author_agent_id = a.id
     JOIN branches b ON c.branch_id = b.id
     WHERE c.repo_id = $1 AND c.reasoning_type IS NOT NULL
     ORDER BY c.created_at ASC`,
    [repoId]
  );

  // Build adjacency map
  const commitMap = new Map<string, Commit>();
  const childrenMap = new Map<string, string[]>();

  for (const commit of commits) {
    commitMap.set(commit.id, commit);
    if (commit.parent_commit_id) {
      const children = childrenMap.get(commit.parent_commit_id) || [];
      children.push(commit.id);
      childrenMap.set(commit.parent_commit_id, children);
    }
  }

  // Build tree recursively
  function buildNode(commitId: string): GraphNode {
    const commit = commitMap.get(commitId)!;
    const childIds = childrenMap.get(commitId) || [];
    return {
      commit,
      children: childIds.map(id => buildNode(id)),
    };
  }

  // Find root nodes (commits without parents or with specified root)
  if (rootCommitId) {
    if (commitMap.has(rootCommitId)) {
      return [buildNode(rootCommitId)];
    }
    return [];
  }

  const roots = commits.filter(c => !c.parent_commit_id || !commitMap.has(c.parent_commit_id));
  return roots.map(c => buildNode(c.id));
}

// ─── Replay Trace (v2) ────────────────────────────────────────────────────────

export async function getCommitReplay(commitId: string): Promise<{
  commit: Commit;
  trace: TraceData | null;
  reasoningChain: Commit[];
}> {
  const commit = await queryOne<Commit>(
    `SELECT c.*, a.ens_name as author_ens, b.name as branch_name
     FROM commits c
     JOIN agents a ON c.author_agent_id = a.id
     JOIN branches b ON c.branch_id = b.id
     WHERE c.id = $1`,
    [commitId]
  );

  if (!commit) {
    throw new Error(`Commit not found: ${commitId}`);
  }

  // Resolve content
  commit.content = (await retrieveContent(commit.content_ref)) ?? '[content not found]';

  // Build trace data if available
  let trace: TraceData | null = null;
  if (commit.trace_prompt) {
    trace = {
      prompt: commit.trace_prompt,
      context: commit.trace_context || {},
      tools: commit.trace_tools || [],
      result: commit.trace_result || '',
    };
  }

  // Get reasoning chain (ancestors with reasoning types)
  const reasoningChain: Commit[] = [];
  let currentId: string | null = commit.parent_commit_id;

  while (currentId) {
    const parent = await queryOne<Commit>(
      `SELECT c.*, a.ens_name as author_ens, b.name as branch_name
       FROM commits c
       JOIN agents a ON c.author_agent_id = a.id
       JOIN branches b ON c.branch_id = b.id
       WHERE c.id = $1 AND c.reasoning_type IS NOT NULL`,
      [currentId]
    );

    if (parent) {
      parent.content = (await retrieveContent(parent.content_ref)) ?? '[content not found]';
      reasoningChain.unshift(parent);
      currentId = parent.parent_commit_id;
    } else {
      // Check if there's a non-reasoning parent to continue the chain
      const anyParent = await queryOne<{ parent_commit_id: string | null }>(
        'SELECT parent_commit_id FROM commits WHERE id = $1',
        [currentId]
      );
      currentId = anyParent?.parent_commit_id ?? null;
    }
  }

  return { commit, trace, reasoningChain };
}

// ─── Context Chain (v3) ───────────────────────────────────────────────────────

/**
 * Agent handoff segment — a sequence of commits by a single agent
 * before the next agent takes over.
 */
export interface HandoffSegment {
  agent: {
    id: string;
    ens_name: string;
    role: string | null;
  };
  commits: Array<{
    id: string;
    message: string;
    semantic_summary: string | null;
    reasoning_type: string | null;
    tags: string[];
    created_at: string;
    branch_name: string;
    knowledge_context: KnowledgeContext | null;
  }>;
  /** Summary of what this agent contributed */
  contribution_summary: string | null;
  /** Aggregated knowledge context from all commits in this segment */
  knowledge_brief: KnowledgeContext | null;
}

export interface ContextChain {
  repo_id: string;
  total_commits: number;
  total_agents: number;
  handoffs: HandoffSegment[];
}

/**
 * Get the context chain for a repository — all commits ordered chronologically,
 * grouped by consecutive agent handoffs. This shows how agents build on each
 * other's knowledge and when control passes between agents.
 */
export async function getContextChain(
  repoId: string,
  branchName?: string
): Promise<ContextChain> {
  let branchFilter = '';
  const params: any[] = [repoId];

  if (branchName) {
    const branch = await queryOne<Branch>(
      'SELECT id FROM branches WHERE repo_id = $1 AND name = $2',
      [repoId, branchName]
    );
    if (branch) {
      params.push(branch.id);
      branchFilter = `AND c.branch_id = $${params.length}`;
    }
  }

  const commits = await query<Commit & { author_role: string | null }>(
    `SELECT c.*, a.ens_name as author_ens, a.role as author_role, b.name as branch_name
     FROM commits c
     JOIN agents a ON c.author_agent_id = a.id
     JOIN branches b ON c.branch_id = b.id
     WHERE c.repo_id = $1 ${branchFilter}
     ORDER BY c.created_at ASC`,
    params
  );

  // Group consecutive commits by the same agent into handoff segments
  const handoffs: HandoffSegment[] = [];
  let currentSegment: HandoffSegment | null = null;

  for (const commit of commits) {
    if (!currentSegment || currentSegment.agent.id !== commit.author_agent_id) {
      // New agent handoff
      currentSegment = {
        agent: {
          id: commit.author_agent_id,
          ens_name: commit.author_ens || '',
          role: (commit as any).author_role || null,
        },
        commits: [],
        contribution_summary: null,
        knowledge_brief: null,
      };
      handoffs.push(currentSegment);
    }

    currentSegment.commits.push({
      id: commit.id,
      message: commit.message,
      semantic_summary: commit.semantic_summary || null,
      reasoning_type: commit.reasoning_type || null,
      tags: commit.tags || [],
      created_at: commit.created_at,
      branch_name: commit.branch_name || '',
      knowledge_context: commit.knowledge_context || null,
    });
  }

  // Build contribution summaries and aggregate knowledge briefs
  for (const segment of handoffs) {
    const summaries = segment.commits
      .filter(c => c.semantic_summary)
      .map(c => c.semantic_summary!);
    if (summaries.length > 0) {
      segment.contribution_summary = summaries[summaries.length - 1];
    }

    // Aggregate knowledge_context from all commits in this segment
    const knowledgeCommits = segment.commits.filter(c => c.knowledge_context);
    if (knowledgeCommits.length > 0) {
      const aggregated: KnowledgeContext = {
        decisions: [],
        libraries: [],
        open_questions: [],
        next_steps: [],
        dependencies: [],
      };
      for (const kc of knowledgeCommits) {
        const kctx = kc.knowledge_context!;
        if (kctx.decisions) aggregated.decisions!.push(...kctx.decisions);
        if (kctx.libraries) aggregated.libraries!.push(...kctx.libraries);
        if (kctx.open_questions) aggregated.open_questions!.push(...kctx.open_questions);
        if (kctx.next_steps) aggregated.next_steps!.push(...kctx.next_steps);
        if (kctx.dependencies) aggregated.dependencies!.push(...kctx.dependencies);
        if (kctx.architecture) aggregated.architecture = kctx.architecture;
        if (kctx.handoff_summary) aggregated.handoff_summary = kctx.handoff_summary;
      }
      // Deduplicate arrays
      aggregated.decisions = [...new Set(aggregated.decisions)];
      aggregated.libraries = [...new Set(aggregated.libraries)];
      aggregated.open_questions = [...new Set(aggregated.open_questions)];
      aggregated.next_steps = [...new Set(aggregated.next_steps)];
      aggregated.dependencies = [...new Set(aggregated.dependencies)];

      segment.knowledge_brief = aggregated;
    }
  }

  // Count unique agents
  const uniqueAgents = new Set(commits.map(c => c.author_agent_id));

  return {
    repo_id: repoId,
    total_commits: commits.length,
    total_agents: uniqueAgents.size,
    handoffs,
  };
}

// ─── Pull Request ─────────────────────────────────────────────────────────────

export async function openPullRequest(
  repoId: string,
  sourceBranchName: string,
  targetBranchName: string,
  description: string,
  authorEns: string
): Promise<PullRequest> {
  const author = await getAgent(authorEns);
  if (!author) throw new Error(`Agent not found: ${authorEns}`);

  const source = await queryOne<Branch>(
    'SELECT * FROM branches WHERE repo_id = $1 AND name = $2',
    [repoId, sourceBranchName]
  );
  if (!source) throw new Error(`Branch "${sourceBranchName}" not found`);

  const target = await queryOne<Branch>(
    'SELECT * FROM branches WHERE repo_id = $1 AND name = $2',
    [repoId, targetBranchName]
  );
  if (!target) throw new Error(`Branch "${targetBranchName}" not found`);

  const [pr] = await query<PullRequest>(
    `INSERT INTO pull_requests (repo_id, source_branch_id, target_branch_id, author_agent_id, description)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [repoId, source.id, target.id, author.id, description]
  );

  return pr;
}

export async function mergePullRequest(
  prId: string,
  reviewerEns: string
): Promise<PullRequest> {
  const reviewer = await getAgent(reviewerEns);
  if (!reviewer) throw new Error(`Reviewer agent not found: ${reviewerEns}`);

  const pr = await queryOne<PullRequest>('SELECT * FROM pull_requests WHERE id = $1', [prId]);
  if (!pr) throw new Error(`Pull request not found: ${prId}`);
  if (pr.status !== 'open') throw new Error(`PR is already ${pr.status}`);

  const [merged] = await query<PullRequest>(
    `UPDATE pull_requests
     SET status = 'merged', reviewer_agent_id = $1, merged_at = NOW()
     WHERE id = $2 RETURNING *`,
    [reviewer.id, prId]
  );

  // Bump reviewer reputation for completing a review
  await query(
    `UPDATE agents SET reputation_score = reputation_score + 5 WHERE id = $1`,
    [reviewer.id]
  );

  return merged;
}
