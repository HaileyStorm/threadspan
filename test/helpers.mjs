import { validateConfig } from "../src/core/config.mjs";
import { Logger } from "../src/core/logger.mjs";

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
