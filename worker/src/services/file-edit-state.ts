import fs from "fs/promises";
import path from "path";

export interface FileSnapshot {
  content: string;
  mtimeMs: number;
}

export interface FileUnchangedResult {
  ok: true;
}

export interface FileChangedResult {
  ok: false;
  reason: string;
}

export type FileAssertResult = FileUnchangedResult | FileChangedResult;

export class FileEditStateTracker {
  private readonly snapshots = new Map<string, FileSnapshot>();

  normalizePath(raw: string): string {
    return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  }

  recordSnapshot(relPath: string, content: string, mtimeMs: number): void {
    const key = this.normalizePath(relPath);
    if (!key) return;
    this.snapshots.set(key, { content, mtimeMs });
  }

  assertUnchanged(relPath: string, currentContent: string, mtimeMs: number): FileAssertResult {
    const key = this.normalizePath(relPath);
    const prior = this.snapshots.get(key);
    if (!prior) {
      return { ok: true };
    }

    if (mtimeMs > prior.mtimeMs && currentContent !== prior.content) {
      return {
        ok: false,
        reason: "file unexpectedly modified since last read",
      };
    }

    if (currentContent !== prior.content && mtimeMs === prior.mtimeMs) {
      return {
        ok: false,
        reason: "file content changed without mtime advance since last read",
      };
    }

    return { ok: true };
  }

  async primeFromDisk(workDir: string, paths: string[]): Promise<void> {
    const unique = [...new Set(paths.map((p) => this.normalizePath(p)).filter(Boolean))];
    for (const relPath of unique) {
      const resolved = path.resolve(workDir, relPath);
      const relative = path.relative(workDir, resolved).replace(/\\/g, "/");
      if (relative.startsWith("../") || path.isAbsolute(relPath)) {
        continue;
      }

      try {
        const stat = await fs.stat(resolved);
        const content = await fs.readFile(resolved, "utf8");
        this.recordSnapshot(relPath, content, stat.mtimeMs);
      } catch {
        // File may not exist yet (create_if_missing); skip priming.
      }
    }
  }
}

export function collectEditActionPaths(actions: Array<{ file_path: string }>): string[] {
  return [...new Set(actions.map((action) => action.file_path.trim()).filter(Boolean))];
}
