import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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
  await ledger.append({ event: "completed", jobId: "job_1", ...evidence });
  await ledger.flush();
  const record = JSON.parse((await readFile(ledgerPath, "utf8")).trim());
  assert.equal(record.event, "completed");
  assert.equal(JSON.parse(await readFile(evidence.evidencePath, "utf8")).stdout, "o");
});
