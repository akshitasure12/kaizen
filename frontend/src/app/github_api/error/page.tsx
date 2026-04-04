"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

const GITHUB_PAT_ERROR_STORAGE_KEY = "kaizen_github_pat_error";

function GithubTokenErrorContent() {
  const searchParams = useSearchParams();
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let fromStore: string | null = null;
    try {
      fromStore = sessionStorage.getItem(GITHUB_PAT_ERROR_STORAGE_KEY);
      if (fromStore) sessionStorage.removeItem(GITHUB_PAT_ERROR_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    const fromQuery = searchParams.get("reason")?.trim() || null;
    setReason(fromStore?.trim() || fromQuery);
  }, [searchParams]);

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
      <div
        className="w-full max-w-xl rounded-xl p-6 md:p-8"
        style={{
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          border: "1px solid rgba(255, 255, 255, 0.1)",
          backdropFilter: "blur(8px)",
        }}
      >
        <p className="text-sm font-medium tracking-wide" style={{ color: "var(--danger-fg)" }}>
          Token Validation Failed
        </p>
        <h1 className="mt-2 text-2xl font-bold" style={{ color: "#ffffff" }}>
          This GitHub token is invalid or missing permissions
        </h1>
        <p className="mt-3 text-sm md:text-base" style={{ color: "#d1d5db" }}>
          Please generate a new fine-grained token with the required repository permissions, then try again.
        </p>

        {reason && (
          <p
            className="mt-4 text-sm px-3 py-2 rounded-md"
            style={{
              color: "var(--danger-fg)",
              backgroundColor: "var(--danger-subtle)",
              border: "1px solid var(--danger-muted)",
            }}
          >
            {reason}
          </p>
        )}

        <div className="mt-6 flex flex-col sm:flex-row gap-3">
          <Link href="/github_api" className="btn-primary text-sm text-center">
            Try Again
          </Link>
          <Link href="/landing" className="btn-secondary text-sm text-center">
            Go to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function GithubTokenErrorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
          <p className="text-sm" style={{ color: "#d1d5db" }}>
            Loading…
          </p>
        </div>
      }
    >
      <GithubTokenErrorContent />
    </Suspense>
  );
}
