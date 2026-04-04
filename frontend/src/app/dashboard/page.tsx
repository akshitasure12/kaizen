"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import reposData from "@/data/repos.json";
import importableRepos from "@/data/importable-repos.json";

const summaryCards = [
	{ label: "Open Repositories", value: "12", hint: "+2 this week" },
	{ label: "Active Agents", value: "8", hint: "3 online now" },
	{ label: "Pending Reviews", value: "17", hint: "Needs attention" },
	{ label: "Merged This Week", value: "43", hint: "+11% vs last week" },
];

// API endpoints
const DASHBOARD_REPOS_API_URL = "http://localhost:3001/integrations/github/repos?page=1&per_page=10";
const IMPORT_REPOS_API_URL = "http://localhost:3001/integrations/github/repos?page=3&per_page=10";

// Fallback values for local testing (safe to remove later)
const FALLBACK_DASHBOARD_PER_PAGE = 10;
const FALLBACK_IMPORT_PER_PAGE = 5;
const FALLBACK_DASHBOARD_REPOS = reposData as LocalRepo[];
const FALLBACK_IMPORT_PAYLOAD = importableRepos as GithubReposResponse;

const FALLBACK_TOKEN =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhMmZjNGFmZi01OWUyLTRlMzItYjY3ZC1mMDk3MWJiOTUxOWQiLCJ1c2VybmFtZSI6ImRlbW9fdXNlciIsImlhdCI6MTc3NTI3MTM5NCwiZXhwIjoxNzc1ODc2MTk0fQ.idECgmnhAM2_kzyVIOTCkg4aFX78YILhYRXIj-BJ9k0";

type LocalRepo = {
	title: string;
	owner: string;
	issues: number;
	description?: string;
};

type GithubRepoItem = {
	id: number;
	name: string;
	full_name: string;
	default_branch: string;
	private: boolean;
	html_url: string;
	description?: string | null;
};

type GithubReposResponse = {
	items: GithubRepoItem[];
	page: number;
	per_page: number;
	has_next: boolean;
	has_prev: boolean;
};

export default function DashboardPage() {
	const [repos, setRepos] = useState<LocalRepo[]>(FALLBACK_DASHBOARD_REPOS);
	const [reposPerPage, setReposPerPage] = useState(FALLBACK_DASHBOARD_PER_PAGE);
	const [page, setPage] = useState(0);
	const [importPage, setImportPage] = useState(0);
	const [isImportOpen, setIsImportOpen] = useState(false);
	const [isImportLoading, setIsImportLoading] = useState(false);
	const [importPayload, setImportPayload] = useState<GithubReposResponse | null>(null);
	const importPerPage = importPayload?.per_page ?? FALLBACK_IMPORT_PER_PAGE;

	const totalPages = Math.ceil(repos.length / reposPerPage);
	const visibleRepos = repos.slice(page * reposPerPage, (page + 1) * reposPerPage);
	const importTotalPages = importPayload ? Math.ceil(importPayload.items.length / importPerPage) : 0;
	const visibleImportRepos = importPayload
		? importPayload.items.slice(importPage * importPerPage, (importPage + 1) * importPerPage)
		: [];

	const toLocalRepo = (repo: GithubRepoItem): LocalRepo => {
		const [ownerFromFullName = "unknown"] = repo.full_name.split("/");
		return {
			title: repo.name,
			owner: ownerFromFullName,
			issues: 0,
			description: repo.description?.trim() || "No description available",
		};
	};

	useEffect(() => {
		const loadDashboardRepos = async () => {
			try {
				const token = localStorage.getItem("ab_token") ?? FALLBACK_TOKEN;
				const res = await fetch(DASHBOARD_REPOS_API_URL, {
					headers: {
						Authorization: `Bearer ${token}`,
					},
				});

				if (!res.ok) {
					throw new Error(`Failed to load dashboard repositories (${res.status})`);
				}

				const data = (await res.json()) as GithubReposResponse;
				setRepos(data.items.map(toLocalRepo));
				setReposPerPage(data.per_page);
				setPage(0);
			} catch (error) {
				const message = error instanceof Error ? error.message : "Failed to load dashboard repositories";
				console.error(`[dashboard] ${message}. Using fallback data.`);
				setRepos(FALLBACK_DASHBOARD_REPOS);
				setReposPerPage(FALLBACK_DASHBOARD_PER_PAGE);
				setPage(0);
			}
		};

		void loadDashboardRepos();
	}, []);

	const loadGithubRepos = async () => {
		setIsImportOpen(true);
		setIsImportLoading(true);
		setImportPage(0);

		try {
			const token = localStorage.getItem("ab_token") ?? FALLBACK_TOKEN;
			const res = await fetch(IMPORT_REPOS_API_URL, {
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!res.ok) {
				throw new Error(`Failed to load import repositories (${res.status})`);
			}

			const data = (await res.json()) as GithubReposResponse;
			setImportPayload(data);
		} catch (error) {
			const message = error instanceof Error ? error.message : "Failed to fetch import repositories";
			console.error(`[import] ${message}. Using fallback data.`);
			setImportPayload({
				...FALLBACK_IMPORT_PAYLOAD,
				per_page: FALLBACK_IMPORT_PER_PAGE,
			});
		} finally {
			setIsImportLoading(false);
		}
	};

	const addImportedRepo = (repo: GithubRepoItem) => {
		const repoToAdd = toLocalRepo(repo);

		setRepos((prev) => {
			const withoutDupes = prev.filter((item) => item.title !== repoToAdd.title);
			return [repoToAdd, ...withoutDupes];
		});
		setPage(0);
		setIsImportOpen(false);
	};

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
							backgroundColor: "rgba(255, 255, 255, 0.08)",
							border: "1px solid rgba(255, 255, 255, 0.1)",
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
					<div className="flex items-center gap-2">
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
						<button
							onClick={loadGithubRepos}
							className="btn-secondary text-sm"
						>
							Import New Repository
						</button>
					</div>
				</div>

				<div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
					{visibleRepos.map((repo) => (
						<Link
							key={repo.title}
							href={`/repositories/${encodeURIComponent(repo.title)}?description=${encodeURIComponent(repo.description?.trim() || "No description available")}`}
							className="rounded-lg border px-4 py-3 flex items-center justify-between gap-3 transition-colors"
							style={{ borderColor: "rgba(255, 255, 255, 0.1)", backgroundColor: "rgba(255, 255, 255, 0.08)" }}
							onMouseEnter={(e) => {
								e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
							}}
							onMouseLeave={(e) => {
								e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.08)";
							}}
						>
							<div>
								<p className="text-sm font-medium" style={{ color: "var(--fg-default)" }}>
									{repo.title}
								</p>
								<p className="text-xs mt-0.5" style={{ color: "var(--fg-muted)" }}>
									{repo.owner}
								</p>
								<p
									className="text-xs mt-1"
									style={{ color: "var(--fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
								>
									{repo.description?.trim() || "No description available"}
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

			{isImportOpen && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center p-4"
					style={{ backgroundColor: "rgba(0, 0, 0, 0.58)" }}
				>
					<div
						className="w-full max-w-3xl rounded-xl border p-5 max-h-[80vh] overflow-auto"
						style={{ borderColor: "var(--border-default)", backgroundColor: "var(--bg-default)" }}
					>
						<div className="flex items-center justify-between mb-4">
							<h3 className="text-lg font-semibold" style={{ color: "var(--fg-default)" }}>
								Import New Repository
							</h3>
							<button className="btn-secondary text-sm" onClick={() => setIsImportOpen(false)}>
								Close
							</button>
						</div>

						{isImportLoading && (
							<p className="text-sm" style={{ color: "var(--fg-muted)" }}>
								Loading repositories...
							</p>
						)}

						{importPayload && (
							<>
								<p className="text-sm mb-2" style={{ color: "var(--fg-muted)" }}>
									Select a repository to add it to Kaizen.
								</p>
								<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
									{visibleImportRepos.map((repo) => (
										<button
											key={repo.id}
											onClick={() => addImportedRepo(repo)}
											className="rounded-lg border px-3 py-2 text-left transition-colors"
											style={{ borderColor: "rgba(255, 255, 255, 0.1)", backgroundColor: "rgba(255, 255, 255, 0.08)" }}
											onMouseEnter={(e) => {
												e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
											}}
											onMouseLeave={(e) => {
												e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.08)";
											}}
										>
											<p className="text-sm font-medium" style={{ color: "var(--fg-default)" }}>
												{repo.full_name}
											</p>
											<p
												className="text-xs mt-0.5"
												style={{ color: "var(--fg-subtle)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
											>
												{repo.description?.trim() || "No description available"}
											</p>
											<p className="text-xs" style={{ color: "var(--fg-muted)" }}>
												Default branch: {repo.default_branch} • {repo.private ? "Private" : "Public"}
											</p>
										</button>
									))}
								</div>
								{importTotalPages > 1 && (
									<div className="flex items-center justify-between mb-1">
										<button
											onClick={() => setImportPage((p) => Math.max(p - 1, 0))}
											disabled={importPage === 0}
											className="btn-secondary text-sm disabled:opacity-40"
											aria-label="Previous import page"
										>
											<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
										</button>
										<span className="text-xs" style={{ color: "var(--fg-muted)" }}>
											Page {importPage + 1} of {importTotalPages}
										</span>
										<button
											onClick={() => setImportPage((p) => Math.min(p + 1, importTotalPages - 1))}
											disabled={importPage === importTotalPages - 1}
											className="btn-secondary text-sm disabled:opacity-40"
											aria-label="Next import page"
										>
											<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6"/></svg>
										</button>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

