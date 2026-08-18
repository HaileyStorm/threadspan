import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";
import { runMcpHttpProxy } from "../src/mcp/server.mjs";
import { createTestConfig, nativePath } from "./helpers.mjs";

const execFileAsync=promisify(execFile);
test("scoped connector token reaches Streamable HTTP MCP but not v1",async(t)=>{
  const previous=process.env.THREADSPAN_TEST_CONNECTOR,previousMain=process.env.THREADSPAN_TEST_MAIN;
  process.env.THREADSPAN_TEST_CONNECTOR="connector-only";process.env.THREADSPAN_TEST_MAIN="main-only";
  t.after(()=>{if(previous===undefined)delete process.env.THREADSPAN_TEST_CONNECTOR;else process.env.THREADSPAN_TEST_CONNECTOR=previous;if(previousMain===undefined)delete process.env.THREADSPAN_TEST_MAIN;else process.env.THREADSPAN_TEST_MAIN=previousMain});
  const config={server:{host:"127.0.0.1",port:0,connectorTokenEnv:"THREADSPAN_TEST_CONNECTOR",authTokenEnv:"THREADSPAN_TEST_MAIN",allowUnauthenticatedLoopback:false,maxConcurrentRequests:2,requestTimeoutMs:5000,maxBodyBytes:1024*1024}};
  const service={stats(){return{status:"ok"}}};const server=createHttpServer(service,config);t.after(()=>closeHttpServer(server));
  const bound=await listenHttpServer(server,{host:"127.0.0.1",port:0}),base=`http://127.0.0.1:${bound.port}`;
  const init=await fetch(`${base}/mcp`,{method:"POST",headers:{authorization:"Bearer connector-only","content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-11-25"}})});
  assert.equal(init.status,200);assert.equal((await init.json()).result.serverInfo.name,"threadspan");const session=init.headers.get("mcp-session-id"),connectorHeaders={authorization:"Bearer connector-only","content-type":"application/json","mcp-session-id":session};const listed=await fetch(`${base}/mcp`,{method:"POST",headers:connectorHeaders,body:JSON.stringify({jsonrpc:"2.0",id:"list",method:"tools/list",params:{}})}),connectorTools=(await listed.json()).result.tools;assert.deepEqual(connectorTools.map(tool=>tool.name),["consult","integrated","bridge_status","bridge_models","bridge_accounts"]);assert.equal(connectorTools.find(tool=>tool.name==="consult").inputSchema.properties.workspace,undefined);const denied=await fetch(`${base}/mcp`,{method:"POST",headers:connectorHeaders,body:JSON.stringify({jsonrpc:"2.0",id:"deny",method:"tools/call",params:{name:"delegate",arguments:{question:"mutate",workspace:"/tmp"}}})});assert.match((await denied.json()).error.message,/outside this connector's read-only scope/);const deniedWorkspace=await fetch(`${base}/mcp`,{method:"POST",headers:connectorHeaders,body:JSON.stringify({jsonrpc:"2.0",id:"deny-workspace",method:"tools/call",params:{name:"consult",arguments:{question:"read",workspace:"/private"}}})});assert.match((await deniedWorkspace.json()).error.message,/cannot authorize filesystem workspace access/);const ownerList=await fetch(`${base}/mcp`,{method:"POST",headers:{authorization:"Bearer main-only","content-type":"application/json","mcp-session-id":session},body:JSON.stringify({jsonrpc:"2.0",id:"owner",method:"tools/list",params:{}})});assert.equal(ownerList.status,401);assert.match((await ownerList.json()).error.message,/invalid MCP connector bearer token/);
  assert.equal((await fetch(`${base}/v1/health`,{headers:{authorization:"Bearer connector-only"}})).status,401);
});

test("HTTP MCP preserves typed ids, rejects active duplicates, and cancels the exact queued or active call",async(t)=>{
  const oldMain=process.env.THREADSPAN_TEST_MAIN,oldConnector=process.env.THREADSPAN_TEST_CONNECTOR;process.env.THREADSPAN_TEST_MAIN="main-cancel";process.env.THREADSPAN_TEST_CONNECTOR="connector-cancel";
  t.after(()=>{if(oldMain===undefined)delete process.env.THREADSPAN_TEST_MAIN;else process.env.THREADSPAN_TEST_MAIN=oldMain;if(oldConnector===undefined)delete process.env.THREADSPAN_TEST_CONNECTOR;else process.env.THREADSPAN_TEST_CONNECTOR=oldConnector});
  const aborted=new Set();const service={consult(input,{signal}){return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>{aborted.add(input.question);reject(signal.reason)},{once:true}))}};
  const config={server:{host:"127.0.0.1",port:0,connectorTokenEnv:"THREADSPAN_TEST_CONNECTOR",authTokenEnv:"THREADSPAN_TEST_MAIN",allowUnauthenticatedLoopback:false,maxConcurrentRequests:1,requestTimeoutMs:5000,maxBodyBytes:1024*1024}};
  const server=createHttpServer(service,config);t.after(()=>closeHttpServer(server));const bound=await listenHttpServer(server,{host:"127.0.0.1",port:0}),base=`http://127.0.0.1:${bound.port}`,headers={authorization:"Bearer connector-cancel","content-type":"application/json"};
  const initialized=await fetch(`${base}/mcp`,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{}})});const session=initialized.headers.get("mcp-session-id");
  const sessionHeaders={...headers,"mcp-session-id":session};const active=fetch(`${base}/mcp`,{method:"POST",headers:sessionHeaders,body:JSON.stringify({jsonrpc:"2.0",id:9,method:"tools/call",params:{name:"consult",arguments:{question:"number"}}})});const queued=fetch(`${base}/mcp`,{method:"POST",headers:sessionHeaders,body:JSON.stringify({jsonrpc:"2.0",id:"9",method:"tools/call",params:{name:"consult",arguments:{question:"string"}}})});
  await new Promise(resolve=>setTimeout(resolve,20));
  const cancelledString=await fetch(`${base}/mcp`,{method:"POST",headers:sessionHeaders,body:JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:"9",reason:"stop-string"}})});assert.equal(cancelledString.status,202);const queuedResponse=await queued;assert.equal(queuedResponse.status,200);assert.match((await queuedResponse.json()).error.message,/stop-string/);assert.deepEqual([...aborted],[]);const duplicate=await fetch(`${base}/mcp`,{method:"POST",headers:sessionHeaders,body:JSON.stringify({jsonrpc:"2.0",id:9,method:"ping",params:{}})});assert.match((await duplicate.json()).error.message,/Duplicate active/);const cancelledNumber=await fetch(`${base}/mcp`,{method:"POST",headers:sessionHeaders,body:JSON.stringify({jsonrpc:"2.0",method:"notifications/cancelled",params:{requestId:9,reason:"stop-number"}})});assert.equal(cancelledNumber.status,202);assert.equal((await active).status,200);assert.deepEqual([...aborted],["number"]);
});

test("stdio host shim proxies through /mcp using only its connector token file",async(t)=>{const previous=process.env.THREADSPAN_TEST_CONNECTOR;process.env.THREADSPAN_TEST_CONNECTOR="connector-file-value";t.after(()=>{if(previous===undefined)delete process.env.THREADSPAN_TEST_CONNECTOR;else process.env.THREADSPAN_TEST_CONNECTOR=previous});const root=await mkdtemp(join(tmpdir(),"threadspan-mcp-proxy-")),tokenFile=join(root,"connector-token");t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(tokenFile,"connector-file-value\n",{mode:0o600});const config={server:{host:"127.0.0.1",port:0,connectorTokenEnv:"THREADSPAN_TEST_CONNECTOR",allowUnauthenticatedLoopback:false,maxConcurrentRequests:1,requestTimeoutMs:5000,maxBodyBytes:1024*1024}},server=createHttpServer({},config);t.after(()=>closeHttpServer(server));const bound=await listenHttpServer(server,{host:"127.0.0.1",port:0}),input=new PassThrough(),output=new PassThrough();let text="";output.on("data",chunk=>{text+=chunk.toString("utf8")});const proxy=runMcpHttpProxy({endpoint:`http://127.0.0.1:${bound.port}/mcp`,tokenFile,input,output});input.end(`${JSON.stringify({jsonrpc:"2.0",id:"proxy",method:"tools/list",params:{}})}\n`);await proxy;const response=JSON.parse(text.trim());assert.equal(response.id,"proxy");assert.deepEqual(response.result.tools.map(tool=>tool.name),["consult","integrated","bridge_status","bridge_models","bridge_accounts"])});

test("HTTP MCP rejects identical owner and connector token values",()=>{const oldMain=process.env.THREADSPAN_EQUAL_MAIN,oldConnector=process.env.THREADSPAN_EQUAL_CONNECTOR;process.env.THREADSPAN_EQUAL_MAIN="same-token";process.env.THREADSPAN_EQUAL_CONNECTOR="same-token";try{assert.throws(()=>createHttpServer({}, {server:{authTokenEnv:"THREADSPAN_EQUAL_MAIN",connectorTokenEnv:"THREADSPAN_EQUAL_CONNECTOR"}}),/must be distinct/)}finally{if(oldMain===undefined)delete process.env.THREADSPAN_EQUAL_MAIN;else process.env.THREADSPAN_EQUAL_MAIN=oldMain;if(oldConnector===undefined)delete process.env.THREADSPAN_EQUAL_CONNECTOR;else process.env.THREADSPAN_EQUAL_CONNECTOR=oldConnector}});

test("host and Codex connector installs reject owner-token values and legacy remote MCP fails closed",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"threadspan-mcp-install-boundary-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const ownerFile=join(root,"owner-token"),ownerAlias=join(root,"owner-token-hardlink"),connectorFile=join(root,"connector-token"),configPath=join(root,"config.json"),hostTarget=join(root,"host-mcp.json"),codexTarget=join(root,"codex-config.toml");
  await writeFile(ownerFile,"shared-owner-value\n",{mode:0o600});await writeFile(connectorFile,"shared-owner-value\n",{mode:0o600});
  await link(ownerFile,ownerAlias);
  const config=createTestConfig({accounts:{path:join(root,"accounts.json"),profileSources:{},fallback:{enabled:false,maxCandidates:1}},server:{authTokenEnv:null,authTokenFile:ownerFile,connectorTokenEnv:null,connectorTokenFile:connectorFile,allowUnauthenticatedLoopback:false}});
  await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
  const cli=nativePath(new URL("../src/cli.mjs",import.meta.url));
  await assert.rejects(execFileAsync(process.execPath,[cli,"host","install","--config",configPath,"--host","cursor","--token-file",ownerAlias,"--target",hostTarget]),error=>/must not be the owner main-token file/.test(error.stderr));
  for(const args of [["host","install","--config",configPath,"--host","cursor","--token-file",connectorFile,"--target",hostTarget],["codex","install","--config",configPath,"--codex-config",codexTarget]]){
    await assert.rejects(execFileAsync(process.execPath,[cli,...args]),error=>/must differ from the owner main token/.test(error.stderr));
  }
  await assert.rejects(readFile(hostTarget),/ENOENT/);await assert.rejects(readFile(codexTarget),/ENOENT/);

  await writeFile(connectorFile,"connector-only-value\n",{mode:0o600});
  const embedded=await execFileAsync(process.execPath,[cli,"codex","snippet","--config",configPath,"--embedded-mcp"]);assert.match(embedded.stdout,/"--embedded"/);
  await assert.rejects(execFileAsync(process.execPath,[cli,"mcp","--config",configPath,"--remote","http://127.0.0.1:8743/v1","--token-file",connectorFile]),error=>/connector-only \/mcp endpoint/.test(error.stderr));
});
