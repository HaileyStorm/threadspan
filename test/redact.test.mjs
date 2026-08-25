import assert from "node:assert/strict";
import test from "node:test";
import { boundedRedactedJson, redactText } from "../src/core/redact.mjs";

test("data-image bodies are redacted before bounded logging", () => {
  const payload = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
  const dataUri = `data:image/png;base64,${payload}`;
  assert.equal(redactText(`before ${dataUri} after`), "before [redacted-data-image] after");
  const body = boundedRedactedJson({ input: [{ image_url: dataUri }], note: "kept" });
  assert.match(body.json, /\[redacted-data-image\]/u);
  assert.doesNotMatch(body.json, /data:image|iVBOR/u);
  assert.equal(redactText("data:image/svg+xml,%3Csvg%3Eprivate%3C/svg%3E"), "[redacted-data-image]");
});
