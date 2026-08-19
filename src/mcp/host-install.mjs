import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { renderClaudeCodeMcpConfig, renderClaudeCodeSettings, renderCursorMcpConfig, renderGrokMcpToml, renderHermesMcpYaml } from "./host-config.mjs";

const GROK_START = "# >>> threadspan managed MCP >>>";
const GROK_END = "# <<< threadspan managed MCP <<<";

export async function installHostSurface(host, options) {
  const home = resolve(options.home ?? homedir());
  const common = {
    nodePath: options.nodePath,
    cliPath: options.cliPath,
    bridgeConfigPath: options.bridgeConfigPath,
    connectorTokenFile: options.connectorTokenFile,
    remoteUrl: options.remoteUrl,
  };
  if (host === "cursor") {
    const path = resolve(options.targetPath ?? resolve(home, ".cursor", "mcp.json"));
    const existingText = await readBoundedRegularFile(path, "{}\n");
    const existing = JSON.parse(existingText);
    return atomicInstall(path, renderCursorMcpConfig(existing, common));
  }
  if (host === "grok") {
    const path = resolve(options.targetPath ?? resolve(home, ".grok", "config.toml"));
    const existing = await readBoundedRegularFile(path, "");
    const block = `${GROK_START}\n${renderGrokMcpToml(common).trimEnd()}\n${GROK_END}`;
    const content = replaceManagedBlock(existing, block);
    const result = await atomicInstall(path, content);
    return { ...result, nextAction: `grok mcp doctor threadspan`, pluginSource: options.pluginSource ?? null };
  }
  if (host === "claude-code") {
    if (options.allowPreview !== true) throw new Error("Claude Code Preview install requires --allow-preview");
    if (typeof options.statusLinePath !== "string" || !options.statusLinePath) throw new TypeError("Claude Code Preview install requires statusLinePath");
    const path = resolve(options.targetPath ?? resolve(home, ".claude", "threadspan", "mcp.json"));
    const settingsPath = resolve(options.settingsTargetPath ?? resolve(home, ".claude", "threadspan", "settings.json"));
    const existing = JSON.parse(await readBoundedRegularFile(path, "{}\n"));
    const existingSettings = JSON.parse(await readBoundedRegularFile(settingsPath, "{}\n"));
    const mcp = await atomicInstall(path, renderClaudeCodeMcpConfig(existing, common));
    const settings = await atomicInstall(settingsPath, renderClaudeCodeSettings(existingSettings, { ...common, statusLinePath: options.statusLinePath }));
    return {
      ...mcp,
      settings,
      stagedOnly: true,
      status: "preview",
      liveTested: false,
      pluginSource: options.pluginSource ?? null,
      nativePickerPreserved: true,
      nextActions: [
        "Revalidate the current Claude Code documentation and sign in outside Threadspan.",
        "Review the staged MCP JSON, then add its threadspan server with Claude Code's native user-scope MCP command.",
        "Review and merge the staged statusLine fragment; install the bundled plugin/skill only with explicit approval.",
      ],
    };
  }
  if (host === "hermes") {
    if (options.allowPreview !== true) throw new Error("Hermes Preview install requires --allow-preview");
    const path = resolve(options.targetPath ?? resolve(home, ".hermes", "threadspan-mcp.yaml"));
    const result = await atomicInstall(path, renderHermesMcpYaml(common));
    return {
      ...result,
      stagedOnly: true,
      status: "preview",
      liveTested: false,
      nativePickerPreserved: true,
      reverseDelegateAvailable: false,
      nextActions: [
        "Revalidate the current official Hermes configuration documentation and preserve native authentication/model selection.",
        "Merge the reviewed read-only connector snippet; do not replace the native config or enable reverse Delegate.",
        "Keep full-agent forward execution disabled until upstream provides verifiable source-bound tool isolation and configured-MCP exclusion.",
      ],
    };
  }
  throw new TypeError(`Unsupported host surface '${host}'`);
}

export function replaceManagedBlock(existing, block) {
  const start = existing.indexOf(GROK_START), end = existing.indexOf(GROK_END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error("Malformed existing Threadspan Grok MCP block");
  const cleaned = start >= 0 ? `${existing.slice(0, start)}${existing.slice(end + GROK_END.length)}` : existing;
  return `${cleaned.trimEnd()}${cleaned.trim() ? "\n\n" : ""}${block}\n`;
}

async function readBoundedRegularFile(path, fallback) {
  let stats;
  try { stats = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return fallback; throw error; }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`Host config is not a regular file: ${path}`);
  if (stats.size > 1024 * 1024) throw new Error(`Host config exceeds 1 MiB: ${path}`);
  return readFile(path, "utf8");
}

async function atomicInstall(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let backupPath = null;
  try {
    await lstat(path);
    backupPath = `${path}.threadspan-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await writeFile(backupPath, await readFile(path), { mode: 0o600, flag: "wx" });
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
  return { hostConfigPath: path, backupPath, rollback: backupPath ? { restore: backupPath, target: path } : { remove: path } };
}
