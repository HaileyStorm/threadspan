#!/usr/bin/env node

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 1024 * 1024) process.exit(0);
  chunks.push(chunk);
}

try {
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const model = compact(input.model?.display_name ?? input.model?.id ?? input.model ?? "Claude");
  const usage = input.context_window?.used_percentage ?? input.contextWindow?.usedPercentage;
  const context = Number.isFinite(Number(usage)) ? ` · ${Math.round(Number(usage))}% ctx` : "";
  process.stdout.write(`Threadspan Preview · ${model}${context}`);
} catch {
  process.stdout.write("Threadspan Preview");
}

function compact(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length <= 32 ? text : `${text.slice(0, 29)}...`;
}
