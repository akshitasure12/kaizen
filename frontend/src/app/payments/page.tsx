"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import {
  blockchainApi,
  type BlockchainConfig,
  type OnchainEventRow,
} from "@/lib/api";

const PER_PAGE = 25;

export default function PaymentsPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const [config, setConfig] = useState<BlockchainConfig | null>(null);
  const [configErr, setConfigErr] = useState<string | null>(null);

  const [rows, setRows] = useState<OnchainEventRow[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsErr, setEventsErr] = useState<string | null>(null);

  useEffect(() => {
    void blockchainApi
      .config()
      .then(setConfig)
      .catch((e) =>
        setConfigErr(e instanceof Error ? e.message : "Config failed"),
      );
  }, []);

  const loadEvents = useCallback(async () => {
    if (!isAuthenticated) return;
    setEventsLoading(true);
    setEventsErr(null);
    try {
      const res = await blockchainApi.onchainEvents({
        limit: PER_PAGE,
        offset,
      });
      setRows(res.data);
      setTotal(res.pagination.total);
      setHasMore(res.pagination.has_more);
    } catch (e) {
      setEventsErr(e instanceof Error ? e.message : "Failed to load events");
    } finally {
      setEventsLoading(false);
    }
  }, [isAuthenticated, offset]);

  useEffect(() => {
    if (isAuthenticated) void loadEvents();
  }, [isAuthenticated, loadEvents]);

  if (authLoading) {
    return (
      <p className="p-8" style={{ color: "var(--fg-muted)" }}>
        Loading…
      </p>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="p-8 max-w-lg space-y-4">
        <p style={{ color: "var(--fg-default)" }}>
          Log in to see on-chain activity for your agents and repositories.
        </p>
        <Link href="/login" className="btn-primary text-sm inline-block">
          Log in
        </Link>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const pageNum = Math.floor(offset / PER_PAGE) + 1;

  return (
    <div
      className="min-h-screen mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-10"
      style={{ backgroundColor: "var(--bg-canvas)" }}
    >
      <h1
        className="text-3xl font-bold mb-2"
        style={{ color: "var(--fg-default)" }}
      >
        Payments & on-chain
      </h1>
      <p className="mb-8" style={{ color: "var(--fg-muted)" }}>
        Indexed contract events (deposits, bounties) scoped to your account.
      </p>

      <section
        className="mb-8 rounded-xl p-4 border"
        style={{ borderColor: "var(--border-default)" }}
      >
        <h2
          className="text-sm font-semibold uppercase tracking-wide mb-2"
          style={{ color: "var(--fg-subtle)" }}
        >
          Chain config
        </h2>
        {configErr && (
          <p className="text-sm" style={{ color: "#f87171" }}>
            {configErr}
          </p>
        )}
        {config && (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm font-mono">
            <div>
              <dt style={{ color: "var(--fg-subtle)" }}>Enabled</dt>
              <dd style={{ color: "var(--fg-default)" }}>
                {String(config.enabled)}
              </dd>
            </div>
            <div>
              <dt style={{ color: "var(--fg-subtle)" }}>Chain ID</dt>
              <dd style={{ color: "var(--fg-default)" }}>{config.chainId}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt style={{ color: "var(--fg-subtle)" }}>Token</dt>
              <dd style={{ color: "var(--fg-default)" }}>
                {config.token.symbol} ({config.token.name}) ·{" "}
                {config.token.mock ? "mock metadata" : "on-chain"}
              </dd>
            </div>
            <div className="sm:col-span-2 break-all">
              <dt style={{ color: "var(--fg-subtle)" }}>ABT</dt>
              <dd style={{ color: "var(--fg-muted)" }}>
                {config.abtContract ?? "—"}
              </dd>
            </div>
            <div className="sm:col-span-2 break-all">
              <dt style={{ color: "var(--fg-subtle)" }}>Bounty</dt>
              <dd style={{ color: "var(--fg-muted)" }}>
                {config.bountyContract ?? "—"}
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section>
        <h2
          className="text-lg font-semibold mb-3"
          style={{ color: "var(--fg-default)" }}
        >
          Recent events
        </h2>
        {eventsErr && (
          <p className="mb-3 text-sm" style={{ color: "#f87171" }}>
            {eventsErr}
          </p>
        )}
        {eventsLoading ? (
          <p style={{ color: "var(--fg-muted)" }}>Loading events…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: "var(--fg-muted)" }}>
            No indexed events yet, or none visible for your account. Ensure RPC
            and contract addresses are set and the API indexer is running.
          </p>
        ) : (
          <div
            className="rounded-xl overflow-x-auto border"
            style={{ borderColor: "var(--border-default)" }}
          >
            <table className="w-full text-xs sm:text-sm">
              <thead>
                <tr
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    color: "var(--fg-subtle)",
                  }}
                >
                  <th className="text-left px-3 py-2">Block</th>
                  <th className="text-left px-3 py-2">Event</th>
                  <th className="text-left px-3 py-2">Tx</th>
                  <th className="text-left px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    style={{ borderTop: "1px solid var(--border-muted)" }}
                  >
                    <td
                      className="px-3 py-2 whitespace-nowrap tabular-nums"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {r.block_number}
                    </td>
                    <td
                      className="px-3 py-2 font-medium whitespace-nowrap"
                      style={{ color: "var(--fg-default)" }}
                    >
                      {r.event_name}
                    </td>
                    <td
                      className="px-3 py-2 font-mono max-w-[140px] truncate"
                      style={{ color: "var(--fg-muted)" }}
                      title={r.tx_hash}
                    >
                      {r.tx_hash}
                    </td>
                    <td
                      className="px-3 py-2 font-mono break-all max-w-md"
                      style={{ color: "var(--fg-muted)" }}
                    >
                      {r.ens_name && <span>ens:{r.ens_name} </span>}
                      {r.issue_id && (
                        <span className="block truncate">issue:{r.issue_id}</span>
                      )}
                      <span className="opacity-80">
                        {JSON.stringify(r.payload)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > PER_PAGE && (
          <div className="flex justify-between items-center mt-4 text-sm">
            <span style={{ color: "var(--fg-subtle)" }}>
              Page {pageNum} / {pages} · {total} events
            </span>
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
      </section>
    </div>
  );
}
