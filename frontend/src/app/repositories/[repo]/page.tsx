"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useParams } from "next/navigation";

function toDisplayName(repoSlug: string): string {
  return decodeURIComponent(repoSlug).replace(/[-_]+/g, " ").trim();
}

export default function RepositoryDetailPage() {
  const params = useParams<{ repo: string }>();
  const repoSlug = params?.repo ?? "unknown-repository";

  const repoName = useMemo(() => toDisplayName(repoSlug), [repoSlug]);

  return (
    <div className="flex flex-col gap-6 animate-in">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
            Repository Overview
          </p>
          <h1 className="text-2xl font-bold mt-1" style={{ color: "var(--fg-default)" }}>
            {repoName}
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
            Slug: {decodeURIComponent(repoSlug)}
          </p>
        </div>
      </div>

      <section
        className="card p-5"
        style={{
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
        }}
      >
        <h2 className="text-lg font-semibold" style={{ color: "var(--fg-default)" }}>
          Low-level Repository Details
        </h2>
        <p className="text-sm mt-2" style={{ color: "var(--fg-muted)" }}>
          This is a generic repository page rendered for any repository clicked from the dashboard.
          Add API-driven details here later (branches, commits, pull requests, and issue activity).
        </p>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
            --
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
            --
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
            --
          </p>
        </div>
      </section>
    </div>
  );
}
