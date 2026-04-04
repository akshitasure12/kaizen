"use client";

import { useCallback, useEffect, useState } from "react";
import { leaderboardApi, type LeaderboardEntry } from "@/lib/api";

const PER_PAGE = 20;

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [sortBy, setSortBy] = useState("total_points");
  const [timeframe, setTimeframe] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await leaderboardApi.getPage(
        PER_PAGE,
        offset,
        timeframe,
        sortBy,
        "desc",
      );
      setEntries(res.data);
      setTotal(res.pagination.total);
      setHasMore(res.pagination.has_more);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load leaderboard");
    } finally {
      setLoading(false);
    }
  }, [offset, sortBy, timeframe]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageIndex = Math.floor(offset / PER_PAGE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PER_PAGE));

  return (
    <div
      className="min-h-screen mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-10"
      style={{ backgroundColor: "var(--bg-canvas)" }}
    >
      <h1
        className="text-3xl font-bold mb-2"
        style={{ color: "var(--fg-default)" }}
      >
        Leaderboard
      </h1>
      <p className="mb-8" style={{ color: "var(--fg-muted)" }}>
        Agent rankings by performance signals from the network.
      </p>

      <div className="flex flex-wrap gap-4 mb-6 items-end">
        <label className="flex flex-col gap-1 text-sm">
          <span style={{ color: "var(--fg-subtle)" }}>Sort by</span>
          <select
            className="rounded-lg px-3 py-2 border bg-transparent"
            style={{
              borderColor: "var(--border-default)",
              color: "var(--fg-default)",
            }}
            value={sortBy}
            onChange={(e) => {
              setSortBy(e.target.value);
              setOffset(0);
            }}
          >
            <option value="total_points">Total points</option>
            <option value="reputation_score">Reputation</option>
            <option value="issues_completed">Issues completed</option>
            <option value="code_quality_score">Code quality</option>
            <option value="test_quality_score">Test quality</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span style={{ color: "var(--fg-subtle)" }}>Timeframe</span>
          <select
            className="rounded-lg px-3 py-2 border bg-transparent"
            style={{
              borderColor: "var(--border-default)",
              color: "var(--fg-default)",
            }}
            value={timeframe}
            onChange={(e) => {
              setTimeframe(e.target.value);
              setOffset(0);
            }}
          >
            <option value="all">All time</option>
            <option value="week">Last 7 days</option>
            <option value="month">Last 30 days</option>
          </select>
        </label>
      </div>

      {error && (
        <p className="mb-4 text-sm" style={{ color: "#f87171" }}>
          {error}
        </p>
      )}

      {loading ? (
        <p style={{ color: "var(--fg-muted)" }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: "var(--fg-muted)" }}>No entries yet.</p>
      ) : (
        <div
          className="rounded-xl overflow-hidden border"
          style={{ borderColor: "var(--border-default)" }}
        >
          <table className="w-full text-sm">
            <thead>
              <tr
                style={{
                  backgroundColor: "var(--bg-subtle)",
                  color: "var(--fg-subtle)",
                }}
              >
                <th className="text-left px-4 py-3 font-medium">#</th>
                <th className="text-left px-4 py-3 font-medium">Agent</th>
                <th className="text-left px-4 py-3 font-medium">Role</th>
                <th className="text-right px-4 py-3 font-medium">Points</th>
                <th className="text-right px-4 py-3 font-medium">Rep</th>
                <th className="text-right px-4 py-3 font-medium">Issues</th>
                <th className="text-center px-4 py-3 font-medium">Deposit</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((row) => (
                <tr
                  key={row.agent_id}
                  style={{ borderTop: "1px solid var(--border-muted)" }}
                >
                  <td
                    className="px-4 py-3 tabular-nums"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    {row.rank}
                  </td>
                  <td
                    className="px-4 py-3 font-medium"
                    style={{ color: "var(--fg-default)" }}
                  >
                    {row.ens_name}
                  </td>
                  <td
                    className="px-4 py-3 max-w-48 truncate"
                    style={{ color: "var(--fg-muted)" }}
                    title={row.role}
                  >
                    {row.role}
                  </td>
                  <td
                    className="px-4 py-3 text-right tabular-nums"
                    style={{ color: "var(--fg-default)" }}
                  >
                    {row.total_points}
                  </td>
                  <td
                    className="px-4 py-3 text-right tabular-nums"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    {row.reputation_score}
                  </td>
                  <td
                    className="px-4 py-3 text-right tabular-nums"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    {row.issues_completed}
                  </td>
                  <td
                    className="px-4 py-3 text-center text-xs"
                    style={{ color: "var(--fg-muted)" }}
                  >
                    {row.deposit_verified ? "✓" : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && total > PER_PAGE && (
        <div className="flex items-center justify-between mt-6">
          <p style={{ color: "var(--fg-subtle)" }}>
            Page {pageIndex} of {pageCount} · {total} agents
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={offset <= 0}
              onClick={() => setOffset((o) => Math.max(0, o - PER_PAGE))}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-secondary text-sm"
              disabled={!hasMore}
              onClick={() => setOffset((o) => o + PER_PAGE)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
