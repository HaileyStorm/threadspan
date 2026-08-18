import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import { callCodexAppServerBatchWithReceipt, callCodexAppServerWithReceipt } from "./app-server.mjs";
import { RequestError } from "../core/errors.mjs";

const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const ROLLOVER_GOAL_STATES = new Set(["active", "paused", "usageLimited"]);

/** Native Codex Continuity lineage, naming, and guarded rollover controller. */
export class CodexContinuityController {
  constructor(config = {}, dependencies = {}) {
    this.config = {
      enabled: config.enabled !== false,
      controlEnabled: config.controlEnabled === true,
      statePath: resolve(config.statePath ?? `${homedir()}/.threadspan/continuity-state.json`),
      maxTasks: config.maxTasks ?? 200,
      handleTtlMs: config.handleTtlMs ?? 10 * 60 * 1000,
      previewTtlMs: config.previewTtlMs ?? 2 * 60 * 1000,
      command: config.command ?? "codex",
    };
    this.environment = dependencies.environment ?? process.env;
    this.call = dependencies.call ?? callCodexAppServerWithReceipt;
    this.callBatch = dependencies.callBatch ?? callCodexAppServerBatchWithReceipt;
    this.now = dependencies.now ?? (() => Date.now());
    this.uuid = dependencies.uuid ?? randomUUID;
    this.logger = dependencies.logger;
    this.state = { schemaVersion: SCHEMA_VERSION, tasks: [], pending: null, receiptDigests: [] };
    this.handles = new Map();
    this.previews = new Map();
    this.ready = null;
    this.lock = Promise.resolve();
  }

  async initialize() {
    if (!this.config.enabled) return;
    this.ready ??= this.#withLock(async () => {
      await this.#load();
    });
    await this.ready;
  }

  async view() {
    if (!this.config.enabled) return disabledView("disabled");
    await this.initialize();
    return this.#withLock(async () => {
      const snapshot = await this.#sync();
      this.#sweepEphemeral();
      const goalRequests = snapshot.tasks.slice(0, this.config.maxTasks).map((item) => ({
        method: "thread/goal/get", params: { threadId: item.thread.id },
      }));
      let goals = [];
      if (goalRequests.length > 0) {
        const response = await this.#batch(goalRequests);
        goals = response.results;
      }
      const tasks = snapshot.tasks.map((item, index) => {
        const handle = this.#newHandle(item.task.logicalId);
        const goal = goals[index]?.goal ?? null;
        const generations = item.task.generations.map((generation, generationIndex) => ({
          index: generationIndex + 1,
          role: generation.threadId === item.task.currentThreadId ? "current" : generation.threadId === item.task.rootThreadId ? "origin" : "previous",
          label: generation.threadId === item.task.currentThreadId
            ? generation.threadId === item.task.rootThreadId ? "Origin task · Current generation" : "Current generation"
            : generation.threadId === item.task.rootThreadId ? "Origin task" : `Generation ${generationIndex + 1}`,
          archived: generation.archived === true,
          status: generation.threadId === item.task.currentThreadId ? threadStatus(item.thread) : "archived",
        }));
        return {
          handle,
          title: item.task.title,
          project: basename(String(item.thread.cwd ?? "")) || "Unknown project",
          selected: index === 0,
          current: { generation: generations.length, status: threadStatus(item.thread), goalStatus: goal?.status ?? "none" },
          generations,
          pendingRecovery: this.state.pending?.logicalId === item.task.logicalId,
          enrolled: item.task.enrolled === true,
          action: this.state.pending?.logicalId === item.task.logicalId ? "Pending" : item.task.enrolled === true ? "Rollover" : "Promote",
        };
      });
      return {
        enabled: true,
        controlEnabled: this.config.controlEnabled,
        provider: "codex",
        evidence: "native-app-server",
        presentation: "logical-task-first-current-generation-selected",
        tasks,
        capabilities: { rename: this.config.controlEnabled, rollover: this.config.controlEnabled, nativeChatListGrouping: false },
        note: "The accepted Continuity supervisor owns Goal transfer, predecessor fencing, successor acceptance, and archival. Threadspan keeps the logical lineage visible.",
      };
    });
  }

  async rename(input = {}) {
    await this.initialize();
    return this.#withLock(async () => {
      this.#assertControls();
      const task = this.#taskForHandle(input.handle);
      const name = normalizeName(input.name);
      const response = await this.#mutate("thread/setName", { threadId: task.currentThreadId, name });
      const readback = await this.#read("thread/read", { threadId: task.currentThreadId, includeTurns: false });
      if (readback.result?.thread?.name !== name) throw new Error("Codex task name read-back did not match");
      task.title = name;
      task.updatedAt = new Date(this.now()).toISOString();
      await this.#save();
      return { accepted: true, title: name, receiptDigest: receiptDigest(response.receipt) };
    });
  }

  async previewRollover(input = {}) {
    await this.initialize();
    return this.#withLock(async () => {
      this.#assertControls();
      const task = this.#taskForHandle(input.handle);
      if (this.state.pending) throw new RequestError("A Continuity rollover is already awaiting recovery");
      const evidence = await this.#rolloverEvidence(task);
      assertRolloverEvidence(evidence);
      const expiresAt = this.now() + this.config.previewTtlMs;
      const plan = {
        kind: "codex-continuity-rollover",
        logicalId: task.logicalId,
        generation: task.generations.length,
        currentThreadId: task.currentThreadId,
        threadUpdatedAt: evidence.thread.updatedAt,
        goalUpdatedAt: evidence.goal?.updatedAt ?? null,
        goalStatus: evidence.goal?.status ?? "none",
        expiresAt,
      };
      const digest = digestObject(plan);
      this.previews.set(digest, plan);
      return {
        accepted: false,
        preview: true,
        digest,
        expiresAt: new Date(expiresAt).toISOString(),
        title: task.title,
        generation: task.generations.length,
        effects: ["post one fixed control turn to this exact task", "use the installed Continuity supervisor to promote or rotate", "preserve the current objective, model/provider/effort, and Goal accounting", "leave the incumbent unchanged if any native gate fails"],
      };
    });
  }

  async rollover(input = {}) {
    await this.initialize();
    return this.#withLock(async () => {
      this.#assertControls();
      if (this.state.pending) throw new RequestError("A Continuity operation is already awaiting native recovery");
      const task = this.#taskForHandle(input.handle);
      const plan = this.previews.get(String(input.digest ?? ""));
      if (!plan || plan.logicalId !== task.logicalId || plan.expiresAt < this.now()) throw new RequestError("Rollover preview is missing or expired");
      const evidence = await this.#rolloverEvidence(task);
      assertRolloverEvidence(evidence);
      if (evidence.thread.updatedAt !== plan.threadUpdatedAt || (evidence.goal?.updatedAt ?? null) !== plan.goalUpdatedAt || (evidence.goal?.status ?? "none") !== plan.goalStatus) {
        throw new RequestError("The current task or Goal changed after preview; review a fresh rollover plan");
      }

      const operationId = this.uuid();
      const controlText = [
        `Threadspan Continuity control request ${operationId}.`,
        "At the next safe boundary, use the installed Continuity supervisor to enroll or rotate this logical task.",
        "Preserve the current objective, user choices, model/provider/effort, project ownership, and all native Goal accounting when a Goal exists.",
        "Require the accepted capsule, predecessor-stop, single-successor lease, receipt, fresh-process goal read-back, and rollback/recovery gates.",
        "Do not perform project work in the shell, do not fork full history merely to shed context, and do not edit Codex databases.",
        "If any gate is unavailable, leave the incumbent unchanged and report one concise blocker.",
      ].join(" ");
      this.state.pending = {
        operationId,
        logicalId: task.logicalId,
        predecessorThreadId: task.currentThreadId,
        previousGoalStatus: evidence.goal?.status ?? "none",
        phase: "request-journaled",
        successorThreadId: null,
        startedAt: new Date(this.now()).toISOString(),
      };
      await this.#save();
      if (threadStatus(evidence.thread) === "notLoaded") {
        await this.#mutate("thread/resume", { threadId: task.currentThreadId, excludeTurns: true });
      }
      const started = await this.#mutate("turn/start", {
        threadId: task.currentThreadId,
        input: [{ type: "text", text: controlText }],
      });
      const turnId = started.result?.turn?.id;
      if (typeof turnId !== "string" || !turnId) throw new Error("Native Continuity control turn did not return an id");
      const readback = await this.#read("thread/read", { threadId: task.currentThreadId, includeTurns: false });
      if (threadStatus(readback.result?.thread) !== "active") throw new Error("Native Continuity control turn did not become active");
      this.state.pending.phase = "supervisor-requested";
      this.state.pending.turnId = turnId;
      await this.#save();
      this.previews.delete(String(input.digest));
      return { accepted: true, operationId, title: task.title, generation: task.generations.length, state: "supervisor-requested" };
    });
  }

  async #rolloverEvidence(task) {
    const response = await this.#readBatch([
      { method: "thread/read", params: { threadId: task.currentThreadId, includeTurns: false } },
      { method: "thread/goal/get", params: { threadId: task.currentThreadId } },
    ]);
    return { thread: response.results[0]?.thread, goal: response.results[1]?.goal };
  }

  async #sync() {
    const response = await this.#readBatch([
      { method: "thread/list", params: { archived: false, limit: this.config.maxTasks, useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc" } },
      { method: "thread/list", params: { archived: true, limit: this.config.maxTasks, useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc" } },
    ]);
    const live = (response.results[0]?.data ?? []).filter((thread) => !thread.parentThreadId);
    const archived = new Map((response.results[1]?.data ?? []).map((thread) => [thread.id, thread]));
    const liveById = new Map(live.map((thread) => [thread.id, thread]));
    const knownThreads = new Set(this.state.tasks.flatMap((task) => task.generations.map((generation) => generation.threadId)));
    let changed = false;

    const pendingMatches = this.state.pending
      ? [...live, ...archived.values()].filter((thread) => {
          const source = parseContinuitySource(thread.threadSource);
          return source?.operationId === this.state.pending.operationId && source.authority === "rw" && source.role !== "controller";
        })
      : [];
    if (this.state.pending && pendingMatches.length > 1) {
      this.state.pending.phase = "ambiguous-successors";
      changed = true;
    } else if (this.state.pending && pendingMatches.length === 1) {
      const successor = pendingMatches[0];
      const task = this.state.tasks.find((item) => item.logicalId === this.state.pending.logicalId);
      if (task) {
        if (!task.generations.some((generation) => generation.threadId === successor.id)) {
          task.generations.push({ threadId: successor.id, archived: archived.has(successor.id), createdAt: secondsIso(successor.createdAt) });
          knownThreads.add(successor.id);
        }
        this.state.pending.successorThreadId = successor.id;
        this.state.pending.phase = "successor-discovered";
        changed = true;
        if (archived.has(this.state.pending.predecessorThreadId) && liveById.has(successor.id)) {
          const goals = await this.#readBatch([
            { method: "thread/goal/get", params: { threadId: this.state.pending.predecessorThreadId } },
            { method: "thread/goal/get", params: { threadId: successor.id } },
          ]);
          if (acceptedGoalTransfer(goals.results[0]?.goal, goals.results[1]?.goal, this.state.pending.previousGoalStatus)) {
            task.currentThreadId = successor.id;
            task.enrolled = true;
            task.updatedAt = secondsIso(successor.updatedAt);
            this.state.pending = null;
            changed = true;
          }
        }
      }
    }

    for (const thread of live) {
      if (knownThreads.has(thread.id) || pendingMatches.some((candidate) => candidate.id === thread.id) || this.state.tasks.length >= this.config.maxTasks) continue;
      const title = normalizeDiscoveredName(thread.name ?? thread.preview ?? "Untitled task");
      this.state.tasks.push({
        logicalId: this.uuid(), title, rootThreadId: thread.id, currentThreadId: thread.id,
        enrolled: String(thread.threadSource ?? "").startsWith("continuity:"),
        generations: [{ threadId: thread.id, archived: false, createdAt: secondsIso(thread.createdAt) }],
        createdAt: secondsIso(thread.createdAt), updatedAt: secondsIso(thread.updatedAt),
      });
      knownThreads.add(thread.id);
      changed = true;
    }
    for (const task of this.state.tasks) {
      for (const generation of task.generations) {
        const isArchived = archived.has(generation.threadId);
        if (generation.archived !== isArchived) {
          generation.archived = isArchived;
          changed = true;
        }
      }
    }
    if (changed) await this.#save();
    return {
      tasks: this.state.tasks.map((task) => ({ task, thread: liveById.get(task.currentThreadId) })).filter((item) => item.thread)
        .sort((left, right) => taskPriority(right.thread) - taskPriority(left.thread)),
    };
  }

  async #read(method, params) { return this.call(method, params, this.#callOptions()); }
  async #readBatch(requests) { return this.callBatch(requests, this.#callOptions()); }
  async #batch(requests) { return this.callBatch(requests, this.#callOptions()); }
  async #mutate(method, params) {
    const response = await this.call(method, params, this.#callOptions());
    const digest = receiptDigest(response.receipt);
    this.state.receiptDigests = [...this.state.receiptDigests, digest].slice(-64);
    return response;
  }

  #callOptions() { return { command: this.config.command, environment: this.environment, timeoutMs: 30_000 }; }
  #assertControls() { if (!this.config.controlEnabled) throw new RequestError("Continuity controls are disabled"); }
  #taskForHandle(handle) {
    this.#sweepEphemeral();
    const record = this.handles.get(String(handle ?? ""));
    if (!record) throw new RequestError("Continuity task handle is missing or expired");
    const task = this.state.tasks.find((item) => item.logicalId === record.logicalId);
    if (!task) throw new RequestError("Continuity task is no longer available");
    return task;
  }
  #newHandle(logicalId) {
    const handle = this.uuid();
    this.handles.set(handle, { logicalId, expiresAt: this.now() + this.config.handleTtlMs });
    return handle;
  }
  #sweepEphemeral() {
    const now = this.now();
    for (const [key, value] of this.handles) if (value.expiresAt < now) this.handles.delete(key);
    for (const [key, value] of this.previews) if (value.expiresAt < now) this.previews.delete(key);
  }

  async #load() {
    try {
      await assertSafeStateAncestors(this.config.statePath);
      const info = await lstat(this.config.statePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Continuity state must be a regular file");
      if (info.size > MAX_STATE_BYTES) throw new Error("Continuity state exceeds the size limit");
      await chmod(this.config.statePath, 0o600);
      const value = JSON.parse(await readFile(this.config.statePath, "utf8"));
      if (value?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.tasks) || !Array.isArray(value.receiptDigests)) throw new Error("Continuity state schema is invalid");
      this.state = value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  async #save() {
    const parent = dirname(this.config.statePath);
    await assertSafeStateAncestors(this.config.statePath, { allowMissingParent: true });
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await assertSafeStateAncestors(this.config.statePath);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Continuity state parent must be a regular directory");
    const temporary = `${this.config.statePath}.tmp-${process.pid}-${this.uuid()}`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, this.config.statePath);
  }
  #withLock(operation) {
    const run = this.lock.then(operation, operation);
    this.lock = run.catch(() => undefined);
    return run;
  }
}

function assertRolloverEvidence(evidence) {
  if (!evidence.thread) throw new RequestError("Current native task evidence is required");
  const status = threadStatus(evidence.thread);
  if (!["idle", "notLoaded"].includes(status)) throw new RequestError("Rollover requires the current task to be idle");
  if (evidence.goal && !ROLLOVER_GOAL_STATES.has(evidence.goal.status)) throw new RequestError(`Goal status '${evidence.goal.status}' cannot roll over`);
}
function normalizeName(value) {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (!name || name.length > 120) throw new RequestError("Task name must contain 1 through 120 visible characters");
  return name;
}
function normalizeDiscoveredName(value) { return normalizeName(String(value ?? "Untitled task").slice(0, 120)); }
function threadStatus(thread) { return String(thread?.status?.type ?? "unknown"); }
function taskPriority(thread) { return (threadStatus(thread) === "active" ? 1_000_000_000_000 : 0) + Number(thread.recencyAt ?? thread.updatedAt ?? 0); }
function secondsIso(value) { return new Date(Number(value ?? 0) * 1000).toISOString(); }
function digestObject(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function receiptDigest(receipt) { return digestObject(receipt ?? null); }
function disabledView(reason) { return { enabled: false, controlEnabled: false, provider: "codex", evidence: "unavailable", tasks: [], capabilities: { rename: false, rollover: false, nativeChatListGrouping: false }, reason }; }

function parseContinuitySource(value) {
  const match = /^continuity:([^:]+):([^:]+):(ro|rw)$/u.exec(String(value ?? ""));
  return match ? { role: match[1], operationId: match[2], authority: match[3] } : null;
}

function acceptedGoalTransfer(predecessor, successor, previousStatus) {
  const predecessorInactive = !predecessor || predecessor.status !== "active";
  if (!predecessorInactive) return false;
  if (previousStatus === "none") return !successor;
  if (!successor) return false;
  if (previousStatus === "usageLimited") return ["active", "usageLimited"].includes(successor.status);
  return successor.status === previousStatus;
}

async function assertSafeStateAncestors(path, options = {}) {
  let cursor = dirname(path);
  const root = parse(resolve(cursor)).root;
  while (cursor && cursor !== root) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Continuity state path contains an unsafe ancestor");
    } catch (error) {
      if (error?.code === "ENOENT" && options.allowMissingParent) {
        cursor = dirname(cursor);
        continue;
      }
      throw error;
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}
