"use client";

import { useEffect, useRef, useState } from "react";
import { agentApi, type Agent as ApiAgent } from "@/lib/api";

const PER_PAGE = 10;

type Agent = {
  id: string;
  ens_name: string;
  role: string;
  created_at: string;
  capabilities: string[];
  reputation_score: number;
  wallet_balance: number;
  max_bounty_spend: number;
};

type AgentsResponse = {
  agents: Agent[];
  page: number;
  per_page: number;
  total: number;
};

function mapAgent(a: ApiAgent): Agent {
  const maxRaw = a.max_bounty_spend;
  return {
    id: a.id,
    ens_name: a.ens_name,
    role: a.role ?? "",
    created_at: a.created_at,
    capabilities: Array.isArray(a.capabilities) ? a.capabilities : [],
    reputation_score: a.reputation_score ?? 0,
    wallet_balance: Number(a.wallet_balance ?? 0),
    max_bounty_spend:
      maxRaw === null || maxRaw === undefined
        ? 0
        : typeof maxRaw === "number"
          ? maxRaw
          : Number(maxRaw),
  };
}

async function fetchAgents(page: number): Promise<AgentsResponse> {
  const offset = (page - 1) * PER_PAGE;
  const res = await agentApi.list({
    mine: true,
    limit: PER_PAGE,
    offset,
  });
  return {
    agents: res.data.map(mapAgent),
    page,
    per_page: PER_PAGE,
    total: res.pagination.total,
  };
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
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className="w-full bg-transparent border-b outline-none text-sm"
        style={{
          color: "var(--fg-default)",
          borderColor: "var(--border-default)",
        }}
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
    const next = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onSave(next);
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(value.join(", "));
            setEditing(false);
          }
        }}
        className="w-full bg-transparent border-b outline-none text-xs"
        style={{
          color: "var(--fg-default)",
          borderColor: "var(--border-default)",
        }}
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
        placeholder={
          tags.length === 0 ? "type a capability, add comma to tag…" : ""
        }
        className="flex-1 bg-transparent outline-none min-w-32"
        style={{ color: "var(--fg-default)", fontSize: "14px" }}
      />
    </div>
  );
}

// ── Add agent modal ────────────────────────────────────────────────────────
function AddAgentModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleAdd = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setSaveErr(null);
    try {
      await agentApi.create({
        ens_name: name.trim().toLowerCase(),
        role: role.trim() || undefined,
        capabilities,
      });
      onCreated();
      onClose();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "Failed to create agent");
    } finally {
      setSaving(false);
    }
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
      style={{
        backgroundColor: "rgba(0,0,0,0.65)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="relative w-full max-w-md mx-4 rounded-2xl p-7"
        style={{
          backgroundColor: "var(--bg-subtle)",
          border: "1px solid var(--border-default)",
        }}
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 text-2xl leading-none transition-colors hover:text-white"
          style={{ color: "var(--fg-subtle)" }}
        >
          ×
        </button>

        <h2
          className="text-xl font-semibold mb-7"
          style={{ color: "var(--fg-default)" }}
        >
          Add new agent
        </h2>

        <div className="space-y-5">
          <div>
            <label
              className="block mb-1.5 text-sm font-medium"
              style={{ color: "var(--fg-muted)" }}
            >
              ENS name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
              }}
              placeholder="myagent.eth"
              style={inputStyle}
            />
          </div>

          <div>
            <label
              className="block mb-1.5 text-sm font-medium"
              style={{ color: "var(--fg-muted)" }}
            >
              Role
            </label>
            <input
              value={role}
              onChange={(e) => setRole(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
              }}
              placeholder="e.g. Solidity Developer"
              style={inputStyle}
            />
          </div>

          <div>
            <label
              className="block mb-1.5 text-sm font-medium"
              style={{ color: "var(--fg-muted)" }}
            >
              Capabilities
              <span
                className="ml-1.5 font-normal"
                style={{ color: "var(--fg-subtle)", fontSize: "12px" }}
              >
                (add comma to tag)
              </span>
            </label>
            <TagInput tags={capabilities} onChange={setCapabilities} />
          </div>

          <div>
            <label
              className="block mb-1.5 text-sm font-medium"
              style={{ color: "var(--fg-muted)" }}
            >
              Knowledge document
              <span
                className="ml-1.5 font-normal"
                style={{ color: "var(--fg-subtle)", fontSize: "12px" }}
              >
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
              {docFile
                ? docFile.name
                : "Click to upload (.pdf, .md, .txt, .json)"}
            </button>
          </div>
        </div>

        {saveErr && (
          <p className="mt-4 text-sm" style={{ color: "#f87171" }}>
            {saveErr}
          </p>
        )}

        <button
          onClick={() => void handleAdd()}
          disabled={!name.trim() || saving}
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
          {saving ? "Creating…" : "Add agent"}
        </button>
      </div>
    </div>
  );
}

// ── Agent row ──────────────────────────────────────────────────────────────
function AgentRow({
  agent,
  onUpdate,
}: {
  agent: Agent;
  onUpdate: (
    ensName: string,
    patch: Partial<Pick<Agent, "role" | "capabilities" | "max_bounty_spend">>,
  ) => void;
}) {
  return (
    <tr
      className="transition-colors"
      style={{ borderBottom: "1px solid var(--border-muted)" }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "rgba(255,255,255,0.03)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
    >
      <td className="px-4 py-4 align-top w-44">
        <div
          className="text-sm font-medium break-all"
          style={{ color: "var(--fg-default)" }}
        >
          {agent.ens_name}
        </div>
        <div className="text-xs mt-1" style={{ color: "var(--fg-subtle)" }}>
          Role:{" "}
          <EditableText
            value={agent.role}
            onSave={(v) => onUpdate(agent.ens_name, { role: v })}
          />
        </div>
      </td>

      <td
        className="px-4 py-4 align-top text-sm whitespace-nowrap"
        style={{ color: "var(--fg-muted)" }}
      >
        {formatDate(agent.created_at)}
      </td>

      <td className="px-4 py-4 align-top min-w-48">
        <EditableCapabilities
          value={agent.capabilities}
          onSave={(v) => onUpdate(agent.ens_name, { capabilities: v })}
        />
      </td>

      <td
        className="px-4 py-4 align-top text-sm text-right tabular-nums"
        style={{ color: "var(--fg-default)" }}
      >
        {agent.reputation_score.toLocaleString()}
      </td>

      <td
        className="px-4 py-4 align-top text-sm text-right tabular-nums"
        style={{ color: "var(--fg-muted)" }}
      >
        {agent.wallet_balance.toFixed(4)} ETH
      </td>

      <td className="px-4 py-4 align-top text-right w-32">
        <EditableText
          value={agent.max_bounty_spend.toFixed(4)}
          onSave={(v) => {
            const n = parseFloat(v);
            if (!isNaN(n)) onUpdate(agent.ens_name, { max_bounty_spend: n });
          }}
        />
        <span className="text-xs ml-1" style={{ color: "var(--fg-subtle)" }}>
          ETH
        </span>
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
  const [updateErr, setUpdateErr] = useState<string | null>(null);

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

  useEffect(() => {
    load(page);
  }, [page]);

  const handleUpdate = async (
    ensName: string,
    patch: Partial<Pick<Agent, "role" | "capabilities" | "max_bounty_spend">>,
  ) => {
    setUpdateErr(null);
    const body: {
      role?: string;
      capabilities?: string[];
      max_bounty_spend?: number;
    } = {};
    if (patch.role !== undefined) body.role = patch.role;
    if (patch.capabilities !== undefined) body.capabilities = patch.capabilities;
    if (patch.max_bounty_spend !== undefined)
      body.max_bounty_spend = patch.max_bounty_spend;
    if (Object.keys(body).length === 0) return;
    try {
      const updated = await agentApi.patch(ensName, body);
      setAgents((prev) =>
        prev.map((a) =>
          a.ens_name === ensName ? mapAgent(updated as ApiAgent) : a,
        ),
      );
    } catch (e) {
      setUpdateErr(
        e instanceof Error ? e.message : "Failed to update agent",
      );
    }
  };

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: "var(--bg-canvas)" }}
    >
      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10">
        {/* ── Heading row ── */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1
              className="text-3xl font-bold"
              style={{ color: "var(--fg-default)" }}
            >
              Agents
            </h1>
            <p
              className="mt-1"
              style={{ color: "var(--fg-muted)", fontSize: "18px" }}
            >
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

        {updateErr && (
          <p className="mb-4 text-sm" style={{ color: "#f87171" }}>
            {updateErr}
          </p>
        )}

        {/* ── Table ── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{ border: "1px solid var(--border-default)" }}
        >
          {loading ? (
            <div
              className="flex items-center justify-center py-24"
              style={{ color: "var(--fg-subtle)", fontSize: "18px" }}
            >
              Loading agents…
            </div>
          ) : error ? (
            <div
              className="flex items-center justify-center py-24"
              style={{ color: "#ef4444", fontSize: "18px" }}
            >
              {error}
            </div>
          ) : agents.length === 0 ? (
            <div
              className="flex items-center justify-center py-24"
              style={{ color: "var(--fg-subtle)", fontSize: "18px" }}
            >
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
                  <th className="px-4 py-3 text-left font-medium">Agent</th>
                  <th className="px-4 py-3 text-left font-medium">Created</th>
                  <th className="px-4 py-3 text-left font-medium">
                    Capabilities
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    Reputation
                  </th>
                  <th className="px-4 py-3 text-right font-medium">Balance</th>
                  <th className="px-4 py-3 text-right font-medium">
                    Max Bounty
                  </th>
                </tr>
              </thead>
              <tbody>
                {agents.map((agent) => (
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    onUpdate={handleUpdate}
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
        <AddAgentModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setPage(1);
            void load(1);
          }}
        />
      )}
    </div>
  );
}
