import assert from "node:assert/strict";
import test from "node:test";
import { KeyedSerialQueue } from "../src/core/keyed-serial-queue.mjs";

test("KeyedSerialQueue serializes one key while allowing unrelated keys to run", async () => {
  const queue = new KeyedSerialQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run("same", undefined, async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = queue.run("same", undefined, async () => { events.push("second"); });
  const other = queue.run("other", undefined, async () => { events.push("other"); });

  await other;
  assert.deepEqual(events, ["first-start", "other"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "other", "first-end", "second"]);
  assert.equal(queue.size, 0);
});

test("an aborted queued call cannot let a later call overtake active work", async () => {
  const queue = new KeyedSerialQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = queue.run("thread", undefined, async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const controller = new AbortController();
  const aborted = queue.run("thread", controller.signal, async () => { events.push("aborted-ran"); });
  const third = queue.run("thread", undefined, async () => { events.push("third"); });
  controller.abort(new Error("cancelled"));
  await assert.rejects(aborted, /cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(events, ["first-start"]);
  releaseFirst();
  await Promise.all([first, third]);
  assert.deepEqual(events, ["first-start", "first-end", "third"]);
});
