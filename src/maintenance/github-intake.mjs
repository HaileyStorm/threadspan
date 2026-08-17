import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 100;

/** Read-only public GitHub compatibility intake. It never checks out or executes contributor code. */
export class GitHubCompatibilityIntake {
  constructor(options = {}) {
    this.repository = options.repository ?? "HaileyStorm/threadspan";
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(this.repository)) throw new TypeError("repository must be owner/name");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.environment = options.environment ?? process.env;
    this.tokenEnv = options.tokenEnv ?? "GITHUB_TOKEN";
    this.statePath = resolve(options.statePath ?? join(homedir(), ".threadspan", "compatibility-intake", "state.json"));
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 15_000, 1_000, 60_000, "timeoutMs");
    this.maxItems = boundedInteger(options.maxItems ?? MAX_ITEMS, 1, MAX_ITEMS, "maxItems");
  }

  async poll() {
    const previous = await readState(this.statePath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("GitHub compatibility intake timed out")), this.timeoutMs);
    timeout.unref?.();
    const headers = { accept: "application/vnd.github+json", "user-agent": "threadspan-compatibility-intake" };
    if (previous.etag) headers["if-none-match"] = previous.etag;
    const token = this.environment[this.tokenEnv];
    if (token) headers.authorization = `Bearer ${token}`;
    try {
      const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}/issues?state=open&labels=compatibility&sort=updated&direction=desc&per_page=100`, { headers, signal: controller.signal });
      if (response.status === 304) return { ...previous, status: "unchanged", checkedAt: new Date().toISOString() };
      if (!response.ok) throw new Error(`GitHub compatibility intake returned HTTP ${response.status}`);
      const text = await response.text();
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("GitHub compatibility intake response exceeded 2097152 bytes");
      const body = JSON.parse(text);
      if (!Array.isArray(body)) throw new TypeError("GitHub compatibility intake response was not an array");
      const items = body.slice(0, this.maxItems).map(sanitizeItem).filter(Boolean);
      const state = {
        schemaVersion: 1,
        repository: this.repository,
        status: "ok",
        checkedAt: new Date().toISOString(),
        etag: response.headers.get("etag") ?? undefined,
        items,
        counts: { issues: items.filter((item) => item.kind === "issue").length, pullRequests: items.filter((item) => item.kind === "pull-request").length },
        policy: "read-only-metadata-no-checkout-no-execution",
      };
      await atomicWrite(this.statePath, state);
      return state;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function sanitizeItem(item) {
  if (!item || typeof item !== "object" || !Number.isSafeInteger(item.number)) return null;
  return {
    number: item.number,
    kind: item.pull_request ? "pull-request" : "issue",
    title: boundedText(item.title, 240),
    url: /^https:\/\/github\.com\//.test(item.html_url ?? "") ? item.html_url : "",
    state: item.state === "open" ? "open" : "unknown",
    updatedAt: boundedText(item.updated_at, 40),
    author: boundedText(item.user?.login, 80),
    labels: Array.isArray(item.labels) ? item.labels.map((label) => boundedText(label?.name ?? label, 80)).filter(Boolean).slice(0, 20) : [],
  };
}

async function readState(path) {
  try {
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return {};
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function boundedText(value, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.slice(0, maximum).replace(/[\u0000-\u001f\u007f]/gu, " ");
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be from ${minimum} to ${maximum}`);
  return value;
}
