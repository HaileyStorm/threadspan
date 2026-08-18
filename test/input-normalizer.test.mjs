import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponsesInput } from "../src/core/input-normalizer.mjs";

test("computer outputs use an opaque marker without output or browser metadata", () => {
  const secret = "private-computer-output";
  const messages = normalizeResponsesInput({
    input: [{
      type: "computer_call_output",
      call_id: "computer_1",
      output: {
        output: secret,
        browser: { currentUrl: "https://private.example.test/account?token=signed" },
        screenshot: { file_id: "local-screenshot-id", data: "base64-image" },
      },
    }],
  });

  assert.deepEqual(messages, [{
    role: "tool",
    toolCallId: "computer_1",
    content: "[computer output omitted]",
  }]);
  assert.equal(JSON.stringify(messages).includes(secret), false);
  assert.doesNotMatch(JSON.stringify(messages), /browser|screenshot|file_id|currentUrl/u);
});

test("image, audio, file, and generated-media references retain only safe public origin and path", () => {
  const messages = normalizeResponsesInput({
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://cdn.example.org/images/chart.png?signature=secret#view" },
        { type: "input_audio", audio_url: { url: "https://media.example.org/audio/sample.mp3?token=secret" } },
        { type: "input_file", file_url: "https://files.example.org/public/report.pdf#download", filename: "private-report.pdf", file_id: "file_private" },
        { type: "generated_image", url: "https://assets.example.org/generated/result.webp?temporary=secret" },
      ],
    }],
  });

  assert.equal(messages[0].content, [
    "[image: https://cdn.example.org/images/chart.png]",
    "[audio: https://media.example.org/audio/sample.mp3]",
    "[file: https://files.example.org/public/report.pdf]",
    "[generated media: https://assets.example.org/generated/result.webp]",
  ].join("\n"));
  assert.doesNotMatch(messages[0].content, /signature|token|temporary|private-report|file_private|#|\?/u);
});

test("unsafe or local attachment references collapse to opaque markers", () => {
  const messages = normalizeResponsesInput({
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "https://user:password@images.example.test/private.png" },
        { type: "input_audio", audio_url: "http://127.0.0.1:8080/private.wav" },
        { type: "input_file", file_id: "file_local_identifier", filename: "/home/person/private.txt" },
        { type: "generated_media", url: "file:///home/person/generated.mp4", metadata: { transcript: "private transcript" } },
      ],
    }],
  });

  assert.equal(messages[0].content, [
    "[image attachment omitted]",
    "[audio attachment omitted]",
    "[file attachment omitted]",
    "[generated media attachment omitted]",
  ].join("\n"));
  assert.doesNotMatch(messages[0].content, /user|password|127\.0\.0\.1|file_local|person|transcript/u);
});
