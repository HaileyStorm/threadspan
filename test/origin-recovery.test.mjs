import test from "node:test";
import assert from "node:assert/strict";
import { notifyNativeOrigin } from "../src/installer/origin-recovery.mjs";

test("unavailable Hermes recovery never invokes an injected native callback", async () => {
  let calls = 0;
  const result = await notifyNativeOrigin(
    { kind: "hermes", id: "native-session-private" },
    { hermesResume: async () => { calls += 1; } },
  );

  assert.equal(calls, 0);
  assert.equal(result.notified, false);
  assert.equal(result.kind, "hermes");
  assert.equal(result.reason, "native-recovery-contract-unavailable");
  assert.equal(result.contract.available, false);
  assert.equal(result.contract.transport, "hermes-acp-session");
  assert.doesNotMatch(JSON.stringify(result), /native-session-private/);
});

test("available Cursor recovery still invokes the injected SDK callback", async () => {
  const calls = [];
  const result = await notifyNativeOrigin(
    { kind: "cursor", id: "cursor-session" },
    {
      message: "bounded recovery notice",
      cursorResume: async (...args) => { calls.push(args); },
    },
  );

  assert.deepEqual(calls, [["cursor-session", "bounded recovery notice"]]);
  assert.equal(result.notified, true);
  assert.equal(result.kind, "cursor");
  assert.equal(result.contract.transport, "cursor-sdk");
});

test("direct and missing-id origins remain non-resumable without callbacks", async () => {
  let calls = 0;
  const callback = async () => { calls += 1; };
  const direct = await notifyNativeOrigin({ kind: "direct", id: "ignored" }, { hermesResume: callback });
  const missingId = await notifyNativeOrigin({ kind: "cursor" }, { cursorResume: callback });

  assert.deepEqual(direct, { notified: false, kind: "direct", reason: "no-resumable-origin" });
  assert.deepEqual(missingId, { notified: false, kind: "cursor", reason: "no-resumable-origin" });
  assert.equal(calls, 0);
});
