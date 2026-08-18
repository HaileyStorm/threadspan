import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/core/config.mjs";
import { Logger } from "../src/core/logger.mjs";

/** Convert a file URL to the current platform's native filesystem path. */
export function nativePath(url) {
  return fileURLToPath(url);
}

/**
 * Wrap a Node CLI fixture in the npm-style Windows command-shim pair used by managed processes.
 * @param {import("node:test").TestContext} context Test cleanup context.
 * @param {string} scriptPath Native path to the Node fixture.
 * @param {string} name Shim basename.
 * @param {{platform?: NodeJS.Platform}} [options] Platform override for fixture coverage.
 * @returns {Promise<string>} Native command path for the current platform.
 */
export async function createWindowsNpmBinShim(context, scriptPath, name, options = {}) {
  if ((options.platform ?? process.platform) !== "win32") return scriptPath;
  const directory = await mkdtemp(join(tmpdir(), `threadspan-${name}-`));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const commandPath = join(directory, `${name}.cmd`);
  const powershellPath = join(directory, `${name}.ps1`);
  const invoke = `& ${powershellQuote(process.execPath)} ${powershellQuote(scriptPath)} $args`;
  const powershell = [
    "#!/usr/bin/env pwsh",
    "$utf8 = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::InputEncoding = $utf8",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
    "if ($MyInvocation.ExpectingInput) {",
    `  $input | ${invoke}`,
    "} else {",
    `  ${invoke}`,
    "}",
    "exit $LASTEXITCODE",
    "",
  ].join("\r\n");
  await Promise.all([
    writeFile(commandPath, `@ECHO off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`),
    writeFile(powershellPath, `\ufeff${powershell}`),
  ]);
  return commandPath;
}

/**
 * Build a validated test configuration with a deterministic mock provider.
 * @param {Record<string, any>} [override] Shallow/deep override.
 * @returns {Record<string, any>}
 */
export function createTestConfig(override = {}) {
  const base = {
    server: {
      host: "127.0.0.1",
      port: 8743,
      authTokenEnv: "CURSOR_BRIDGE_TEST_TOKEN",
      allowUnauthenticatedLoopback: true,
      maxBodyBytes: 1024 * 1024,
      requestTimeoutMs: 30_000,
      maxConcurrentRequests: 2,
      allowedOrigins: [],
    },
    responses: { exposeReasoning: false },
    logging: { level: "silent", logBodies: false },
    sessions: { ttlMs: 60_000, maxEntries: 100 },
    defaults: { provider: "mock", mode: "consult", model: "mock-model" },
    providers: {
      mock: {
        adapter: "mock",
        model: "mock-model",
        capabilities: ["consult", "integrated", "delegate"],
      },
    },
  };
  return validateConfig(deepMerge(base, override), "<test>");
}

/** Return a silent logger for tests. */
export function silentLogger() {
  return new Logger({ level: "silent" });
}

/**
 * Deep merge test objects.
 * @param {any} base Base.
 * @param {any} override Override.
 * @returns {any}
 */
function deepMerge(base, override) {
  if (!base || typeof base !== "object" || Array.isArray(base) || !override || typeof override !== "object" || Array.isArray(override)) return override;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) output[key] = key in output ? deepMerge(output[key], value) : value;
  return output;
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}
