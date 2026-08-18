import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstallerRecoveryStore } from "../src/installer/recovery-store.mjs";
test("installer recovery persists bounded origin metadata without prompts",async(t)=>{const root=await mkdtemp(join(tmpdir(),"threadspan-recovery-"));t.after(()=>rm(root,{recursive:true,force:true}));const store=new InstallerRecoveryStore({root});await store.create({sessionId:"install-test",origin:{kind:"grok",id:"session-1",project:"/tmp/project"}});await store.update("install-test",{state:"planned",selectedComponents:["daemon"],planDigest:"abc",ignoredSecret:"no"});const record=await store.read("install-test");assert.equal(record.origin.kind,"grok");assert.equal(record.state,"planned");assert.equal(record.ignoredSecret,undefined);assert.doesNotMatch(await readFile(join(root,"install-test.json"),"utf8"),/prompt|ignoredSecret/)});

test("installer recovery atomically claims donation visibility once per session",async(t)=>{const root=await mkdtemp(join(tmpdir(),"threadspan-recovery-donation-"));t.after(()=>rm(root,{recursive:true,force:true}));const store=new InstallerRecoveryStore({root});await store.create({sessionId:"install-donation",origin:{kind:"direct"}});const claims=await Promise.all([store.claimDonation("install-donation"),store.claimDonation("install-donation"),store.claimDonation("install-donation")]);assert.deepEqual(claims.sort(),[false,false,true]);assert.match((await store.read("install-donation")).donationShownAt,/^\d{4}-\d{2}-\d{2}T/)});
