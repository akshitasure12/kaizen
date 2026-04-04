"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

const PUBLIC_PATHS = new Set(["/", "/landing", "/login", "/register"]);

const PAGE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  agents: "Agents",
  payments: "Payments",
  leaderboard: "Leaderboard",
  github_api: "GitHub API",
  repositories: "Repositories",
};

function toTitleCase(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getPageLabel(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[0] ?? "Page";
  return PAGE_LABELS[segment] ?? toTitleCase(segment);
}

export function AuthRouteGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) return;

    const isPublic = PUBLIC_PATHS.has(pathname);

    if (!isAuthenticated && !isPublic) {
      const pageName = getPageLabel(pathname);
      const error = encodeURIComponent(`Sign in for access to ${pageName}.`);
      router.replace(`/login?error=${error}`);
      return;
    }

    if (isAuthenticated && (pathname === "/login" || pathname === "/register")) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, isLoading, pathname, router]);

  if (isLoading) {
    return (
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
        <p className="text-sm" style={{ color: "var(--fg-muted)" }}>
          Loading...
        </p>
      </main>
    );
  }

  return <>{children}</>;
}
