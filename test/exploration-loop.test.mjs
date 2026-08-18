import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExplorationLoop,
  normalizeStructuredExplorationActivities,
} from "../src/core/exploration-loop.mjs";

const cleanGit = Object.freeze({ branch: "worker", commit: "abc123", clean: true, status: [] });

test("exploration-loop classification recovers repeated structured activity with unchanged Git", () => {
  const result = classifyExplorationLoop({
    mode: "delegate",
    terminalState: "incomplete",
    activities: [
      { kind: "plan" },
      { type: "read_file" },
      { action: "search" },
      { category: "inspect" },
      "free-form planning text is ignored",
    ],
    gitBefore: cleanGit,
    gitAfter: structuredClone(cleanGit),
    turnsUsed: 12,
    overallTurnCeiling: 16,
    reserveTurns: 4,
  });

  assert.equal(result.recover, true);
  assert.equal(result.reason, "unchanged-repeated-exploration");
  assert.equal(result.recoveryTurns, 4);
  assert.deepEqual(result.activityKindCounts, { plan: 1, read: 3 });
});

test("exploration-loop classification fails closed across mode, structure, Git, and turn gates", () => {
  const baseline = {
    mode: "delegate",
    terminalState: "incomplete",
    activities: [{ kind: "plan" }, { kind: "read" }, { kind: "read" }, { kind: "read" }],
    gitBefore: cleanGit,
    gitAfter: structuredClone(cleanGit),
    turnsUsed: 12,
    overallTurnCeiling: 16,
    reserveTurns: 4,
  };
  assert.equal(classifyExplorationLoop({ ...baseline, mode: "consult" }).recover, false);
  assert.equal(classifyExplorationLoop({ ...baseline, terminalState: "complete" }).recover, false);
  assert.equal(classifyExplorationLoop({ ...baseline, activities: ["plan", "read", "read", "read"] }).recover, false);
  assert.equal(classifyExplorationLoop({ ...baseline, gitAfter: { ...cleanGit, status: [" M source.mjs"], clean: false } }).recover, false);
  assert.equal(classifyExplorationLoop({ ...baseline, turnsUsed: 16 }).recover, false);
});

test("structured exploration normalizer accepts explicit categories and rejects prose", () => {
  assert.deepEqual(normalizeStructuredExplorationActivities([
    { kind: "planning" },
    { type: "file_read" },
    { action: "write" },
    "read file",
    null,
  ]), [{ kind: "plan" }, { kind: "read" }]);
});
