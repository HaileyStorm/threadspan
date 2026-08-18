import { createHash } from "node:crypto";

export const OUTPUT_SUMMARY_VERSION = "threadspan-output-summary/v1";

export const DEFAULT_OUTPUT_SUMMARY_OPTIONS = Object.freeze({
  enabled: true,
  minBytes: 128 * 1024,
  minLines: 512,
  minRepetitions: 64,
  minDuplicateLineRatio: 0.9,
  headBytes: 8 * 1024,
  tailBytes: 8 * 1024,
});

const REPLAY_CRITICAL_PROVIDER_PATTERN = /(?:^|[-_/])(nous|deepseek)(?:$|[-_/])/i;
const REPLAY_CRITICAL_PURPOSE_PATTERN = /wire|replay|serializ|canonical|session-store|raw-evidence|private-evidence|acceptance-evidence|run-evidence/i;

/**
 * Replace only large, line-repetitive output with a deterministic head/tail summary.
 * The input string is never mutated and exact content is returned whenever eligibility is uncertain.
 * @param {string} value Output text.
 * @param {Record<string, any>} [options] Conservative thresholds and path/provider context.
 * @returns {{content: string, summarized: boolean, metadata?: Record<string, any>}}
 */
export function summarizeRepetitiveOutput(value, options = {}) {
  const content = String(value ?? "");
  const policy = resolveOutputSummaryOptions(options);
  if (!summaryAllowed(policy)) return { content, summarized: false };

  const bytes = Buffer.from(content, "utf8");
  if (bytes.length < policy.minBytes) return { content, summarized: false };

  const lines = indexLines(bytes);
  if (lines.length < policy.minLines) return { content, summarized: false };

  const repetition = measureLineRepetition(bytes, lines);
  if (
    repetition.repetitionCount < policy.minRepetitions
    || repetition.duplicateLineRatio < policy.minDuplicateLineRatio
  ) {
    return { content, summarized: false };
  }

  const bounds = selectExactBounds(lines, bytes.length, policy.headBytes, policy.tailBytes);
  if (!bounds || bounds.tailStart <= bounds.headEnd) return { content, summarized: false };

  const head = bytes.subarray(0, bounds.headEnd).toString("utf8");
  const tail = bytes.subarray(bounds.tailStart).toString("utf8");
  const metadata = {
    version: OUTPUT_SUMMARY_VERSION,
    originalBytes: bytes.length,
    originalLines: lines.length,
    omittedBytes: bounds.tailStart - bounds.headEnd,
    omittedLines: bounds.tailLineIndex - bounds.headLineCount,
    headBytes: bounds.headEnd,
    tailBytes: bytes.length - bounds.tailStart,
    repetitionCount: repetition.repetitionCount,
    duplicateLineRatio: Number(repetition.duplicateLineRatio.toFixed(6)),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (metadata.omittedBytes <= 0 || metadata.omittedLines <= 0) return { content, summarized: false };

  return {
    content: [
      "[THREADSPAN PROGRAMMATIC OUTPUT SUMMARY]",
      JSON.stringify(metadata),
      "--- EXACT HEAD ---",
      head,
      "--- OMITTED REPETITIVE OUTPUT ---",
      `bytes=${metadata.omittedBytes} lines=${metadata.omittedLines}`,
      "--- EXACT TAIL ---",
      tail,
      "[END THREADSPAN PROGRAMMATIC OUTPUT SUMMARY]",
    ].join("\n"),
    summarized: true,
    metadata,
  };
}

/** Normalize configurable thresholds while retaining conservative defaults. */
export function resolveOutputSummaryOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    minBytes: positiveInteger(options.minBytes, DEFAULT_OUTPUT_SUMMARY_OPTIONS.minBytes),
    minLines: positiveInteger(options.minLines, DEFAULT_OUTPUT_SUMMARY_OPTIONS.minLines),
    minRepetitions: positiveInteger(options.minRepetitions, DEFAULT_OUTPUT_SUMMARY_OPTIONS.minRepetitions),
    minDuplicateLineRatio: ratio(options.minDuplicateLineRatio, DEFAULT_OUTPUT_SUMMARY_OPTIONS.minDuplicateLineRatio),
    headBytes: positiveInteger(options.headBytes, DEFAULT_OUTPUT_SUMMARY_OPTIONS.headBytes),
    tailBytes: positiveInteger(options.tailBytes, DEFAULT_OUTPUT_SUMMARY_OPTIONS.tailBytes),
    providerId: optionalString(options.providerId),
    adapter: optionalString(options.adapter),
    purpose: optionalString(options.purpose),
    path: optionalString(options.path),
    replayCritical: options.replayCritical === true,
  };
}

/** Fail closed for provider serialization, replay, canonical storage, and evidence paths. */
function summaryAllowed(policy) {
  if (!policy.enabled || policy.replayCritical) return false;
  if ([policy.providerId, policy.adapter].filter(Boolean).some((value) => REPLAY_CRITICAL_PROVIDER_PATTERN.test(value))) return false;
  if ([policy.purpose, policy.path].filter(Boolean).some((value) => REPLAY_CRITICAL_PURPOSE_PATTERN.test(value))) return false;
  return true;
}

/** Index UTF-8 line byte ranges, retaining newline bytes in each complete line. */
function indexLines(bytes) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < bytes.length) lines.push({ start, end: bytes.length });
  return lines;
}

/** Count exact duplicate lines without normalizing timestamps, paths, or other evidence. */
function measureLineRepetition(bytes, lines) {
  const counts = new Map();
  let repetitionCount = 0;
  for (const line of lines) {
    let end = line.end;
    if (end > line.start && bytes[end - 1] === 0x0a) end -= 1;
    if (end > line.start && bytes[end - 1] === 0x0d) end -= 1;
    const key = bytes.subarray(line.start, end).toString("base64");
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count > repetitionCount) repetitionCount = count;
  }
  const duplicateLines = [...counts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  return {
    repetitionCount,
    duplicateLineRatio: lines.length === 0 ? 0 : duplicateLines / lines.length,
  };
}

/** Select complete-line head/tail boundaries that do not exceed configured byte budgets. */
function selectExactBounds(lines, totalBytes, headBudget, tailBudget) {
  let headLineCount = 0;
  let headEnd = 0;
  while (headLineCount < lines.length && lines[headLineCount].end <= headBudget) {
    headEnd = lines[headLineCount].end;
    headLineCount += 1;
  }
  if (headLineCount === 0) return undefined;

  let tailLineIndex = lines.length;
  let tailStart = totalBytes;
  while (tailLineIndex > headLineCount) {
    const candidate = lines[tailLineIndex - 1].start;
    if (totalBytes - candidate > tailBudget) break;
    tailLineIndex -= 1;
    tailStart = candidate;
  }
  if (tailLineIndex === lines.length) return undefined;
  return { headEnd, headLineCount, tailStart, tailLineIndex };
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function ratio(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
