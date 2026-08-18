import assert from "node:assert/strict";
import test from "node:test";
import { BridgeService } from "../src/bridge/service.mjs";
import { createDesktopLaunchPlan, mainWindowEvaluationExpression, renderDesktopHudScript } from "../src/desktop/host.mjs";
import { createTestConfig, silentLogger } from "./helpers.mjs";

test("desktop launch plan uses a loopback-only main-process inspector", () => {
  const plan = createDesktopLaunchPlan({ platform: "win32", executable: "C:/Program Files/OpenAI/ChatGPT.exe", inspectPort: 19324 });
  assert.equal(plan.command, "C:/Program Files/OpenAI/ChatGPT.exe");
  assert.deepEqual(plan.args, ["--inspect=127.0.0.1:19324"]);
  assert.equal(plan.options.detached, true);
  assert.equal(plan.options.stdio, "ignore");
});

test("desktop HUD is isolated, actionable, and contains no credential material", () => {
  const script = renderDesktopHudScript({
    status: "ready",
    route: { id: "consult/mock/mock-model" },
    routeMap: { nodes: [{ id: "mock" }] },
    pickerRoutes: [{ id: "consult/mock/mock-model", mode: "consult", provider: "mock", model: "mock-model", availability: "available", free: true }],
  });
  assert.match(script, /attachShadow/);
  assert.match(script, /select-route/);
  assert.match(script, /consult\/mock\/mock-model/);
  assert.doesNotMatch(script, /Bearer|authToken|secret/i);
  assert.match(mainWindowEvaluationExpression(script), /getAllWindows/);
});

test("Desktop route selection becomes the live Threadspan auto route", async () => {
  const config = createTestConfig({
    defaults: { provider: "mock", mode: "consult", model: "mock-model" },
    providers: { mock: { models: ["mock-model"] } },
  });
  const service = new BridgeService(config, { logger: silentLogger() });
  const selected = service.selectDesktopRoute({ routeId: "consult/mock/mock-model" });
  assert.equal(selected.routeId, "consult/mock/mock-model");
  const quick = service.desktopState();
  assert.ok(quick.pickerRoutes.some((route) => route.id === "consult/mock/mock-model"));
  const state = await service.threadspanState();
  assert.equal(state.desktopRouteSelection.routeId, "consult/mock/mock-model");
  assert.equal(state.route.id, "consult/mock/mock-model");
  service.selectDesktopRoute({ routeId: "delegate/mock/mock-model" });
  const explicitConsult = await service.executeResponse({ model: "consult/threadspan/auto", input: "mode authority" });
  assert.equal(explicitConsult.model, "consult/mock/mock-model");
  assert.match(explicitConsult.output_text, /^mock:consult:/);
  await service.close();
});
