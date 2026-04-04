"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import importableRepos from "@/data/importable-repos.json";
import {
  authApi,
  integrationsApi,
  repoApi,
  type ApiError,
  type GitHubAccessibleRepo,
  type Repository,
} from "@/lib/api";

// API endpoints
const DASHBOARD_REPOS_API_URL =
  "http://localhost:3001/integrations/github/repos?page=1&per_page=10";
const IMPORT_REPOS_API_URL =
  "http://localhost:3001/integrations/github/repos?page=3&per_page=10";

type LocalRepo = {
  title: string;
  owner: string;
  issues: number;
  description?: string;
};

type GithubRepoItem = {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
  private: boolean;
  html_url: string;
  description?: string | null;
};

type GithubReposResponse = {
  items: GithubRepoItem[];
  page: number;
  per_page: number;
  has_next: boolean;
  has_prev: boolean;
};

export default function DashboardPage() {
  const {
    isAuthenticated,
    isLoading: authLoading,
    agents,
    selectedAgent,
    selectAgent,
    github,
    refreshSession,
  } = useAuth();

  const [repos, setRepos] = useState<Repository[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const [importOpen, setImportOpen] = useState(false);
  const [patInput, setPatInput] = useState("");
  const [patSaving, setPatSaving] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);

  const [ghPage, setGhPage] = useState(1);
  const [ghList, setGhList] = useState<GitHubAccessibleRepo[]>([]);
  const [ghHasNext, setGhHasNext] = useState(false);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [selectedGh, setSelectedGh] = useState<GitHubAccessibleRepo | null>(
    null,
  );

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    setReposLoading(true);
    setReposError(null);
    try {
      const list = await repoApi.list();
      setRepos(list);
    } catch (e) {
      setReposError(
        e instanceof Error ? e.message : "Failed to load repositories",
      );
    } finally {
      setReposLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) loadRepos();
  }, [isAuthenticated, loadRepos]);

  const loadGithubPage = useCallback(async (p: number, append: boolean) => {
    setGhLoading(true);
    setGhError(null);
    try {
      const data = await integrationsApi.listGithubRepos(p, 30);
      setGhList((prev) => (append ? [...prev, ...data.items] : data.items));
      setGhHasNext(data.has_next);
      setGhPage(p);
    } catch (e) {
      const err = e as ApiError;
      setGhError(err.message || "Could not list GitHub repositories");
    } finally {
      setGhLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!importOpen || !github?.api_key_configured) return;
    loadGithubPage(1, false);
  }, [importOpen, github?.api_key_configured, loadGithubPage]);

  const savePat = async () => {
    const v = patInput.trim();
    if (!v) {
      setPatError("Paste a personal access token");
      return;
    }
    setPatSaving(true);
    setPatError(null);
    try {
      await authApi.setGithubApiKey(v);
      setPatInput("");
      await refreshSession();
    } catch (e) {
      setPatError(e instanceof Error ? e.message : "Failed to save token");
    } finally {
      setPatSaving(false);
    }
  };

  const runImport = async () => {
    if (!selectedGh || !selectedAgent) return;
    const [owner, repoName] = selectedGh.full_name.split("/");
    if (!owner || !repoName) {
      setImportError("Invalid full_name from GitHub");
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      await repoApi.importFromGitHub({
        owner_ens: selectedAgent.ens_name,
        github_owner: owner,
        github_repo: repoName,
        github_default_branch: selectedGh.default_branch,
        name: selectedGh.name,
        description: "",
        repo_type: "general",
      });
      setImportOpen(false);
      setSelectedGh(null);
      await loadRepos();
    } catch (e) {
      const err = e as ApiError;
      const extra =
        err.github_message && err.github_status
          ? ` (GitHub ${err.github_status}: ${err.github_message})`
          : "";
      setImportError((err.message || "Import failed") + extra);
    } finally {
      setImporting(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(repos.length / PAGE_SIZE));
  const visibleRepos = repos.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const summaryCards = [
    {
      label: "Repositories",
      value: String(repos.length),
      hint: isAuthenticated ? "Linked in Kaizen" : "Sign in to sync",
    },
    {
      label: "Your agents",
      value: String(agents.length),
      hint: agents.length ? "Owner for new imports" : "Register an agent first",
    },
    {
      label: "GitHub PAT",
      value: github?.api_key_configured ? "Set" : "Missing",
      hint: "Required before import",
    },
    {
      label: "Webhook",
      value: "On import",
      hint: "Server must set callback URL + secret",
    },
  ];

  if (authLoading) {
    return (
      <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
        Loading…
      </p>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col gap-4 animate-in">
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--fg-default)" }}
        >
          Dashboard
        </h1>
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          Sign in to import GitHub repositories and manage webhooks from here.
        </p>
        <Link href="/login" className="btn-secondary text-sm w-fit">
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 animate-in">
      <div>
        <h1
          className="text-2xl font-bold"
          style={{ color: "var(--fg-default)" }}
        >
          Dashboard
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
          Import a GitHub repo to create a Kaizen record and install the merge
          webhook in one step.
        </p>
      </div>

      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {summaryCards.map((item) => (
          <div
            key={item.label}
            className="card p-5"
            style={{
              backgroundImage:
                "radial-gradient(circle at top right, rgba(255, 255, 255, 0.08), transparent 52%)",
              boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
            }}
          >
            <p
              className="text-xs uppercase tracking-wide"
              style={{ color: "var(--fg-subtle)" }}
            >
              {item.label}
            </p>
            <p
              className="text-3xl font-bold mt-2"
              style={{ color: "var(--fg-default)" }}
            >
              {item.value}
            </p>
            <p className="text-xs mt-2" style={{ color: "var(--fg-muted)" }}>
              {item.hint}
            </p>
          </div>
        ))}
      </section>

      <section
        className="card p-5"
        style={{
          backgroundImage:
            "radial-gradient(circle at top right, rgba(255, 255, 255, 0.07), transparent 48%)",
          boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
        }}
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2
            className="text-lg font-semibold"
            style={{ color: "var(--fg-default)" }}
          >
            Repositories
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => loadRepos()}
              className="btn-secondary text-sm"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={() => {
                setImportOpen(true);
                setImportError(null);
                setSelectedGh(null);
              }}
              className="text-sm rounded-lg px-3 py-1.5 font-medium"
              style={{
                background: "var(--accent, #6366f1)",
                color: "#fff",
              }}
            >
              Import from GitHub
            </button>
          </div>
        </div>

        {reposError && (
          <p className="text-sm mb-3" style={{ color: "#f87171" }}>
            {reposError}
          </p>
        )}

        {reposLoading ? (
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            Loading repositories…
          </p>
        ) : visibleRepos.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            No repositories yet. Use <strong>Import from GitHub</strong> after
            connecting a PAT.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {visibleRepos.map((repo) => (
                <Link
                  key={repo.id}
                  href={`/repositories/${repo.id}`}
                  className="rounded-lg border px-4 py-3 flex items-center justify-between gap-3 transition-colors"
                  style={{
                    borderColor: "var(--border-default)",
                    backgroundColor: "var(--bg-subtle)",
                  }}
                >
                  <div className="min-w-0">
                    <p
                      className="text-sm font-medium truncate"
                      style={{ color: "var(--fg-default)" }}
                    >
                      {repo.name}
                    </p>
                    <p
                      className="text-xs mt-0.5 truncate"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {repo.github_owner && repo.github_repo
                        ? `${repo.github_owner}/${repo.github_repo}`
                        : (repo.owner_ens ?? "—")}
                    </p>
                  </div>
                  <div className="shrink-0 text-right leading-tight">
                    <p
                      className="text-lg font-bold tabular-nums"
                      style={{ color: "var(--fg-default)" }}
                    >
                      {repo.open_issues ?? 0}
                    </p>
                    <p
                      className="text-sm"
                      style={{ color: "var(--fg-subtle)" }}
                    >
                      open issues
                    </p>
                  </div>
                </Link>
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(p - 1, 0))}
                  disabled={page === 0}
                  className="btn-secondary text-sm disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-xs" style={{ color: "var(--fg-muted)" }}>
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPage((p) => Math.min(p + 1, totalPages - 1))
                  }
                  disabled={page >= totalPages - 1}
                  className="btn-secondary text-sm disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {importOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.65)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="import-title"
        >
          <div
            className="card max-w-lg w-full max-h-[90vh] overflow-y-auto p-5 flex flex-col gap-4"
            style={{ borderColor: "var(--border-default)" }}
          >
            <div className="flex items-start justify-between gap-2">
              <h3
                id="import-title"
                className="text-lg font-semibold"
                style={{ color: "var(--fg-default)" }}
              >
                Import from GitHub
              </h3>
              <button
                type="button"
                className="text-sm opacity-70 hover:opacity-100"
                onClick={() => setImportOpen(false)}
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            {!github?.api_key_configured ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
                  Paste a GitHub personal access token with repo and webhook
                  access. It is stored for your account only.
                </p>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder="ghp_… or fine-grained token"
                  value={patInput}
                  onChange={(e) => setPatInput(e.target.value)}
                  className="rounded-md border px-3 py-2 text-sm bg-transparent"
                  style={{
                    borderColor: "var(--border-default)",
                    color: "var(--fg-default)",
                  }}
                />
                {patError && (
                  <p className="text-sm" style={{ color: "#f87171" }}>
                    {patError}
                  </p>
                )}
                <button
                  type="button"
                  disabled={patSaving}
                  onClick={() => void savePat()}
                  className="btn-secondary text-sm w-fit"
                >
                  {patSaving ? "Saving…" : "Save token"}
                </button>
              </div>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <label
                    className="text-xs uppercase tracking-wide"
                    style={{ color: "var(--fg-subtle)" }}
                  >
                    Owner agent (Kaizen)
                  </label>
                  {agents.length === 0 ? (
                    <p className="text-sm" style={{ color: "#f87171" }}>
                      Register an agent for your account before importing (POST
                      /agents or your onboarding flow).
                    </p>
                  ) : (
                    <select
                      value={selectedAgent?.ens_name ?? ""}
                      onChange={(e) => {
                        const a = agents.find(
                          (x) => x.ens_name === e.target.value,
                        );
                        if (a) selectAgent(a);
                      }}
                      className="rounded-md border px-3 py-2 text-sm bg-transparent"
                      style={{
                        borderColor: "var(--border-default)",
                        color: "var(--fg-default)",
                      }}
                    >
                      {agents.map((a) => (
                        <option key={a.id} value={a.ens_name}>
                          {a.ens_name}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {ghError && (
                  <p className="text-sm" style={{ color: "#f87171" }}>
                    {ghError}
                  </p>
                )}

                <div className="flex flex-col gap-2 max-h-48 overflow-y-auto">
                  {ghLoading && ghList.length === 0 ? (
                    <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
                      Loading your GitHub repositories…
                    </p>
                  ) : (
                    ghList.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => setSelectedGh(r)}
                        className="text-left rounded-lg border px-3 py-2 text-sm transition-colors"
                        style={{
                          borderColor:
                            selectedGh?.id === r.id
                              ? "var(--accent, #6366f1)"
                              : "var(--border-default)",
                          backgroundColor:
                            selectedGh?.id === r.id
                              ? "rgba(99,102,241,0.12)"
                              : "var(--bg-subtle)",
                          color: "var(--fg-default)",
                        }}
                      >
                        <span className="font-medium">{r.full_name}</span>
                        <span
                          className="text-xs block mt-0.5"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          default: {r.default_branch}
                          {r.private ? " · private" : ""}
                        </span>
                      </button>
                    ))
                  )}
                </div>

                {ghHasNext && (
                  <button
                    type="button"
                    disabled={ghLoading}
                    onClick={() => loadGithubPage(ghPage + 1, true)}
                    className="btn-secondary text-sm w-fit"
                  >
                    {ghLoading ? "Loading…" : "Load more"}
                  </button>
                )}

                {importError && (
                  <p className="text-sm" style={{ color: "#f87171" }}>
                    {importError}
                  </p>
                )}

                <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
                  The API creates the repo row, registers the pull_request
                  webhook on GitHub, and stores the hook id. Requires server env{" "}
                  <code className="text-[11px]">GITHUB_WEBHOOK_SECRET</code> and{" "}
                  <code className="text-[11px]">
                    GITHUB_WEBHOOK_CALLBACK_URL
                  </code>
                  .
                </p>

                <button
                  type="button"
                  disabled={
                    !selectedGh ||
                    !selectedAgent ||
                    agents.length === 0 ||
                    importing
                  }
                  onClick={() => void runImport()}
                  className="text-sm rounded-lg px-3 py-2 font-medium disabled:opacity-40"
                  style={{
                    background: "var(--accent, #6366f1)",
                    color: "#fff",
                  }}
                >
                  {importing ? "Importing…" : "Import & install webhook"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
