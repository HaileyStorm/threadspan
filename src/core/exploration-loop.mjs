const STRUCTURED_EXPLORATION_KINDS = new Set(["plan", "read"]);

/**
 * Classify a bounded provider-owned attempt without inspecting prose.
 *
 * Recovery is permitted only for an incomplete Delegate attempt whose structured activity shows
 * both planning and reading, whose Git state is unchanged, and whose overall turn ceiling still
 * contains the configured reserve. The caller remains responsible for issuing at most one recovery.
 *
 * @param {{
 *   mode: string,
 *   terminalState: "complete"|"incomplete"|string,
 *   activities?: unknown[],
 *   gitBefore?: Record<string, any>,
 *   gitAfter?: Record<string, any>,
 *   turnsUsed?: number,
 *   overallTurnCeiling: number,
 *   reserveTurns: number,
 *   minimumStructuredActivities?: number,
 *   minimumRepeatedKindCount?: number,
 * }} input Classification input.
 * @returns {{
 *   recover: boolean,
 *   reason: string,
 *   recoveryTurns: number,
 *   structuredActivityCount: number,
 *   activityKindCounts: Record<string, number>,
 *   gitUnchanged: boolean,
 * }} Deterministic recovery decision.
 */
export function classifyExplorationLoop(input) {
  const activities = normalizeStructuredExplorationActivities(input.activities);
  const activityKindCounts = Object.fromEntries([...STRUCTURED_EXPLORATION_KINDS].map((kind) => [
    kind,
    activities.filter((activity) => activity.kind === kind).length,
  ]));
  const gitUnchanged = sameGitState(input.gitBefore, input.gitAfter);
  const turnsUsed = positiveIntegerOrZero(input.turnsUsed);
  const overallTurnCeiling = positiveIntegerOrZero(input.overallTurnCeiling);
  const configuredReserve = positiveIntegerOrZero(input.reserveTurns);
  const recoveryTurns = Math.min(configuredReserve, Math.max(0, overallTurnCeiling - turnsUsed));
  const minimumStructuredActivities = positiveIntegerOrZero(input.minimumStructuredActivities) || 4;
  const minimumRepeatedKindCount = positiveIntegerOrZero(input.minimumRepeatedKindCount) || 2;

  const gates = [
    [input.mode === "delegate", "mode-not-delegate"],
    [input.terminalState === "incomplete", "attempt-complete"],
    [activities.length >= minimumStructuredActivities, "insufficient-structured-activity"],
    [activityKindCounts.plan > 0 && activityKindCounts.read > 0, "missing-plan-or-read-activity"],
    [Math.max(activityKindCounts.plan, activityKindCounts.read) >= minimumRepeatedKindCount, "activity-not-repeated"],
    [gitUnchanged, "git-state-changed-or-unavailable"],
    [turnsUsed > 0 && turnsUsed < overallTurnCeiling && recoveryTurns > 0, "turn-reserve-unavailable"],
  ];
  const failed = gates.find(([passed]) => !passed);
  return {
    recover: failed === undefined,
    reason: failed?.[1] ?? "unchanged-repeated-exploration",
    recoveryTurns,
    structuredActivityCount: activities.length,
    activityKindCounts,
    gitUnchanged,
  };
}

/**
 * Normalize only explicit structured plan/read records. Free-form text is intentionally ignored.
 * @param {unknown} input Candidate activity list.
 * @returns {{kind: "plan"|"read"}[]} Normalized activity categories.
 */
export function normalizeStructuredExplorationActivities(input) {
  if (!Array.isArray(input)) return [];
  return input.flatMap((activity) => {
    if (!activity || typeof activity !== "object" || Array.isArray(activity)) return [];
    const rawKind = activity.kind ?? activity.type ?? activity.category ?? activity.action;
    if (typeof rawKind !== "string") return [];
    const normalized = rawKind.trim().toLowerCase().replaceAll("_", "-");
    const kind = normalized === "plan" || normalized === "planning"
      ? "plan"
      : ["read", "file-read", "read-file", "inspect", "search"].includes(normalized)
        ? "read"
        : undefined;
    return kind && STRUCTURED_EXPLORATION_KINDS.has(kind) ? [{ kind }] : [];
  });
}

/** Compare bounded Git identity/status rather than workspace paths. */
function sameGitState(before, after) {
  if (!before || !after) return false;
  const leftStatus = normalizedStatus(before.status);
  const rightStatus = normalizedStatus(after.status);
  return before.commit === after.commit
    && before.branch === after.branch
    && before.clean === after.clean
    && JSON.stringify(leftStatus) === JSON.stringify(rightStatus);
}

function normalizedStatus(value) {
  return Array.isArray(value) ? value.map(String).sort() : [];
}

function positiveIntegerOrZero(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
