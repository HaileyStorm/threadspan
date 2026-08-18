import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InstallerGuiController } from "../src/installer/gui-controller.mjs";
import { InstallerRecoveryStore } from "../src/installer/recovery-store.mjs";

test("daemon restart claims incomplete recovery once through the recorded native host",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"threadspan-gui-restart-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new InstallerRecoveryStore({root:join(root,"state")});
  await store.create({sessionId:"install-old",origin:{kind:"grok",id:"grok-session",project:root}});
  const notifications=[];
  let grokConfirmed=false;
  const options={recoveryStore:store,listTasks:async()=>[],notifyOrigin:async(origin)=>{const notified=origin.kind!=="grok"||grokConfirmed;grokConfirmed=true;notifications.push({kind:origin.kind,notified});return{notified,kind:origin.kind}}};

  const first=new InstallerGuiController({server:{host:"127.0.0.1",port:8743}},options);
  await first.createSession({installRoot:root,origin:{kind:"direct"}});
  assert.deepEqual(notifications,[{kind:"grok",notified:false}]);
  assert.equal((await store.read("install-old")).notificationSentAt,null,"unconfirmed delivery is not marked sent");
  await store.update("install-old",{notificationClaimedAt:new Date().toISOString()});

  await store.create({sessionId:"install-pending",origin:{kind:"codex",id:"codex-session",project:root}});
  const second=new InstallerGuiController({server:{host:"127.0.0.1",port:8743}},options);
  const concurrent=new InstallerGuiController({server:{host:"127.0.0.1",port:8743}},options);
  await Promise.all([
    second.createSession({installRoot:root,origin:{kind:"direct"}}),
    concurrent.createSession({installRoot:root,origin:{kind:"direct"}}),
  ]);
  assert.deepEqual(notifications,[{kind:"grok",notified:false},{kind:"grok",notified:true},{kind:"codex",notified:true}],"restart retries a stale unconfirmed claim once, skips direct sessions, and keeps a newly pending native origin");

  const third=new InstallerGuiController({server:{host:"127.0.0.1",port:8743}},options);
  await third.createSession({installRoot:root,origin:{kind:"direct"}});
  assert.equal(notifications.filter((item)=>item.notified).length,2,"each native origin has exactly one confirmed notification across restart");
});

test("task protection receipts cannot cross sessions or survive a changed plan",async(t)=>{
  const root=await mkdtemp(join(tmpdir(),"threadspan-gui-receipt-")),installRoot=join(root,"install");
  await mkdir(installRoot);t.after(()=>rm(root,{recursive:true,force:true}));
  const groups=[{project:"/repo",defaultDisposition:"wait",tasks:[{id:"t1",name:"Build",status:"active",defaultDisposition:"wait"}]}];
  let inventoryCall=0;
  const controller=new InstallerGuiController({server:{host:"127.0.0.1",port:8743}},{
    recoveryStore:new InstallerRecoveryStore({root:join(root,"state")}),
    stableUpdater:{checkAndUpdate:async()=>({status:"current",currentVersion:"0.4.0",latestVersion:"0.4.0",canContinueCurrent:true,retryable:true})},
    listTasks:async()=>inventoryCall++%2===0?groups:[],
  });
  const first=await controller.createSession({installRoot,origin:{kind:"direct"}}),firstNonce=new URL(first.url).hash.slice("#session=".length);
  await controller.bootstrap(firstNonce);
  const firstPlan=await controller.plan(firstNonce,{components:["daemon"]});
  const firstReceipt=await controller.protect(firstNonce,{taskIds:["t1"],disposition:"wait"});
  assert.equal(firstReceipt.sessionId,first.sessionId);
  assert.equal(firstReceipt.planDigest,firstPlan.plan.digest);
  assert.deepEqual(firstReceipt.taskIds,["t1"]);
  assert.equal(firstReceipt.nativeInventory.trusted,true);

  const second=await controller.createSession({installRoot,origin:{kind:"direct"}}),secondNonce=new URL(second.url).hash.slice("#session=".length);
  await controller.bootstrap(secondNonce);
  const secondPlan=await controller.plan(secondNonce,{components:["daemon"]});
  controller.authorize(secondNonce).taskReceipt=firstReceipt;
  await assert.rejects(controller.apply(secondNonce,{approvedDigest:secondPlan.plan.digest,desktopClosureApproved:true}),/matching server-issued protection receipt/);

  const changedPlan=await controller.plan(firstNonce,{components:["daemon","continuity"]});
  assert.notEqual(changedPlan.plan.digest,firstPlan.plan.digest);
  controller.authorize(firstNonce).taskReceipt=firstReceipt;
  await assert.rejects(controller.apply(firstNonce,{approvedDigest:changedPlan.plan.digest,desktopClosureApproved:true}),/matching server-issued protection receipt/);
});
