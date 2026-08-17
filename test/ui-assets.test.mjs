import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function read(relative) {
  return readFile(join(root, relative), "utf8");
}

test("Threadspan sidecar assets exist as local static files", async () => {
  const files = [
    "ui/index.html",
    "ui/threadspan.css",
    "ui/threadspan.js",
    "ui/adapt-state.js",
    "ui/mark.svg",
    "docs/UI.md",
  ];
  for (const file of files) {
    const info = await stat(join(root, file));
    assert.ok(info.isFile(), `${file} should exist`);
    assert.ok(info.size > 0, `${file} should be non-empty`);
  }
});

test("sidecar JavaScript is syntactically valid without a browser", () => {
  for (const file of ["ui/adapt-state.js", "ui/threadspan.js"]) {
    const result = spawnSync(process.execPath, ["--check", join(root, file)], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || `${file} failed node --check`);
  }
});

test("HTML carries route-bar semantics, landmarks, and HUD non-injection copy", async () => {
  const html = await read("ui/index.html");
  assert.match(html, /data-threadspan-ui="sidecar"/);
  assert.match(html, /<title>Threadspan — One task\. Every model\.<\/title>/);
  assert.match(html, /Skip to route bar/);
  assert.match(html, /<header id="threadspan-bar"/);
  assert.match(html, /<main id="threadspan-drawer"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="threadspan-drawer"/);
  assert.match(html, /data-hud-injection="not-assumed"/);
  assert.match(html, /documented Desktop HUD injection is not assumed/i);
  assert.match(html, /local daemon/i);
  assert.match(html, /opened independently/i);
  assert.match(html, /plugin or MCP UI surface/i);
  for (const field of [
    "route",
    "mode",
    "availability",
    "quota",
    "context",
    "fallbacks",
    "checkpoint",
    "utilization",
    "history",
    "route-map",
    "appearance",
    "filters",
    "reroute",
  ]) {
    assert.match(html, new RegExp(`data-field="${field}"`));
  }
  assert.match(html, />Consult</);
  assert.match(html, />Integrated</);
  assert.match(html, />Delegate</);
  assert.match(html, /ckpt_18f2/);
  assert.match(html, /qualified fallbacks/i);
  assert.match(html, /does not apply automatic failover/i);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
  assert.match(html, /href="\.\/threadspan\.css"/);
  assert.match(html, /src="\.\/mark\.svg"/);
  assert.match(html, /src="\.\/adapt-state\.js"/);
  assert.match(html, /src="\.\/threadspan\.js"/);
});

test("CSS is local, high-contrast, reduced-motion aware, and not glass or purple", async () => {
  const css = await read("ui/threadspan.css");
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /prefers-contrast:\s*more/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(css, /Threadspan alone owns this copper\/teal accent pair/);
  assert.match(css, /appearance-disclosure/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /"Segoe UI"/);
  assert.match(css, /Ubuntu/);
  assert.match(css, /min-height:\s*2\.5rem/);
  assert.match(css, /@media \(max-width: 40rem\)/);
  assert.doesNotMatch(css, /backdrop-filter/);
  assert.doesNotMatch(css, /glass/i);
  assert.doesNotMatch(css, /url\(["']?https?:/i);
  assert.doesNotMatch(css, /purple|violet|magenta|indigo|fuchsia/i);
});

test("mark.svg is an editable vector braid without raster assets", async () => {
  const svg = await read("ui/mark.svg");
  assert.match(svg, /<svg[\s\S]*viewBox="0 0 32 32"/);
  assert.match(svg, /id="strand-ink"/);
  assert.match(svg, /id="strand-copper"/);
  assert.match(svg, /id="strand-teal"/);
  assert.match(svg, /<path /);
  assert.match(svg, /<title/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(svg, /<image[\s>]/);
  assert.doesNotMatch(svg, /xlink:href=/);
  assert.doesNotMatch(svg, /href=["']https?:/);
});

test("adapter normalizes synthetic JSON and fails closed on bad state", async () => {
  const source = await read("ui/adapt-state.js");
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, vm.createContext(sandbox));
  const api = sandbox.ThreadspanState;
  assert.equal(typeof api.adaptThreadspanState, "function");
  assert.equal(api.SYNTHETIC_STATE.hud.assumedInjection, false);

  const ready = api.adaptThreadspanState(api.SYNTHETIC_STATE);
  assert.equal(ready.status, "ready");
  assert.equal(ready.product.tagline, "One task. Every model.");
  assert.equal(ready.route.mode, "delegate");
  assert.equal(ready.route.verified, true);
  assert.equal(ready.fallbacks.length, 2);
  assert.ok(ready.fallbacks.every((row) => row.qualified));
  assert.equal(ready.checkpoint.id, "ckpt_18f2");
  assert.equal(ready.context.percentUsed, 41);
  assert.equal(ready.reroute.actor, "operator");
  assert.match(ready.modeNote, /bounded execution task/i);
  assert.equal(ready.hud.assumedInjection, false);

  const filtered = api.applyFilters(ready, { mode: "consult", verifiedOnly: true });
  assert.equal(filtered.fallbacks.length, 2);
  assert.equal(filtered.history.length, 1);
  assert.equal(filtered.history[0].event, "consult-complete");

  assert.equal(api.adaptThreadspanState(null).status, "empty");
  assert.equal(api.adaptThreadspanState("nope").status, "error");
  assert.equal(api.adaptThreadspanState({ status: "loading" }).status, "loading");
  assert.equal(api.adaptThreadspanState({ route: { id: "other/x/y", mode: "other" } }).status, "empty");
});

test("docs describe independent hosting and refuse assumed Desktop HUD injection", async () => {
  const docs = await read("docs/UI.md");
  assert.match(docs, /HUD injection is not assumed/i);
  assert.match(docs, /Served by the local daemon/);
  assert.match(docs, /Opened independently/);
  assert.match(docs, /plugin or MCP UI surface/i);
  assert.match(docs, /adaptThreadspanState/);
  assert.match(docs, /snapshot is not a security sandbox/i);
  assert.match(docs, /not automatic failover/i);
  assert.match(docs, /not live-certified/i);
});
