import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { asBridgeError, BridgeError, RequestError } from "../core/errors.mjs";
import { CONNECTOR_TOOL_NAMES, dispatchMcpRequest } from "../mcp/server.mjs";
import { InstallerGuiController } from "../installer/gui-controller.mjs";
import { projectContinuityPublicResult, projectContinuityPublicView } from "../codex/continuity-controller.mjs";

/**
 * Create the local HTTP surface for Responses API, model discovery, health, Consult, and Delegate.
 * @param {import("./service.mjs").BridgeService} service Bridge service.
 * @param {Record<string, any>} config Validated bridge configuration.
 * @param {{installerGui?: InstallerGuiController}} [options] Testable runtime dependencies.
 * @returns {import("node:http").Server}
 */
export function createHttpServer(service, config, options = {}) {
  const gate = new ConcurrencyGate(config.server?.maxConcurrentRequests ?? 4);
  let installerGui = options.installerGui;
  const getInstallerGui = () => (installerGui ??= new InstallerGuiController(config));
  const authentication = resolveAuthentication(config);
  const mcpActiveRequests = new Map();
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
      if (url.pathname === "/threadspan/install/session" && request.method === "POST") {
        enforceRequestAuthentication(request, config, authentication);
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        writeJson(response, 201, await getInstallerGui().createSession(body));
        return;
      }
      if (url.pathname.startsWith("/threadspan/install/api/")) {
        if (!isLoopbackAddress(request.socket.remoteAddress ?? "")) throw new BridgeError("Installer GUI is loopback-only", { status: 403, code: "loopback_required" });
        const nonce = request.headers["x-threadspan-install-session"];
        const action = url.pathname.slice("/threadspan/install/api/".length);
        const activeInstallerGui = getInstallerGui();
        const installSession = activeInstallerGui.authorize(nonce);
        if (["complete", "cancelled"].includes(installSession.state)) {
          writeJson(response, 410, errorEnvelope("installer_session_closed", "The one-time installer session is already closed"));
          return;
        }
        if (request.method === "GET" && action === "bootstrap") {
          writeJson(response, 200, await activeInstallerGui.bootstrap(nonce, { signal: requestController.signal }));
          return;
        }
        if (request.method === "POST" && ["plan", "apply", "protect", "heartbeat", "close"].includes(action)) {
          const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
          const result = action === "plan" ? await activeInstallerGui.plan(nonce, body)
            : action === "apply" ? await activeInstallerGui.apply(nonce, body)
              : action === "protect" ? await activeInstallerGui.protect(nonce, body)
                : action === "heartbeat" ? await activeInstallerGui.heartbeat(nonce)
                : await activeInstallerGui.close(nonce, body.intent);
          writeJson(response, 200, result);
          return;
        }
        writeJson(response, 404, errorEnvelope("not_found", `No installer GUI action for ${request.method} ${action}`));
        return;
      }
      if (request.method === "GET" && (url.pathname === "/threadspan" || (url.pathname.startsWith("/threadspan/") && url.pathname !== "/threadspan/state"))) {
        if (!isLoopbackAddress(request.socket.remoteAddress ?? "")) {
          writeJson(response, 403, errorEnvelope("loopback_required", "Threadspan UI is available only from the local host"));
          return;
        }
        await handleThreadspanUiRequest(service, url.pathname, response, installerGui);
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Streamable HTTP MCP accepts POST requests"));
          return;
        }
        enforceConnectorAuthentication(request, config, authentication);
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        const mcpSessionId = String(request.headers["mcp-session-id"] ?? randomUUID());
        if (body.method === "notifications/cancelled") {
          mcpActiveRequests.get(mcpRequestKey(mcpSessionId, body.params?.requestId))?.abort(new Error(body.params?.reason ?? "MCP request cancelled"));
          response.writeHead(202, { "cache-control": "no-store", "mcp-session-id": mcpSessionId });
          response.end();
          return;
        }
        if (body.id === undefined && String(body.method ?? "").startsWith("notifications/")) {
          response.writeHead(202, { "cache-control": "no-store", "mcp-session-id": mcpSessionId });
          response.end();
          return;
        }
        const mcpController = new AbortController();
        const mcpKey = mcpRequestKey(mcpSessionId, body.id);
        if (mcpActiveRequests.has(mcpKey)) {
          writeMcpJson(response, {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32600, message: "Duplicate active JSON-RPC request id" },
          }, mcpSessionId);
          return;
        }
        const abortMcp = () => mcpController.abort(requestController.signal.reason ?? new Error("MCP HTTP request aborted"));
        requestController.signal.addEventListener("abort", abortMcp, { once: true });
        mcpActiveRequests.set(mcpKey, mcpController);
        try {
          release = await gate.acquire(mcpController.signal);
          const result = await dispatchMcpRequest(service, body.method, body.params ?? {}, mcpController.signal, {
            serverName: "threadspan",
            serverVersion: "0.5.0",
            allowedTools: CONNECTOR_TOOL_NAMES,
          });
          writeMcpJson(response, { jsonrpc: "2.0", id: body.id ?? null, result }, mcpSessionId);
        } catch (error) {
          const bridgeError = asBridgeError(error);
          writeMcpJson(response, {
            jsonrpc: "2.0",
            id: body.id ?? null,
            error: { code: -32000, message: bridgeError.message, data: { code: bridgeError.code, status: bridgeError.status, details: bridgeError.details } },
          }, mcpSessionId);
        } finally {
          requestController.signal.removeEventListener("abort", abortMcp);
          if (mcpActiveRequests.get(mcpKey) === mcpController) mcpActiveRequests.delete(mcpKey);
        }
        return;
      }
      if (url.pathname === "/v1/action-items" || url.pathname.startsWith("/v1/action-items/")) {
        enforceOwnerOnlyAuthentication(request, authentication, "Action items");
        if (request.method === "GET" && url.pathname === "/v1/action-items") {
          writeJson(response, 200, await service.actionItemsState(actionItemQuery(url.searchParams)));
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/action-items") {
          if ([...url.searchParams.keys()].length > 0) throw new RequestError("Action-item publication does not accept query parameters");
          const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
          writeJson(response, 201, await service.publishActionItem(body));
          return;
        }
        const completion = /^\/v1\/action-items\/([^/]+)\/complete$/.exec(url.pathname);
        if (request.method === "POST" && completion) {
          if ([...url.searchParams.keys()].length > 0) throw new RequestError("Action-item completion does not accept query parameters");
          const handle = decodeActionItemHandle(completion[1]);
          const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
          writeJson(response, 200, await service.completeActionItem(handle, body));
          return;
        }
        if (url.pathname === "/v1/action-items" || completion) {
          response.setHeader("allow", url.pathname === "/v1/action-items" ? "GET, POST" : "POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Action-item route uses its documented method only"));
          return;
        }
        writeJson(response, 404, errorEnvelope("not_found", "No action-item route matches this request"));
        return;
      }
      if (url.pathname.startsWith("/v1/maximum-utilization/")) {
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Maximum-utilization controls require POST"));
          return;
        }
        enforceAccountMutationAuthentication(request, authentication);
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        if (url.pathname === "/v1/maximum-utilization/refresh-native") {
          writeJson(response, 202, await service.refreshMaximumUtilizationNative());
        } else if (url.pathname === "/v1/maximum-utilization/disable") {
          writeJson(response, 200, await service.disableMaximumUtilization());
        } else if (url.pathname === "/v1/maximum-utilization/manual/enter") {
          writeJson(response, 200, await service.enterManualMaximumUtilization(body));
        } else if (url.pathname === "/v1/maximum-utilization/manual/leave") {
          writeJson(response, 200, await service.leaveManualMaximumUtilization());
        } else {
          writeJson(response, 404, errorEnvelope("not_found", `No maximum-utilization control for ${url.pathname}`));
        }
        return;
      }
      if (url.pathname === "/v1/continuity" || url.pathname.startsWith("/v1/continuity/")) {
        enforceAccountMutationAuthentication(request, authentication);
        if (request.method === "GET" && url.pathname === "/v1/continuity") {
          writeJson(response, 200, projectContinuityPublicView(await service.continuityState()));
          return;
        }
        if (request.method !== "POST") {
          response.setHeader("allow", "GET, POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Continuity controls require GET or POST"));
          return;
        }
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        if (url.pathname === "/v1/continuity/rename") writeJson(response, 200, projectContinuityPublicResult(await service.renameContinuityTask(body), "rename"));
        else if (url.pathname === "/v1/continuity/rollover/preview") writeJson(response, 200, projectContinuityPublicResult(await service.previewContinuityRollover(body), "preview"));
        else if (url.pathname === "/v1/continuity/rollover") writeJson(response, 202, projectContinuityPublicResult(await service.requestContinuityRollover(body), "rollover"));
        else writeJson(response, 404, errorEnvelope("not_found", `No Continuity control for ${url.pathname}`));
        return;
      }
      if (url.pathname === "/v1/automatic-takeover/disable") {
        enforceAccountMutationAuthentication(request, authentication);
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Automatic takeover controls require POST"));
          return;
        }
        await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        writeJson(response, 200, await service.disableAutomaticTakeover());
        return;
      }
      if (url.pathname === "/v1/copy/review") {
        enforceAccountMutationAuthentication(request, authentication);
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Copy review requires POST"));
          return;
        }
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        writeJson(response, 200, await service.reviewCopy(body));
        return;
      }
      if (url.pathname === "/v1/copy/check" || url.pathname === "/v1/copy/release-review") {
        enforceAccountMutationAuthentication(request, authentication);
        if (request.method !== "POST") {
          response.setHeader("allow", "POST");
          writeJson(response, 405, errorEnvelope("method_not_allowed", url.pathname === "/v1/copy/release-review" ? "Release copy review requires POST" : "External copy check requires POST"));
          return;
        }
        const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
        if (url.pathname === "/v1/copy/release-review") {
          writeJson(response, 200, await service.reviewReleaseCopy({ ...body, userStarted: true }));
        } else {
          writeJson(response, 200, await service.checkCopy(body));
        }
        return;
      }
      if (isAccountMutation(request.method, url.pathname)) {
        enforceAccountMutationAuthentication(request, authentication);
        if (request.method === "POST" && url.pathname === "/v1/accounts") {
          const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
          writeJson(response, 201, await service.createAccount(body));
          return;
        }
        if (request.method === "PUT" && url.pathname === "/v1/accounts/active") {
          const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
          writeJson(response, 200, await service.selectAccount(body.accountId ?? body.account_id));
          return;
        }
        if (request.method === "DELETE" && url.pathname.startsWith("/v1/accounts/")) {
          writeJson(response, 200, await service.removeAccount(decodeURIComponent(url.pathname.slice("/v1/accounts/".length))));
          return;
        }
      }
      if (url.pathname === "/v1/desktop/route") {
        enforceAccountMutationAuthentication(request, authentication);
        if (request.method === "GET") {
          writeJson(response, 200, service.desktopRouteState());
          return;
        }
        if (request.method === "POST") {
          const body = await readJsonBody(request, config.server?.maxBodyBytes ?? 8 * 1024 * 1024, requestController.signal);
          writeJson(response, 200, service.selectDesktopRoute(body));
          return;
        }
        response.setHeader("allow", "GET, POST");
        writeJson(response, 405, errorEnvelope("method_not_allowed", "Desktop route selection requires GET or POST"));
        return;
      }
      if (url.pathname === "/v1/desktop/state") {
        enforceOwnerOnlyAuthentication(request, authentication, "Desktop state");
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          writeJson(response, 405, errorEnvelope("method_not_allowed", "Desktop state requires GET"));
          return;
        }
        writeJson(response, 200, service.desktopState());
        return;
      }
      enforceRequestAuthentication(request, config, authentication);
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
      if (request.method === "GET" && ["/v1/accounts", "/v1/accounts/descriptors"].includes(url.pathname)) {
        const accounts = await service.describeAccounts();
        writeJson(response, 200, url.pathname.endsWith("/descriptors") ? { descriptors: accounts.descriptors } : accounts);
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

/** Authenticate the public connector with a scoped token that cannot access `/v1`. */
function enforceConnectorAuthentication(request, config, authentication) {
  const supplied = parseBearerToken(request.headers.authorization);
  const { main, connector } = authentication;
  if (tokensEqual(supplied, connector)) return;
  if (!main && !connector) throw new BridgeError("MCP connector authentication is not configured", { status: 503, code: "connector_auth_not_configured" });
  throw new BridgeError("Missing or invalid MCP connector bearer token", { status: 401, code: "connector_unauthorized" });
}

/** Account mutation is always owner-authenticated and loopback-only, even in permissive dev mode. */
function enforceAccountMutationAuthentication(request, authentication) {
  enforceOwnerOnlyAuthentication(request, authentication, "Account mutation");
}

/** Require the main owner token on loopback; connector tokens never authorize this surface. */
function enforceOwnerOnlyAuthentication(request, authentication, label) {
  if (!isLoopbackAddress(request.socket.remoteAddress ?? "")) throw new BridgeError(`${label} is loopback-only`, { status: 403, code: "loopback_required" });
  if (!authentication.main) throw new BridgeError(`Main authentication is not configured for ${label.toLowerCase()}`, { status: 503, code: "auth_not_configured" });
  if (!tokensEqual(parseBearerToken(request.headers.authorization), authentication.main)) throw new BridgeError(`Missing or invalid owner bearer token for ${label.toLowerCase()}`, { status: 401, code: "unauthorized" });
}

function isAccountMutation(method, pathname) {
  return (method === "POST" && pathname === "/v1/accounts")
    || (method === "PUT" && pathname === "/v1/accounts/active")
    || (method === "DELETE" && pathname.startsWith("/v1/accounts/") && pathname !== "/v1/accounts/active");
}

function actionItemQuery(searchParams) {
  const allowed = new Set(["scope", "projectKey", "status", "filter", "sort", "limit"]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) throw new RequestError("Action-item query contains unsupported or repeated parameters");
  }
  const result = {};
  const scope = searchParams.get("scope");
  const projectKey = searchParams.get("projectKey");
  const status = searchParams.get("status");
  const filter = searchParams.get("filter");
  const sort = searchParams.get("sort");
  const limit = searchParams.get("limit");
  if (scope !== null) {
    if (!["all", "global", "project"].includes(scope)) throw new RequestError("Action-item scope is invalid");
    result.scope = scope;
  }
  if (projectKey !== null) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(projectKey)) throw new RequestError("Action-item project key is invalid");
    result.projectKey = projectKey;
  }
  if (scope === "project" && projectKey === null) throw new RequestError("Project scope requires a project key");
  if (scope === "global" && projectKey !== null) throw new RequestError("Global scope cannot include a project key");
  if (status !== null) {
    if (!["open", "completed", "stale", "closed"].includes(status)) throw new RequestError("Action-item status is invalid");
    result.status = status;
  }
  if (filter !== null) {
    if (!filter.trim() || filter.length > 160 || /[\u0000-\u001f\u007f]/.test(filter)) throw new RequestError("Action-item filter is invalid");
    result.filter = filter.trim();
  }
  if (sort !== null) {
    if (!["updated-desc", "updated-asc", "created-desc", "created-asc", "title-asc", "title-desc"].includes(sort)) {
      throw new RequestError("Action-item sort is invalid");
    }
    result.sort = sort;
  }
  if (limit !== null) {
    if (!/^[1-9][0-9]{0,2}$/.test(limit) || Number(limit) > 500) throw new RequestError("Action-item limit is invalid");
    result.limit = Number(limit);
  }
  return result;
}

function decodeActionItemHandle(value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new RequestError("Action-item handle encoding is invalid");
  }
  if (!/^act_[0-9a-f]{32}$/.test(decoded)) throw new RequestError("Action-item handle is invalid");
  return decoded;
}

/** Preserve JSON-RPC request id type within an MCP session. */
function mcpRequestKey(sessionId, requestId) {
  return `${sessionId}:${requestId === null ? "null" : typeof requestId}:${JSON.stringify(requestId)}`;
}

function writeMcpJson(response, body, sessionId) {
  if (response.writableEnded) return;
  const text = JSON.stringify(body);
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    "mcp-protocol-version": "2025-11-25",
    "mcp-session-id": sessionId,
  });
  response.end(text);
}

const THREADSPAN_ASSETS = new Map([
  ["/threadspan/", ["index.html", "text/html; charset=utf-8"]],
  ["/threadspan/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/threadspan/threadspan.css", ["threadspan.css", "text/css; charset=utf-8"]],
  ["/threadspan/threadspan.js", ["threadspan.js", "text/javascript; charset=utf-8"]],
  ["/threadspan/adapt-state.js", ["adapt-state.js", "text/javascript; charset=utf-8"]],
  ["/threadspan/mark.svg", ["mark.svg", "image/svg+xml"]],
  ["/threadspan/install/", ["install.html", "text/html; charset=utf-8"]],
  ["/threadspan/install/index.html", ["install.html", "text/html; charset=utf-8"]],
  ["/threadspan/install/install.css", ["install.css", "text/css; charset=utf-8"]],
  ["/threadspan/install/install.js", ["install.js", "text/javascript; charset=utf-8"]],
]);

async function handleThreadspanUiRequest(service, pathname, response, installerGui) {
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
  if (pathname.startsWith("/threadspan/install/") && !hasActiveInstallerSession(installerGui)) {
    writeJson(response, 404, errorEnvelope("not_found", "The one-time installer UI is available only during an active installation session"));
    return;
  }
  const [name, contentType] = asset;
  const body = await readFile(new URL(`../../ui/${name}`, import.meta.url));
  response.writeHead(200, { "content-type": contentType, "content-length": body.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

/** Keep installer-only assets outside the normal daemon UI once setup completes or expires. */
function hasActiveInstallerSession(installerGui) {
  if (!installerGui) return false;
  for (const [nonce, session] of installerGui.sessions ?? []) {
    if (["complete", "cancelled"].includes(session.state)) continue;
    try {
      installerGui.authorize(nonce);
      return true;
    } catch {}
  }
  return false;
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
function enforceRequestAuthentication(request, config, authentication) {
  const remoteAddress = request.socket.remoteAddress ?? "";
  const loopback = isLoopbackAddress(remoteAddress);
  const tokenEnv = config.server?.authTokenEnv;
  const expectedToken = authentication.main;
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

function resolveAuthentication(config) {
  const tokenEnv = config.server?.authTokenEnv;
  const connectorEnv = config.server?.connectorTokenEnv;
  if (tokenEnv && connectorEnv && tokenEnv === connectorEnv) throw new Error("server.authTokenEnv and server.connectorTokenEnv must differ");
  let main = tokenEnv ? process.env[tokenEnv] : undefined;
  if (!main && config.server?.authTokenFile) {
    try { main = readFileSync(config.server.authTokenFile, "utf8").trim(); } catch {}
  }
  let connector = connectorEnv ? process.env[connectorEnv] : undefined;
  if (!connector && config.server?.connectorTokenFile) {
    try { connector = readFileSync(config.server.connectorTokenFile, "utf8").trim(); } catch {}
  }
  if (main && connector && tokensEqual(main, connector)) throw new Error("Main and connector tokens must be distinct");
  return Object.freeze({ main, connector });
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
    scope: body.scope ?? body.bridge_scope,
    allowedPaths: body.allowedPaths ?? body.allowed_paths,
    deniedPaths: body.deniedPaths ?? body.denied_paths,
    nonGoals: body.nonGoals ?? body.non_goals,
    allowSubagents: body.allowSubagents ?? body.allow_subagents,
    allowWebSearch: body.allowWebSearch ?? body.allow_web_search,
    coordinatorId: body.coordinatorId ?? body.coordinator_id,
    workerGroup: body.workerGroup ?? body.worker_group,
    accountId: body.accountId ?? body.account_id,
    accountFallback: body.accountFallback ?? body.account_fallback,
    continuityHandoff: body.continuityHandoff ?? body.continuity_handoff,
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
