import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  inspectReleaseArchive,
  InstallerStableUpdater,
  MAX_EXPANDED_RELEASE_BYTES,
  parseChecksumManifest,
  RELEASE_PUBLIC_KEY_RELATIVE_PATH,
  runInstallerCommand,
  selectLatestStableRelease,
  validatePortableArchiveEntries,
  verifyResumeCapsule,
} from "../src/installer/update-check.mjs";

const archiveBytes = Buffer.from("synthetic verified Threadspan release archive");
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const releaseSigner = generateKeyPairSync("ed25519");

function checksumManifest(checksum = archiveSha256) {
  return `${checksum}  threadspan-0.5.0.tar.gz\n`;
}

function manifestSignature(manifest, privateKey = releaseSigner.privateKey) {
  return sign(null, Buffer.from(manifest), privateKey);
}

async function writeReleaseAsset(url, path, options = {}) {
  const manifest = options.manifest ?? checksumManifest();
  if (url.endsWith("SHA256SUMS.sig")) return writeFile(path, options.signature ?? manifestSignature(manifest));
  if (url.endsWith("SHA256SUMS")) return writeFile(path, manifest);
  return writeFile(path, options.archive ?? archiveBytes);
}

async function temporaryRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-stable-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeSourceRoot(root, version) {
  await Promise.all([
    mkdir(join(root, "ui"), { recursive: true }),
    mkdir(join(root, "src", "installer"), { recursive: true }),
  ]);
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "threadspan", version })}\n`);
  await writeFile(join(root, "README.md"), "https://github.com/HaileyStorm/threadspan\n");
  await Promise.all([
    writeFile(join(root, "ui", "install.html"), `<p>Threadspan ${version}</p>`),
    writeFile(join(root, "ui", "install.css"), `/* Threadspan ${version} */`),
    writeFile(join(root, "ui", "install.js"), `globalThis.threadspanVersion=${JSON.stringify(version)};`),
    writeFile(join(root, "ui", "mark.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"),
    writeFile(
      join(root, ...RELEASE_PUBLIC_KEY_RELATIVE_PATH.split("/")),
      releaseSigner.publicKey.export({ type: "spki", format: "pem" }),
    ),
  ]);
}

function release(version, options = {}) {
  const tag = `v${version}`;
  const archiveName = `threadspan-${version}.tar.gz`;
  const manifestName = "SHA256SUMS";
  return {
    tag_name: tag,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    html_url: `https://github.com/HaileyStorm/threadspan/releases/tag/${tag}`,
    assets: [
      { name: archiveName, browser_download_url: `https://github.com/HaileyStorm/threadspan/releases/download/${tag}/${archiveName}` },
      { name: manifestName, browser_download_url: `https://github.com/HaileyStorm/threadspan/releases/download/${tag}/${manifestName}` },
      ...(options.signature === false ? [] : [{ name: "SHA256SUMS.sig", browser_download_url: `https://github.com/HaileyStorm/threadspan/releases/download/${tag}/SHA256SUMS.sig` }]),
    ],
  };
}

function fakeGitHub(releases) {
  return async () => ({ ok: true, status: 200, json: async () => releases });
}

function noGit() {
  throw new Error("not a git checkout");
}

test("stable selection excludes channels, drafts, and prereleases", () => {
  const selected = selectLatestStableRelease([
    release("9.0.0", { prerelease: true }),
    { ...release("8.0.0"), tag_name: "v8.0.0-beta.1", html_url: "https://github.com/HaileyStorm/threadspan/releases/tag/v8.0.0-beta.1" },
    release("7.0.0", { draft: true }),
    release("0.6.0"),
    release("0.5.0"),
  ]);
  assert.equal(selected.tag_name, "v0.6.0");
});

test("offline stable check is visible and leaves the current installation usable", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  let relaunched = false;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: async () => { throw new Error("offline"); },
    relaunch: async () => { relaunched = true; },
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.status, "unavailable");
  assert.equal(result.canContinueCurrent, true);
  assert.match(result.message, /offline/);
  assert.equal(relaunched, false);
  assert.equal(JSON.parse(await readFile(join(currentRoot, "package.json"))).version, "0.4.0");
});

test("a private or not-yet-released repository is not mislabeled as a GitHub outage", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "no-public-release");
  assert.match(result.message, /No public stable release/);
  assert.doesNotMatch(result.message, /unavailable|outage/i);
});

test("dirty official checkout is never fetched or changed", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const commands = [];
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: async (args) => {
      commands.push(args);
      if (args[0] === "rev-parse") return currentRoot;
      if (args[0] === "remote") return "https://github.com/HaileyStorm/threadspan.git";
      if (args[0] === "status") return " M README.md";
      throw new Error(`unexpected mutating git command: ${args.join(" ")}`);
    },
    relaunch: async () => assert.fail("dirty checkout must not relaunch"),
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "dirty-checkout");
  assert.equal(commands.some((args) => args[0] === "fetch" || args[0] === "merge"), false);
});

test("clean exact official checkout fetches and fast-forwards only to the stable tag", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const commands = [];
  let relaunch;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: async (args) => {
      commands.push(args);
      if (args[0] === "rev-parse") return currentRoot;
      if (args[0] === "remote") return "https://github.com/HaileyStorm/threadspan.git";
      if (args[0] === "status") return "";
      if (args[0] === "fetch") return "";
      if (args[0] === "show" && args[1].endsWith(":package.json")) return JSON.stringify({ name: "threadspan", version: "0.5.0" });
      if (args[0] === "show" && args[1].endsWith(":README.md")) return "https://github.com/HaileyStorm/threadspan";
      if (args[0] === "show" && args[1].endsWith(`:${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`)) return releaseSigner.publicKey.export({ type: "spki", format: "pem" });
      if (args[0] === "ls-tree") return ["package.json", "README.md", RELEASE_PUBLIC_KEY_RELATIVE_PATH, "ui/install.html", "ui/install.css", "ui/install.js", "ui/mark.svg"].join("\n");
      if (args[0] === "cat-file") return "blob";
      if (args[0] === "merge") await writeFile(join(currentRoot, "package.json"), `${JSON.stringify({ name: "threadspan", version: "0.5.0" })}\n`);
      return "";
    },
    relaunch: async (value) => { relaunch = value; return { pid: 42 }; },
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  });
  const result = await updater.checkAndUpdate({
    sessionId: "install-clean",
    nonce: "nonce-clean",
    installRoot: join(root, "install"),
    daemonBaseUrl: "http://127.0.0.1:8743",
  });
  assert.equal(result.status, "relaunching");
  assert.deepEqual(commands.find((args) => args[0] === "fetch"), ["fetch", "--no-tags", "origin", "refs/tags/v0.5.0:refs/tags/v0.5.0"]);
  assert.deepEqual(commands.find((args) => args[0] === "merge"), ["merge", "--ff-only", "refs/tags/v0.5.0"]);
  assert.ok(commands.findIndex((args) => args[0] === "show") < commands.findIndex((args) => args[0] === "merge"), "tag identity is validated before the checkout changes");
  assert.equal(relaunch.stagedRoot, currentRoot);
  assert.equal(verifyResumeCapsule(relaunch.resumeCapsule).toVersion, "0.5.0");
});

test("invalid stable Git tag is rejected before merge changes the checkout", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const commands = [];
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: async (args) => {
      commands.push(args);
      if (args[0] === "rev-parse") return currentRoot;
      if (args[0] === "remote") return "https://github.com/HaileyStorm/threadspan.git";
      if (args[0] === "status") return "";
      if (args[0] === "show" && args[1].endsWith(":package.json")) return JSON.stringify({ name: "lookalike", version: "0.5.0" });
      throw new Error("unexpected command");
    },
    relaunch: async () => assert.fail("invalid tag must not relaunch"),
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.status, "blocked");
  assert.equal(result.currentChanged, false);
  assert.equal(commands.some((args) => args[0] === "merge"), false);
});

test("stable Git tag rejects valid private-key material hidden under an ordinary filename", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const privateMaterial = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  const commands = [];
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: async (args) => {
      commands.push(args);
      if (args[0] === "rev-parse") return currentRoot;
      if (args[0] === "remote") return "https://github.com/HaileyStorm/threadspan.git";
      if (args[0] === "status") return "";
      if (args[0] === "fetch") return "";
      if (args[0] === "show" && args[1].endsWith(":package.json")) return JSON.stringify({ name: "threadspan", version: "0.5.0" });
      if (args[0] === "show" && args[1].endsWith(":README.md")) return "https://github.com/HaileyStorm/threadspan";
      if (args[0] === "show" && args[1].endsWith(":notes.txt")) return privateMaterial;
      if (args[0] === "ls-tree") return ["package.json", "README.md", RELEASE_PUBLIC_KEY_RELATIVE_PATH, "notes.txt"].join("\n");
      if (args[0] === "grep") return "refs/tags/v0.5.0:notes.txt";
      throw new Error(`unexpected command: ${args.join(" ")}`);
    },
    relaunch: async () => assert.fail("private-key-bearing tag must not relaunch"),
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.reason, "git-fast-forward-failed");
  assert.match(result.message, /notes\.txt.*private key material/);
  assert.equal(commands.some((args) => args[0] === "merge"), false);
});

test("checksum mismatch blocks extraction, execution, and relaunch", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  let extracted = false;
  let relaunched = false;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: noGit,
    releasePublicKey: releaseSigner.publicKey,
    download: async (url, path) => writeReleaseAsset(url, path, { manifest: checksumManifest("0".repeat(64)) }),
    extractArchive: async () => { extracted = true; },
    relaunch: async () => { relaunched = true; },
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "checksum-mismatch");
  assert.equal(extracted, false);
  assert.equal(relaunched, false);
});

test("checksum validation and extraction consume one immutable archive snapshot despite path replacement", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  let downloadedArchivePath;
  let extractedSnapshot;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: noGit,
    releasePublicKey: releaseSigner.publicKey,
    download: async (url, path) => {
      await writeReleaseAsset(url, path);
      if (url.endsWith(".tar.gz")) downloadedArchivePath = path;
    },
    inspectArchive: async (snapshot) => {
      assert.deepEqual(snapshot, archiveBytes);
      await writeFile(downloadedArchivePath, Buffer.from("same-owner replacement after checksum"));
      return true;
    },
    extractArchive: async (snapshot, destination) => {
      extractedSnapshot = Buffer.from(snapshot);
      await writeSourceRoot(join(destination, "threadspan-0.5.0"), "0.5.0");
    },
    relaunch: async () => ({ pid: 88 }),
  });
  const result = await updater.checkAndUpdate({
    sessionId: "snapshot",
    nonce: "snapshot-nonce",
    installRoot: join(root, "install"),
    daemonBaseUrl: "http://127.0.0.1:8743",
  });
  assert.equal(result.status, "relaunching");
  assert.deepEqual(extractedSnapshot, archiveBytes);
});

test("owner-local staging rejects a symbolic-link redirect", { skip: process.platform === "win32" }, async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  const outside = join(root, "outside");
  await Promise.all([writeSourceRoot(currentRoot, "0.4.0"), mkdir(outside)]);
  await symlink(outside, join(root, "staging"), "dir");
  let downloaded = false;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging", "releases"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: noGit,
    download: async () => { downloaded = true; },
    relaunch: async () => assert.fail("redirected staging must not relaunch"),
  });
  const result = await updater.checkAndUpdate({});
  assert.equal(result.status, "blocked");
  assert.match(result.message, /link or non-directory/);
  assert.equal(downloaded, false);
});

test("verified bundle stages side-by-side and relaunches with a bounded resume capsule", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  let relaunch;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: noGit,
    releasePublicKey: releaseSigner.publicKey,
    download: writeReleaseAsset,
    inspectArchive: async () => true,
    extractArchive: async (_archive, destination) => writeSourceRoot(join(destination, "threadspan-0.5.0"), "0.5.0"),
    relaunch: async (value) => { relaunch = value; return { pid: 77 }; },
    now: () => new Date("2026-08-17T00:00:00.000Z"),
  });
  const result = await updater.checkAndUpdate({
    sessionId: "install-bundle",
    nonce: "nonce-bundle",
    installRoot: join(root, "install"),
    daemonBaseUrl: "http://127.0.0.1:8743",
  });
  assert.equal(result.status, "relaunching");
  assert.equal(result.sourceKind, "verified-release-bundle");
  assert.match(relaunch.stagedRoot, /threadspan-0\.5\.0-[0-9a-f]{12}$/);
  assert.equal(JSON.parse(await readFile(join(relaunch.stagedRoot, "package.json"))).version, "0.5.0");
  assert.equal(JSON.parse(await readFile(join(currentRoot, "package.json"))).version, "0.4.0");
  assert.equal(Object.keys(relaunch.verifiedAssets).length, 4);
  const capsule = verifyResumeCapsule(relaunch.resumeCapsule);
  assert.equal(capsule.sessionId, "install-bundle");
  assert.equal(capsule.toVersion, "0.5.0");
  assert.equal("tasks" in capsule || "credentials" in capsule, false);
  const resumed = await updater.checkAndUpdate({ currentRoot: result.preparedRoot });
  assert.equal(resumed.status, "current");
  assert.equal(resumed.currentVersion, "0.5.0");
});

test("default archive preflight and native extraction consume a canonical stdin snapshot", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const canonicalArchive = createTarGzip([
    { path: "threadspan-0.5.0/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/package.json", type: "0", data: Buffer.from(`${JSON.stringify({ name: "threadspan", version: "0.5.0" })}\n`) },
    { path: "threadspan-0.5.0/README.md", type: "0", data: Buffer.from("https://github.com/HaileyStorm/threadspan\n") },
    { path: "threadspan-0.5.0/src/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/src/installer/", type: "5", size: 0 },
    { path: `threadspan-0.5.0/${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`, type: "0", data: releaseSigner.publicKey.export({ type: "spki", format: "pem" }) },
    { path: "threadspan-0.5.0/ui/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/ui/install.html", type: "0", data: Buffer.from("<p>Threadspan 0.5.0</p>") },
    { path: "threadspan-0.5.0/ui/install.css", type: "0", data: Buffer.from("/* Threadspan 0.5.0 */") },
    { path: "threadspan-0.5.0/ui/install.js", type: "0", data: Buffer.from("globalThis.threadspanVersion='0.5.0';") },
    { path: "threadspan-0.5.0/ui/mark.svg", type: "0", data: Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>") },
  ]);
  const checksum = createHash("sha256").update(canonicalArchive).digest("hex");
  const manifest = checksumManifest(checksum);
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: noGit,
    releasePublicKey: releaseSigner.publicKey,
    download: (url, path) => writeReleaseAsset(url, path, {
      archive: canonicalArchive,
      manifest,
      signature: manifestSignature(manifest),
    }),
    relaunch: async () => ({ pid: 99 }),
  });
  const result = await updater.checkAndUpdate({
    sessionId: "native-tar",
    nonce: "native-tar-nonce",
    installRoot: join(root, "install"),
    daemonBaseUrl: "http://127.0.0.1:8743",
  });
  assert.equal(result.status, "relaunching");
  assert.equal(JSON.parse(await readFile(join(result.preparedRoot, "package.json"), "utf8")).version, "0.5.0");
});

test("checksum parser requires one exact filename", () => {
  assert.equal(parseChecksumManifest(`${archiveSha256}  threadspan-0.5.0.tar.gz\n`, "threadspan-0.5.0.tar.gz"), archiveSha256);
  assert.throws(() => parseChecksumManifest(`${archiveSha256}  other.tar.gz\n`, "threadspan-0.5.0.tar.gz"), /does not name/);
});

test("release bundles fail closed when unsigned, signed by the wrong key, or manifest-tampered", async (t) => {
  const wrongSigner = generateKeyPairSync("ed25519");
  for (const scenario of ["unsigned", "wrong-signer", "tampered"]) {
    await t.test(scenario, async (st) => {
      const root = await temporaryRoot(st);
      const currentRoot = join(root, "current");
      await writeSourceRoot(currentRoot, "0.4.0");
      let archiveDownloaded = false;
      const original = checksumManifest();
      const delivered = scenario === "tampered" ? checksumManifest("f".repeat(64)) : original;
      const signature = manifestSignature(original, scenario === "wrong-signer" ? wrongSigner.privateKey : releaseSigner.privateKey);
      const updater = new InstallerStableUpdater({
        currentRoot,
        ownerRoot: root,
        stagingRoot: join(root, "staging"),
        fetchImpl: fakeGitHub([release("0.5.0", { signature: scenario !== "unsigned" })]),
        runGit: noGit,
        releasePublicKey: releaseSigner.publicKey,
        download: async (url, path) => {
          if (url.endsWith(".tar.gz")) archiveDownloaded = true;
          return writeReleaseAsset(url, path, { manifest: delivered, signature });
        },
        extractArchive: async () => assert.fail("unauthenticated release must not extract"),
        relaunch: async () => assert.fail("unauthenticated release must not relaunch"),
      });
      const result = await updater.checkAndUpdate({});
      assert.equal(result.status, "blocked");
      assert.equal(result.reason, "publisher-authenticity-failed");
      assert.equal(result.canContinueCurrent, true);
      assert.equal(archiveDownloaded, false, "archive is not downloaded before publisher authentication");
    });
  }
});

test("release discovery and every asset download have phase-specific timeouts", async (t) => {
  const discoveryRoot = await temporaryRoot(t);
  await writeSourceRoot(join(discoveryRoot, "current"), "0.4.0");
  const discovery = new InstallerStableUpdater({
    currentRoot: join(discoveryRoot, "current"),
    ownerRoot: discoveryRoot,
    stagingRoot: join(discoveryRoot, "staging"),
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })),
    timeouts: { releaseDiscoveryMs: 10 },
  });
  const discoveryResult = await discovery.checkAndUpdate({});
  assert.equal(discoveryResult.reason, "release-discovery-timeout");
  assert.equal(discoveryResult.canContinueCurrent, true);

  for (const [phase, suffix, timeoutName] of [
    ["manifest-download", "SHA256SUMS", "manifestDownloadMs"],
    ["signature-download", "SHA256SUMS.sig", "signatureDownloadMs"],
    ["archive-download", ".tar.gz", "archiveDownloadMs"],
  ]) {
    await t.test(phase, async (st) => {
      const root = await temporaryRoot(st);
      const currentRoot = join(root, "current");
      await writeSourceRoot(currentRoot, "0.4.0");
      const updater = new InstallerStableUpdater({
        currentRoot,
        ownerRoot: root,
        stagingRoot: join(root, "staging"),
        fetchImpl: fakeGitHub([release("0.5.0")]),
        runGit: noGit,
        releasePublicKey: releaseSigner.publicKey,
        timeouts: { [timeoutName]: 10 },
        download: async (url, path, options) => {
          if (url.endsWith(suffix)) {
            return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
          }
          return writeReleaseAsset(url, path);
        },
      });
      const result = await updater.checkAndUpdate({});
      assert.equal(result.reason, `${phase}-timeout`);
      assert.equal(result.canContinueCurrent, true);
    });
  }
});

test("archive listing and extraction have deterministic phase timeouts", async (t) => {
  for (const [phase, timeoutName] of [
    ["archive-listing", "archiveListingMs"],
    ["archive-extraction", "archiveExtractionMs"],
  ]) {
    await t.test(phase, async (st) => {
      const root = await temporaryRoot(st);
      const currentRoot = join(root, "current");
      await writeSourceRoot(currentRoot, "0.4.0");
      let relaunched = false;
      let terminationSettled = false;
      const settlesAfterAbort = (...args) => new Promise((_resolve, reject) => {
        const options = args.at(-1);
        options.signal.addEventListener("abort", () => {
          setTimeout(() => {
            terminationSettled = true;
            reject(options.signal.reason);
          }, 20);
        }, { once: true });
      });
      const updater = new InstallerStableUpdater({
        currentRoot,
        ownerRoot: root,
        stagingRoot: join(root, "staging"),
        fetchImpl: fakeGitHub([release("0.5.0")]),
        runGit: noGit,
        releasePublicKey: releaseSigner.publicKey,
        download: writeReleaseAsset,
        inspectArchive: phase === "archive-listing" ? settlesAfterAbort : async () => true,
        extractArchive: phase === "archive-extraction" ? settlesAfterAbort : async () => assert.fail("timed-out listing must not extract"),
        timeouts: { [timeoutName]: 10 },
        relaunch: async () => { relaunched = true; },
      });
      const result = await updater.checkAndUpdate({});
      assert.equal(result.reason, `${phase}-timeout`);
      assert.equal(result.canContinueCurrent, true);
      assert.equal(relaunched, false);
      assert.equal(terminationSettled, true, "timeout must await the phase's settled termination before cleanup returns");
    });
  }
});

test("parent cancellation stops archive listing before extraction or relaunch", async (t) => {
  const root = await temporaryRoot(t);
  const currentRoot = join(root, "current");
  await writeSourceRoot(currentRoot, "0.4.0");
  const controller = new AbortController();
  let listingStarted;
  const started = new Promise((resolve) => { listingStarted = resolve; });
  let listingSettled = false;
  let extracted = false;
  let relaunched = false;
  const updater = new InstallerStableUpdater({
    currentRoot,
    ownerRoot: root,
    stagingRoot: join(root, "staging"),
    fetchImpl: fakeGitHub([release("0.5.0")]),
    runGit: noGit,
    releasePublicKey: releaseSigner.publicKey,
    download: writeReleaseAsset,
    inspectArchive: (_archive, options) => new Promise((_resolve, reject) => {
      listingStarted();
      options.signal.addEventListener("abort", () => setTimeout(() => {
        listingSettled = true;
        reject(options.signal.reason);
      }, 20), { once: true });
    }),
    extractArchive: async () => { extracted = true; },
    relaunch: async () => { relaunched = true; },
  });
  const operation = updater.checkAndUpdate({ signal: controller.signal });
  await started;
  controller.abort();
  const result = await operation;
  assert.equal(result.reason, "client-disconnected");
  assert.equal(listingSettled, true, "cancellation must await settled phase termination");
  assert.equal(extracted, false);
  assert.equal(relaunched, false);
});

test("installer subprocess cancellation terminates its descendant process tree", async (t) => {
  const root = await temporaryRoot(t);
  const pidPath = join(root, "descendant.pid");
  const source = [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const controller = new AbortController();
  const operation = runInstallerCommand(process.execPath, ["-e", source], {
    signal: controller.signal,
    timeoutMs: 5_000,
  });
  const descendantPid = Number(await waitForFile(pidPath));
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  controller.abort();
  await assert.rejects(operation, /Installer client disconnected/);
  await waitForProcessExit(descendantPid);
});

test("installer subprocess timeout awaits descendant process-tree termination", async (t) => {
  const root = await temporaryRoot(t);
  const pidPath = join(root, "timeout-descendant.pid");
  const source = [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
    `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const operation = runInstallerCommand(process.execPath, ["-e", source], { timeoutMs: 100 });
  const descendantPid = Number(await waitForFile(pidPath));
  await assert.rejects(operation, /timed out/i);
  await waitForProcessExit(descendantPid);
});

test("strict archive preflight rejects links and expanded-size bombs before native tar", async (t) => {
  const root = await temporaryRoot(t);
  const archivePath = join(root, "threadspan-0.5.0.tar.gz");
  const neverList = async () => assert.fail("unsafe archive must fail before native tar listing");
  for (const type of ["1", "2"]) {
    await writeFile(archivePath, createTarGzip([
      { path: "threadspan-0.5.0/", type: "5", size: 0 },
      { path: `threadspan-0.5.0/link-${type}`, type, size: 0 },
    ]));
    await assert.rejects(inspectReleaseArchive(archivePath, {
      expectedRootName: "threadspan-0.5.0",
      runCommand: neverList,
    }), /symbolic link, hard link, or special entry/);
  }

  await writeFile(archivePath, createInvalidUtf8TarGzip());
  await assert.rejects(inspectReleaseArchive(archivePath, {
    expectedRootName: "threadspan-0.5.0",
    runCommand: neverList,
  }), /path is not valid UTF-8/);

  await writeFile(archivePath, createTarGzip([
    { path: "threadspan-0.5.0/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/src/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/src/installer/", type: "5", size: 0 },
    { path: `threadspan-0.5.0/${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`, type: "0", size: 0 },
    { path: "threadspan-0.5.0/extra.pem", type: "0", size: 0 },
  ]));
  await assert.rejects(inspectReleaseArchive(archivePath, {
    expectedRootName: "threadspan-0.5.0",
    runCommand: neverList,
  }), /forbidden key material 'extra\.pem'/);

  await writeFile(archivePath, createTarGzip([
    { path: "threadspan-0.5.0/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/bomb.bin", type: "0", size: MAX_EXPANDED_RELEASE_BYTES + 1, omitData: true },
  ]));
  await assert.rejects(inspectReleaseArchive(archivePath, {
    expectedRootName: "threadspan-0.5.0",
    runCommand: neverList,
  }), /expanded regular-file size/);

  await writeFile(archivePath, createTarGzip([
    { path: "threadspan-0.5.0/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/padding.bin", type: "0", size: 2048 },
  ]));
  await assert.rejects(inspectReleaseArchive(archivePath, {
    expectedRootName: "threadspan-0.5.0",
    maxInflatedTarBytes: 1024,
    runCommand: neverList,
  }), /expanded tar size/);
});

test("strict archive preflight rejects concealed private-key encodings before native tar", async (t) => {
  const root = await temporaryRoot(t);
  const archivePath = join(root, "threadspan-0.5.0.tar.gz");
  const { privateKey } = generateKeyPairSync("ed25519");
  const encrypted = privateKey.export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: "archive-passphrase-must-not-print",
  });
  const cases = [
    ["encrypted", encrypted],
    ["openssh", Buffer.from(openSshPrivateKeyFixture())],
    ["der", privateKey.export({ type: "pkcs8", format: "der" })],
  ];
  for (const [name, privateBytes] of cases) {
    await writeFile(archivePath, createTarGzip([
      { path: "threadspan-0.5.0/", type: "5", size: 0 },
      { path: "threadspan-0.5.0/src/", type: "5", size: 0 },
      { path: "threadspan-0.5.0/src/installer/", type: "5", size: 0 },
      { path: `threadspan-0.5.0/${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`, type: "0", data: Buffer.alloc(0) },
      { path: `threadspan-0.5.0/src/ordinary-${name}.dat`, type: "0", data: privateBytes },
    ]));
    await assert.rejects(
      inspectReleaseArchive(archivePath, {
        expectedRootName: "threadspan-0.5.0",
        runCommand: async () => assert.fail("private material must fail before native tar"),
      }),
      (error) => {
        assert.match(error.message, /prohibited private key material/);
        assert.equal(error.message.includes(`ordinary-${name}`), false);
        assert.equal(error.message.includes("archive-passphrase-must-not-print"), false);
        return true;
      },
    );
  }
});

test("strict archive preflight enforces canonical portable UID, GID, mode, and mtime", async (t) => {
  const root = await temporaryRoot(t);
  const archivePath = join(root, "threadspan-0.5.0.tar.gz");
  for (const metadata of [{ uid: 1 }, { gid: 1 }, { mode: 0o777 }, { mtime: 1 }]) {
    await writeFile(archivePath, createTarGzip([
      { path: "threadspan-0.5.0/", type: "5", size: 0, ...metadata },
    ]));
    await assert.rejects(inspectReleaseArchive(archivePath, {
      expectedRootName: "threadspan-0.5.0",
      runCommand: async () => assert.fail("non-portable metadata must fail before native tar"),
    }), /canonical portable UID, GID, mode, or mtime bounds/);
  }
});

test("native tar listing consumes the exact preflighted bytes through stdin", async () => {
  const archive = createTarGzip([
    { path: "threadspan-0.5.0/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/src/", type: "5", size: 0 },
    { path: "threadspan-0.5.0/src/installer/", type: "5", size: 0 },
    { path: `threadspan-0.5.0/${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`, type: "0", data: Buffer.alloc(0) },
  ]);
  let consumed;
  await inspectReleaseArchive(archive, {
    expectedRootName: "threadspan-0.5.0",
    runCommand: async (command, args, options) => {
      assert.equal(command, "tar");
      assert.deepEqual(args, ["-tzf", "-"]);
      consumed = Buffer.from(options.stdin);
      return "";
    },
  });
  assert.deepEqual(consumed, archive);
});

test("archive extraction rejects every non-portable path class and casefold collisions", () => {
  for (const entries of [
    ["/absolute/file"],
    ["C:/drive/file"],
    ["root/../escape"],
    ["root\\backslash"],
    ["root/file:stream"],
    ["root/trailing. "],
    ["root/CON.txt"],
    ["root/File.txt", "root/file.TXT"],
    ["root/caf\u00e9.txt", "root/cafe\u0301.txt"],
    ["root/file", "root/file/child"],
  ]) assert.throws(() => validatePortableArchiveEntries(entries), /unsafe|Windows|colliding|escapes|regular file/i, entries.join(","));
  assert.throws(
    () => validatePortableArchiveEntries(Array.from({ length: 30_001 }, (_value, index) => `root/file-${index}`)),
    /entry count/,
  );
  assert.throws(
    () => validatePortableArchiveEntries(["root/", "root/implicit/parents/file.txt"]),
    /explicit parent directory/,
  );
  assert.equal(validatePortableArchiveEntries(["threadspan-0.5.0/", "threadspan-0.5.0/src/", "threadspan-0.5.0/src/index.mjs"]), true);
});

test("installer UI makes stable update the first state and keeps manual Check again", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("../ui/install.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/install.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-installer-first-state="stable-update"/);
  assert.match(html, /Step 1 of 6/);
  assert.match(source, /^const stepDefs=\[\n\s+\["Update","Checking for updates"/);
  assert.match(source, />Check again</);
  assert.match(source, /state\.bootstrap=await api\("bootstrap"\)/);
  assert.match(source, /Continue current/);
  assert.match(source, /await makePlan\(\);state\.taskReceipt=await api\("protect"/);
  assert.match(source, /function invalidatePlan\(\)/);
  for (const phrase of ["Coming next", "Roadmap, not current functionality", "provider-aware Continuity handoffs", "richer reverse-host parity", "more provider adapters", "smarter availability and utilization planning", "awesome, sleek, effective memory system"]) {
    assert.match(source, new RegExp(phrase));
  }
});

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for '${path}'`);
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} survived bounded process-tree termination`);
}

function createTarGzip(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = entry.data === undefined ? undefined : Buffer.from(entry.data);
    const size = entry.size ?? data?.byteLength ?? 0;
    chunks.push(createTarHeader(entry.path, size, entry.type, entry));
    if (!entry.omitData && size > 0) {
      if (data && data.byteLength !== size) throw new Error("test tar data size mismatch");
      chunks.push(data ?? Buffer.alloc(size));
      const padding = (512 - (size % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: 9, mtime: 0 });
}

function createInvalidUtf8TarGzip() {
  const root = createTarHeader("threadspan-0.5.0/", 0, "5");
  const invalid = createTarHeader("threadspan-0.5.0/invalid.txt", 0, "0");
  const invalidOffset = invalid.indexOf(Buffer.from("invalid", "utf8"));
  invalid[invalidOffset] = 0xff;
  writeTarChecksum(invalid);
  return gzipSync(Buffer.concat([root, invalid, Buffer.alloc(1024)]), { level: 9, mtime: 0 });
}

function createTarHeader(path, size, type, metadata = {}) {
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, path);
  writeTarOctal(header, 100, 8, metadata.mode ?? (type === "5" ? 0o755 : 0o644));
  writeTarOctal(header, 108, 8, metadata.uid ?? 0);
  writeTarOctal(header, 116, 8, metadata.gid ?? 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, metadata.mtime ?? 0);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  writeTarChecksum(header);
  return header;
}

function writeTarChecksum(header) {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
}

function writeTarText(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("test tar path is too long");
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  buffer.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function openSshPrivateKeyFixture() {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const payload = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "ascii"),
    sshString("none"),
    sshString("none"),
    sshString(Buffer.alloc(0)),
    count,
    sshString("synthetic-public-key"),
    sshString("synthetic-private-block"),
  ]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${payload.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
