"use client";

import Link from "next/link";
import { useState } from "react";
import reposData from "@/data/repos.json";

const summaryCards = [
	{ label: "Open Repositories", value: "12", hint: "+2 this week" },
	{ label: "Active Agents", value: "8", hint: "3 online now" },
	{ label: "Pending Reviews", value: "17", hint: "Needs attention" },
	{ label: "Merged This Week", value: "43", hint: "+11% vs last week" },
];

const PAGE_SIZE = 20;

export default function DashboardPage() {
	const [page, setPage] = useState(0);
	const totalPages = Math.ceil(reposData.length / PAGE_SIZE);
	const visibleRepos = reposData.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	return (
		<div className="flex flex-col gap-6 animate-in">
			<div>
				<h1 className="text-2xl font-bold" style={{ color: "var(--fg-default)" }}>
					Dashboard
				</h1>
				<p className="text-sm mt-1" style={{ color: "var(--fg-muted)" }}>
					Track repository health, agent activity, and delivery flow.
				</p>
			</div>

			<section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
				{summaryCards.map((item) => (
					<div
						key={item.label}
						className="card p-5"
						style={{
							backgroundImage: "radial-gradient(circle at top right, rgba(255, 255, 255, 0.08), transparent 52%)",
							boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.06)",
						}}
					>
						<p className="text-xs uppercase tracking-wide" style={{ color: "var(--fg-subtle)" }}>
							{item.label}
						</p>
						<p className="text-3xl font-bold mt-2" style={{ color: "var(--fg-default)" }}>
							{item.value}
						</p>
						<p className="text-xs mt-2" style={{ color: "var(--fg-muted)" }}>
							{item.hint}
						</p>
					</div>
				))}
			</section>

			<section
				className="card p-5"
				style={{
					backgroundImage: "radial-gradient(circle at top right, rgba(255, 255, 255, 0.07), transparent 48%)",
					boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.05)",
				}}
			>
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-lg font-semibold" style={{ color: "var(--fg-default)" }}>
						Repositories
					</h2>
					<button
						onClick={() => setPage(0)}
						className="btn-secondary text-sm flex items-center gap-1.5"
					>
						<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
							<path d="M21 3v5h-5" />
							<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
							<path d="M8 16H3v5" />
						</svg>
						Refresh
					</button>
				</div>

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					{visibleRepos.map((repo) => (
						<Link
							key={repo.title}
							href={`/repositories/${encodeURIComponent(repo.title)}`}
							className="rounded-lg border px-4 py-3 flex items-center justify-between gap-3 transition-colors"
							style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-subtle)" }}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = "var(--bg-subtle)";
							}}
						>
							<div>
								<p className="text-sm font-medium" style={{ color: "var(--fg-default)" }}>
									{repo.title}
								</p>
								<p className="text-xs mt-0.5" style={{ color: "var(--fg-muted)" }}>
									{repo.owner}
								</p>
							</div>
							<div className="shrink-0 text-right leading-tight">
								<p className="text-lg font-bold tabular-nums" style={{ color: "var(--fg-default)" }}>
									{repo.issues}
								</p>
								<p className="text-sm" style={{ color: "var(--fg-subtle)" }}>
									issues
								</p>
							</div>
						</Link>
					))}
				</div>

				{totalPages > 1 && (
					<div className="flex items-center justify-between mt-4">
						<button
							onClick={() => setPage((p) => Math.max(p - 1, 0))}
							disabled={page === 0}
							className="btn-secondary text-sm disabled:opacity-40"
							aria-label="Previous page"
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
						</button>
						<span className="text-xs" style={{ color: "var(--fg-muted)" }}>
							Page {page + 1} of {totalPages}
						</span>
						<button
							onClick={() => setPage((p) => Math.min(p + 1, totalPages - 1))}
							disabled={page === totalPages - 1}
							className="btn-secondary text-sm disabled:opacity-40"
							aria-label="Next page"
						>
							<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
						</button>
					</div>
				)}
			</section>
		</div>
	);
}

