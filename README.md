# Kaizen

Scaffold for the **Demo-ready GitHub Git** stack (Fastify API, git worker process, Next.js UI, Postgres). Implementation follows the internal plan: GitHub as code SoT, merge webhook for bounties, shared temp clone for agent + judge — **not built in this repo state yet**, only structure and tooling.

## Prereqs

- Node 20+
- Docker (optional, for Postgres / full stack images)

## Env

1. `cp .env.example .env` at the **repo root**.
2. Adjust secrets before any production deploy (`JWT_SECRET`, GitHub fields, `OPENAI_API_KEY`, etc.).

The API, worker, and Next config all try to load a root `.env` by walking up from the current working directory.

## Local dev

```bash
npm install
docker compose up -d postgres   # optional
npm run dev:api                 # http://localhost:3001
npm run dev:frontend            # http://localhost:3000
npm run dev:worker              # logs scaffold tick
```

Migrations entrypoint (connectivity check only until SQL is added):

```bash
npm run migrate
```

## Docker

- **Postgres only:** `docker compose up -d postgres`
- **API + worker + web + Postgres:** `docker compose --profile stack up --build`  
  Point `NEXT_PUBLIC_API_URL` at wherever the browser can reach the API (for real demos, rebuild the `web` image with the public API URL).

## Layout

| Path | Role |
|------|------|
| `backend/` | Fastify API (`/health`, `/status`), env validation, `src/db/migrate.ts`, `migrations/` for future SQL |
| `worker/` | Git worker process (idle scaffold; Phase 2 in the plan) |
| `frontend/` | Next.js app (`NEXT_PUBLIC_API_URL`) |
| `ref/` | Ignored reference snapshot only — not source of truth |
