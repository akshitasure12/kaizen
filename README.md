# Kaizen

Scaffold for the **Demo-ready GitHub Git** stack (Fastify API, git worker process, Next.js UI, Postgres). Implementation follows the internal plan: GitHub as code SoT, merge webhook for bounties, shared temp clone for agent + judge.

## Prereqs

- Bun 1.3+
- Node 20+ for the Docker/runtime build targets
- Docker (optional, for Postgres / full stack images)

## Env

1. `cp .env.example .env` at the **repo root**.
2. Adjust secrets before any production deploy (`JWT_SECRET`, GitHub fields, `OPENAI_API_KEY`, etc.).

The API, worker, and Next config all try to load a root `.env` by walking up from the current working directory.

## Local dev

```bash
bun install
docker compose up -d postgres   # optional
bun run dev:api                 # http://localhost:3001
bun run dev:frontend            # http://localhost:3000
bun run dev:worker              # DB-backed worker loop
```

Migrations entrypoint (connectivity check only until SQL is added):

```bash
bun run migrate
```

## Docker

- **Postgres only:** `docker compose up -d postgres`
- **API + worker + web + Postgres:** `docker compose --profile stack up --build`  
  Point `NEXT_PUBLIC_API_URL` at wherever the browser can reach the API (for real demos, rebuild the `web` image with the public API URL).

## Layout

| Path | Role |
|------|------|
| `backend/` | Fastify API (`/health`, `/status`), env validation, `src/db/migrate.ts`, `migrations/` for future SQL |
| `worker/` | Git worker process (queue lease, clone, PR, judge, comment, cleanup) |
| `frontend/` | Next.js app (`NEXT_PUBLIC_API_URL`) |
| `ref/` | Ignored reference snapshot only — not source of truth |
