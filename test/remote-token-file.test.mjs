import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RemoteBridgeService } from "../src/bridge/remote-service.mjs";
test("remote MCP shim can read an owner-local token file",async(t)=>{const root=await mkdtemp(join(tmpdir(),"threadspan-token-"));t.after(()=>rm(root,{recursive:true,force:true}));const tokenFile=join(root,"token");await writeFile(tokenFile,"file-token\n",{mode:0o600});let authorization;const service=new RemoteBridgeService({baseUrl:"http://127.0.0.1:8743",tokenFile,environment:{},fetchImpl:async(_url,init)=>{authorization=init.headers.authorization;return Response.json({status:"ok"})}});await service.stats();assert.equal(authorization,"Bearer file-token")});
