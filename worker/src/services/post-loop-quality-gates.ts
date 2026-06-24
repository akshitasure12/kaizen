export interface DiffQualityMetrics {
  addedSubstantiveChars: number;
  substantiveHunks: number;
  placeholderLineCount: number;
}

export type PostLoopGateFailureType =
  | "empty_workspace"
  | "note_only_implementation"
  | "insufficient_implementation_files"
  | "required_artifact_content"
  | "insufficient_substantive_diff"
  | "insufficient_substantive_hunks"
  | "placeholder_detected";

export interface PostLoopGateSuccess {
  ok: true;
}

export interface PostLoopGateFailure {
  ok: false;
  failureType: PostLoopGateFailureType;
  reason: string;
  detail?: Record<string, unknown>;
}

export type PostLoopGateResult = PostLoopGateSuccess | PostLoopGateFailure;

export function evaluatePostLoopQualityGates(params: {
  workspaceFileCount: number;
  implementationFileCount: number;
  allowNoteOnly: boolean;
  artifactCheckOk: boolean;
  artifactCheckReason?: string;
  diffQuality: DiffQualityMetrics;
  minImplementationFiles: number;
  minSubstantiveChars: number;
  minSubstantiveHunks: number;
  rejectPlaceholderDiffs: boolean;
}): PostLoopGateResult {
  if (params.workspaceFileCount === 0) {
    return {
      ok: false,
      failureType: "empty_workspace",
      reason: "Edit loop produced no file changes; refusing to open PR with empty diff.",
    };
  }

  if (!params.allowNoteOnly && params.implementationFileCount === 0) {
    return {
      ok: false,
      failureType: "note_only_implementation",
      reason:
        "No implementation diff detected beyond KAIZEN_AGENT.md. Provide payload.edit_commands or fix commands that modify source files.",
    };
  }

  if (!params.allowNoteOnly && params.implementationFileCount < params.minImplementationFiles) {
    return {
      ok: false,
      failureType: "insufficient_implementation_files",
      reason: `Implementation diff touched ${params.implementationFileCount} file(s); minimum required is ${params.minImplementationFiles}`,
      detail: {
        implementation_file_count: params.implementationFileCount,
        required_implementation_files: params.minImplementationFiles,
      },
    };
  }

  if (!params.allowNoteOnly && !params.artifactCheckOk) {
    return {
      ok: false,
      failureType: "required_artifact_content",
      reason: params.artifactCheckReason || "Required artifact content check failed",
    };
  }

  if (!params.allowNoteOnly) {
    if (params.diffQuality.addedSubstantiveChars < params.minSubstantiveChars) {
      return {
        ok: false,
        failureType: "insufficient_substantive_diff",
        reason: `Substantive added content ${params.diffQuality.addedSubstantiveChars} chars is below required ${params.minSubstantiveChars}`,
        detail: {
          added_substantive_chars: params.diffQuality.addedSubstantiveChars,
          required_substantive_chars: params.minSubstantiveChars,
          substantive_hunks: params.diffQuality.substantiveHunks,
        },
      };
    }

    if (params.diffQuality.substantiveHunks < params.minSubstantiveHunks) {
      return {
        ok: false,
        failureType: "insufficient_substantive_hunks",
        reason: `Substantive hunk count ${params.diffQuality.substantiveHunks} is below required ${params.minSubstantiveHunks}`,
        detail: {
          substantive_hunks: params.diffQuality.substantiveHunks,
          required_substantive_hunks: params.minSubstantiveHunks,
        },
      };
    }

    if (params.rejectPlaceholderDiffs && params.diffQuality.placeholderLineCount > 0) {
      return {
        ok: false,
        failureType: "placeholder_detected",
        reason: `Placeholder content detected in implementation diff (${params.diffQuality.placeholderLineCount} line(s))`,
        detail: {
          placeholder_line_count: params.diffQuality.placeholderLineCount,
        },
      };
    }
  }

  return { ok: true };
}
