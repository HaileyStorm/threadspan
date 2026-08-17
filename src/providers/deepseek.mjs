import { OpenAiChatProvider } from "./openai-chat.mjs";

/**
 * DeepSeek V4 adapter with thinking-mode and reasoning-content round-trip support.
 *
 * DeepSeek V4 thinking mode rejects `tool_choice`, ignores sampling controls, requires non-null
 * assistant content on tool-call messages, and requires `reasoning_content` to be replayed across
 * tool-call turns. The generic message normalizer already preserves reasoning content; this adapter
 * applies the remaining wire-level compatibility rules.
 */
export class DeepSeekProvider extends OpenAiChatProvider {
  /** @param {string} id @param {Record<string, any>} config @param {{logger: any}} context */
  constructor(id, config, context) {
    super(id, { baseUrl: "https://api.deepseek.com", ...config }, context);
  }

  /**
   * Build a DeepSeek-compatible Chat Completions body.
   * @param {Record<string, any>} request Provider-neutral request.
   * @returns {Record<string, any>}
   */
  buildRequestBody(request) {
    const body = super.buildRequestBody(request);
    const thinking = this.config.thinking ?? { type: "enabled" };
    const thinkingEnabled = thinking?.type !== "disabled";
    if (thinkingEnabled) {
      delete body.temperature;
      delete body.top_p;
      delete body.presence_penalty;
      delete body.frequency_penalty;
      delete body.tool_choice;
      for (const message of body.messages) {
        if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.content === null) {
          message.content = "";
        }
      }
    }
    return {
      ...body,
      ...(thinking ? { thinking } : {}),
      ...(this.config.reasoningEffort ? { reasoning_effort: this.config.reasoningEffort } : {}),
    };
  }
}
