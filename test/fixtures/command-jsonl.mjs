let input = "";
for await (const chunk of process.stdin) input += chunk.toString("utf8");
process.stdout.write(`${JSON.stringify({ type: "text-delta", delta: `received:${process.env.CURSOR_BRIDGE_MODE}:` })}\n`);
process.stdout.write(`${JSON.stringify({ type: "text-delta", delta: input.includes("hello") ? "yes" : "no" })}\n`);
