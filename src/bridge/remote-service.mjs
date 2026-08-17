import { BridgeError } from "../core/errors.mjs";

/**
 * Service-compatible HTTP client for MCP shims that share one persistent bridge daemon.
 *
 * Each ChatGPT/Codex Desktop process may still launch its own tiny stdio MCP process, while
 * provider pools, retained Cursor agents, Grok admission limits, and ledgers remain centralized.
 */
export class RemoteBridgeService {
  /**
   * @param {{
   *   baseUrl: string,
   *   tokenEnv?: string,
   *   timeoutMs?: number,
   *   fetchImpl?: typeof fetch,
   *   environment?: NodeJS.ProcessEnv,
   * }} options Client options.
   */
  constructor(options) {
    if (!options?.baseUrl) throw new Error("RemoteBridgeService requires baseUrl");
    this.baseUrl = normalizeBridgeBaseUrl(options.baseUrl);
    this.tokenEnv = options.tokenEnv ?? "CURSOR_BRIDGE_TOKEN";
    this.timeoutMs = positiveInteger(options.timeoutMs, 2 * 60 * 60 * 1000);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.environment = options.environment ?? process.env;
  }

  /** Forward an advisory Consult call to the persistent daemon. */
  async consult(input, options = {}) {
    return this.#request("/v1/consult", { method: "POST", body: input, signal: options.signal });
  }

  /** Forward a bounded Delegate call to the persistent daemon. */
  async delegate(input, options = {}) {
    return this.#request("/v1/delegate", { method: "POST", body: input, signal: options.signal });
  }

  /** Return daemon health and provider-runtime counters. */
  async stats() {
    return this.#request("/health");
  }

  /** Return configured provider capabilities. */
  async describeProviders() {
    const result = await this.#request("/v1/bridge/providers");
    return result.data ?? result;
  }

  /** Return routed model records. */
  async listModels() {
    const result = await this.#request("/v1/models");
    return result.data ?? result;
  }

  /** The proxy owns no local provider resources. */
  async close() {}

  /** Execute one authenticated, cancellable JSON request. */
  async #request(path, options = {}) {
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutController.abort(new BridgeError(`Remote bridge request timed out after ${this.timeoutMs} ms`, {
        status: 504,
        code: "remote_bridge_timeout",
      }));
    }, this.timeoutMs);
    timeout.unref?.();
    const signal = combineAbortSignals(options.signal, timeoutController.signal);
    const token = this.environment[this.tokenEnv];
    const headers = { accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      });
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch (error) {
        throw new BridgeError(`Remote bridge returned non-JSON HTTP ${response.status}`, {
          status: 502,
          code: "remote_bridge_invalid_response",
          details: { body: text.slice(0, 2000) },
          cause: error,
        });
      }
      if (!response.ok) {
        const upstream = body?.error ?? {};
        throw new BridgeError(upstream.message ?? `Remote bridge returned HTTP ${response.status}`, {
          status: response.status,
          code: upstream.code ?? upstream.type ?? "remote_bridge_error",
          details: upstream.details,
        });
      }
      return body;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (timeoutController.signal.aborted) throw timeoutController.signal.reason ?? error;
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(`Could not reach persistent bridge daemon at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, {
        status: 503,
        code: "remote_bridge_unavailable",
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Normalize a daemon root URL or a Codex Responses `/v1` base URL to the daemon root. */
export function normalizeBridgeBaseUrl(value) {
  const url = new URL(String(value));
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") || "";
  return url.toString().replace(/\/$/, "");
}

/** Combine caller cancellation with the local timeout. */
function combineAbortSignals(left, right) {
  const signals = [left, right].filter(Boolean);
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/** Resolve a positive safe integer or a fallback. */
function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
