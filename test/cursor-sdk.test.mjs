import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityError } from "../src/core/errors.mjs";
import { Logger } from "../src/core/logger.mjs";
import { CursorSdkProvider } from "../src/providers/cursor-sdk.mjs";

/** Collect every event yielded by an async provider run. */
async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

/** Create a fake Cursor SDK with observable agent creation and disposal. */
function createFakeCursorSdk() {
  const state = { creates: 0, sends: 0, disposals: 0 };
  return {
    state,
    sdk: {
      Cursor: { models: { list: async () => ({ models: [{ id: "auto" }] }) } },
      Agent: {
        create: async () => {
          state.creates += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          const agentId = `agent-${state.creates}`;
          return {
            agentId,
            async send() {
              state.sends += 1;
              return {
                id: `run-${state.sends}`,
                supports: () => false,
                wait: async () => ({ status: "completed", result: "delegated result" }),
              };
            },
            async [Symbol.asyncDispose]() {
              state.disposals += 1;
            },
          };
        },
      },
    },
  };
}

test("Cursor provider rejects Integrated mode instead of misrepresenting the agent harness", async () => {
  const { sdk } = createFakeCursorSdk();
  const provider = new CursorSdkProvider("cursor-ultra", {
    adapter: "cursor-sdk",
    apiKey: "test-key",
    capabilities: ["consult", "integrated", "delegate"],
  }, {
    logger: new Logger({ level: "silent" }),
    cursorSdkLoader: async () => sdk,
  });

  assert.equal(provider.capabilities().modes.integrated.supported, false);
  await assert.rejects(
    async () => collect(provider.run({ mode: "integrated", model: "auto", messages: [] })),
    CapabilityError,
  );
  await provider.close();
});

test("simultaneous first Delegate calls share one retained Cursor agent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cursor-bridge-delegate-test-"));
  const { sdk, state } = createFakeCursorSdk();
  const provider = new CursorSdkProvider("cursor-ultra", {
    adapter: "cursor-sdk",
    apiKey: "test-key",
    capabilities: ["consult", "delegate"],
    delegate: { maxAgents: 4, agentTtlMs: 60_000 },
  }, {
    logger: new Logger({ level: "silent" }),
    cursorSdkLoader: async () => sdk,
  });
  const request = {
    mode: "delegate",
    model: "auto",
    messages: [{ role: "user", content: "Do one bounded thing." }],
    threadId: "same-thread",
    workspace,
  };

  try {
    const [left, right] = await Promise.all([
      collect(provider.run(request)),
      collect(provider.run(request)),
    ]);
    assert.equal(state.creates, 1);
    assert.equal(state.sends, 2);
    assert.equal(left.at(-1).message.content, "delegated result");
    assert.equal(right.at(-1).message.content, "delegated result");
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }

  assert.equal(state.disposals, 1);
});

test("an aborted queued Delegate call does not run or let later work overtake the active send", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "cursor-bridge-delegate-abort-test-"));
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const state = { sends: 0, disposals: 0 };
  const sdk = {
    Cursor: { models: { list: async () => ({ models: [{ id: "auto" }] }) } },
    Agent: {
      create: async () => ({
        agentId: "agent-one",
        async send() {
          state.sends += 1;
          const sendNumber = state.sends;
          return {
            id: `run-${sendNumber}`,
            supports: () => false,
            wait: async () => {
              if (sendNumber === 1) await firstGate;
              return { status: "completed", result: `result-${sendNumber}` };
            },
          };
        },
        async [Symbol.asyncDispose]() { state.disposals += 1; },
      }),
    },
  };
  const provider = new CursorSdkProvider("cursor-ultra", {
    adapter: "cursor-sdk",
    apiKey: "test-key",
    capabilities: ["delegate"],
  }, {
    logger: new Logger({ level: "silent" }),
    cursorSdkLoader: async () => sdk,
  });
  const baseRequest = {
    mode: "delegate",
    model: "auto",
    messages: [{ role: "user", content: "work" }],
    threadId: "same-thread",
    workspace,
  };

  try {
    const first = collect(provider.run(baseRequest));
    while (state.sends === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    const controller = new AbortController();
    const second = collect(provider.run({ ...baseRequest, signal: controller.signal }));
    const third = collect(provider.run(baseRequest));
    controller.abort(new Error("queued-cancel"));
    await assert.rejects(second, /queued-cancel/);
    assert.equal(state.sends, 1);
    releaseFirst();
    const [firstEvents, thirdEvents] = await Promise.all([first, third]);
    assert.equal(state.sends, 2);
    assert.equal(firstEvents.at(-1).message.content, "result-1");
    assert.equal(thirdEvents.at(-1).message.content, "result-2");
  } finally {
    releaseFirst?.();
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
  assert.equal(state.disposals, 1);
});
