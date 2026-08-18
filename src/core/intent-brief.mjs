export const INTENT_BRIEF_FIELDS = Object.freeze([
  "deliverables",
  "constraints",
  "permissions",
  "priorities",
  "exclusions",
  "acceptance",
  "deferred",
]);
export const INTENT_UPDATE_CLASSIFICATIONS = Object.freeze(["override", "addition", "correction"]);

const MAX_ITEMS = 24;
const MAX_ITEM_CHARS = 320;

/**
 * Normalize an explicit, request-local intent brief. The brief is derived only from structured
 * caller input; Threadspan does not infer authority from the raw prompt or persist a memory copy.
 */
export function deriveIntentBrief(source) {
  if (!isPlainObject(source)) throw new TypeError("Intent brief must be an object");
  const unknown = Object.keys(source).filter((key) => key !== "objective" && !INTENT_BRIEF_FIELDS.includes(key));
  if (unknown.length > 0) throw new TypeError(`Intent brief contains unsupported fields: ${unknown.join(", ")}`);
  const objective = boundedText(source.objective, "Intent brief objective");
  return deepFreeze({
    objective,
    ...Object.fromEntries(INTENT_BRIEF_FIELDS.map((field) => [field, normalizeItems(source[field] ?? [], `Intent brief ${field}`)])),
  });
}

/** Apply explicitly classified updates without inventing or dropping unaffected authority. */
export function applyIntentBriefUpdates(brief, updates = []) {
  let current = deriveIntentBrief(brief);
  if (!Array.isArray(updates)) throw new TypeError("Intent brief updates must be an array");
  for (const update of updates) current = applyIntentBriefUpdate(current, update);
  return current;
}

/** Apply one override, addition, or exact correction to an intent brief. */
export function applyIntentBriefUpdate(brief, update) {
  const current = deriveIntentBrief(brief);
  if (!isPlainObject(update) || !INTENT_UPDATE_CLASSIFICATIONS.includes(update.classification)) {
    throw new TypeError(`Intent brief update classification must be one of ${INTENT_UPDATE_CLASSIFICATIONS.join(", ")}`);
  }
  const allowed = update.classification === "correction"
    ? new Set(["classification", "replacements"])
    : new Set(["classification", "changes"]);
  const unknown = Object.keys(update).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`Intent brief ${update.classification} contains unsupported fields: ${unknown.join(", ")}`);

  if (update.classification === "correction") return applyCorrections(current, update.replacements);
  if (!isPlainObject(update.changes) || Object.keys(update.changes).length === 0) {
    throw new TypeError(`Intent brief ${update.classification} requires non-empty changes`);
  }
  const result = structuredClone(current);
  for (const [field, value] of Object.entries(update.changes)) {
    if (field === "objective") {
      const next = boundedText(value, "Intent brief objective update");
      result.objective = update.classification === "addition" ? `${result.objective}\n${next}` : next;
      continue;
    }
    if (!INTENT_BRIEF_FIELDS.includes(field)) throw new TypeError(`Intent brief update contains unsupported field '${field}'`);
    const next = normalizeItems(value, `Intent brief ${field} update`);
    result[field] = update.classification === "addition" ? uniqueItems([...result[field], ...next]) : next;
  }
  return deriveIntentBrief(result);
}

function applyCorrections(current, replacements) {
  if (!Array.isArray(replacements) || replacements.length === 0 || replacements.length > MAX_ITEMS) {
    throw new TypeError(`Intent brief correction requires 1-${MAX_ITEMS} exact replacements`);
  }
  const result = structuredClone(current);
  for (const [index, replacement] of replacements.entries()) {
    if (!isPlainObject(replacement) || Object.keys(replacement).some((key) => !["field", "from", "to"].includes(key))) {
      throw new TypeError(`Intent brief correction replacement ${index} is invalid`);
    }
    const field = replacement.field;
    const from = boundedText(replacement.from, `Intent brief correction ${index}.from`);
    const to = boundedText(replacement.to, `Intent brief correction ${index}.to`);
    if (field === "objective") {
      if (result.objective !== from) throw new TypeError("Intent brief correction objective does not match the authoritative current value");
      result.objective = to;
      continue;
    }
    if (!INTENT_BRIEF_FIELDS.includes(field)) throw new TypeError(`Intent brief correction contains unsupported field '${field}'`);
    const position = result[field].indexOf(from);
    if (position < 0) throw new TypeError(`Intent brief correction source was not found in ${field}`);
    result[field][position] = to;
    result[field] = uniqueItems(result[field]);
  }
  return deriveIntentBrief(result);
}

function normalizeItems(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new TypeError(`${label} must be an array with at most ${MAX_ITEMS} items`);
  return uniqueItems(value.map((item, index) => boundedText(item, `${label}[${index}]`)));
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_ITEM_CHARS || /[\u0000-\u001f\u007f]/.test(value.replaceAll("\n", ""))) {
    throw new TypeError(`${label} must be a non-empty string of at most ${MAX_ITEM_CHARS} characters without control characters`);
  }
  return value.trim();
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
