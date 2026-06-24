"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import {
  issueApi,
  knowledgeBaseApi,
  repoApi,
  type GitJob,
  type Issue,
  type KnowledgeDocument,
  type KnowledgeSnippet,
  type ResolveResponse,
  type Repository,
} from "@/lib/api";

const ISSUE_PAGE = 15;
const JOB_PAGE = 10;
const KB_PAGE = 20;
const ACTIVE_GIT_JOB_POLL_MS = 2500;
const ACTIVE_GIT_JOB_STATUSES = new Set(["pending", "running"]);

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

function isActiveGitJob(j: GitJob): boolean {
  const status = (j.status || "").trim().toLowerCase();
  return ACTIVE_GIT_JOB_STATUSES.has(status);
}

function stripExtension(filename: string): string {
  return filename.replace(/\.[a-z0-9]+$/i, "").trim();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Invalid file read result"));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
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

function decompositionLogForJob(job: GitJob): {
  reasons: string[];
  children: Array<{
    issueId: string;
    title: string;
    body: string;
    agentEns: string;
    assignmentReason: string;
  }>;
} | null {
  const decomposition = job.payload?.orchestration?.decomposition;
  if (!decomposition || decomposition.used !== true) return null;

  const reasons = Array.isArray(decomposition.reasons)
    ? decomposition.reasons
        .filter((reason): reason is string =>
          typeof reason === "string" && reason.trim().length > 0,
        )
        .slice(0, 8)
    : [];

  const children = Array.isArray(decomposition.children)
    ? decomposition.children
        .map((child) => ({
          issueId: (child?.issue_id || "").trim(),
          title: (child?.title || "").trim(),
          body: (child?.body || "").trim(),
          agentEns: (child?.agent_ens || "").trim(),
          assignmentReason: (child?.assignment_reason || "").trim(),
        }))
        .filter((child) => child.issueId || child.title || child.agentEns)
        .slice(0, 20)
    : [];

  return { reasons, children };
}

function summarizeResolve(response: ResolveResponse): string {
  const createdCount = response.created_children?.length ?? 0;
  const assignedCount =
    response.jobs?.filter((job) => Boolean(job.agent_ens?.trim())).length ?? 0;

  if (response.plan.path === "single_agent") {
    return "Single-agent resolve enqueued.";
  }

  if (response.plan.path === "reuse_children") {
    return `Reused existing subagents; parent orchestration enqueued as one PR with ${assignedCount} assigned subagents.`;
  }

  return `Generated ${createdCount} subagents; assigned ${assignedCount}; execution enqueued as one PR.`;
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
  const [expandedJobLogId, setExpandedJobLogId] = useState<string | null>(null);

  const [kbDocs, setKbDocs] = useState<KnowledgeDocument[]>([]);
  const [kbTotal, setKbTotal] = useState(0);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbErr, setKbErr] = useState<string | null>(null);
  const [kbUploading, setKbUploading] = useState(false);
  const [kbUploadErr, setKbUploadErr] = useState<string | null>(null);
  const [kbDeletingId, setKbDeletingId] = useState<string | null>(null);
  const [kbQuery, setKbQuery] = useState("");
  const [kbSearching, setKbSearching] = useState(false);
  const [kbSearchErr, setKbSearchErr] = useState<string | null>(null);
  const [kbSearchResults, setKbSearchResults] = useState<KnowledgeSnippet[]>([]);
  const kbFileRef = useRef<HTMLInputElement>(null);

  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const [resolveBusy, setResolveBusy] = useState(false);
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [resolveOk, setResolveOk] = useState<string | null>(null);
  const [resolveMeta, setResolveMeta] = useState<ResolveResponse | null>(null);

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

  const loadKnowledgeBase = useCallback(async () => {
    if (!repoId) return;
    setKbLoading(true);
    setKbErr(null);
    try {
      const res = await knowledgeBaseApi.list(repoId, {
        limit: KB_PAGE,
        offset: 0,
      });
      setKbDocs(res.data);
      setKbTotal(res.pagination.total);
    } catch (e) {
      setKbErr(
        e instanceof Error ? e.message : "Failed to load knowledge documents",
      );
    } finally {
      setKbLoading(false);
    }
  }, [repoId]);

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

  useEffect(() => {
    if (!repo || !isAuthenticated) return;
    void loadKnowledgeBase();
  }, [repo, isAuthenticated, loadKnowledgeBase]);

  const hasActiveGitJob = jobs.some(isActiveGitJob);

  useEffect(() => {
    if (!repo || !isAuthenticated || !hasActiveGitJob) return;
    const t = window.setInterval(() => {
      void loadJobs();
    }, ACTIVE_GIT_JOB_POLL_MS);
    return () => window.clearInterval(t);
  }, [repo, isAuthenticated, hasActiveGitJob, loadJobs]);

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
      const response = await issueApi.resolve(repoId, selectedIssue.id, {
        mode: "execute",
        ...(selectedAgent?.ens_name
          ? { agent_ens: selectedAgent.ens_name }
          : {}),
      });
      setResolveMeta(response);
      setResolveOk(summarizeResolve(response));
      await loadJobs();
      await loadIssues();
    } catch (e) {
      setResolveErr(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setResolveBusy(false);
    }
  };

  const runKbUpload = async (file: File) => {
    if (!repoId) return;
    setKbUploading(true);
    setKbUploadErr(null);
    try {
      const lower = file.name.toLowerCase();
      const mime =
        file.type ||
        (lower.endsWith(".pdf")
          ? "application/pdf"
          : lower.endsWith(".md")
            ? "text/markdown"
            : lower.endsWith(".json")
              ? "application/json"
              : "text/plain");

      const title = stripExtension(file.name) || "Knowledge document";
      if (mime === "application/pdf" || lower.endsWith(".pdf")) {
        const dataUrl = await readFileAsDataUrl(file);
        const base64 = dataUrl.includes(",") ? dataUrl.split(",").pop() || "" : dataUrl;
        await knowledgeBaseApi.ingest(repoId, {
          title,
          filename: file.name,
          mime_type: "application/pdf",
          file_base64: base64,
        });
      } else {
        const content = await file.text();
        await knowledgeBaseApi.ingest(repoId, {
          title,
          filename: file.name,
          mime_type: mime,
          content,
        });
      }

      await loadKnowledgeBase();
      setKbSearchResults([]);
    } catch (e) {
      setKbUploadErr(
        e instanceof Error ? e.message : "Failed to upload knowledge document",
      );
    } finally {
      setKbUploading(false);
      if (kbFileRef.current) {
        kbFileRef.current.value = "";
      }
    }
  };

  const runKbDelete = async (documentId: string) => {
    if (!repoId) return;
    setKbDeletingId(documentId);
    setKbErr(null);
    try {
      await knowledgeBaseApi.remove(repoId, documentId);
      await loadKnowledgeBase();
      setKbSearchResults((prev) =>
        prev.filter((snippet) => snippet.document_id !== documentId),
      );
    } catch (e) {
      setKbErr(
        e instanceof Error ? e.message : "Failed to delete knowledge document",
      );
    } finally {
      setKbDeletingId(null);
    }
  };

  const runKbSearch = async () => {
    if (!repoId) return;
    const queryText = kbQuery.trim();
    if (!queryText) {
      setKbSearchErr("Enter a search query");
      return;
    }

    setKbSearching(true);
    setKbSearchErr(null);
    try {
      const result = await knowledgeBaseApi.search(repoId, {
        query: queryText,
        limit: 8,
      });
      setKbSearchResults(result.results || []);
    } catch (e) {
      setKbSearchErr(e instanceof Error ? e.message : "KB search failed");
      setKbSearchResults([]);
    } finally {
      setKbSearching(false);
    }
  };

  const issuePages = Math.max(1, Math.ceil(issueTotal / ISSUE_PAGE));
  const jobPages = Math.max(1, Math.ceil(jobTotal / JOB_PAGE));
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const visibleIssues = issues.filter((issue) => !issue.parent_issue_id);
  const visibleJobs = jobs.filter(
    (job) => !issuesById.get(job.issue_id)?.parent_issue_id,
  );

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

      <section
        className="card p-4"
        style={{
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <div>
            <h2
              className="text-lg font-semibold"
              style={{ color: "var(--fg-default)" }}
            >
              Knowledge base
            </h2>
            <p className="text-xs" style={{ color: "var(--fg-subtle)" }}>
              Upload repository knowledge for retrieval-augmented agent execution.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={kbFileRef}
              type="file"
              accept=".pdf,.md,.txt,.json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void runKbUpload(file);
              }}
            />
            <button
              type="button"
              className="btn-secondary text-sm"
              onClick={() => kbFileRef.current?.click()}
              disabled={kbUploading}
            >
              {kbUploading ? "Uploading…" : "Upload document"}
            </button>
          </div>
        </div>

        {kbUploadErr && (
          <p className="text-sm mb-2" style={{ color: "#f87171" }}>
            {kbUploadErr}
          </p>
        )}
        {kbErr && (
          <p className="text-sm mb-2" style={{ color: "#f87171" }}>
            {kbErr}
          </p>
        )}

        <div className="flex flex-col md:flex-row gap-2 mb-3">
          <input
            value={kbQuery}
            onChange={(e) => setKbQuery(e.target.value)}
            placeholder="Search repository knowledge"
            className="w-full rounded px-3 py-2 text-sm bg-transparent border"
            style={{
              borderColor: "rgba(255,255,255,0.15)",
              color: "var(--fg-default)",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runKbSearch();
              }
            }}
          />
          <button
            type="button"
            className="btn-secondary text-sm"
            disabled={kbSearching}
            onClick={() => void runKbSearch()}
          >
            {kbSearching ? "Searching…" : "Search"}
          </button>
        </div>

        {kbSearchErr && (
          <p className="text-sm mb-2" style={{ color: "#f87171" }}>
            {kbSearchErr}
          </p>
        )}

        {kbSearchResults.length > 0 && (
          <div className="mb-4 rounded-lg border p-3" style={{ borderColor: "rgba(255,255,255,0.12)" }}>
            <p className="text-xs uppercase mb-2" style={{ color: "var(--fg-subtle)" }}>
              Search results
            </p>
            <ul className="space-y-2">
              {kbSearchResults.map((result) => (
                <li key={result.chunk_id} className="text-sm" style={{ color: "var(--fg-muted)" }}>
                  <p style={{ color: "var(--fg-default)" }}>
                    {result.title}
                    <span className="ml-2 text-xs" style={{ color: "var(--fg-subtle)" }}>
                      score {result.score.toFixed(2)}
                    </span>
                  </p>
                  <p className="text-xs" style={{ color: "var(--fg-subtle)" }}>
                    {result.content}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-between mb-2">
          <p className="text-xs" style={{ color: "var(--fg-subtle)" }}>
            Documents: {kbTotal}
          </p>
          <button
            type="button"
            className="btn-secondary text-xs"
            onClick={() => void loadKnowledgeBase()}
          >
            Refresh
          </button>
        </div>

        {kbLoading ? (
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            Loading knowledge documents…
          </p>
        ) : kbDocs.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
            No knowledge documents uploaded yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {kbDocs.map((doc) => (
              <li
                key={doc.id}
                className="rounded-lg px-3 py-2"
                style={{
                  backgroundColor: "rgba(0,0,0,0.25)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--fg-default)" }}>
                      {doc.title}
                    </p>
                    <p className="text-xs truncate" style={{ color: "var(--fg-muted)" }}>
                      {doc.source_filename || doc.source_mime_type || "document"}
                      {typeof doc.chunk_count === "number" ? ` · ${doc.chunk_count} chunks` : ""}
                      {` · ${Math.round((doc.byte_size || 0) / 1024)} KB`}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={kbDeletingId === doc.id}
                    onClick={() => void runKbDelete(doc.id)}
                  >
                    {kbDeletingId === doc.id ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
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
          ) : visibleIssues.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              No issues yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {visibleIssues.map((issue) => {
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
          <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
            <h2
              className="text-lg font-semibold"
              style={{ color: "var(--fg-default)" }}
            >
              Git jobs
            </h2>
          </div>
          {jobsErr && (
            <p className="text-sm mb-2" style={{ color: "#f87171" }}>
              {jobsErr}
            </p>
          )}
          {jobsLoading ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              Loading jobs…
            </p>
          ) : visibleJobs.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
              No git jobs yet.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {visibleJobs.map((j) => {
                const jobLines = gitJobStateLines(j);
                const decompositionLog = decompositionLogForJob(j);
                const showDecompositionLog = expandedJobLogId === j.id;
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
                  {decompositionLog ? (
                    <div className="mt-2">
                      <button
                        type="button"
                        className="btn-secondary text-xs"
                        onClick={() =>
                          setExpandedJobLogId((prev) =>
                            prev === j.id ? null : j.id,
                          )
                        }
                      >
                        {showDecompositionLog
                          ? "Hide decomposition log"
                          : "Show decomposition log"}
                      </button>
                      {showDecompositionLog ? (
                        <div
                          className="mt-2 rounded-md px-2 py-2"
                          style={{
                            border: "1px solid rgba(255,255,255,0.08)",
                            backgroundColor: "rgba(255,255,255,0.04)",
                          }}
                        >
                          {decompositionLog.reasons.length > 0 ? (
                            <p
                              className="text-xs"
                              style={{ color: "var(--fg-subtle)" }}
                            >
                              Why decomposed: {decompositionLog.reasons.join(", ")}
                            </p>
                          ) : null}
                          {decompositionLog.children.length > 0 ? (
                            <ul className="mt-2 space-y-1">
                              {decompositionLog.children.map((child, index) => (
                                <li
                                  key={`${child.issueId || child.title || "child"}-${index}`}
                                  className="text-xs"
                                  style={{ color: "var(--fg-muted)" }}
                                >
                                  {child.title || child.issueId || "Child issue"}
                                  {child.agentEns
                                    ? ` · ${child.agentEns}`
                                    : ""}
                                  {child.assignmentReason
                                    ? ` · ${child.assignmentReason}`
                                    : ""}
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
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

            {resolveMeta ? (
              <p className="text-xs mt-3" style={{ color: "var(--fg-muted)" }}>
                Workflow: {resolveMeta.plan.decision} · {resolveMeta.plan.path}. Decomposition details are recorded in the PR workflow report.
              </p>
            ) : null}

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
