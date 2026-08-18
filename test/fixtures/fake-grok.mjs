import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
if (process.env.FAKE_GROK_COUNTER_PATH) {
  await appendFile(process.env.FAKE_GROK_COUNTER_PATH, `${JSON.stringify(args)}\n`, "utf8");
}
if (args.includes("--version")) {
  process.stdout.write("grok 1.0.4 (test)\n");
  process.exit(0);
}
if (args[0] === "models") {
  process.stdout.write(JSON.stringify({ models: [{ id: "grok-4.6" }] }));
  process.exit(0);
}
if (process.env.FAKE_GROK_ARGS_PATH) {
  await writeFile(process.env.FAKE_GROK_ARGS_PATH, JSON.stringify(args), "utf8");
}
if (process.env.FAKE_GROK_QUOTA === "1") {
  process.stderr.write(JSON.stringify({ error: { code: "subscription:free-usage-exhausted", message: "quota exhausted" } }));
  process.exit(1);
}
const resumeIndex = args.indexOf("--resume");
const sessionIndex = args.indexOf("--session-id");
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : sessionIndex >= 0 ? args[sessionIndex + 1] : undefined;
const attempt = resumeIndex >= 0 ? "recovery" : "initial";
const sessionMode = process.env.FAKE_GROK_SESSION_MODE;
const omitSession = sessionMode === `omit-${attempt}`;
const returnedSessionId = sessionMode === `mismatch-${attempt}` ? `mismatch-${sessionId}` : sessionId;
const sessionEnvelope = omitSession || !returnedSessionId ? {} : { session_id: returnedSessionId };
if (process.env.FAKE_GROK_RETARGET_LINK && process.env.FAKE_GROK_RETARGET_TARGET && process.env.FAKE_GROK_EXPECT_PHYSICAL_WORKSPACE) {
  await rm(process.env.FAKE_GROK_RETARGET_LINK, { force: true });
  await symlink(
    process.env.FAKE_GROK_RETARGET_TARGET,
    process.env.FAKE_GROK_RETARGET_LINK,
    process.env.FAKE_GROK_RETARGET_LINK_TYPE ?? "dir",
  );
  const cwdIndex = args.indexOf("--cwd");
  const [argumentWorkspace, environmentWorkspace, processWorkspace, expectedWorkspace] = await Promise.all([
    realpath(args[cwdIndex + 1]),
    realpath(process.env.CURSOR_BRIDGE_WORKSPACE),
    realpath(process.cwd()),
    realpath(process.env.FAKE_GROK_EXPECT_PHYSICAL_WORKSPACE),
  ]);
  if (argumentWorkspace !== expectedWorkspace || environmentWorkspace !== expectedWorkspace || processWorkspace !== expectedWorkspace) {
    process.stderr.write(JSON.stringify({ error: { code: "workspace_escape", message: "retargeted workspace escaped its physical binding" } }));
    process.exit(1);
  }
}
if (process.env.FAKE_GROK_LOCK_DIR) {
  await mkdir(process.env.FAKE_GROK_LOCK_DIR, { recursive: true });
  const workspaceKey = process.env.FAKE_GROK_LOCK_KEY
    ?? createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  const lockPath = join(process.env.FAKE_GROK_LOCK_DIR, `${workspaceKey}.lock`);
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    process.stderr.write(JSON.stringify({ error: { code: "duplicate_writer", message: "concurrent writer detected" } }));
    process.exit(1);
  }
  try {
    const required = Number(process.env.FAKE_GROK_BARRIER_COUNT ?? 0);
    if (required > 1) {
      let observed = false;
      for (let index = 0; index < 100; index += 1) {
        const entries = await readdir(process.env.FAKE_GROK_LOCK_DIR);
        if (entries.filter((entry) => entry.endsWith(".lock")).length >= required) {
          observed = true;
          break;
        }
        await delay(5);
      }
      if (!observed) {
        process.stderr.write(JSON.stringify({ error: { code: "barrier_timeout", message: "unrelated workspaces did not overlap" } }));
        process.exitCode = 1;
      } else {
        await delay(50);
      }
    } else {
      await delay(Number(process.env.FAKE_GROK_LOCK_DELAY_MS ?? 80));
    }
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
  if (process.exitCode) process.exit(process.exitCode);
}
if (resumeIndex >= 0 && process.env.FAKE_GROK_RECOVERY_ENTITLEMENT === "1") {
  process.stderr.write(JSON.stringify({ error: { code: "entitlement_rejected", message: "product entitlement rejected" } }));
  process.exit(1);
}
if (resumeIndex >= 0) {
  process.stdout.write(JSON.stringify({
    output_text: "worker-recovered",
    ...sessionEnvelope,
    usage: { input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 3, reasoning_tokens: 1, total_tokens: 14 },
    turns: 3,
    model_calls: 3,
    estimated_cost: "$0.0040",
    model: "grok-4.6",
    finish_reason: "stop"
  }));
  process.exit(0);
}
if (process.env.FAKE_GROK_MALFORMED === "1") {
  process.stdout.write("not terminal json");
  process.exit(0);
}
if (process.env.FAKE_GROK_NESTED_SPOOF === "1") {
  process.stdout.write(JSON.stringify({
    output_text: "nested-spoof",
    result: {
      session_id: sessionId,
      finish_reason: "max_turns",
      turns: 12,
      model_calls: 12,
      activities: [{ kind: "plan" }, { kind: "read" }, { kind: "read" }, { kind: "read" }]
    }
  }));
  process.exit(0);
}
if (process.env.FAKE_GROK_CHANGE_FILE === "1") {
  await writeFile("exploration-change.txt", "changed\n", "utf8");
}
if (process.env.FAKE_GROK_EXPLORATION === "1" || process.env.FAKE_GROK_INCOMPLETE === "1") {
  const turnIndex = args.indexOf("--max-turns");
  const turns = Number(args[turnIndex + 1]);
  if (process.env.FAKE_GROK_MAX_TURN_STDERR) process.stderr.write(process.env.FAKE_GROK_MAX_TURN_STDERR);
  process.stdout.write(JSON.stringify({
    output_text: process.env.FAKE_GROK_EXPLORATION_TEXT ?? "exploration-only",
    ...sessionEnvelope,
    ...(process.env.FAKE_GROK_MAX_TURN_ERROR_CODE ? { error_code: process.env.FAKE_GROK_MAX_TURN_ERROR_CODE } : {}),
    ...(process.env.FAKE_GROK_MAX_TURN_ERROR_MESSAGE ? { error_message: process.env.FAKE_GROK_MAX_TURN_ERROR_MESSAGE } : {}),
    ...(process.env.FAKE_GROK_MAX_TURN_ERROR_STATUS ? { error_status: process.env.FAKE_GROK_MAX_TURN_ERROR_STATUS } : {}),
    ...(process.env.FAKE_GROK_MAX_TURN_DIAGNOSTIC ? { diagnostic: process.env.FAKE_GROK_MAX_TURN_DIAGNOSTIC } : {}),
    ...(process.env.FAKE_GROK_EXPLORATION === "1" ? {
      activities: [{ kind: "plan" }, { kind: "read" }, { type: "file_read" }, { action: "search" }]
    } : {}),
    usage: { input_tokens: 8, cache_read_input_tokens: 12, output_tokens: 2, reasoning_tokens: 2, total_tokens: 24 },
    turns,
    model_calls: turns,
    estimated_cost: "$0.0080",
    model: "grok-4.6",
    finish_reason: "max_turns"
  }));
  process.exit(process.env.FAKE_GROK_MAX_TURN_EXIT === "1" ? 17 : 0);
}
const promptIndex = args.indexOf("--single");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";
process.stdout.write(JSON.stringify({
  output_text: prompt.includes("AUTHORITATIVE THREAD PACKET") ? "worker-ok" : "missing-packet",
  ...sessionEnvelope,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 20,
    output_tokens: 3,
    reasoning_tokens: 2,
    total_tokens: 35
  },
  turns: 2,
  model_calls: 2,
  estimated_cost: "$0.0100",
  model: "grok-4.6",
  finish_reason: "stop"
}));
