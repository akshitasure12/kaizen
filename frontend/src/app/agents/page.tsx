"use client";

import { useEffect, useRef, useState } from "react";
import agentsData from "@/data/agents.json";

const PER_PAGE = agentsData.per_page ?? 5;

type Agent = {
  id: string;
  name: string;
  role: string;
  created_at: string;
  capabilities: string[];
  reputation_score: number;
  wallet_balance: number;
  max_bounty_spent: number;
};

type AgentsResponse = {
  agents: Agent[];
  page: number;
  per_page: number;
  total: number;
};

function normalizeAgentsPayload(raw: unknown, page: number): AgentsResponse {
  let rows: unknown[] = [];
  if (Array.isArray(raw)) {
    rows = raw;
  } else if (raw && typeof raw === "object" && Array.isArray((raw as { agents?: unknown }).agents)) {
    rows = (raw as { agents: unknown[] }).agents;
  }
  const mapped: Agent[] = rows.map((row) => {
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? "");
    const name = String(r.name ?? r.ens_name ?? "");
    const caps = r.capabilities;
    const capabilities = Array.isArray(caps) ? caps.map(String) : [];
    const maxRaw = r.max_bounty_spent ?? r.max_bounty_spend;
    return {
      id,
      name,
      role: String(r.role ?? ""),
      created_at: String(r.created_at ?? ""),
      capabilities,
      reputation_score: Number(r.reputation_score ?? 0),
      wallet_balance: Number(r.wallet_balance ?? 0),
      max_bounty_spent: typeof maxRaw === "number" ? maxRaw : Number(maxRaw ?? 0),
    };
  });
  const start = (page - 1) * PER_PAGE;
  const agents = mapped.slice(start, start + PER_PAGE);
  return {
    agents,
    page,
    per_page: PER_PAGE,
    total: mapped.length,
  };
}
async function fetchAgents(page: number): Promise<AgentsResponse> {
  try {
    const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
    const token = typeof window !== "undefined" ? localStorage.getItem("ab_token") : null;
    const res = await fetch(
      `${BASE}/agents?page=${page}&per_page=${PER_PAGE}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} }
    );
    if (!res.ok) throw new Error(`${res.status}`);
    const raw: unknown = await res.json();
    return normalizeAgentsPayload(raw, page);
  } catch {
    // Fall back to local fake data
    const start = (page - 1) * PER_PAGE;
    return {
      agents: agentsData.agents.slice(start, start + PER_PAGE) as Agent[],
      page,
      per_page: PER_PAGE,
      total: agentsData.total,
    };
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// ── Editable cell ──────────────────────────────────────────────────────────
function EditableText({
  value,
  onSave,
}: {
  value: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== value) onSave(draft.trim());
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        className="w-full bg-transparent border-b outline-none text-sm"
        style={{ color: "var(--fg-default)", borderColor: "var(--border-default)" }}
      />
    );
  }

  return (
    <span
      className="cursor-pointer hover:underline underline-offset-2 decoration-dashed"
      style={{ color: "var(--fg-default)" }}
      title="Click to edit"
      onClick={() => setEditing(true)}
    >
      {value || <span style={{ color: "var(--fg-subtle)" }}>—</span>}
    </span>
  );
}

// ── Editable capabilities ──────────────────────────────────────────────────
function EditableCapabilities({
  value,
  onSave,
}: {
  value: string[];
  onSave: (v: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value.join(", "));

  const commit = () => {
    setEditing(false);
    const next = draft.split(",").map((s) => s.trim()).filter(Boolean);
    onSave(next);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value.join(", ")); setEditing(false); } }}
        className="w-full bg-transparent border-b outline-none text-xs"
        style={{ color: "var(--fg-default)", borderColor: "var(--border-default)" }}
        placeholder="comma-separated"
      />
    );
  }

  return (
    <div
      className="flex flex-wrap gap-1 cursor-pointer"
      title="Click to edit"
      onClick={() => setEditing(true)}
    >
      {value.map((cap) => (
        <span
          key={cap}
          className="px-2 py-0.5 rounded text-xs font-medium"
          style={{
            backgroundColor: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "var(--fg-muted)",
          }}
        >
          {cap}
        </span>
      ))}
    </div>
  );
}

// ── Capabilities tag input ─────────────────────────────────────────────────
function TagInput({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (v: string[]) => void;
}) {
  const [input, setInput] = useState("");

  const addTag = (raw: string) => {
    const trimmed = raw.trim().replace(/,\s*$/, "");
    if (trimmed && !tags.includes(trimmed)) {
      onChange([...tags, trimmed]);
    }
    setInput("");
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (val.endsWith(", ") || (val.endsWith(",") && val.length > 1)) {
      addTag(val.replace(/,\s*$/, ""));
    } else {
      setInput(val);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTag(input);
    } else if (e.key === "Backspace" && input === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  };

  return (
    <div
      className="rounded-lg p-3 min-h-[52px] flex flex-wrap gap-1.5 items-start"
      style={{
        backgroundColor: "rgba(255,255,255,0.04)",
        border: "1px solid var(--border-default)",
      }}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium"
          style={{
            backgroundColor: "rgba(255,255,255,0.08)",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "var(--fg-muted)",
          }}
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(tags.filter((t) => t !== tag))}
            className="ml-0.5 leading-none hover:text-white"
            style={{ color: "var(--fg-subtle)" }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={tags.length === 0 ? "type a capability, add comma to tag…" : ""}
        className="flex-1 bg-transparent outline-none min-w-32"
        style={{ color: "var(--fg-default)", fontSize: "14px" }}
      />
    </div>
  );
}

// ── Add agent modal ────────────────────────────────────────────────────────
function AddAgentModal({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (agent: Agent) => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [docFile, setDocFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    if (!name.trim()) return;
    const newAgent: Agent = {
      id: `agt_${Date.now()}`,
      name: name.trim(),
      role: role.trim(),
      created_at: new Date().toISOString(),
      capabilities,
      reputation_score: 0,
      wallet_balance: 0,
      max_bounty_spent: 0,
    };
    onAdd(newAgent);
    onClose();
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    backgroundColor: "rgba(255,255,255,0.04)",
    border: "1px solid var(--border-default)",
    borderRadius: "8px",
    padding: "10px 14px",
    color: "var(--fg-default)",
    fontSize: "16px",
    outline: "none",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl p-7"
        style={{ backgroundColor: "var(--bg-subtle)", border: "1px solid var(--border-default)" }}
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 text-2xl leading-none transition-colors hover:text-white"
          style={{ color: "var(--fg-subtle)" }}
        >
          ×
        </button>

        <h2 className="text-xl font-semibold mb-7" style={{ color: "var(--fg-default)" }}>
          Add new agent
        </h2>

        <div className="space-y-5">
          <div>
            <label className="block mb-1.5 text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder="agent-name"
              style={inputStyle}
            />
          </div>

          <div>
            <label className="block mb-1.5 text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
              Role
            </label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              placeholder="e.g. Solidity Developer"
              style={inputStyle}
            />
          </div>

          <div>
            <label className="block mb-1.5 text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
              Capabilities
              <span className="ml-1.5 font-normal" style={{ color: "var(--fg-subtle)", fontSize: "12px" }}>
                (add comma to tag)
              </span>
            </label>
            <TagInput tags={capabilities} onChange={setCapabilities} />
          </div>

          <div>
            <label className="block mb-1.5 text-sm font-medium" style={{ color: "var(--fg-muted)" }}>
              Knowledge document
              <span className="ml-1.5 font-normal" style={{ color: "var(--fg-subtle)", fontSize: "12px" }}>
                (optional)
              </span>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.md,.txt,.json"
              onChange={(e) => setDocFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="w-full rounded-lg py-2.5 px-4 text-sm transition-colors text-left"
              style={{
                backgroundColor: "rgba(255,255,255,0.04)",
                border: "1px dashed var(--border-default)",
                color: docFile ? "var(--fg-default)" : "var(--fg-subtle)",
              }}
            >
              {docFile ? docFile.name : "Click to upload (.pdf, .md, .txt, .json)"}
            </button>
          </div>
        </div>

        <button
          onClick={handleAdd}
          disabled={!name.trim()}
          className="mt-7 w-full py-3 rounded-lg font-semibold text-base transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            color: "#000000",
            backgroundColor: "#ffffff",
            border: "1px solid transparent",
          }}
          onMouseEnter={(e) => {
            if (!name.trim()) return;
            e.currentTarget.style.color = "#ffffff";
            e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.15)";
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "#000000";
            e.currentTarget.style.backgroundColor = "#ffffff";
            e.currentTarget.style.borderColor = "transparent";
          }}
        >
          Add agent
        </button>
      </div>
    </div>
  );
}

// ── Agent row ──────────────────────────────────────────────────────────────
function AgentRow({
  agent,
  onUpdate,
  onDelete,
}: {
  agent: Agent;
  onUpdate: (id: string, patch: Partial<Agent>) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <tr
      className="transition-colors"
      style={{ borderBottom: "1px solid var(--border-muted)" }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)")}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
    >
      {/* Name */}
      <td className="px-4 py-4 align-top w-36">
        <EditableText
          value={agent.name}
          onSave={(v) => onUpdate(agent.id, { name: v })}
        />
        <div className="text-xs mt-0.5" style={{ color: "var(--fg-subtle)" }}>
          {agent.role}
        </div>
      </td>

      {/* Created */}
      <td className="px-4 py-4 align-top text-sm whitespace-nowrap" style={{ color: "var(--fg-muted)" }}>
        {formatDate(agent.created_at)}
      </td>

      {/* Capabilities */}
      <td className="px-4 py-4 align-top min-w-48">
        <EditableCapabilities
          value={agent.capabilities}
          onSave={(v) => onUpdate(agent.id, { capabilities: v })}
        />
      </td>

      {/* Reputation */}
      <td className="px-4 py-4 align-top text-sm text-right tabular-nums" style={{ color: "var(--fg-default)" }}>
        {agent.reputation_score.toLocaleString()}
      </td>

      {/* Wallet */}
      <td className="px-4 py-4 align-top text-sm text-right tabular-nums" style={{ color: "var(--fg-muted)" }}>
        {agent.wallet_balance.toFixed(4)} ETH
      </td>

      {/* Max bounty */}
      <td className="px-4 py-4 align-top text-right w-32">
        <EditableText
          value={agent.max_bounty_spent.toFixed(4)}
          onSave={(v) => {
            const n = parseFloat(v);
            if (!isNaN(n)) onUpdate(agent.id, { max_bounty_spent: n });
          }}
        />
        <span className="text-xs ml-1" style={{ color: "var(--fg-subtle)" }}>ETH</span>
      </td>

      {/* Delete */}
      <td className="px-4 py-4 align-top text-center">
        <button
          onClick={() => onDelete(agent.id)}
          className="px-3 py-1 rounded text-xs font-medium transition-all"
          style={{
            color: "#ef4444",
            backgroundColor: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.2)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(239,68,68,0.18)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "rgba(239,68,68,0.08)";
          }}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));

  const load = async (p: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchAgents(p);
      setAgents(data.agents);
      setTotal(data.total);
    } catch {
      setError("Failed to load agents.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(page); }, [page]);

  const handleUpdate = (id: string, patch: Partial<Agent>) => {
    setAgents((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    // TODO: PATCH /agents/:id
  };

  const handleDelete = (id: string) => {
    setAgents((prev) => prev.filter((a) => a.id !== id));
    setTotal((t) => t - 1);
    // TODO: DELETE /agents/:id
  };

  const handleAdd = (agent: Agent) => {
    setAgents((prev) => [agent, ...prev]);
    setTotal((t) => t + 1);
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-canvas)" }}>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10">
        {/* ── Heading row ── */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold" style={{ color: "var(--fg-default)" }}>
              Agents
            </h1>
            <p className="mt-1" style={{ color: "var(--fg-muted)", fontSize: "18px" }}>
              Manage autonomous agents and their configuration.
            </p>
          </div>

          <button
            onClick={() => setShowModal(true)}
            className="px-5 py-2.5 rounded-md font-semibold transition-all"
            style={{
              color: "#000000",
              backgroundColor: "#ffffff",
              border: "1px solid transparent",
              fontSize: "18px",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "#ffffff";
              e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.15)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "#000000";
              e.currentTarget.style.backgroundColor = "#ffffff";
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            + Add new agent
          </button>
        </div>

        {/* ── Table ── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: "1px solid var(--border-default)" }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-24" style={{ color: "var(--fg-subtle)", fontSize: "18px" }}>
              Loading agents…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center py-24" style={{ color: "#ef4444", fontSize: "18px" }}>
              {error}
            </div>
          ) : agents.length === 0 ? (
            <div className="flex items-center justify-center py-24" style={{ color: "var(--fg-subtle)", fontSize: "18px" }}>
              No agents found.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr
                  className="text-xs uppercase tracking-wider"
                  style={{
                    backgroundColor: "var(--bg-subtle)",
                    borderBottom: "1px solid var(--border-default)",
                    color: "var(--fg-subtle)",
                  }}
                >
                  <th className="px-4 py-3 text-left font-medium">Name</th>
                  <th className="px-4 py-3 text-left font-medium">Created</th>
                  <th className="px-4 py-3 text-left font-medium">Capabilities</th>
                  <th className="px-4 py-3 text-right font-medium">Reputation</th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 text-right font-medium">Max Bounty</th>
                  <th className="px-4 py-3 text-center font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Pagination ── */}
        {!loading && !error && totalPages > 1 && (
          <div className="flex items-center justify-between mt-6">
            <p style={{ color: "var(--fg-subtle)", fontSize: "18px" }}>
              Page {page} of {totalPages} · {total} agents
            </p>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="px-4 py-1.5 rounded font-medium transition-all disabled:opacity-30"
                style={{
                  color: "var(--fg-default)",
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-default)",
                  fontSize: "18px",
                }}
              >
                ← Prev
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="px-4 py-1.5 rounded font-medium transition-all disabled:opacity-30"
                style={{
                  color: "var(--fg-default)",
                  backgroundColor: "var(--bg-subtle)",
                  border: "1px solid var(--border-default)",
                  fontSize: "18px",
                }}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </main>
      {showModal && (
        <AddAgentModal onClose={() => setShowModal(false)} onAdd={handleAdd} />
      )}
    </div>
  );
}
