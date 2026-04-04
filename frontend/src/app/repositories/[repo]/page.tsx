"use client";

import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

function toDisplayName(repoSlug: string): string {
  return decodeURIComponent(repoSlug).replace(/[-_]+/g, " ").trim();
}

type IssueItem = {
  id: number;
  title: string;
  status: "open" | "in-review";
  priority: "high" | "medium" | "low";
};

export default function RepositoryDetailPage() {
  const params = useParams<{ repo: string }>();
  const searchParams = useSearchParams();
  const repoSlug = params?.repo ?? "unknown-repository";

  const repoName = useMemo(() => toDisplayName(repoSlug), [repoSlug]);
  const repoDescription = useMemo(() => {
    return searchParams.get("description")?.trim() || "No description available";
  }, [searchParams]);

  const issues = useMemo<IssueItem[]>(
    () => [
      { id: 187, title: "CI pipeline fails on workflow dispatch", status: "open", priority: "high" },
      { id: 193, title: "Stale dependency warning in build stage", status: "open", priority: "medium" },
      { id: 201, title: "Webhook retries missing exponential backoff", status: "in-review", priority: "high" },
      { id: 209, title: "Improve null handling in repository parser", status: "open", priority: "medium" },
      { id: 214, title: "Permissions mismatch for read-only collaborators", status: "open", priority: "high" },
      { id: 219, title: "Dashboard card timing out on slow networks", status: "open", priority: "low" },
      { id: 225, title: "Pagination reset after import action", status: "in-review", priority: "medium" },
      { id: 232, title: "Repository details page lacks issue context", status: "open", priority: "low" },
    ],
    []
  );

  const [selectedIssueId, setSelectedIssueId] = useState<number | null>(() => issues[0]?.id ?? null);

  const selectedIssue = issues.find((issue) => issue.id === selectedIssueId) ?? null;

  return (
    <div className="flex flex-col gap-6 animate-in">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--fg-default)" }}>
            {repoName}
          </h1>
          <p
            className="text-sm mt-1"
            style={{ color: "var(--fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {repoDescription}
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
              <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
                Branches
              </p>
              <p className="text-2xl font-bold mt-2" style={{ color: "var(--fg-default)" }}>
                8
              </p>
            </div>

            <div
              className="card p-4"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
              }}
            >
              <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
                Open Issues
              </p>
              <p className="text-2xl font-bold mt-2" style={{ color: "var(--fg-default)" }}>
                {issues.length}
              </p>
            </div>

            <div
              className="card p-4"
              style={{
                backgroundColor: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 255, 255, 0.1)",
              }}
            >
              <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
                Last Activity
              </p>
              <p className="text-2xl font-bold mt-2" style={{ color: "var(--fg-default)" }}>
                2h ago
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="w-full md:w-3/5">
          <div
            className="card p-4"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.08)",
              border: "1px solid rgba(255, 255, 255, 0.1)",
            }}
          >
            <h2 className="text-lg font-semibold" style={{ color: "var(--fg-default)" }}>
              Issues
            </h2>
            <p className="text-sm mt-1 mb-3" style={{ color: "var(--fg-muted)" }}>
              Select an issue to inspect details and start a Kaizen solution flow.
            </p>

            <div className="flex flex-col gap-2">
              {issues.map((issue) => {
                const isSelected = selectedIssueId === issue.id;

                return (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => setSelectedIssueId(issue.id)}
                    className="rounded-lg border px-4 py-3 text-left transition-opacity"
                    style={{
                      borderColor: isSelected ? "var(--accent-fg)" : "rgba(255, 255, 255, 0.1)",
                      backgroundColor: "rgba(255, 255, 255, 0.06)",
                    }}
                  >
                    <p className="text-sm font-medium" style={{ color: "var(--fg-default)" }}>
                      {issue.title}
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--fg-muted)" }}>
                      Issue #{issue.id}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
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
              <div>
                <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
                  Selected Issue
                </p>
                <h3 className="text-lg font-semibold mt-1" style={{ color: "var(--fg-default)" }}>
                  {selectedIssue.title}
                </h3>
                <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
                  Issue #{selectedIssue.id}
                </p>
              </div>
              <button type="button" className="btn-secondary text-sm" onClick={() => setSelectedIssueId(null)}>
                Close
              </button>
            </div>

            <button type="button" className="btn-primary text-sm mt-5 w-full">
              Solve with Kaizen
            </button>

            <div className="mt-5 space-y-4">
              <div className="card p-4" style={{ borderColor: "rgba(255, 255, 255, 0.12)" }}>
                <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
                  Summary
                </p>
                <p className="text-sm mt-2" style={{ color: "var(--fg-default)" }}>
                  This issue is causing repeated friction in the delivery pipeline. A Kaizen run can generate a
                  fix proposal, test checklist, and rollout notes automatically.
                </p>
              </div>

              <div className="card p-4" style={{ borderColor: "rgba(255, 255, 255, 0.12)" }}>
                <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
                  Placeholder Details
                </p>
                <p className="text-sm mt-2" style={{ color: "var(--fg-muted)" }}>
                  Status: {selectedIssue.status === "open" ? "Open" : "In Review"}
                </p>
                <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
                  Priority: {selectedIssue.priority}
                </p>
                <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
                  Suggested owner: Repo maintainers
                </p>
                <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
                  Estimated effort: 1-2 engineering days
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
