import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Append-only JSONL ledger for provider worker lifecycle, usage, and bounded evidence records. */
export class RunLedger {
  /**
   * @param {{
   *   providerId: string,
   *   path?: string,
   *   enabled?: boolean,
   *   required?: boolean,
   *   includeOutput?: boolean,
   *   evidenceDirectory?: string,
   *   logger?: any,
   * }} options Ledger options.
   */
  constructor(options) {
    this.providerId = options.providerId;
    this.enabled = options.enabled !== false;
    this.required = options.required === true;
    this.includeOutput = options.includeOutput === true;
    this.path = this.enabled ? resolveLedgerPath(options.path, options.providerId) : undefined;
    this.evidenceDirectory = this.enabled && this.includeOutput
      ? resolveEvidenceDirectory(options.evidenceDirectory, options.providerId)
      : undefined;
    this.logger = options.logger;
    this.tail = Promise.resolve();
  }

  /**
   * Append one lifecycle record in call order.
   * @param {Record<string, any>} record Record without timestamp/provider defaults.
   * @returns {Promise<void>}
   */
  append(record) {
    if (!this.enabled || !this.path) return Promise.resolve();
    const payload = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      provider: this.providerId,
      ...record,
    };
    const operation = this.tail.then(() => appendJsonLine(this.path, payload));
    this.tail = operation.catch(() => undefined);
    return operation.catch((error) => this.#handleFailure("append provider run ledger", error));
  }

  /**
   * Hash prompt/stdout/stderr and optionally persist the raw evidence in a private JSON file.
   * @param {string} jobId Stable job id.
   * @param {{prompt?: string, stdout?: string, stderr?: string, metadata?: Record<string, any>}} evidence Evidence content.
   * @returns {Promise<{promptSha256?: string, stdoutSha256?: string, stderrSha256?: string, evidencePath?: string}>}
   */
  async captureEvidence(jobId, evidence) {
    const result = {
      ...(evidence.prompt === undefined ? {} : { promptSha256: sha256Text(evidence.prompt) }),
      ...(evidence.stdout === undefined ? {} : { stdoutSha256: sha256Text(evidence.stdout) }),
      ...(evidence.stderr === undefined ? {} : { stderrSha256: sha256Text(evidence.stderr) }),
    };
    if (!this.enabled || !this.includeOutput || !this.evidenceDirectory) return result;

    const path = join(this.evidenceDirectory, `${sanitizeFileSegment(jobId)}.json`);
    try {
      await mkdir(this.evidenceDirectory, { recursive: true, mode: 0o700 });
      await writeFile(path, `${JSON.stringify({
        schemaVersion: 1,
        timestamp: new Date().toISOString(),
        provider: this.providerId,
        jobId,
        ...evidence,
      }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      return { ...result, evidencePath: path };
    } catch (error) {
      await this.#handleFailure("persist provider run evidence", error);
      return result;
    }
  }

  /** Wait for all queued ledger writes. */
  async flush() {
    await this.tail;
  }

  /** Log optional ledger failures or rethrow when evidence is configured as required. */
  async #handleFailure(operation, error) {
    this.logger?.warn(`Could not ${operation}`, {
      provider: this.providerId,
      path: this.path,
      error: error instanceof Error ? error.message : String(error),
    });
    if (this.required) throw error;
  }
}

/** Resolve an explicit, home-relative, or default ledger path. */
export function resolveLedgerPath(configuredPath, providerId) {
  if (typeof configuredPath === "string" && configuredPath.length > 0) return resolve(expandHomePath(configuredPath));
  return join(homedir(), ".cursor-codex-bridge", "ledgers", `${providerId}.jsonl`);
}

/** Resolve an explicit or default raw-evidence directory. */
export function resolveEvidenceDirectory(configuredPath, providerId) {
  if (typeof configuredPath === "string" && configuredPath.length > 0) return resolve(expandHomePath(configuredPath));
  return join(homedir(), ".cursor-codex-bridge", "evidence", providerId);
}

/** Return a non-reversible short identity for a workspace path without storing the path itself. */
export function workspacePathFingerprint(workspace) {
  if (!workspace) return undefined;
  return sha256Text(resolve(String(workspace))).slice(0, 20);
}

/** Return a SHA-256 digest for text evidence. */
export function sha256Text(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

/** Append one JSON record with private file/directory modes where supported. */
async function appendJsonLine(path, payload) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.appendFile(`${JSON.stringify(payload)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Expand a home-relative configured path. */
function expandHomePath(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** Keep evidence filenames portable and non-empty. */
function sanitizeFileSegment(value) {
  const rendered = String(value ?? "job").replace(/[^A-Za-z0-9._-]/g, "_");
  return rendered || "job";
}
