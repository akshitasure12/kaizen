"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useState } from "react";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/agents", label: "Agents" },
  { href: "/payments", label: "Payments" },
  { href: "/leaderboard", label: "Leaderboard" },
];

export function Navbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { isAuthenticated, user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    setMobileOpen(false);
    router.push("/landing");
  };

  const isActive = (href: string) => {
    if (href === "/dashboard")
      return pathname === "/" || pathname === "/dashboard";
    return pathname.startsWith(href);
  };

  return (
    <header
      className="sticky top-0 z-50 border-b transition-all duration-300"
      style={{
        backgroundColor: "var(--bg-default)",
        borderColor: "var(--border-default)",
        backdropFilter: "none",
      }}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        {/* 3-column grid: logo | centered tabs | auth */}
        <div
          className="h-16 items-center hidden md:grid"
          style={{ gridTemplateColumns: "1fr auto 1fr" }}
        >
          {/* Left: Logo */}
          <div className="flex items-center">
            <Link href="/" className="flex items-center gap-2 group">
              <img
                src="/logo.svg"
                alt="Kaizen"
                width="32"
                height="32"
                className="shrink-0"
              />
              <span
                className="text-lg font-semibold"
                style={{ color: "var(--fg-default)" }}
              >
                Kaizen
              </span>
            </Link>
          </div>

          {/* Center: Nav tabs */}
          <nav className="flex items-center gap-1">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="px-3 py-2 rounded-md text-sm font-medium transition-colors"
                style={{
                  color: "#ffffff",
                  backgroundColor: isActive(item.href)
                    ? "var(--accent-emphasis)"
                    : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (!isActive(item.href)) {
                    e.currentTarget.style.color = "#ffffff";
                    e.currentTarget.style.backgroundColor = "var(--bg-subtle)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive(item.href)) {
                    e.currentTarget.style.color = "#ffffff";
                    e.currentTarget.style.backgroundColor = "transparent";
                  }
                }}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          {/* Right: Auth */}
          <div className="flex items-center justify-end gap-3">
            {isAuthenticated ? (
              <div className="flex items-center gap-3">
                <span
                  className="text-sm font-medium truncate max-w-[140px]"
                  style={{ color: "var(--fg-muted)" }}
                  title={user?.username}
                >
                  {user?.username}
                </span>
                <button
                  onClick={handleLogout}
                  className="btn-primary text-sm"
                  style={{
                    color: "#000000",
                    backgroundColor: "#ffffff",
                    border: "1px solid rgba(255, 255, 255, 0.2)",
                    boxShadow: "none",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = "#f0f0f0";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = "#ffffff";
                  }}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <Link
                href="/login"
                className="btn-primary text-sm"
                style={{
                  color: "#000000",
                  backgroundColor: "#ffffff",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  boxShadow: "none",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f0f0f0";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#ffffff";
                }}
              >
                Sign in
              </Link>
            )}
          </div>
        </div>

        {/* Mobile: flex layout (logo left, hamburger right) */}
        <div className="flex h-16 items-center justify-between md:hidden">
          <Link href="/" className="flex items-center gap-2">
            <img
              src="/logo.svg"
              alt="AgentBranch"
              width="32"
              height="32"
              className="shrink-0"
            />
            <span
              className="text-lg font-semibold"
              style={{ color: "var(--fg-default)" }}
            >
              Kaizen
            </span>
          </Link>

          <div className="flex items-center gap-3">
            {isAuthenticated ? (
              <button
                onClick={handleLogout}
                className="btn-primary text-sm px-4 py-2 rounded-md transition-colors inline-flex items-center"
                style={{
                  color: "#000000",
                  backgroundColor: "#ffffff",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  boxShadow: "none",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f0f0f0";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#ffffff";
                }}
              >
                Sign out
              </button>
            ) : (
              <Link
                href="/login"
                className="btn-primary text-sm px-4 py-2 rounded-md transition-colors inline-flex items-center"
                style={{
                  color: "#000000",
                  backgroundColor: "#ffffff",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  boxShadow: "none",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.backgroundColor = "#f0f0f0";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.backgroundColor = "#ffffff";
                }}
              >
                Sign in
              </Link>
            )}
            <button
              className="p-2 rounded-md"
              style={{ color: "var(--fg-default)" }}
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="Toggle menu"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                {mobileOpen ? (
                  <path
                    fillRule="evenodd"
                    d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                    clipRule="evenodd"
                  />
                ) : (
                  <path
                    fillRule="evenodd"
                    d="M3 5a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 10a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM3 15a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1z"
                    clipRule="evenodd"
                  />
                )}
              </svg>
            </button>
          </div>
        </div>

        {/* Mobile nav dropdown */}
        {mobileOpen && (
          <nav
            className="md:hidden pb-4 border-t"
            style={{ borderColor: "var(--border-muted)" }}
          >
            <div className="flex flex-col gap-1 pt-3">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  className="px-3 py-2 rounded-md text-sm font-medium"
                  style={{
                    color: "var(--fg-default)",
                    backgroundColor: isActive(item.href)
                      ? "var(--accent-emphasis)"
                      : "transparent",
                  }}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </nav>
        )}
      </div>
    </header>
  );
}
