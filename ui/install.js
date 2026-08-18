const stepDefs=[
  ["Update","Checking for updates","Use the latest public release when one is available."],
  ["Select","Choose what to add","Start small. You can add anything later."],
  ["Protect","Protect active work","Choose what must finish before setup."],
  ["Review","Review","Check files, usage, and rollback."],
  ["Install","Install","Approve shutdown and writes separately."],
  ["Prove","Verify","Keep results and rollback together."],
];
const THEME_STORAGE_KEY="threadspanInstallerTheme";
const THEME_MODES=new Set(["system","dark","light"]);
const PROVIDER_COMPONENT_IDS=new Set(["cursor","grok-build","claude-code","agentrouter-free","mistral-api-free","groqcloud-free","cloudflare-workers-ai-free","gemini-api-free","nous","openrouter","codex-native"]);
const READY_STATES=new Set(["ready","installed","available","authenticated"]);
const UNAVAILABLE_STATES=new Set(["not-installed","unavailable","missing","blocked"]);
const state={step:0,bootstrap:null,selected:new Set(),longContext:new Set(),plan:null,applied:null,session:null,resume:null,helper:null,donationShown:false,taskDisposition:"wait",taskIds:[],taskReceipt:null,themeMode:normalizeThemeMode(document.documentElement.dataset.themeMode),hostTheme:null,voicePresets:[],voice:{selectedProfile:"technical-partner",profiles:[]}};
const $=(id)=>document.getElementById(id);
const content=$("content"),next=$("next"),back=$("back"),events=$("events");
let systemThemeMedia=null;try{if(typeof matchMedia==="function")systemThemeMedia=matchMedia("(prefers-color-scheme: dark)")}catch{}

bindThemeControls();
start().catch(fail);

async function start(){
  const hash=new URLSearchParams(location.hash.slice(1));
  state.session=hash.get("session")||sessionStorage.getItem("threadspanInstallSession");
  state.resume=hash.get("resume");
  state.helper=hash.get("helper")||sessionStorage.getItem("threadspanInstallHelper");
  if(!state.session)throw new Error("This installer window has no active session. Launch it with `threadspan install gui`.");
  sessionStorage.setItem("threadspanInstallSession",state.session);
  if(state.helper)sessionStorage.setItem("threadspanInstallHelper",state.helper);
  history.replaceState(null,"",location.pathname);
  state.bootstrap=await api("bootstrap");
  syncThemeFromBootstrap();
  state.selected=new Set(state.bootstrap.defaults);
  removeUnreadyProviderDefaults();
  state.voicePresets=state.bootstrap.voice?.presets||[];
  state.voice={selectedProfile:state.bootstrap.voice?.selectedProfile||"technical-partner",profiles:structuredClone(state.bootstrap.voice?.profiles||[])};
  showOrigin();addEvent("Session",state.resume?"Resumed in the verified updated setup window":"Connected to the local installer");render();
  setInterval(()=>api("heartbeat",{},"POST").catch(()=>{}),10000);
}

function render(){
  document.querySelector(".steps").innerHTML=stepDefs.map((s,i)=>`<span class="step ${i===state.step?"active":i<state.step?"done":""}"><b>${i<state.step?"✓":i+1}</b>${s[0]}</span>`).join("");
  $("step-label").textContent=`Step ${state.step+1} of ${stepDefs.length}`;$("page-title").textContent=stepDefs[state.step][1];$("page-lede").textContent=stepDefs[state.step][2];
  back.disabled=state.step===0;next.disabled=false;next.textContent=state.step===5?"Close":state.step===4?(state.plan?.plan?.hasChanges===false?"Finish":"Install"):state.step===0?updateNextLabel():"Next";
  if(state.step===0)renderUpdate();else if(state.step===1)renderComponents();else if(state.step===2)renderTasks();else if(state.step===3)renderReview();else if(state.step===4)renderApproval();else renderProof();
  updateUsage();
}

function renderUpdate(){
  const update=state.bootstrap.update||{status:"blocked",message:"No stable release result is available.",canContinueCurrent:true,retryable:true};
  const noPublicRelease=update.reason==="no-public-release"||update.reason==="no-stable-release";
  const title=update.status==="current"?"Up to date":update.status==="relaunching"?"Update ready":noPublicRelease?"No public release yet":update.status==="unavailable"?"Update check unavailable":"Current install preserved";
  const tone=update.status==="current"?"update-current":update.status==="relaunching"?"update-progress":"update-warning";
  const versions=[update.currentVersion&&`Current ${update.currentVersion}`,update.latestVersion&&`Stable ${update.latestVersion}`].filter(Boolean).join(" · ");
  const preservation=update.currentChanged?"The official clean checkout was fast-forwarded, but the current installer remains usable. Credentials and task state were not changed.":"No current files, credentials, or task state were changed.";
  content.innerHTML=`<section class="update-card ${tone}"><div class="update-icon" aria-hidden="true">${update.status==="current"?"✓":update.status==="relaunching"?"↗":"!"}</div><div><h2>${esc(title)}</h2><p>${esc(update.message||"Stable release check completed.")}</p>${versions?`<code>${esc(versions)}</code>`:""}</div></section><div class="update-actions"><button class="secondary" id="check-again" type="button" ${update.status==="relaunching"?"disabled":""}>Check again</button>${update.releaseUrl?`<a href="${esc(update.releaseUrl)}" target="_blank" rel="noreferrer">Official release</a>`:""}</div>${update.canContinueCurrent&&update.status!=="current"?`<p class="empty">Use Check again to retry, or continue with the current installation. ${esc(preservation)}</p>`:""}`;
  $("check-again")?.addEventListener("click",checkAgain);
  if(update.status==="relaunching"){
    next.disabled=true;
    addEvent("Update",`Verified stable ${update.latestVersion||"release"}; opening the updated window`);
    setTimeout(()=>window.close(),600);
  }else if(update.status==="unavailable"||update.status==="blocked"){
    addEvent("Update",`${update.message||"Check unavailable"} Current install remains usable.`);
  }else addEvent("Update",`Stable ${update.latestVersion||update.currentVersion} verified`);
  if(update.status!=="relaunching"&&state.bootstrap.donation?.show)showDonationCardOnce();
}

async function checkAgain(){
  next.disabled=true;
  content.innerHTML='<p class="empty">Checking the official latest stable release…</p>';
  try{
    state.bootstrap=await api("bootstrap");
    syncThemeFromBootstrap();
    if(state.bootstrap.defaults?.length){state.selected=new Set(state.bootstrap.defaults);removeUnreadyProviderDefaults()}
    render();
  }catch(error){fail(error)}
}

function updateNextLabel(){
  const status=state.bootstrap.update?.status;
  return status==="unavailable"||status==="blocked"?"Continue current":"Choose components";
}

function renderComponents(){
  const groups=groupInstallerComponents();
  const main=groups.ready.map(componentChoiceMarkup).join("");
  const add=groups.addProviders.map(componentChoiceMarkup).join("");
  const disclosure=add?`<details class="add-providers"><summary>Add providers <span>${groups.addProviders.length}</span></summary><p id="add-providers-help">Extra providers stay here until installed or live-checked. Free and no-card access can change. Selecting one only adds setup steps; nothing is installed, authenticated, enabled, or billed without approval. No provider partnership is implied.</p><div class="choice-list" aria-describedby="add-providers-help">${add}</div></details>`:"";
  content.innerHTML=`<div class="choice-list">${main}</div>${disclosure}<div class="disposition"><strong>Optional long context:</strong><label title="Higher context can consume quota at a higher multiplier"><input type="checkbox" data-long-context="gpt-5.6-600k" ${state.longContext.has("gpt-5.6-600k")?"checked":""}> 600k</label><label title="Use only when the task genuinely needs near-million-token context"><input type="checkbox" data-long-context="gpt-5.6-1m" ${state.longContext.has("gpt-5.6-1m")?"checked":""}> 1M</label></div>${state.selected.has("voice-profiles")?voiceSettingsMarkup():""}`;
  content.querySelectorAll("[data-component]").forEach(el=>el.addEventListener("change",()=>{el.checked?state.selected.add(el.dataset.component):state.selected.delete(el.dataset.component);invalidatePlan();if(el.dataset.component==="voice-profiles")renderComponents()}));
  content.querySelectorAll("[data-long-context]").forEach(el=>el.addEventListener("change",()=>{el.checked?state.longContext.add(el.dataset.longContext):state.longContext.delete(el.dataset.longContext);invalidatePlan()}));
  bindVoiceSettings();
}

function renderTasks(){
  const groups=state.bootstrap.taskGroups||[];
  content.innerHTML=`${state.bootstrap.taskInventoryError?`<p class="error">Task inventory incomplete: ${esc(state.bootstrap.taskInventoryError)} You must verify tasks manually before apply.</p>`:""}${groups.length?groups.map(group=>`<section class="task-group"><header><input class="group-check" type="checkbox" checked><strong>${esc(group.project)}</strong><span>${group.tasks.length} active</span></header>${group.tasks.map(task=>`<label class="task"><input type="checkbox" data-task-id="${esc(task.id)}" checked><span>${esc(task.name)}</span><code>${esc(task.activeFlags.join(", ")||task.status)}</code></label>`).join("")}</section>`).join(""):`<p class="empty">${state.bootstrap.taskEvidence?.trusted?"No active Codex tasks need protection.":"No trusted active-task inventory is available; verify Desktop manually."}</p>`}<div class="disposition"><strong>Selected tasks:</strong><label><input type="radio" name="disposition" value="wait" ${state.taskDisposition==="wait"?"checked":""}> Finish before install</label><label title="Requires a documented native pause controller"><input type="radio" name="disposition" value="pause" ${state.taskDisposition==="pause"?"checked":""} ${state.bootstrap.taskControl?.pauseSupported?"":"disabled"}> Pause explicitly</label></div>`;
  content.querySelectorAll(".group-check").forEach(group=>group.addEventListener("change",()=>{group.closest(".task-group").querySelectorAll(".task input").forEach(item=>item.checked=group.checked);invalidatePlan()}));
  content.querySelectorAll("[data-task-id]").forEach(el=>el.addEventListener("change",invalidatePlan));
  content.querySelectorAll("[name=disposition]").forEach(el=>el.addEventListener("change",()=>{state.taskDisposition=el.value;invalidatePlan()}));
}

async function makePlan(){
  state.plan=await api("plan",{components:[...state.selected],longContextProfiles:state.selected.has("context-profiles")?[...state.longContext]:[],...(state.selected.has("voice-profiles")?{voice:voicePlanInput()}:{}),taskProtection:{taskIds:state.taskIds,disposition:state.taskDisposition}},"POST");
  addEvent("Plan","Digest-bound preview created");
}

function renderReview(){
  if(!state.plan){content.innerHTML='<p class="empty">Preparing the exact plan…</p>';makePlan().then(render).catch(fail);return}
  const p=state.plan.plan,estimate=state.plan.usageEstimate.acceptanceModelTokens;
  const exclusions=(p.exclusions||[]).map(item=>`<li><code>${esc(item.relativePath)}</code> — ${esc(item.reason)}</li>`).join("");
  content.innerHTML=`${p.hasChanges?"":'<p class="empty"><strong>No writable installation changes are planned.</strong> Matching managed files remain unchanged and exclusions remain visibly preserved, so no task protection, Desktop closure, or write approval is needed.</p>'}<div class="review"><pre class="preview">${esc(state.plan.preview.text)}</pre><aside class="evidence"><div><span>Operations</span><strong>${p.operations.length}</strong></div><div><span>Unchanged</span><strong>${(p.unchanged||[]).length}</strong></div><div><span>Excluded</span><strong>${(p.exclusions||[]).length}</strong></div><div><span>Plan digest</span><strong title="${p.digest}">${p.digest.slice(0,12)}…</strong></div><div><span>Acceptance estimate</span><strong>${fmt(estimate.low)}-${fmt(estimate.high)} tokens</strong></div></aside></div>${exclusions?`<section class="approval"><h2>Preserved exclusions</h2><p>These native project/user settings were not changed. Each reason is bound into the plan digest.</p><ul>${exclusions}</ul></section>`:""}${resilienceNote()}`;
}

function renderApproval(){
  if(state.plan.plan.hasChanges===false){content.innerHTML='<p class="empty"><strong>Nothing to approve.</strong> The digest records matching managed files and any visibly preserved exclusions; no Desktop closure or file write will occur.</p>';return}
  content.innerHTML=`<section class="approval"><h2>Desktop closure</h2><p>Selected active tasks must finish, or be explicitly paused, before Desktop closes. Threadspan will not force-kill an app.</p><label><input id="tasks-ready" type="checkbox"> <span>I confirmed the selected tasks are finished or intentionally paused.</span></label><label><input id="desktop-approved" type="checkbox"> <span>I approve closing/restarting Desktop when the reviewed installation requires it.</span></label></section><section class="approval"><h2>File writes</h2><p>Apply only the digest shown in Review. Existing files receive preimage backups and a rollback manifest.</p><label><input id="write-approved" type="checkbox"> <span>Apply plan <code>${state.plan.plan.digest.slice(0,16)}…</code>.</span></label></section>`;
  const sync=()=>next.disabled=!["tasks-ready","desktop-approved","write-approved"].every(id=>$(id).checked);content.querySelectorAll("input").forEach(el=>el.addEventListener("change",sync));sync();
}

function renderProof(){
  const r=state.applied;
  const unchanged=r?.status==="unchanged";
  const preserved=r?.status==="preserved";
  content.innerHTML=(r?`<div class="choice-list"><div class="choice"><span>✓</span><span><strong>${unchanged?"Installation already matched":preserved?"Existing settings preserved":"Installation applied"}</strong><small>${unchanged?"No files or host state changed.":preserved?"No files changed; review the digest-bound exclusions before any future install.":`${esc(r.written?.length||0)} files written. Rollback manifest retained.`}</small></span><span class="tier">Proved</span></div></div><pre class="preview">${esc(JSON.stringify(r,null,2))}</pre>`:`<p class="empty">No apply result is available.</p>`)+roadmapNote();
}

function roadmapNote(){return '<aside class="roadmap-note"><p class="eyebrow">Coming next</p><p><strong>Roadmap, not current functionality:</strong> provider-aware Continuity handoffs, richer reverse-host parity, more provider adapters, smarter availability and utilization planning, and an awesome, sleek, effective memory system.</p></aside>'}
function resilienceNote(){return '<aside class="roadmap-note"><p class="eyebrow">Compatibility Watch — Recover, learn, harden</p><p>Detect app/provider drift, restore compatibility, run bounded direct/meta/meta-meta hardening, and stop. For deterministic early code-work failures: repair directly, collect focused regression evidence, update the recognizer/helper/process, check why detection or coordination missed it, then stop at depth 2. Portable fixes may become reviewed sanitized GitHub issue/PR proposals; agent output remains evidence, not completion authority. No credentials, cross-host state, prompts, recursive analysis, token churn, silent project-policy override, or agent-submitted auto-merge.</p></aside>'}

function showDonationCardOnce(){
  if(state.donationShown)return;
  const template=$("donation-card-template");
  if(!template)return;
  state.donationShown=true;
  content.append(template.content.cloneNode(true));
  content.querySelector("[data-dismiss-donation]")?.addEventListener("click",()=>content.querySelector("[data-donation-card]")?.remove());
}

next.addEventListener("click",async()=>{try{
  if(state.step===5){await closeSession("complete");window.close();return}
  if(state.step===1){
    if(state.selected.size===0)throw new Error("Select at least one component");
    await makePlan();
    if(state.plan.plan.hasChanges===false){state.step=3;render();return}
  }
  if(state.step===2){
    state.taskIds=selectedTaskIds();
    await makePlan();state.taskReceipt=await api("protect",{taskIds:state.taskIds,disposition:state.taskDisposition},"POST");
    addEvent("Tasks",state.taskReceipt.taskIds.length?`Protection receipt issued for ${state.taskReceipt.taskIds.length} task(s)`:"No active task receipt required");
  }
  if(state.step===4){
    next.disabled=true;
    const noChanges=state.plan.plan.hasChanges===false;
    state.applied=await api("apply",noChanges?{approvedDigest:state.plan.plan.digest}:{approvedDigest:state.plan.plan.digest,desktopClosureApproved:true,manualTaskConfirmation:$("tasks-ready").checked},"POST");
    addEvent("Install",noChanges?"No changes required; approval prompts skipped":"Plan applied and rollback manifest written");
  }
  state.step++;render();
}catch(e){fail(e)}});
back.addEventListener("click",()=>{if(state.step>0){state.step=state.step===3&&state.plan?.plan?.hasChanges===false?1:state.step-1;render()}});
$("cancel").addEventListener("click",async()=>{if(confirm("Cancel Threadspan setup? No further changes will be made.")){await closeSession("cancel");window.close()}});
$("monitor-toggle").addEventListener("click",()=>{const area=document.querySelector(".workspace"),hidden=area.classList.toggle("monitor-hidden");$("monitor-toggle").setAttribute("aria-expanded",String(!hidden))});
$("appearance").addEventListener("click",()=>$("appearance-dialog").showModal());
$("save-appearance").addEventListener("click",()=>{document.documentElement.style.setProperty("--copper",$("copper").value);document.documentElement.style.setProperty("--teal",$("teal").value)});

function bindThemeControls(){
  document.querySelectorAll('[name="installer-theme"]').forEach(input=>input.addEventListener("change",()=>{if(input.checked)applyThemeMode(input.value,{persist:true,announce:true})}));
  const onSystemChange=()=>{if(state.themeMode==="system")applyThemeMode("system")};
  if(systemThemeMedia?.addEventListener)systemThemeMedia.addEventListener("change",onSystemChange);else systemThemeMedia?.addListener?.(onSystemChange);
  applyThemeMode(state.themeMode);
}

function syncThemeFromBootstrap(){state.hostTheme=bootstrapThemeHint(state.bootstrap);applyThemeMode(state.themeMode)}
function applyThemeMode(value,{persist=false,announce=false}={}){
  const mode=normalizeThemeMode(value);state.themeMode=mode;
  const effective=mode==="system"?(state.hostTheme||(systemThemeMedia?systemThemeMedia.matches?"dark":"light":"dark")):mode;
  document.documentElement.dataset.themeMode=mode;document.documentElement.dataset.theme=effective;document.documentElement.style.colorScheme=effective;
  document.querySelectorAll('[name="installer-theme"]').forEach(input=>{input.checked=input.value===mode});
  if(persist){try{localStorage.setItem(THEME_STORAGE_KEY,mode)}catch{}}
  if(announce&&$("theme-status"))$("theme-status").textContent=`Installer theme: ${mode}${mode==="system"?` (${effective})`:""}`;
}
function normalizeThemeMode(value){return THEME_MODES.has(String(value||"").toLowerCase())?String(value).toLowerCase():"system"}
function normalizeThemeHint(value){const candidate=value&&typeof value==="object"?(value.theme??value.colorScheme??value.mode):value;const normalized=String(candidate||"").toLowerCase();return normalized==="dark"||normalized==="light"?normalized:null}
function bootstrapThemeHint(bootstrap){
  const candidates=[bootstrap?.theme,bootstrap?.appearance?.theme,bootstrap?.hostTheme,bootstrap?.providerTheme,bootstrap?.host?.theme,bootstrap?.provider?.theme,bootstrap?.origin?.theme,bootstrap?.origin?.appearance?.theme,bootstrap?.recovery?.theme,bootstrap?.recovery?.appearance?.theme,bootstrap?.recovery?.result?.theme];
  return candidates.map(normalizeThemeHint).find(Boolean)||null;
}

function showOrigin(){const o=state.bootstrap.origin;if(o.kind==="direct"&&!o.id)return;const el=$("origin");el.hidden=false;el.innerHTML=`<strong>Origin: ${esc(o.kind)}</strong><code>${esc(o.id||"direct launch")}</code><span>If this window disappears, Threadspan uses this host's native resume path.</span>`}
function installerComponents(){const optional={id:"maximum-utilization",label:"Maximum utilization",description:"Needs authoritative native quota + capable host adapter; otherwise remains observational/pending.",optional:true};return state.bootstrap.components.some(item=>item.id===optional.id)?state.bootstrap.components:[...state.bootstrap.components,optional]}
function groupInstallerComponents(){const ready=[],addProviders=[];for(const component of installerComponents()){if(!PROVIDER_COMPONENT_IDS.has(component.id)||componentReadiness(component)==="ready")ready.push(component);else addProviders.push(component)}return{ready,addProviders}}
function removeUnreadyProviderDefaults(){for(const component of installerComponents())if(PROVIDER_COMPONENT_IDS.has(component.id)&&componentReadiness(component)!=="ready")state.selected.delete(component.id)}
function componentChoiceMarkup(c){const readiness=PROVIDER_COMPONENT_IDS.has(c.id)?componentReadiness(c):null;const readinessText=c.availabilityLabel||readinessLabel(readiness);return `<label class="choice" title="${esc(c.description)}"${readiness?` data-readiness="${readiness}"`:""}><input type="checkbox" data-component="${esc(c.id)}" ${state.selected.has(c.id)?"checked":""}><span><strong>${esc(c.label)}</strong><small>${esc(c.description)}</small>${readiness?`<small class="readiness ${readiness}">Readiness: ${esc(readinessText)}</small>`:""}${c.id==="codex-full-access"?'<small><strong>Warning:</strong> removes command approval pauses and command sandboxing; app/MCP approvals become preapproved. It does not enable destructive or open-world access.</small>':""}</span>${surfaceTier(c.id)}</label>`}
function componentReadiness(component){
  const hostId={"codex-native":"codex","grok-build":"grok",cursor:"cursor"}[component.id];if(hostId&&state.bootstrap?.origin?.kind===hostId)return"ready";
  const surface=state.bootstrap?.hostSurfaces?.find(item=>item.id===(hostId||component.id));const provider=state.bootstrap?.providers?.find(item=>item.id===component.id);
  const metadata=[component.readiness,component.installationStatus,component.installation,component.runtime,provider,surface,state.bootstrap?.providerReadiness?.[component.id],state.bootstrap?.readiness?.providers?.[component.id],state.bootstrap?.recovery?.providerReadiness?.[component.id]];
  const candidates=metadata.flatMap(value=>value&&typeof value==="object"?[value.status,value.state,value.readiness]:[value]);
  const normalized=candidates.map(value=>String(value||"").toLowerCase()).filter(Boolean);if(normalized.some(value=>UNAVAILABLE_STATES.has(value)))return normalized.includes("not-installed")||normalized.includes("missing")?"not-installed":"unavailable";if(normalized.some(value=>READY_STATES.has(value))||metadata.some(value=>value?.installed===true||value?.available===true)||component.installed===true||component.available===true)return"ready";if(metadata.some(value=>value?.installed===false)||component.installed===false)return"not-installed";if(metadata.some(value=>value?.available===false)||component.available===false)return"unavailable";return"unknown";
}
function readinessLabel(value){return{ready:"Ready",unavailable:"Unavailable","not-installed":"Not installed",unknown:"Unknown — verify install and sign-in prerequisites in Review"}[value]||"Unknown"}
function surfaceTier(id){const map={"grok-build":"Enhanced",cursor:"Standard","codex-native":"Primary","claude-code":"Preview","maximum-utilization":"Optional"};return map[id]?`<span class="tier">${map[id]}</span>`:"<span></span>"}
function updateUsage(){const n=[...state.selected].filter(x=>["cursor","grok-build","nous","openrouter","claude-code"].includes(x)).length;$("usage").textContent=n?`~${fmt(n*8000)}-${fmt(n*75000)} acceptance tokens`:"0 model tokens"}
function selectedTaskIds(){return [...document.querySelectorAll("[data-task-id]:checked")].map(el=>el.dataset.taskId)}
function invalidatePlan(){state.plan=null;state.taskReceipt=null}

function voiceSettingsMarkup(){
  const profile=currentVoiceProfile();
  const custom=state.voice.profiles.some(item=>item.id===state.voice.selectedProfile);
  const parameters=[
    ["directness","Directness","D"],["warmth","Warmth","W"],["technicalDepth","Technical depth","T"],
    ["progressCadence","Progress cadence","P"],["uncertaintyDisclosure","Uncertainty disclosure","U"],["correctionExplicitness","Correction explicitness","C"],
  ];
  const cards=[...state.voicePresets,...state.voice.profiles].map(item=>`<label class="voice-card"><input type="radio" name="voice-preset" data-voice-preset="${esc(item.id)}" ${state.voice.selectedProfile===item.id?"checked":""}><span><strong>${esc(item.name)}</strong><small>${esc(item.userPromise)}</small><code>${voiceParameterCode(item.parameters)}</code></span></label>`).join("");
  const controls=parameters.map(([key,label,short])=>`<label class="voice-control"><span>${esc(label)} <b>${short}<output data-voice-value="${key}">${profile.parameters[key]}</output></b></span><input type="range" min="1" max="5" step="1" value="${profile.parameters[key]}" data-voice-parameter="${key}"></label>`).join("");
  return `<section class="voice-settings" data-voice-settings><header><div><p class="eyebrow">Settings · Voice</p><h2>Voice</h2><p>Changes wording and progress cadence only. Tools, permissions, and evidence stay the same.</p></div><button class="secondary" id="voice-customize" type="button">Customize</button></header><div class="voice-grid">${cards}</div><details class="voice-advanced" ${custom?"open":""}><summary>Advanced controls</summary><div class="voice-form"><label>Name <input id="voice-name" maxlength="80" value="${esc(profile.name)}" ${custom?"":"disabled"}></label><label>User promise <input id="voice-promise" maxlength="180" value="${esc(profile.userPromise)}" ${custom?"":"disabled"}></label><div class="voice-sliders">${controls}</div><label>Preferred terms <input id="voice-preferred" maxlength="263" value="${esc(profile.preferredTerms.join(", "))}" placeholder="comma separated" ${custom?"":"disabled"}></label><label>Avoided terms <input id="voice-avoided" maxlength="263" value="${esc(profile.avoidedTerms.join(", "))}" placeholder="comma separated" ${custom?"":"disabled"}></label></div></details><aside class="voice-preview"><span>Live preview</span><output id="voice-preview">${esc(voicePreview(profile))}</output></aside><button class="quiet" id="voice-reset" type="button">Reset to Technical partner</button></section>`;
}

function bindVoiceSettings(){
  if(!content.querySelector("[data-voice-settings]"))return;
  content.querySelectorAll("[data-voice-preset]").forEach(el=>el.addEventListener("change",()=>{const custom=state.voice.profiles.some(item=>item.id===el.dataset.voicePreset);state.voice={selectedProfile:el.dataset.voicePreset,profiles:custom?state.voice.profiles:[]};invalidatePlan();renderComponents()}));
  $("voice-customize")?.addEventListener("click",()=>{const base=structuredClone(currentVoiceProfile());state.voice={selectedProfile:"custom",profiles:[{...base,id:"custom",name:base.id==="custom"?base.name:`Custom ${base.name}`} ]};invalidatePlan();renderComponents()});
  $("voice-reset")?.addEventListener("click",()=>{state.voice={selectedProfile:"technical-partner",profiles:[]};invalidatePlan();renderComponents()});
  if(!state.voice.profiles.some(item=>item.id===state.voice.selectedProfile))return;
  content.querySelectorAll("[data-voice-parameter]").forEach(el=>el.addEventListener("input",()=>{editableVoiceProfile().parameters[el.dataset.voiceParameter]=Number(el.value);content.querySelector(`[data-voice-value='${el.dataset.voiceParameter}']`).textContent=el.value;refreshVoicePreview()}));
  [["voice-name","name"],["voice-promise","userPromise"]].forEach(([id,key])=>$(id)?.addEventListener("input",()=>{editableVoiceProfile()[key]=$(id).value;refreshVoicePreview()}));
  [["voice-preferred","preferredTerms"],["voice-avoided","avoidedTerms"]].forEach(([id,key])=>$(id)?.addEventListener("input",()=>{editableVoiceProfile()[key]=parseVoiceTerms($(id).value);refreshVoicePreview()}));
}

function currentVoiceProfile(){return state.voice.profiles.find(item=>item.id===state.voice.selectedProfile)||state.voicePresets.find(item=>item.id===state.voice.selectedProfile)||state.voicePresets[0]||{id:"technical-partner",name:"Technical partner",userPromise:"Direct technical collaboration.",parameters:{directness:5,warmth:3,technicalDepth:5,progressCadence:1,uncertaintyDisclosure:4,correctionExplicitness:5},preferredTerms:[],avoidedTerms:[]}}
function editableVoiceProfile(){return state.voice.profiles.find(item=>item.id===state.voice.selectedProfile)}
function voicePlanInput(){return structuredClone(state.voice)}
function voiceParameterCode(p){return `D${p.directness}/W${p.warmth}/T${p.technicalDepth}/P${p.progressCadence}/U${p.uncertaintyDisclosure}/C${p.correctionExplicitness}`}
function voicePreview(profile){return `${profile.name}: ${profile.userPromise} ${voiceParameterCode(profile.parameters)}${profile.preferredTerms.length?` · Prefer ${profile.preferredTerms.join(", ")}`:""}${profile.avoidedTerms.length?` · Avoid ${profile.avoidedTerms.join(", ")}`:""}`}
function refreshVoicePreview(){const output=$("voice-preview");if(output)output.textContent=voicePreview(currentVoiceProfile());invalidatePlan()}
function parseVoiceTerms(value){return [...new Set(String(value).split(",").map(term=>term.trim()).filter(Boolean))].slice(0,8)}
async function api(action,body,method="GET"){const r=await fetch(`/threadspan/install/api/${action}`,{method,headers:{"x-threadspan-install-session":state.session,...(state.helper?{"x-threadspan-helper-token":state.helper}:{}),...(method==="POST"?{"content-type":"application/json"}:{})},body:method==="POST"?JSON.stringify(body):undefined});const value=await r.json().catch(()=>({}));if(!r.ok)throw new Error(value?.error?.message||`Installer request failed (${r.status})`);return value}
async function closeSession(intent){return api("close",{intent},"POST").catch(()=>{})}
function addEvent(title,detail){const li=document.createElement("li"),now=new Date();li.innerHTML=`<time>${now.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</time><span><strong>${esc(title)}</strong><small>${esc(detail)}</small></span>`;events.prepend(li)}
function fail(error){console.error(error);addEvent("Error",error.message||String(error));content.innerHTML=`<p class="error">${esc(error.message||String(error))}</p>`;next.disabled=true}
function fmt(n){return n>=1000?`${Math.round(n/1000)}k`:String(n)}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
