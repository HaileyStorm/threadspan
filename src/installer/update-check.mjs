import { createHash, createPrivateKey, createPublicKey, verify as verifySignature } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { runCapturedProcess } from "../core/managed-process.mjs";

export const OFFICIAL_REPOSITORY = "HaileyStorm/threadspan";
export const OFFICIAL_REPOSITORY_URL = `https://github.com/${OFFICIAL_REPOSITORY}`;
export const RELEASE_PUBLIC_KEY_RELATIVE_PATH = "src/installer/release-signing-public-key.pem";
const RELEASES_API = `https://api.github.com/repos/${OFFICIAL_REPOSITORY}/releases?per_page=30`;
const OFFICIAL_GIT_REMOTES = new Set([
  `${OFFICIAL_REPOSITORY_URL}.git`,
  `git@github.com:${OFFICIAL_REPOSITORY}.git`,
  `ssh://git@github.com/${OFFICIAL_REPOSITORY}.git`,
]);
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 4096;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 30_000;
export const MAX_EXPANDED_RELEASE_BYTES = 128 * 1024 * 1024;
const MAX_INFLATED_TAR_BYTES = MAX_EXPANDED_RELEASE_BYTES + (MAX_ARCHIVE_ENTRIES * 1024) + 1024;
const KEY_MATERIAL_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx", ".crt", ".cer"];
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const GUI_ASSETS = ["ui/install.html", "ui/install.css", "ui/install.js", "ui/mark.svg"];
export const RELEASE_PUBLIC_KEY_PATH = fileURLToPath(new URL("./release-signing-public-key.pem", import.meta.url));
const DEFAULT_TIMEOUTS = Object.freeze({
  releaseDiscoveryMs: 15_000,
  manifestDownloadMs: 30_000,
  signatureDownloadMs: 30_000,
  archiveDownloadMs: 5 * 60_000,
  archiveListingMs: 60_000,
  archiveExtractionMs: 2 * 60_000,
});

/**
 * Check the official stable release and safely prepare it before installer component selection.
 */
export class InstallerStableUpdater {
  constructor(options = {}) {
    this.currentRoot = resolve(options.currentRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
    this.ownerRoot = resolve(options.ownerRoot ?? homedir());
    this.stagingRoot = resolve(options.stagingRoot ?? join(this.ownerRoot, ".threadspan", "staging", "releases"));
    assertWithin(this.ownerRoot, this.stagingRoot, "Release staging root");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.download = options.download ?? downloadAsset;
    this.inspectArchive = options.inspectArchive ?? inspectReleaseArchive;
    this.extractArchive = options.extractArchive ?? extractTarArchive;
    this.runGit = options.runGit ?? runGit;
    this.runCommand = options.runCommand ?? runCommand;
    this.relaunch = options.relaunch;
    this.now = options.now ?? (() => new Date());
    this.releasePublicKey = options.releasePublicKey;
    this.readReleasePublicKey = options.readReleasePublicKey ?? (() => loadReleasePublicKey());
    this.timeouts = normalizeTimeouts(options.timeouts);
  }

  /**
   * Return a user-presentable status. A verified newer release is prepared and relaunched.
   * Network and update failures leave the current installation usable.
   */
  async checkAndUpdate(context = {}) {
    const currentRoot = context.currentRoot ? resolve(context.currentRoot) : this.currentRoot;
    let current;
    try {
      current = await readThreadspanIdentity(currentRoot);
    } catch (error) {
      return blocked("current-identity-invalid", error, { canContinueCurrent: true });
    }

    let release;
    try {
      release = await runBoundedPhase("release-discovery", this.timeouts.releaseDiscoveryMs, context.signal, (signal) => (
        fetchLatestStableRelease({ fetchImpl: this.fetchImpl, signal })
      ));
    } catch (error) {
      return unavailable(error, current.version);
    }

    const latestVersion = versionFromTag(release.tag_name);
    if (compareVersions(latestVersion, current.version) <= 0) {
      return {
        status: "current",
        currentVersion: current.version,
        latestVersion,
        releaseUrl: release.html_url,
        canContinueCurrent: true,
        retryable: true,
        message: `Threadspan ${current.version} is the latest stable release.`,
      };
    }

    let source;
    try {
      source = await inspectSource(currentRoot, this.runGit);
    } catch (error) {
      return blocked("source-inspection-failed", error, versions(current.version, latestVersion));
    }

    if (source.kind === "git") {
      if (!isOfficialGitRemote(source.remote)) {
        return blocked("unexpected-git-remote", "The checkout origin is not the exact official Threadspan repository.", {
          ...versions(current.version, latestVersion),
          sourceKind: "git",
        });
      }
      if (source.dirty) {
        return blocked("dirty-checkout", "The official checkout has local changes; it was not fetched or modified.", {
          ...versions(current.version, latestVersion),
          sourceKind: "git",
        });
      }
      return this.#fastForwardOfficialCheckout(currentRoot, release, current.version, context);
    }

    return this.#stageReleaseBundle(release, current.version, context);
  }

  async #fastForwardOfficialCheckout(currentRoot, release, currentVersion, context) {
    const latestVersion = versionFromTag(release.tag_name);
    const tagRef = `refs/tags/${release.tag_name}`;
    let currentChanged = false;
    try {
      throwIfAborted(context.signal);
      await this.runGit(["fetch", "--no-tags", "origin", `${tagRef}:${tagRef}`], { cwd: currentRoot, signal: context.signal });
      const rechecked = await inspectSource(currentRoot, this.runGit);
      if (rechecked.kind !== "git" || !isOfficialGitRemote(rechecked.remote) || rechecked.dirty) {
        throw new Error("Checkout identity or cleanliness changed after fetch; fast-forward was cancelled");
      }
      await validateGitTag(this.runGit, currentRoot, tagRef, latestVersion, context.signal);
      await this.runGit(["merge-base", "--is-ancestor", "HEAD", tagRef], { cwd: currentRoot, signal: context.signal });
      await this.runGit(["merge", "--ff-only", tagRef], { cwd: currentRoot, signal: context.signal });
      currentChanged = true;
      await validateThreadspanReleaseRoot(currentRoot, latestVersion);
      return await this.#relaunchVerified(currentRoot, currentVersion, latestVersion, release, context, "git-fast-forward");
    } catch (error) {
      return blocked("git-fast-forward-failed", error, {
        ...versions(currentVersion, latestVersion),
        sourceKind: "git",
        currentChanged,
      });
    }
  }

  async #stageReleaseBundle(release, currentVersion, context) {
    const latestVersion = versionFromTag(release.tag_name);
    let temporaryRoot;
    try {
      const assets = selectReleaseAssets(release, latestVersion);
      await ensureOwnerLocalDirectory(this.ownerRoot, this.stagingRoot);
      temporaryRoot = await mkdtemp(join(this.stagingRoot, `.threadspan-${latestVersion}-partial-`));
      const archivePath = join(temporaryRoot, assets.archive.name);
      const manifestPath = join(temporaryRoot, assets.manifest.name);
      const signaturePath = join(temporaryRoot, assets.signature.name);
      await runBoundedPhase("manifest-download", this.timeouts.manifestDownloadMs, context.signal, (signal) => this.download(
        assets.manifest.browser_download_url,
        manifestPath,
        { fetchImpl: this.fetchImpl, maxBytes: MAX_MANIFEST_BYTES, signal },
      ));
      await runBoundedPhase("signature-download", this.timeouts.signatureDownloadMs, context.signal, (signal) => this.download(
        assets.signature.browser_download_url,
        signaturePath,
        { fetchImpl: this.fetchImpl, maxBytes: MAX_SIGNATURE_BYTES, signal },
      ));
      const manifestBytes = await readStableRegularFile(manifestPath, MAX_MANIFEST_BYTES);
      const signatureBytes = await readStableRegularFile(signaturePath, MAX_SIGNATURE_BYTES);
      let publicKey;
      try {
        publicKey = this.releasePublicKey ?? await this.readReleasePublicKey();
      } catch {
        throw updateError("publisher-authenticity-failed", "Release publisher authenticity could not be proven: pinned public key is unavailable");
      }
      verifyChecksumManifestSignature(manifestBytes, signatureBytes, publicKey);
      const expected = parseChecksumManifest(manifestBytes.toString("utf8"), assets.archive.name);
      const authenticatedSourceCommit = parseSignedReleaseSourceCommit(manifestBytes.toString("utf8"));

      await runBoundedPhase("archive-download", this.timeouts.archiveDownloadMs, context.signal, (signal) => this.download(
        assets.archive.browser_download_url,
        archivePath,
        { fetchImpl: this.fetchImpl, maxBytes: MAX_BUNDLE_BYTES, signal },
      ));
      const archiveBytes = await readStableRegularFile(archivePath, MAX_BUNDLE_BYTES);
      const actual = sha256(archiveBytes);
      if (actual !== expected) throw updateError("checksum-mismatch", "Downloaded release bundle failed SHA-256 verification");

      const expectedRootName = `threadspan-${latestVersion}`;
      await runBoundedPhase("archive-listing", this.timeouts.archiveListingMs, context.signal, (signal) => this.inspectArchive(
        archiveBytes,
        { expectedRootName, runCommand: this.runCommand, signal },
      ));
      const unpacked = join(temporaryRoot, "unpacked");
      await mkdir(unpacked, { mode: 0o700 });
      await runBoundedPhase("archive-extraction", this.timeouts.archiveExtractionMs, context.signal, (signal) => this.extractArchive(
        archiveBytes,
        unpacked,
        { runCommand: this.runCommand, signal },
      ));
      const extractedRoot = await findExtractedRoot(unpacked, expectedRootName);
      await validateThreadspanReleaseRoot(extractedRoot, latestVersion, { extracted: true });

      const finalRoot = join(this.stagingRoot, `threadspan-${latestVersion}-${actual.slice(0, 12)}`);
      try {
        await lstat(finalRoot);
        throw updateError("staging-exists", "Verified release staging destination already exists; it was not overwritten");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(extractedRoot, finalRoot);
      if (authenticatedSourceCommit) {
        await Promise.all([
          writeFile(join(finalRoot, ".threadspan-release.tar.gz"), archiveBytes, { flag: "wx", mode: 0o600 }),
          writeFile(join(finalRoot, ".threadspan-release.SHA256SUMS"), manifestBytes, { flag: "wx", mode: 0o600 }),
          writeFile(join(finalRoot, ".threadspan-release.SHA256SUMS.sig"), signatureBytes, { flag: "wx", mode: 0o600 }),
        ]);
      }
      await writeFile(join(finalRoot, ".threadspan-release.json"), `${JSON.stringify({
        schemaVersion: authenticatedSourceCommit ? 2 : 1,
        repository: OFFICIAL_REPOSITORY,
        version: latestVersion,
        tag: release.tag_name,
        bundleSha256: actual,
        ...(authenticatedSourceCommit ? {
          provenanceKind: "publisher-signed-release-manifest",
          sourceCommit: authenticatedSourceCommit,
          signedManifestSha256: sha256(manifestBytes),
        } : {}),
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rm(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = undefined;
      return await this.#relaunchVerified(finalRoot, currentVersion, latestVersion, release, context, "verified-release-bundle", {
        sourceCommit: authenticatedSourceCommit,
      });
    } catch (error) {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
      return blocked(error?.updateCode ?? "release-staging-failed", error, {
        ...versions(currentVersion, latestVersion),
        sourceKind: "release-bundle",
      });
    }
  }

  async #relaunchVerified(root, currentVersion, latestVersion, release, context, sourceKind, provenance = {}) {
    if (typeof this.relaunch !== "function") {
      return blocked("relaunch-unavailable", "The verified release is ready, but no installer relaunch controller is available.", {
        ...versions(currentVersion, latestVersion),
        sourceKind,
      });
    }
    try {
      throwIfAborted(context.signal);
      const verifiedAssets = await hashVerifiedGuiAssets(root);
      const resumeCapsule = createResumeCapsule({
        sessionId: context.sessionId,
        nonce: context.nonce,
        installRoot: context.installRoot,
        fromVersion: currentVersion,
        toVersion: latestVersion,
        issuedAt: this.now().toISOString(),
      });
      const launched = await this.relaunch({
        stagedRoot: root,
        daemonBaseUrl: context.daemonBaseUrl,
        browserPath: context.browserPath,
        resumeCapsule,
        verifiedAssets,
      });
      return {
        status: "relaunching",
        currentVersion,
        latestVersion,
        sourceKind,
        releaseUrl: release.html_url,
        canContinueCurrent: false,
        retryable: false,
        message: `Verified Threadspan ${latestVersion}; opening the updated setup window.`,
        relaunchPid: launched?.pid,
        preparedRoot: root,
        ...(provenance.sourceCommit ? { sourceCommit: provenance.sourceCommit } : {}),
      };
    } catch (error) {
      return blocked("relaunch-failed", error, {
        ...versions(currentVersion, latestVersion),
        sourceKind,
        currentChanged: sourceKind === "git-fast-forward",
      });
    }
  }
}

/** Select the highest strict major.minor.patch release, excluding drafts and prereleases. */
export function selectLatestStableRelease(releases) {
  const stable = (Array.isArray(releases) ? releases : [])
    .filter((release) => release && release.draft !== true && release.prerelease !== true && isStableTag(release.tag_name))
    .filter(isOfficialRelease)
    .sort((left, right) => compareVersions(versionFromTag(right.tag_name), versionFromTag(left.tag_name)));
  if (stable.length === 0) throw updateError("no-stable-release", "GitHub did not return an official stable Threadspan release");
  return stable[0];
}

/** Parse one exact archive checksum from a SHA-256 manifest. */
export function parseChecksumManifest(text, archiveName) {
  let found;
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match || match[2] !== archiveName) continue;
    if (found) throw updateError("ambiguous-checksum", `Checksum manifest repeats '${archiveName}'`);
    found = match[1].toLowerCase();
  }
  if (!found) throw updateError("checksum-missing", `Checksum manifest does not name '${archiveName}' exactly`);
  return found;
}

/** Read one exact source commit carried inside publisher-signed checksum-manifest bytes. */
export function parseSignedReleaseSourceCommit(text) {
  const matches = String(text).split(/\r?\n/)
    .map((line) => /^# threadspan-source-commit ([0-9a-f]{40,64})$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => match[1]);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw updateError("ambiguous-source-commit", "Signed release metadata repeats the source commit");
  return matches[0];
}

/** Verify the exact checksum-manifest bytes with the pinned Ed25519 publisher key. */
export function verifyChecksumManifestSignature(manifestBytes, signatureBytes, publicKey) {
  try {
    const manifest = Buffer.from(manifestBytes);
    const signature = Buffer.from(signatureBytes);
    if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES || signature.length !== 64) {
      throw new Error("Release checksum signature has an invalid size");
    }
    const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Release publisher key is not Ed25519");
    if (!verifySignature(null, manifest, key, signature)) throw new Error("Release checksum manifest has an invalid publisher signature");
    return true;
  } catch (error) {
    throw updateError("publisher-authenticity-failed", `Release publisher authenticity could not be proven: ${messageOf(error)}`);
  }
}

/** Load and validate the exact Ed25519 trust root shipped with a release tree. */
export async function loadReleasePublicKey(root) {
  const path = root === undefined
    ? RELEASE_PUBLIC_KEY_PATH
    : resolve(root, ...RELEASE_PUBLIC_KEY_RELATIVE_PATH.split("/"));
  try {
    const keyBytes = await readStableRegularFile(path, 1024 * 1024);
    if (containsPrivateKeyMaterial(keyBytes)) throw new Error("contains private key material");
    const key = createPublicKey(keyBytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    return key;
  } catch (error) {
    throw updateError("publisher-authenticity-failed", `Pinned release public key is invalid or unavailable: ${messageOf(error)}`);
  }
}

/** Create a bounded, integrity-tagged capsule containing no credentials or task state. */
export function createResumeCapsule(input) {
  const payload = {
    schemaVersion: 1,
    kind: "threadspan-installer-stable-update",
    repository: OFFICIAL_REPOSITORY,
    sessionId: boundedString(input.sessionId, 128, "sessionId"),
    nonce: boundedString(input.nonce, 256, "nonce"),
    installRoot: boundedString(input.installRoot, 2048, "installRoot"),
    fromVersion: normalizeVersion(input.fromVersion),
    toVersion: normalizeVersion(input.toVersion),
    issuedAt: boundedString(input.issuedAt, 64, "issuedAt"),
  };
  return Object.freeze({ ...payload, digest: sha256(Buffer.from(JSON.stringify(payload))) });
}

/** Verify a capsule before a staged helper trusts its session or paths. */
export function verifyResumeCapsule(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "threadspan-installer-stable-update" || value.repository !== OFFICIAL_REPOSITORY) {
    throw new TypeError("Invalid Threadspan installer resume capsule");
  }
  const { digest, ...payload } = value;
  const expected = sha256(Buffer.from(JSON.stringify(payload)));
  if (!/^[0-9a-f]{64}$/.test(String(digest ?? "")) || digest !== expected) throw new TypeError("Installer resume capsule digest mismatch");
  createResumeCapsule(payload);
  return Object.freeze({ ...payload, digest });
}

/** Encode a verified resume capsule for a URL fragment. */
export function encodeResumeCapsule(capsule) {
  return Buffer.from(JSON.stringify(verifyResumeCapsule(capsule))).toString("base64url");
}

/** Match only explicitly approved official Git transport URLs. */
export function isOfficialGitRemote(remote) {
  return OFFICIAL_GIT_REMOTES.has(String(remote ?? "").trim());
}

async function fetchLatestStableRelease(options) {
  if (typeof options.fetchImpl !== "function") throw new TypeError("fetch is unavailable");
  const response = await options.fetchImpl(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "threadspan-installer" },
    signal: options.signal,
  });
  if (response?.status === 404) throw updateError("no-public-release", "No public stable Threadspan release was found");
  if (!response?.ok) throw updateError("github-unavailable", `GitHub release check failed with HTTP ${response?.status ?? "unknown"}`);
  return selectLatestStableRelease(await response.json());
}

async function inspectSource(root, runGitImpl) {
  let top;
  try {
    top = await runGitImpl(["rev-parse", "--show-toplevel"], { cwd: root });
  } catch {
    return { kind: "release-bundle" };
  }
  if (resolve(String(top).trim()) !== resolve(root)) return { kind: "release-bundle" };
  const [remote, status] = await Promise.all([
    runGitImpl(["remote", "get-url", "origin"], { cwd: root }),
    runGitImpl(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  return { kind: "git", remote: String(remote).trim(), dirty: String(status).trim().length > 0 };
}

async function runGit(args, options) {
  return runCommand("git", args, options);
}

/** Run installer subprocesses with bounded output and descendant-aware cancellation. */
export async function runInstallerCommand(command, args, options = {}) {
  let result;
  try {
    result = await runCapturedProcess({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      maxStdoutBytes: options.maxBuffer ?? 8 * 1024 * 1024,
      maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 30 * 60_000,
      killTree: true,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    throw error;
  }
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  if (!allowedExitCodes.includes(result.exitCode)) {
    const suffix = result.stderr ? `: ${result.stderr.trim()}` : "";
    throw new Error(`${command} exited with code ${result.exitCode ?? "unknown"}${suffix}`);
  }
  return String(result.stdout ?? "").trim();
}

const runCommand = runInstallerCommand;

async function downloadAsset(url, path, options) {
  assertOfficialAssetUrl(url);
  throwIfAborted(options.signal);
  const response = await options.fetchImpl(url, { headers: { "user-agent": "threadspan-installer" }, signal: options.signal });
  if (!response?.ok) throw updateError("download-failed", `Release asset download failed with HTTP ${response?.status ?? "unknown"}`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes) throw updateError("download-too-large", "Release asset exceeds the bounded download size");
  if (!response.body) throw updateError("download-failed", "Release asset response has no body");
  const handle = await open(path, "wx", 0o600);
  let received = 0;
  try {
    for await (const chunk of response.body) {
      throwIfAborted(options.signal);
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      if (received > options.maxBytes) throw updateError("download-too-large", "Release asset exceeds the bounded download size");
      await handle.write(bytes);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
}

/** Strictly inspect a canonical USTAR release before native tar writes any path. */
export async function inspectReleaseArchive(archiveInput, options = {}) {
  const archiveBytes = await snapshotArchiveInput(archiveInput);
  const expectedRootName = normalizePortablePath(options.expectedRootName);
  if (expectedRootName.includes("/")) throw new TypeError("Expected release archive root must be one portable directory name");
  const maxInflatedTarBytes = Math.min(MAX_INFLATED_TAR_BYTES, options.maxInflatedTarBytes ?? MAX_INFLATED_TAR_BYTES);
  if (!Number.isSafeInteger(maxInflatedTarBytes) || maxInflatedTarBytes < 1024) throw new TypeError("Archive inspection byte limit is invalid");
  await scanStrictUstarArchive(archiveBytes, { expectedRootName, maxInflatedTarBytes, signal: options.signal });
  await (options.runCommand ?? runCommand)("tar", ["-tzf", "-"], {
    env: tarEnvironment(),
    maxBuffer: 16 * 1024 * 1024,
    stdin: archiveBytes,
    signal: options.signal,
  });
}

async function extractTarArchive(archiveInput, destination, options = {}) {
  const archiveBytes = await snapshotArchiveInput(archiveInput);
  await (options.runCommand ?? runCommand)("tar", ["-xzf", "-", "-C", destination, "--no-same-owner", "--no-same-permissions"], {
    env: tarEnvironment(),
    stdin: archiveBytes,
    signal: options.signal,
  });
}

async function snapshotArchiveInput(archiveInput) {
  if (Buffer.isBuffer(archiveInput) || ArrayBuffer.isView(archiveInput)) {
    const bytes = Buffer.from(archiveInput);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BUNDLE_BYTES) throw updateError("unsafe-archive", "Release archive has an invalid byte size");
    return bytes;
  }
  const archivePath = String(archiveInput ?? "");
  if (!/\.(?:tar\.gz|tgz)$/i.test(archivePath)) throw updateError("unsupported-archive", "Only gzip-compressed tar release bundles are accepted");
  return readStableRegularFile(archivePath, MAX_BUNDLE_BYTES);
}

async function scanStrictUstarArchive(archiveBytes, options) {
  throwIfAborted(options.signal);
  const input = Readable.from([archiveBytes]);
  const gunzip = createGunzip();
  const stream = input.pipe(gunzip);
  const abort = () => {
    const reason = abortReason(options.signal);
    input.destroy(reason);
    gunzip.destroy(reason);
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  let buffer = Buffer.alloc(0);
  let entryBytesRemaining = 0;
  let entryPaddingRemaining = 0;
  let entryChunks = [];
  let inflatedBytes = 0;
  let zeroBlocks = 0;
  let ended = false;
  let expandedBytes = 0;
  const entries = [];
  try {
    for await (const chunk of stream) {
      throwIfAborted(options.signal);
      const bytes = Buffer.from(chunk);
      inflatedBytes += bytes.length;
      if (inflatedBytes > options.maxInflatedTarBytes) throw updateError("unsafe-archive", "Release archive exceeds the bounded expanded tar size");
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
      while (buffer.length > 0) {
        if (ended) {
          if (!buffer.every((byte) => byte === 0)) throw updateError("unsafe-archive", "Release archive contains data after its end marker");
          buffer = Buffer.alloc(0);
          break;
        }
        if (entryBytesRemaining > 0) {
          const consumed = Math.min(entryBytesRemaining, buffer.length);
          entryChunks.push(buffer.subarray(0, consumed));
          buffer = buffer.subarray(consumed);
          entryBytesRemaining -= consumed;
          if (entryBytesRemaining === 0) {
            if (containsPrivateKeyMaterial(Buffer.concat(entryChunks))) {
              throw updateError("unsafe-archive", "Release archive contains prohibited private key material");
            }
            entryChunks = [];
          }
          continue;
        }
        if (entryPaddingRemaining > 0) {
          const consumed = Math.min(entryPaddingRemaining, buffer.length);
          if (!buffer.subarray(0, consumed).every((byte) => byte === 0)) {
            throw updateError("unsafe-archive", "Release archive contains nonzero file padding");
          }
          buffer = buffer.subarray(consumed);
          entryPaddingRemaining -= consumed;
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every((byte) => byte === 0)) {
          zeroBlocks += 1;
          if (zeroBlocks === 2) ended = true;
          continue;
        }
        if (zeroBlocks !== 0) throw updateError("unsafe-archive", "Release archive has an invalid end marker");
        const entry = parseStrictUstarHeader(header);
        entries.push(entry);
        if (entries.length > MAX_ARCHIVE_ENTRIES) throw updateError("unsafe-archive", "Release archive exceeds the bounded entry count");
        if (entry.type === "file") {
          expandedBytes += entry.size;
          if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_RELEASE_BYTES) {
            throw updateError("unsafe-archive", "Release archive exceeds the bounded expanded regular-file size");
          }
          entryBytesRemaining = entry.size;
          entryPaddingRemaining = (512 - (entry.size % 512)) % 512;
        }
      }
    }
    throwIfAborted(options.signal);
    if (!ended || entryBytesRemaining !== 0 || entryPaddingRemaining !== 0 || buffer.length !== 0) {
      throw updateError("unsafe-archive", "Release archive is truncated or missing its end marker");
    }
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (error?.updateCode) throw error;
    throw updateError("unsafe-archive", `Release archive could not be inspected safely: ${messageOf(error)}`);
  } finally {
    options.signal?.removeEventListener("abort", abort);
    input.destroy();
    gunzip.destroy();
  }

  validatePortableArchiveEntries(entries);
  const rootEntries = entries.filter((entry) => normalizeArchiveEntryPath(entry.path) === options.expectedRootName);
  if (rootEntries.length !== 1 || rootEntries[0].type !== "directory") {
    throw updateError("archive-layout-invalid", `Release archive must contain the exact root '${options.expectedRootName}/'`);
  }
  let releasePublicKeys = 0;
  for (const entry of entries) {
    const path = normalizeArchiveEntryPath(entry.path);
    if (path !== options.expectedRootName && !path.startsWith(`${options.expectedRootName}/`)) {
      throw updateError("archive-layout-invalid", `Release archive entry '${path}' is outside the exact release root`);
    }
    if (path === options.expectedRootName) continue;
    const relativePath = path.slice(options.expectedRootName.length + 1);
    if (relativePath === RELEASE_PUBLIC_KEY_RELATIVE_PATH && entry.type === "file") releasePublicKeys += 1;
    else if (isForbiddenKeyMaterialPath(relativePath)) {
      throw updateError("unsafe-archive", `Release archive contains forbidden key material '${relativePath}'`);
    }
  }
  if (releasePublicKeys !== 1) throw updateError("release-identity-mismatch", `Release archive must contain '${RELEASE_PUBLIC_KEY_RELATIVE_PATH}' exactly once`);
  return Object.freeze({ entryCount: entries.length, expandedBytes });
}

function parseStrictUstarHeader(header) {
  const storedChecksum = readTarOctal(header, 148, 8, "checksum");
  let actualChecksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    actualChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (storedChecksum !== actualChecksum) throw updateError("unsafe-archive", "Release archive contains an invalid tar header checksum");
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii")) || !header.subarray(263, 265).equals(Buffer.from("00", "ascii"))) {
    throw updateError("unsafe-archive", "Release archive is not canonical portable USTAR");
  }
  if (!header.subarray(157, 257).every((byte) => byte === 0)) throw updateError("unsafe-archive", "Release archive contains a link target");
  const rawType = header[156];
  const type = rawType === 0 || rawType === 0x30 ? "file" : rawType === 0x35 ? "directory" : undefined;
  if (!type) throw updateError("unsafe-archive", "Release archive contains a symbolic link, hard link, or special entry");
  const name = readTarText(header, 0, 100);
  const prefix = readTarText(header, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  const mode = readTarOctal(header, 100, 8, "mode");
  const uid = readTarOctal(header, 108, 8, "uid");
  const gid = readTarOctal(header, 116, 8, "gid");
  const size = readTarOctal(header, 124, 12, "size");
  const mtime = readTarOctal(header, 136, 12, "mtime");
  const expectedMode = type === "directory" ? 0o755 : 0o644;
  if (uid !== 0 || gid !== 0 || mtime !== 0 || mode !== expectedMode) {
    throw updateError("unsafe-archive", "Release archive metadata exceeds the canonical portable UID, GID, mode, or mtime bounds");
  }
  if (type === "directory" && (size !== 0 || !path.endsWith("/"))) throw updateError("unsafe-archive", "Release archive directory metadata is invalid");
  if (type === "file" && path.endsWith("/")) throw updateError("unsafe-archive", "Release archive regular-file metadata is invalid");
  return { path, size, type, mode, uid, gid, mtime };
}

function readTarText(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  if (end !== -1 && !field.subarray(end).every((byte) => byte === 0)) throw updateError("unsafe-archive", "Release archive tar text field has nonzero bytes after its terminator");
  try {
    return STRICT_UTF8.decode(field.subarray(0, end === -1 ? field.length : end));
  } catch {
    throw updateError("unsafe-archive", "Release archive path is not valid UTF-8");
  }
}

function readTarOctal(header, offset, length, label) {
  const field = header.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(field)) throw updateError("unsafe-archive", `Release archive tar ${label} is invalid`);
  const value = Number.parseInt(field, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw updateError("unsafe-archive", `Release archive tar ${label} exceeds safe bounds`);
  return value;
}

function tarEnvironment() {
  const environment = { ...process.env };
  delete environment.TAR_OPTIONS;
  return environment;
}

function selectReleaseAssets(release, version) {
  const tag = release.tag_name;
  const archiveNames = new Set([
    `threadspan-${version}.tar.gz`,
  ]);
  const manifestNames = new Set([
    "SHA256SUMS",
  ]);
  const signatureNames = new Set(["SHA256SUMS.sig"]);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const archives = assets.filter((asset) => archiveNames.has(asset?.name));
  const manifests = assets.filter((asset) => manifestNames.has(asset?.name));
  const signatures = assets.filter((asset) => signatureNames.has(asset?.name));
  if (archives.length !== 1 || manifests.length !== 1 || signatures.length !== 1) {
    throw updateError("publisher-authenticity-failed", "Stable release must provide one canonical Threadspan tar bundle, SHA256SUMS, and SHA256SUMS.sig");
  }
  assertOfficialAssetUrl(archives[0].browser_download_url, tag, archives[0].name);
  assertOfficialAssetUrl(manifests[0].browser_download_url, tag, manifests[0].name);
  assertOfficialAssetUrl(signatures[0].browser_download_url, tag, signatures[0].name);
  return { archive: archives[0], manifest: manifests[0], signature: signatures[0] };
}

function assertOfficialAssetUrl(value, expectedTag, expectedName) {
  let url;
  try { url = new URL(String(value)); } catch { throw updateError("release-asset-url-invalid", "Release asset URL is invalid"); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw updateError("release-asset-url-invalid", "Release asset URL is not an exact official GitHub URL");
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const expectedPrefix = ["HaileyStorm", "threadspan", "releases", "download"];
  if (parts.length !== 6 || expectedPrefix.some((part, index) => parts[index] !== part)) {
    throw updateError("release-asset-url-invalid", "Release asset URL is outside the official Threadspan release path");
  }
  if (expectedTag !== undefined && (parts[4] !== expectedTag || parts[5] !== expectedName)) {
    throw updateError("release-asset-url-invalid", "Release asset URL does not match its release tag and filename");
  }
}

function isOfficialRelease(release) {
  try {
    const url = new URL(String(release.html_url));
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && parts.length === 5
      && parts[0] === "HaileyStorm"
      && parts[1] === "threadspan"
      && parts[2] === "releases"
      && parts[3] === "tag"
      && parts[4] === release.tag_name;
  } catch {
    return false;
  }
}

async function findExtractedRoot(unpacked, expectedRootName) {
  const entries = await readdir(unpacked, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (entries.length !== 1 || directories.length !== 1 || directories[0].name !== expectedRootName) {
    throw updateError("archive-layout-invalid", `Release bundle must contain the exact source root '${expectedRootName}'`);
  }
  return join(unpacked, expectedRootName);
}

async function readThreadspanIdentity(root) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (packageJson.name !== "threadspan") throw new Error("package.json does not identify Threadspan");
  const version = normalizeVersion(packageJson.version);
  return { name: packageJson.name, version };
}

async function validateThreadspanReleaseRoot(root, expectedVersion, options = {}) {
  if (options.extracted === true) await assertRegularTree(root);
  const identity = await readThreadspanIdentity(root);
  if (identity.version !== expectedVersion) throw updateError("release-version-mismatch", `Release bundle identifies version ${identity.version}, expected ${expectedVersion}`);
  const readme = await readFile(join(root, "README.md"), "utf8");
  if (!readme.includes(OFFICIAL_REPOSITORY_URL)) throw updateError("release-identity-mismatch", "Release bundle does not identify the official Threadspan repository");
  await loadReleasePublicKey(root);
  for (const relativePath of GUI_ASSETS) {
    const info = await lstat(join(root, relativePath));
    if (!info.isFile() || info.isSymbolicLink()) throw updateError("release-assets-invalid", `Verified GUI asset '${relativePath}' is not a regular file`);
  }
  return identity;
}

async function validateGitTag(runGitImpl, root, tagRef, expectedVersion, signal) {
  const packageJson = JSON.parse(await runGitImpl(["show", `${tagRef}:package.json`], { cwd: root, signal }));
  if (packageJson.name !== "threadspan" || normalizeVersion(packageJson.version) !== expectedVersion) {
    throw updateError("release-version-mismatch", "Stable Git tag does not identify the expected Threadspan version");
  }
  const readme = await runGitImpl(["show", `${tagRef}:README.md`], { cwd: root, signal });
  if (!String(readme).includes(OFFICIAL_REPOSITORY_URL)) {
    throw updateError("release-identity-mismatch", "Stable Git tag does not identify the official Threadspan repository");
  }
  const treePaths = String(await runGitImpl(["ls-tree", "-r", "--name-only", tagRef], { cwd: root, signal }))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(normalizePortablePath);
  if (treePaths.filter((path) => path === RELEASE_PUBLIC_KEY_RELATIVE_PATH).length !== 1) {
    throw updateError("release-identity-mismatch", `Stable Git tag must contain '${RELEASE_PUBLIC_KEY_RELATIVE_PATH}' exactly once`);
  }
  for (const path of treePaths) {
    if (isForbiddenKeyMaterialPath(path)) throw updateError("release-identity-mismatch", `Stable Git tag contains forbidden key material '${path}'`);
  }
  const privateCandidates = String(await runGitImpl([
    "grep",
    "-I",
    "-E",
    "-l",
    "-e",
    "-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----",
    tagRef,
    "--",
  ], { cwd: root, signal, allowedExitCodes: [0, 1] }))
    .split(/\r?\n/)
    .filter(Boolean);
  for (const candidate of privateCandidates) {
    const prefix = `${tagRef}:`;
    if (!candidate.startsWith(prefix)) throw updateError("release-identity-mismatch", "Stable Git tag private-key scan returned an unexpected path");
    const path = normalizePortablePath(candidate.slice(prefix.length));
    const bytes = await runGitImpl(["show", `${tagRef}:${path}`], { cwd: root, signal });
    if (containsPrivateKeyMaterial(Buffer.from(bytes))) throw updateError("release-identity-mismatch", `Stable Git tag file '${path}' contains private key material`);
  }
  const releaseKey = await runGitImpl(["show", `${tagRef}:${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`], { cwd: root, signal });
  try {
    if (containsPrivateKeyMaterial(Buffer.from(releaseKey))) throw new Error("private key material");
    const key = createPublicKey(releaseKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw updateError("release-identity-mismatch", "Stable Git tag does not contain the required Ed25519 release public key");
  }
  for (const relativePath of GUI_ASSETS) {
    const type = await runGitImpl(["cat-file", "-t", `${tagRef}:${relativePath}`], { cwd: root, signal });
    if (String(type).trim() !== "blob") throw updateError("release-assets-invalid", `Stable Git tag is missing regular GUI asset '${relativePath}'`);
  }
}

async function assertRegularTree(root) {
  const pending = [resolve(root)];
  let count = 0;
  let expandedBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const info = await lstat(current);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw updateError("unsafe-extracted-tree", "Extracted release contains a link or special filesystem entry");
    if (!info.isDirectory()) {
      if (info.nlink !== 1) throw updateError("unsafe-extracted-tree", "Extracted release contains a hard-linked regular file");
      expandedBytes += info.size;
      if (!Number.isSafeInteger(expandedBytes) || expandedBytes > MAX_EXPANDED_RELEASE_BYTES) {
        throw updateError("unsafe-extracted-tree", "Extracted release exceeds the bounded regular-file size");
      }
      const relativePath = relative(resolve(root), current).split(sep).join("/");
      if (isForbiddenKeyMaterialPath(relativePath)) throw updateError("unsafe-extracted-tree", `Extracted release contains forbidden key material '${relativePath}'`);
      if (containsPrivateKeyMaterial(await readFile(current))) throw updateError("unsafe-extracted-tree", `Extracted release file '${relativePath}' contains private key material`);
      continue;
    }
    for (const entry of await readdir(current)) {
      count += 1;
      if (count > MAX_ARCHIVE_ENTRIES) throw updateError("unsafe-extracted-tree", "Extracted release exceeds the bounded entry count");
      pending.push(join(current, entry));
    }
  }
}

async function hashVerifiedGuiAssets(root) {
  const output = {};
  for (const relativePath of GUI_ASSETS) output[relativePath] = sha256(await readFile(join(root, relativePath)));
  return Object.freeze(output);
}

/** Validate archive names with the same portable-path contract as the release producer. */
export function validatePortableArchiveEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw updateError("unsafe-archive", "Release archive has an invalid entry count");
  }
  const root = { children: new Map(), type: undefined };
  const types = new Map();
  for (const entry of entries) {
    const rawPath = typeof entry === "object" && entry !== null ? entry.path : entry;
    const normalized = normalizeArchiveEntryPath(rawPath);
    const type = typeof entry === "object" && entry !== null
      ? entry.type
      : String(rawPath).endsWith("/") ? "directory" : "file";
    if (!["file", "directory"].includes(type)) throw updateError("unsafe-archive", "Release archive contains an invalid entry type");
    let node = root;
    const parts = portablePathKey(normalized).split("/");
    for (let index = 0; index < parts.length; index += 1) {
      if (node.type === "file") throw updateError("unsafe-archive", "Release archive places an entry below a regular file");
      const part = parts[index];
      if (!node.children.has(part)) node.children.set(part, { children: new Map(), type: undefined });
      node = node.children.get(part);
    }
    if (node.type !== undefined) throw updateError("unsafe-archive", "Release archive contains duplicate or cross-platform-colliding paths");
    if (type === "file" && node.children.size > 0) throw updateError("unsafe-archive", "Release archive makes a regular file an ancestor of another entry");
    node.type = type;
    types.set(parts.join("/"), type);
  }
  for (const key of types.keys()) {
    const parts = key.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      if (types.get(parts.slice(0, length).join("/")) !== "directory") {
        throw updateError("unsafe-archive", "Release archive omits an explicit parent directory entry");
      }
    }
  }
  return true;
}

function normalizeArchiveEntryPath(value) {
  const raw = String(value ?? "");
  return normalizePortablePath(raw.endsWith("/") ? raw.slice(0, -1) : raw);
}

function normalizePortablePath(value) {
  const path = String(value ?? "");
  if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw updateError("unsafe-archive", "Release archive contains an unsafe path");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw updateError("unsafe-archive", "Release archive path escapes its staging root");
  for (const part of parts) assertPortableSegment(part, path);
  return parts.join("/");
}

function portablePathKey(path) {
  return path.split("/").map((part) => part.normalize("NFC").toLowerCase()).join("/");
}

function assertPortableSegment(segment, path) {
  if (/[\u0000-\u001f<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment)) throw updateError("unsafe-archive", `Release archive path is not Windows-safe: '${path}'`);
  const stem = segment.split(".")[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw updateError("unsafe-archive", `Release archive path uses a Windows-reserved name: '${path}'`);
}

function isForbiddenKeyMaterialPath(relativePath) {
  const normalized = normalizePortablePath(relativePath);
  if (normalized === RELEASE_PUBLIC_KEY_RELATIVE_PATH) return false;
  const name = normalized.toLowerCase().split("/").at(-1);
  return KEY_MATERIAL_EXTENSIONS.some((extension) => name.endsWith(extension))
    || name === "id_rsa"
    || name === "id_ed25519"
    || name.startsWith("id_");
}

function containsPrivateKeyMaterial(bytes) {
  const material = Buffer.from(bytes);
  try {
    createPrivateKey(material);
    return true;
  } catch {}
  if (material.byteLength <= 1024 * 1024 && material[0] === 0x30) {
    for (const type of ["pkcs8", "pkcs1", "sec1"]) {
      try {
        createPrivateKey({ key: material, format: "der", type });
        return true;
      } catch {}
    }
  }
  const text = material.toString("utf8");
  for (const match of text.matchAll(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----\r?\n([\s\S]*?)\r?\n-----END \1-----/gu)) {
    const pem = match[0];
    try {
      createPrivateKey(pem);
      return true;
    } catch {}
    const payload = decodePemPayload(match[2]);
    if (match[1] === "ENCRYPTED PRIVATE KEY" && isEncryptedPkcs8(payload)) return true;
    if (match[1] === "OPENSSH PRIVATE KEY" && isOpenSshPrivateKey(payload)) return true;
  }
  return false;
}

function decodePemPayload(body) {
  const compact = body.replace(/\s/gu, "");
  if (!compact || compact.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(compact)) return undefined;
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64") !== compact) return undefined;
  return decoded;
}

function isEncryptedPkcs8(bytes) {
  if (!bytes) return false;
  const outer = readDerElement(bytes, 0);
  if (!outer || outer.tag !== 0x30 || outer.next !== bytes.length) return false;
  const algorithm = readDerElement(bytes, outer.start);
  if (!algorithm || algorithm.tag !== 0x30 || algorithm.start === algorithm.end) return false;
  const encrypted = readDerElement(bytes, algorithm.next);
  return Boolean(encrypted && encrypted.tag === 0x04 && encrypted.start < encrypted.end && encrypted.next === outer.end);
}

function readDerElement(bytes, offset) {
  if (offset + 2 > bytes.length) return undefined;
  const tag = bytes[offset];
  const firstLength = bytes[offset + 1];
  let length;
  let start = offset + 2;
  if ((firstLength & 0x80) === 0) length = firstLength;
  else {
    const width = firstLength & 0x7f;
    if (width === 0 || width > 4 || start + width > bytes.length || bytes[start] === 0) return undefined;
    length = 0;
    for (let index = 0; index < width; index += 1) length = (length * 256) + bytes[start + index];
    if (length < 128) return undefined;
    start += width;
  }
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) return undefined;
  return { tag, start, end, next: end };
}

function isOpenSshPrivateKey(bytes) {
  const magic = Buffer.from("openssh-key-v1\0", "ascii");
  if (!bytes || bytes.length <= magic.length || !bytes.subarray(0, magic.length).equals(magic)) return false;
  let offset = magic.length;
  const cipher = readSshString(bytes, offset);
  if (!cipher || cipher.value.length === 0) return false;
  offset = cipher.next;
  const kdf = readSshString(bytes, offset);
  if (!kdf || kdf.value.length === 0) return false;
  offset = kdf.next;
  const kdfOptions = readSshString(bytes, offset);
  if (!kdfOptions || kdfOptions.next + 4 > bytes.length) return false;
  offset = kdfOptions.next;
  const keyCount = bytes.readUInt32BE(offset);
  if (keyCount < 1 || keyCount > 1024) return false;
  offset += 4;
  for (let index = 0; index < keyCount; index += 1) {
    const publicKey = readSshString(bytes, offset);
    if (!publicKey || publicKey.value.length === 0) return false;
    offset = publicKey.next;
  }
  const privateBlock = readSshString(bytes, offset);
  return Boolean(privateBlock && privateBlock.value.length > 0 && privateBlock.next === bytes.length);
}

function readSshString(bytes, offset) {
  if (offset + 4 > bytes.length) return undefined;
  const length = bytes.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (!Number.isSafeInteger(end) || end > bytes.length) return undefined;
  return { value: bytes.subarray(start, end), next: end };
}

function assertWithin(root, candidate, label) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  throw new TypeError(`${label} must stay inside the owner-local root`);
}

async function ensureOwnerLocalDirectory(ownerRoot, target) {
  const owner = resolve(ownerRoot);
  assertWithin(owner, target, "Release staging root");
  const ownerInfo = await lstat(owner);
  if (!ownerInfo.isDirectory() || ownerInfo.isSymbolicLink()) throw updateError("unsafe-staging-root", "Owner-local root is not a regular directory");
  let current = owner;
  for (const part of relative(owner, resolve(target)).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw updateError("unsafe-staging-root", "Release staging path contains a link or non-directory entry");
  }
}

function isStableTag(value) {
  return /^v?\d+\.\d+\.\d+$/.test(String(value ?? ""));
}

function versionFromTag(tag) {
  if (!isStableTag(tag)) throw new TypeError(`Unsupported stable release tag '${tag}'`);
  return String(tag).replace(/^v/, "");
}

function normalizeVersion(value) {
  const version = String(value ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new TypeError(`Unsupported Threadspan version '${version}'`);
  return version;
}

function compareVersions(left, right) {
  const a = normalizeVersion(left).split(".").map(Number);
  const b = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function boundedString(value, maximum, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new TypeError(`${label} is missing or too long`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read one stable regular-file snapshot from a same-owner mutable directory. */
async function readStableRegularFile(path, maxBytes) {
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const beforePath = await lstat(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw updateError("unsafe-file-replacement", "Release asset is not a stable regular file");
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maxBytes)) {
      throw updateError("unsafe-file-replacement", "Release asset has an invalid byte size");
    }
    const bytes = await handle.readFile();
    const [after, afterPath] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!sameStableFile(before, after) || !sameStableFile(before, beforePath) || !sameStableFile(before, afterPath)) {
      throw updateError("unsafe-file-replacement", "Release asset changed while it was being consumed");
    }
    if (BigInt(bytes.byteLength) !== before.size) throw updateError("unsafe-file-replacement", "Release asset changed size while it was being consumed");
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameStableFile(left, right) {
  return right.isFile()
    && !right.isSymbolicLink()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function updateError(code, message) {
  const error = new Error(message);
  error.updateCode = code;
  return error;
}

function versions(currentVersion, latestVersion) {
  return { currentVersion, latestVersion };
}

function unavailable(error, currentVersion) {
  const noPublicRelease = error?.updateCode === "no-public-release" || error?.updateCode === "no-stable-release";
  return {
    status: "unavailable",
    reason: error?.updateCode ?? "github-unavailable",
    currentVersion,
    canContinueCurrent: true,
    retryable: true,
    message: noPublicRelease ? "No public stable release was found. The current source remains usable." : `Update check unavailable: ${messageOf(error)}`,
  };
}

function blocked(reason, error, extra = {}) {
  return {
    status: "blocked",
    reason,
    canContinueCurrent: true,
    retryable: true,
    message: messageOf(error),
    ...extra,
  };
}

function messageOf(value) {
  return value instanceof Error ? value.message : String(value);
}

function normalizeTimeouts(value = {}) {
  const result = {};
  for (const [name, defaultValue] of Object.entries(DEFAULT_TIMEOUTS)) {
    const selected = value[name] ?? defaultValue;
    if (!Number.isSafeInteger(selected) || selected < 1) throw new TypeError(`${name} must be a positive integer`);
    result[name] = selected;
  }
  return Object.freeze(result);
}

async function runBoundedPhase(phase, timeoutMs, parentSignal, operation) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortReason(parentSignal));
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(updateError(`${phase}-timeout`, `${phase.replaceAll("-", " ")} timed out after ${timeoutMs} ms`)), timeoutMs);
  let rejectOnAbort;
  const aborted = new Promise((_resolve, reject) => { rejectOnAbort = () => reject(controller.signal.reason); });
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  operationPromise.catch(() => undefined);
  try {
    return await Promise.race([operationPromise, aborted]);
  } catch (error) {
    if (controller.signal.aborted) {
      await operationPromise.catch(() => undefined);
      throw controller.signal.reason ?? error;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", rejectOnAbort);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  if (signal?.reason?.updateCode) return signal.reason;
  return updateError("client-disconnected", "Installer client disconnected");
}
