"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { authApi } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";

const GITHUB_PAT_ERROR_STORAGE_KEY = "kaizen_github_pat_error";

const REQUIRED_PERMISSIONS = [
  {
    name: "Contents",
    access: "Read and Write",
    reason: "Required for pushing code changes and accessing repository files.",
  },
  {
    name: "Issues",
    access: "Read and Write",
    reason: "Required for reading and creating issue and PR comments.",
  },
  {
    name: "Pull requests",
    access: "Read and Write",
    reason: "Required for creating, listing, and managing pull requests.",
  },
  {
    name: "Metadata",
    access: "Read",
    reason:
      "Required for basic repository information (usually included automatically).",
  },
  {
    name: "Webhooks",
    access: "Read and Write",
    reason:
      "Required for creating webhooks that allows Kaizen to be informed of PR status changes.",
  },
] as const;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Could not validate this token. Please generate a new fine-grained token and try again.";
}

export default function GitHubApiPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading, refreshSession } = useAuth();
  const [token, setToken] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [status, setStatus] = useState<{
    kind: "idle" | "success" | "error";
    text: string;
  }>({
    kind: "idle",
    text: "",
  });

  useEffect(() => {
    if (isLoading) return;
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
        <p className="text-sm" style={{ color: "#d1d5db" }}>
          Loading…
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const cleanedToken = token.trim();
    if (!cleanedToken) {
      setStatus({
        kind: "error",
        text: "Please paste your GitHub token before submitting.",
      });
      return;
    }

    setIsSubmitting(true);
    setStatus({ kind: "idle", text: "" });

    try {
      await authApi.setGithubApiKey(cleanedToken);
      setToken("");
      await refreshSession();
      setStatus({
        kind: "success",
        text: "Token saved. Redirecting to dashboard…",
      });
      setTimeout(() => {
        router.push("/dashboard");
      }, 500);
    } catch (error) {
      const reason = getErrorMessage(error);

      setStatus({ kind: "error", text: reason });
      try {
        sessionStorage.setItem(GITHUB_PAT_ERROR_STORAGE_KEY, reason);
      } catch {
        /* private mode / quota */
      }
      router.push("/github_api/error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-4xl flex flex-row gap-4"
      >
        <div className="w-3/5 px-6 md:px-8">
          <h1
            className="text-2xl md:text-3xl font-bold"
            style={{ color: "#ffffff" }}
          >
            Create and submit a fine-grained personal access token
          </h1>
          <p className="mt-3 text-sm md:text-base" style={{ color: "#d1d5db" }}>
            Follow these exact steps, then paste the generated token below.
          </p>

          <ol
            className="mt-4 space-y-2.5 text-sm md:text-base"
            style={{ color: "#e5e7eb" }}
          >
            <li>
              <strong style={{ color: "#ffffff" }}>
                1. Open token settings:
              </strong>{" "}
              Go to{" "}
              <a
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
                className="underline"
                style={{ color: "#ffffff" }}
              >
                GitHub Fine-Grained PAT Creation
              </a>
              .
            </li>
            <li>
              <strong style={{ color: "#ffffff" }}>
                2. Select resource owner and repositories:
              </strong>{" "}
              Choose your account and grant access to the repositories you want
              Kaizen to manage (or all repositories).
            </li>
            <li>
              <strong style={{ color: "#ffffff" }}>
                3. Set repository permissions:
              </strong>
              <ul className="mt-1.5 list-disc pl-5 space-y-1">
                {REQUIRED_PERMISSIONS.map((permission) => (
                  <li key={permission.name}>
                    <p style={{ color: "#ffffff" }} className="inline">
                      {permission.name}: {permission.access}
                    </p>
                    <span style={{ color: "#d1d5db" }}>
                      {" "}
                      - {permission.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
            <li>
              <strong style={{ color: "#ffffff" }}>4. Generate token:</strong>{" "}
              Click <em>Generate token</em> and copy it immediately.
            </li>
            <li>
              <strong style={{ color: "#ffffff" }}>
                5. Submit token here:
              </strong>{" "}
              Paste the token into the field below and click submit.
            </li>
          </ol>
        </div>

        <div
          className="w-2/5 h-fit self-center rounded-xl p-6 md:p-8"
          style={{
            backgroundColor: "rgba(0, 0, 0, 0.08)",
            border: "1px solid rgba(172, 172, 172, 0.67)",
            backdropFilter: "blur(8px)",
          }}
        >
          <div className="flex flex-col gap-3">
            <label
              htmlFor="github-token"
              className="text-base md:text-lg font-medium"
              style={{ color: "#ffffff" }}
            >
              Paste your Fine-grained GitHub PAT here:
            </label>
            <input
              id="github-token"
              type="password"
              className="input text-sm md:text-base"
              placeholder="github_pat_..."
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              style={{
                borderColor: "rgba(172, 172, 172, 0.67)",
                color: "rgba(172, 172, 172, 0.67)",
              }}
            />

            {status.kind !== "idle" && (
              <p
                className="text-sm px-3 py-2 rounded-md"
                style={{
                  color:
                    status.kind === "success"
                      ? "var(--success-fg)"
                      : "var(--danger-fg)",
                  backgroundColor:
                    status.kind === "success"
                      ? "var(--success-subtle)"
                      : "var(--danger-subtle)",
                  border:
                    status.kind === "success"
                      ? "1px solid var(--success-muted)"
                      : "1px solid var(--danger-muted)",
                }}
              >
                {status.text}
              </p>
            )}
          </div>

          <button
            type="submit"
            className="btn-primary w-full py-2 text-sm md:text-base font-medium mt-10"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Submitting..." : "Submit Token"}
          </button>
        </div>
      </form>
    </div>
  );
}
