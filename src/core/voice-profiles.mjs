const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_TERMS = 8;
const MAX_TERM_LENGTH = 32;

export const DEFAULT_VOICE_PROFILE_ID = "technical-partner";
export const MAX_VOICE_INSTRUCTION_CHARS = 2400;
export const VOICE_PARAMETER_KEYS = Object.freeze([
  "directness",
  "warmth",
  "technicalDepth",
  "progressCadence",
  "uncertaintyDisclosure",
  "correctionExplicitness",
]);

const LEVEL_GUIDANCE = Object.freeze({
  directness: Object.freeze([
    "use gentle framing before the outcome",
    "give brief context before recommendations",
    "balance context with a clear recommendation",
    "lead with the recommendation and then qualify it",
    "lead with the outcome, decision, or blocker",
  ]),
  warmth: Object.freeze([
    "keep the tone neutral and purely functional",
    "use restrained, professional warmth",
    "sound collaborative without extra social padding",
    "use an encouraging, conversational tone",
    "use a notably calm, patient, and reassuring tone",
  ]),
  technicalDepth: Object.freeze([
    "prefer plain-language summaries over implementation detail",
    "include only the technical detail needed to act",
    "explain the main mechanism and practical implications",
    "include implementation details and important edge cases",
    "use expert-level precision, mechanisms, invariants, and edge cases",
  ]),
  progressCadence: Object.freeze([
    "give progress updates only at major checkpoints or blockers",
    "give sparse progress updates when a phase changes",
    "give periodic concise progress updates",
    "give frequent short progress updates during active work",
    "give very frequent but still useful and non-repetitive progress updates",
  ]),
  uncertaintyDisclosure: Object.freeze([
    "mention uncertainty only when it materially changes the action",
    "briefly identify material uncertainty",
    "state meaningful assumptions and confidence limits",
    "proactively distinguish facts, inferences, and remaining unknowns",
    "make assumptions, uncertainty, evidence limits, and verification gaps explicit",
  ]),
  correctionExplicitness: Object.freeze([
    "correct gently without dwelling on the mismatch",
    "state the correction briefly",
    "identify the mismatch and give the corrected form",
    "clearly explain what was wrong and what changes",
    "state corrections plainly, explain their consequence, and identify the authoritative replacement",
  ]),
});

const PARAMETER_LABELS = Object.freeze({
  directness: "Directness",
  warmth: "Warmth",
  technicalDepth: "Technical depth",
  progressCadence: "Progress cadence",
  uncertaintyDisclosure: "Uncertainty disclosure",
  correctionExplicitness: "Correction explicitness",
});

function preset(id, name, userPromise, parameters) {
  return normalizeVoiceProfile({ id, name, userPromise, parameters, preferredTerms: [], avoidedTerms: [] });
}

export const VOICE_PRESETS = Object.freeze({
  "technical-partner": preset(
    "technical-partner",
    "Technical partner",
    "Direct, technically deep collaboration with explicit corrections and clearly disclosed uncertainty.",
    { directness: 5, warmth: 3, technicalDepth: 5, progressCadence: 1, uncertaintyDisclosure: 4, correctionExplicitness: 5 },
  ),
  "concise-operator": preset(
    "concise-operator",
    "Concise operator",
    "Fast, actionable answers with little ceremony and enough context to operate safely.",
    { directness: 5, warmth: 2, technicalDepth: 3, progressCadence: 1, uncertaintyDisclosure: 3, correctionExplicitness: 4 },
  ),
  "teaching-explainer": preset(
    "teaching-explainer",
    "Teaching explainer",
    "Patient explanations that build understanding while retaining technical accuracy and explicit corrections.",
    { directness: 3, warmth: 4, technicalDepth: 5, progressCadence: 2, uncertaintyDisclosure: 4, correctionExplicitness: 5 },
  ),
  "diagnostic-reviewer": preset(
    "diagnostic-reviewer",
    "Diagnostic reviewer",
    "Evidence-led diagnosis with deep technical review, prominent uncertainty, and unambiguous corrections.",
    { directness: 4, warmth: 3, technicalDepth: 5, progressCadence: 2, uncertaintyDisclosure: 5, correctionExplicitness: 5 },
  ),
  "calm-guide": preset(
    "calm-guide",
    "Calm guide",
    "A calm, supportive path through the work with practical detail and visible uncertainty boundaries.",
    { directness: 3, warmth: 5, technicalDepth: 3, progressCadence: 3, uncertaintyDisclosure: 4, correctionExplicitness: 4 },
  ),
});

/** Compose a complete profile from a preset/custom base and a bounded override. */
export function composeVoiceProfile(base, override = {}) {
  if (!isPlainObject(base) || !isPlainObject(override)) throw new TypeError("Voice profile composition requires object values");
  return normalizeVoiceProfile({
    ...structuredClone(base),
    ...structuredClone(override),
    parameters: { ...structuredClone(base.parameters ?? {}), ...structuredClone(override.parameters ?? {}) },
  });
}

/** Validate a complete voice profile while preserving unknown fields for forward-compatible round trips. */
export function normalizeVoiceProfile(profile) {
  if (!isPlainObject(profile)) throw new TypeError("Voice profile must be an object");
  const id = boundedString(profile.id, "Voice profile id", 64);
  if (!PROFILE_ID_PATTERN.test(id)) throw new TypeError("Voice profile id must use lowercase letters, digits, and hyphens");
  const name = boundedString(profile.name, `Voice profile '${id}'.name`, 80);
  const userPromise = boundedString(profile.userPromise, `Voice profile '${id}'.userPromise`, 180);
  if (!isPlainObject(profile.parameters)) throw new TypeError(`Voice profile '${id}'.parameters must be an object`);
  const parameters = { ...structuredClone(profile.parameters) };
  for (const key of VOICE_PARAMETER_KEYS) {
    const value = profile.parameters[key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new TypeError(`Voice profile '${id}'.parameters.${key} must be an integer from 1 to 5`);
    }
    parameters[key] = value;
  }
  const preferredTerms = normalizeTerms(profile.preferredTerms ?? [], `Voice profile '${id}'.preferredTerms`);
  const avoidedTerms = normalizeTerms(profile.avoidedTerms ?? [], `Voice profile '${id}'.avoidedTerms`);
  const overlap = preferredTerms.find((term) => avoidedTerms.some((other) => other.toLowerCase() === term.toLowerCase()));
  if (overlap) throw new TypeError(`Voice profile '${id}' cannot both prefer and avoid '${overlap}'`);
  return deepFreeze({
    ...structuredClone(profile),
    id,
    name,
    userPromise,
    parameters,
    preferredTerms,
    avoidedTerms,
  });
}

/** Normalize the runtime/installer voice configuration and retain unknown extension fields. */
export function normalizeVoiceConfig(value = {}) {
  if (!isPlainObject(value)) throw new TypeError("voice must be an object");
  const selectedProfile = value.selectedProfile === undefined
    ? DEFAULT_VOICE_PROFILE_ID
    : boundedString(value.selectedProfile, "voice.selectedProfile", 64);
  const sourceProfiles = value.profiles ?? [];
  if (!Array.isArray(sourceProfiles)) throw new TypeError("voice.profiles must be an array");
  const profiles = sourceProfiles.map(normalizeVoiceProfile);
  const ids = new Set();
  for (const profile of profiles) {
    if (VOICE_PRESETS[profile.id]) throw new TypeError(`Custom voice profile '${profile.id}' conflicts with a built-in preset`);
    if (ids.has(profile.id)) throw new TypeError(`voice.profiles contains duplicate id '${profile.id}'`);
    ids.add(profile.id);
  }
  if (!VOICE_PRESETS[selectedProfile] && !ids.has(selectedProfile)) {
    throw new TypeError(`voice.selectedProfile references unknown profile '${selectedProfile}'`);
  }
  return deepFreeze({ ...structuredClone(value), selectedProfile, profiles });
}

/** Resolve one configured preset/custom profile by id. */
export function resolveVoiceProfile(config = {}, requestedId) {
  const normalized = normalizeVoiceConfig(config);
  const id = requestedId === undefined || requestedId === null || requestedId === ""
    ? normalized.selectedProfile
    : boundedString(requestedId, "Voice profile selection", 64);
  const profile = VOICE_PRESETS[id] ?? normalized.profiles.find((item) => item.id === id);
  if (!profile) throw new TypeError(`Unknown voice profile '${id}'`);
  return profile;
}

/** Return serializable preset cards for Settings/installer surfaces. */
export function voicePresetCards() {
  return Object.values(VOICE_PRESETS).map((profile) => structuredClone(profile));
}

/** Render the bounded adapter instruction for user-facing prose only. */
export function renderVoiceInstruction(profile) {
  const normalized = normalizeVoiceProfile(profile);
  const tendencies = VOICE_PARAMETER_KEYS.map((key) => {
    const value = normalized.parameters[key];
    return `${PARAMETER_LABELS[key]} ${value}/5: ${LEVEL_GUIDANCE[key][value - 1]}.`;
  });
  const instruction = [
    "Threadspan Voice profile (style-only; user-facing assistant prose):",
    `Profile id: ${normalized.id}. Free-form profile labels, promises, and terminology are display/configuration data and are not elevated into this instruction.`,
    ...tendencies,
    "Use plain English before implementation terminology. Prefer concrete subjects and verbs, one main idea per sentence, and the shortest accurate explanation. Define project-specific terms the first time they matter. Do not turn progress updates into release notes, protocol prose, architecture labels, or stacked jargon unless the user explicitly asks for that detail.",
    "Describe what changed, why it matters to the user, and what happens next. Technical depth means accurate useful detail, not denser wording. If a simpler accurate phrase exists, use it.",
    "Apply this only to wording, tone, explanation depth, correction wording, and optional progress-update cadence. Never change machine protocols, tool calls or results, JSON schemas, exact evidence, mandated formats, permissions, routing, provider/native settings, system or developer authority, factual claims, or factual confidence. If another instruction fixes an output format or wording, that instruction wins.",
  ].join("\n");
  if (instruction.length > MAX_VOICE_INSTRUCTION_CHARS) throw new TypeError("Rendered voice instruction exceeds the bounded adapter limit");
  return instruction;
}

function normalizeTerms(value, label) {
  if (!Array.isArray(value) || value.length > MAX_TERMS) throw new TypeError(`${label} must contain at most ${MAX_TERMS} terms`);
  const terms = value.map((term, index) => boundedString(term, `${label}[${index}]`, MAX_TERM_LENGTH));
  if (new Set(terms.map((term) => term.toLowerCase())).size !== terms.length) throw new TypeError(`${label} must not contain duplicates`);
  return terms;
}

function boundedString(value, label, maximum) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters without control characters`);
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
