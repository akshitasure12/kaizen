// ── API Client for AgentBranch ─────────────────────────────────
// Used by client components. Server components can use fetch() directly.

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token =
    typeof window !== "undefined" ? localStorage.getItem("ab_token") : null;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(
      (body as Record<string, string>).error ?? `Request failed: ${res.status}`
    );
    (err as ApiError).status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

export interface ApiError extends Error {
  status: number;
}

// ── Types ──────────────────────────────────────────────────────

export interface Agent {
  id: string;
  ens_name: string;
  role: string;
  capabilities: string[];
  reputation_score: number;
  deposit_verified?: boolean;
  total_earnings?: number;
  wallet_balance?: number;
  max_bounty_spend?: number | null;
  created_at: string;
}

export interface Repository {
  id: string;
  name: string;
  description?: string;
  owner_ens?: string;
  bounty_pool?: number;
  branch_count?: number;
  commit_count?: number;
  open_issues?: number;
  repo_type?: "general" | "academia";
  academia_field?: string;
  created_at: string;
}

export interface Branch {
  id: string;
  name: string;
  commit_count?: number;
  created_at: string;
}

export interface KnowledgeContext {
  decisions?: string[];
  architecture?: string;
  libraries?: string[];
  open_questions?: string[];
  next_steps?: string[];
  dependencies?: string[];
  handoff_summary?: string;
}

export interface FailureContext {
  failed: boolean;
  error_type?: string;
  error_detail?: string;
  failed_approach?: string;
  root_cause?: string;
  severity?: "low" | "medium" | "high";
}

export interface CheckResult {
  name: string;
  status: "passed" | "failed" | "warning" | "skipped";
  severity: "info" | "warning" | "critical";
  message: string;
  details?: Record<string, unknown>;
}

export interface WorkflowRun {
  id: string;
  repo_id: string;
  commit_id: string | null;
  pr_id: string | null;
  event_type: "commit" | "pr_open" | "pr_merge";
  status: string;
  checks: CheckResult[];
  summary: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
}

export interface Commit {
  id: string;
  repo_id: string;
  branch_id: string;
  message: string;
  content?: string;
  content_type?: string;
  author_ens?: string;
  branch_name?: string;
  semantic_summary?: string;
  tags?: string[];
  reasoning_type?: "knowledge" | "hypothesis" | "experiment" | "conclusion" | "trace";
  trace_prompt?: string;
  trace_context?: Record<string, unknown>;
  trace_tools?: string[];
  trace_result?: string;
  knowledge_context?: KnowledgeContext;
  failure_context?: FailureContext;
  parent_commit_id?: string;
  created_at: string;
}

export interface PullRequest {
  id: string;
  repo_id: string;
  description?: string;
  status: "open" | "approved" | "merged" | "rejected";
  bounty_amount?: number;
  author_ens?: string;
  reviewer_ens?: string;
  source_branch_name?: string;
  target_branch_name?: string;
  created_at: string;
  merged_at?: string;
}

export interface Issue {
  id: string;
  repo_id: string;
  title: string;
  body?: string;
  status: "open" | "in_progress" | "closed" | "cancelled";
  scorecard?: Scorecard;
  assigned_agent_id?: string;
  assigned_agent_ens?: string;
  created_at: string;
  closed_at?: string;
}

export interface Scorecard {
  difficulty?: "easy" | "medium" | "hard" | "expert";
  base_points?: number;
  unit_tests?: { name: string; points: number }[];
  bonus_criteria?: string[];
  bonus_points_per_criterion?: number;
  time_limit_hours?: number;
  required_language?: string;
  importance?: "P0" | "P1" | "P2" | "P3" | "P4";
}

export interface Judgement {
  id: string;
  issue_id: string;
  agent_id: string;
  verdict: JudgeVerdict;
  points_awarded: number;
  judged_at: string;
}

export interface JudgeVerdict {
  passed_tests?: string[];
  failed_tests?: string[];
  bonus_achieved?: string[];
  bonus_missed?: string[];
  code_quality?: number;
  reasoning?: string;
  suggestions?: string[];
  points_awarded?: number;
  agent_ens?: string;
}

export interface LeaderboardEntry {
  rank: number;
  agent_id: string;
  ens_name: string;
  role: string;
  reputation_score: number;
  total_points: number;
  issues_completed: number;
  deposit_verified: boolean;
  code_quality: number;
  test_pass_rate: number;
  academic_contribution: number;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  pagination?: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  timeframe?: string;
}

export interface LeaderboardStats {
  total_agents: number;
  total_points: number;
  total_issues: number;
  total_repositories?: number;
  academia_repositories?: number;
}

export interface AgentProfile extends Agent {
  rank: number;
  total_points: number;
  issues_completed: number;
  academic_contribution: number;
  judgements: Judgement[];
  contributions: {
    id: string;
    name: string;
    commit_count: number;
    pr_count: number;
    repo_type?: "general" | "academia";
    academia_field?: string;
  }[];
}

export interface WalletInfo {
  balance: number;
  spending_cap: number | null;
  transactions: WalletTransaction[];
}

export interface WalletTransaction {
  id: string;
  amount: number;
  tx_type: string;
  note?: string;
  created_at: string;
}

export interface IssueBounty {
  id: string;
  issue_id: string;
  poster_agent_id: string;
  poster_ens?: string;
  amount: number;
  deadline: string;
  max_submissions: number;
  status: "funded" | "judging" | "awarded" | "expired" | "cancelled";
  winner_agent_id?: string;
  winner_ens?: string;
  created_at: string;
  submissions?: BountySubmission[];
}

export interface BountySubmission {
  id: string;
  agent_id: string;
  agent_ens?: string;
  content: string;
  judge_verdict?: JudgeVerdict;
  points_awarded: number;
  submitted_at: string;
}

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
  contribution_summary: string | null;
  knowledge_brief: KnowledgeContext | null;
}

export interface ContextChain {
  repo_id: string;
  total_commits: number;
  total_agents: number;
  handoffs: HandoffSegment[];
}

// ── API Functions ──────────────────────────────────────────────

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  del: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "DELETE",
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
};

export const agentApi = {
  list: () => api.get<Agent[]>("/agents"),
  get: (ens: string) => api.get<Agent>(`/agents/${ens}`),
  create: (data: { ens_name: string; role: string; capabilities: string[] }) =>
    api.post<Agent>("/agents", data),
};

export const repoApi = {
  list: (type?: "general" | "academia") => {
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    const qs = params.toString();
    return api.get<Repository[]>(`/repositories${qs ? `?${qs}` : ""}`);
  },
  get: (id: string) => api.get<Repository>(`/repositories/${id}`),
  branches: (id: string) => api.get<Branch[]>(`/repositories/${id}/branches`),
  commits: (id: string, agentEns: string, branch?: string) => {
    let path = `/repositories/${id}/commits?agent_ens=${agentEns}`;
    if (branch) path += `&branch=${branch}`;
    return api.get<Commit[]>(path);
  },
  searchCommits: (id: string, query: string) =>
    api.get<(Commit & { similarity?: number })[]>(
      `/repositories/${id}/commits/search?q=${encodeURIComponent(query)}`
    ),
  commitGraph: (id: string) =>
    api.get<unknown[]>(`/repositories/${id}/commits/graph`),
  contextChain: (id: string, branch?: string) => {
    let path = `/repositories/${id}/context-chain`;
    if (branch) path += `?branch=${encodeURIComponent(branch)}`;
    return api.get<ContextChain>(path);
  },
  searchFailures: (id: string, options?: { error_type?: string; severity?: string; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.error_type) params.set("error_type", options.error_type);
    if (options?.severity) params.set("severity", options.severity);
    if (options?.limit) params.set("limit", String(options.limit));
    const qs = params.toString();
    return api.get<Commit[]>(`/repositories/${id}/commits/failures${qs ? `?${qs}` : ""}`);
  },
  workflowRuns: (id: string, limit?: number) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const qs = params.toString();
    return api.get<WorkflowRun[]>(`/repositories/${id}/workflow-runs${qs ? `?${qs}` : ""}`);
  },
  commitWorkflow: (repoId: string, commitId: string) =>
    api.get<WorkflowRun>(`/repositories/${repoId}/commits/${commitId}/workflow`),
};

export const issueApi = {
  list: (repoId: string, status?: string) => {
    let path = `/repositories/${repoId}/issues`;
    if (status) path += `?status=${status}`;
    return api.get<Issue[]>(path);
  },
  get: (repoId: string, issueId: string) =>
    api.get<Issue & { judgements?: Judgement[] }>(
      `/repositories/${repoId}/issues/${issueId}`
    ),
  create: (
    repoId: string,
    data: { title: string; body?: string; scorecard?: Scorecard }
  ) => api.post<Issue>(`/repositories/${repoId}/issues`, data),
  update: (repoId: string, issueId: string, data: Partial<Issue>) =>
    api.patch<Issue>(`/repositories/${repoId}/issues/${issueId}`, data),
  assign: (repoId: string, issueId: string, agentEns: string) =>
    api.post(`/repositories/${repoId}/issues/${issueId}/assign`, {
      agent_ens: agentEns,
    }),
  submit: (repoId: string, issueId: string, data: { agent_ens: string; content: string }) =>
    api.post(`/repositories/${repoId}/issues/${issueId}/submit`, data),
  close: (
    repoId: string,
    issueId: string,
    data: { agent_ens: string; submission_content?: string }
  ) => api.post(`/repositories/${repoId}/issues/${issueId}/close`, data),
};

export const bountyApi = {
  get: (repoId: string, issueId: string) =>
    api.get<IssueBounty>(`/repositories/${repoId}/issues/${issueId}/bounty`),
  post: (
    repoId: string,
    issueId: string,
    data: {
      agent_ens: string;
      amount: number;
      deadline_hours: number;
      max_submissions?: number;
    }
  ) => api.post<IssueBounty>(`/repositories/${repoId}/issues/${issueId}/bounty`, data),
  submit: (
    repoId: string,
    issueId: string,
    data: { agent_ens: string; content: string }
  ) =>
    api.post(`/repositories/${repoId}/issues/${issueId}/bounty-submit`, data),
  judge: (repoId: string, issueId: string) =>
    api.post(`/repositories/${repoId}/issues/${issueId}/bounty-judge`),
  cancel: (repoId: string, issueId: string, agentEns: string) =>
    api.del(`/repositories/${repoId}/issues/${issueId}/bounty`, {
      agent_ens: agentEns,
    }),
};

export const walletApi = {
  get: (ens: string) => api.get<WalletInfo>(`/agents/${ens}/wallet`),
  deposit: (ens: string, amount: number, note?: string) =>
    api.post(`/agents/${ens}/deposit`, { amount, note }),
  setCap: (ens: string, spending_cap: number | null) =>
    api.patch(`/agents/${ens}/wallet`, { spending_cap }),
};

export const prApi = {
  list: (repoId: string, status?: string) => {
    let path = `/repositories/${repoId}/pulls`;
    if (status) path += `?status=${status}`;
    return api.get<PullRequest[]>(path);
  },
  get: (repoId: string, prId: string) =>
    api.get<PullRequest>(`/repositories/${repoId}/pulls/${prId}`),
  merge: (repoId: string, prId: string, reviewerEns: string) =>
    api.post(`/repositories/${repoId}/pulls/${prId}/merge`, {
      reviewer_ens: reviewerEns,
    }),
  reject: (repoId: string, prId: string, reviewerEns: string) =>
    api.post(`/repositories/${repoId}/pulls/${prId}/reject`, {
      reviewer_ens: reviewerEns,
    }),
};

export const leaderboardApi = {
  get: async (limit?: number, offset?: number, timeframe?: string, sort_by?: string, order?: "asc" | "desc") => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (offset) params.set("offset", String(offset));
    if (timeframe) params.set("timeframe", timeframe);
    if (sort_by) params.set("sort_by", sort_by);
    if (order) params.set("order", order);
    const qs = params.toString();
    const response = await api.get<LeaderboardResponse | LeaderboardEntry[]>(
      `/leaderboard${qs ? `?${qs}` : ""}`
    );

    if (Array.isArray(response)) {
      return response;
    }

    return Array.isArray(response.entries) ? response.entries : [];
  },
  stats: () => api.get<LeaderboardStats>("/leaderboard/stats"),
  agentProfile: (ens: string) =>
    api.get<AgentProfile>(`/leaderboard/agents/${ens}`),
};

export const authApi = {
  register: (username: string, password: string) =>
    api.post<{ token: string; user: { id: string; username: string } }>(
      "/auth/register",
      { username, password }
    ),
  login: (username: string, password: string) =>
    api.post<{ token: string; user: { id: string; username: string } }>(
      "/auth/login",
      { username, password }
    ),
  me: () =>
    api.get<{ user: { id: string; username: string }; agents: Agent[] }>(
      "/auth/me"
    ),
};

export const blockchainApi = {
  config: () => api.get<BlockchainConfig>("/blockchain/config"),
  registerAgent: (data: {
    ens_name: string;
    role: string;
    capabilities: string[];
    tx_hash: string;
  }) => api.post<Agent>("/blockchain/register-agent", data),
  mockTx: () => api.post<{ tx_hash: string }>("/blockchain/mock-tx"),
};

// ── v7 Types: BitGo Wallets ──────────────────────────────────

/** Matches backend AgentWallet shape from bitgo-wallet.ts */
export interface BitGoWallet {
  walletId: string;
  address: string;
  coin: string;
  label: string;
  createdAt: string;
}

/** Matches backend WalletListItem shape (GET /blockchain/wallets) */
export interface BitGoWalletListItem {
  walletId: string;
  address: string;
  label: string;
  balance: string;
}

/** Matches backend WalletBalance shape */
export interface BitGoBalance {
  walletId: string;
  address: string;
  coin: string;
  balance: string;
  balanceFormatted: string;
  confirmedBalance: string;
  spendableBalance: string;
}

/** Matches backend TransactionResult shape */
export interface BitGoSendResult {
  txId: string;
  txHash: string;
  status: string;
  from: string;
  to: string;
  amount: string;
  coin: string;
  fee?: string;
}

/** Matches backend getBitGoConfig() shape */
export interface BitGoConfig {
  enabled: boolean;
  env: string;
  coin: string;
  apiBase: string;
  enterpriseId: string | null;
  walletCount: number;
}

// ── v7 Types: x402 Payment Protocol ──────────────────────────

export interface X402Config {
  enabled: boolean;
  facilitator: string;
  network: string;
  treasury: string;
  protectedRoutes: {
    route: string;
    price: string;
    description: string;
  }[];
}

export interface X402PaymentRecord {
  id: string;
  route: string;
  payerAddress: string;
  amount: string;
  network: string;
  txHash: string | null;
  settledAt: string;
  status: "verified" | "settled" | "failed";
}

export interface X402PaymentStats {
  totalPayments: number;
  settled: number;
  failed: number;
  byRoute: Record<string, number>;
}

// ── v7 Types: Blockchain Config ──────────────────────────────

/** Matches backend GET /blockchain/config response shape exactly */
export interface BlockchainConfig {
  chain: string;
  chainId: number;
  rpcUrl: string;
  abtContract: string | null;
  bountyContract: string | null;
  treasury: string;
  requiredDeposit: string;
  blockchainEnabled: boolean;
  bountyContractEnabled: boolean;
  token: {
    name: string;
    symbol: string;
    decimals: number;
    contractAddress: string;
  } | null;
  bitgo: BitGoConfig;
}

// ── v7 API: BitGo Wallets ────────────────────────────────────

export const bitgoWalletApi = {
  /** Create a new BitGo wallet for an agent */
  create: (agentId: string, label: string) =>
    api.post<{ message: string; wallet: BitGoWallet }>(
      "/blockchain/wallets/create",
      { agent_id: agentId, label }
    ),
  /** Get wallet info for an agent */
  get: (agentId: string) =>
    api.get<BitGoWallet>(`/blockchain/wallets/${agentId}`),
  /** Get wallet balance for an agent */
  balance: (agentId: string) =>
    api.get<BitGoBalance>(`/blockchain/wallets/${agentId}/balance`),
  /** Send a transaction from an agent's wallet */
  send: (agentId: string, toAddress: string, amountWei: string, note?: string) =>
    api.post<{ message: string; transaction: BitGoSendResult }>(
      `/blockchain/wallets/${agentId}/send`,
      { to_address: toAddress, amount_wei: amountWei, note }
    ),
  /** List all agent wallets */
  list: () =>
    api.get<{ bitgo_enabled: boolean; wallets: BitGoWalletListItem[] }>(
      "/blockchain/wallets"
    ),
};

// ── v7 API: x402 Payment Protocol ────────────────────────────

export const x402Api = {
  /** Get x402 configuration and protected routes */
  config: () => api.get<X402Config>("/x402/config"),
  /** Get recent payment log */
  payments: () =>
    api.get<{ total: number; payments: X402PaymentRecord[] }>("/x402/payments"),
  /** Get payment statistics */
  stats: () => api.get<X402PaymentStats>("/x402/payments/stats"),
};
