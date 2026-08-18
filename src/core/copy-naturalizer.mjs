import { createHash } from "node:crypto";

/** Stable schema/version tag included in every preview result and digest. */
export const COPY_NATURALIZER_VERSION = "threadspan-copy-naturalizer/v1";

/** Required visible qualification for every injected detector signal. */
export const COPY_DETECTOR_DISCLAIMER = "Detector signals are advisory and non-probative. They cannot prove AI authorship.";

const HARD_MAX_INPUT_CHARS = 50_000;
const HARD_MAX_PASSES = 5;
const HARD_MAX_DETECTORS = 8;

/** Built-in wording profiles. They affect presentation only, never facts or protected text. */
export const COPY_NATURALIZATION_PROFILES = deepFreeze({
  human: {
    id: "human",
    label: "Human",
    guidance: "Use plain, specific wording, varied sentence lengths, and natural transitions. Keep the meaning and tone exact.",
  },
  technical: {
    id: "technical",
    label: "Technical",
    guidance: "Prefer precise verbs, explicit cause and effect, and compact technical detail. Keep terminology and factual confidence exact.",
  },
  concise: {
    id: "concise",
    label: "Concise",
    guidance: "Lead with the outcome, remove repetition and filler, and retain every detail needed to act safely.",
  },
});

/** Conservative defaults: no adapters run until the caller explicitly enables the engine. */
export const DEFAULT_COPY_NATURALIZER_OPTIONS = deepFreeze({
  enabled: false,
  profile: "human",
  maxInputChars: 12_000,
  maxPasses: 3,
  minImprovement: 0.01,
  maxExpansionRatio: 1.6,
  maxProtectedSpans: 256,
  adapterTimeoutMs: 180_000,
  tokenChars: 4,
  inputCostPerMillionTokens: null,
  outputCostPerMillionTokens: null,
});

const STOCK_PHRASES = Object.freeze([
  "in today's fast-paced world",
  "it is important to note",
  "it's important to note",
  "at the end of the day",
  "in order to",
  "a wide range of",
  "serves as a testament",
  "plays a crucial role",
]);

const FILLER_PATTERN = /\b(?:actually|basically|clearly|quite|really|simply|very)\b/giu;
const PASSIVE_PATTERN = /\b(?:am|are|be|been|being|is|was|were)\s+(?:\w+ly\s+)?[\p{L}][\p{L}'’-]*(?:ed|en)\b/giu;
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Run local readability heuristics without calling a detector or rewrite adapter.
 * @param {string} value Plain text to inspect.
 * @returns {{score: number, metrics: Record<string, number | boolean>, findings: Array<{code: string, message: string, count?: number}>}}
 */
export function analyzeCopyReadability(value) {
  const text = validatePlainText(value, HARD_MAX_INPUT_CHARS);
  const words = text.match(WORD_PATTERN) ?? [];
  const sentences = splitSentences(text);
  const sentenceLengths = sentences.map((sentence) => (sentence.match(WORD_PATTERN) ?? []).length).filter(Boolean);
  const longSentences = sentenceLengths.filter((length) => length > 28).length;
  const averageSentenceWords = sentenceLengths.length === 0
    ? words.length
    : sentenceLengths.reduce((sum, length) => sum + length, 0) / sentenceLengths.length;
  const fillerCount = countMatches(text, FILLER_PATTERN);
  const passiveCount = countMatches(text, PASSIVE_PATTERN);
  const stockPhraseCount = STOCK_PHRASES.reduce((count, phrase) => count + countOccurrences(text, phrase, false), 0);
  const repeatedOpeners = countRepeatedOpeners(sentences);
  const machineStructured = looksMachineStructured(text);

  let penalty = 0;
  if (averageSentenceWords > 22) penalty += Math.min(0.24, (averageSentenceWords - 22) * 0.012);
  penalty += Math.min(0.24, longSentences * 0.08);
  penalty += Math.min(0.18, stockPhraseCount * 0.06);
  penalty += Math.min(0.14, words.length === 0 ? 0 : (fillerCount / words.length) * 5);
  penalty += Math.min(0.10, words.length === 0 ? 0 : (passiveCount / words.length) * 3);
  penalty += Math.min(0.10, repeatedOpeners * 0.04);
  const score = Number(Math.max(0, Math.min(1, 1 - penalty)).toFixed(4));

  const findings = [];
  if (machineStructured) findings.push({ code: "structured-content", message: "The input looks machine-structured and should remain exact." });
  if (longSentences > 0) findings.push({ code: "long-sentences", message: "Break up long sentences where the meaning stays clear.", count: longSentences });
  if (stockPhraseCount > 0) findings.push({ code: "stock-framing", message: "Replace stock framing with direct wording.", count: stockPhraseCount });
  if (fillerCount > 0) findings.push({ code: "filler", message: "Remove filler that does not change the meaning.", count: fillerCount });
  if (passiveCount > 0) findings.push({ code: "passive-voice", message: "Use active voice where the actor is known.", count: passiveCount });
  if (repeatedOpeners > 0) findings.push({ code: "repeated-openers", message: "Vary repeated sentence openings.", count: repeatedOpeners });
  if (findings.length === 0) findings.push({ code: "clear", message: "The copy is already direct and readable." });

  return {
    score,
    metrics: {
      characters: text.length,
      words: words.length,
      sentences: sentenceLengths.length,
      averageSentenceWords: Number(averageSentenceWords.toFixed(2)),
      longSentences,
      stockPhraseCount,
      fillerCount,
      passiveCount,
      repeatedOpeners,
      machineStructured,
    },
    findings: findings.slice(0, 6),
  };
}

/**
 * Extract bounded exact-text evidence that a rewrite must preserve as a multiset.
 * @param {string} value Plain text to inspect.
 * @param {{maxInputChars?: number, maxProtectedSpans?: number}} [options] Bounds for standalone inspection.
 * @returns {{spans: Array<{kind: string, start: number, end: number, text: string, sha256: string}>, counts: Record<string, number>}}
 */
export function inspectProtectedCopySpans(value, options = {}) {
  const maxInputChars = boundedInteger(options.maxInputChars, DEFAULT_COPY_NATURALIZER_OPTIONS.maxInputChars, 1, HARD_MAX_INPUT_CHARS, "maxInputChars");
  const maxProtectedSpans = boundedInteger(options.maxProtectedSpans, DEFAULT_COPY_NATURALIZER_OPTIONS.maxProtectedSpans, 1, 512, "maxProtectedSpans");
  const text = validatePlainText(value, maxInputChars);
  const spans = collectProtectedSpans(text);
  if (spans.length > maxProtectedSpans) throw new RangeError(`Copy contains more than ${maxProtectedSpans} protected spans`);
  const evidence = spans.map((span) => ({
    ...span,
    sha256: sha256(span.text),
  }));
  return { spans: evidence, counts: countProtectedEvidence(evidence) };
}

/**
 * Resolve and validate the public engine options without selecting a provider or model.
 * @param {Record<string, any>} [options] Naturalization policy and injected adapters.
 * @returns {Record<string, any>} Validated effective options.
 */
export function resolveCopyNaturalizerOptions(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("Copy naturalizer options must be an object");
  if (options.enabled !== undefined && typeof options.enabled !== "boolean") throw new TypeError("enabled must be a boolean");
  const profile = options.profile ?? DEFAULT_COPY_NATURALIZER_OPTIONS.profile;
  if (typeof profile !== "string" || !COPY_NATURALIZATION_PROFILES[profile]) throw new TypeError(`Unknown copy naturalization profile '${String(profile)}'`);
  const detectors = options.detectors ?? [];
  if (!Array.isArray(detectors) || detectors.length > HARD_MAX_DETECTORS) throw new TypeError(`detectors must contain at most ${HARD_MAX_DETECTORS} adapters`);
  for (const [index, detector] of detectors.entries()) {
    if (typeof detector !== "function" && (!isObjectLike(detector) || typeof safeRead(detector, "analyze") !== "function")) {
      throw new TypeError(`detectors[${index}] must be a function or expose analyze()`);
    }
  }
  const rewriteAdapter = options.rewriteAdapter ?? null;
  if (rewriteAdapter !== null && typeof rewriteAdapter !== "function"
    && (!isObjectLike(rewriteAdapter) || typeof safeRead(rewriteAdapter, "rewrite") !== "function")) {
    throw new TypeError("rewriteAdapter must be a function or expose rewrite()");
  }
  const inputCostPerMillionTokens = optionalRate(options.inputCostPerMillionTokens, "inputCostPerMillionTokens");
  const outputCostPerMillionTokens = optionalRate(options.outputCostPerMillionTokens, "outputCostPerMillionTokens");
  const signal = options.signal;
  if (signal !== undefined && (typeof signal !== "object" || typeof signal.addEventListener !== "function" || typeof signal.aborted !== "boolean")) {
    throw new TypeError("signal must be an AbortSignal");
  }
  return {
    enabled: options.enabled ?? DEFAULT_COPY_NATURALIZER_OPTIONS.enabled,
    profile,
    detectors: [...detectors],
    rewriteAdapter,
    voiceConstraints: normalizeVoiceConstraints(options.voiceConstraints),
    maxInputChars: boundedInteger(options.maxInputChars, DEFAULT_COPY_NATURALIZER_OPTIONS.maxInputChars, 1, HARD_MAX_INPUT_CHARS, "maxInputChars"),
    maxPasses: boundedInteger(options.maxPasses, DEFAULT_COPY_NATURALIZER_OPTIONS.maxPasses, 1, HARD_MAX_PASSES, "maxPasses"),
    minImprovement: boundedNumber(options.minImprovement, DEFAULT_COPY_NATURALIZER_OPTIONS.minImprovement, 0, 1, "minImprovement"),
    maxExpansionRatio: boundedNumber(options.maxExpansionRatio, DEFAULT_COPY_NATURALIZER_OPTIONS.maxExpansionRatio, 1, 3, "maxExpansionRatio"),
    maxProtectedSpans: boundedInteger(options.maxProtectedSpans, DEFAULT_COPY_NATURALIZER_OPTIONS.maxProtectedSpans, 1, 512, "maxProtectedSpans"),
    adapterTimeoutMs: boundedInteger(options.adapterTimeoutMs, DEFAULT_COPY_NATURALIZER_OPTIONS.adapterTimeoutMs, 25, 600_000, "adapterTimeoutMs"),
    tokenChars: boundedInteger(options.tokenChars, DEFAULT_COPY_NATURALIZER_OPTIONS.tokenChars, 1, 8, "tokenChars"),
    inputCostPerMillionTokens,
    outputCostPerMillionTokens,
    signal,
  };
}

/**
 * Produce a review-only wording suggestion. Detectors are advisory, adapters are injected by the caller,
 * and every changed suggestion requires a separate caller-controlled apply action.
 * @param {string} value Bounded plain-text copy.
 * @param {Record<string, any>} [options] See {@link resolveCopyNaturalizerOptions}.
 * @returns {Promise<Record<string, any>>} Original text, suggestion, findings, safety evidence, estimates, and preview digest.
 */
export async function naturalizeCopy(value, options = {}) {
  const policy = resolveCopyNaturalizerOptions(options);
  throwIfAborted(policy.signal);
  const original = validatePlainText(value, policy.maxInputChars);
  const baselineProtection = inspectProtectedCopySpans(original, policy);
  const originalAnalysis = analyzeCopyReadability(original);
  const tracker = createEstimateTracker(policy);
  const passHistory = [];
  let current = original;
  let currentAnalysis = originalAnalysis;
  let attempted = 0;
  let accepted = 0;
  let stopReason = "disabled";
  let reviewRequired = false;
  let protectionChange = [];
  let rejectedPass;
  let detectorInitial = [];
  let detectorSuggestion = [];

  if (policy.enabled) {
    detectorInitial = await runDetectors(original, "original", policy, tracker);
    detectorSuggestion = detectorInitial;
    if (originalAnalysis.metrics.machineStructured) {
      stopReason = "structured-content";
    } else if (!policy.rewriteAdapter) {
      stopReason = "no-rewrite-adapter";
    } else {
      const seen = new Set([sha256(original)]);
      stopReason = "pass-limit";
      for (let pass = 1; pass <= policy.maxPasses; pass += 1) {
        throwIfAborted(policy.signal);
        attempted += 1;
        let adapterOutput;
        try {
          adapterOutput = await runRewriteAdapter(current, pass, currentAnalysis, baselineProtection, policy, tracker);
        } catch (error) {
          if (policy.signal?.aborted) throw abortReason(policy.signal);
          stopReason = error instanceof AdapterTimeoutError ? "adapter-timeout" : "adapter-error";
          passHistory.push({ pass, disposition: stopReason });
          break;
        }
        if (!adapterOutput) {
          stopReason = "invalid-rewrite-output";
          passHistory.push({ pass, disposition: stopReason });
          break;
        }
        const candidate = adapterOutput.text;
        if (candidate === current || seen.has(sha256(candidate))) {
          stopReason = "convergence";
          passHistory.push({ pass, disposition: stopReason });
          break;
        }

        let candidateProtection;
        try {
          candidateProtection = inspectProtectedCopySpans(candidate, policy);
        } catch {
          reviewRequired = true;
          stopReason = "protected-span-change";
          protectionChange = [{ kind: "bounds", reason: "candidate-protection-overflow" }];
          rejectedPass = pass;
          passHistory.push({ pass, disposition: "rejected-protected-change" });
          break;
        }
        protectionChange = compareProtectedEvidence(baselineProtection, candidateProtection);
        const voiceChange = compareVoiceConstraints(original, candidate, policy.voiceConstraints);
        if (protectionChange.length > 0 || voiceChange.length > 0) {
          reviewRequired = true;
          stopReason = protectionChange.length > 0 ? "protected-span-change" : "voice-constraint-change";
          protectionChange = [...protectionChange, ...voiceChange];
          rejectedPass = pass;
          passHistory.push({ pass, disposition: "rejected-protected-change" });
          break;
        }

        const candidateAnalysis = analyzeCopyReadability(candidate);
        const improvement = Number((candidateAnalysis.score - currentAnalysis.score).toFixed(4));
        if (improvement < policy.minImprovement) {
          stopReason = "no-improvement";
          passHistory.push({
            pass,
            disposition: stopReason,
            scoreBefore: currentAnalysis.score,
            scoreAfter: candidateAnalysis.score,
            improvement,
          });
          break;
        }
        current = candidate;
        currentAnalysis = candidateAnalysis;
        accepted += 1;
        seen.add(sha256(candidate));
        passHistory.push({
          pass,
          disposition: "accepted",
          scoreBefore: Number((candidateAnalysis.score - improvement).toFixed(4)),
          scoreAfter: candidateAnalysis.score,
          improvement,
          suggestionSha256: sha256(candidate),
        });
      }
      if (current !== original) detectorSuggestion = await runDetectors(current, "suggestion", policy, tracker);
    }
  }

  const disagreement = summarizeDetectorDisagreement(detectorSuggestion);
  const findings = reviewRequired
    ? [{ code: "review-required", message: "A rewrite changed protected text and was rejected; explicit review is required." }, ...currentAnalysis.findings].slice(0, 6)
    : currentAnalysis.findings;
  const protectedSpans = {
    preserved: protectionChange.length === 0,
    evidence: baselineProtection.spans,
    counts: baselineProtection.counts,
    changed: protectionChange,
    ...(rejectedPass === undefined ? {} : { rejectedPass }),
  };
  const estimates = finishEstimates(tracker, { maximum: policy.maxPasses, attempted, accepted, stopReason });
  const status = !policy.enabled
    ? "disabled"
    : reviewRequired
      ? "review-required"
      : current !== original
        ? "suggested"
        : stopReason === "no-rewrite-adapter" || stopReason === "structured-content"
          ? "analyzed"
          : "unchanged";
  const digestPayload = {
    version: COPY_NATURALIZER_VERSION,
    original,
    suggestion: current,
    profile: policy.profile,
    voiceConstraints: policy.voiceConstraints,
    protectedCounts: baselineProtection.counts,
    reviewRequired,
  };

  return {
    version: COPY_NATURALIZER_VERSION,
    status,
    enabled: policy.enabled,
    autoApply: false,
    original,
    suggestion: current,
    profile: COPY_NATURALIZATION_PROFILES[policy.profile],
    voiceConstraints: structuredClone(policy.voiceConstraints),
    analysis: currentAnalysis,
    findings,
    detectorDisclaimer: COPY_DETECTOR_DISCLAIMER,
    detectors: { original: detectorInitial, suggestion: detectorSuggestion },
    detectorDisagreement: disagreement,
    protectedSpans,
    reviewRequired,
    passes: passHistory,
    estimates,
    previewDigest: sha256(stableStringify(digestPayload)),
  };
}

async function runRewriteAdapter(text, pass, analysis, protection, policy, tracker) {
  const adapter = policy.rewriteAdapter;
  const rewrite = typeof adapter === "function" ? adapter : safeRead(adapter, "rewrite");
  const receiver = typeof adapter === "function" ? undefined : adapter;
  const context = deepFreeze({
    version: COPY_NATURALIZER_VERSION,
    purpose: "readability-preview",
    pass,
    profile: COPY_NATURALIZATION_PROFILES[policy.profile],
    voiceConstraints: structuredClone(policy.voiceConstraints),
    findings: structuredClone(analysis.findings),
    protectedSpans: protection.spans.map(({ kind, text: exact, sha256: digest }) => ({ kind, text: exact, sha256: digest })),
    rules: [
      "Return plain text only.",
      "Preserve every protected span and numeric fact exactly.",
      "Preserve the selected Voice constraints and factual confidence.",
      "Improve readability only; detector signals are not an acceptance target.",
    ],
  });
  const estimatedInput = text + stableStringify(context);
  let raw;
  try {
    raw = await callBounded(
      (signal) => Reflect.apply(rewrite, receiver, [text, Object.freeze({ ...context, signal })]),
      policy.adapterTimeoutMs,
      policy.signal,
    );
  } catch (error) {
    recordAdapterEstimate(tracker, estimatedInput, "", undefined, undefined);
    throw error;
  }
  const output = normalizeRewriteOutput(raw, text, policy);
  recordAdapterEstimate(tracker, estimatedInput, output?.text ?? "", output?.usage, output?.costUsd);
  return output;
}

function normalizeRewriteOutput(raw, input, policy) {
  let text;
  let usage;
  let costUsd;
  try {
    if (typeof raw === "string") {
      text = raw;
    } else if (isPlainObject(raw)) {
      text = raw.text;
      usage = normalizeUsage(raw.usage);
      costUsd = optionalNonnegative(raw.costUsd);
    }
  } catch {
    return null;
  }
  if (typeof text !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return null;
  const expansionLimit = Math.max(input.length + 64, Math.ceil(input.length * policy.maxExpansionRatio));
  if (text.length > policy.maxInputChars || text.length > expansionLimit) return null;
  return { text, usage, costUsd };
}

async function runDetectors(text, stage, policy, tracker) {
  const promises = policy.detectors.map(async (adapter, index) => {
    const id = detectorId(adapter, index);
    const analyze = typeof adapter === "function" ? adapter : safeRead(adapter, "analyze");
    const receiver = typeof adapter === "function" ? undefined : adapter;
    recordAdapterEstimate(tracker, text, "", undefined, undefined);
    try {
      const raw = await callBounded((signal) => Reflect.apply(analyze, receiver, [text, Object.freeze({
        version: COPY_NATURALIZER_VERSION,
        purpose: "advisory-readability-signal",
        stage,
        profileId: policy.profile,
        disclaimer: COPY_DETECTOR_DISCLAIMER,
        signal,
      })]), policy.adapterTimeoutMs, policy.signal);
      const score = detectorScore(raw);
      return score === null ? { id, status: "invalid-output" } : { id, status: "ok", score };
    } catch (error) {
      if (policy.signal?.aborted) throw abortReason(policy.signal);
      return { id, status: error instanceof AdapterTimeoutError ? "timeout" : "error" };
    }
  });
  return Promise.all(promises);
}

function detectorScore(raw) {
  try {
    if (!isPlainObject(raw)) return null;
    const score = raw.score;
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 1
      ? Number(score.toFixed(4))
      : null;
  } catch {
    return null;
  }
}

function summarizeDetectorDisagreement(results) {
  const scores = results.filter((result) => result.status === "ok").map((result) => result.score);
  if (scores.length < 2) {
    return {
      present: false,
      comparableSignals: scores.length,
      scoreSpread: null,
      summary: scores.length === 0 ? "No comparable detector signals." : "Only one comparable detector signal.",
    };
  }
  const scoreSpread = Number((Math.max(...scores) - Math.min(...scores)).toFixed(4));
  const present = scoreSpread >= 0.35;
  return {
    present,
    comparableSignals: scores.length,
    scoreSpread,
    summary: present ? "Advisory detector signals materially disagree." : "Advisory detector signals are broadly aligned.",
  };
}

function collectProtectedSpans(text) {
  const candidates = [];
  collectCodeFences(text, candidates);
  collectPattern(text, candidates, "code-span", /`[^`\n]+`/gu, 1);
  collectPattern(text, candidates, "quoted-text", /^(?:[ \t]*>[^\n]*(?:\n|$))+/gmu, 2);
  collectPattern(text, candidates, "quoted-text", /"[^"\n]{1,2000}"/gu, 2);
  collectPattern(text, candidates, "quoted-text", /“[^”\n]{1,2000}”/gu, 2);
  collectPattern(text, candidates, "quoted-text", /‘[^’\n]{1,2000}’/gu, 2);
  collectAsciiSingleQuotes(text, candidates);
  collectPattern(text, candidates, "url", /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu, 3, trimUrlPunctuation);
  collectPattern(text, candidates, "address", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, 3);
  collectPattern(text, candidates, "address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, 3);
  collectPattern(text, candidates, "address", /\b\d{1,6}\s+(?:[\p{L}0-9.'-]+\s+){0,6}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Highway|Hwy|Place|Pl|Trail|Trl|Parkway|Pkwy|Circle|Cir)\.?\b(?:\s+(?:Apt|Apartment|Suite|Unit|#)\s*[A-Z0-9-]+)?/giu, 3);
  collectPattern(text, candidates, "mention", /@[A-Z0-9_][A-Z0-9_.-]{0,63}/giu, 4);
  collectPattern(text, candidates, "numeric-fact", /(?<![\p{L}\p{N}_])(?:[$€£¥]\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:%|°[CF]?|ms|s|min|h|KB|MB|GB|TB|B|Hz|kHz|MHz|GHz|kg|g|mg|km|m|cm|mm|mi|ft|in))?(?![\p{L}\p{N}_])/giu, 5);

  candidates.sort((left, right) => left.priority - right.priority || left.start - right.start || right.end - left.end);
  const selected = [];
  for (const candidate of candidates) {
    if (candidate.end <= candidate.start || selected.some((span) => rangesOverlap(span, candidate))) continue;
    selected.push(candidate);
  }
  return selected
    .sort((left, right) => left.start - right.start)
    .map(({ kind, start, end, text: exact }) => ({ kind, start, end, text: exact }));
}

function collectCodeFences(text, candidates) {
  const opening = /^[ \t]*(```|~~~)[^\n]*(?:\n|$)/gmu;
  for (const match of text.matchAll(opening)) {
    const marker = match[1];
    const afterOpening = match.index + match[0].length;
    const closePattern = new RegExp(`^[ \\t]*${marker}[ \\t]*(?:\\n|$)`, "gmu");
    closePattern.lastIndex = afterOpening;
    const closing = closePattern.exec(text);
    const end = closing ? closing.index + closing[0].length : text.length;
    candidates.push({ kind: "code-fence", start: match.index, end, text: text.slice(match.index, end), priority: 0 });
    opening.lastIndex = end;
  }
}

function collectAsciiSingleQuotes(text, candidates) {
  const pattern = /(^|[\s([{])('[^'\n]{1,1000}')(?=$|[\s.,!?;:)\]}])/gmu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1].length;
    candidates.push({ kind: "quoted-text", start, end: start + match[2].length, text: match[2], priority: 2 });
  }
}

function collectPattern(text, candidates, kind, pattern, priority, transform = (match) => match[0]) {
  for (const match of text.matchAll(pattern)) {
    const exact = transform(match);
    const start = match.index;
    candidates.push({ kind, start, end: start + exact.length, text: exact, priority });
  }
}

function trimUrlPunctuation(match) {
  return match[0].replace(/[.,!?;:]+$/u, "").replace(/\)+$/u, (closing) => {
    const source = match[0].slice(0, -closing.length);
    const unmatched = Math.max(0, closing.length - Math.max(0, countChar(source, "(") - countChar(source, ")")));
    return closing.slice(0, closing.length - unmatched);
  });
}

function compareProtectedEvidence(original, candidate) {
  const keys = new Set([...Object.keys(original.counts), ...Object.keys(candidate.counts)]);
  const changed = [];
  for (const key of [...keys].sort()) {
    const originalCount = original.counts[key] ?? 0;
    const suggestionCount = candidate.counts[key] ?? 0;
    if (originalCount === suggestionCount) continue;
    const separator = key.indexOf(":");
    changed.push({
      kind: key.slice(0, separator),
      sha256: key.slice(separator + 1),
      originalCount,
      suggestionCount,
    });
  }
  return changed;
}

function countProtectedEvidence(spans) {
  const counts = {};
  for (const span of spans) {
    const key = `${span.kind}:${span.sha256}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function compareVoiceConstraints(original, candidate, voice) {
  const changes = [];
  for (const phrase of voice.requiredPhrases) {
    const originalCount = countOccurrences(original, phrase, true);
    const suggestionCount = countOccurrences(candidate, phrase, true);
    const requiredCount = Math.max(1, originalCount);
    if (suggestionCount < requiredCount) changes.push({ kind: "voice-required-phrase", sha256: sha256(phrase), originalCount: requiredCount, suggestionCount });
  }
  for (const term of voice.preferredTerms) {
    const originalCount = countOccurrences(original, term, false);
    const suggestionCount = countOccurrences(candidate, term, false);
    if (suggestionCount < originalCount) changes.push({ kind: "voice-preferred-term", sha256: sha256(term), originalCount, suggestionCount });
  }
  for (const term of voice.avoidedTerms) {
    const originalCount = countOccurrences(original, term, false);
    const suggestionCount = countOccurrences(candidate, term, false);
    if (suggestionCount > originalCount) changes.push({ kind: "voice-avoided-term", sha256: sha256(term), originalCount, suggestionCount });
  }
  return changes;
}

function normalizeVoiceConstraints(value) {
  if (value === undefined || value === null) {
    return deepFreeze({ id: null, parameters: {}, constraints: [], requiredPhrases: [], preferredTerms: [], avoidedTerms: [] });
  }
  if (!isPlainObject(value)) throw new TypeError("voiceConstraints must be an object");
  const id = value.id === undefined && value.profileId === undefined
    ? null
    : boundedText(value.id ?? value.profileId, "voiceConstraints.id", 64);
  const parameters = value.parameters ?? {};
  if (!isPlainObject(parameters) || Object.keys(parameters).length > 16) throw new TypeError("voiceConstraints.parameters must be a bounded object");
  const normalizedParameters = {};
  for (const [key, parameter] of Object.entries(parameters)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(key) || !Number.isInteger(parameter) || parameter < 1 || parameter > 5) {
      throw new TypeError(`Invalid Voice parameter '${key}'`);
    }
    normalizedParameters[key] = parameter;
  }
  return deepFreeze({
    id,
    parameters: normalizedParameters,
    constraints: boundedTextArray(value.constraints ?? [], "voiceConstraints.constraints", 8, 200),
    requiredPhrases: boundedTextArray(value.requiredPhrases ?? [], "voiceConstraints.requiredPhrases", 16, 120),
    preferredTerms: boundedTextArray(value.preferredTerms ?? [], "voiceConstraints.preferredTerms", 16, 64),
    avoidedTerms: boundedTextArray(value.avoidedTerms ?? [], "voiceConstraints.avoidedTerms", 16, 64),
  });
}

function createEstimateTracker(policy) {
  return {
    policy,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costKnown: true,
    costUsd: 0,
    usedAdapterUsage: false,
  };
}

function recordAdapterEstimate(tracker, input, output, usage, reportedCost) {
  const estimatedInput = estimateTokens(input, tracker.policy.tokenChars);
  const estimatedOutput = estimateTokens(output, tracker.policy.tokenChars);
  const inputTokens = usage?.inputTokens ?? estimatedInput;
  const outputTokens = usage?.outputTokens ?? estimatedOutput;
  tracker.calls += 1;
  tracker.inputTokens += inputTokens;
  tracker.outputTokens += outputTokens;
  tracker.usedAdapterUsage ||= Boolean(usage);
  if (reportedCost !== undefined) {
    tracker.costUsd += reportedCost;
    return;
  }
  const inputRate = tracker.policy.inputCostPerMillionTokens;
  const outputRate = tracker.policy.outputCostPerMillionTokens;
  if (inputRate === null || outputRate === null) {
    tracker.costKnown = false;
    return;
  }
  tracker.costUsd += (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

function finishEstimates(tracker, passes) {
  const total = tracker.inputTokens + tracker.outputTokens;
  return {
    passes,
    adapterCalls: tracker.calls,
    tokens: {
      input: tracker.inputTokens,
      output: tracker.outputTokens,
      total,
      estimated: !tracker.usedAdapterUsage,
      method: tracker.usedAdapterUsage ? "Adapter usage when supplied; character estimate otherwise." : `Character estimate at ${tracker.policy.tokenChars} characters per token.`,
    },
    cost: {
      currency: "USD",
      amount: tracker.calls === 0 ? 0 : tracker.costKnown ? Number(tracker.costUsd.toFixed(8)) : null,
      estimated: true,
      method: tracker.calls === 0
        ? "No adapter calls."
        : tracker.costKnown
          ? "Adapter-reported cost or caller-supplied per-token rates."
          : "Unavailable until the caller supplies rates or adapter-reported cost.",
    },
  };
}

function normalizeUsage(value) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return undefined;
  const inputTokens = optionalSafeInteger(value.inputTokens);
  const outputTokens = optionalSafeInteger(value.outputTokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
}

function estimateTokens(value, tokenChars) {
  return value.length === 0 ? 0 : Math.ceil(value.length / tokenChars);
}

function detectorId(adapter, index) {
  try {
    const candidate = typeof adapter === "function" ? adapter.id : adapter.id;
    if (typeof candidate === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/u.test(candidate)) return candidate;
  } catch {
    // Use a stable local id when adapter metadata is hostile or malformed.
  }
  return `detector-${index + 1}`;
}

function splitSentences(text) {
  return text.split(/(?<=[.!?])\s+|\n{2,}/u).map((sentence) => sentence.trim()).filter(Boolean);
}

function countRepeatedOpeners(sentences) {
  const counts = new Map();
  let repeated = 0;
  for (const sentence of sentences) {
    const opener = (sentence.match(WORD_PATTERN) ?? []).slice(0, 2).join(" ").toLowerCase();
    if (!opener) continue;
    const count = (counts.get(opener) ?? 0) + 1;
    counts.set(opener, count);
    if (count > 1) repeated += 1;
  }
  return repeated;
}

function looksMachineStructured(text) {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) return false;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

function countMatches(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].length;
}

function countOccurrences(text, needle, caseSensitive) {
  if (!needle) return 0;
  const source = caseSensitive ? text : text.toLocaleLowerCase("en-US");
  const target = caseSensitive ? needle : needle.toLocaleLowerCase("en-US");
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(target, index)) !== -1) {
    count += 1;
    index += target.length;
  }
  return count;
}

function countChar(value, character) {
  return [...value].filter((item) => item === character).length;
}

function rangesOverlap(left, right) {
  return left.start < right.end && right.start < left.end;
}

function validatePlainText(value, maximum) {
  if (typeof value !== "string") throw new TypeError("Copy must be plain text");
  if (value.length > maximum) throw new RangeError(`Copy exceeds the ${maximum}-character limit`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError("Copy contains unsupported control characters");
  return value;
}

function boundedTextArray(value, label, maximumItems, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumItems) throw new TypeError(`${label} must contain at most ${maximumItems} items`);
  const result = value.map((item, index) => boundedText(item, `${label}[${index}]`, maximumLength));
  if (new Set(result.map((item) => item.toLocaleLowerCase("en-US"))).size !== result.length) throw new TypeError(`${label} must not contain duplicates`);
  return result;
}

function boundedText(value, label, maximumLength) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be bounded plain text`);
  return value;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  return candidate;
}

function boundedNumber(value, fallback, minimum, maximum, label) {
  const candidate = value ?? fallback;
  if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < minimum || candidate > maximum) throw new TypeError(`${label} must be from ${minimum} to ${maximum}`);
  return candidate;
}

function optionalRate(value, label) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a nonnegative number or null`);
  return value;
}

function optionalNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeRead(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

class AdapterTimeoutError extends Error {}

function callBounded(invoke, timeoutMs, parentSignal) {
  throwIfAborted(parentSignal);
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => {
      controller.abort(parentSignal.reason);
      settle(reject, abortReason(parentSignal));
    };
    const timer = setTimeout(() => {
      controller.abort(new AdapterTimeoutError("Adapter timed out"));
      settle(reject, new AdapterTimeoutError("Adapter timed out"));
    }, timeoutMs);
    timer.unref?.();
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    if (parentSignal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => invoke(controller.signal))
      .then((result) => settle(resolve, result), (error) => settle(reject, error));
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal) {
  return signal?.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
