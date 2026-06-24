import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export const KAIZEN_LOG_DIR = ".kaizen/logs";

export async function ensureKaizenLogDir(workDir: string): Promise<string> {
  const absolute = path.join(workDir, KAIZEN_LOG_DIR);
  await fs.mkdir(absolute, { recursive: true });
  return absolute;
}

function hashCommand(command: string): string {
  return crypto.createHash("sha256").update(command).digest("hex").slice(0, 8);
}

export async function persistCommandLog(params: {
  workDir: string;
  cycle: number;
  phase: string;
  command: string;
  stdout: string;
  stderr: string;
}): Promise<string> {
  await ensureKaizenLogDir(params.workDir);
  const filename = `${params.phase}-c${params.cycle}-${hashCommand(params.command)}.log`;
  const relativePath = `${KAIZEN_LOG_DIR}/${filename}`;
  const absolutePath = path.join(params.workDir, relativePath);
  const body = [
    `# command: ${params.command}`,
    `# phase: ${params.phase}`,
    `# cycle: ${params.cycle}`,
    "",
    "=== stdout ===",
    params.stdout,
    "",
    "=== stderr ===",
    params.stderr,
  ].join("\n");
  await fs.writeFile(absolutePath, body, "utf8");
  return relativePath;
}

export function summarizeLogForRecovery(fullText: string, maxChars = 2400): string {
  if (fullText.length <= maxChars) return fullText;
  const separator = "\n\n...[truncated for recovery context]...\n\n";
  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = Math.max(0, maxChars - headSize - separator.length);
  const head = fullText.slice(0, headSize).trimEnd();
  const tail = fullText.slice(fullText.length - tailSize).trimStart();
  return `${head}${separator}${tail}`;
}
