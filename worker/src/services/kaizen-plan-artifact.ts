import fs from "fs/promises";
import path from "path";
import type { EditAction } from "./edit-actions";

export const KAIZEN_PLAN_FILENAME = "KAIZEN_PLAN.json";

export type KaizenPlanPhaseName = "explore" | "implement";
export type KaizenPlanPhaseStatus = "pending" | "in_progress" | "completed" | "failed";

export interface KaizenPlanPhase {
  name: KaizenPlanPhaseName;
  status: KaizenPlanPhaseStatus;
  summary?: string;
  ranked_files?: string[];
  ranked_tests?: string[];
  search_terms?: string[];
  verify_hints?: string[];
  edit_actions_v1?: EditAction[];
  edit_commands?: string[];
  verify_commands?: string[];
  fix_commands?: string[];
  edit_loop_cycles?: number;
  edit_loop_passed?: boolean;
}

export interface KaizenPlanArtifact {
  version: "1";
  issue_title: string;
  created_at: string;
  updated_at: string;
  phases: KaizenPlanPhase[];
  required_artifacts?: string[];
  autonomous_plan_source?: string | null;
}

export function buildInitialKaizenPlan(params: {
  issueTitle: string;
  rankedFiles: string[];
  rankedTests: string[];
  searchTerms: string[];
  verifyHints: string[];
  requiredArtifacts: string[];
  exploreSummary?: string;
  implementSummary?: string;
  editActionsV1?: EditAction[];
  editCommands?: string[];
  verifyCommands?: string[];
  fixCommands?: string[];
  autonomousPlanSource?: string | null;
}): KaizenPlanArtifact {
  const now = new Date().toISOString();
  return {
    version: "1",
    issue_title: params.issueTitle,
    created_at: now,
    updated_at: now,
    required_artifacts: params.requiredArtifacts,
    autonomous_plan_source: params.autonomousPlanSource ?? null,
    phases: [
      {
        name: "explore",
        status: "completed",
        summary:
          params.exploreSummary ||
          "Collected repository context hints, ranked files, and verification candidates.",
        ranked_files: params.rankedFiles,
        ranked_tests: params.rankedTests,
        search_terms: params.searchTerms,
        verify_hints: params.verifyHints,
      },
      {
        name: "implement",
        status: "in_progress",
        summary:
          params.implementSummary ||
          "Apply structured edits and run verify/fix loop until checks pass.",
        edit_actions_v1: params.editActionsV1 ?? [],
        edit_commands: params.editCommands ?? [],
        verify_commands: params.verifyCommands ?? [],
        fix_commands: params.fixCommands ?? [],
      },
    ],
  };
}

export async function writeKaizenPlanArtifact(
  workDir: string,
  plan: KaizenPlanArtifact,
): Promise<string> {
  const relativePath = KAIZEN_PLAN_FILENAME;
  const absolutePath = path.join(workDir, relativePath);
  const next: KaizenPlanArtifact = {
    ...plan,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(absolutePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return relativePath;
}

export async function readKaizenPlanArtifact(workDir: string): Promise<KaizenPlanArtifact | null> {
  try {
    const raw = await fs.readFile(path.join(workDir, KAIZEN_PLAN_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as KaizenPlanArtifact;
    if (parsed?.version !== "1" || !Array.isArray(parsed.phases)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function updateKaizenPlanArtifact(
  workDir: string,
  updater: (plan: KaizenPlanArtifact) => KaizenPlanArtifact,
): Promise<string | null> {
  const existing = await readKaizenPlanArtifact(workDir);
  if (!existing) return null;
  return writeKaizenPlanArtifact(workDir, updater(existing));
}

export function summarizeKaizenPlanPhases(plan: KaizenPlanArtifact): Array<{
  name: KaizenPlanPhaseName;
  status: KaizenPlanPhaseStatus;
}> {
  return plan.phases.map((phase) => ({
    name: phase.name,
    status: phase.status,
  }));
}
