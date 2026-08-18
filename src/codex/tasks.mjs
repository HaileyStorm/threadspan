import { callCodexAppServer } from "./app-server.mjs";

export async function listCodexTaskGroups(options = {}) {
  const result = await callCodexAppServer("thread/list", {
    archived: false,
    limit: options.limit ?? 200,
    useStateDbOnly: true,
  }, options);
  const groups = new Map();
  let notLoaded = 0;
  let total = 0;
  for (const thread of result?.data ?? []) {
    total += 1;
    const status = thread?.status?.type ?? "unknown";
    if (status === "notLoaded") notLoaded += 1;
    if (status !== "active") continue;
    const project = String(thread.cwd ?? "Unknown project");
    if (!groups.has(project)) groups.set(project, []);
    groups.get(project).push({
      id: thread.id,
      name: thread.name ?? String(thread.preview ?? "Active task").slice(0, 120),
      status,
      activeFlags: thread.status?.activeFlags ?? [],
      source: thread.source,
      defaultDisposition: "wait",
    });
  }
  const grouped = [...groups.entries()].map(([project, tasks]) => ({ project, tasks, defaultDisposition: "wait" }));
  return { groups: grouped, evidence: { total, active: grouped.reduce((sum, group) => sum + group.tasks.length, 0), notLoaded, trusted: notLoaded === 0 } };
}
