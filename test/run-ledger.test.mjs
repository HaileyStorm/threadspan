import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RunLedger } from "../src/core/run-ledger.mjs";

test("RunLedger records private JSONL lifecycle data and optional evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-bridge-ledger-"));
  const ledgerPath = join(root, "ledger.jsonl");
  const evidenceDirectory = join(root, "evidence");
  const ledger = new RunLedger({
    providerId: "worker",
    path: ledgerPath,
    includeOutput: true,
    evidenceDirectory,
  });
  const evidence = await ledger.captureEvidence("job_1", { prompt: "p", stdout: "o", stderr: "e" });
  assert.match(evidence.promptSha256, /^[a-f0-9]{64}$/);
  assert.equal(evidence.evidencePath, join(evidenceDirectory, "job_1.json"));
  assert.equal(evidence.evidenceArtifact.path, evidence.evidencePath);
  assert.ok(evidence.evidenceArtifact.size > 0);
  assert.match(evidence.evidenceArtifact.sha256, /^[a-f0-9]{64}$/);
  await ledger.append({ event: "completed", jobId: "job_1", ...evidence });
  await ledger.flush();
  const record = JSON.parse((await readFile(ledgerPath, "utf8")).trim());
  assert.equal(record.event, "completed");
  const rawEvidence = await readFile(evidence.evidencePath);
  assert.equal(JSON.parse(rawEvidence.toString("utf8")).stdout, "o");
  assert.equal(evidence.evidenceArtifact.size, rawEvidence.length);
  assert.equal(evidence.evidenceArtifact.sha256, createHash("sha256").update(rawEvidence).digest("hex"));
});

test("RunLedger required append shares ordering and always surfaces persistence failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-required-ledger-"));
  const ledgerPath = join(root, "ledger.jsonl");
  const ledger = new RunLedger({ providerId: "worker", path: ledgerPath, required: false });
  const optional = ledger.append({ event: "running", jobId: "job_1" });
  const required = ledger.appendRequired({ event: "cleanup-required", jobId: "job_1", cleanupRequired: true });
  await Promise.all([optional, required]);
  const records = (await readFile(ledgerPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map((record) => record.event), ["running", "cleanup-required"]);

  const blockedPath = join(root, "blocked-ledger");
  await mkdir(blockedPath);
  const blocked = new RunLedger({ providerId: "worker", path: blockedPath, required: false });
  await assert.rejects(blocked.appendRequired({ event: "cleanup-required", cleanupRequired: true }));
  const disabled = new RunLedger({ providerId: "worker", enabled: false });
  await assert.rejects(disabled.appendRequired({ event: "cleanup-required", cleanupRequired: true }), /persistence is disabled/u);
});
