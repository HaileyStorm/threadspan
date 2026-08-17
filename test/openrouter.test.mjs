import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { OpenRouterProvider } from "../src/providers/openrouter.mjs";
import { silentLogger } from "./helpers.mjs";

test("OpenRouter discovers live models, marks free routes, and reads credits", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [
        { id: "paid/model", pricing: { prompt: "0.1", completion: "0.2" } },
        { id: "free/model:free", pricing: { prompt: "0", completion: "0" } },
      ] }));
      return;
    }
    response.end(JSON.stringify({ data: { total_credits: 10, total_usage: 3.5 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider = new OpenRouterProvider("openrouter", {
    adapter: "openrouter",
    baseUrl,
    creditsUrl: `${baseUrl}/credits`,
    apiKey: "test-key",
    model: "auto",
    discoverModels: true,
    capabilities: ["consult", "integrated"],
  }, { logger: silentLogger() });

  const models = await provider.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].free, false);
  assert.equal(models[1].free, true);
  assert.deepEqual(await provider.readAccountUsage(), {
    available: true,
    totalCredits: 10,
    totalUsage: 3.5,
    remainingCredits: 6.5,
  });
  assert.ok(requests.every((request) => request.authorization === "Bearer test-key"));
});
