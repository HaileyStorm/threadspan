#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BridgeService } from "./bridge/service.mjs";
import { closeHttpServer, createHttpServer, listenHttpServer } from "./bridge/http-server.mjs";
import { RemoteBridgeService } from "./bridge/remote-service.mjs";
import { installCodexConfigBlock, renderCodexConfigBlock, resolveCodexConfigPath, uninstallCodexConfigBlock } from "./codex/config.mjs";
import { buildMergedModelCatalog } from "./codex/catalog.mjs";
import { discoverNativeCodexCatalog } from "./codex/app-server.mjs";
import { installBridgeSkills, resolveCodexSkillsRoot } from "./codex/skill-install.mjs";
import { createExampleConfig, loadConfig, resolveConfigPath, writeInitialConfig } from "./core/config.mjs";
import { asBridgeError } from "./core/errors.mjs";
import { resolveExecutablePath } from "./core/executable.mjs";
import { Logger } from "./core/logger.mjs";
import { applyInstallerPlan, createInstallerPlan, previewInstallerPlan } from "./installer/index.mjs";
import { runMcpServer } from "./mcp/server.mjs";
import { inspectGrokBuildInstallation } from "./providers/grok-build.mjs";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SOURCE_DIRECTORY, "..");

/**
 * CLI entry point.
 * @param {string[]} argv Process arguments after the executable and script.
 * @returns {Promise<void>}
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  const [command = "help", subcommand, ...rest] = parsed.positionals;

  try {
    if (["help", "--help", "-h"].includes(command)) {
      printHelp();
      return;
    }
    if (command === "config" && subcommand === "init") {
      const path = writeInitialConfig(parsed.options.config, createExampleConfig(), { force: parsed.options.force === true });
      process.stdout.write(`${path}\n`);
      return;
    }
    if (command === "install" && subcommand === "plan") {
      const installRoot = valueOption(parsed.options.root);
      const outputPath = valueOption(parsed.options.output);
      if (!installRoot || !outputPath) throw new Error("install plan requires --root PATH and --output PLAN.json");
      const components = arrayOption(parsed.options.component);
      const longContext = valueOption(parsed.options.longContext);
      const plan = createInstallerPlan({
        installRoot,
        selection: parsed.options.all === true || components.length === 0 ? "all" : components,
        longContextProfiles: longContext === "all" ? "all" : arrayOption(parsed.options.longContext),
        planId: valueOption(parsed.options.planId),
      });
      const destination = resolve(outputPath);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, destination);
      process.stdout.write(previewInstallerPlan(plan).text);
      process.stdout.write(`Plan file: ${destination}\n`);
      return;
    }
    if (command === "install" && subcommand === "apply") {
      const planPath = valueOption(parsed.options.plan);
      const approvedDigest = valueOption(parsed.options.approveDigest);
      if (!planPath || !approvedDigest) throw new Error("install apply requires --plan PLAN.json and --approve-digest SHA256");
      const plan = JSON.parse(await readFile(resolve(planPath), "utf8"));
      process.stdout.write(`${JSON.stringify(await applyInstallerPlan(plan, { approvedDigest }), null, 2)}\n`);
      return;
    }

    const configPath = resolveConfigPath(valueOption(parsed.options.config));
    const config = loadConfig(configPath);
    const logger = new Logger({ level: valueOption(parsed.options.logLevel) ?? config.logging?.level ?? "info" });

    if (command === "serve") {
      await runServe(config, logger);
      return;
    }
    if (command === "mcp") {
      const remoteUrl = parsed.options.embedded === true
        ? undefined
        : valueOption(parsed.options.remote) ?? process.env.THREADSPAN_MCP_URL ?? process.env.CURSOR_BRIDGE_MCP_URL;
      const service = remoteUrl
        ? new RemoteBridgeService({
            baseUrl: remoteUrl,
            tokenEnv: config.server.authTokenEnv,
            timeoutMs: config.server.requestTimeoutMs,
          })
        : new BridgeService(config, { logger });
      try {
        await runMcpServer({ service, logger: logger.child(remoteUrl ? "mcp-proxy" : "mcp") });
      } finally {
        await service.close();
      }
      return;
    }
    if (command === "doctor") {
      const report = await runDoctor(config, { live: parsed.options.live === true });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (command === "providers" || command === "models") {
      const service = new BridgeService(config, { logger });
      try {
        const result = command === "providers" ? await service.describeProviders() : await service.listModels();
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        await service.close();
      }
      return;
    }
    if (command === "catalog" && subcommand === "build") {
      const nativePath = valueOption(parsed.options.native);
      const outputPath = valueOption(parsed.options.output);
      if (!outputPath) throw new Error("catalog build requires --output PATH");
      const nativeCatalog = nativePath
        ? JSON.parse(await readFile(resolve(nativePath), "utf8"))
        : await discoverNativeCodexCatalog({ command: valueOption(parsed.options.codex) ?? "codex" });
      const service = new BridgeService(config, { logger });
      try {
        const catalog = buildMergedModelCatalog(
          nativeCatalog,
          await service.listModels(),
          await service.describeProviders(),
          { favorites: arrayOption(parsed.options.favorite), showFree: parsed.options.showFree === true },
        );
        const destination = resolve(outputPath);
        await mkdir(dirname(destination), { recursive: true });
        const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
        await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, destination);
        process.stdout.write(`${JSON.stringify({ path: destination, models: catalog.models.length }, null, 2)}\n`);
      } finally {
        await service.close();
      }
      return;
    }
    if (command === "consult" || command === "delegate") {
      const service = new BridgeService(config, { logger });
      try {
        const question = valueOption(parsed.options.question) ?? [subcommand, ...rest].filter(Boolean).join(" ");
        const context = await resolveTextOption(parsed.options.context, parsed.options.contextFile);
        const input = {
          question,
          ...(context ? { context } : {}),
          ...(valueOption(parsed.options.provider) ? { provider: valueOption(parsed.options.provider) } : {}),
          ...(valueOption(parsed.options.model) ? { model: valueOption(parsed.options.model) } : {}),
          ...(valueOption(parsed.options.thread) ? { threadId: valueOption(parsed.options.thread) } : {}),
          ...(valueOption(parsed.options.workspace) ? { workspace: resolve(valueOption(parsed.options.workspace)) } : {}),
          ...(valueOption(parsed.options.timeout) ? { timeoutMs: Number(valueOption(parsed.options.timeout)) } : {}),
          ...(valueOption(parsed.options.profile) ? { profile: valueOption(parsed.options.profile) } : {}),
          ...(valueOption(parsed.options.effort) ? { reasoningEffort: valueOption(parsed.options.effort) } : {}),
          ...(valueOption(parsed.options.maxTurns) ? { maxTurns: Number(valueOption(parsed.options.maxTurns)) } : {}),
          ...(valueOption(parsed.options.expectedTurns) ? { expectedTurns: Number(valueOption(parsed.options.expectedTurns)) } : {}),
          ...(parsed.options.noPlan === true ? { noPlan: true } : {}),
          ...(parsed.options.allowSubagents === true ? { allowSubagents: true } : {}),
          ...(parsed.options.noSubagents === true ? { allowSubagents: false } : {}),
          ...(parsed.options.allowWebSearch === true || parsed.options.allowWeb === true ? { allowWebSearch: true } : {}),
          ...(parsed.options.noWebSearch === true || parsed.options.noWeb === true ? { allowWebSearch: false } : {}),
          ...(valueOption(parsed.options.coordinatorId) ? { coordinatorId: valueOption(parsed.options.coordinatorId) } : {}),
          ...(valueOption(parsed.options.workerGroup) ? { workerGroup: valueOption(parsed.options.workerGroup) } : {}),
          ...(arrayOption(parsed.options.acceptanceCommand).length > 0 ? { acceptanceCommands: arrayOption(parsed.options.acceptanceCommand) } : {}),
          ...(arrayOption(parsed.options.allowPath).length > 0 ? { allowedPaths: arrayOption(parsed.options.allowPath), deniedPaths: arrayOption(parsed.options.denyPath), nonGoals: arrayOption(parsed.options.nonGoal) } : {}),
        };
        const result = command === "consult" ? await service.consult(input) : await service.delegate(input);
        writeConvenienceResult(result, { json: parsed.options.json === true });
      } finally {
        await service.close();
      }
      return;
    }
    if (command === "codex" && ["snippet", "install", "uninstall"].includes(subcommand)) {
      await runCodexCommand(subcommand, parsed.options, configPath, config);
      return;
    }
    if (command === "skill" && subcommand === "install") {
      const targetRoot = resolve(valueOption(parsed.options.target) ?? resolveCodexSkillsRoot());
      const selection = valueOption(parsed.options.skill) ?? "consult";
      const names = selection === "all" ? ["consult", "managed-worker"] : [selection];
      for (const name of names) {
        if (!["consult", "managed-worker"].includes(name)) throw new Error(`Unknown packaged skill '${name}'`);
      }
      const targets = await installBridgeSkills(resolve(PACKAGE_ROOT, "skills"), targetRoot, names, { force: parsed.options.force === true });
      process.stdout.write(targets.length === 1 ? `${targets[0]}\n` : `${JSON.stringify(targets, null, 2)}\n`);
      return;
    }

    throw new Error(`Unknown command '${[command, subcommand].filter(Boolean).join(" ")}'`);
  } catch (error) {
    const bridgeError = asBridgeError(error);
    process.stderr.write(`${bridgeError.code}: ${bridgeError.message}\n`);
    if (bridgeError.details && (process.env.THREADSPAN_DEBUG === "1" || process.env.CURSOR_BRIDGE_DEBUG === "1")) {
      process.stderr.write(`${JSON.stringify(bridgeError.details, null, 2)}\n`);
    }
    process.exitCode = 1;
  }
}

/**
 * Start the daemon and keep it alive until SIGINT or SIGTERM.
 * @param {Record<string, any>} config Bridge configuration.
 * @param {Logger} logger Logger.
 * @returns {Promise<void>}
 */
async function runServe(config, logger) {
  const service = new BridgeService(config, { logger });
  const server = createHttpServer(service, config);
  const address = await listenHttpServer(server, { host: config.server.host, port: config.server.port });
  logger.info("Bridge HTTP server listening", { host: address.address, port: address.port, configPath: config.configPath });
  process.stdout.write(`http://${formatHost(address.address)}:${address.port}\n`);

  await new Promise((resolveSignal) => {
    const shutdown = () => resolveSignal();
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await closeHttpServer(server);
  await service.close();
}

/**
 * Render, install, or uninstall the managed Codex configuration block.
 * @param {"snippet"|"install"|"uninstall"} subcommand Codex subcommand.
 * @param {Record<string, any>} options CLI options.
 * @param {string} bridgeConfigPath Bridge config path.
 * @param {Record<string, any>} config Bridge configuration.
 * @returns {Promise<void>}
 */
async function runCodexCommand(subcommand, options, bridgeConfigPath, config) {
  const codexConfigPath = resolve(valueOption(options.codexConfig) ?? resolveCodexConfigPath());
  if (subcommand === "uninstall") {
    process.stdout.write(`${JSON.stringify(await uninstallCodexConfigBlock(codexConfigPath), null, 2)}\n`);
    return;
  }
  const bridgeUrl = valueOption(options.url) ?? `http://${config.server.host}:${config.server.port}/v1`;
  const block = renderCodexConfigBlock({
    bridgeUrl,
    mcpRemoteUrl: options.embeddedMcp === true ? undefined : bridgeUrl,
    tokenEnv: config.server.authTokenEnv,
    cliPath: fileURLToPath(import.meta.url),
    bridgeConfigPath,
    defaultProvider: config.defaults.provider,
    defaultModel: config.defaults.model,
    integratedProvider: valueOption(options.integratedProvider) ?? findProviderForMode(config, "integrated")?.id ?? config.defaults.provider,
    integratedModel: valueOption(options.integratedModel) ?? findProviderForMode(config, "integrated")?.config.model ?? config.defaults.model,
    delegateProvider: valueOption(options.delegateProvider) ?? findProviderForMode(config, "delegate")?.id ?? config.defaults.provider,
    delegateModel: valueOption(options.delegateModel) ?? findProviderForMode(config, "delegate")?.config.model ?? config.defaults.model,
    modelCatalogPath: valueOption(options.modelCatalog),
  });
  if (subcommand === "snippet") {
    process.stdout.write(`${block}\n`);
    return;
  }
  const result = await installCodexConfigBlock(codexConfigPath, block, { backup: options.noBackup !== true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Build an environment/configuration readiness report without paid inference calls by default.
 * @param {Record<string, any>} config Bridge configuration.
 * @param {{live?: boolean}} options Doctor options.
 * @returns {Promise<Record<string, any>>}
 */
async function runDoctor(config, options) {
  const checks = [];
  checks.push({ name: "config", ok: true, detail: config.configPath });
  const tokenEnv = config.server.authTokenEnv;
  const tokenConfigured = Boolean(tokenEnv && process.env[tokenEnv]);
  checks.push({
    name: "bridge-auth-token",
    ok: tokenConfigured || config.server.allowUnauthenticatedLoopback === true,
    warning: !tokenConfigured && config.server.allowUnauthenticatedLoopback === true,
    detail: tokenConfigured ? `${tokenEnv} is set` : `${tokenEnv ?? "THREADSPAN_TOKEN"} is not set; loopback-only unauthenticated access is enabled`,
  });

  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.enabled === false) continue;
    const apiKey = provider.apiKey || (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    if (provider.apiKeyEnv) {
      checks.push({ name: `provider:${id}:credential`, ok: Boolean(apiKey), detail: apiKey ? `${provider.apiKeyEnv} is set` : `${provider.apiKeyEnv} is not set` });
    }
    if (provider.adapter === "cursor-sdk") {
      let installed = false;
      let detail;
      try {
        const sdk = await import("@cursor/sdk");
        installed = Boolean(sdk.Agent);
        detail = installed ? "@cursor/sdk imported" : "@cursor/sdk did not export Agent";
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      checks.push({ name: `provider:${id}:sdk`, ok: installed, detail });
    }
    if (provider.adapter === "command") {
      const executablePath = await resolveExecutablePath(provider.command);
      checks.push({
        name: `provider:${id}:command`,
        ok: executablePath !== undefined,
        detail: executablePath ?? `${provider.command ?? "missing command"} was not found on PATH`,
      });
    }
    if (provider.adapter === "grok-build") {
      const inspection = await inspectGrokBuildInstallation(provider);
      checks.push({
        name: `provider:${id}:grok-build`,
        ok: inspection.ok,
        detail: inspection.ok
          ? `${inspection.executable} — ${inspection.version ?? "version unknown"}${inspection.sha256 ? ` — sha256 ${inspection.sha256}` : ""}`
          : inspection.errors.join("; "),
      });
      for (const warning of inspection.warnings) {
        checks.push({ name: `provider:${id}:grok-build-policy`, ok: true, warning: true, detail: warning });
      }
      checks.push({
        name: `provider:${id}:grok-build-entitlement`,
        ok: true,
        warning: true,
        detail: "Consumer Build entitlement and remaining weekly usage cannot be verified through a documented headless meter without an authenticated request; verify the CLI account and Settings → Usage before automatic batches",
      });
    }
    if (options.live && provider.baseUrl) {
      const baseUrl = String(provider.baseUrl).replace(/\/$/, "");
      const url = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
      try {
        const response = await fetch(url, {
          headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          signal: AbortSignal.timeout(5000),
        });
        checks.push({ name: `provider:${id}:live`, ok: response.ok, detail: `${response.status} ${response.statusText}` });
      } catch (error) {
        checks.push({ name: `provider:${id}:live`, ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  return {
    ok: checks.every((check) => check.ok || check.warning),
    generatedAt: new Date().toISOString(),
    liveChecks: options.live === true,
    checks,
  };
}

export { resolveExecutablePath };

/**
 * Find the first enabled provider declaring a mode.
 * @param {Record<string, any>} config Bridge configuration.
 * @param {string} mode Bridge mode.
 * @returns {{id: string, config: Record<string, any>}|undefined}
 */
function findProviderForMode(config, mode) {
  for (const [id, provider] of Object.entries(config.providers)) {
    if (provider.enabled !== false && provider.capabilities?.includes(mode)) return { id, config: provider };
  }
  return undefined;
}

/**
 * Write a Consult/Delegate result while keeping the answer clean on stdout and continuity ids
 * visible on stderr. JSON mode emits the complete result to stdout and no side-channel metadata.
 *
 * @param {Record<string, any>} result Convenience result.
 * @param {{json?: boolean, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream}} [options] Output options.
 */
export function writeConvenienceResult(result, options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (options.json === true) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const text = String(result?.text ?? "");
  stdout.write(`${text}${text.endsWith("\n") ? "" : "\n"}`);
  const identifiers = [
    result?.threadId ? `threadId=${result.threadId}` : undefined,
    result?.responseId ? `responseId=${result.responseId}` : undefined,
  ].filter(Boolean);
  if (identifiers.length > 0) stderr.write(`[threadspan] ${identifiers.join(" ")}\n`);
}

/**
 * Parse positional and GNU-style long options.
 * @param {string[]} argv CLI arguments.
 * @returns {{positionals: string[], options: Record<string, string|boolean|string[]>}}
 */
export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf("=");
    const rawName = equals >= 0 ? value.slice(2, equals) : value.slice(2);
    const name = toCamelCase(rawName);
    const inlineValue = equals >= 0 ? value.slice(equals + 1) : undefined;
    const next = argv[index + 1];
    const optionValue = inlineValue ?? (next !== undefined && !next.startsWith("--") ? argv[++index] : true);
    if (options[name] === undefined) options[name] = optionValue;
    else if (Array.isArray(options[name])) options[name].push(optionValue);
    else options[name] = [options[name], optionValue];
  }
  return { positionals, options };
}

/**
 * Convert a dashed option name to camelCase.
 * @param {string} value Option name.
 * @returns {string}
 */
function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

/**
 * Resolve an option that may have been repeated; the last value wins.
 * @param {unknown} value Parsed option.
 * @returns {string|undefined}
 */
function valueOption(value) {
  const resolved = Array.isArray(value) ? value.at(-1) : value;
  return typeof resolved === "string" ? resolved : undefined;
}

/** Return every string value supplied for a repeatable option. */
function arrayOption(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

/**
 * Resolve inline text or load text from a file.
 * @param {unknown} inline Inline option.
 * @param {unknown} file File option.
 * @returns {Promise<string|undefined>}
 */
async function resolveTextOption(inline, file) {
  const inlineValue = valueOption(inline);
  if (inlineValue !== undefined) return inlineValue;
  const path = valueOption(file);
  return path ? readFile(resolve(path), "utf8") : undefined;
}

/**
 * Add brackets around IPv6 addresses for URL display.
 * @param {string} host Host.
 * @returns {string}
 */
function formatHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

/** Print CLI usage. */
function printHelp() {
  process.stdout.write(`threadspan — one task across every model

Usage:
  threadspan install plan --root PATH --output PLAN.json [--all|--component ID ...] [--long-context all|NAME ...]
  threadspan install apply --plan PLAN.json --approve-digest SHA256
  threadspan config init [--config PATH] [--force]
  threadspan serve [--config PATH]
  threadspan mcp [--config PATH] [--remote URL|--embedded]
  threadspan doctor [--config PATH] [--live]
  threadspan providers [--config PATH]
  threadspan models [--config PATH]
  threadspan catalog build --output PATH [--native PATH|--codex PATH] [--favorite ROUTE ...] [--show-free]
  threadspan consult "question" [--context TEXT|--context-file PATH] [--provider ID] [--model ID] [--workspace PATH] [--thread ID] [--profile NAME] [--effort low|medium|high] [--max-turns N] [--expected-turns N] [--no-plan] [--allow-subagents|--no-subagents] [--allow-web|--no-web] [--coordinator-id ID] [--worker-group NAME] [--json]
  threadspan delegate "task" --workspace PATH --allow-path PATH ... [--deny-path PATH ...] [--non-goal TEXT ...] [same routing options] [--acceptance-command CMD ...]
  threadspan codex snippet [--config PATH]
  threadspan codex install [--config PATH] [--codex-config PATH] [--model-catalog PATH] [--embedded-mcp]
  threadspan codex uninstall [--codex-config PATH]
  threadspan skill install [--skill consult|managed-worker|all] [--target SKILLS_ROOT] [--force]

Modes:
  Consult     Advisory second opinion. Cursor uses a disposable workspace snapshot.
  Integrated  Secondary raw model is active; the calling client owns tools.
  Delegate    Secondary provider agent owns a bounded execution task.
`);
}

/**
 * Determine whether this module is the process entry point, including npm-created bin symlinks.
 *
 * `path.resolve()` alone compares the symlink path in `process.argv[1]` with the package's
 * real module path and therefore fails for an installed npm binary. Canonical paths preserve
 * the no-side-effects-on-import contract while allowing the packaged CLI to start normally.
 *
 * @param {string|undefined} invocationPath Process entry path.
 * @param {string} [modulePath] Canonical module candidate.
 * @returns {boolean} Whether the module should execute `main()`.
 */
export function isDirectCliInvocation(invocationPath, modulePath = fileURLToPath(import.meta.url)) {
  if (!invocationPath) return false;
  try {
    return realpathSync(invocationPath) === realpathSync(modulePath);
  } catch {
    return resolve(invocationPath) === resolve(modulePath);
  }
}

if (isDirectCliInvocation(process.argv[1])) {
  await main();
}
