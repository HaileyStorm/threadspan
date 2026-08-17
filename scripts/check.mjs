import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** Recursively collect JavaScript module files. */
async function collect(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collect(path));
    else if (/\.(?:mjs|js)$/.test(entry.name)) output.push(path);
  }
  return output;
}

/** Run `node --check` for one file. */
async function check(path) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--check", path], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`Syntax check failed for ${path}`)));
  });
}

for (const path of await collect(resolve("src"))) await check(path);
for (const path of await collect(resolve("scripts"))) await check(path);
