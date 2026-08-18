import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createCompanionLaunchPlan, createUpdatedInstallerRelaunchPlan, launchCompanionWindow, resolveInstallerProxyUrl } from "../src/installer/companion-launch.mjs";
import { createResumeCapsule } from "../src/installer/update-check.mjs";

test("companion launch is an argv-safe loopback app window", () => {
  const plan = createCompanionLaunchPlan({ browserPath: "/usr/bin/vivaldi", url: "http://127.0.0.1:8743/threadspan/install/#session=opaque" });
  assert.equal(plan.command, "/usr/bin/vivaldi");
  assert.equal(plan.args[0], "--app=http://127.0.0.1:8743/threadspan/install/#session=opaque");
  assert.throws(() => createCompanionLaunchPlan({ browserPath: "browser", url: "https://example.com/threadspan/install/" }), /loopback-only/);
});

test("staged helper pins absolute-form requests to the configured loopback daemon", () => {
  const upstream = resolveInstallerProxyUrl("http://attacker.invalid/threadspan/install/api/apply?attempt=1", "http://127.0.0.1:8743");
  assert.equal(upstream.href, "http://127.0.0.1:8743/threadspan/install/api/apply?attempt=1");
  assert.throws(() => resolveInstallerProxyUrl("http://attacker.invalid/other", "http://127.0.0.1:8743"), /only installer API/);
});

test("companion launch waits for browser spawn and rejects startup failure", async () => {
  let unref = false;
  const launched = launchCompanionWindow({
    browserPath: "/browser",
    url: "http://127.0.0.1:8743/threadspan/install/#session=opaque",
    spawnChild: () => {
      const child = new EventEmitter();
      child.pid = 41;
      child.unref = () => { unref = true; };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal((await launched).pid, 41);
  assert.equal(unref, true);

  await assert.rejects(launchCompanionWindow({
    browserPath: "/missing-browser",
    url: "http://127.0.0.1:8743/threadspan/install/#session=opaque",
    spawnChild: () => {
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    },
  }), /ENOENT/);
});

test("updated installer relaunch keeps the capsule and credentials out of argv", () => {
  const resumeCapsule = createResumeCapsule({
    sessionId: "install-test",
    nonce: "opaque-session-nonce",
    installRoot: "/tmp/threadspan-install",
    fromVersion: "0.4.0",
    toVersion: "0.5.0",
    issuedAt: "2026-08-17T00:00:00.000Z",
  });
  const digest = "a".repeat(64);
  const plan = createUpdatedInstallerRelaunchPlan({
    stagedRoot: "/tmp/threadspan-staged",
    daemonBaseUrl: "http://127.0.0.1:8743",
    resumeCapsule,
    verifiedAssets: {
      "ui/install.html": digest,
      "ui/install.css": digest,
      "ui/install.js": digest,
      "ui/mark.svg": digest,
    },
    environment: { PATH: "/usr/bin", DISPLAY: ":0", NOUS_API_KEY: "must-not-propagate" },
  });
  assert.deepEqual(plan.args.slice(-1), ["--serve-staged-gui"]);
  assert.doesNotMatch(plan.args.join(" "), /opaque-session-nonce|must-not-propagate/);
  assert.equal(plan.environment.DISPLAY, ":0");
  assert.equal(plan.environment.NOUS_API_KEY, undefined);
  assert.ok(Object.keys(plan.environment).some((key) => key === "THREADSPAN_STAGED_GUI_RELAUNCH"));
  assert.throws(() => createUpdatedInstallerRelaunchPlan({
    stagedRoot: "/tmp/threadspan-staged",
    daemonBaseUrl: "https://github.com",
    resumeCapsule,
    verifiedAssets: {},
  }), /loopback/);
});
