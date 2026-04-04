"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  /* ── Submit ──────────────────────────────────────────────── */

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    router.push("/github_api");
  }

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <>
    <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
      <div className="w-full max-w-sm flex flex-col gap-6 animate-in">
        {/* Logo / Heading */}
        <div className="text-center">
          <Link href="/" className="inline-block mb-4">
            <img src="/logo.svg" alt="Kaizen" width="32" height="32" className="shrink-0 mx-auto" />
          </Link>
          <h1
            className="text-xl font-bold"
            style={{ color: "var(--fg-default)" }}
          >
            Sign in to Kaizen
          </h1>
        </div>

        {/* Form card */}
        <div className="card p-6" style={{ borderColor: "rgba(255, 255, 255, 0.22)" }}>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Username */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="username"
                className="text-sm font-medium"
                style={{ color: "var(--fg-default)" }}
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                className="input"
                style={{ borderColor: "rgba(255, 255, 255, 0.24)" }}
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>

            {/* Password */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="password"
                className="text-sm font-medium"
                style={{ color: "var(--fg-default)" }}
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                className="input"
                style={{ borderColor: "rgba(255, 255, 255, 0.24)" }}
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>

            {/* Error message (temporarily disabled) */}
            {/* {error && (
              <p
                className="text-sm px-3 py-2 rounded-md"
                style={{
                  color: "var(--danger-fg)",
                  backgroundColor: "var(--danger-subtle)",
                  border: "1px solid var(--danger-muted)",
                }}
              >
                {error}
              </p>
            )} */}

            {/* Submit */}
            <button
              type="submit"
              className="btn-primary w-full py-2 text-sm font-medium mt-1"
            >
              Sign in
            </button>
          </form>
        </div>

        {/* Toggle mode */}
        <div
          className="card p-4 text-center text-sm"
          style={{ color: "var(--fg-muted)", borderColor: "rgba(255, 255, 255, 0.22)" }}
        >
          Don&apos;t have an account?{" "}
          <Link
            href="/register"
            className="font-medium hover:underline"
            style={{ color: "var(--accent-fg)" }}
          >
            Sign up
          </Link>
        </div>
      </div>
    </div>
    </>
  );
}
