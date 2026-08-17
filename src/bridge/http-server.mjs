import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { asBridgeError, BridgeError, RequestError } from "../core/errors.mjs";

/**
 * Create the local HTTP surface for Responses API, model discovery, health, Consult, and Delegate.
 * @param {import("./service.mjs").BridgeService} service Bridge service.
 * @param {Record<string, any>} config Validated bridge configuration.
 * @returns {import("node:http").Server}
 */
export function createHttpServer(service, config) {
  const gate = new ConcurrencyGate(config.server?.maxConcurrentRequests ?? 4);
  return createServer(async (request, response) => {
    const requestController = new AbortController();
    const requestTimeoutMs = config.server?.requestTimeoutMs ?? 30 * 60 * 1000;
    const timeout = setTimeout(() => requestController.abort(new BridgeError("Request timed out", {
      status: 504,
      code: "request_timeout",
      details: { requestTimeoutMs },
    })), requestTimeoutMs);
    timeout.unref?.();
    const onDisconnect = () => requestController.abort(new Error("Client disconnected"));
    request.on("aborted", onDisconnect);
    response.on("close", () => {
      if (!response.writableFinished) onDisconnect();
    });

    let release;
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "OPTIONS") {
        writeOptionsResponse(request, response, config);
        return;
      }
      if (request.method === "GET" && (url.pathname === "/threadspan" || (url.pathname.startsWith("/threadspan/") && url.pathname !== "/threadspan/state"))) {
        if (!isLoopbackAddress(request.socket.remoteAddress ?? "")) {
          writeJson(response, 403, errorEnvelope("loopback_required", "Threadspan UI is available only from the local host"));
          return;
        }
        await handleThreadspanUiRequest(service, url.pathname, response);
        return;
      }
      enforceRequestAuthentication(request, config);
      applyCorsResponseHeaders(request, response, config);

      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
        writeJson(response, 200, service.stats());
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/models") {
        writeJson(response, 200, { object: "list", data: await service.listModels() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/bridge/providers") {
        writeJson(response, 200, { object: "list", data: await service.describeProviders() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/threadspan/state") {
        writeJson(response, 200, await service.threadspanState());
        return;
      }

      if (request.method === "POST" && ["/v1/responses", "/v1/consult", "/v1/delegate"].includes(url.pathname)) {
        release = await gate.acquire(requestController.signal);
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        if (url.pathname === "/v1/responses") {
          await handleResponsesRequest(service, body, requestController.signal, response);
        } else if (url.pathname === "/v1/consult") {
          writeJson(response, 200, await service.consult(normalizeConvenienceHttpInput(body), { signal: requestController.signal }));
        } else {
          writeJson(response, 200, await service.delegate(normalizeConvenienceHttpInput(body), { signal: requestController.signal }));
        }
        return;
      }

      writeJson(response, 404, errorEnvelope("not_found", `No route for ${request.method} ${url.pathname}`));
    } catch (error) {
      const bridgeError = asBridgeError(error);
      if (!response.headersSent) {
        writeJson(response, bridgeError.status, errorEnvelope(bridgeError.code, bridgeError.message, bridgeError.details));
      } else if (!response.writableEnded) {
        response.end();
      }
    } finally {
      release?.();
      clearTimeout(timeout);
      request.off("aborted", onDisconnect);
    }
  });
}

const THREADSPAN_ASSETS = new Map([
  ["/threadspan/", ["index.html", "text/html; charset=utf-8"]],
  ["/threadspan/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/threadspan/threadspan.css", ["threadspan.css", "text/css; charset=utf-8"]],
  ["/threadspan/threadspan.js", ["threadspan.js", "text/javascript; charset=utf-8"]],
  ["/threadspan/adapt-state.js", ["adapt-state.js", "text/javascript; charset=utf-8"]],
  ["/threadspan/mark.svg", ["mark.svg", "image/svg+xml"]],
]);

async function handleThreadspanUiRequest(service, pathname, response) {
  if (pathname === "/threadspan") {
    response.writeHead(302, { location: "/threadspan/", "cache-control": "no-store" });
    response.end();
    return;
  }
  const asset = THREADSPAN_ASSETS.get(pathname);
  if (!asset) {
    writeJson(response, 404, errorEnvelope("not_found", `No Threadspan UI asset for ${pathname}`));
    return;
  }
  const [name, contentType] = asset;
  const body = await readFile(new URL(`../../ui/${name}`, import.meta.url));
  response.writeHead(200, { "content-type": contentType, "content-length": body.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

/**
 * Start an HTTP server and resolve with its bound address.
 * @param {import("node:http").Server} server HTTP server.
 * @param {{host: string, port: number}} address Bind address.
 * @returns {Promise<import("node:net").AddressInfo>}
 */
export async function listenHttpServer(server, address) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address.port, address.host);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("HTTP server did not expose a TCP address");
  return bound;
}

/**
 * Gracefully close the HTTP server, force-closing idle connections when available.
 * @param {import("node:http").Server} server HTTP server.
 * @returns {Promise<void>}
 */
export async function closeHttpServer(server) {
  if (!server.listening) return;
  server.closeIdleConnections?.();
  const closePromise = new Promise((resolve) => server.close(() => resolve()));
  let forceTimer;
  const forcedClose = new Promise((resolve) => {
    forceTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolve();
    }, 5000);
    forceTimer.unref?.();
  });
  await Promise.race([closePromise, forcedClose]);
  if (forceTimer) clearTimeout(forceTimer);
}

/**
 * Execute a Responses request as buffered JSON or an SSE stream.
 * @param {import("./service.mjs").BridgeService} service Bridge service.
 * @param {Record<string, any>} body Request body.
 * @param {AbortSignal} signal Abort signal.
 * @param {import("node:http").ServerResponse} response HTTP response.
 * @returns {Promise<void>}
 */
async function handleResponsesRequest(service, body, signal, response) {
  if (body.stream !== true) {
    const result = await service.executeResponse(body, { signal });
    writeJson(response, 200, result);
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(": keep-alive\n\n");
  }, 15_000);
  keepAlive.unref?.();
  try {
    await service.executeResponse(body, {
      signal,
      onEvent: async (event) => {
        await writeWithBackpressure(response, `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      },
    });
    await writeWithBackpressure(response, "data: [DONE]\n\n");
  } finally {
    clearInterval(keepAlive);
    if (!response.writableEnded) response.end();
  }
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import("node:http").IncomingMessage} request HTTP request.
 * @param {number} maxBytes Maximum body bytes.
 * @param {AbortSignal} signal Abort signal.
 * @returns {Promise<Record<string, any>>}
 */
async function readJsonBody(request, maxBytes, signal) {
  const chunks = [];
  let size = 0;
  const onAbort = () => request.destroy();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of request) {
      if (signal.aborted) throw signal.reason ?? new Error("Request aborted");
      size += chunk.length;
      if (size > maxBytes) throw new RequestError(`Request body exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body is not an object");
    return parsed;
  } catch (error) {
    throw new RequestError("Request body is not valid JSON", { cause: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Enforce bearer-token and local-origin policy.
 * @param {import("node:http").IncomingMessage} request HTTP request.
 * @param {Record<string, any>} config Bridge configuration.
 */
function enforceRequestAuthentication(request, config) {
  const remoteAddress = request.socket.remoteAddress ?? "";
  const loopback = isLoopbackAddress(remoteAddress);
  const tokenEnv = config.server?.authTokenEnv;
  const expectedToken = typeof tokenEnv === "string" && tokenEnv ? process.env[tokenEnv] : undefined;
  const suppliedToken = parseBearerToken(request.headers.authorization);
  const origin = request.headers.origin;
  const allowedOrigins = new Set(config.server?.allowedOrigins ?? []);

  if (origin && !allowedOrigins.has(origin) && !tokensEqual(suppliedToken, expectedToken)) {
    throw new BridgeError("Browser-origin requests require an allowed origin or valid bearer token", { status: 403, code: "forbidden_origin" });
  }
  if (expectedToken && tokensEqual(suppliedToken, expectedToken)) return;
  if (loopback && config.server?.allowUnauthenticatedLoopback === true && !origin) return;
  if (!expectedToken) {
    throw new BridgeError(`Bridge authentication token is not configured; set ${tokenEnv ?? "CURSOR_BRIDGE_TOKEN"}`, { status: 503, code: "auth_not_configured" });
  }
  throw new BridgeError("Missing or invalid bearer token", { status: 401, code: "unauthorized" });
}

/**
 * Send the response to a CORS preflight only for explicitly allowed origins.
 * @param {import("node:http").IncomingMessage} request HTTP request.
 * @param {import("node:http").ServerResponse} response HTTP response.
 * @param {Record<string, any>} config Bridge configuration.
 */
function writeOptionsResponse(request, response, config) {
  const origin = request.headers.origin;
  if (!origin || !(config.server?.allowedOrigins ?? []).includes(origin)) {
    writeJson(response, 403, errorEnvelope("forbidden_origin", "Origin is not allowed"));
    return;
  }
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  response.end();
}

/**
 * Reflect an explicitly allowed browser origin on non-preflight responses.
 * @param {import("node:http").IncomingMessage} request HTTP request.
 * @param {import("node:http").ServerResponse} response HTTP response.
 * @param {Record<string, any>} config Bridge configuration.
 */
function applyCorsResponseHeaders(request, response, config) {
  const origin = request.headers.origin;
  if (!origin || !(config.server?.allowedOrigins ?? []).includes(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", appendVary(response.getHeader("vary"), "Origin"));
}

/** Append a token to a Vary header without duplicating it. */
function appendVary(existing, token) {
  const values = String(existing ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.some((value) => value.toLowerCase() === token.toLowerCase())) values.push(token);
  return values.join(", ");
}

/**
 * Normalize snake_case HTTP convenience fields to the service's camelCase input.
 * @param {Record<string, any>} body HTTP body.
 * @returns {Record<string, any>}
 */
function normalizeConvenienceHttpInput(body) {
  return {
    ...body,
    threadId: body.threadId ?? body.thread_id,
    timeoutMs: body.timeoutMs ?? body.timeout_ms,
    reasoningEffort: body.reasoningEffort ?? body.reasoning_effort,
    maxTurns: body.maxTurns ?? body.max_turns,
    expectedTurns: body.expectedTurns ?? body.expected_turns,
    noPlan: body.noPlan ?? body.no_plan,
    acceptanceCommands: body.acceptanceCommands ?? body.acceptance_commands,
    allowSubagents: body.allowSubagents ?? body.allow_subagents,
    allowWebSearch: body.allowWebSearch ?? body.allow_web_search,
    coordinatorId: body.coordinatorId ?? body.coordinator_id,
    workerGroup: body.workerGroup ?? body.worker_group,
  };
}

/**
 * Write a JSON HTTP response unless the stream is already closed.
 * @param {import("node:http").ServerResponse} response HTTP response.
 * @param {number} status HTTP status.
 * @param {unknown} body JSON body.
 */
function writeJson(response, status, body) {
  if (response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/**
 * Write a chunk and await drain when the kernel buffer is full.
 * @param {import("node:http").ServerResponse} response HTTP response.
 * @param {string} chunk Output chunk.
 * @returns {Promise<void>}
 */
async function writeWithBackpressure(response, chunk) {
  if (response.writableEnded || response.destroyed) return;
  if (response.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("error", onError);
      response.off("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); resolve(); };
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
  });
}

/**
 * Return an OpenAI-style error envelope.
 * @param {string} code Stable code.
 * @param {string} message Human-readable message.
 * @param {unknown} [details] Optional details.
 * @returns {Record<string, any>}
 */
function errorEnvelope(code, message, details) {
  return { error: { message, type: code, code, ...(details === undefined ? {} : { details }) } };
}

/**
 * Parse a bearer token from an Authorization header.
 * @param {string|undefined} authorization Authorization header.
 * @returns {string|undefined}
 */
function parseBearerToken(authorization) {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1];
}

/**
 * Compare credentials in constant time when both exist.
 * @param {string|undefined} supplied Supplied token.
 * @param {string|undefined} expected Expected token.
 * @returns {boolean}
 */
function tokensEqual(supplied, expected) {
  if (!supplied || !expected) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Identify IPv4/IPv6 loopback addresses, including IPv4-mapped IPv6.
 * @param {string} address Socket address.
 * @returns {boolean}
 */
export function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("127.") || address === "::ffff:127.0.0.1";
}

/**
 * FIFO concurrency gate used to bound provider pressure and local agent processes.
 */
class ConcurrencyGate {
  /** @param {number} limit Maximum concurrent holders. */
  constructor(limit) {
    this.limit = Math.max(1, Number(limit) || 1);
    this.active = 0;
    this.waiters = [];
  }

  /**
   * Acquire a slot and return an idempotent release callback.
   * @param {AbortSignal} [signal] Abort signal.
   * @returns {Promise<() => void>}
   */
  async acquire(signal) {
    if (signal?.aborted) throw signal.reason ?? new Error("Request aborted while queued");
    if (this.active < this.limit) {
      this.active += 1;
      return this.#releaseCallback();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason ?? new Error("Request aborted while queued"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * Construct one release callback and wake the next waiter.
   * @returns {() => void}
   */
  #releaseCallback() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(this.#releaseCallback());
      } else {
        this.active -= 1;
      }
    };
  }
}
