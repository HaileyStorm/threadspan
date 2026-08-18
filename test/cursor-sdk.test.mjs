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
  const state = { creates: 0, sends: 0, disposals: 0, prompts: [], agentOptions: [] };
  return {
    state,
    sdk: {
      Cursor: { models: { list: async () => ({ models: [{ id: "auto" }] }) } },
      Agent: {
        create: async (options) => {
          state.creates += 1;
          state.agentOptions.push(options);
          await new Promise((resolve) => setTimeout(resolve, 20));
          const agentId = `agent-${state.creates}`;
          return {
            agentId,
            async send(prompt) {
              state.sends += 1;
              state.prompts.push(prompt);
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

test("Cursor SDK exposes native settings and forwards explicit false sandbox/review overrides", async () => {
  const native = createFakeCursorSdk();
  const nativeProvider = new CursorSdkProvider("cursor-native", {
    adapter: "cursor-sdk",
    apiKey: "test-key",
    capabilities: ["consult"],
  }, {
    logger: new Logger({ level: "silent" }),
    cursorSdkLoader: async () => native.sdk,
  });
  try {
    const events = await collect(nativeProvider.run({ mode: "consult", model: "auto", messages: [{ role: "user", content: "review" }] }));
    assert.deepEqual(nativeProvider.capabilities().settings.nativeSettings, { settingSources: true, sandbox: true, autoReview: true });
    assert.equal("sandboxOptions" in native.state.agentOptions[0].local, false);
    assert.equal("autoReview" in native.state.agentOptions[0].local, false);
    assert.equal(events.at(-1).providerMetadata.cursorSdk.effectiveSettings.sandbox, "native");
  } finally {
    await nativeProvider.close();
  }

  const explicit = createFakeCursorSdk();
  const explicitProvider = new CursorSdkProvider("cursor-explicit", {
    adapter: "cursor-sdk",
    apiKey: "test-key",
    capabilities: ["consult"],
    local: { settingSources: [], sandboxEnabled: false, autoReview: false },
  }, {
    logger: new Logger({ level: "silent" }),
    cursorSdkLoader: async () => explicit.sdk,
  });
  try {
    const events = await collect(explicitProvider.run({ mode: "consult", model: "auto", messages: [{ role: "user", content: "review" }] }));
    assert.deepEqual(explicit.state.agentOptions[0].local, {
      cwd: explicit.state.agentOptions[0].local.cwd,
      settingSources: [],
      autoReview: false,
      sandboxOptions: { enabled: false },
    });
    assert.deepEqual(events.at(-1).providerMetadata.cursorSdk.effectiveSettings, {
      settingSources: [],
      sandbox: "disabled",
      autoReview: "disabled",
    });
  } finally {
    await explicitProvider.close();
  }
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
    assert.equal(state.prompts[1].split("Do one bounded thing.").length - 1, 1);
    assert.equal(left.at(-1).message.content, "delegated result");
    assert.equal(right.at(-1).message.content, "delegated result");
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }

  assert.equal(state.disposals, 1);
});

test("retained Cursor agents replay changed policy once without replaying old turns", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "threadspan-cursor-policy-"));
  const { sdk, state } = createFakeCursorSdk();
  const provider = new CursorSdkProvider("cursor", {
    adapter: "cursor-sdk",
    apiKey: "test-key",
    capabilities: ["delegate"],
  }, {
    logger: new Logger({ level: "silent" }),
    cursorSdkLoader: async () => sdk,
  });
  try {
    const run = (messages) => collect(provider.run({
      mode: "delegate", model: "auto", workspace, messages,
    }));
    await run([
      { role: "system", content: "policy one" },
      { role: "user", content: "first task" },
    ]);
    await run([
      { role: "system", content: "policy one" },
      { role: "user", content: "first task" },
      { role: "assistant", content: "first result" },
      { role: "user", content: "second task" },
    ]);
    await run([
      { role: "system", content: "policy two" },
      { role: "user", content: "first task" },
      { role: "assistant", content: "first result" },
      { role: "user", content: "third task" },
    ]);
    assert.doesNotMatch(state.prompts[1], /policy one|first task|first result/);
    assert.match(state.prompts[1], /second task/);
    assert.match(state.prompts[2], /policy two/);
    assert.doesNotMatch(state.prompts[2], /policy one|first result/);
    assert.match(state.prompts[2], /third task/);
  } finally {
    await provider.close();
    await rm(workspace, { recursive: true, force: true });
  }
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
