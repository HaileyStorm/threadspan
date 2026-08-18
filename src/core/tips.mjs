const MODES = new Set(["consult", "integrated", "delegate"]);

const TIP_CATALOG = Object.freeze({
  compatibility: Object.freeze({
    id: "compatibility-review",
    text: "Compatibility Watch found local drift. Review its evidence before changing routes.",
    glossaryTerm: "compatibility-watch",
  }),
  unverified: Object.freeze({
    id: "route-unverified",
    text: "This route is not currently verified. Check provider and account health before relying on it.",
    glossaryTerm: "availability",
  }),
  fallback: Object.freeze({
    id: "qualified-fallback",
    text: "Qualified fallbacks are alternatives, not automatic failover. Review the route map before rerouting.",
    glossaryTerm: "fallback",
  }),
  consult: Object.freeze({
    id: "try-consult",
    text: "Try Consult for a second opinion while the current host keeps judgment and execution.",
    glossaryTerm: "consult",
  }),
  integrated: Object.freeze({
    id: "try-integrated",
    text: "Try Integrated when a raw secondary model should reason while the current host keeps its tools.",
    glossaryTerm: "integrated",
  }),
  delegate: Object.freeze({
    id: "try-delegate",
    text: "Try Delegate for a bounded execution task whose diff and evidence the coordinator will review.",
    glossaryTerm: "delegate",
  }),
});

/** Return one static catalog tip by public key without accepting caller-authored copy. */
export function tipById(id) {
  const selected = Object.values(TIP_CATALOG).find((tip) => tip.id === id);
  return selected ? { ...selected } : null;
}

/**
 * Select at most one compact local tip from a fixed priority order.
 *
 * The input is intentionally limited to enums, booleans, and a bounded count so
 * prompts, identifiers, credentials, paths, and provider text cannot influence
 * or enter the result.
 *
 * @param {{mode?: unknown, routeVerified?: unknown, qualifiedFallbackCount?: unknown, compatibilityChanged?: unknown}} [signals]
 * @returns {{id: string, text: string, glossaryTerm: string} | null}
 */
export function selectTip(signals = {}) {
  const mode = typeof signals.mode === "string" && MODES.has(signals.mode) ? signals.mode : null;
  const routeVerified = signals.routeVerified === true;
  const qualifiedFallbackCount = Number.isInteger(signals.qualifiedFallbackCount)
    ? Math.max(0, Math.min(2, signals.qualifiedFallbackCount))
    : 0;

  let selected = null;
  if (signals.compatibilityChanged === true) selected = TIP_CATALOG.compatibility;
  else if (mode && !routeVerified) selected = TIP_CATALOG.unverified;
  else if (qualifiedFallbackCount > 0) selected = TIP_CATALOG.fallback;
  else if (mode) selected = TIP_CATALOG[mode];

  return selected ? { ...selected } : null;
}
