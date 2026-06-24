# Kaizen

Scaffold for the **Demo-ready GitHub Git** stack (Fastify API, git worker process, Next.js UI, Postgres). Implementation follows the internal plan: GitHub as code SoT, merge webhook for bounties, shared temp clone for agent + judge.

## Prereqs

- **Node 20+** and **[Bun](https://bun.sh)** (package manager / runtime used by this repo)
- **Docker** (optional, for Postgres / full stack images)
- **Foundry** (`curl -L https://foundry.paradigm.xyz | bash` then `foundryup`) — only if you deploy or compile `contracts/`

## Env

1. `cp .env.example .env` at the **repo root**.
2. Adjust secrets before any production deploy (`JWT_SECRET`, GitHub fields, `OPENAI_API_KEY`, etc.).

The API, worker, and Next config all try to load a root `.env` by walking up from the current working directory.

---

## Blockchain (Solidity — Base Sepolia)

Canonical Foundry project lives in **`contracts/`**.

### 1. Install contract dependencies

From the repo root:

```bash
git submodule update --init --recursive
```

If submodules are missing, install Foundry deps inside `contracts/`:

```bash
cd contracts
forge install
```

### 2. Build and test

```bash
cd contracts
forge build
forge test
```

### 3. Configure deploy secrets

Export (or place in a shell profile / CI secrets):

| Variable               | Purpose                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BASE_SEPOLIA_RPC_URL` | JSON-RPC for Base Sepolia (e.g. `https://sepolia.base.org` or an Alchemy/Infura URL)                               |
| `PRIVATE_KEY`          | Deployer EOA private key (hex, with `0x` prefix as Forge expects) — must hold a little ETH on Base Sepolia for gas |
| `TREASURY_ADDRESS`     | Address that receives protocol fees and agent-registration flows per the contracts                                 |

Optional for contract verification on Basescan: `BASESCAN_API_KEY`.

### 4. Deploy

Dry run (simulation only):

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL"
```

Broadcast to the network:

```bash
forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

The script logs **`ABT_CONTRACT_ADDRESS`** and **`BOUNTY_CONTRACT_ADDRESS`**. Copy them into the **repo root** `.env` (and optionally mirror the `NEXT_PUBLIC_*` lines for the frontend):

```env
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
ABT_CONTRACT_ADDRESS=0x...
BOUNTY_CONTRACT_ADDRESS=0x...
TREASURY_ADDRESS=0x...
```

Optional verification (after `--broadcast`):

```bash
forge script script/Deploy.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --verify
```

### 5. What the backend uses

With **`BASE_SEPOLIA_RPC_URL`** and **`ABT_CONTRACT_ADDRESS`** set, the API will:

- Expose chain config on `GET /blockchain/config`
- Verify **`AgentBranchToken.depositForAgent`** transactions when registering an agent (`POST /blockchain/register-agent` with `deposit_tx_hash`)

If those variables are unset, blockchain features stay in **mock** mode (no RPC calls).

For a full walkthrough of wallet setup, faucet funding, env configuration, deployment, and UI flow, see [docs/blockchain-setup.md](docs/blockchain-setup.md).

---

## Backend API

### 1. Configure

From the repo root `.env`, set at minimum:

| Variable        | Required            | Notes                                                   |
| --------------- | ------------------- | ------------------------------------------------------- |
| `DATABASE_URL`  | Yes (for real data) | Postgres URL, e.g. from `docker compose up -d postgres` |
| `JWT_SECRET`    | Yes in production   | Long random string                                      |
| `PORT` / `HOST` | Optional            | Default API: `http://0.0.0.0:3001`                      |

For **on-chain** agent deposit verification, also set **`BASE_SEPOLIA_RPC_URL`** and **`ABT_CONTRACT_ADDRESS`** as in the blockchain section.

For **GitHub PR webhooks** (merge/refund), set **`GITHUB_WEBHOOK_SECRET`** and **`GITHUB_WEBHOOK_CALLBACK_URL`**. Linking a GitHub remote and installing the webhook happens only via **`POST /repositories/import-from-github`** (dashboard **Import from GitHub**). See [docs/github-webhook-testing.md](docs/github-webhook-testing.md).

### 2. Install dependencies

From the **repo root**:

```bash
bun install
```

### 3. Database migrations

Ensure Postgres is reachable, then:

```bash
bun run migrate
```

By default this applies **incremental** SQL files from `backend/src/db/migrations/`
(tracked in `schema_migrations`) without dropping existing data. For a local
destructive reset that replays full `schema.sql`:

```bash
bun run migrate -- --full
```

Or set `MIGRATE_FULL=1`.

### 4. Run (development)

```bash
bun run dev:api
```

API listens on `http://localhost:3001` by default (`GET /health`, `GET /status`).

### 5. Run (production-style)

```bash
bun run build:backend
bun run start:api
```

Use `NODE_ENV=production` and a strong `JWT_SECRET`. Put the API behind HTTPS and restrict `CORS_ORIGIN` to your frontend origin(s).

### 6. Worker (git jobs)

In another process (same `.env`):

```bash
bun run dev:worker
```

### 7. Repository Knowledge Base (RAG)

The backend supports repository-scoped user-ingested knowledge documents that are
retrieved and injected into:

- git job context hints (worker note generation)
- agent assignment relevance scoring
- judge prompt context

Documents are scoped to the **repo importer** (`owner_user_id` on upload). Deletes
are soft (`status = deleted`).

Enable and tune from `.env`:

- `KB_RAG_ENABLED`
- `KB_MAX_DOCUMENT_BYTES`
- `KB_CHUNK_SIZE_CHARS`
- `KB_CHUNK_OVERLAP_CHARS`
- `KB_RETRIEVAL_TOP_K`
- `KB_HINT_MAX_SNIPPETS`
- `KB_HINT_SNIPPET_MAX_CHARS`
- `KB_ASSIGNMENT_TOP_K`
- `KB_JUDGE_TOP_K`
- `KB_JUDGE_SNIPPET_MAX_CHARS`
- `KB_JUDGE_CONTEXT_MAX_CHARS`

Worker judge gate:

- `WORKER_JUDGE_MIN_SCORE_FOR_AWAITING_MERGE`

Repository KB API endpoints (auth required, repository must belong to caller):

- `POST /repositories/:repoId/knowledge-base/documents`
  - Text ingest: send `content` (plus optional `title`, `filename`, `mime_type`, `metadata`)
  - PDF ingest: send `mime_type=application/pdf` with `file_base64`
- `GET /repositories/:repoId/knowledge-base/documents?limit=&offset=`
- `POST /repositories/:repoId/knowledge-base/search` with `{ "query": "...", "limit": 8 }`
- `DELETE /repositories/:repoId/knowledge-base/documents/:documentId`

Accepted upload formats in current UI/API flow: `.pdf`, `.md`, `.txt`, `.json`.

### 8. Issue resolve orchestration (single PR)

`POST /repositories/:repoId/issues/:issueId/resolve` always enqueues **one parent
git job** that produces a single PR. Child issues (new or reused) are included as
requirements in the job payload (`child_assignments`); they are not assigned
separate agents or per-child git jobs.

- Child bounty posting during resolve is **disabled**; use the decompose endpoint or
  parent issue bounty instead.
- Omitted `allocation_strategy` on decompose defaults to **`difficulty`**.
- Per-child git job fanout remains available via the **git-jobs** API (`fanout_children`),
  not via resolve.

---

## Local dev (full stack quick path)

```bash
bun install
docker compose up -d postgres   # optional
bun run migrate
bun run dev:api                   # http://localhost:3001
bun run dev:frontend              # http://localhost:5173 (see frontend package)
bun run dev:worker
```

---

## Docker

- **Postgres only:** `docker compose up -d postgres`
- **API + worker + web + Postgres:** `docker compose --profile stack up --build`  
  Point `NEXT_PUBLIC_API_URL` at wherever the browser can reach the API (for real demos, rebuild the `web` image with the public API URL).
- **GitHub webhooks from localhost:** add profile **`tunnel`** and set `NGROK_AUTHTOKEN` + `GITHUB_WEBHOOK_SECRET` in `.env`, then  
  `docker compose --profile stack --profile tunnel up --build`  
  Use **http://localhost:4040** for the public HTTPS URL. Step-by-step: [docs/github-webhook-testing.md](docs/github-webhook-testing.md).
- **API on host + ngrok CLI:** `bun run tunnel:ngrok` (requires `ngrok` on your `PATH`; forwards to port 3001).

---

## Layout

| Path         | Role                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------- |
| `backend/`   | Fastify API (`/health`, `/status`), env validation, `src/db/migrate.ts`, `src/db/schema.sql` |
| `worker/`    | Thin alias that runs the backend worker script                                               |
| `frontend/`  | Next.js app (`NEXT_PUBLIC_API_URL`)                                                          |
| `contracts/` | Foundry: AgentBranchToken, BountyPayment, deploy script (`forge build`, `forge test`)        |
| `ref/`       | Optional local reference snapshot only — **not** required for builds or deploys              |

## AI agent development

Agent configuration for Cursor and compatible tools:

| Layer | Path |
|-------|------|
| Entry | [AGENTS.md](AGENTS.md) |
| Hub (SSOT, workflow, roadmap) | [.cursor/README.md](.cursor/README.md) |
| Orchestration + invariants | `.cursor/rules/kaizen-orchestration.mdc`, `kaizen-project.mdc` |
| Package rules | `.cursor/rules/backend.mdc`, `worker.mdc`, `frontend.mdc`, `contracts.mdc` |
| Skills catalog | [.cursor/skills/README.md](.cursor/skills/README.md) |
| SWE discipline | [.cursor/instructions/coding-behavior.md](.cursor/instructions/coding-behavior.md) |

Auto skills: `kaizen-triage`, `kaizen-testing`, `kaizen-validate`. Manual: `/worker-roadmap` (`kaizen-worker-roadmap`), `/code-review` (`kaizen-review`). See [Cursor agent best practices](https://cursor.com/blog/agent-best-practices).