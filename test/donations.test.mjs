import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { closeHttpServer, createHttpServer, listenHttpServer } from "../src/bridge/http-server.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bitcoin = "1K628QLEh3sS8sEdzZfvuqqHRecVckSgaJ";
const cardano = "addr1q9fd05jktgv49094z8hvjp6cqvn7npt8hfzjna4dvhezmvpgl92x5cevqghl4ng0we2es4xjp59gvm3nttdzwf9ym6lqr3628x";
const ethereum = "0x78b6adac22415568A7F725a865206ccFd1a82F4c";
const vastRecipient = "HaileyCollet@gmail.com";

async function read(relative) {
  return readFile(join(root, relative), "utf8");
}

test("public donation copy contains the exact destinations and safety boundaries", async () => {
  const [readme, guide] = await Promise.all([read("README.md"), read("docs/DONATIONS.md")]);
  for (const copy of [readme, guide]) {
    for (const destination of [bitcoin, cardano, ethereum, vastRecipient]) assert.match(copy, new RegExp(destination));
    assert.match(copy, /https:\/\/buymeacoffee\.com\/threadspan/i);
    assert.doesNotMatch(copy, /Buy Me a Coffee[\s\S]*setup (?:is )?pending/i);
    assert.match(copy, /irreversible/i);
  }
  assert.match(guide, /https:\/\/docs\.vast\.ai\/guides\/reference\/billing/);
  assert.match(guide, /https:\/\/docs\.vast\.ai\/cli\/reference\/transfer-credit/);
  assert.match(guide, /provider-native balance or low-credit emails/i);
  assert.match(guide, /maintainer-only local monitor/i);
  assert.match(guide, /No donation monitor exists today/i);
  for (const boundary of ["donation telemetry", "popups", "nags", "auto-polling", "provider keys", "account setup", "automatic transfers"]) {
    assert.match(guide, new RegExp(boundary, "i"));
  }
});

test("installer donation card is local, quiet, and shown once near the stable-update start", async () => {
  const [html, css, js] = await Promise.all([read("ui/install.html"), read("ui/install.css"), read("ui/install.js")]);
  assert.match(html, /<template id="donation-card-template">/);
  assert.match(html, /<details>/);
  assert.doesNotMatch(html, /<details\s+open/);
  assert.match(html, /data-dismiss-donation/);
  for (const destination of [bitcoin, cardano, ethereum, vastRecipient]) assert.match(html, new RegExp(destination));
  assert.match(html, /QR codes and full details/);
  assert.match(html, /chess and Mamba research/);
  assert.match(html, /Maestro Continuum/);
  assert.match(html, /Support never changes access, routing, or provider priority/);
  assert.match(css, /\.donation-card/);
  assert.match(js, /if\(update\.status!=="relaunching"&&state\.bootstrap\.donation\?\.show\)showDonationCardOnce\(\)/);
  assert.match(js, /if\(state\.donationShown\)return/);
  assert.match(js, /state\.donationShown=true/);
  assert.doesNotMatch(js.slice(js.indexOf("function showDonationCardOnce"), js.indexOf("next.addEventListener")), /fetch\(|setInterval\(/);
  assert.doesNotMatch(html, /<dialog[^>]+donat/i);
  assert.match(await read("docs/DONATIONS.md"), /once per installer session[\s\S]*reload[\s\S]*staged updater relaunch/i);
});

test("README carries the human donation framing exactly once without route preference", async () => {
  const readme = await read("README.md");
  assert.equal((readme.match(/Donations help sustain Hailey's hands-on AI work/g) ?? []).length, 1);
  for (const phrase of [
    "past chess and Mamba-model work",
    "Maestro Continuum",
    "Palimpsest",
    "Loom/ScaFOLD",
    "Qwen3.8-27B abliteration/efficient-reasoning model",
    "other tools",
  ]) assert.ok(readme.includes(phrase), `README should mention ${phrase}`);
  assert.match(readme, /never privilege or discourage any model, provider, or host route/);
});

test("QR assets ship locally and donation support does not enter runtime or installer components", async () => {
  for (const asset of ["donate-btc.svg", "donate-cardano.svg", "donate-ethereum.svg"]) {
    const info = await stat(join(root, "ui", "assets", asset));
    assert.ok(info.isFile());
    assert.ok(info.size > 0);
  }
  for (const file of ["ui/index.html", "ui/threadspan.js", "ui/adapt-state.js", "src/installer/components.mjs"]) {
    assert.doesNotMatch(await read(file), /donat(?:e|ion)|buy me a coffee|HaileyCollet/i, `${file} must not contain donation support`);
  }
});

test("daemon serves the one-time installer UI only while an installation session is active",async(t)=>{let executed=false;const session={state:"launched"},installerGui={sessions:new Map([["nonce",session]]),authorize(nonce){if(nonce!=="nonce")throw new Error("missing");return session},plan(){executed=true;return{}}};const config={server:{host:"127.0.0.1",port:0,allowUnauthenticatedLoopback:true,maxConcurrentRequests:1,requestTimeoutMs:5000}};const server=createHttpServer({},config,{installerGui});t.after(()=>closeHttpServer(server));const bound=await listenHttpServer(server,{host:"127.0.0.1",port:0}),base=`http://127.0.0.1:${bound.port}`,url=`${base}/threadspan/install/`;const active=await fetch(url);assert.equal(active.status,200);assert.match(await active.text(),/donation-card-template/);session.state="complete";const completed=await fetch(url);assert.equal(completed.status,404);assert.doesNotMatch(await completed.text(),/HaileyCollet|donation-card-template/);const reopened=await fetch(`${base}/threadspan/install/api/plan`,{method:"POST",headers:{"content-type":"application/json","x-threadspan-install-session":"nonce"},body:"{}"});assert.equal(reopened.status,410);assert.equal(executed,false)});
