// ── API Client for AgentBranch ─────────────────────────────────
// Used by client components. Server components can use fetch() directly.

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
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
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const msg =
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      `Request failed: ${res.status}`;
    const err = new Error(msg) as ApiError;
    err.status = res.status;
    if (typeof body.code === "string") err.code = body.code;
    if (typeof body.github_message === "string")
      err.github_message = body.github_message;
    if (typeof body.github_status === "number")
      err.github_status = body.github_status;
    throw err;
  }

  return res.json() as Promise<T>;
}

export interface ApiError extends Error {
  status: number;
  code?: string;
  github_message?: string;
  github_status?: number;
}

export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface Paginated<T> {
  data: T[];
  pagination: PaginationMeta;
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
  created_at: string;
  github_owner?: string | null;
  github_repo?: string | null;
  github_default_branch?: string | null;
  github_hook_id?: number | null;
}

export interface GitHubAccessibleRepo {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
}

export interface GitHubUserReposPage {
  items: GitHubAccessibleRepo[];
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
}

export interface RepoImportResult extends Repository {
  webhook: {
    action: "created" | "updated";
    hook_id: number;
    callback_url: string;
  };
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
  code_quality_score?: number;
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
  code_quality_score: number;
  test_quality_score: number;
  code_quality?: number;
  test_pass_rate?: number;
}

export interface LeaderboardResponse {
  data: LeaderboardEntry[];
  pagination: PaginationMeta;
  timeframe?: string;
  sort_by?: string;
  order?: string;
}

export interface LeaderboardStats {
  total_agents: number;
  total_points: number;
  total_issues: number;
  total_repositories?: number;
}

export interface AgentProfile extends Agent {
  rank: number;
  total_points: number;
  issues_completed: number;
  judgements: Judgement[];
  contributions: {
    id: string;
    name: string;
    commit_count: number;
    pr_count: number;
  }[];
}

export interface CreateAgentInput {
  ens_name: string;
  role?: string;
  capabilities?: string[];
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
  list: (opts?: { limit?: number; offset?: number; mine?: boolean }) => {
    const p = new URLSearchParams();
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    if (opts?.mine) p.set("mine", "1");
    const qs = p.toString();
    return api.get<Paginated<Agent>>(`/agents${qs ? `?${qs}` : ""}`);
  },
  get: (ens: string) => api.get<Agent>(`/agents/${ens}`),
  create: (data: CreateAgentInput) => api.post<Agent>("/agents", data),
  patch: (ens: string, body: Partial<CreateAgentInput> & { max_bounty_spend?: number | null }) =>
    api.patch<Agent>(`/agents/${encodeURIComponent(ens)}`, body),
};

export interface GitJob {
  id: string;
  issue_id: string;
  repo_id: string;
  user_id: string;
  agent_id: string;
  base_branch: string;
  status: string;
  stage: string;
  branch_name?: string | null;
  github_pr_number?: number | null;
  error_message?: string | null;
  created_at: string;
  updated_at: string;
}

export const repoApi = {
  list: (opts?: { limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return api.get<Paginated<Repository>>(`/repositories${qs ? `?${qs}` : ""}`);
  },
  importFromGitHub: (body: {
    github_owner: string;
    github_repo: string;
    github_default_branch?: string;
    name?: string;
    description?: string;
  }) => api.post<RepoImportResult>("/repositories/import-from-github", body),
  get: (id: string) => api.get<Repository>(`/repositories/${id}`),
  gitJobs: (
    repoId: string,
    opts?: { issue_id?: string; status?: string; limit?: number; offset?: number },
  ) => {
    const p = new URLSearchParams();
    if (opts?.issue_id) p.set("issue_id", opts.issue_id);
    if (opts?.status) p.set("status", opts.status);
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return api.get<Paginated<GitJob>>(
      `/repositories/${repoId}/git-jobs${qs ? `?${qs}` : ""}`,
    );
  },
};

export const issueApi = {
  list: (
    repoId: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ) => {
    const p = new URLSearchParams();
    if (opts?.status) p.set("status", opts.status);
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return api.get<Paginated<Issue>>(
      `/repositories/${repoId}/issues${qs ? `?${qs}` : ""}`,
    );
  },
  get: (repoId: string, issueId: string) =>
    api.get<Issue & { judgements?: Judgement[] }>(
      `/repositories/${repoId}/issues/${issueId}`,
    ),
  create: (
    repoId: string,
    data: { title: string; body?: string; scorecard?: Scorecard },
  ) => api.post<Issue>(`/repositories/${repoId}/issues`, data),
  update: (repoId: string, issueId: string, data: Partial<Issue>) =>
    api.patch<Issue>(`/repositories/${repoId}/issues/${issueId}`, data),
  assign: (repoId: string, issueId: string, agentEns: string) =>
    api.post(`/repositories/${repoId}/issues/${issueId}/assign`, {
      agent_ens: agentEns,
    }),
  submit: (
    repoId: string,
    issueId: string,
    data: { agent_ens: string; content: string },
  ) => api.post(`/repositories/${repoId}/issues/${issueId}/submit`, data),
  close: (
    repoId: string,
    issueId: string,
    data: { agent_ens: string; submission_content?: string },
  ) => api.post(`/repositories/${repoId}/issues/${issueId}/close`, data),
  resolve: (
    repoId: string,
    issueId: string,
    body?: {
      mode?: "plan_only" | "execute";
      agent_ens?: string;
      base_branch?: string;
      fanout_children?: boolean;
      idempotency_key?: string;
      max_attempts?: number;
    },
  ) =>
    api.post<unknown>(
      `/repositories/${repoId}/issues/${issueId}/resolve`,
      body ?? {},
    ),
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
    },
  ) =>
    api.post<IssueBounty>(
      `/repositories/${repoId}/issues/${issueId}/bounty`,
      data,
    ),
  submit: (
    repoId: string,
    issueId: string,
    data: { agent_ens: string; content: string },
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

export const leaderboardApi = {
  get: async (
    limit?: number,
    offset?: number,
    timeframe?: string,
    sort_by?: string,
    order?: "asc" | "desc",
  ) => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (offset) params.set("offset", String(offset));
    if (timeframe) params.set("timeframe", timeframe);
    if (sort_by) params.set("sort_by", sort_by);
    if (order) params.set("order", order);
    const qs = params.toString();
    const response = await api.get<LeaderboardResponse | LeaderboardEntry[]>(
      `/leaderboard${qs ? `?${qs}` : ""}`,
    );

    if (Array.isArray(response)) {
      return response;
    }

    return Array.isArray(response.data) ? response.data : [];
  },
  getPage: async (
    limit?: number,
    offset?: number,
    timeframe?: string,
    sort_by?: string,
    order?: "asc" | "desc",
  ): Promise<LeaderboardResponse> => {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    if (offset) params.set("offset", String(offset));
    if (timeframe) params.set("timeframe", timeframe);
    if (sort_by) params.set("sort_by", sort_by);
    if (order) params.set("order", order);
    const qs = params.toString();
    return api.get<LeaderboardResponse>(`/leaderboard${qs ? `?${qs}` : ""}`);
  },
  stats: () => api.get<LeaderboardStats>("/leaderboard/stats"),
  agentProfile: (ens: string) =>
    api.get<AgentProfile>(`/leaderboard/agents/${ens}`),
};

export interface AuthMeResponse {
  user: { id: string; username: string; created_at?: string };
  agents: Agent[];
  github: { api_key_configured: boolean };
}

export const authApi = {
  register: (username: string, password: string) =>
    api.post<{ token: string; user: { id: string; username: string } }>(
      "/auth/register",
      { username, password },
    ),
  login: (username: string, password: string) =>
    api.post<{ token: string; user: { id: string; username: string } }>(
      "/auth/login",
      { username, password },
    ),
  me: () => api.get<AuthMeResponse>("/auth/me"),
  setGithubApiKey: (github_api_key: string | null) =>
    api.patch<{ message: string; github: { api_key_configured: boolean } }>(
      "/auth/github-api-key",
      { github_api_key },
    ),
};

export const integrationsApi = {
  listGithubRepos: (page = 1, perPage = 30) =>
    api.get<GitHubUserReposPage>(
      `/integrations/github/repos?page=${page}&per_page=${perPage}`,
    ),
};

/** GET /blockchain/config (backend getBlockchainConfig + token) */
export interface BlockchainConfig {
  enabled: boolean;
  chainId: number;
  rpcUrl: string | null;
  abtContract: string | null;
  bountyContract: string | null;
  token: {
    name: string;
    symbol: string;
    decimals: number;
    mock: boolean;
  };
}

export interface OnchainEventRow {
  id: string;
  chain_id: string;
  block_number: string;
  tx_hash: string;
  log_index: number;
  contract_address: string;
  event_name: string;
  payload: Record<string, unknown>;
  bounty_id: string | null;
  ens_name: string | null;
  issue_id: string | null;
  agent_id: string | null;
  created_at: string;
}

export const blockchainApi = {
  config: () => api.get<BlockchainConfig>("/blockchain/config"),
  registerAgent: (data: CreateAgentInput & { deposit_tx_hash?: string }) =>
    api.post<Agent>("/blockchain/register-agent", data),
  onchainEvents: (opts?: {
    limit?: number;
    offset?: number;
    event_name?: string;
  }) => {
    const p = new URLSearchParams();
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    if (opts?.event_name) p.set("event_name", opts.event_name);
    const qs = p.toString();
    return api.get<Paginated<OnchainEventRow>>(
      `/blockchain/onchain-events${qs ? `?${qs}` : ""}`,
    );
  },
};
