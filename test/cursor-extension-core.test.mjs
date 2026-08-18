import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
const require=createRequire(import.meta.url);const {normalizeLoopbackBaseUrl,normalizeWindowsLaunch,renderState}=require("../integrations/cursor-threadspan/core.js");
test("Cursor extension never sends daemon bearer off loopback",()=>{assert.equal(normalizeLoopbackBaseUrl("http://127.0.0.1:8743/"),"http://127.0.0.1:8743");assert.throws(()=>normalizeLoopbackBaseUrl("https://example.com"),/loopback-only/);assert.throws(()=>normalizeLoopbackBaseUrl("http://user:pass@localhost:8743"),/credentials/)});
test("Cursor extension renders current route and host state",()=>{const html=renderState({route:{selected:{id:"consult/grok/grok-4.6"}},fallbacks:[{provider:"nous",model:"deepseek"}],utilization:{providers:{grok:{status:"ready"}}},hostSurfaces:[{label:"Cursor",tier:"standard",reverse:true}]});assert.match(html,/consult\/grok/);assert.match(html,/nous/);assert.match(html,/Cursor \(standard\)/)});
test("Cursor Windows launch passes hostile path text as one PowerShell file argument",()=>{const launch=normalizeWindowsLaunch("C:\\bin\\threadspan.cmd",["--origin-project","C:\\x & y"],{SystemRoot:"C:\\Windows"});assert.match(launch.command,/powershell\.exe$/i);assert.equal(launch.args.at(-1),"C:\\x & y");assert.match(launch.args[6],/threadspan\.ps1$/i)});
