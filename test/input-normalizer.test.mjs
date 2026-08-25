import assert from "node:assert/strict";
import test from "node:test";
import { extractResponsesImages, normalizeResponsesInput } from "../src/core/input-normalizer.mjs";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);

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

test("bounded image extraction accepts only canonical inline PNG/JPEG and leaves opaque history", () => {
  const png = `data:image/png;base64,${pngBytes.toString("base64")}`;
  const jpeg = `data:image/jpeg;base64,${jpegBytes.toString("base64")}`;
  const request = { input: [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "compare the shapes" },
      { type: "input_image", image_url: png },
      { type: "image_url", image_url: { url: jpeg } },
    ],
  }] };
  const images = extractResponsesImages(request);
  assert.deepEqual(images.map(({ bytes, ...image }) => ({ ...image, length: bytes.length })), [
    { mime: "image/png", sha256: "4c4b6a3be1314ab86138bef4314dde022e600960d8689a2c8f8631802d20dab6", length: 8 },
    { mime: "image/jpeg", sha256: "a96021502fb4a8df642108f90ae9ffc50c75d2d925e8c6c391a66cb366f0ca83", length: 6 },
  ]);
  const messages = normalizeResponsesInput(request);
  assert.match(messages[0].content, /compare the shapes/);
  assert.equal((messages[0].content.match(/\[image attachment omitted\]/gu) ?? []).length, 2);
  assert.doesNotMatch(JSON.stringify(messages), /data:image|iVBOR|\/9j\//u);
});

test("Grok image extraction rejects noncanonical, remote, wrong-magic, excess, and other media", () => {
  const valid = `data:image/png;base64,${pngBytes.toString("base64")}`;
  const requestFor = (part) => ({ input: [{ type: "message", role: "user", content: [part] }] });
  for (const [part, pattern] of [
    [{ type: "input_image", image_url: "https://public.example.org/a.png" }, /strict canonical/],
    [{ type: "input_image", image_url: "data:image/png;base64,AA==" }, /magic/],
    [{ type: "input_image", image_url: valid.replace("base64,", "base64,\n") }, /strict canonical/],
    [{ type: "input_audio", audio_url: "data:audio/wav;base64,AA==" }, /unsupported/],
    [{ type: "input_file", file_url: "file:\/\/\/tmp\/a" }, /unsupported/],
    [{ type: "generated_image", image_url: valid }, /unsupported/],
    [{ type: "future_media", value: valid }, /unsupported/],
  ]) assert.throws(() => extractResponsesImages(requestFor(part)), pattern);
  assert.throws(() => extractResponsesImages(requestFor({ type: "input_image", image_url: `data:image/png;base64,${pngBytes.toString("base64").replace(/=$/u, "")}` })), /strict canonical/);
  assert.throws(() => extractResponsesImages({ input: [{ type: "message", role: "user", content: Array.from({ length: 5 }, () => ({ type: "input_image", image_url: valid })) }] }), /more than 4/);
  assert.throws(() => extractResponsesImages({ input: [{ type: "function_call_output", call_id: "call_1", output: valid }] }), /outside an input_image\/image_url block/);
  assert.throws(() => extractResponsesImages({ input: [{ type: "message", role: "user", content: [{ type: "input_text", text: valid }] }] }), /outside an input_image\/image_url block/);
});

test("Grok image input uses a closed message-only shape with no hidden provider fields", () => {
  const image = { type: "input_image", image_url: `data:image/png;base64,${pngBytes.toString("base64")}` };
  const imageMessage = { type: "message", role: "user", content: [image] };
  for (const hiddenItem of [
    "top-level text",
    { type: "reasoning", summary: [{ text: "private reasoning" }] },
    { type: "function_call", name: "hidden", arguments: '{"private":true}' },
    { type: "function_call_output", call_id: "call_1", output: "private tool result" },
    { type: "computer_call_output", output: "private computer result" },
  ]) {
    assert.throws(() => extractResponsesImages({ input: [imageMessage, hiddenItem] }), /explicit message/);
  }
  for (const extra of [
    { reasoning_content: "private reasoning" },
    { tool_calls: [{ name: "hidden" }] },
    { name: "hidden-name" },
  ]) {
    const request = { input: [{ ...imageMessage, ...extra }] };
    assert.throws(() => extractResponsesImages(request), (error) => {
      assert.match(error.message, /only type, role, and content/);
      assert.doesNotMatch(error.message, /private reasoning|hidden-name/u);
      return true;
    });
  }
  assert.throws(() => extractResponsesImages({ input: [{ ...imageMessage, role: "tool" }] }), /explicit role/);
  assert.throws(() => extractResponsesImages({ input: [{
    ...imageMessage,
    content: [{ type: "input_text", text: "question", tool_result: "private" }, image],
  }] }), /only explicit type and text fields/);
  assert.throws(() => extractResponsesImages({ input: [{
    ...imageMessage,
    content: [{ ...image, private_detail: "private" }],
  }] }), /no hidden fields/);
});

test("opaque Responses compaction history fails closed instead of losing its prefix", () => {
  const secret = "encrypted-native-compaction-payload";
  for (const type of ["compaction", "context_compaction"]) {
    assert.throws(
      () => normalizeResponsesInput({
        input: [
          { type, encrypted_content: secret },
          { type: "message", role: "user", content: "tail" },
        ],
      }),
      (error) => {
        assert.match(error.message, /Opaque Responses compaction history/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  }
});
