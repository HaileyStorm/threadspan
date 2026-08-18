import { naturalizeCopy } from "./copy-naturalizer.mjs";
import { checkCopy, describeCopyCheck, resolveCopyCheckPolicy } from "./copy-check.mjs";

/**
 * User-started release companion: local Copy review plus optional external checks.
 *
 * Ordinary packaging and the default test suite must not call this with a live
 * fetch. External timeout, failure, or skip never fails the release review.
 *
 * @param {string} value Bounded plain-text copy.
 * @param {Record<string, any>} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function reviewReleaseCopy(value, options = {}) {
  if (options.userStarted !== true) {
    throw new TypeError("Release copy review runs only when a user starts it");
  }
  const copyCheck = resolveCopyCheckPolicy(options.copyCheck ?? {});
  const description = describeCopyCheck(copyCheck);
  let local = {
    status: "skipped",
    reason: "release-scope",
    message: "Saved release scope does not request local Copy review.",
  };
  if (copyCheck.releaseScope.localReview === true && options.copyNaturalizer?.enabled === true) {
    try {
      local = await naturalizeCopy(value, {
        enabled: true,
        profile: options.copyNaturalizer.profile,
        maxInputChars: options.copyNaturalizer.maxInputChars,
        maxPasses: options.copyNaturalizer.maxPasses,
        adapterTimeoutMs: options.copyNaturalizer.timeoutMs,
        rewriteAdapter: options.rewriteAdapter ?? null,
        voiceConstraints: options.voiceConstraints,
        signal: options.signal,
      });
    } catch (error) {
      local = {
        status: "error",
        reason: "local-review-error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } else if (options.copyNaturalizer?.enabled !== true) {
    local = {
      status: "skipped",
      reason: "copy-review-disabled",
      message: "Local Copy review is disabled.",
    };
  }

  let external;
  try {
    external = await checkCopy(value, {
      ...copyCheck,
      trigger: "release",
      action: options.action ?? "check",
      confirmed: options.confirmed,
      requestedAdapters: options.adapters,
      acknowledgeRetention: options.acknowledgeRetention,
      pangramResult: options.pangramResult,
      environment: options.environment,
      fetch: options.fetch,
      openUrl: options.openUrl,
      writeClipboard: options.writeClipboard,
      signal: options.signal,
      now: options.now,
    });
  } catch (error) {
    external = {
      version: copyCheck.version,
      trigger: "release",
      action: options.action ?? "check",
      permissionMode: copyCheck.permissionMode,
      advisoryOnly: true,
      averaged: false,
      provesAuthorship: false,
      controlsRewrite: false,
      failsRelease: false,
      results: [{
        adapter: "copy-check",
        status: "error",
        score: null,
        checkedAt: new Date().toISOString(),
        displayText: error instanceof Error ? error.message : String(error),
      }],
    };
  }

  return {
    kind: "release-copy-review",
    userStarted: true,
    releaseFailed: false,
    localReviewControlsRelease: false,
    externalChecksFailRelease: false,
    advisoryOnly: true,
    averaged: false,
    provesAuthorship: false,
    policy: description,
    local,
    external,
  };
}
