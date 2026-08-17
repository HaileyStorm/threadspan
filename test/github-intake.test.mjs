import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GitHubCompatibilityIntake } from "../src/maintenance/github-intake.mjs";

test("GitHub intake persists only bounded issue and PR metadata and reuses ETag", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadspan-intake-"));
  t.after(async () => { const { rm } = await import("node:fs/promises"); await rm(root, { recursive: true, force: true }); });
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (calls.length === 2) return new Response(null, { status: 304, headers: { etag: '"one"' } });
    return new Response(JSON.stringify([
      { number: 7, title: "Windows update drift", html_url: "https://github.com/HaileyStorm/threadspan/issues/7", state: "open", updated_at: "2026-08-17T00:00:00Z", user: { login: "agent-user" }, labels: [{ name: "compatibility" }], body: "must not persist" },
      { number: 8, title: "Profile fix", html_url: "https://github.com/HaileyStorm/threadspan/pull/8", state: "open", updated_at: "2026-08-17T01:00:00Z", user: { login: "contributor" }, labels: [{ name: "compatibility" }], pull_request: { url: "untrusted" }, diff_url: "must not persist" },
    ]), { status: 200, headers: { etag: '"one"' } });
  };
  const path = join(root, "state.json");
  const intake = new GitHubCompatibilityIntake({ fetchImpl, statePath: path, environment: { GITHUB_TOKEN: "secret" } });
  const first = await intake.poll();
  assert.deepEqual(first.counts, { issues: 1, pullRequests: 1 });
  const stored = await readFile(path, "utf8");
  assert.doesNotMatch(stored, /must not persist|secret|diff_url|body/);
  const second = await intake.poll();
  assert.equal(second.status, "unchanged");
  assert.equal(calls[1].headers["if-none-match"], '"one"');
});
