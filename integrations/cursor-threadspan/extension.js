const vscode=require("vscode");
const fs=require("node:fs/promises");
const os=require("node:os");
const path=require("node:path");
const {spawn,execFile}=require("node:child_process");
const {promisify}=require("node:util");
const {normalizeLoopbackBaseUrl,normalizeWindowsLaunch,renderState,escapeHtml}=require("./core");
const execFileAsync=promisify(execFile);

class ThreadspanView{
  constructor(){this.view=null}
  resolveWebviewView(view){this.view=view;view.webview.options={enableScripts:false,enableCommandUris:["threadspan.account.add","threadspan.account.select"],localResourceRoots:[]};view.webview.html=page("Loading Threadspan…");void this.refresh()}
  async refresh(){if(!this.view)return;try{this.view.webview.html=page(renderState(await daemonRequest("GET","/threadspan/state")))}catch(error){this.view.webview.html=page(`<p class="error">${escapeHtml(error.message||String(error))}</p><p>Start Threadspan, then run <b>Threadspan: Refresh provider state</b>.</p>`)}}
}

function activate(context){const provider=new ThreadspanView();context.subscriptions.push(vscode.window.registerWebviewViewProvider("threadspan.control",provider));context.subscriptions.push(vscode.commands.registerCommand("threadspan.refresh",()=>provider.refresh()));context.subscriptions.push(vscode.commands.registerCommand("threadspan.install",()=>launchInstaller()));context.subscriptions.push(vscode.commands.registerCommand("threadspan.account.add",async()=>{await addAccount();await provider.refresh()}));context.subscriptions.push(vscode.commands.registerCommand("threadspan.account.select",async()=>{await selectAccount();await provider.refresh()}))}

async function addAccount(){
  const [state,accountState]=await Promise.all([daemonRequest("GET","/threadspan/state"),daemonRequest("GET","/v1/accounts")]);
  const providers=(state.routeMap?.nodes||[]).map(item=>({label:item.label||item.id,value:item.id}));if(!providers.length)throw new Error("No configured providers are available");
  const provider=await vscode.window.showQuickPick(providers,{placeHolder:"Provider for this account"});if(!provider)return;
  const auth=await vscode.window.showQuickPick((accountState.descriptors||[]).map(item=>({label:item.label,description:item.instructions,value:item.authKind,instructions:item.instructions})),{placeHolder:"Provider-native authentication source"});if(!auth)return;
  await vscode.window.showInformationMessage(auth.instructions||"Complete authentication in the provider's native app or CLI. Threadspan does not collect credential values.");
  const label=await vscode.window.showInputBox({prompt:"Local account label (no email or identity data)",validateInput:value=>!value||value.includes("@")?"Use a short local label without an email address":undefined});if(!label)return;
  let authSourceRef="";if(["api-key-env","secret-file-ref"].includes(auth.value)){authSourceRef=await vscode.window.showInputBox({prompt:auth.value==="api-key-env"?"Environment variable name only (never the key value)":"Opaque secret-file reference configured in Threadspan (never the path or file contents)"})||"";if(!authSourceRef)return}
  let profileRef="";if(["native-oauth","device-login","cli-login"].includes(auth.value)){profileRef=await vscode.window.showInputBox({prompt:"Optional opaque profile ref (never a raw profile path)",ignoreFocusOut:true})||""}
  await daemonRequest("POST","/v1/accounts",{providerId:provider.value,label,authKind:auth.value,authSourceRef,profileRef});
}

async function selectAccount(){const state=await daemonRequest("GET","/v1/accounts");const choice=await vscode.window.showQuickPick((state.accounts||[]).map(item=>({label:item.label,description:`${item.providerId} · ${item.authKind}${item.active?" · active":""}`,value:item.id})),{placeHolder:"Select the provider account"});if(choice)await daemonRequest("PUT","/v1/accounts/active",{accountId:choice.value})}

async function daemonRequest(method,route,body){const config=vscode.workspace.getConfiguration("threadspan");const base=normalizeLoopbackBaseUrl(config.get("baseUrl","http://127.0.0.1:8743"));const tokenPath=expandHome(config.get("tokenFile","~/.threadspan/auth-token"));const token=(await fs.readFile(tokenPath,"utf8")).trim();const response=await fetch(`${base}${route}`,{method,headers:{authorization:`Bearer ${token}`,...(body?{"content-type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});const json=await response.json().catch(()=>({}));if(!response.ok)throw new Error(json.error?.message||`HTTP ${response.status}`);return json}

async function launchInstaller(){
  const config=vscode.workspace.getConfiguration("threadspan");let command=config.get("command","threadspan");const project=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;const args=["install","gui","--origin","cursor",...(project?["--origin-project",project]:[])];
  if(process.platform==="win32"&&!/[\\/]/.test(command)&&!path.extname(command)){const found=await execFileAsync("where.exe",[command],{windowsHide:true});command=found.stdout.split(/\r?\n/).find(Boolean)||command}
  const launch=process.platform==="win32"?normalizeWindowsLaunch(command,args,process.env):{command,args};const child=spawn(launch.command,launch.args,{detached:true,stdio:"ignore",windowsHide:true});child.once("error",error=>vscode.window.showErrorMessage(`Threadspan setup could not start: ${error.message}`));child.unref();
}

function page(body){return `<!doctype html><meta charset="utf-8"><style>:root{color-scheme:light dark}body{font:13px var(--vscode-font-family);padding:14px;color:var(--vscode-foreground)}h2{font-size:16px}ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--vscode-panel-border)}li span,.muted{color:var(--vscode-descriptionForeground)}.error{color:var(--vscode-errorForeground)}</style>${body}`}
function expandHome(value){return value.startsWith("~/")?path.join(os.homedir(),value.slice(2)):value}
module.exports={activate,deactivate(){}};
