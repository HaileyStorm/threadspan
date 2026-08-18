#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const claudeMode = args.includes("--output-format");
const modelIndex = args.indexOf("--model");
const cancellationMode = args.includes("--cancel") || args[modelIndex + 1] === "process-tree-cancel";
const providerMode = claudeMode || args.includes("--provider");
const descendantScript = cancellationMode
  ? "process.on('SIGTERM',()=>{});setInterval(() => {}, 1000)"
  : "setInterval(() => {}, 1000)";
const descendant = spawn(process.execPath, ["-e", descendantScript], {
  stdio: providerMode ? ["ignore", "inherit", "inherit"] : "ignore",
});
descendant.unref();
const pidFileIndex = args.indexOf("--pid-file");
if (pidFileIndex >= 0) await writeFile(args[pidFileIndex + 1], String(descendant.pid));

let output = `${descendant.pid}\n`;
if (claudeMode) {
  const sessionFlag = args.includes("--resume") ? "--resume" : "--session-id";
  const sessionId = args[args.indexOf(sessionFlag) + 1];
  const events = [
    { type: "system", subtype: "init", session_id: sessionId },
    { type: "stream_event", session_id: sessionId, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: String(descendant.pid) } } },
  ];
  if (!cancellationMode) {
    events.push(
      { type: "assistant", session_id: sessionId, message: { role: "assistant", content: [{ type: "text", text: String(descendant.pid) }] } },
      { type: "result", subtype: "success", is_error: false, session_id: sessionId, result: String(descendant.pid) },
    );
  }
  output = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

process.stdout.write(output, () => {
  if (cancellationMode) setInterval(() => {}, 1000);
  else process.exit(0);
});
