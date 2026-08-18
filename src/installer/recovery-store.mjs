import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ORIGIN_KINDS = new Set(["codex", "grok", "cursor", "hermes", "direct"]);

export class InstallerRecoveryStore {
  constructor(options = {}) {
    if (typeof options.root !== "string" || !options.root) throw new TypeError("recovery store root is required");
    this.root = resolve(options.root);
    this.tail = Promise.resolve();
  }

  async create(record) {
    validateRecord(record);
    const next = {
      schemaVersion: 1,
      sessionId: record.sessionId,
      state: "launched",
      origin: sanitizeOrigin(record.origin),
      selectedComponents: [],
      planDigest: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      donationShownAt: null,
    };
    return this.#serialized(() => this.#write(next));
  }

  async update(sessionId, patch) {
    validateId(sessionId);
    return this.#serialized(async () => {
      const current = await this.read(sessionId);
      const allowed = pick(patch, ["state", "selectedComponents", "planDigest", "result", "closeIntent", "lastHeartbeatAt", "notificationClaimedAt", "notificationSentAt", "donationShownAt"]);
      const next = { ...current, ...allowed, updatedAt: new Date().toISOString() };
      return this.#write(next);
    });
  }

  async read(sessionId) {
    validateId(sessionId);
    const text = await readFile(this.#path(sessionId), "utf8");
    const record = JSON.parse(text);
    validateRecord(record);
    return record;
  }

  async list(options = {}) {
    const limit = Math.min(512, Math.max(1, options.limit ?? 256));
    let names;
    try { names = await readdir(this.root); } catch (error) { if (error?.code === "ENOENT") return []; throw error; }
    const records = [];
    for (const name of names.filter((value) => /^install-[A-Za-z0-9._-]+\.json$/.test(value)).sort().slice(-limit)) {
      const path = resolve(this.root, name);
      const stats = await lstat(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 64 * 1024) continue;
      try { records.push(await this.read(name.slice(0, -5))); } catch {}
    }
    return records;
  }

  /** Atomically claim the one donation-card display allowed for an installer session. */
  async claimDonation(sessionId) {
    validateId(sessionId);
    return this.#serialized(async () => {
      const current = await this.read(sessionId);
      if (current.donationShownAt) return false;
      const now = new Date().toISOString();
      await this.#write({ ...current, donationShownAt: now, updatedAt: now });
      return true;
    });
  }

  #serialized(operation) {
    const next = this.tail.then(operation, operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  async #write(record) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const target = this.#path(record.sessionId);
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    return record;
  }

  #path(sessionId) {
    return resolve(this.root, `${sessionId}.json`);
  }
}

function validateRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new TypeError("recovery record must be an object");
  validateId(record.sessionId);
  if (record.origin !== undefined) sanitizeOrigin(record.origin);
}

function sanitizeOrigin(origin = { kind: "direct" }) {
  const kind = origin.kind ?? "direct";
  if (!ORIGIN_KINDS.has(kind)) throw new TypeError(`Unsupported origin kind '${kind}'`);
  const id = origin.id == null ? null : String(origin.id);
  if (id !== null && id.length > 256) throw new TypeError("origin id is too long");
  return { kind, id, project: origin.project == null ? null : String(origin.project).slice(0, 512) };
}

function validateId(id) {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new TypeError("invalid recovery session id");
}

function pick(value, keys) {
  const result = {};
  if (!value || typeof value !== "object") return result;
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key];
  return result;
}
