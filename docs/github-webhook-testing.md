# GitHub webhooks: import flow and testing

Merge/refund logic listens on:

`POST /integrations/github/webhook`

GitHub must reach that URL over **HTTPS** (use a tunnel such as ngrok in local dev). The **only supported way** to attach a GitHub remote and install the webhook in this project is **`POST /repositories/import-from-github`** (dashboard **Import from GitHub**, or the same API from scripts). There is no separate “install webhook” endpoint; do not rely on manually adding a webhook in the GitHub UI for normal operation.

## Server environment (required for import)

| Variable | Purpose |
|----------|---------|
| `GITHUB_WEBHOOK_SECRET` | HMAC secret; must match the secret GitHub stores on the hook (the import call sets it via the GitHub API). |
| `GITHUB_WEBHOOK_CALLBACK_URL` | Full public URL of the webhook route, e.g. `https://abc123.ngrok-free.app/integrations/github/webhook`. |

Generate a secret locally, e.g. `openssl rand -hex 24`.

## User setup

1. **PAT:** `PATCH /auth/github-api-key` (dashboard saves the same field). The token must be allowed to **manage webhooks** on the target repository (classic: `repo` / appropriate hook scope; fine-grained: **Webhooks → Read and write** on that repo).
2. **Import:** `POST /repositories/import-from-github` as the authenticated user with `github_owner`, `github_repo`, optional `github_default_branch`, `name`, `description`. The repo is scoped to that user (`imported_by_user_id`); no agent picker or `owner_ens` on import.

On success the API:

- Inserts the Kaizen repository row (and `main` branch),
- Sets `github_owner` / `github_repo` / `github_default_branch`,
- Creates or updates the GitHub `web` hook (`pull_request`, JSON, active) via the GitHub API,
- Persists `github_hook_id` on the repository row.

If webhook provisioning fails, the new repository row is **removed** so you do not end up linked without a hook.

## Local dev: public callback URL (ngrok)

Your API on `localhost` is not reachable by GitHub until tunneled.

### Docker Compose (API in Docker)

1. Root `.env`: `GITHUB_WEBHOOK_SECRET`, `NGROK_AUTHTOKEN`, and **`GITHUB_WEBHOOK_CALLBACK_URL`** = `https://<ngrok-host>/integrations/github/webhook` (set after you see the forwarding URL, or restart API after updating `.env`).
2. `docker compose --profile stack --profile tunnel up --build`
3. Open **http://localhost:4040**, copy the **HTTPS** forwarding host, and ensure `GITHUB_WEBHOOK_CALLBACK_URL` matches exactly (path `/integrations/github/webhook`).

### API on host + ngrok CLI

1. `ngrok config add-authtoken <token>` once.
2. `bun run dev:api` with `GITHUB_WEBHOOK_SECRET` set.
3. `bun run tunnel:ngrok` → set `GITHUB_WEBHOOK_CALLBACK_URL` to the HTTPS URL shown + `/integrations/github/webhook`.

Then run through **Dashboard → Import from GitHub** (or call `import-from-github`).

### Sanity check (deliveries)

In GitHub repo **Settings → Webhooks**, open the hook and use **Recent Deliveries**:

- **`ping`:** **204** after signature verification (non–`pull_request` events are ignored).
- **`pull_request`:** JSON response (`ok`, `ignored`, `payout`, `refunded`, …) depending on DB state.

## Updating default branch only

After import, you may call:

`PATCH /repositories/:id/github` with body `{ "github_default_branch": "develop" }` only.  
Sending `github_owner` / `github_repo` returns **400** (`GITHUB_REMOTE_IMMUTABLE`).

## End-to-end payout / refund test

The handler only acts when an **`issue_bounties`** row exists for the PR (`github_owner`, `github_repo`, `github_pr_number`). Typical flow:

1. Import repo (creates link + webhook).
2. `POST /repositories/:repoId/git-jobs` so a real PR exists and the worker sets `github_pr_number` on the bounty.
3. **Merge** the PR → webhook `closed` + `merged: true` → payout path in logs/response.
4. **Close without merge** on another test PR → refund path.

If there is **no matching bounty**, the handler returns `{ ok: true, ignored: true }`.

## Troubleshooting

| Symptom | Likely cause |
|--------|----------------|
| `503` on import | `GITHUB_WEBHOOK_SECRET` and/or `GITHUB_WEBHOOK_CALLBACK_URL` missing on the API. |
| `403` `GITHUB_HOOK_ADMIN_FORBIDDEN` | PAT cannot manage webhooks on that repo. |
| `409` `GITHUB_REMOTE_ALREADY_IMPORTED` | That GitHub repo is already linked to a Kaizen row. |
| `401` `invalid signature` on delivery | Secret mismatch or raw body altered (wrong content-type / proxy). |
| `204` on delivery | Not `pull_request`, or action is not `closed`. |
| `{ ignored: true }` | No matching bounty row for that PR. |

The API registers **raw body** parsing only for `/integrations/github/webhook`; keep that route’s body intact for HMAC verification.
