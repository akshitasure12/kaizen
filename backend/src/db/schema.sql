-- Kaizen — full schema (fresh install).
-- Run via `bun run migrate` against an empty or disposable database.
-- commits.embedding uses type vector(1536): install pgvector (CREATE EXTENSION vector) or migrate will fail at commits.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION
  WHEN undefined_file THEN
    RAISE NOTICE 'pgvector not available; commits.embedding must use float[] (change column type if needed)';
END $$;

-- ─── teardown (dependency order: leaves first) ─────────────────────────────
DROP TABLE IF EXISTS tool_execution_logs CASCADE;
DROP TABLE IF EXISTS onchain_events CASCADE;
DROP TABLE IF EXISTS onchain_indexer_state CASCADE;
DROP TABLE IF EXISTS agent_reputation_snapshots CASCADE;
DROP TABLE IF EXISTS agent_outcomes CASCADE;
DROP TABLE IF EXISTS merge_settlement_events CASCADE;
DROP TABLE IF EXISTS bounty_submissions CASCADE;
DROP TABLE IF EXISTS issue_bounties CASCADE;
DROP TABLE IF EXISTS wallet_transactions CASCADE;
DROP TABLE IF EXISTS workflow_runs CASCADE;
DROP TABLE IF EXISTS git_jobs CASCADE;
DROP TABLE IF EXISTS judge_results CASCADE;
DROP TABLE IF EXISTS issue_judgements CASCADE;
DROP TABLE IF EXISTS agent_scores CASCADE;
DROP TABLE IF EXISTS issues CASCADE;
DROP TABLE IF EXISTS bounty_ledger CASCADE;
DROP TABLE IF EXISTS commits CASCADE;
DROP TABLE IF EXISTS pull_requests CASCADE;
DROP TABLE IF EXISTS branches CASCADE;
DROP TABLE IF EXISTS repositories CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS users CASCADE;

DROP FUNCTION IF EXISTS update_commit_search_vector() CASCADE;

-- ─── users ─────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  github_api_key TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);

-- ─── agents ─────────────────────────────────────────────────────────────────
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ens_name VARCHAR(255) UNIQUE NOT NULL,
  role VARCHAR(100),
  capabilities TEXT[],
  reputation_score INTEGER DEFAULT 0,
  wallet_balance NUMERIC(18, 4) DEFAULT 0,
  max_bounty_spend NUMERIC(18, 4) DEFAULT NULL,
  deposit_tx_hash VARCHAR(66),
  deposit_verified BOOLEAN DEFAULT FALSE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agents_user ON agents(user_id);

-- ─── repositories ───────────────────────────────────────────────────────────
CREATE TABLE repositories (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  owner_agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  bounty_pool NUMERIC(18, 4) DEFAULT 0,
  github_owner VARCHAR(255),
  github_repo VARCHAR(255),
  github_default_branch VARCHAR(255) DEFAULT 'main',
  github_hook_id BIGINT,
  imported_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_repositories_github_remote
  ON repositories (lower(github_owner), lower(github_repo))
  WHERE github_owner IS NOT NULL AND github_repo IS NOT NULL;

CREATE INDEX idx_repositories_imported_by ON repositories(imported_by_user_id);

-- GitHub: fine-grained PAT on `users.github_api_key` + `repositories.github_*` (import-from-github) + repo webhooks.

-- ─── branches ───────────────────────────────────────────────────────────────
CREATE TABLE branches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  base_branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES agents(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (repo_id, name)
);

CREATE INDEX idx_branches_repo ON branches(repo_id);

-- ─── commits (embedding: vector if pgvector loaded; else use float[]) ───────
CREATE TABLE commits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  author_agent_id UUID NOT NULL REFERENCES agents(id),
  message TEXT NOT NULL,
  content_ref TEXT NOT NULL,
  content_type VARCHAR(50) DEFAULT 'text',
  parent_commit_id UUID REFERENCES commits(id) ON DELETE SET NULL,
  embedding vector(1536),
  semantic_summary TEXT,
  tags TEXT[] DEFAULT '{}',
  reasoning_type VARCHAR(20),
  trace_prompt TEXT,
  trace_context JSONB,
  trace_tools JSONB,
  trace_result TEXT,
  knowledge_context JSONB,
  failure_context JSONB,
  search_vector tsvector,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_commits_branch ON commits(branch_id);
CREATE INDEX idx_commits_repo ON commits(repo_id);
CREATE INDEX idx_commits_reasoning_type ON commits(reasoning_type) WHERE reasoning_type IS NOT NULL;
CREATE INDEX idx_commits_tags ON commits USING gin(tags);

CREATE OR REPLACE FUNCTION update_commit_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', COALESCE(NEW.message, '') || ' ' || COALESCE(NEW.semantic_summary, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commit_search_vector_trigger
  BEFORE INSERT OR UPDATE ON commits
  FOR EACH ROW
  EXECUTE FUNCTION update_commit_search_vector();

CREATE INDEX idx_commits_search ON commits USING gin(search_vector);

-- ─── pull_requests, bounty_ledger ───────────────────────────────────────────
CREATE TABLE pull_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_branch_id UUID NOT NULL REFERENCES branches(id),
  target_branch_id UUID NOT NULL REFERENCES branches(id),
  author_agent_id UUID NOT NULL REFERENCES agents(id),
  reviewer_agent_id UUID REFERENCES agents(id),
  description TEXT,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open','approved','merged','rejected')),
  bounty_amount NUMERIC(18, 4) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  merged_at TIMESTAMPTZ
);

CREATE TABLE bounty_ledger (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  amount NUMERIC(18, 4) NOT NULL,
  tx_type VARCHAR(20) NOT NULL CHECK (tx_type IN ('deposit','escrow','release','slash')),
  pr_id UUID REFERENCES pull_requests(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_prs_repo ON pull_requests(repo_id);
CREATE INDEX idx_ledger_repo ON bounty_ledger(repo_id);
CREATE INDEX idx_ledger_agent ON bounty_ledger(agent_id);

-- ─── issues (git_job_id FK added after git_jobs) ───────────────────────────
CREATE TABLE issues (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  status VARCHAR(20) DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed', 'cancelled')),
  scorecard JSONB DEFAULT '{}'::jsonb,
  assigned_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  parent_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  root_issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  github_issue_number INTEGER,
  git_job_id UUID,
  settlement_finalized_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_issues_repo ON issues(repo_id);
CREATE INDEX idx_issues_status ON issues(status);
CREATE INDEX idx_issues_assigned ON issues(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX idx_issues_parent ON issues(parent_issue_id) WHERE parent_issue_id IS NOT NULL;

-- ─── issue_judgements, judge_results, agent_scores ────────────────────────────
CREATE TABLE issue_judgements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  verdict JSONB NOT NULL,
  points_awarded INTEGER NOT NULL DEFAULT 0,
  judged_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(issue_id, agent_id)
);

CREATE TABLE judge_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  pr_number INTEGER,
  verdict_json JSONB NOT NULL,
  score_numeric NUMERIC(8, 7),
  comment_body TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(issue_id, agent_id, pr_number)
);

CREATE TABLE agent_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, issue_id)
);

CREATE INDEX idx_judgements_issue ON issue_judgements(issue_id);
CREATE INDEX idx_judge_results_issue ON judge_results(issue_id);
CREATE INDEX idx_judge_results_agent ON judge_results(agent_id);
CREATE INDEX idx_judge_results_pr ON judge_results(pr_number) WHERE pr_number IS NOT NULL;
CREATE INDEX idx_scores_agent ON agent_scores(agent_id);

-- ─── issue_bounties ──────────────────────────────────────────────────────────
CREATE TABLE issue_bounties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  poster_agent_id UUID NOT NULL REFERENCES agents(id),
  amount NUMERIC(18, 4) NOT NULL CHECK (amount > 0),
  deadline TIMESTAMPTZ NOT NULL,
  max_submissions INTEGER NOT NULL DEFAULT 5 CHECK (max_submissions > 0),
  status VARCHAR(20) DEFAULT 'funded'
    CHECK (status IN ('funded', 'judging', 'awarded', 'expired', 'cancelled')),
  winner_agent_id UUID REFERENCES agents(id),
  github_pr_number INTEGER,
  judge_payout_fraction NUMERIC(8, 7),
  github_judge_verdict JSONB,
  is_mock_judge BOOLEAN NOT NULL DEFAULT FALSE,
  payout_status VARCHAR(32) DEFAULT 'internal',
  merge_webhook_delivery_id VARCHAR(255),
  settlement_key VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_issue_bounties_merge_delivery
  ON issue_bounties(merge_webhook_delivery_id) WHERE merge_webhook_delivery_id IS NOT NULL;
CREATE INDEX idx_issue_bounties_github_pr ON issue_bounties(github_pr_number) WHERE github_pr_number IS NOT NULL;
CREATE UNIQUE INDEX idx_issue_bounties_settlement_key
  ON issue_bounties(settlement_key) WHERE settlement_key IS NOT NULL;
CREATE INDEX idx_issue_bounties_issue ON issue_bounties(issue_id);

CREATE TABLE merge_settlement_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  bounty_id UUID REFERENCES issue_bounties(id) ON DELETE SET NULL,
  pr_number INTEGER NOT NULL,
  merge_commit_sha VARCHAR(255),
  github_delivery_id VARCHAR(255) NOT NULL,
  merge_event_key VARCHAR(255) NOT NULL,
  merge_semantic_key VARCHAR(255) NOT NULL,
  settlement_key VARCHAR(255) NOT NULL,
  payout_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  outcome_status VARCHAR(32) NOT NULL DEFAULT 'pending',
  payout_tx_ref VARCHAR(255),
  error_message TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (merge_event_key),
  UNIQUE (merge_semantic_key),
  UNIQUE (settlement_key)
);

CREATE INDEX idx_merge_settlement_events_repo_pr ON merge_settlement_events(repository_id, pr_number);
CREATE INDEX idx_merge_settlement_events_bounty ON merge_settlement_events(bounty_id);

CREATE TABLE agent_outcomes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  bounty_id UUID NOT NULL REFERENCES issue_bounties(id) ON DELETE CASCADE,
  merge_event_id VARCHAR(255) NOT NULL,
  merged BOOLEAN NOT NULL,
  payout_fraction NUMERIC(8, 7) NOT NULL DEFAULT 0,
  payout_amount NUMERIC(18, 4) NOT NULL DEFAULT 0,
  judge_score NUMERIC(8, 7),
  outcome_score NUMERIC(8, 7) NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  failure_category VARCHAR(64),
  settlement_key VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (merge_event_id)
);

CREATE UNIQUE INDEX idx_agent_outcomes_settlement_key
  ON agent_outcomes(settlement_key) WHERE settlement_key IS NOT NULL;
CREATE INDEX idx_agent_outcomes_agent_created ON agent_outcomes(agent_id, created_at DESC);
CREATE INDEX idx_agent_outcomes_issue ON agent_outcomes(issue_id);

CREATE TABLE agent_reputation_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  outcome_id UUID NOT NULL REFERENCES agent_outcomes(id) ON DELETE CASCADE,
  previous_score NUMERIC(12, 4) NOT NULL,
  next_score NUMERIC(12, 4) NOT NULL,
  ewma_alpha NUMERIC(8, 7) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_reputation_snapshots_agent_created
  ON agent_reputation_snapshots(agent_id, created_at DESC);

CREATE TABLE bounty_submissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bounty_id UUID NOT NULL REFERENCES issue_bounties(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  content TEXT NOT NULL,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  judge_verdict JSONB,
  points_awarded INTEGER DEFAULT 0,
  UNIQUE(bounty_id, agent_id)
);

CREATE INDEX idx_bounty_submissions_bounty ON bounty_submissions(bounty_id);

CREATE TABLE wallet_transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  amount NUMERIC(18, 4) NOT NULL,
  tx_type VARCHAR(30) NOT NULL
    CHECK (tx_type IN ('deposit', 'bounty_post', 'bounty_win', 'bounty_refund', 'earning')),
  reference_id UUID,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_wallet_tx_agent ON wallet_transactions(agent_id);

-- ─── workflow_runs ───────────────────────────────────────────────────────────
CREATE TABLE workflow_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repo_id UUID NOT NULL REFERENCES repositories(id),
  commit_id UUID REFERENCES commits(id),
  pr_id UUID REFERENCES pull_requests(id),
  event_type VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workflow_runs_repo_id ON workflow_runs(repo_id);

-- ─── git_jobs ───────────────────────────────────────────────────────────────
CREATE TABLE git_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  issue_id UUID NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  base_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  status VARCHAR(24) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'awaiting_merge', 'completed', 'failed', 'cancelled')),
  branch_name VARCHAR(512),
  github_pr_number INTEGER,
  judge_comment_id BIGINT,
  diff_summary_json JSONB,
  error_message TEXT,
  stage VARCHAR(64) NOT NULL DEFAULT 'pending'
    CHECK (
      stage IN (
        'pending',
        'leased',
        'cloning',
        'planning',
        'editing',
        'committing',
        'pushing',
        'pr_opened',
        'judging',
        'comment_posted',
        'cleanup_done',
        'awaiting_merge',
        'completed',
        'failed',
        'cancelled',
        'pending_retry'
      )
    ),
  attempt INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_token VARCHAR(128),
  lease_owner VARCHAR(255),
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  retry_after TIMESTAMPTZ,
  last_error_classification VARCHAR(24),
  idempotency_key VARCHAR(255),
  payload JSONB DEFAULT '{}'::jsonb,
  completed_at TIMESTAMPTZ,
  settlement_finalized_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_git_jobs_idempotency_key ON git_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_git_jobs_status ON git_jobs(status) WHERE status IN ('pending', 'running');
CREATE INDEX idx_git_jobs_issue ON git_jobs(issue_id);
CREATE INDEX idx_git_jobs_lease_exp ON git_jobs(lease_expires_at) WHERE status = 'running';
CREATE INDEX idx_git_jobs_retry_after ON git_jobs(retry_after) WHERE status = 'pending';
CREATE INDEX idx_git_jobs_branch_name ON git_jobs(branch_name) WHERE branch_name IS NOT NULL;
CREATE UNIQUE INDEX idx_git_jobs_judge_comment_id ON git_jobs(judge_comment_id) WHERE judge_comment_id IS NOT NULL;

ALTER TABLE issues
  ADD CONSTRAINT issues_git_job_id_fkey FOREIGN KEY (git_job_id) REFERENCES git_jobs(id) ON DELETE SET NULL;

CREATE TABLE tool_execution_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  git_job_id UUID NOT NULL REFERENCES git_jobs(id) ON DELETE CASCADE,
  phase VARCHAR(16) NOT NULL CHECK (phase IN ('edit', 'verify', 'fix')),
  cycle INTEGER NOT NULL DEFAULT 1,
  command_text TEXT NOT NULL,
  command_bin VARCHAR(128),
  command_args_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  execution_status VARCHAR(16) NOT NULL DEFAULT 'executed' CHECK (execution_status IN ('executed', 'blocked')),
  exit_code INTEGER,
  signal VARCHAR(32),
  timed_out BOOLEAN NOT NULL DEFAULT FALSE,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  stdout_tail TEXT,
  stderr_tail TEXT,
  blocked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tool_execution_logs_job_created ON tool_execution_logs(git_job_id, created_at DESC);
CREATE INDEX idx_tool_execution_logs_job_phase ON tool_execution_logs(git_job_id, phase);
CREATE INDEX idx_tool_execution_logs_status ON tool_execution_logs(execution_status, created_at DESC);

-- ─── on-chain indexer ───────────────────────────────────────────────────────
CREATE TABLE onchain_indexer_state (
  chain_id BIGINT NOT NULL PRIMARY KEY,
  last_processed_block BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE onchain_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  chain_id BIGINT NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  contract_address VARCHAR(42) NOT NULL,
  event_name VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  bounty_id BIGINT,
  ens_name VARCHAR(255),
  issue_id UUID REFERENCES issues(id) ON DELETE SET NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tx_hash, log_index)
);

CREATE INDEX idx_onchain_events_chain_block ON onchain_events(chain_id, block_number DESC);
CREATE INDEX idx_onchain_events_agent ON onchain_events(agent_id);
CREATE INDEX idx_onchain_events_issue ON onchain_events(issue_id);
CREATE INDEX idx_onchain_events_bounty ON onchain_events(chain_id, bounty_id) WHERE bounty_id IS NOT NULL;

-- ─── seed system agent (repo scaffolding FK only) ───────────────────────────
INSERT INTO agents (ens_name, role, capabilities, reputation_score, user_id)
VALUES ('kaizen.system', 'system', ARRAY[]::TEXT[], 0, NULL);
