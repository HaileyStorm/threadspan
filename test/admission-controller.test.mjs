import assert from "node:assert/strict";
import test from "node:test";
import { WeightedAdmissionController } from "../src/core/admission-controller.mjs";

test("weighted admission serializes active jobs and reconciles expected to actual units", async () => {
  const controller = new WeightedAdmissionController({
    maxActive: 1,
    minStartIntervalMs: 0,
    maxUnitsPerWindow: 3,
    windowMs: 1000,
  });
  const releaseFirst = await controller.acquire(2);
  let secondAdmitted = false;
  const second = controller.acquire(2).then((release) => {
    secondAdmitted = true;
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAdmitted, false);

  releaseFirst(1);
  const releaseSecond = await second;
  assert.equal(controller.stats().unitsInWindow, 3);
  releaseSecond(2);
  controller.close();
});

test("weighted admission waits for rolling reservations and supports queued cancellation", async () => {
  const controller = new WeightedAdmissionController({
    maxActive: 2,
    minStartIntervalMs: 0,
    maxUnitsPerWindow: 2,
    windowMs: 35,
  });
  const release = await controller.acquire(2);
  release(2);
  const started = Date.now();
  const nextRelease = await controller.acquire(1);
  assert.ok(Date.now() - started >= 20);
  nextRelease(1);

  const occupied = await controller.acquire(1);
  const aborter = new AbortController();
  const cancelled = controller.acquire(1, aborter.signal);
  aborter.abort(new Error("cancelled-in-test"));
  await assert.rejects(cancelled, /cancelled-in-test/);
  occupied(1);
  controller.close();
});


test("weighted admission can reconcile a successful zero-model-call terminal record", async () => {
  const controller = new WeightedAdmissionController({ maxActive: 1, maxUnitsPerWindow: 2, windowMs: 1000 });
  const release = await controller.acquire(1);
  release(0);
  assert.equal(controller.stats().unitsInWindow, 0);
  controller.close();
});
