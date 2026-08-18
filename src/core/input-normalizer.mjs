import { RequestError } from "./errors.mjs";

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
