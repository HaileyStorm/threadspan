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
  assert.match(source, /fetch\("\/v1\/continuity"/);
  assert.match(source, /Recovery pending/);
  assert.match(adapter, /recoverySource/);
  assert.match(adapter, /blocker/);
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

test("HUD exposes a bounded owner action rail without polling or diagnostic queue conflation", async () => {
  const [html, source, css] = await Promise.all([
    readFile("ui/index.html", "utf8"),
    readFile("ui/threadspan.js", "utf8"),
    readFile("ui/threadspan.css", "utf8"),
  ]);
  assert.match(html, /<h2 id="needs-you-heading">Needs you<\/h2>/);
  assert.match(html, /Owner action queue/);
  assert.match(html, /Stale and closed entries are historical visibility, not diagnostics or an active work queue/);
  assert.match(html, /name="needs-scope"/);
  assert.match(html, /name="needs-status"/);
  assert.match(html, /name="needs-sort"/);
  assert.match(html, /data-field="needs-you-status" role="status" aria-live="polite"/);
  assert.match(source, /\/v1\/action-items\?/);
  assert.match(source, /\/v1\/action-items\/\$\{encodeURIComponent\(item\.handle\)\}\/complete/);
  assert.match(source, /\.slice\(0, 100\)/);
  assert.match(source, /Completion recorded for exact-owner delivery/);
  assert.match(css, /\.needs-you-panel[\s\S]*?position:sticky/);
  assert.match(css, /@media \(max-width:52rem\)[\s\S]*?needs-you-panel[\s\S]*?position:static/);
  const needsSource = source.slice(source.indexOf("function renderNeedsYou"), source.indexOf("function kicker"));
  assert.doesNotMatch(needsSource, /setInterval|setTimeout|addEventListener\("focus"/);
});
