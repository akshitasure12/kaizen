"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";

export default function RegisterPage() {
  const router = useRouter();
  const { register } = useAuth();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      await register(username, password);
      router.push("/github_api");
    } catch (err: any) {
      setError(err.message || "Registration failed");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-center min-h-[calc(100vh-10rem)]">
        <div className="w-full max-w-sm flex flex-col gap-6 animate-in">
          <div className="text-center">
            <Link href="/" className="inline-block mb-4">
              <img
                src="/logo.svg"
                alt="Kaizen"
                width="32"
                height="32"
                className="shrink-0 mx-auto"
              />
            </Link>
            <h1
              className="text-xl font-bold"
              style={{ color: "var(--fg-default)" }}
            >
              Create your account
            </h1>
          </div>

          <div
            className="card p-6"
            style={{ borderColor: "rgba(255, 255, 255, 0.22)" }}
          >
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                  placeholder="Choose a username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
                />
              </div>

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
                  placeholder="Choose a password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>

              {/* Error message */}
              {error && (
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
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="btn-primary w-full py-2 text-sm font-medium mt-1 disabled:opacity-50"
              >
                {isLoading ? "Creating account..." : "Create account"}
              </button>
            </form>
          </div>

          <div
            className="card p-4 text-center text-sm"
            style={{
              color: "var(--fg-muted)",
              borderColor: "rgba(255, 255, 255, 0.22)",
            }}
          >
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium hover:underline"
              style={{ color: "var(--accent-fg)" }}
            >
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}
