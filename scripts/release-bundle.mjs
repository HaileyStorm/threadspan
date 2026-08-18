import { createHash, createPrivateKey, createPublicKey, sign as signBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { resolveExecutablePath } from "../src/core/executable.mjs";
import { normalizeManagedCommand, runCapturedProcess } from "../src/core/managed-process.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const OFFICIAL_REPOSITORY_URL = "https://github.com/HaileyStorm/threadspan";
export const RELEASE_PUBLIC_KEY_RELATIVE_PATH = "src/installer/release-signing-public-key.pem";
const REQUIRED_RELEASE_FILES = Object.freeze([
  "package.json",
  "README.md",
  "src/cli.mjs",
  RELEASE_PUBLIC_KEY_RELATIVE_PATH,
  "ui/install.html",
  "ui/install.css",
  "ui/install.js",
  "ui/mark.svg",
]);
const MAX_ARCHIVE_ENTRIES = 30_000;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const DEFAULT_NPM_PACK_TIMEOUT_MS = 120_000;
const MAX_NPM_PACK_TIMEOUT_MS = 5 * 60_000;
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".threadspan",
  ".codex",
  ".npm",
  ".ssh",
  ".cache",
  ".artifacts",
  ".artifacts-temp",
  ".cursor-bridge",
  "node_modules",
  "coverage",
  "rollback",
  "rollbacks",
  "evidence",
  "artifact",
  "artifacts",
  "user data",
  "browser-profile",
  "browser-profiles",
  "credentials",
  "secrets",
]);
const FORBIDDEN_NAMES = new Set([
  ".npmrc",
  ".netrc",
  ".ds_store",
  "thumbs.db",
  "config.local.jsonc",
  "credentials",
  "credentials.json",
  "auth-token",
  "cookies",
  "cookies-journal",
  "login data",
  "web data",
  "local state",
  "id_rsa",
  "id_ed25519",
  "package-lock.json",
  "sha256sums",
  "sha256sums.txt",
]);
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keystore", ".kdbx", ".crt", ".cer"];
const COMPILED_EXTENSIONS = [".exe", ".msi", ".msix", ".dll", ".so", ".dylib", ".dmg", ".pkg", ".deb", ".rpm", ".appimage"];

/** Return the exact stable-release asset names consumed by the installer updater. */
export function canonicalReleaseNames(version) {
  const normalized = normalizeVersion(version);
  return Object.freeze({
    archiveName: `threadspan-${normalized}.tar.gz`,
    manifestName: "SHA256SUMS",
    signatureName: "SHA256SUMS.sig",
    rootName: `threadspan-${normalized}`,
  });
}

/** Return true when a package-relative path is unsafe or host-local release input. */
export function isReleaseExcluded(relativePath, options = {}) {
  const normalized = normalizePortableReleasePath(relativePath);
  const lower = normalized.toLowerCase();
  const segments = lower.split("/");
  const name = segments.at(-1);
  const outputRelative = options.outputRelative ? normalizePortableReleasePath(options.outputRelative).toLowerCase() : undefined;

  if (outputRelative && (lower === outputRelative || lower.startsWith(`${outputRelative}/`))) return true;
  if (normalized === RELEASE_PUBLIC_KEY_RELATIVE_PATH) return false;
  if (segments.some((segment) => segment.startsWith(".working") || FORBIDDEN_SEGMENTS.has(segment))) return true;
  if (FORBIDDEN_NAMES.has(name) || name === ".env" || name.startsWith(".env.")) return true;
  if (name === "secret" || name.startsWith("secret.") || name === "secrets" || name.startsWith("secrets.") || name.startsWith("credentials.") || name.startsWith("id_")) return true;
  if (name.endsWith(".log") || SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  if (COMPILED_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  if (/^threadspan-\d+\.\d+\.\d+\.(?:tar\.gz|tgz)$/.test(name)) return true;
  return false;
}

/** Build one deterministic source archive and its exact SHA-256 manifest. */
export async function buildReleaseBundle(options = {}) {
  const root = resolve(options.root ?? repositoryRoot);
  const outputDirectory = resolve(options.outputDirectory ?? join(root, "dist", "release"));
  if (root === outputDirectory) throw new TypeError("Release output directory must not be the source root");
  await assertPathMissing(outputDirectory, "Release output directory must not already exist");

  const outputRelative = relativeWithin(root, outputDirectory);
  const packagePaths = await readNpmPacklist(root, {
    command: options.npmCommand ?? "npm",
    prefixArgs: options.npmCommandArgs,
    timeoutMs: options.npmPackTimeoutMs,
  });
  for (const path of packagePaths) {
    if (isForbiddenKeyMaterialPath(path)) throw new Error(`Release package manifest contains forbidden key material '${path}'`);
  }
  const selectedPaths = packagePaths
    .filter((path) => !isReleaseExcluded(path, { outputRelative }))
    .sort(compareUtf8);
  for (const required of REQUIRED_RELEASE_FILES) {
    if (!selectedPaths.includes(required)) throw new Error(`npm package manifest is missing required release file '${required}'`);
  }

  const files = [];
  const sourceByteLimit = Math.min(MAX_SOURCE_BYTES, options.maxSourceBytes ?? MAX_SOURCE_BYTES);
  if (!Number.isSafeInteger(sourceByteLimit) || sourceByteLimit < 1) throw new TypeError("Release source byte limit is invalid");
  let sourceBytes = 0;
  for (const relativePath of selectedPaths) {
    const absolutePath = resolveInside(root, relativePath);
    let bytes;
    try {
      bytes = await readStableRegularFile(absolutePath, { maxBytes: sourceByteLimit - sourceBytes });
    } catch (error) {
      if (error?.code === "release-source-too-large") throw new Error(`Release source exceeds ${sourceByteLimit} bytes`);
      throw new Error(`Release input '${relativePath}' is not a regular file`);
    }
    sourceBytes += bytes.byteLength;
    if (sourceBytes > sourceByteLimit) throw new Error(`Release source exceeds ${sourceByteLimit} bytes`);
    if (relativePath !== RELEASE_PUBLIC_KEY_RELATIVE_PATH && containsPrivateKeyMaterial(bytes)) {
      throw new Error("Release package contains prohibited private key material");
    }
    files.push({ path: relativePath, bytes });
  }

  const identity = validateReleaseIdentity(files);
  const version = identity.version;
  const names = canonicalReleaseNames(version);
  const archiveBytes = createTarGzip(names.rootName, files);
  if (archiveBytes.byteLength > MAX_BUNDLE_BYTES) throw new Error("Release bundle exceeds installer download limit");
  const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
  const manifest = `${archiveSha256}  ${names.archiveName}\n`;
  const signature = options.signingPrivateKeyPath === undefined
    ? undefined
    : await signManifest(Buffer.from(manifest), options.signingPrivateKeyPath, root, identity.publicKey);

  const outputParent = resolve(outputDirectory, "..");
  await mkdir(outputParent, { recursive: true, mode: 0o755 });
  const parentInfo = await lstat(outputParent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Release output parent is not a regular directory");
  const stagingDirectory = await mkdtemp(join(outputParent, ".threadspan-release-"));
  let published = false;
  try {
    await writeFile(join(stagingDirectory, names.archiveName), archiveBytes, { flag: "wx", mode: 0o644 });
    await writeFile(join(stagingDirectory, names.manifestName), manifest, { encoding: "utf8", flag: "wx", mode: 0o644 });
    if (signature) await writeFile(join(stagingDirectory, names.signatureName), signature, { flag: "wx", mode: 0o644 });
    await rename(stagingDirectory, outputDirectory);
    published = true;
  } finally {
    if (!published) await rm(stagingDirectory, { recursive: true, force: true });
  }
  const archivePath = join(outputDirectory, names.archiveName);
  const manifestPath = join(outputDirectory, names.manifestName);
  const signaturePath = signature ? join(outputDirectory, names.signatureName) : undefined;

  return Object.freeze({
    ...names,
    version,
    archivePath,
    manifestPath,
    signaturePath,
    archiveSha256,
    fileCount: files.length,
  });
}

async function signManifest(manifestBytes, privateKeyPath, root, shippedPublicKey) {
  if (typeof privateKeyPath !== "string" || !privateKeyPath || !isAbsolute(privateKeyPath)) {
    throw new TypeError("Signing requires an explicit absolute external private-key path");
  }
  const keyPath = resolve(privateKeyPath);
  const rel = relative(root, keyPath);
  if (!rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new TypeError("Signing private key must be stored outside the Threadspan source tree");
  }
  let keyBytes;
  try {
    keyBytes = await readStableRegularFile(keyPath, { ownerOnly: true, maxBytes: 1024 * 1024 });
  } catch {
    throw new Error("Unable to read an owner-only external release signing key");
  }
  try {
    const keyText = keyBytes.toString("utf8").trim();
    if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----$/u.test(keyText)) {
      throw new Error("unsupported private-key encoding");
    }
    const key = createPrivateKey(keyBytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    const derivedPublicKey = createPublicKey(key).export({ type: "spki", format: "der" });
    const expectedPublicKey = shippedPublicKey.export({ type: "spki", format: "der" });
    if (!derivedPublicKey.equals(expectedPublicKey)) throw new Error("public key mismatch");
    return signBytes(null, manifestBytes, key);
  } catch {
    throw new Error("External release signing key does not match the shipped Ed25519 public key");
  }
}

function validateReleaseIdentity(files) {
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  const packageJson = JSON.parse(byPath.get("package.json").toString("utf8"));
  if (packageJson.name !== "threadspan") throw new TypeError("package.json must identify threadspan");
  const version = normalizeVersion(packageJson.version);
  const readme = byPath.get("README.md").toString("utf8");
  if (!readme.includes(OFFICIAL_REPOSITORY_URL)) throw new Error("README.md does not identify the official Threadspan repository");
  try {
    const keyBytes = byPath.get(RELEASE_PUBLIC_KEY_RELATIVE_PATH);
    if (containsPrivateKeyMaterial(keyBytes)) throw new Error("private key material");
    const key = createPublicKey(keyBytes);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
    return Object.freeze({ version, publicKey: key });
  } catch {
    throw new Error(`Required release file '${RELEASE_PUBLIC_KEY_RELATIVE_PATH}' is not a valid Ed25519 public key`);
  }
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

/** Read one stable regular-file snapshot without following a final POSIX symlink. */
async function readStableRegularFile(path, options = {}) {
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
  const beforePath = await lstat(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error("not a regular file");
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("not a regular file");
    if (options.ownerOnly === true && process.platform !== "win32" && (before.mode & 0o077n) !== 0n) {
      throw new Error("permissions are not owner-only");
    }
    if (options.maxBytes !== undefined && (options.maxBytes < 0 || before.size > BigInt(options.maxBytes))) {
      const error = new Error("file exceeds byte limit");
      error.code = "release-source-too-large";
      throw error;
    }
    const bytes = await handle.readFile();
    const [after, afterPath] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!sameStableFile(before, after) || !sameStableFile(before, beforePath) || !sameStableFile(before, afterPath)) {
      throw new Error("file changed while being read");
    }
    if (BigInt(bytes.byteLength) !== before.size) throw new Error("file size changed while being read");
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

function isForbiddenKeyMaterialPath(relativePath) {
  const normalized = normalizePortableReleasePath(relativePath);
  if (normalized === RELEASE_PUBLIC_KEY_RELATIVE_PATH) return false;
  const name = normalized.toLowerCase().split("/").at(-1);
  return SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))
    || name === "id_rsa"
    || name === "id_ed25519"
    || name.startsWith("id_");
}

/** Read npm's package manifest through the same shell-free managed command path used by releases. */
export async function readNpmPacklist(root, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NPM_PACK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_NPM_PACK_TIMEOUT_MS) {
    throw new TypeError(`npm pack timeout must be between 1 and ${MAX_NPM_PACK_TIMEOUT_MS} ms`);
  }
  const prefixArgs = options.prefixArgs ?? [];
  if (!Array.isArray(prefixArgs) || prefixArgs.length > 16 || prefixArgs.some((value) => (
    typeof value !== "string" || value.length === 0 || value.length > 2048 || value.includes("\0")
  ))) throw new TypeError("npm pack command prefix arguments are invalid");
  const cache = await mkdtemp(join(tmpdir(), "threadspan-release-npm-"));
  try {
    let result;
    try {
      const environment = {
        ...(options.environment ?? process.env),
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      };
      const executable = await resolveExecutablePath(options.command ?? "npm", {
        cwd: root,
        environment,
      });
      if (typeof executable !== "string" || !executable) throw new Error("npm executable was not found");
      const invocation = normalizeManagedCommand(executable, [
        ...prefixArgs,
        "pack",
        "--dry-run",
        "--json",
        "--ignore-scripts",
        "--cache",
        cache,
      ], { environment });
      result = await runCapturedProcess({
        command: invocation.command,
        args: invocation.args,
        cwd: root,
        shell: false,
        windowsHide: true,
        maxStdoutBytes: 16 * 1024 * 1024,
        maxStderrBytes: 64 * 1024,
        timeoutMs,
        killTree: true,
        env: environment,
      });
    } catch (error) {
      if (error?.kind === "timeout") {
        throw new Error(`npm pack timed out after ${timeoutMs} ms; its process tree was terminated`);
      }
      throw new Error("npm pack could not produce the release manifest");
    }
    if (result.exitCode !== 0) throw new Error("npm pack could not produce the release manifest");
    const { stdout } = result;
    const records = JSON.parse(stdout);
    if (!Array.isArray(records) || records.length !== 1 || !Array.isArray(records[0]?.files)) {
      throw new Error("npm pack did not return one package manifest");
    }
    const paths = records[0].files.map((entry) => normalizePortableReleasePath(entry.path));
    const portablePaths = paths.map(portablePathKey);
    if (new Set(paths).size !== paths.length || new Set(portablePaths).size !== portablePaths.length) {
      throw new Error("npm package manifest contains duplicate or cross-platform-colliding paths");
    }
    return paths;
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
}

function createTarGzip(rootName, files) {
  const directories = new Set([rootName]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${rootName}/${parts.slice(0, index).join("/")}`);
    }
  }
  const sortedDirectories = [...directories].sort(compareUtf8);
  if (sortedDirectories.length + files.length > MAX_ARCHIVE_ENTRIES) throw new Error("Release archive has too many entries");

  const chunks = [];
  for (const path of sortedDirectories) chunks.push(tarHeader(`${path}/`, 0, "5", 0o755));
  for (const file of files) {
    const path = `${rootName}/${file.path}`;
    chunks.push(tarHeader(path, file.bytes.byteLength, "0", 0o644), file.bytes);
    const padding = (512 - (file.bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function tarHeader(path, size, type, mode) {
  const header = Buffer.alloc(512);
  const split = splitUstarPath(path);
  writeText(header, 0, 100, split.name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function splitUstarPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Release path is too long for portable ustar: '${path}'`);
}

function writeText(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("Tar header text exceeds its field");
  bytes.copy(buffer, offset);
}

function writeOctal(buffer, offset, length, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Tar header number is invalid");
  const text = value.toString(8);
  if (text.length > length - 1) throw new Error("Tar header number exceeds its field");
  buffer.write(text.padStart(length - 1, "0"), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

export function normalizePortableReleasePath(value) {
  const path = String(value ?? "");
  if (!path || path.includes("\\") || path.includes("\0") || isAbsolute(path) || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Unsafe npm package path '${path}'`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe npm package path '${path}'`);
  for (const part of parts) assertPortableSegment(part, path);
  return parts.join("/");
}

function portablePathKey(path) {
  return path.split("/").map((part) => part.normalize("NFC").toLowerCase()).join("/");
}

function assertPortableSegment(segment, path) {
  if (/[\u0000-\u001f<>:"|?*]/u.test(segment) || /[ .]$/u.test(segment)) throw new Error(`Release path is not Windows-safe: '${path}'`);
  const stem = segment.split(".")[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) throw new Error(`Release path uses a Windows-reserved name: '${path}'`);
}

async function assertPathMissing(path, message) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}

function resolveInside(root, relativePath) {
  const candidate = resolve(root, ...normalizePortableReleasePath(relativePath).split("/"));
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Release path escapes source root: '${relativePath}'`);
  return candidate;
}

function relativeWithin(root, candidate) {
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

function normalizeVersion(value) {
  const version = String(value ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new TypeError(`Unsupported Threadspan version '${version}'`);
  return version;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function parseArguments(argv) {
  let outputDirectory;
  let signingPrivateKeyPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--output-dir", "-o", "--signing-key"].includes(argument)) throw new TypeError(`Unknown release option '${argument}'`);
    if (index + 1 >= argv.length) throw new TypeError(`Release option '${argument}' requires a value`);
    if (argument === "--signing-key") {
      if (signingPrivateKeyPath !== undefined) throw new TypeError("Release signing key must be provided at most once");
      signingPrivateKeyPath = argv[index + 1];
    } else {
      if (outputDirectory !== undefined) throw new TypeError("Release output directory must be provided at most once");
      outputDirectory = argv[index + 1];
    }
    index += 1;
  }
  return { outputDirectory, signingPrivateKeyPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildReleaseBundle(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`release bundle failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
