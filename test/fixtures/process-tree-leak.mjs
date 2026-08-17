#!/usr/bin/env node
import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
descendant.unref();
process.stdout.write(`${descendant.pid}\n`, () => process.exit(0));
