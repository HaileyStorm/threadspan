import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandProvider } from "../src/providers/command.mjs";
import { silentLogger } from "./helpers.mjs";

test("CommandProvider rejects shell mode before launching a command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "threadspan-command-shell-"));
  const marker = join(directory, "marker");
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "created")`],
    outputFormat: "text",
    shell: true,
  }, { logger: silentLogger() });

  try {
    await assert.rejects(async () => {
      for await (const _event of provider.run({
        mode: "consult",
        model: "model-x",
        messages: [{ role: "user", content: "hello" }],
        workspace: process.cwd(),
      })) {}
    }, /does not support shell:true/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CommandProvider passes hostile placeholder text as one literal argv value", async () => {
  const directory = mkdtempSync(join(tmpdir(), "threadspan-command-argv-"));
  const marker = join(directory, "marker");
  const hostileModel = `literal; ${process.execPath} -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'created')"`;
  const provider = new CommandProvider("cmd", {
    adapter: "command",
    capabilities: ["consult"],
    command: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(process.argv[1]))", "{model}"],
    outputFormat: "text",
  }, { logger: silentLogger() });

  try {
    const events = [];
    for await (const event of provider.run({
      mode: "consult",
      model: hostileModel,
      messages: [{ role: "user", content: "hello" }],
      workspace: process.cwd(),
    })) events.push(event);

    assert.equal(JSON.parse(events.at(-1).message.content), hostileModel);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
