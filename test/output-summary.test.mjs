import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  OUTPUT_SUMMARY_VERSION,
  summarizeRepetitiveOutput,
} from "../src/core/output-summary.mjs";
import { renderMessagesForAgent } from "../src/core/policies.mjs";
import { SessionStore } from "../src/core/session-store.mjs";

const LOW_TEST_THRESHOLDS = Object.freeze({
  minBytes: 128,
  minLines: 12,
  minRepetitions: 8,
  minDuplicateLineRatio: 0.7,
  headBytes: 96,
  tailBytes: 96,
});

function repetitiveOutput(count = 80) {
  return ["exact-head", ...Array.from({ length: count }, () => "repeated tool output"), "exact-tail"].join("\n");
}

test("renderMessagesForAgent golden output keeps small tool results exact", () => {
  const rendered = renderMessagesForAgent([{
    role: "tool",
    toolCallId: "call_small",
    content: "ok",
    status: "completed",
  }], { outputSummary: LOW_TEST_THRESHOLDS });
  assert.equal(rendered, "[TOOL]\nok\nTOOL CALL ID: call_small\nMESSAGE METADATA\n{\"status\":\"completed\"}");
});

test("large repetitive tool output gets a deterministic exact-head/tail summary", () => {
  const original = repetitiveOutput();
  const result = summarizeRepetitiveOutput(original, LOW_TEST_THRESHOLDS);
  const bytes = Buffer.from(original, "utf8");
  assert.equal(result.summarized, true);
  assert.equal(result.metadata.version, OUTPUT_SUMMARY_VERSION);
  assert.equal(result.metadata.originalBytes, bytes.length);
  assert.equal(result.metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.metadata.repetitionCount, 80);
  assert.ok(result.metadata.omittedBytes > 0);
  assert.ok(result.metadata.omittedLines > 0);
  const exactHead = bytes.subarray(0, result.metadata.headBytes).toString("utf8");
  const exactTail = bytes.subarray(bytes.length - result.metadata.tailBytes).toString("utf8");
  assert.match(result.content, /THREADSPAN PROGRAMMATIC OUTPUT SUMMARY/);
  assert.ok(result.content.includes(exactHead));
  assert.ok(result.content.includes(exactTail));
});

test("large nonrepetitive output remains exact by default", () => {
  const original = Array.from({ length: 80 }, (_value, index) => `unique-${index}-${"x".repeat(24)}`).join("\n");
  const result = summarizeRepetitiveOutput(original, LOW_TEST_THRESHOLDS);
  assert.deepEqual(result, { content: original, summarized: false });
});

test("errors remain exact even when their output is large and repetitive", () => {
  const original = repetitiveOutput();
  const rendered = renderMessagesForAgent([{
    role: "tool",
    toolCallId: "call_error",
    content: original,
    status: "failed",
    error: { code: "EFAIL", message: "command failed" },
  }], { outputSummary: LOW_TEST_THRESHOLDS });
  assert.ok(rendered.includes(original));
  assert.doesNotMatch(rendered, /THREADSPAN PROGRAMMATIC OUTPUT SUMMARY/);
  assert.match(rendered, /\"status\":\"failed\"/);
  assert.match(rendered, /\"code\":\"EFAIL\"/);
});

test("artifact and execution evidence metadata remains exact beside summarized content", () => {
  const metadata = {
    status: "completed",
    command: "node",
    argv: ["script.mjs", "--check"],
    hashes: { stdoutSha256: "a".repeat(64) },
    evidenceClass: "live-provider",
    cost: { usd: 0.125 },
    pid: 4242,
    processIds: [4242, 4243],
    artifact: { path: "/private/evidence/job.json", size: 8192, sha256: "b".repeat(64) },
  };
  const rendered = renderMessagesForAgent([{
    role: "tool",
    toolCallId: "call_evidence",
    content: repetitiveOutput(),
    ...metadata,
  }], { outputSummary: LOW_TEST_THRESHOLDS });
  assert.match(rendered, /THREADSPAN PROGRAMMATIC OUTPUT SUMMARY/);
  for (const exact of [
    '"command":"node"',
    '"argv":["script.mjs","--check"]',
    '"evidenceClass":"live-provider"',
    '"pid":4242',
    '"path":"/private/evidence/job.json"',
    '"size":8192',
    `"sha256":"${"b".repeat(64)}"`,
  ]) assert.ok(rendered.includes(exact), `missing exact metadata ${exact}`);
});

test("reasoning and ordered tool-call IDs, names, and raw arguments round trip exactly", () => {
  const rawFirst = '{"path":"a.txt", "line":7}';
  const rawSecond = '{"command":"npm test", "argv":["--", "focused"]}';
  const messages = [{
    role: "assistant",
    content: "checking",
    reasoningContent: "private reasoning stays exact",
    toolCalls: [
      { id: "call_1", name: "read_file", arguments: rawFirst },
      { id: "call_2", name: "exec_command", arguments: rawSecond },
    ],
  }];
  const before = structuredClone(messages);
  const rendered = renderMessagesForAgent(messages, { outputSummary: LOW_TEST_THRESHOLDS });
  assert.ok(rendered.indexOf("ID: call_1") < rendered.indexOf("ID: call_2"));
  for (const exact of ["private reasoning stays exact", "NAME: read_file", "NAME: exec_command", rawFirst, rawSecond]) {
    assert.ok(rendered.includes(exact));
  }
  assert.deepEqual(messages, before);
});

test("canonical SessionStore messages remain unchanged and retain full summarized content", () => {
  const store = new SessionStore();
  const original = repetitiveOutput();
  store.appendMessages("thread-summary", [{ role: "tool", toolCallId: "call_store", content: original }]);
  const canonicalBefore = structuredClone(store.getThread("thread-summary").messages);
  const rendered = renderMessagesForAgent(store.getThread("thread-summary").messages, { outputSummary: LOW_TEST_THRESHOLDS });
  assert.match(rendered, /THREADSPAN PROGRAMMATIC OUTPUT SUMMARY/);
  assert.deepEqual(store.getThread("thread-summary").messages, canonicalBefore);
  assert.equal(store.getThread("thread-summary").messages[0].content, original);
});

test("replay-critical providers and evidence paths always retain exact output", () => {
  const original = repetitiveOutput();
  for (const context of [
    { providerId: "nous" },
    { adapter: "deepseek" },
    { purpose: "provider-wire-serialization" },
    { path: "private-evidence" },
    { replayCritical: true },
  ]) {
    assert.deepEqual(summarizeRepetitiveOutput(original, { ...LOW_TEST_THRESHOLDS, ...context }), {
      content: original,
      summarized: false,
    });
  }
});
