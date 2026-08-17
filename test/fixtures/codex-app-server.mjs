#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 1) {
    process.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "fixture" } })}\n`);
  }
  if (message.id === 2) {
    process.stdout.write(`${JSON.stringify({ id: 2, result: { data: [{
      id: "gpt-fixture",
      model: "gpt-fixture",
      displayName: "GPT Fixture",
      description: "Fixture native model.",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "high", description: "Deep" }],
      defaultReasoningEffort: "high",
      inputModalities: ["text", "image"],
      additionalSpeedTiers: ["fast"],
      serviceTiers: [{ id: "priority", name: "Fast" }],
      isDefault: true,
    }], nextCursor: null } })}\n`);
  }
});
