"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  issueApi,
  repoApi,
  type GitJob,
  type Issue,
  type Repository,
} from "@/lib/api";

const ISSUE_PAGE = 15;
const JOB_PAGE = 10;

const ISSUE_STATUS_LABEL: Record<Issue["status"], string> = {
  open: "Open",
  in_progress: "In progress",
  closed: "Closed",
  cancelled: "Cancelled",
};

function issueStatusChipStyle(status: Issue["status"]): {
  border: string;
  backgroundColor: string;
  color: string;
} {
  switch (status) {
    case "open":
      return {
        border: "rgba(52, 211, 153, 0.4)",
        backgroundColor: "rgba(52, 211, 153, 0.12)",
        color: "#6ee7b7",
      };
    case "in_progress":
      return {
        border: "rgba(96, 165, 250, 0.45)",
        backgroundColor: "rgba(96, 165, 250, 0.12)",
        color: "#93c5fd",
      };
    case "closed":
      return {
        border: "rgba(161, 161, 170, 0.35)",
        backgroundColor: "rgba(255, 255, 255, 0.06)",
        color: "var(--fg-muted)",
      };
    case "cancelled":
      return {
        border: "rgba(248, 113, 113, 0.45)",
        backgroundColor: "rgba(248, 113, 113, 0.1)",
        color: "#fca5a5",
      };
    default:
      return {
        border: "rgba(161, 161, 170, 0.35)",
        backgroundColor: "rgba(255, 255, 255, 0.06)",
        color: "var(--fg-muted)",
      };
  }
}

function IssueStatusChip({ status }: { status: Issue["status"] }) {
  const s = issueStatusChipStyle(status);
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium shrink-0"
      style={{
        border: `1px solid ${s.border}`,
        backgroundColor: s.backgroundColor,
        color: s.color,
      }}
    >
      {ISSUE_STATUS_LABEL[status]}
    </span>
  );
}

function humanizeJobToken(s: string) {
  return s.replace(/_/g, " ");
}

/** Avoid redundant `pending · pending`; clarify queue state. */
function gitJobStateLines(j: GitJob): { title: string; subtitle?: string } {
  const st = (j.status || "").trim() || "unknown";
  const sg = (j.stage || "").trim();
  const stL = st.toLowerCase();
  const sgL = sg.toLowerCase();
  if (!sg || stL === sgL) {
    if (stL === "pending") {
      return {
        title: "Pending",
        subtitle: "Queued — a worker will claim this job when available",
      };
    }
    return { title: humanizeJobToken(st) };
  }
  return {
    title: `${humanizeJobToken(st)} · ${humanizeJobToken(sg)}`,
  };
}

export default function RepositoryDetailPage() {
  const params = useParams<{ repo: string }>();
  const repoId = params?.repo ?? "";
  const { isAuthenticated, selectedAgent } = useAuth();

  const [repo, setRepo] = useState<Repository | null>(null);
  const [repoErr, setRepoErr] = useState<string | null>(null);

  const [issues, setIssues] = useState<Issue[]>([]);
  const [issueTotal, setIssueTotal] = useState(0);
  const [issuePage, setIssuePage] = useState(0);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issuesErr, setIssuesErr] = useState<string | null>(null);

  const [jobs, setJobs] = useState<GitJob[]>([]);
  const [jobTotal, setJobTotal] = useState(0);
  const [jobPage, setJobPage] = useState(0);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsErr, setJobsErr] = useState<string | null>(null);

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [resolveOk, setResolveOk] = useState<string | null>(null);

  const loadRepo = useCallback(async () => {
    if (!repoId) return;
    setRepoErr(null);
    try {
      const r = await repoApi.get(repoId);
      setRepo(r);
    } catch (e) {
      setRepo(null);
      setRepoErr(e instanceof Error ? e.message : "Failed to load repository");
    }
  }, [repoId]);

  const loadIssues = useCallback(async () => {
    if (!repoId) return;
    setIssuesLoading(true);
    setIssuesErr(null);
    try {
      const res = await issueApi.list(repoId, {
        limit: ISSUE_PAGE,
        offset: issuePage * ISSUE_PAGE,
      });
      setIssues(res.data);
      setIssueTotal(res.pagination.total);
    } catch (e) {
      setIssuesErr(e instanceof Error ? e.message : "Failed to load issues");
    } finally {
      setIssuesLoading(false);
    }
  }, [repoId, issuePage]);

  const loadJobs = useCallback(async () => {
    if (!repoId) return;
    setJobsLoading(true);
    setJobsErr(null);
    try {
      const res = await repoApi.gitJobs(repoId, {
        limit: JOB_PAGE,
        offset: jobPage * JOB_PAGE,
      });
      setJobs(res.data);
      setJobTotal(res.pagination.total);
    } catch (e) {
      setJobsErr(e instanceof Error ? e.message : "Failed to load git jobs");
    } finally {
      setJobsLoading(false);
    }
  }, [repoId, jobPage]);

  useEffect(() => {
    void loadRepo();
  }, [loadRepo]);

  useEffect(() => {
    if (!repo || !isAuthenticated) return;
    void loadIssues();
  }, [repo, isAuthenticated, loadIssues]);

  useEffect(() => {
    if (!repo || !isAuthenticated) return;
    void loadJobs();
  }, [repo, isAuthenticated, loadJobs]);

  const hasActiveQueuedJob = jobs.some(
    (j) => (j.status || "").toLowerCase().trim() === "pending",
  );

  useEffect(() => {
    if (!repo || !isAuthenticated || !hasActiveQueuedJob) return;
    const t = window.setInterval(() => {
      void loadJobs();
    }, 8000);
    return () => window.clearInterval(t);
  }, [repo, isAuthenticated, hasActiveQueuedJob, loadJobs]);

  const selectedIssue =
    issues.find((i) => i.id === selectedIssueId) ?? null;

  const runCreate = async () => {
    if (!repoId || !newTitle.trim()) return;
    setCreating(true);
    setCreateErr(null);
    try {
      await issueApi.create(repoId, {
        title: newTitle.trim(),
        body: newBody.trim() || undefined,
      });
      setNewTitle("");
      setNewBody("");
      setCreateOpen(false);
      setIssuePage(0);
      await loadIssues();
    } catch (e) {
      setCreateErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  };

  const runResolve = async () => {
    if (!repoId || !selectedIssue) return;
    setResolveBusy(true);
    setResolveErr(null);
    setResolveOk(null);
    try {
      await issueApi.resolve(repoId, selectedIssue.id, {
        mode: "execute",
        ...(selectedAgent?.ens_name
          ? { agent_ens: selectedAgent.ens_name }
          : {}),
      });
      setResolveOk("Resolve enqueued — check git jobs below.");
      await loadJobs();
      await loadIssues();
    } catch (e) {
      setResolveErr(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setResolveBusy(false);
    }
  };

  const issuePages = Math.max(1, Math.ceil(issueTotal / ISSUE_PAGE));
  const jobPages = Math.max(1, Math.ceil(jobTotal / JOB_PAGE));

  if (!repoId) {
    return (
      <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
        Missing repository id.
      </p>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col gap-4">
        <p style={{ color: "var(--fg-default)" }}>
          Sign in to view this repository.
        </p>
        <Link href="/login" className="btn-primary w-fit text-sm">
          Log in
        </Link>
      </div>
    );
  }

  if (repoErr) {
    return (
      <div className="flex flex-col gap-3">
        <p style={{ color: "#f87171" }}>{repoErr}</p>
        <Link href="/dashboard" className="btn-secondary text-sm w-fit">
          Back to dashboard
        </Link>
      </div>
    );
  }

  if (!repo) {
    return (
      <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
        Loading repository…
      </p>
    );
  }

  const gh =
    repo.github_owner && repo.github_repo
      ? `${repo.github_owner}/${repo.github_repo}`
      : null;

  return (
    <div className="flex flex-col gap-6 animate-in">
      <div className="flex items-start gap-3">
        <Link
          href="/dashboard"
          className="inline-flex shrink-0 items-center justify-center rounded-lg border p-2.5 transition-colors hover:opacity-90"
          style={{
            borderColor: "rgba(255, 255, 255, 0.14)",
            backgroundColor: "rgba(255, 255, 255, 0.06)",
            color: "var(--fg-default)",
          }}
          aria-label="Back to dashboard"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1
            className="text-2xl font-bold"
            style={{ color: "var(--fg-default)" }}
          >
            {repo.name}
          </h1>
          {gh && (
            <p
              className="text-sm mt-1 font-mono"
              style={{ color: "var(--fg-muted)" }}
            >
              {gh}
            </p>
          )}
          <p
            className="text-sm mt-1 max-w-2xl"
            style={{ color: "var(--fg-subtle)" }}
          >
            {repo.description?.trim() || "No description."}
          </p>
        </div>
      </div>

      <section>
        <div className="w-full md:w-3/5">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div
              className="card p-4"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
              }}
            >
              <p
                className="text-xs uppercase tracking-wide"
                style={{ color: "var(--fg-subtle)" }}
              >
                Branches
              </p>
              <p
                className="text-2xl font-bold mt-2"
                style={{ color: "var(--fg-default)" }}
              >
                {repo.branch_count ?? "—"}
              </p>
            </div>
            <div
              className="card p-4"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
              }}
            >
              <p
                className="text-xs uppercase tracking-wide"
                style={{ color: "var(--fg-subtle)" }}
              >
                Issues
              </p>
              <p
                className="text-2xl font-bold mt-2"
                style={{ color: "var(--fg-default)" }}
              >
                {issuesLoading ? "…" : issueTotal}
              </p>
              <p
                className="text-xs mt-1"
                style={{ color: "var(--fg-subtle)" }}
              >
                Total in this repo
              </p>
            </div>
            <div
              className="card p-4"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
              }}
            >
              <p
                className="text-xs uppercase tracking-wide"
                style={{ color: "var(--fg-subtle)" }}
              >
                Default branch
              </p>
              <p
                className="text-lg font-semibold mt-2 truncate"
                style={{ color: "var(--fg-default)" }}
              >
                {repo.github_default_branch ?? "—"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div
          className="card p-4"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <h2
              className="text-lg font-semibold"
              style={{ color: "var(--fg-default)" }}
            >
              Issues
            </h2>
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={() => setCreateOpen((v) => !v)}
            >
              {createOpen ? "Cancel" : "New issue"}
            </button>
          </div>

          {createOpen && (
            <div
              className="mb-4 p-3 rounded-lg space-y-2"
              style={{
                border: "1px solid rgba(255,255,255,0.12)",
                backgroundColor: "rgba(0,0,0,0.2)",
              }}
            >
              <input
                className="w-full rounded px-3 py-2 text-sm bg-transparent border"
                style={{
                  borderColor: "rgba(255,255,255,0.15)",
                  color: "var(--fg-default)",
                }}
                placeholder="Title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
              />
              <textarea
                className="w-full rounded px-3 py-2 text-sm bg-transparent border min-h-[80px]"
                style={{
                  borderColor: "rgba(255,255,255,0.15)",
                  color: "var(--fg-default)",
                }}
                placeholder="Description (optional)"
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
              />
              {createErr && (
                <p className="text-xs" style={{ color: "#f87171" }}>
                  {createErr}
                </p>
              )}
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={creating || !newTitle.trim()}
                onClick={() => void runCreate()}
              >
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          )}

          {issuesErr && (
            <p className="text-sm mb-2" style={{ color: "#f87171" }}>
              {issuesErr}
            </p>
          )}

          {issuesLoading ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              Loading issues…
            </p>
          ) : issues.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              No issues yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {issues.map((issue) => {
                const sel = selectedIssueId === issue.id;
                return (
                  <li key={issue.id}>
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedIssueId(sel ? null : issue.id)
                      }
                      className="w-full rounded-lg border px-4 py-3 text-left transition-opacity"
                      style={{
                        borderColor: sel
                          ? "var(--accent-fg)"
                          : "rgba(255, 255, 255, 0.1)",
                        backgroundColor: "rgba(255, 255, 255, 0.06)",
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p
                          className="text-sm font-medium min-w-0 flex-1"
                          style={{ color: "var(--fg-default)" }}
                        >
                          {issue.title}
                        </p>
                        <IssueStatusChip status={issue.status} />
                      </div>
                      {issue.assigned_agent_ens ? (
                        <p
                          className="text-xs mt-1.5"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          {issue.assigned_agent_ens}
                        </p>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {issueTotal > ISSUE_PAGE && (
            <div className="flex justify-between items-center mt-4 text-sm">
              <span style={{ color: "var(--fg-subtle)" }}>
                Page {issuePage + 1} / {issuePages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={issuePage <= 0}
                  onClick={() => setIssuePage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={issuePage >= issuePages - 1}
                  onClick={() => setIssuePage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>

        <div
          className="card p-4"
          style={{
            backgroundColor: "rgba(255, 255, 255, 0.08)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
          }}
        >
          <h2
            className="text-lg font-semibold mb-3"
            style={{ color: "var(--fg-default)" }}
          >
            Git jobs
          </h2>
          {jobsErr && (
            <p className="text-sm mb-2" style={{ color: "#f87171" }}>
              {jobsErr}
            </p>
          )}
          {jobsLoading ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              Loading jobs…
            </p>
          ) : jobs.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              No git jobs yet.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {jobs.map((j) => {
                const jobLines = gitJobStateLines(j);
                return (
                <li
                  key={j.id}
                  className="rounded-lg px-3 py-2"
                  style={{
                    backgroundColor: "rgba(0,0,0,0.25)",
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}
                >
                  <div
                    className="font-mono text-xs truncate"
                    style={{ color: "var(--fg-subtle)" }}
                  >
                    {j.id.slice(0, 8)}…
                  </div>
                  <div
                    className="font-medium mt-0.5"
                    style={{ color: "var(--fg-default)" }}
                  >
                    {jobLines.title}
                  </div>
                  {jobLines.subtitle ? (
                    <div
                      className="text-xs mt-1 leading-snug"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {jobLines.subtitle}
                    </div>
                  ) : null}
                  <div
                    className="text-xs mt-1"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    issue {j.issue_id.slice(0, 8)}…
                    {j.github_pr_number != null
                      ? ` · PR #${j.github_pr_number}`
                      : ""}
                  </div>
                  {j.error_message && (
                    <div
                      className="text-xs mt-1 truncate"
                      style={{ color: "#f87171" }}
                      title={j.error_message}
                    >
                      {j.error_message}
                    </div>
                  )}
                </li>
              );
              })}
            </ul>
          )}
          {jobTotal > JOB_PAGE && (
            <div className="flex justify-between items-center mt-4 text-sm">
              <span style={{ color: "var(--fg-subtle)" }}>
                Page {jobPage + 1} / {jobPages}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={jobPage <= 0}
                  onClick={() => setJobPage((p) => p - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  disabled={jobPage >= jobPages - 1}
                  onClick={() => setJobPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      {selectedIssue && (
        <div className="fixed top-16 bottom-0 right-0 z-40 w-full sm:w-2/5 pointer-events-none">
          <div
            className="absolute inset-y-0 right-0 w-full border-l p-5 overflow-auto pointer-events-auto animate-panel-in"
            style={{
              borderColor: "rgba(255, 255, 255, 0.14)",
              backgroundColor: "rgba(12, 18, 28, 0.96)",
              boxShadow: "-12px 0 30px rgba(0, 0, 0, 0.35)",
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <p
                    className="text-xs uppercase tracking-wide"
                    style={{ color: "var(--fg-subtle)" }}
                  >
                    Issue
                  </p>
                  <IssueStatusChip status={selectedIssue.status} />
                </div>
                <h3
                  className="text-lg font-semibold mt-1"
                  style={{ color: "var(--fg-default)" }}
                >
                  {selectedIssue.title}
                </h3>
                <p
                  className="text-xs mt-1 font-mono break-all"
                  style={{ color: "var(--fg-muted)" }}
                >
                  {selectedIssue.id}
                </p>
              </div>
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={() => setSelectedIssueId(null)}
              >
                Close
              </button>
            </div>

            {selectedIssue.body && (
              <div
                className="mt-4 text-sm whitespace-pre-wrap"
                style={{ color: "var(--fg-muted)" }}
              >
                {selectedIssue.body}
              </div>
            )}

            <p className="text-xs mt-4" style={{ color: "var(--fg-subtle)" }}>
              {selectedAgent
                ? `Resolve as ${selectedAgent.ens_name}`
                : "Pick an agent in the navbar to pass agent_ens"}
            </p>

            {resolveErr && (
              <p className="text-sm mt-2" style={{ color: "#f87171" }}>
                {resolveErr}
              </p>
            )}
            {resolveOk && (
              <p className="text-sm mt-2" style={{ color: "#86efac" }}>
                {resolveOk}
              </p>
            )}

            <button
              type="button"
              className="btn-primary text-sm mt-4 w-full"
              disabled={
                resolveBusy ||
                selectedIssue.status === "closed" ||
                selectedIssue.status === "cancelled"
              }
              onClick={() => void runResolve()}
            >
              {resolveBusy ? "Resolving…" : "Resolve / enqueue worker"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
