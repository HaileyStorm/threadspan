const SENSITIVE_KEY = /(authorization|api[-_]?key|token|secret|password|cookie|session)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/=:-]+/gi;
const LONG_SECRET = /\b(?:sk|cursor|ghp|pat|jwt|key)[-_][A-Za-z0-9._~+\/=:-]{12,}\b/gi;

/**
 * Recursively redact likely credentials without mutating the input.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 12) return "[depth-limit]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, child] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(child, depth + 1);
    }
    return output;
  }
  return value;
}

/** Redact likely credentials embedded in free text. */
export function redactText(text) {
  return text.replace(BEARER, "Bearer [redacted]").replace(LONG_SECRET, "[redacted]");
}
/**
 * Serialize an arbitrary value for opt-in body logging after credential redaction.
 *
 * The returned object keeps the actual structured payload out of the logger, preventing a
 * multi-megabyte request or response from bypassing the log-size bound during final JSON
 * serialization. `maxChars` counts JavaScript string code units rather than encoded bytes.
 *
 * @param {unknown} value Value to serialize.
 * @param {number} [maxChars=32768] Maximum serialized characters retained.
 * @returns {{json: string, truncated: boolean, originalChars: number}}
 */
export function boundedRedactedJson(value, maxChars = 32_768) {
  const normalizedLimit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 32_768;
  let json;
  try {
    json = JSON.stringify(redact(value));
  } catch (error) {
    json = JSON.stringify({ serializationError: error instanceof Error ? error.message : String(error) });
  }
  if (json === undefined) json = String(value);
  const originalChars = json.length;
  if (originalChars <= normalizedLimit) return { json, truncated: false, originalChars };
  const suffix = "…[truncated]";
  const retainedChars = Math.max(0, normalizedLimit - suffix.length);
  return {
    json: `${json.slice(0, retainedChars)}${suffix}`,
    truncated: true,
    originalChars,
  };
}

