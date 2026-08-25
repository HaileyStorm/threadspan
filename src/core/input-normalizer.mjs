import { createHash } from "node:crypto";
import { RequestError } from "./errors.mjs";

export const MAX_GROK_IMAGE_COUNT = 4;
export const MAX_GROK_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_GROK_IMAGE_TOTAL_BYTES = 40 * 1024 * 1024;

const GROK_IMAGE_TYPES = new Set(["input_image", "image_url"]);
const ALLOWED_TOP_LEVEL_INPUT_TYPES = new Set([
  "message",
  "function_call",
  "reasoning",
  "function_call_output",
  "computer_call_output",
  "compaction",
  "context_compaction",
]);

const ATTACHMENT_LABELS = new Map([
  ["input_image", "image"],
  ["image_url", "image"],
  ["output_image", "image"],
  ["input_file", "file"],
  ["file", "file"],
  ["input_audio", "audio"],
  ["audio", "audio"],
  ["output_audio", "audio"],
  ["input_video", "media"],
  ["video", "media"],
  ["output_video", "media"],
  ["generated_image", "generated media"],
  ["generated_audio", "generated media"],
  ["generated_media", "generated media"],
]);

const NON_PUBLIC_HOST_SUFFIXES = [
  ".corp",
  ".example",
  ".home",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".onion",
  ".test",
];

/**
 * Convert Responses-style input into a provider-neutral message list.
 * Content blocks are preserved where possible; unsupported binary/image payloads become explicit text placeholders.
 */
export function normalizeResponsesInput(request, previousRecord) {
  const messages = [];
  if (request.instructions) messages.push({ role: "system", content: String(request.instructions) });

  if (previousRecord?.messages) messages.push(...structuredClone(previousRecord.messages));
  const input = request.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    appendInputItems(messages, input);
  } else if (input !== undefined && input !== null) {
    throw new RequestError("input must be a string or an array");
  }

  if (messages.length === 0) throw new RequestError("Request contains no input messages");
  return coalesceAdjacentMessages(messages);
}

/**
 * Extract bounded inline images from only the current Responses input.
 *
 * Returned buffers are ephemeral provider-attempt inputs. Normalized messages retain only opaque
 * attachment placeholders, so image bytes and data URLs never enter history, logs, or ledgers.
 */
export function extractResponsesImages(request) {
  const input = request?.input;
  if (typeof input === "string" || input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new RequestError("input must be a string or an array");

  const imageRequest = input.some((item) => messageContentParts(item).some((part) => part && typeof part === "object" && GROK_IMAGE_TYPES.has(part.type)));
  const images = [];
  let totalBytes = 0;
  for (const [itemIndex, item] of input.entries()) {
    if (imageRequest) assertClosedImageMessageItem(item, itemIndex);
    if (typeof item === "string") continue;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new RequestError(`Grok saved-session input item ${itemIndex} must be text or a structured Responses item`);
    }
    const type = String(item.type ?? "");
    if (type === "message" || item.role) {
      const content = item.content;
      if (typeof content === "string") {
        assertNoEmbeddedImageDataUri(content, `message ${itemIndex}`);
        continue;
      }
      if (content === undefined || content === null) continue;
      const parts = Array.isArray(content) ? content : [content];
      for (const [partIndex, part] of parts.entries()) {
        if (typeof part === "string") {
          assertNoEmbeddedImageDataUri(part, `message ${itemIndex} part ${partIndex}`);
          continue;
        }
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          throw new RequestError(`Grok saved-session message ${itemIndex} part ${partIndex} is not a supported text or image block`);
        }
        if (["input_text", "output_text", "text"].includes(part.type) && typeof part.text === "string") {
          assertNoEmbeddedImageDataUri(part.text, `message ${itemIndex} part ${partIndex}`);
          continue;
        }
        if (!GROK_IMAGE_TYPES.has(part.type)) {
          throw new RequestError(`Grok saved-session message ${itemIndex} part ${partIndex} is unsupported; remote URLs, local paths, audio, video, files, generated media, and unknown blocks are disabled`);
        }
        if (images.length >= MAX_GROK_IMAGE_COUNT) {
          throw new RequestError(`Grok saved-session image input cannot contain more than ${MAX_GROK_IMAGE_COUNT} images`);
        }
        const reference = part.image_url ?? part.url;
        const candidate = reference && typeof reference === "object" && !Array.isArray(reference) ? reference.url : reference;
        const image = decodeCanonicalImageDataUri(candidate, itemIndex, partIndex);
        totalBytes += image.bytes.length;
        if (totalBytes > MAX_GROK_IMAGE_TOTAL_BYTES) {
          throw new RequestError(`Grok saved-session image input exceeds the ${MAX_GROK_IMAGE_TOTAL_BYTES}-byte aggregate limit`);
        }
        images.push(image);
      }
      continue;
    }
    if (!ALLOWED_TOP_LEVEL_INPUT_TYPES.has(type)) {
      throw new RequestError(`Grok saved-session input item ${itemIndex} type '${type || "unknown"}' is unsupported`);
    }
    assertNoEmbeddedImageDataUri(JSON.stringify(item), `input item ${itemIndex}`);
  }
  return images;
}

function messageContentParts(item) {
  if (!item || typeof item !== "object" || Array.isArray(item) || !(item.type === "message" || item.role)) return [];
  return Array.isArray(item.content) ? item.content : item.content === undefined || item.content === null ? [] : [item.content];
}

function assertClosedImageMessageItem(item, itemIndex) {
  if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "message") {
    throw new RequestError(`Grok image input item ${itemIndex} must be an explicit message; reasoning, tool calls/results, and other top-level items are disabled`);
  }
  const unknownMessageFields = Object.keys(item).filter((key) => !["type", "role", "content"].includes(key));
  if (unknownMessageFields.length > 0) {
    throw new RequestError(`Grok image message ${itemIndex} contains unsupported fields; only type, role, and content are allowed`);
  }
  if (!["system", "developer", "user", "assistant"].includes(item.role) || !Array.isArray(item.content)) {
    throw new RequestError(`Grok image message ${itemIndex} requires an explicit role and content block array`);
  }
  for (const [partIndex, part] of item.content.entries()) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      throw new RequestError(`Grok image message ${itemIndex} part ${partIndex} must be an explicit text or image block`);
    }
    if (["input_text", "output_text", "text"].includes(part.type)) {
      if (typeof part.text !== "string" || Object.keys(part).some((key) => !["type", "text"].includes(key))) {
        throw new RequestError(`Grok image message ${itemIndex} part ${partIndex} must contain only explicit type and text fields`);
      }
      continue;
    }
    if (!GROK_IMAGE_TYPES.has(part.type) || item.role !== "user"
      || Object.keys(part).some((key) => !["type", "image_url", "url"].includes(key))) {
      throw new RequestError(`Grok image message ${itemIndex} part ${partIndex} must be a user image block with no hidden fields`);
    }
    const reference = part.image_url ?? part.url;
    if (reference && typeof reference === "object" && !Array.isArray(reference)
      && Object.keys(reference).some((key) => key !== "url")) {
      throw new RequestError(`Grok image message ${itemIndex} part ${partIndex} image reference contains unsupported fields`);
    }
  }
}

function assertNoEmbeddedImageDataUri(value, label) {
  if (/data:image\//iu.test(String(value ?? ""))) {
    throw new RequestError(`Grok saved-session ${label} contains an image data URI outside an input_image/image_url block`);
  }
}

function decodeCanonicalImageDataUri(value, itemIndex, partIndex) {
  if (typeof value !== "string") {
    throw new RequestError(`Grok saved-session image ${itemIndex}:${partIndex} must be an inline PNG or JPEG data URI`);
  }
  const match = value.match(/^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]*={0,2})$/u);
  if (!match || match[2].length === 0 || match[2].length % 4 !== 0) {
    throw new RequestError(`Grok saved-session image ${itemIndex}:${partIndex} must use strict canonical base64 PNG or JPEG data URI encoding`);
  }
  const [, mime, encoded] = match;
  const maximumEncodedLength = Math.ceil(MAX_GROK_IMAGE_BYTES / 3) * 4;
  if (encoded.length > maximumEncodedLength) {
    throw new RequestError(`Grok saved-session image ${itemIndex}:${partIndex} exceeds the ${MAX_GROK_IMAGE_BYTES}-byte per-image limit`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_GROK_IMAGE_BYTES || bytes.toString("base64") !== encoded) {
    throw new RequestError(`Grok saved-session image ${itemIndex}:${partIndex} is not canonical base64 within the per-image limit`);
  }
  const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const jpeg = bytes.length >= 5
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  if (mime === "image/png" ? !png : !jpeg) {
    throw new RequestError(`Grok saved-session image ${itemIndex}:${partIndex} bytes do not match declared ${mime} magic`);
  }
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mime,
  };
}

/** Convert a Consult tool request into normalized messages. */
export function normalizeConsultInput(input) {
  const messages = [];
  if (input.system) messages.push({ role: "system", content: String(input.system) });
  if (input.context) {
    messages.push({
      role: "user",
      content: `CURRENT THREAD / TASK CONTEXT\n\n${String(input.context)}`,
    });
  }
  if (Array.isArray(input.artifacts) && input.artifacts.length > 0) {
    const rendered = input.artifacts.map((artifact, index) => {
      const label = artifact?.label ?? artifact?.path ?? `artifact-${index + 1}`;
      return `--- ${label} ---\n${artifact?.content ?? ""}`;
    }).join("\n\n");
    messages.push({ role: "user", content: `RELEVANT ARTIFACTS\n\n${rendered}` });
  }
  messages.push({ role: "user", content: String(input.question ?? "") });
  return coalesceAdjacentMessages(messages);
}

function appendInputItems(messages, items) {
  /** @type {any | undefined} */
  let pendingAssistant;
  const flushAssistant = () => {
    if (pendingAssistant) messages.push(pendingAssistant);
    pendingAssistant = undefined;
  };

  for (const item of items) {
    if (typeof item === "string") {
      flushAssistant();
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;

    // Responses compaction summaries are opaque to the provider that created
    // them. Passing an OpenAI-encrypted checkpoint to another provider would
    // silently discard the compacted prefix, so fail before any provider work.
    // Codex's local/token-budget compaction expands to ordinary history and is
    // unaffected by this guard.
    if (item.type === "compaction" || item.type === "context_compaction") {
      throw new RequestError(
        "Opaque Responses compaction history cannot be transferred across providers; create a fresh task or provider-neutral Continuity fork with an ordinary-text summary before switching",
      );
    }

    if (item.type === "message" || item.role) {
      flushAssistant();
      const message = {
        role: normalizeRole(item.role),
        content: normalizeContent(item.content),
        ...(item.name ? { name: String(item.name) } : {}),
        ...(item.reasoning_content ? { reasoningContent: String(item.reasoning_content) } : {}),
      };
      const inlineToolCalls = normalizeInlineToolCalls(item.tool_calls ?? item.toolCalls);
      if (inlineToolCalls.length > 0) message.toolCalls = inlineToolCalls;
      messages.push(message);
      continue;
    }

    if (item.type === "function_call") {
      pendingAssistant ??= { role: "assistant", content: "", toolCalls: [] };
      pendingAssistant.toolCalls.push({
        id: String(item.call_id ?? item.id ?? `call_${pendingAssistant.toolCalls.length + 1}`),
        name: String(item.name ?? "unknown_tool"),
        arguments: normalizeArguments(item.arguments),
        ...(typeof item.arguments === "string" ? { argumentsText: item.arguments } : {}),
      });
      continue;
    }

    if (item.type === "reasoning") {
      pendingAssistant ??= { role: "assistant", content: "", toolCalls: [] };
      const summary = Array.isArray(item.summary)
        ? item.summary.map((part) => part?.text ?? "").filter(Boolean).join("\n")
        : "";
      if (summary) pendingAssistant.reasoningContent = summary;
      continue;
    }

    if (item.type === "function_call_output") {
      flushAssistant();
      messages.push({
        role: "tool",
        toolCallId: String(item.call_id ?? item.id ?? "unknown_call"),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? null),
      });
      continue;
    }

    if (item.type === "computer_call_output") {
      flushAssistant();
      messages.push({
        role: "tool",
        toolCallId: String(item.call_id ?? item.id ?? "computer_call"),
        content: "[computer output omitted]",
      });
      continue;
    }
  }
  flushAssistant();
}

function normalizeRole(role) {
  const value = String(role ?? "user").toLowerCase();
  if (["system", "developer", "user", "assistant", "tool"].includes(value)) return value;
  return "user";
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object") return normalizeContent([content]);
    return content == null ? "" : JSON.stringify(content);
  }
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (["input_text", "output_text", "text"].includes(part.type)) return String(part.text ?? "");
    const attachmentLabel = ATTACHMENT_LABELS.get(part.type);
    if (attachmentLabel) {
      const publicReference = normalizePublicAttachmentUrl(
        part.image_url ?? part.audio_url ?? part.file_url ?? part.media_url ?? part.url,
      );
      return publicReference
        ? `[${attachmentLabel}: ${publicReference}]`
        : `[${attachmentLabel} attachment omitted]`;
    }
    return `[unsupported content block: ${part.type ?? "unknown"}]`;
  }).filter(Boolean).join("\n");
}

/** Keep only a syntactically public HTTP(S) origin and path from an attachment reference. */
function normalizePublicAttachmentUrl(value) {
  const candidate = value && typeof value === "object" ? value.url : value;
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  let url;
  try { url = new URL(candidate); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!isPublicHostname(hostname)) return undefined;
  url.hostname = hostname;
  return `${url.origin}${url.pathname}`;
}

/** Reject local, reserved, single-label, and IP-literal attachment hosts without performing DNS. */
function isPublicHostname(hostname) {
  if (!hostname || hostname === "localhost" || !hostname.includes(".")) return false;
  if (hostname.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname)) return false;
  return !NON_PUBLIC_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function normalizeArguments(value) {
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value ?? {};
}

/** Normalize bridge-private or Chat-shaped inline tool calls on message items. */
function normalizeInlineToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call, index) => ({
    id: String(call?.id ?? call?.call_id ?? `call_${index + 1}`),
    name: String(call?.name ?? call?.function?.name ?? "unknown_tool"),
    arguments: normalizeArguments(call?.arguments ?? call?.function?.arguments),
    ...(typeof (call?.arguments ?? call?.function?.arguments) === "string"
      ? { argumentsText: call?.arguments ?? call?.function?.arguments }
      : {}),
  }));
}

function isPlainTextMessage(message) {
  return message && Object.keys(message).every((key) => ["role", "content"].includes(key));
}

function coalesceAdjacentMessages(messages) {
  const result = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (
      previous &&
      previous.role === message.role &&
      isPlainTextMessage(previous) &&
      isPlainTextMessage(message)
    ) {
      previous.content = `${previous.content}\n\n${message.content}`.trim();
    } else {
      result.push({ ...message });
    }
  }
  return result;
}

/** Translate provider-neutral messages to OpenAI Chat Completions messages. */
export function toOpenAiChatMessages(messages, options = {}) {
  return messages.map((message) => {
    const role = message.role === "developer" && options.developerAsSystem ? "system" : message.role;
    if (role === "assistant" && message.toolCalls) {
      return {
        role,
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.argumentsText ?? (typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {})),
          },
        })),
        ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
        ...(Array.isArray(message.reasoningDetails) ? { reasoning_details: structuredClone(message.reasoningDetails) } : {}),
      };
    }
    if (role === "tool") {
      return { role, tool_call_id: message.toolCallId, content: String(message.content ?? "") };
    }
    return {
      role,
      content: String(message.content ?? ""),
      ...(message.name ? { name: message.name } : {}),
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      ...(Array.isArray(message.reasoningDetails) ? { reasoning_details: structuredClone(message.reasoningDetails) } : {}),
    };
  });
}

/** Translate Responses API function tools to Chat Completions tools. */
export function toOpenAiChatTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const translated = tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") return [];
    if (tool.type === "function") {
      return [{
        type: "function",
        function: {
          name: String(tool.name ?? tool.function?.name ?? "unknown_tool"),
          description: tool.description ?? tool.function?.description,
          parameters: tool.parameters ?? tool.function?.parameters ?? { type: "object", properties: {} },
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      }];
    }
    return [];
  });
  return translated.length > 0 ? translated : undefined;
}

/**
 * Serialize provider-neutral thread messages back into bridge-compatible Responses input items.
 * This retains tool-call linkage and hidden reasoning when convenience tools continue a thread.
 * @param {Array<Record<string, any>>} messages Provider-neutral messages.
 * @returns {Array<Record<string, any>>}
 */
export function toBridgeResponsesInput(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        type: "function_call_output",
        call_id: String(message.toolCallId ?? "unknown_call"),
        output: String(message.content ?? ""),
      };
    }
    return {
      type: "message",
      role: message.role,
      content: String(message.content ?? ""),
      ...(message.name ? { name: message.name } : {}),
      ...(message.reasoningContent ? { reasoning_content: message.reasoningContent } : {}),
      ...(Array.isArray(message.toolCalls) && message.toolCalls.length > 0 ? {
        tool_calls: message.toolCalls.map((call) => ({
          id: String(call.id ?? "unknown_call"),
          name: String(call.name ?? "unknown_tool"),
          arguments: call.arguments ?? {},
        })),
      } : {}),
    };
  });
}
