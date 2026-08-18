import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const DEFAULT_DESKTOP_INSPECT_PORT = 9224;

/** Build a ChatGPT Desktop launch plan with a loopback-only main-process inspector. */
export function createDesktopLaunchPlan({ platform = process.platform, executable, inspectPort = DEFAULT_DESKTOP_INSPECT_PORT } = {}) {
  const path = executable || discoverDesktopExecutable(platform);
  if (!path) throw new Error(`Could not locate ChatGPT Desktop for ${platform}; pass --app PATH`);
  return { command: path, args: [`--inspect=127.0.0.1:${inspectPort}`], options: { detached: true, stdio: "ignore", windowsHide: false } };
}

/** Render an isolated in-app HUD script containing sanitized state and no bearer token. */
export function renderDesktopHudScript(state = {}) {
  const routes = (Array.isArray(state.pickerRoutes) ? state.pickerRoutes : [])
    .filter((route) => route && typeof route.id === "string")
    .slice(0, 120)
    .map((route) => ({
      id: route.id,
      mode: route.mode ?? route.id.split("/")[0] ?? "consult",
      provider: route.provider ?? route.id.split("/")[1] ?? "provider",
      model: route.model ?? route.id.split("/").at(-1) ?? "auto",
      available: route.availability !== "unavailable",
      free: route.free === true,
    }));
  const payload = {
    routes,
    selected: state.desktopRouteSelection?.routeId ?? state.route?.id ?? "",
    providerCount: Array.isArray(state.providers) ? state.providers.length : state.routeMap?.nodes?.length ?? 0,
    status: state.status ?? "connecting",
  };
  return `(${mountDesktopHud.toString()})(${JSON.stringify(payload)})`;
}

/** Evaluate renderer code in the largest visible ChatGPT/Codex window. */
export function mainWindowEvaluationExpression(rendererCode) {
  return `(async()=>{const load=process.mainModule?.require?.bind(process.mainModule)??process.getBuiltinModule('module').createRequire(process.execPath);const electron=load('electron');const window=electron.BrowserWindow.getAllWindows().filter(item=>item.isVisible()).sort((left,right)=>{const a=left.getBounds(),b=right.getBounds();return b.width*b.height-a.width*a.height})[0];if(!window)throw new Error('No visible ChatGPT Desktop window');return await window.webContents.executeJavaScript(${JSON.stringify(rendererCode)},true)})()`;
}

export class DesktopHost {
  constructor(config, options = {}) {
    this.config = config;
    this.inspectPort = Number(options.inspectPort ?? DEFAULT_DESKTOP_INSPECT_PORT);
    this.appPath = options.appPath;
    this.baseUrl = `http://${formatHost(config.server.host)}:${config.server.port}`;
    this.token = options.token;
    this.pollIntervalMs = Math.max(1_000, Number(options.pollIntervalMs ?? 3_000));
    this.selectionPath = resolve(options.selectionPath ?? join(dirname(config.configPath), "state", "desktop-route.json"));
    this.selectedRouteId = null;
    this.launchProcess = options.launchProcess ?? spawn;
    this.client = null;
    this.lastStateDigest = "";
    this.lastError = "";
    this.tickCount = 0;
    this.lastFullState = null;
  }

  async run({ launch = false, signal } = {}) {
    this.token ??= await resolveDesktopToken(this.config);
    this.selectedRouteId = await readSelectedRoute(this.selectionPath);
    if (!this.token) throw new Error("Desktop HUD requires the owner token through the configured environment or owner-only token file");
    if (!(await inspectorAvailable(this.inspectPort))) {
      if (!launch) throw new Error("ChatGPT Desktop is not exposing the Threadspan attachment channel; use `threadspan desktop launch`");
      const plan = createDesktopLaunchPlan({ executable: this.appPath, inspectPort: this.inspectPort });
      const child = this.launchProcess(plan.command, plan.args, plan.options);
      child.once?.("error", (error) => { process.stderr.write(`Threadspan Desktop launch failed: ${error.message}\n`); });
      child.unref?.();
      await waitForInspector(this.inspectPort, 30_000);
    }
    while (!signal?.aborted) {
      try {
        this.client ??= await InspectorClient.connect(this.inspectPort);
        await this.#tick();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.lastError) process.stderr.write(`Threadspan Desktop: ${message}\n`);
        this.lastError = message;
        await this.client?.close().catch(() => {});
        this.client = null;
      }
      await abortableDelay(this.pollIntervalMs, signal);
    }
    await this.client?.close().catch(() => {});
  }

  async #tick() {
    let state = await this.#request("/v1/desktop/state", { timeoutMs: 5_000 });
    this.tickCount += 1;
    if (this.tickCount === 1 || this.tickCount % 10 === 0) {
      try { this.lastFullState = await this.#request("/threadspan/state", { timeoutMs: 5_000 }); } catch {}
    }
    if (this.lastFullState) state = this.lastFullState;
    if (this.selectedRouteId && state.desktopRouteSelection?.routeId !== this.selectedRouteId) {
      await this.#request("/v1/desktop/route", { method: "POST", body: { routeId: this.selectedRouteId } });
      state = await this.#request("/v1/desktop/state", { timeoutMs: 5_000 });
    }
    const digest = JSON.stringify({
      status: state.status,
      route: state.route?.id,
      selection: state.desktopRouteSelection?.routeId,
      routes: (state.pickerRoutes ?? []).slice(0, 120).map((route) => [route.id, route.availability]),
      providers: (state.routeMap?.nodes ?? []).map((provider) => [provider.id, provider.availability]),
    });
    const presence = await this.client.evaluate(mainWindowEvaluationExpression("({mounted:!!document.getElementById('threadspan-desktop-root'),action:document.getElementById('threadspan-desktop-root')?.dataset.threadspanAction||''})"));
    if (presence?.action) {
      await this.client.evaluate(mainWindowEvaluationExpression("(()=>{const host=document.getElementById('threadspan-desktop-root');if(host)delete host.dataset.threadspanAction;return true})()"));
      await this.#handleAction(JSON.parse(presence.action));
      return;
    }
    if (!presence?.mounted || digest !== this.lastStateDigest) {
      await this.client.evaluate(mainWindowEvaluationExpression(renderDesktopHudScript(state)));
      this.lastStateDigest = digest;
      this.lastError = "";
    }
  }

  async #handleAction(action) {
    if (action?.type !== "select-route" || typeof action.routeId !== "string") return;
    await this.#request("/v1/desktop/route", { method: "POST", body: { routeId: action.routeId } });
    this.selectedRouteId = action.routeId;
    await writeSelectedRoute(this.selectionPath, action.routeId);
    this.lastStateDigest = "";
  }

  async #request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      headers: { authorization: `Bearer ${this.token}`, ...(options.body ? { "content-type": "application/json" } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message ?? `Threadspan HTTP ${response.status}`);
    return body;
  }
}

class InspectorClient {
  static async connect(port) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.json());
    const target = targets.find((item) => item.type === "node" && item.webSocketDebuggerUrl) ?? targets.find((item) => item.webSocketDebuggerUrl);
    if (!target) throw new Error("Desktop main-process inspector is unavailable");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((accept, reject) => {
      const timeout = setTimeout(() => reject(new Error("Desktop inspector connection timed out")), 3_000);
      socket.onopen = () => { clearTimeout(timeout); accept(); };
      socket.onerror = (error) => { clearTimeout(timeout); reject(error); };
    });
    return new InspectorClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      pending(message);
    };
    socket.onclose = () => {
      for (const accept of this.pending.values()) accept({ result: { exceptionDetails: { text: "Desktop inspector disconnected" } } });
      this.pending.clear();
    };
  }

  async evaluate(expression) {
    const message = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (message.result?.exceptionDetails) throw new Error(message.result.exceptionDetails.text ?? "Desktop evaluation failed");
    return message.result?.result?.value;
  }

  call(method, params = {}) {
    return new Promise((accept, reject) => {
      const id = ++this.nextId;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`Desktop inspector timed out during ${method}`)); }, 10_000);
      this.pending.set(id, (message) => { clearTimeout(timeout); accept(message); });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() { this.socket.close(); }
}

function mountDesktopHud(data) {
  const previous = document.getElementById("threadspan-desktop-root");
  const wasOpen = previous?.dataset.open === "true";
  const mode = previous?.dataset.mode || "all";
  previous?.remove();
  const host = document.createElement("section");
  host.id = "threadspan-desktop-root";
  host.dataset.open = String(wasOpen);
  host.dataset.mode = mode;
  host.setAttribute("aria-label", "Threadspan");
  host.style.cssText = "position:fixed;z-index:2147483646;top:92px;left:50%;transform:translateX(-50%);width:min(430px,calc(100vw - 28px));font:12px/1.35 ui-sans-serif,system-ui;color:#eafdf8;pointer-events:auto";
  const root = host.attachShadow({ mode: "open" });
  const escape = (value) => String(value ?? "").replace(/[&<>\"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
  const render = () => {
    const routes = data.routes.filter((route) => host.dataset.mode === "all" || route.mode === host.dataset.mode);
    const selected = data.routes.find((route) => route.id === data.selected);
    root.innerHTML = `<style>*{box-sizing:border-box}button{font:inherit;color:inherit}.shell{border:1px solid rgba(65,220,186,.38);border-radius:14px;background:linear-gradient(145deg,rgba(7,24,23,.97),rgba(14,30,33,.96));box-shadow:0 16px 42px rgba(0,0,0,.38);backdrop-filter:blur(18px);overflow:hidden}.bar{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:9px 11px}.mark{width:9px;height:25px;border-radius:5px;background:linear-gradient(#55e6bc,#25a7b7)}.name{font-weight:780;letter-spacing:.08em}.meta{opacity:.72;margin-top:1px}.button,.tab,.route{border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.055);border-radius:9px;cursor:pointer}.button{padding:6px 9px}.panel{display:${host.dataset.open === "true" ? "block" : "none"};border-top:1px solid rgba(255,255,255,.09);padding:10px}.tabs{display:flex;gap:6px;margin-bottom:8px}.tab{padding:4px 8px;opacity:.72}.tab[data-active=true]{background:rgba(65,220,186,.14);opacity:1}.routes{display:grid;gap:5px;max-height:300px;overflow:auto}.route{display:grid;grid-template-columns:74px 1fr auto;gap:8px;text-align:left;padding:7px 8px}.route:hover{background:rgba(65,220,186,.1)}.route[data-selected=true]{border-color:rgba(65,220,186,.6);background:rgba(65,220,186,.13)}.route:disabled{opacity:.38;cursor:not-allowed}.mode{text-transform:uppercase;font-size:10px;letter-spacing:.08em;opacity:.65}.model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tag{font-size:10px;opacity:.66}.empty{padding:18px;text-align:center;opacity:.65}</style><div class="shell"><div class="bar"><span class="mark"></span><div><div class="name">THREADSPAN</div><div class="meta">${escape(data.status)} · ${data.providerCount} providers · ${selected ? escape(selected.provider+" / "+selected.model) : "auto"}</div></div><button class="button" data-toggle>${host.dataset.open === "true" ? "Close" : "Routes"}</button></div><div class="panel"><div class="tabs">${["all","consult","integrated","delegate"].map((item) => `<button class="tab" data-mode="${item}" data-active="${host.dataset.mode === item}">${item === "all" ? "All" : item[0].toUpperCase()+item.slice(1)}</button>`).join("")}</div><div class="routes">${routes.length ? routes.map((route) => `<button class="route" data-route="${escape(route.id)}" data-selected="${route.id === data.selected}" ${route.available ? "" : "disabled"}><span class="mode">${escape(route.mode)}</span><span class="model">${escape(route.provider)} · ${escape(route.model)}</span><span class="tag">${route.free ? "FREE" : route.available ? "READY" : "OFF"}</span></button>`).join("") : '<div class="empty">No routes match this view.</div>'}</div></div></div>`;
    root.querySelector("[data-toggle]").onclick = () => { host.dataset.open = String(host.dataset.open !== "true"); render(); };
    root.querySelectorAll("[data-mode]").forEach((button) => { button.onclick = () => { host.dataset.mode = button.dataset.mode; render(); }; });
    root.querySelectorAll("[data-route]").forEach((button) => { button.onclick = () => {
      data.selected = button.dataset.route;
      host.dataset.threadspanAction = JSON.stringify({ type: "select-route", routeId: button.dataset.route });
      render();
    }; });
  };
  render();
  document.body.append(host);
  return { mounted: true, routeCount: data.routes.length };
}

async function resolveDesktopToken(config) {
  if (config.server.authTokenFile && existsSync(resolve(config.server.authTokenFile))) {
    return (await readFile(resolve(config.server.authTokenFile), "utf8")).trim();
  }
  const envName = config.server.authTokenEnv;
  if (envName && process.env[envName]) return process.env[envName];
  const envFile = join(dirname(config.configPath), "secrets", "main.env");
  if (existsSync(envFile)) {
    const fallbackName = envName ?? "THREADSPAN_TOKEN";
    const line = (await readFile(envFile, "utf8")).split(/\r?\n/).find((item) => item.startsWith(`${fallbackName}=`));
    if (line) return line.slice(fallbackName.length + 1).replace(/^(["'])(.*)\1$/, "$2");
  }
  const candidates = [join(dirname(config.configPath), "secrets", "main.token")].map(resolve);
  for (const path of candidates) if (existsSync(path)) return (await readFile(path, "utf8")).trim();
  return null;
}

async function readSelectedRoute(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return typeof value?.routeId === "string" && value.routeId ? value.routeId : null;
  } catch { return null; }
}

async function writeSelectedRoute(path, routeId) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, routeId }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function discoverDesktopExecutable(platform) {
  if (process.env.THREADSPAN_CHATGPT_PATH) return process.env.THREADSPAN_CHATGPT_PATH;
  if (platform === "linux") return "/usr/bin/chatgpt";
  if (platform === "win32") {
    try {
      const script = "(Get-AppxPackage OpenAI.Codex).InstallLocation + '\\\\app\\\\ChatGPT.exe'";
      return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
    } catch { return null; }
  }
  if (platform === "darwin") return "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
  return null;
}

async function inspectorAvailable(port) { try { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })).ok; } catch { return false; } }

async function waitForInspector(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await inspectorAvailable(port)) return;
    await new Promise((accept) => setTimeout(accept, 250));
  }
  throw new Error("ChatGPT Desktop did not expose the Threadspan attachment channel; close it fully and retry `threadspan desktop launch`");
}

function abortableDelay(ms, signal) {
  return new Promise((accept) => {
    if (signal?.aborted) return accept();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); accept(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function formatHost(host) { return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; }
