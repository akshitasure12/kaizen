import { spawn } from "child_process";

export type ToolExecutionPhase = "edit" | "verify" | "fix";

export interface ToolExecutionResult {
  command: string;
  executable: string | null;
  args: string[];
  phase: ToolExecutionPhase;
  cycle: number;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  blockedReason: string | null;
}

interface ValidationResult {
  ok: boolean;
  executable?: string;
  args?: string[];
  reason?: string;
}

const SECRET_ENV_KEY_RE = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i;
const SAFE_EXECUTABLE_RE = /^[a-zA-Z0-9._-]+$/;

function truncateTail(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function appendAndTrim(current: string, chunk: string, maxLength: number): string {
  return truncateTail(current + chunk, maxLength);
}

function tokenizeCommand(raw: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\") {
        escaped = true;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaped || quote !== null) {
    return null;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function findShellSyntaxViolation(raw: string): string | null {
  let quote: "single" | "double" | null = null;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;

    if (ch === "\n" || ch === "\r" || ch === "\0") {
      return "multi-line commands and null bytes are not allowed";
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (quote === "single") {
      if (ch === "'") quote = null;
      continue;
    }

    if (quote === "double") {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
      }
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      continue;
    }
    if (ch === '"') {
      quote = "double";
      continue;
    }

    if (ch === ";" || ch === "&" || ch === "|" || ch === ">" || ch === "<" || ch === "`") {
      return `shell operator '${ch}' is not allowed`;
    }
    if (ch === "$" && (raw[i + 1] === "(" || raw[i + 1] === "{")) {
      return "shell substitution syntax is not allowed";
    }
  }

  if (escaped || quote !== null) {
    return "unterminated quote or escape sequence";
  }
  return null;
}

function validateCommandArgs(args: string[]): string | null {
  for (const arg of args) {
    if (arg.length > 500) {
      return "command argument too long";
    }
    if (arg.includes("\0")) {
      return "command argument contains null byte";
    }
    if (!arg.startsWith("-")) {
      if (arg.startsWith("/")) {
        return "absolute file paths are not allowed";
      }
      if (arg === ".." || arg.startsWith("../") || arg.includes("/../") || arg.endsWith("/..")) {
        return "path traversal syntax is not allowed";
      }
    }
  }
  return null;
}

function sanitizeCommandEnv(): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(nextEnv)) {
    if (SECRET_ENV_KEY_RE.test(key)) {
      delete nextEnv[key];
    }
  }
  return nextEnv;
}

export function validateToolCommand(params: {
  command: string;
  allowedCommands: Set<string>;
  maxCommandLength: number;
}): ValidationResult {
  const command = params.command.trim();
  if (!command) {
    return { ok: false, reason: "empty command" };
  }
  if (command.length > params.maxCommandLength) {
    return { ok: false, reason: `command exceeds max length ${params.maxCommandLength}` };
  }

  const shellViolation = findShellSyntaxViolation(command);
  if (shellViolation) {
    return { ok: false, reason: shellViolation };
  }

  const tokens = tokenizeCommand(command);
  if (!tokens || tokens.length === 0) {
    return { ok: false, reason: "invalid command tokenization" };
  }

  const executable = tokens[0]!;
  const normalized = executable.toLowerCase();

  if (!SAFE_EXECUTABLE_RE.test(executable)) {
    return { ok: false, reason: "executable contains unsafe characters" };
  }
  if (executable.includes("/") || executable.includes("\\")) {
    return { ok: false, reason: "path-based executable invocation is not allowed" };
  }
  if (!params.allowedCommands.has(normalized)) {
    return { ok: false, reason: `command '${executable}' is not in allowlist` };
  }

  const args = tokens.slice(1);
  const argViolation = validateCommandArgs(args);
  if (argViolation) {
    return { ok: false, reason: argViolation };
  }

  return {
    ok: true,
    executable,
    args,
  };
}

export async function executeToolCommand(params: {
  command: string;
  phase: ToolExecutionPhase;
  cycle: number;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxCommandLength: number;
  allowedCommands: Set<string>;
}): Promise<ToolExecutionResult> {
  const started = Date.now();
  const validation = validateToolCommand({
    command: params.command,
    allowedCommands: params.allowedCommands,
    maxCommandLength: params.maxCommandLength,
  });

  if (!validation.ok) {
    return {
      command: params.command,
      executable: null,
      args: [],
      phase: params.phase,
      cycle: params.cycle,
      exitCode: -1,
      signal: null,
      durationMs: Date.now() - started,
      timedOut: false,
      stdout: "",
      stderr: "",
      blockedReason: validation.reason || "command blocked",
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const child = spawn(validation.executable!, validation.args!, {
      cwd: params.cwd,
      env: sanitizeCommandEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 1500);
    }, params.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendAndTrim(stdout, chunk.toString(), params.maxOutputBytes);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendAndTrim(stderr, chunk.toString(), params.maxOutputBytes);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command: params.command,
        executable: validation.executable!,
        args: validation.args!,
        phase: params.phase,
        cycle: params.cycle,
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - started,
        timedOut: false,
        stdout,
        stderr: appendAndTrim(stderr, `\n${error.message}`, params.maxOutputBytes).trim(),
        blockedReason: null,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        command: params.command,
        executable: validation.executable!,
        args: validation.args!,
        phase: params.phase,
        cycle: params.cycle,
        exitCode: code,
        signal: signal ? String(signal) : null,
        durationMs: Date.now() - started,
        timedOut,
        stdout,
        stderr,
        blockedReason: null,
      });
    });
  });
}