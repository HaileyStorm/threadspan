import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CODEX_FULL_ACCESS_TRANSFORM_ID = "codex-full-access-v1";

const ROOT_SETTINGS = Object.freeze([
  Object.freeze({ key: "approval_policy", value: "never" }),
  Object.freeze({ key: "sandbox_mode", value: "danger-full-access" }),
  Object.freeze({ key: "approvals_reviewer", value: "user" }),
]);
const APP_SETTINGS = Object.freeze([
  Object.freeze({ key: "approvals_reviewer", value: "user" }),
  Object.freeze({ key: "default_tools_approval_mode", value: "approve" }),
]);
const SERVER_SETTINGS = Object.freeze([
  Object.freeze({ key: "default_tools_approval_mode", value: "approve" }),
]);
const MAX_CONFLICTS = 64;

/** Resolve the current host's user-level Codex configuration path. */
export function resolveCodexUserConfigPath(options = {}) {
  const configuredHome = options.environment?.CODEX_HOME;
  const base = typeof configuredHome === "string" && configuredHome.trim()
    ? configuredHome.trim()
    : join(options.homeDirectory ?? homedir(), ".codex");
  if (base.includes("\0")) throw new Error("CODEX_HOME contains an invalid null byte");
  return resolve(base, "config.toml");
}

/** Decode config bytes as strict UTF-8 without discarding a byte-order mark. */
export function decodeCodexConfig(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Codex user config is not valid UTF-8");
  }
}

/**
 * Apply the explicit full-access policy while preserving unrelated TOML lines,
 * comments, ordering, and per-tool overrides.
 */
export function transformCodexFullAccessConfig(source) {
  if (typeof source !== "string") throw new TypeError("Codex config source must be a string");
  const eol = source.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const lines = source.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? [];
  const records = [];
  const tables = new Map();
  const targetAssignments = new Map();
  const conflicts = [];
  let currentTable = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const body = stripLineEnding(line);
    const header = parseTableHeader(body, index + 1);
    if (header) {
      currentTable = header.path;
      if (isManagedNamespace(currentTable)) {
        if (header.array) failClosed(index + 1, "array table in a managed namespace");
        const id = pathId(currentTable);
        if (tables.has(id)) failClosed(index + 1, `duplicate target table ${displayPath(currentTable)}`);
        tables.set(id, { path: currentTable, headerIndex: index });
      }
      records.push({ kind: "header", lineIndex: index, table: currentTable });
      continue;
    }

    const assignment = parseAssignment(body, index + 1);
    if (!assignment) {
      records.push({ kind: "other", lineIndex: index, table: currentTable });
      continue;
    }
    const fullPath = [...currentTable, ...assignment.keyPath];
    const target = classifyTargetSetting(fullPath);
    const perTool = classifyPerToolOverride(fullPath);
    if (target) {
      if (assignment.multiline) failClosed(index + 1, `multiline target key ${displayPath(fullPath)}`);
      const id = pathId(fullPath);
      if (targetAssignments.has(id)) failClosed(index + 1, `duplicate target key ${displayPath(fullPath)}`);
      targetAssignments.set(id, { ...assignment, lineIndex: index, fullPath, target });
    } else if (perTool) {
      if (assignment.multiline) failClosed(index + 1, `multiline per-tool override ${displayPath(fullPath)}`);
      const id = pathId(fullPath);
      if (targetAssignments.has(id)) failClosed(index + 1, `duplicate per-tool override ${displayPath(fullPath)}`);
      targetAssignments.set(id, { ...assignment, lineIndex: index, fullPath, perTool });
      appendConflict(conflicts, perTool);
    } else if (isAmbiguousManagedAssignment(fullPath, assignment)) {
      failClosed(index + 1, `ambiguous dotted or inline assignment in ${displayPath(fullPath)}`);
    }
    records.push({ kind: "assignment", lineIndex: index, table: currentTable, fullPath });
    if (assignment.multiline) {
      const endIndex = findContinuationEnd(lines, index, assignment.valueStart);
      for (let skipped = index + 1; skipped <= endIndex; skipped += 1) {
        records.push({ kind: "continuation", lineIndex: skipped, table: currentTable });
      }
      index = endIndex;
    }
  }

  for (const assignment of targetAssignments.values()) {
    if (!assignment.target || assignment.fullPath.length === 1) continue;
    const ownerPath = assignment.fullPath.slice(0, -1);
    if (!tables.has(pathId(ownerPath))) {
      failClosed(assignment.lineIndex + 1, `target key outside an explicit target table ${displayPath(ownerPath)}`);
    }
  }

  const desiredTables = collectDesiredTables(tables);
  const replacements = new Map();
  const insertions = new Map();
  for (const setting of ROOT_SETTINGS) {
    scheduleSetting({ lines, targetAssignments, replacements, insertions, eol }, [], setting, firstHeaderIndex(records, lines.length));
  }
  for (const table of desiredTables) {
    if (table.headerIndex === undefined) continue;
    const settings = table.kind === "app" || table.kind === "app-default" ? APP_SETTINGS : SERVER_SETTINGS;
    const insertionIndex = nextHeaderIndex(records, table.headerIndex, lines.length);
    for (const setting of settings) {
      scheduleSetting({ lines, targetAssignments, replacements, insertions, eol }, table.path, setting, insertionIndex);
    }
  }

  const appendedTables = desiredTables.filter((table) => table.headerIndex === undefined);
  let output = "";
  for (let index = 0; index <= lines.length; index += 1) {
    if (insertions.has(index)) output += insertions.get(index).join("");
    if (index < lines.length) output += replacements.get(index) ?? lines[index];
  }
  for (const table of appendedTables) {
    output = ensureTrailingEol(output, eol);
    if (output && !endsWithBlankLine(output, eol)) output += eol;
    output += `[${table.path.map(renderKey).join(".")}]${eol}`;
    const settings = table.kind === "app-default" ? APP_SETTINGS : SERVER_SETTINGS;
    for (const setting of settings) output += `${setting.key} = ${JSON.stringify(setting.value)}${eol}`;
  }

  const effects = policyEffects(desiredTables);
  return Object.freeze({
    content: output,
    changed: output !== source,
    conflicts: Object.freeze(conflicts),
    effects,
    contentSha256: sha256(output),
  });
}

/** Public, content-free description used in plan previews and manifests. */
export function codexFullAccessPolicyDescription() {
  return Object.freeze({
    transformId: CODEX_FULL_ACCESS_TRANSFORM_ID,
    settings: Object.freeze([
      "approval_policy=never",
      "sandbox_mode=danger-full-access",
      "approvals_reviewer=user",
      "apps._default.approvals_reviewer=user",
      "apps._default.default_tools_approval_mode=approve",
      "existing apps.<id> approvals_reviewer=user and default_tools_approval_mode=approve",
      "existing mcp_servers.<id> default_tools_approval_mode=approve",
      "existing plugins.<plugin>.mcp_servers.<server> default_tools_approval_mode=approve",
    ]),
    effect: "Removes command approval pauses and command sandboxing; app and MCP tools are preapproved unless a per-tool override remains.",
    exclusions: Object.freeze([
      "does not enable destructive_enabled or open_world_enabled",
      "does not enable tools, apps, plugins, or servers",
      "does not alter project config, profiles, CLI flags, or per-tool overrides",
    ]),
  });
}

function collectDesiredTables(tables) {
  const result = [];
  for (const table of tables.values()) {
    const kind = classifyManagedTable(table.path);
    if (kind) result.push({ ...table, kind });
  }
  if (!result.some((table) => table.kind === "app-default")) {
    result.push({ path: ["apps", "_default"], kind: "app-default", headerIndex: undefined });
  }
  return result;
}

function scheduleSetting(context, tablePath, setting, insertionIndex) {
  const fullPath = [...tablePath, setting.key];
  const existing = context.targetAssignments.get(pathId(fullPath));
  if (existing) {
    context.replacements.set(existing.lineIndex, rewriteAssignment(context.lines[existing.lineIndex], existing, setting.value));
    return;
  }
  const line = `${setting.key} = ${JSON.stringify(setting.value)}${context.eol}`;
  const pending = context.insertions.get(insertionIndex) ?? [];
  pending.push(line);
  context.insertions.set(insertionIndex, pending);
}

function parseTableHeader(line, lineNumber) {
  const offset = skipSpace(line, 0);
  if (line[offset] !== "[") return null;
  const array = line[offset + 1] === "[";
  const openLength = array ? 2 : 1;
  const close = array ? "]]" : "]";
  const closeIndex = findUnquotedSequence(line, close, offset + openLength);
  if (closeIndex < 0) failClosed(lineNumber, "unterminated table header");
  const tail = line.slice(closeIndex + close.length).trim();
  if (tail && !tail.startsWith("#")) failClosed(lineNumber, "unexpected data after table header");
  const path = parseDottedKey(line.slice(offset + openLength, closeIndex), lineNumber);
  return { array, path };
}

function parseAssignment(line, lineNumber) {
  const offset = skipSpace(line, 0);
  if (!line[offset] || line[offset] === "#") return null;
  let parsed;
  try {
    parsed = parseDottedKeyWithOffset(line, offset, lineNumber);
  } catch (error) {
    if (/TOML policy transform/.test(error.message)) throw error;
    return null;
  }
  let cursor = skipSpace(line, parsed.offset);
  if (line[cursor] !== "=") return null;
  const valueStart = skipSpace(line, cursor + 1);
  const commentIndex = findInlineComment(line, valueStart);
  const rawValueEnd = commentIndex < 0 ? line.length : commentIndex;
  let valueEnd = rawValueEnd;
  while (valueEnd > valueStart && (line[valueEnd - 1] === " " || line[valueEnd - 1] === "\t")) valueEnd -= 1;
  const value = line.slice(valueStart, valueEnd);
  if (!value) failClosed(lineNumber, "empty target assignment");
  return {
    keyPath: parsed.path,
    equalsIndex: cursor,
    valueStart,
    valueEnd,
    valueKind: value.trimStart().startsWith("{") ? "inline-table" : "other",
    multiline: isMultilineValue(value),
  };
}

function parseDottedKey(value, lineNumber) {
  const parsed = parseDottedKeyWithOffset(value, 0, lineNumber);
  if (skipSpace(value, parsed.offset) !== value.length) failClosed(lineNumber, "invalid dotted key syntax");
  return parsed.path;
}

function parseDottedKeyWithOffset(value, initialOffset, lineNumber) {
  const path = [];
  let offset = skipSpace(value, initialOffset);
  while (offset < value.length) {
    let key;
    if (value[offset] === '"') {
      const end = findBasicStringEnd(value, offset + 1);
      if (end < 0) failClosed(lineNumber, "unterminated quoted key");
      try { key = JSON.parse(value.slice(offset, end + 1)); } catch { failClosed(lineNumber, "unsupported quoted key escape"); }
      offset = end + 1;
    } else if (value[offset] === "'") {
      const end = value.indexOf("'", offset + 1);
      if (end < 0) failClosed(lineNumber, "unterminated literal key");
      key = value.slice(offset + 1, end);
      offset = end + 1;
    } else {
      const match = value.slice(offset).match(/^[A-Za-z0-9_-]+/);
      if (!match) failClosed(lineNumber, "unsupported key syntax");
      key = match[0];
      offset += key.length;
    }
    if (!key) failClosed(lineNumber, "empty key segment");
    path.push(key);
    offset = skipSpace(value, offset);
    if (value[offset] !== ".") break;
    offset = skipSpace(value, offset + 1);
  }
  if (path.length === 0) failClosed(lineNumber, "empty key");
  return { path, offset };
}

function classifyManagedTable(path) {
  if (path.length === 2 && path[0] === "apps") return path[1] === "_default" ? "app-default" : "app";
  if (path.length === 2 && path[0] === "mcp_servers") return "mcp-server";
  if (path.length === 4 && path[0] === "plugins" && path[2] === "mcp_servers") return "plugin-mcp-server";
  return null;
}

function classifyTargetSetting(path) {
  if (path.length === 1 && ROOT_SETTINGS.some((setting) => setting.key === path[0])) return { kind: "root", setting: path[0] };
  const table = classifyManagedTable(path.slice(0, -1));
  const key = path.at(-1);
  if ((table === "app" || table === "app-default") && APP_SETTINGS.some((setting) => setting.key === key)) return { kind: table, setting: key };
  if ((table === "mcp-server" || table === "plugin-mcp-server") && key === "default_tools_approval_mode") return { kind: table, setting: key };
  return null;
}

function classifyPerToolOverride(path) {
  if (path.length === 5 && path[0] === "apps" && path[2] === "tools" && path[4] === "approval_mode") {
    return { kind: "app-tool", table: displayPath(path.slice(0, -1)), setting: "approval_mode" };
  }
  if (path.length === 5 && path[0] === "mcp_servers" && path[2] === "tools" && path[4] === "approval_mode") {
    return { kind: "mcp-tool", table: displayPath(path.slice(0, -1)), setting: "approval_mode" };
  }
  if (path.length === 7 && path[0] === "plugins" && path[2] === "mcp_servers" && path[4] === "tools" && path[6] === "approval_mode") {
    return { kind: "plugin-mcp-tool", table: displayPath(path.slice(0, -1)), setting: "approval_mode" };
  }
  return null;
}

function isManagedNamespace(path) {
  if (path[0] === "apps" || path[0] === "mcp_servers") return true;
  return path[0] === "plugins" && path.includes("mcp_servers");
}

function isAmbiguousManagedAssignment(fullPath, assignment) {
  if (!isManagedNamespace(fullPath)) return false;
  if (classifyManagedTable(fullPath)) return true;
  if (fullPath.length === 1) return true;
  return assignment.valueKind === "inline-table" && couldHidePerToolOverride(fullPath);
}

function couldHidePerToolOverride(path) {
  if (path[0] === "apps" && path[2] === "tools" && (path.length === 3 || path.length === 4)) return true;
  if (path[0] === "mcp_servers" && path[2] === "tools" && (path.length === 3 || path.length === 4)) return true;
  return path[0] === "plugins" && path[2] === "mcp_servers" && path[4] === "tools" && (path.length === 5 || path.length === 6);
}

function rewriteAssignment(line, assignment, value) {
  const ending = line.slice(stripLineEnding(line).length);
  const body = stripLineEnding(line);
  return `${body.slice(0, assignment.valueStart)}${JSON.stringify(value)}${body.slice(assignment.valueEnd)}${ending}`;
}

function policyEffects(tables) {
  return Object.freeze({
    topLevelSettings: Object.freeze(ROOT_SETTINGS.map((setting) => setting.key)),
    appTables: tables.filter((table) => table.kind === "app").length,
    mcpServerTables: tables.filter((table) => table.kind === "mcp-server").length,
    pluginMcpServerTables: tables.filter((table) => table.kind === "plugin-mcp-server").length,
    destructiveOrOpenWorldEnablement: false,
    appPluginServerEnablement: false,
  });
}

function appendConflict(conflicts, conflict) {
  if (conflicts.length < MAX_CONFLICTS) conflicts.push(Object.freeze({ ...conflict }));
  else if (!conflicts.some((item) => item.kind === "truncated")) conflicts.push(Object.freeze({ kind: "truncated", table: "additional per-tool overrides", setting: "approval_mode" }));
}

function firstHeaderIndex(records, fallback) {
  return records.find((record) => record.kind === "header")?.lineIndex ?? fallback;
}

function nextHeaderIndex(records, headerIndex, fallback) {
  return records.find((record) => record.kind === "header" && record.lineIndex > headerIndex)?.lineIndex ?? fallback;
}

function findInlineComment(line, start) {
  let quote = null;
  let escaped = false;
  let bracketDepth = 0;
  for (let index = start; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") bracketDepth += 1;
    else if (char === "]" || char === "}") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "#" && bracketDepth === 0) return index;
  }
  return -1;
}

function isMultilineValue(value) {
  if (value.startsWith('"""') || value.startsWith("'''")) return true;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (const char of value) {
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
    } else if (quote === "'") {
      if (char === "'") quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return quote !== null || depth !== 0;
}

function findContinuationEnd(lines, startIndex, valueStart) {
  let value = stripLineEnding(lines[startIndex]).slice(valueStart);
  for (let index = startIndex; index < lines.length; index += 1) {
    if (index > startIndex) value += `\n${stripLineEnding(lines[index])}`;
    if (tomlValueIsComplete(value)) return index;
  }
  failClosed(startIndex + 1, "unterminated multiline value");
}

function tomlValueIsComplete(value) {
  let quote = null;
  let triple = null;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (triple) {
      if (triple === '"""' && escaped) {
        escaped = false;
        continue;
      }
      if (triple === '"""' && char === "\\") {
        escaped = true;
        continue;
      }
      if (value.startsWith(triple, index)) {
        index += 2;
        triple = null;
      }
      continue;
    }
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      else if (char === "\n") return false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else if (char === "\n") return false;
      continue;
    }
    if (value.startsWith('"""', index) || value.startsWith("'''", index)) {
      triple = value.slice(index, index + 3);
      index += 2;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "#") {
      const newline = value.indexOf("\n", index + 1);
      if (newline < 0) break;
      index = newline;
    }
    if (depth < 0) return true;
  }
  return triple === null && quote === null && depth === 0;
}

function findUnquotedSequence(value, sequence, start) {
  let quote = null;
  let escaped = false;
  for (let index = start; index <= value.length - sequence.length; index += 1) {
    const char = value[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (value.startsWith(sequence, index)) return index;
  }
  return -1;
}

function findBasicStringEnd(value, start) {
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    if (escaped) escaped = false;
    else if (value[index] === "\\") escaped = true;
    else if (value[index] === '"') return index;
  }
  return -1;
}

function renderKey(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function displayPath(path) {
  return path.map(renderKey).join(".");
}

function pathId(path) {
  return JSON.stringify(path);
}

function stripLineEnding(line) {
  return line.replace(/(?:\r\n|\n|\r)$/, "");
}

function skipSpace(value, offset) {
  while (value[offset] === " " || value[offset] === "\t") offset += 1;
  return offset;
}

function ensureTrailingEol(value, eol) {
  return !value || value.endsWith("\n") || value.endsWith("\r") ? value : `${value}${eol}`;
}

function endsWithBlankLine(value, eol) {
  return value.endsWith(`${eol}${eol}`);
}

function failClosed(lineNumber, description) {
  throw new Error(`Codex TOML policy transform failed closed at line ${lineNumber}: ${description}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
