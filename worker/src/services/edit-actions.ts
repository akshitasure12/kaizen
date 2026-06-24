export type EditAction =
  | {
      type: "replace_text";
      file_path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean;
    }
  | {
      type: "append_text";
      file_path: string;
      content: string;
    }
  | {
      type: "write_file";
      file_path: string;
      content: string;
      create_if_missing?: boolean;
    };

const PLACEHOLDER_LITERALS = [
  "initial",
  "todo",
  "placeholder",
  "stub",
  "fixme",
  "tbd",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizePath(raw: string): string {
  return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSafeRelativePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("/") || value.startsWith("-")) return false;
  if (value.includes("://")) return false;
  if (value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..")) {
    return false;
  }
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function normalizeLimitedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n/g, "\n");
  if (!normalized.trim()) return null;
  if (normalized.length > maxLength) return null;
  return normalized;
}

function isLikelyPlaceholderContent(content: string): boolean {
  const compact = content
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/(^|\n)\s*#.*$/g, " ")
    .replace(/(^|\n)\s*\/\/.*$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!compact) return true;
  const tokens = compact.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return true;
  if (tokens.length <= 3 && tokens.every((token) => PLACEHOLDER_LITERALS.includes(token))) {
    return true;
  }

  if (tokens.length <= 2 && tokens.every((token) => token.length <= 4)) {
    return true;
  }

  return false;
}

export function sanitizeEditActions(params: {
  value: unknown;
  maxActions: number;
  maxStringLength: number;
}): EditAction[] {
  if (!Array.isArray(params.value)) return [];

  const actions: EditAction[] = [];
  for (const item of params.value) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : "";
    const filePath = normalizePath(typeof item.file_path === "string" ? item.file_path : "");
    if (!isSafeRelativePath(filePath)) continue;

    if (type === "replace_text") {
      const oldString = normalizeLimitedString(item.old_string, params.maxStringLength);
      const newString = normalizeLimitedString(item.new_string, params.maxStringLength);
      if (!oldString || !newString || oldString === newString) continue;
      actions.push({
        type,
        file_path: filePath,
        old_string: oldString,
        new_string: newString,
        ...(item.replace_all === true ? { replace_all: true } : {}),
      });
      continue;
    }

    if (type === "append_text") {
      const content = normalizeLimitedString(item.content, params.maxStringLength);
      if (!content || isLikelyPlaceholderContent(content)) continue;
      actions.push({ type, file_path: filePath, content });
      continue;
    }

    if (type === "write_file") {
      const content = normalizeLimitedString(item.content, params.maxStringLength);
      if (!content || isLikelyPlaceholderContent(content)) continue;
      actions.push({
        type,
        file_path: filePath,
        content,
        ...(item.create_if_missing === true ? { create_if_missing: true } : {}),
      });
      continue;
    }
  }

  return actions.slice(0, params.maxActions);
}

export function editActionToCommand(action: EditAction, maxCommandLength: number): string | null {
  if (action.type === "replace_text") {
    const script = [
      "const fs=require('fs')",
      `const p=${JSON.stringify(action.file_path)}`,
      "if(!fs.existsSync(p))process.exit(2)",
      "const t=fs.readFileSync(p,'utf8')",
      `const o=${JSON.stringify(action.old_string)}`,
      `const n=${JSON.stringify(action.new_string)}`,
      "if(o===n)process.exit(0)",
      action.replace_all
        ? "if(!t.includes(o))process.exit(3);const next=t.split(o).join(n);if(next!==t)fs.writeFileSync(p,next)"
        : "const i=t.indexOf(o);if(i<0)process.exit(3);if(t.indexOf(o,i+o.length)>=0)process.exit(4);const next=t.replace(o,n);if(next!==t)fs.writeFileSync(p,next)",
    ].join(";");
    const command = `node -e ${JSON.stringify(script)}`;
    return command.length <= maxCommandLength ? command : null;
  }

  if (action.type === "append_text") {
    const script = [
      "const fs=require('fs')",
      `const p=${JSON.stringify(action.file_path)}`,
      "if(!fs.existsSync(p))process.exit(2)",
      "const t=fs.readFileSync(p,'utf8')",
      `const c=${JSON.stringify(action.content)}`,
      "if(!t.includes(c)){const next=t.replace(/\\s*$/,'')+'\\n\\n'+c+'\\n';fs.writeFileSync(p,next)}",
    ].join(";");
    const command = `node -e ${JSON.stringify(script)}`;
    return command.length <= maxCommandLength ? command : null;
  }

  const script = [
    "const fs=require('fs')",
    `const p=${JSON.stringify(action.file_path)}`,
    `const c=${JSON.stringify(action.content)}`,
    action.create_if_missing
      ? "if(fs.existsSync(p)){const t=fs.readFileSync(p,'utf8');if(t!==c)fs.writeFileSync(p,c)}else{fs.writeFileSync(p,c)}"
      : "if(!fs.existsSync(p))process.exit(2);const t=fs.readFileSync(p,'utf8');if(t!==c)fs.writeFileSync(p,c)",
  ].join(";");
  const command = `node -e ${JSON.stringify(script)}`;
  return command.length <= maxCommandLength ? command : null;
}

export function editActionsToCommands(params: {
  actions: EditAction[];
  maxCommands: number;
  maxCommandLength: number;
}): string[] {
  const commands: string[] = [];
  for (const action of params.actions) {
    const command = editActionToCommand(action, params.maxCommandLength);
    if (command) {
      commands.push(command);
    }
    if (commands.length >= params.maxCommands) break;
  }
  return commands;
}