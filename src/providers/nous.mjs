import { OpenAiChatProvider } from "./openai-chat.mjs";

/**
 * Nous Portal adapter.
 * It supports either the official inference endpoint with an API key or the local
 * `hermes proxy start` subscription proxy, which is the recommended OAuth path.
 */
export class NousProvider extends OpenAiChatProvider {
  constructor(id, config, context) {
    super(id, {
      baseUrl: "http://127.0.0.1:8645/v1",
      apiKey: "unused-proxy-attaches-real-creds",
      ...config,
    }, context);
  }
}
