import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("HUD exposes a compact Continuity task tree without native identifiers", async () => {
  const [html, source, adapter] = await Promise.all([
    readFile("ui/index.html", "utf8"),
    readFile("ui/threadspan.js", "utf8"),
    readFile("ui/adapt-state.js", "utf8"),
  ]);
  assert.match(html, /<h2 id="continuity-heading">Continuity<\/h2>/);
  assert.match(html, /Task tree/);
  assert.match(source, /renderContinuity/);
  assert.match(source, /Rename/);
  assert.match(source + adapter, /Promote|Rollover/);
  assert.match(source, /\/v1\/continuity\/rollover\/preview/);
  assert.match(source, /\/v1\/automatic-takeover\/disable/);
  assert.match(adapter, /adaptAutomaticTakeover/);
  assert.match(html, /Copy review/);
  assert.match(source, /\/v1\/copy\/review/);
  assert.match(html, /External copy check/);
  assert.match(source, /\/v1\/copy\/check/);
  assert.match(source, /pangram-handoff/);
  assert.match(html, /cannot prove authorship/);
  assert.match(html, /https:\/\/www\.pangram\.com\//);
  const copyCheckMarkup = source.slice(source.indexOf("function bindCopyCheckControls"), source.indexOf("function bindCopyReviewControls"));
  assert.doesNotMatch(copyCheckMarkup, /setInterval|addEventListener\("focus"|addEventListener\("input"/);
  assert.match(adapter, /adaptContinuity/);
  assert.match(adapter, /opaque handles/i);
  for (const forbidden of ["nativeThreadId", "nativeGoalId", "recoveryKey"]) {
    assert.doesNotMatch(html + source + adapter, new RegExp(forbidden));
  }
});
