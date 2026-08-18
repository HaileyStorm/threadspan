import assert from "node:assert/strict";
import test from "node:test";
import { applyIntentBriefUpdate, applyIntentBriefUpdates, deriveIntentBrief } from "../src/core/intent-brief.mjs";

const source = {
  objective: "Implement Voice",
  deliverables: ["Runtime", "Tests"],
  constraints: ["No memory"],
  permissions: ["Edit assigned files"],
  priorities: ["Preserve authority"],
  exclusions: ["Provider settings"],
  acceptance: ["Full verify passes"],
  deferred: ["Host-native style API"],
};

test("intent brief derives only the explicit authority fields", () => {
  const brief = deriveIntentBrief(source);
  assert.deepEqual(brief, source);
  assert.equal(Object.isFrozen(brief), true);
  assert.throws(() => deriveIntentBrief({ ...source, rawPrompt: "private" }), /unsupported fields: rawPrompt/);
});

test("classified updates preserve unaffected authority", () => {
  const updated = applyIntentBriefUpdates(source, [
    { classification: "addition", changes: { deliverables: ["Docs"], constraints: ["Bounded"] } },
    { classification: "override", changes: { priorities: ["Release safety"] } },
    { classification: "correction", replacements: [{ field: "objective", from: "Implement Voice", to: "Implement Voice and intent" }] },
  ]);
  assert.equal(updated.objective, "Implement Voice and intent");
  assert.deepEqual(updated.deliverables, ["Runtime", "Tests", "Docs"]);
  assert.deepEqual(updated.constraints, ["No memory", "Bounded"]);
  assert.deepEqual(updated.permissions, source.permissions);
  assert.deepEqual(updated.priorities, ["Release safety"]);
});

test("corrections must match exact current authority and updates must be classified", () => {
  assert.throws(() => applyIntentBriefUpdate(source, { classification: "correction", replacements: [{ field: "constraints", from: "missing", to: "replacement" }] }), /source was not found/);
  assert.throws(() => applyIntentBriefUpdate(source, { changes: { deliverables: ["x"] } }), /classification/);
  assert.throws(() => applyIntentBriefUpdate(source, { classification: "override", changes: { unknown: ["x"] } }), /unsupported field/);
});
