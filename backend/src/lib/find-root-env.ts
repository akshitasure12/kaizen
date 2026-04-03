import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Walk up from cwd to find `.env` (repo root when running from any workspace package).
 */
export function findRootEnvPath(): string | undefined {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
