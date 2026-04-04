import { parseGitHubLinkHeader } from "./github-integration";

const GH_API = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** Normalize origin + pathname for comparing GitHub hook URLs. */
export function canonicalizeWebhookCallbackUrl(raw: string): string {
  const u = new URL(raw.trim());
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return `${u.origin}${path}`;
}

type GitHubHookRow = {
  id: number;
  type: string;
  name: string;
  active: boolean;
  events: string[];
  config?: {
    url?: string;
    content_type?: string;
    insecure_ssl?: string;
  };
};

async function readGithubJsonMessage(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as { message?: string };
    if (typeof j?.message === "string") return j.message;
  } catch {
    /* ignore */
  }
  return undefined;
}

export interface EnsureRepoWebhookOk {
  /** `created` = new hook; `updated` = existing hook matched by URL (re-applied config/secret). */
  action: "created" | "updated";
  hook_id: number;
  github_owner: string;
  github_repo: string;
  callback_url: string;
}

export interface EnsureRepoWebhookErr {
  ok: false;
  status: number;
  code: string;
  message: string;
  github_status: number;
  github_message?: string;
}

function hookUrlMatches(hookUrl: string | undefined, canonical: string): boolean {
  if (!hookUrl?.trim()) return false;
  try {
    return canonicalizeWebhookCallbackUrl(hookUrl) === canonical;
  } catch {
    return false;
  }
}

async function listAllRepoHooks(
  accessToken: string,
  owner: string,
  repo: string,
): Promise<
  | { ok: true; hooks: GitHubHookRow[] }
  | { ok: false; status: number; github_message?: string }
> {
  const hooks: GitHubHookRow[] = [];
  let nextUrl: string | null =
    `${GH_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks?per_page=100`;

  while (nextUrl) {
    const res = await fetch(nextUrl, { headers: ghHeaders(accessToken) });
    if (!res.ok) {
      const msg = await readGithubJsonMessage(res);
      return { ok: false, status: res.status, github_message: msg };
    }
    const page = (await res.json()) as GitHubHookRow[];
    if (Array.isArray(page)) hooks.push(...page);
    const link = parseGitHubLinkHeader(res.headers.get("link"));
    nextUrl = link.next ?? null;
  }

  return { ok: true, hooks };
}

/**
 * Idempotent: create a `web` hook or PATCH the existing one whose config.url matches `callbackUrl`.
 * Uses the same secret GitHub will use for HMAC as the API verifies (GITHUB_WEBHOOK_SECRET).
 */
export async function ensureKaizenPullRequestWebhook(
  accessToken: string,
  owner: string,
  repo: string,
  callbackUrl: string,
  secret: string,
): Promise<{ ok: true; data: EnsureRepoWebhookOk } | EnsureRepoWebhookErr> {
  const ownerL = owner.trim().toLowerCase();
  const repoL = repo.trim().toLowerCase();
  let canonical: string;
  try {
    canonical = canonicalizeWebhookCallbackUrl(callbackUrl);
  } catch {
    return {
      ok: false,
      status: 400,
      code: "INVALID_CALLBACK_URL",
      message: "GITHUB_WEBHOOK_CALLBACK_URL is not a valid absolute URL.",
      github_status: 0,
    };
  }

  const listed = await listAllRepoHooks(accessToken, ownerL, repoL);
  if (!listed.ok) {
    return mapListOrWriteFailure(listed.status, listed.github_message, "list hooks");
  }

  const existing = listed.hooks.find((h) => hookUrlMatches(h.config?.url, canonical));

  const bodyCreate = {
    name: "web",
    active: true,
    events: ["pull_request"],
    config: {
      url: callbackUrl.trim(),
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  };

  const bodyPatch = {
    active: true,
    events: ["pull_request"],
    config: {
      url: callbackUrl.trim(),
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  };

  if (existing) {
    const patchUrl = `${GH_API}/repos/${encodeURIComponent(ownerL)}/${encodeURIComponent(repoL)}/hooks/${existing.id}`;
    const res = await fetch(patchUrl, {
      method: "PATCH",
      headers: { ...ghHeaders(accessToken), "Content-Type": "application/json" },
      body: JSON.stringify(bodyPatch),
    });
    if (!res.ok) {
      const msg = await readGithubJsonMessage(res);
      return mapListOrWriteFailure(res.status, msg, "update webhook");
    }
    return {
      ok: true,
      data: {
        action: "updated",
        hook_id: existing.id,
        github_owner: ownerL,
        github_repo: repoL,
        callback_url: canonical,
      },
    };
  }

  const postUrl = `${GH_API}/repos/${encodeURIComponent(ownerL)}/${encodeURIComponent(repoL)}/hooks`;
  const res = await fetch(postUrl, {
    method: "POST",
    headers: { ...ghHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(bodyCreate),
  });
  if (!res.ok) {
    const msg = await readGithubJsonMessage(res);
    return mapListOrWriteFailure(res.status, msg, "create webhook");
  }

  let newId: number;
  let github_message: string | undefined;
  try {
    const j = (await res.json()) as { id?: number; message?: string };
    github_message = typeof j?.message === "string" ? j.message : undefined;
    if (typeof j?.id !== "number") throw new Error("missing id");
    newId = j.id;
  } catch {
    return {
      ok: false,
      status: 502,
      code: "GITHUB_INVALID_RESPONSE",
      message: "GitHub returned success but the hook payload was not usable.",
      github_status: res.status,
      github_message,
    };
  }

  return {
    ok: true,
    data: {
      action: "created",
      hook_id: newId,
      github_owner: ownerL,
      github_repo: repoL,
      callback_url: canonical,
    },
  };
}

function mapListOrWriteFailure(
  githubStatus: number,
  githubMessage: string | undefined,
  op: string,
): EnsureRepoWebhookErr {
  if (githubStatus === 404) {
    return {
      ok: false,
      status: 404,
      code: "GITHUB_REPO_NOT_FOUND",
      message:
        "Repository not found or the token cannot see it. Check github_owner/github_repo and that the PAT can access this repo.",
      github_status: githubStatus,
      github_message: githubMessage,
    };
  }
  if (githubStatus === 403) {
    return {
      ok: false,
      status: 403,
      code: "GITHUB_HOOK_ADMIN_FORBIDDEN",
      message:
        "This token cannot manage webhooks on that repository. Classic PAT: include scope `repo` (private repos) or `public_repo` plus `admin:repo_hook` as needed. Fine-grained PAT: under Repository permissions set **Webhooks** to **Read and write** (and **Administration** if GitHub requires it for hook management).",
      github_status: githubStatus,
      github_message: githubMessage,
    };
  }
  if (githubStatus === 401) {
    return {
      ok: false,
      status: 401,
      code: "GITHUB_TOKEN_INVALID",
      message:
        "GitHub rejected the token (401). Update it with PATCH /auth/github-api-key.",
      github_status: githubStatus,
      github_message: githubMessage,
    };
  }
  return {
    ok: false,
    status: 502,
    code: "GITHUB_WEBHOOK_API_ERROR",
    message: `GitHub API failed to ${op}.`,
    github_status: githubStatus,
    github_message: githubMessage,
  };
}
