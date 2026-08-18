import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  buildReleaseBundle,
  canonicalReleaseNames,
  isReleaseExcluded,
  normalizePortableReleasePath,
  readNpmPacklist,
  RELEASE_PUBLIC_KEY_RELATIVE_PATH,
} from "../scripts/release-bundle.mjs";
import {
  inspectReleaseArchive,
  loadReleasePublicKey,
  verifyChecksumManifestSignature,
} from "../src/installer/update-check.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_GUI = ["ui/install.html", "ui/install.css", "ui/install.js", "ui/mark.svg"];
const gitFixtureRoots = new Set();

test("release bundle is canonical, deterministic, excluded, and installer-extractable", async (t) => {
  const root = await createFixture(t);
  const firstParent = await mkdtemp(join(tmpdir(), "threadspan-release-first-"));
  const secondParent = await mkdtemp(join(tmpdir(), "threadspan-release-second-"));
  const firstOutput = join(firstParent, "release");
  const secondOutput = join(secondParent, "release");
  t.after(() => Promise.all([
    rm(firstParent, { recursive: true, force: true }),
    rm(secondParent, { recursive: true, force: true }),
  ]));

  const first = await buildReleaseBundle({ root, outputDirectory: firstOutput });
  const second = await buildReleaseBundle({ root, outputDirectory: secondOutput });
  assert.deepEqual(canonicalReleaseNames("1.2.3"), {
    archiveName: "threadspan-1.2.3.tar.gz",
    manifestName: "SHA256SUMS",
    signatureName: "SHA256SUMS.sig",
    rootName: "threadspan-1.2.3",
  });
  assert.equal(first.archiveName, "threadspan-1.2.3.tar.gz");
  assert.equal(first.manifestName, "SHA256SUMS");
  assert.equal(first.signatureName, "SHA256SUMS.sig");
  assert.equal(first.signaturePath, undefined);
  const sourceCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  assert.equal(first.sourceCommit, sourceCommit);
  assert.deepEqual(first.metadata, {
    ...canonicalReleaseNames("1.2.3"),
    version: "1.2.3",
    sourceCommit,
    archiveSha256: first.archiveSha256,
    fileCount: first.fileCount,
    signed: false,
  });
  assert.equal(JSON.stringify(first.metadata).includes(root), false);
  assert.equal(JSON.stringify(first.metadata).includes(firstParent), false);

  const [firstArchive, secondArchive, firstManifest, secondManifest] = await Promise.all([
    readFile(first.archivePath),
    readFile(second.archivePath),
    readFile(first.manifestPath, "utf8"),
    readFile(second.manifestPath, "utf8"),
  ]);
  assert.deepEqual(firstArchive, secondArchive);
  assert.equal(firstManifest, secondManifest);
  const independentSha256 = createHash("sha256").update(firstArchive).digest("hex");
  assert.equal(first.archiveSha256, independentSha256);
  assert.equal(
    firstManifest,
    `${first.archiveSha256}  threadspan-1.2.3.tar.gz\n# threadspan-source-commit ${sourceCommit}\n`,
  );
  assert.equal(firstArchive.readUInt32LE(4), 0, "gzip mtime must be zero");

  const headers = readTarHeaders(firstArchive);
  assert.ok(headers.length > 6);
  assert.equal(headers.every((header) => header.path.startsWith("threadspan-1.2.3/")), true);
  assert.equal(headers.every((header) => header.uid === 0 && header.gid === 0 && header.mtime === 0), true);
  assert.equal(headers.every((header) => header.uname === "" && header.gname === ""), true);
  assert.equal(headers.every((header) => header.type === "0" || header.type === "5"), true);
  assert.equal(headers.every((header) => header.mode === (header.type === "5" ? 0o755 : 0o644)), true);
  const archivedPaths = headers.map((header) => header.path);
  const archivedPublicKeyPath = `threadspan-1.2.3/${RELEASE_PUBLIC_KEY_RELATIVE_PATH}`;
  assert.deepEqual(archivedPaths.filter((path) => path.toLowerCase().endsWith(".pem")), [archivedPublicKeyPath]);
  for (const forbidden of [".working", ".git", "node_modules", ".env.production", "credentials.json", "secrets.json", "id_ecdsa", "secret.pem", "rollbacks", "evidence", ".threadspan", "User Data", "tool.exe"]) {
    assert.equal(archivedPaths.some((path) => path.includes(forbidden)), false, `${forbidden} must be excluded`);
  }

  const { stdout } = await execFileAsync("tar", ["-tzf", first.archivePath]);
  const listed = stdout.trim().split(/\r?\n/);
  assert.deepEqual(listed, archivedPaths);
  const extracted = await mkdtemp(join(tmpdir(), "threadspan-release-extracted-"));
  t.after(() => rm(extracted, { recursive: true, force: true }));
  await execFileAsync("tar", ["-xzf", first.archivePath, "-C", extracted, "--no-same-owner", "--no-same-permissions"]);
  const extractedRoot = join(extracted, "threadspan-1.2.3");
  const identity = JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8"));
  assert.equal(identity.name, "threadspan");
  assert.equal(identity.version, "1.2.3");
  assert.equal((await lstat(join(extractedRoot, "src", "cli.mjs"))).isFile(), true);
  assert.match(await readFile(join(extractedRoot, "README.md"), "utf8"), /https:\/\/github\.com\/HaileyStorm\/threadspan/);
  assert.deepEqual(
    await readFile(join(extractedRoot, ...RELEASE_PUBLIC_KEY_RELATIVE_PATH.split("/"))),
    await readFile(join(root, ...RELEASE_PUBLIC_KEY_RELATIVE_PATH.split("/"))),
  );
  assert.equal((await loadReleasePublicKey(extractedRoot)).asymmetricKeyType, "ed25519");
  for (const relativePath of REQUIRED_GUI) {
    const info = await lstat(join(extractedRoot, ...relativePath.split("/")));
    assert.equal(info.isFile(), true);
    assert.equal(info.isSymbolicLink(), false);
  }
});

test("release exclusions cover credentials, sentinels, rollback evidence, host state, and executables", () => {
  for (const path of [
    ".git/config",
    "src/.working",
    "src/.working.agent",
    "src/node_modules/dependency/index.js",
    "src/.env",
    "src/.env.production",
    "src/credentials.json",
    "src/secrets.json",
    "src/private.key",
    "src/certificate.pem",
    "src/rollbacks/restore.json",
    "src/evidence/run.json",
    "src/.threadspan/state.json",
    "src/browser/User Data/Default/Cookies",
    "src/tool.exe",
    "dist/release/threadspan-1.2.3.tar.gz",
    "dist/release/SHA256SUMS",
  ]) assert.equal(isReleaseExcluded(path, { outputRelative: "dist/release" }), true, path);

  for (const path of ["src/core/auth.mjs", "src/core/session-store.mjs", "docs/SECURITY.md", "ui/install.js"]) {
    assert.equal(isReleaseExcluded(path), false, path);
  }
  assert.equal(isReleaseExcluded(RELEASE_PUBLIC_KEY_RELATIVE_PATH), false, RELEASE_PUBLIC_KEY_RELATIVE_PATH);
  assert.throws(() => canonicalReleaseNames("v1.2.3"), /Unsupported Threadspan version/);
  assert.throws(() => isReleaseExcluded("src/CON"), /Windows-reserved/);
  assert.throws(() => isReleaseExcluded("src/bad:name"), /Windows-safe/);
  for (const path of ["/absolute", "C:/drive", "../escape", "src\\backslash", "src/trailing.", "src/AUX.txt"]) {
    assert.throws(() => normalizePortableReleasePath(path), /Unsafe|Windows|reserved/i, path);
  }
});

test("release producer signs SHA256SUMS only with an explicit external Ed25519 key", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const root = await createFixture(t, { releasePublicKey: publicKey });
  const keyRoot = await mkdtemp(join(tmpdir(), "threadspan-release-key-"));
  const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-signed-"));
  t.after(() => Promise.all([
    rm(keyRoot, { recursive: true, force: true }),
    rm(outputParent, { recursive: true, force: true }),
  ]));
  const keyPath = join(keyRoot, "release-private.pem");
  await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const result = await buildReleaseBundle({
    root,
    outputDirectory: join(outputParent, "release"),
    signingPrivateKeyPath: keyPath,
  });
  const [manifest, signature] = await Promise.all([readFile(result.manifestPath), readFile(result.signaturePath)]);
  assert.equal(result.signatureName, "SHA256SUMS.sig");
  assert.equal(signature.length, 64);
  assert.equal(verify(null, manifest, publicKey, signature), true);
  assert.equal(
    manifest.toString("utf8"),
    `${result.archiveSha256}  threadspan-1.2.3.tar.gz\n# threadspan-source-commit ${result.sourceCommit}\n`,
  );
  verifyChecksumManifestSignature(manifest, signature, publicKey);
  const tamperedManifest = Buffer.from(manifest);
  const provenanceOffset = tamperedManifest.indexOf(result.sourceCommit);
  assert.notEqual(provenanceOffset, -1);
  tamperedManifest[provenanceOffset] = tamperedManifest[provenanceOffset] === 0x30 ? 0x31 : 0x30;
  assert.throws(
    () => verifyChecksumManifestSignature(tamperedManifest, signature, publicKey),
    /invalid publisher signature/,
  );
  assert.equal(JSON.stringify(result).includes(keyPath), false, "private key path is not returned or logged in release metadata");
  assert.equal(result.metadata.signed, true);
  assert.equal(JSON.stringify(result.metadata).includes(root), false);
  assert.equal(JSON.stringify(result.metadata).includes(outputParent), false);
  const repeated = await buildReleaseBundle({
    root,
    outputDirectory: join(outputParent, "release-repeat"),
    signingPrivateKeyPath: keyPath,
  });
  assert.deepEqual(await readFile(repeated.archivePath), await readFile(result.archivePath));
  assert.deepEqual(await readFile(repeated.manifestPath), manifest);
  assert.deepEqual(await readFile(repeated.signaturePath), signature);
  assert.equal(repeated.sourceCommit, result.sourceCommit);

  await assert.rejects(buildReleaseBundle({
    root,
    outputDirectory: join(outputParent, "relative-key"),
    signingPrivateKeyPath: "release-private.pem",
  }), /explicit absolute external private-key path/);
  const inTreeKeyPath = join(root, "release-private.pem");
  await writeFile(inTreeKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await assert.rejects(buildReleaseBundle({
    root,
    outputDirectory: join(outputParent, "in-tree-key"),
    signingPrivateKeyPath: inTreeKeyPath,
  }), /outside the Threadspan source tree/);

  const wrongKeyPath = join(keyRoot, "wrong-private.pem");
  const wrongKey = generateKeyPairSync("ed25519").privateKey;
  await writeFile(wrongKeyPath, wrongKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const mismatchedOutput = join(outputParent, "mismatched-key");
  await assert.rejects(buildReleaseBundle({
    root,
    outputDirectory: mismatchedOutput,
    signingPrivateKeyPath: wrongKeyPath,
  }), /does not match the shipped Ed25519 public key/);
  await assert.rejects(lstat(mismatchedOutput), { code: "ENOENT" }, "a mismatched signer must emit no release assets");

  const unsupportedSigners = [
    ["encrypted", privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "signer-passphrase-must-not-print" })],
    ["openssh", "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-supported-signing-key\n-----END OPENSSH PRIVATE KEY-----\n"],
    ["der", privateKey.export({ type: "pkcs8", format: "der" })],
  ];
  for (const [name, material] of unsupportedSigners) {
    const path = join(keyRoot, `${name}.bin`);
    await writeFile(path, material, { mode: 0o600 });
    await assert.rejects(
      buildReleaseBundle({
        root,
        outputDirectory: join(outputParent, `unsupported-${name}`),
        signingPrivateKeyPath: path,
      }),
      (error) => {
        assert.match(error.message, /does not match the shipped Ed25519 public key/);
        assert.equal(error.message.includes(path), false);
        assert.equal(error.message.includes("signer-passphrase-must-not-print"), false);
        return true;
      },
    );
  }
});

test("release output and expanded source bounds fail closed", async (t) => {
  const root = await createFixture(t);
  const existingOutput = await mkdtemp(join(tmpdir(), "threadspan-release-existing-"));
  const boundedParent = await mkdtemp(join(tmpdir(), "threadspan-release-bounded-"));
  t.after(() => Promise.all([
    rm(existingOutput, { recursive: true, force: true }),
    rm(boundedParent, { recursive: true, force: true }),
  ]));
  await assert.rejects(buildReleaseBundle({ root, outputDirectory: existingOutput }), /must not already exist/);
  await assert.rejects(buildReleaseBundle({
    root,
    outputDirectory: join(boundedParent, "release"),
    maxSourceBytes: 1,
  }), /Release source exceeds 1 bytes/);
  const concealedPrivateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  await writeFixtureFile(root, "src/innocent-looking.txt", concealedPrivateKey);
  await assert.rejects(buildReleaseBundle({
    root,
    outputDirectory: join(boundedParent, "private-material"),
  }), /prohibited private key material/);
  const privateKeyRoot = await createFixture(t);
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFixtureFile(
    privateKeyRoot,
    RELEASE_PUBLIC_KEY_RELATIVE_PATH,
    privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  await assert.rejects(buildReleaseBundle({
    root: privateKeyRoot,
    outputDirectory: join(boundedParent, "private-key-at-public-path"),
  }), /not a valid Ed25519 public key/);
  const forbiddenKeyRoot = await createFixture(t);
  await writeFixtureFile(forbiddenKeyRoot, "src/unexpected.pem", "-----BEGIN PUBLIC KEY-----\nnot allowed here\n");
  await assert.rejects(buildReleaseBundle({
    root: forbiddenKeyRoot,
    outputDirectory: join(boundedParent, "unexpected-key-path"),
  }), /package manifest contains forbidden key material 'src\/unexpected\.pem'/);
});

test("release provenance requires a clean commit while allowing release-ineligible untracked state", async (t) => {
  await t.test("unstaged tracked change", async (st) => {
    const root = await createFixture(st);
    const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-dirty-tracked-"));
    st.after(() => rm(outputParent, { recursive: true, force: true }));
    await writeFile(join(root, "src", "index.mjs"), "export const dirty = true;\n");
    await assert.rejects(
      buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") }),
      /tracked changes; commit them before bundling/,
    );
  });

  await t.test("staged tracked change", async (st) => {
    const root = await createFixture(st);
    const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-dirty-staged-"));
    st.after(() => rm(outputParent, { recursive: true, force: true }));
    await writeFile(join(root, "src", "index.mjs"), "export const staged = true;\n");
    await execFileAsync("git", ["add", "src/index.mjs"], { cwd: root });
    await assert.rejects(
      buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") }),
      /tracked changes; commit them before bundling/,
    );
  });

  await t.test("release-eligible untracked file", async (st) => {
    const root = await createFixture(st);
    const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-untracked-eligible-"));
    st.after(() => rm(outputParent, { recursive: true, force: true }));
    await writeFile(join(root, "src", "untracked.mjs"), "export {};\n");
    await assert.rejects(
      buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") }),
      /release-eligible untracked files; commit them before bundling/,
    );
  });

  await t.test("release-ineligible untracked file", async (st) => {
    const root = await createFixture(st);
    const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-untracked-ineligible-"));
    st.after(() => rm(outputParent, { recursive: true, force: true }));
    await writeFile(join(root, ".working.local"), "host-local reservation\n");
    const result = await buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") });
    assert.equal((await lstat(result.archivePath)).isFile(), true);
  });
});

test("release preflight rejects personal email or password material in URL userinfo", async (t) => {
  const root = await createFixture(t);
  const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-url-userinfo-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  await writeFixtureFile(root, "src/url-userinfo.txt", "https://person" + "@gmail.com:password@provider.example/path\n");
  await assert.rejects(buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") }), /unintended personal data/);
});

test("release preflight rejects high-confidence secrets and unintended PII without scanning arbitrary prose", async (t) => {
  const publicDonationEmail = ["HaileyCollet", "gmail.com"].join("@");
  const cases = [
    {
      name: "known credential token",
      content: ["ghp", "_", "A".repeat(36)].join(""),
      expected: /prohibited secret material/,
    },
    {
      name: "unintended email",
      content: ["release.owner", "private.example.com"].join("@"),
      expected: /unintended personal data/,
    },
    {
      name: "unintended SSN",
      content: ["123", "45", "6789"].join("-"),
      expected: /unintended personal data/,
    },
    {
      name: "public email outside exact allowlist",
      content: publicDonationEmail,
      expected: /unintended personal data/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async (st) => {
      const root = await createFixture(st);
      const relativePath = "src/ordinary-note.txt";
      await writeFixtureFile(root, relativePath, `${entry.content}\n`);
      const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-sensitive-scan-"));
      st.after(() => rm(outputParent, { recursive: true, force: true }));
      await assert.rejects(
        buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") }),
        (error) => {
          assert.match(error.message, entry.expected);
          assert.equal(error.message.includes(entry.content), false);
          assert.equal(error.message.includes(relativePath), false);
          return true;
        },
      );
    });
  }

  const acceptedRoot = await createFixture(t);
  await writeFixtureFile(acceptedRoot, "README.md", [
    "https://github.com/HaileyStorm/threadspan",
    `Optional public donation contact: ${publicDonationEmail}`,
    "Documentation may discuss API keys, passwords, signed URLs, and private data without containing them.",
    "Synthetic contact: maintainer@example.test",
    "",
  ].join("\n"));
  await writeFixtureFile(acceptedRoot, "src/security-guidance.txt", [
    "Never publish an API key or access token.",
    "Use a synthetic placeholder rather than arbitrary high-entropy prose scanning.",
    "",
  ].join("\n"));
  const acceptedOutputParent = await mkdtemp(join(tmpdir(), "threadspan-release-sensitive-accepted-"));
  t.after(() => rm(acceptedOutputParent, { recursive: true, force: true }));
  const accepted = await buildReleaseBundle({
    root: acceptedRoot,
    outputDirectory: join(acceptedOutputParent, "release"),
  });
  assert.equal((await lstat(accepted.archivePath)).isFile(), true);
});

test("npm pack awaits bare executable resolution before command normalization", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-release-npm-resolution-"));
  const bin = join(root, "bin");
  const fakeNpmPath = join(root, "fake-npm.cjs");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "npm"));
  await writeFile(fakeNpmPath, "process.stdout.write(JSON.stringify([{files:[{path:'package.json'}]}]));\n");

  const paths = await readNpmPacklist(root, {
    command: "npm",
    prefixArgs: [fakeNpmPath],
    environment: { ...process.env, PATH: bin },
  });
  assert.deepEqual(paths, ["package.json"]);
});

test("npm pack timeout settles descendant-aware process-tree termination before release cleanup", async (t) => {
  const root = await createFixture(t);
  const processRoot = await mkdtemp(join(tmpdir(), "threadspan-release-npm-timeout-"));
  const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-npm-timeout-output-"));
  t.after(() => Promise.all([
    rm(processRoot, { recursive: true, force: true }),
    rm(outputParent, { recursive: true, force: true }),
  ]));
  const descendantPidPath = join(processRoot, "descendant.pid");
  const cachePathReceipt = join(processRoot, "cache.path");
  const fakeNpmPath = join(processRoot, "fake-npm.cjs");
  const fakeNpmSource = [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const cache=process.argv[process.argv.indexOf('--cache')+1];",
    `writeFileSync(${JSON.stringify(cachePathReceipt)},cache);`,
    "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore',cwd:cache});",
    `writeFileSync(${JSON.stringify(descendantPidPath)},String(child.pid));`,
    "setInterval(()=>{},1000);",
  ].join("");
  await writeFile(fakeNpmPath, fakeNpmSource);
  const outputDirectory = join(outputParent, "release");
  await assert.rejects(buildReleaseBundle({
    root,
    outputDirectory,
    npmCommand: process.execPath,
    npmCommandArgs: [fakeNpmPath],
    npmPackTimeoutMs: 300,
  }), /npm pack timed out after 300 ms; its process tree was terminated/);
  const descendantPid = Number(await waitForFile(descendantPidPath));
  const cachePath = await waitForFile(cachePathReceipt);
  assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
  await waitForProcessExit(descendantPid);
  await assert.rejects(lstat(cachePath), { code: "ENOENT" }, "npm cache cleanup must wait for the descendant that can cause Windows EBUSY");
  await assert.rejects(lstat(outputDirectory), { code: "ENOENT" });
});

test("release producer rejects concealed private-key encodings without exposing their names or contents", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const encrypted = privateKey.export({
    type: "pkcs8",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: "do-not-print-this-passphrase",
  });
  const cases = [
    ["encrypted-pkcs8", encrypted],
    ["openssh", openSshPrivateKeyFixture()],
    ["binary-der", privateKey.export({ type: "pkcs8", format: "der" })],
  ];
  for (const [name, material] of cases) {
    await t.test(name, async (st) => {
      const root = await createFixture(st, { releasePublicKey: publicKey });
      const concealedName = `src/ordinary-${name}.dat`;
      await writeFixtureFile(root, concealedName, material);
      const outputParent = await mkdtemp(join(tmpdir(), "threadspan-release-private-scan-"));
      st.after(() => rm(outputParent, { recursive: true, force: true }));
      await assert.rejects(
        buildReleaseBundle({ root, outputDirectory: join(outputParent, "release") }),
        (error) => {
          assert.match(error.message, /prohibited private key material/);
          assert.equal(error.message.includes(concealedName), false);
          assert.equal(error.message.includes("do-not-print-this-passphrase"), false);
          return true;
        },
      );
    });
  }

  const publicDerRoot = await createFixture(t, { releasePublicKey: publicKey });
  await writeFixtureFile(publicDerRoot, "src/ordinary-public-reference.dat", publicKey.export({ type: "spki", format: "der" }));
  const publicDerOutput = await mkdtemp(join(tmpdir(), "threadspan-release-public-der-"));
  t.after(() => rm(publicDerOutput, { recursive: true, force: true }));
  const accepted = await buildReleaseBundle({ root: publicDerRoot, outputDirectory: join(publicDerOutput, "release") });
  assert.equal((await lstat(accepted.archivePath)).isFile(), true, "public DER must not be misclassified as private material");
});

test("package metadata exposes the local release producer", async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  assert.equal(manifest.files.includes("scripts/release-bundle.mjs"), true);
  assert.equal(manifest.scripts["release:bundle"], "node ./scripts/release-bundle.mjs");
  assert.equal(manifest.scripts["test:release-bundle"], "node --test --test-reporter=spec test/release-bundle.test.mjs");
});

test("current package source markers are not mistaken for private key material", async (t) => {
  const outputParent = await mkdtemp(join(tmpdir(), "threadspan-current-tree-release-"));
  t.after(() => rm(outputParent, { recursive: true, force: true }));
  const root = await copyCurrentPackageFixture(t);
  const result = await buildReleaseBundle({
    root,
    outputDirectory: join(outputParent, "release"),
  });
  assert.equal(result.signaturePath, undefined);
  await inspectReleaseArchive(result.archivePath, { expectedRootName: result.rootName });
});

async function createFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-release-fixture-"));
  t.after(async () => {
    gitFixtureRoots.delete(root);
    await rm(root, { recursive: true, force: true });
  });
  const packageJson = {
    name: "threadspan",
    version: "1.2.3",
    type: "module",
    files: ["src", "ui", "README.md"],
  };
  await writeFixtureFile(root, "package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFixtureFile(root, "README.md", "https://github.com/HaileyStorm/threadspan\n");
  await writeFixtureFile(root, "src/index.mjs", "export {};\n");
  await writeFixtureFile(root, "src/cli.mjs", "export {};\n");
  const publicKey = options.releasePublicKey ?? generateKeyPairSync("ed25519").publicKey;
  await writeFixtureFile(root, RELEASE_PUBLIC_KEY_RELATIVE_PATH, publicKey.export({ type: "spki", format: "pem" }));
  await writeFixtureFile(root, "src/core/auth.mjs", "export const safeSource = true;\n");
  await writeFixtureFile(root, "ui/install.html", "<!doctype html><title>Threadspan</title>\n");
  await writeFixtureFile(root, "ui/install.css", "body{}\n");
  await writeFixtureFile(root, "ui/install.js", "export {};\n");
  await writeFixtureFile(root, "ui/mark.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n");
  for (const path of [
    "src/.working.agent",
    "src/.env.production",
    "src/credentials.json",
    "src/secrets.json",
    "src/rollbacks/restore.json",
    "src/evidence/run.json",
    "src/.threadspan/state.json",
    "src/browser/User Data/Default/Cookies",
    "src/tool.exe",
    "src/node_modules/dependency/index.js",
  ]) await writeFixtureFile(root, path, "must not release\n");
  await initializeGitFixture(root);
  gitFixtureRoots.add(root);
  return root;
}

async function writeFixtureFile(root, relativePath, content) {
  const path = join(root, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (gitFixtureRoots.has(root)) await commitFixture(root);
}

async function copyCurrentPackageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "threadspan-current-package-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePaths = await readNpmPacklist(projectRoot);
  for (const relativePath of packagePaths) {
    const source = join(projectRoot, ...relativePath.split("/"));
    const destination = join(root, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await initializeGitFixture(root);
  return root;
}

async function initializeGitFixture(root) {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await commitFixture(root);
}

async function commitFixture(root) {
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  };
  await execFileAsync("git", ["add", "-A"], { cwd: root, env: environment });
  await execFileAsync("git", [
    "-c", "user.name=Threadspan Test",
    "-c", "user.email=threadspan@example.test",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "--allow-empty", "-m", "fixture",
  ], { cwd: root, env: environment });
}

function readTarHeaders(archive) {
  const tar = gunzipSync(archive);
  const headers = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const name = readText(block, 0, 100);
    const prefix = readText(block, 345, 155);
    const size = readOctal(block, 124, 12);
    headers.push({
      path: prefix ? `${prefix}/${name}` : name,
      mode: readOctal(block, 100, 8),
      uid: readOctal(block, 108, 8),
      gid: readOctal(block, 116, 8),
      mtime: readOctal(block, 136, 12),
      type: String.fromCharCode(block[156] || 0x30),
      uname: readText(block, 265, 32),
      gname: readText(block, 297, 32),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return headers;
}

function readText(buffer, offset, length) {
  const bytes = buffer.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end === -1 ? bytes.length : end).toString("utf8");
}

function readOctal(buffer, offset, length) {
  const value = readText(buffer, offset, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
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

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("Timed out waiting for the fake npm descendant receipt");
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
  throw new Error("Fake npm descendant survived settled process-tree termination");
}
