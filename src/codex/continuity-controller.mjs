import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  callCodexAppServerBatchWithReceipt,
  callCodexAppServerWithReceipt,
  validateCodexAppServerReceipt,
} from "./app-server.mjs";
import { RequestError } from "../core/errors.mjs";

const SCHEMA_VERSION = 2;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const CLAIM_RETRIES = 25;
const CLAIM_RETRY_MS = 4;
const MAX_RECEIPTS = 64;
const MAX_COMPLETED_OPERATIONS = 32;
const ROLLOVER_GOAL_STATES = new Set(["active", "paused", "usageLimited"]);
const INACTIVE_THREAD_STATES = new Set(["idle", "notLoaded"]);
const PENDING_PHASES = new Set(["request-journaled", "dispatch-indeterminate", "supervisor-requested", "successor-discovered", "ambiguous-successors", "predecessor-not-stopped", "predecessor-goal-retained", "goal-evidence-unsupported", "goal-parity-mismatch", "migration-recovery-required", "late-duplicate-successor"]);
const RECEIPT_PHASES = new Set(["view", "rename", "action-delivery", "preview", "pre-dispatch", "dispatch", "reconciliation"]);
const ACCOUNTING_FIELDS = new Set(["tokensUsed", "timeUsedSeconds", "tokenBudget", "timeBudgetSeconds", "elapsedTimeSeconds", "inputTokens", "outputTokens"]);
const GOAL_FIELDS = new Set(["threadId", "objective", "status", "createdAt", "updatedAt", ...ACCOUNTING_FIELDS]);
const PUBLIC_ACTIONS = new Set(["Promote", "Rollover", "Pending", "Unsupported"]);

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
    this.host = dependencies.host ?? hostname();
    this.processId = dependencies.processId ?? process.pid;
    this.ownerId = dependencies.ownerId ?? randomUUID();
    this.logger = dependencies.logger;
    this.state = emptyState();
    this.loadedDigest = null;
    this.handles = new Map();
    this.operationHandles = new Map();
    this.previews = new Map();
    this.ready = null;
    this.lock = Promise.resolve();
  }

  async initialize() {
    if (!this.config.enabled) return;
    this.ready ??= this.#withLock(() => this.#load());
    await this.ready;
  }

  async view() {
    if (!this.config.enabled) return disabledView("disabled");
    await this.initialize();
    return this.#withClaim(async () => {
      const snapshot = await this.#sync();
      this.#sweepEphemeral();
      const goalRequests = snapshot.tasks.slice(0, this.config.maxTasks).map((item) => ({
        method: "thread/goal/get", params: { threadId: item.thread.id },
      }));
      let goals = [];
      if (goalRequests.length > 0) {
        const response = await this.#batch(goalRequests, "view");
        goals = response.results;
      }
      const goalEvidence = goals.map(goalResult);
      const unsupported = goalEvidence.some((goal) => goal.support === "unsupported");
      const controlsAvailable = this.config.controlEnabled && !this.state.pending && !unsupported;
      const tasks = snapshot.tasks.map((item, index) => {
        const handle = this.#newHandle(item.task.logicalId);
        const goal = goalEvidence[index] ?? { support: "unsupported", goal: null };
        const generations = item.task.generations.map((generation, generationIndex) => ({
          index: generationIndex + 1,
          role: generation.threadId === item.task.currentThreadId ? "current"
            : generation.threadId === item.task.rootThreadId ? "origin"
              : generation.prepared === true ? "prepared" : "previous",
          label: generation.threadId === item.task.currentThreadId
            ? generation.threadId === item.task.rootThreadId ? "Origin task · Current generation" : "Current generation"
            : generation.threadId === item.task.rootThreadId ? "Origin task" : `Generation ${generationIndex + 1}`,
          archived: generation.archived === true,
          status: generation.threadId === item.task.currentThreadId ? threadStatus(item.thread)
            : generation.prepared === true ? "prepared" : "archived",
        }));
        const pending = this.state.pending?.logicalId === item.task.logicalId ? this.state.pending : null;
        const action = pending ? "Pending" : goal.support === "unsupported" ? "Unsupported" : item.task.enrolled ? "Rollover" : "Promote";
        return {
          handle,
          title: item.task.title,
          project: basename(String(item.thread.cwd ?? "")) || "Unknown project",
          selected: index === 0,
          current: {
            generation: generations.length,
            status: threadStatus(item.thread),
            goalStatus: goal.support === "unsupported" ? "unsupported" : goal.goal?.status ?? "none",
          },
          generations,
          pendingRecovery: pending ? publicRecovery(pending, this.#newOperationHandle(pending.operationId)) : false,
          enrolled: item.task.enrolled === true,
          controlsAvailable: controlsAvailable && !pending,
          action,
        };
      });
      await this.#save();
      return projectContinuityPublicView({
        enabled: true,
        controlEnabled: controlsAvailable,
        provider: "codex",
        evidence: "validated-native-app-server-receipts",
        presentation: "logical-task-first-current-generation-selected",
        tasks,
        capabilities: {
          rename: controlsAvailable,
          rollover: controlsAvailable,
          nativeChatListGrouping: false,
        },
        note: this.state.pending
          ? "Recovery is explicit and non-replayable until native predecessor, successor, Goal, and receipt gates all reconcile."
          : unsupported
            ? "Native Goal evidence is unsupported or ambiguous; controls remain unavailable."
            : "The accepted Continuity supervisor owns Goal transfer, predecessor fencing, successor acceptance, and archival.",
      });
    });
  }

  async rename(input = {}) {
    await this.initialize();
    return this.#withClaim(async () => {
      this.#assertControls();
      if (this.state.pending) throw new RequestError("Continuity controls are unavailable while recovery is pending");
      const task = this.#taskForHandle(input.handle);
      const name = normalizeName(input.name);
      await this.#mutate("thread/setName", { threadId: task.currentThreadId, name }, "rename");
      const readback = await this.#read("thread/read", { threadId: task.currentThreadId, includeTurns: false }, "rename");
      if (readback.result?.thread?.name !== name) throw new Error("Codex task name read-back did not match");
      task.title = name;
      task.updatedAt = isoNow(this.now());
      await this.#save();
      return { accepted: true, title: name };
    });
  }

  /** Deliver one owner-authorized action completion to the exact idle native Codex task. */
  async deliverActionItem(entry = {}) {
    await this.initialize();
    return this.#withClaim(async () => {
      this.#assertControls();
      if (entry.ownerRef !== "codex-thread") return { supported: false };
      const threadId = nativeActionOwnerId(entry.nativeId);
      const handle = actionItemHandle(entry.handle);
      const note = actionItemNote(entry.note);
      const evidence = await this.#read("thread/read", { threadId, includeTurns: false }, "action-delivery");
      const thread = evidence.result?.thread;
      if (!thread) throw new RequestError("Action-item owner is no longer available");
      const status = threadStatus(thread);
      if (status === "active") throw new RequestError("Action-item owner is active; completion delivery remains queued");
      if (!["idle", "notLoaded"].includes(status)) throw new RequestError("Action-item owner is not ready for completion delivery");
      if (status === "notLoaded") await this.#mutate("thread/resume", { threadId, excludeTurns: true }, "action-delivery");
      const input = [
        `Threadspan action ${handle} was completed by the owner.`,
        note ? `Owner note: ${note}` : "No completion note was supplied.",
        "Resume only the bounded work this completion unblocks. Do not create an acknowledgement action item or wake an unrelated task.",
      ].join(" ");
      const started = await this.#mutate("turn/start", { threadId, input: [{ type: "text", text: input }] }, "action-delivery");
      const turnId = started.result?.turn?.id;
      if (typeof turnId !== "string" || !turnId) throw new Error("Native action completion turn did not return an id");
      await this.#save();
      return { supported: true, deliveryRef: `codex-turn:${digestObject(turnId).slice(0, 32)}` };
    });
  }

  async previewRollover(input = {}) {
    await this.initialize();
    return this.#withClaim(async () => {
      this.#assertControls();
      const task = this.#taskForHandle(input.handle);
      if (this.state.pending) throw new RequestError("A Continuity rollover is already awaiting recovery");
      const evidence = await this.#rolloverEvidence(task, "preview");
      assertRolloverEvidence(evidence);
      const expiresAt = this.now() + this.config.previewTtlMs;
      const plan = {
        kind: "codex-continuity-rollover",
        logicalId: task.logicalId,
        generation: task.generations.length,
        currentThreadId: task.currentThreadId,
        threadUpdatedAt: evidence.thread.updatedAt,
        goalBinding: captureGoalBinding(evidence.goal),
        receiptEvidence: evidence.receipts,
        observedAt: isoNow(this.now()),
        expiresAt,
      };
      const digest = digestObject(plan);
      this.previews.set(digest, plan);
      trimMap(this.previews, 64);
      await this.#save();
      return {
        accepted: false,
        preview: true,
        digest,
        expiresAt: new Date(expiresAt).toISOString(),
        title: task.title,
        generation: task.generations.length,
        effects: [
          "post one fixed control turn to this exact task",
          "use the installed Continuity supervisor to promote or rotate",
          "preserve objective, status, accounting, source authority, and stable recovery identity",
          "leave the incumbent unchanged and require manual reconciliation if native dispatch becomes uncertain",
        ],
      };
    });
  }

  async rollover(input = {}) {
    await this.initialize();
    return this.#withClaim(async () => {
      this.#assertControls();
      if (this.state.pending) throw new RequestError("A Continuity operation is already awaiting native recovery");
      const task = this.#taskForHandle(input.handle);
      const plan = this.previews.get(String(input.digest ?? ""));
      if (!plan || plan.logicalId !== task.logicalId || plan.expiresAt < this.now()) throw new RequestError("Rollover preview is missing or expired");
      const evidence = await this.#rolloverEvidence(task, "pre-dispatch");
      assertRolloverEvidence(evidence);
      const currentGoalBinding = captureGoalBinding(evidence.goal);
      if (evidence.thread.updatedAt !== plan.threadUpdatedAt || !sameGoalBinding(currentGoalBinding, plan.goalBinding)) {
        throw new RequestError("The current task or Goal changed after preview; review a fresh rollover plan");
      }

      const operationId = randomStableId(this.uuid);
      const recoveryKey = randomStableId(this.uuid);
      const operationHandle = this.#newOperationHandle(operationId);
      const controlText = [
        `Threadspan Continuity control request ${operationId}.`,
        `Stable recovery key ${recoveryKey}.`,
        "At the next safe boundary, use the installed Continuity supervisor to enroll or rotate this logical task.",
        "Preserve the current objective, user choices, model/provider/effort, project ownership, and all native Goal accounting when a Goal exists.",
        "Require quiet/no-user-input gates, predecessor stop, exactly one continuity:worker successor with rw authority, and fresh native read-back.",
        "Do not perform project work in the shell, fork full history merely to shed context, edit Codex databases, or replay an uncertain request.",
        "If any gate is unavailable, leave the incumbent unchanged and report one concise blocker.",
      ].join(" ");
      this.state.pending = {
        operationId,
        recoveryKey,
        logicalId: task.logicalId,
        logicalGeneration: task.generations.length,
        predecessor: {
          threadId: task.currentThreadId,
          updatedAt: evidence.thread.updatedAt,
          status: threadStatus(evidence.thread),
        },
        preview: {
          digest: String(input.digest),
          observedAt: plan.observedAt,
          threadUpdatedAt: plan.threadUpdatedAt,
        },
        goalBinding: plan.goalBinding,
        successor: null,
        phase: "request-journaled",
        blocker: "Native supervisor dispatch has not been confirmed.",
        action: "Do not replay; reconcile the exact native operation.",
        dispatch: { status: "journaled", turnId: null },
        evidence: { preview: plan.receiptEvidence.slice(-8), dispatch: [], reconciliation: [] },
        startedAt: isoNow(this.now()),
        updatedAt: isoNow(this.now()),
      };
      await this.#save();
      try {
        // Persist uncertainty before the first native effect. A process crash,
        // timeout, or malformed reply can therefore never leave replayable state.
        this.state.pending.phase = "dispatch-indeterminate";
        this.state.pending.blocker = "Native dispatch is in flight and its exact result is not yet proven.";
        this.state.pending.action = "Do not replay; wait for source-bound receipt and native reconciliation.";
        this.state.pending.dispatch.status = "indeterminate";
        this.state.pending.updatedAt = isoNow(this.now());
        await this.#save();
        if (threadStatus(evidence.thread) === "notLoaded") {
          await this.#mutate("thread/resume", { threadId: task.currentThreadId, excludeTurns: true }, "dispatch");
        }
        const started = await this.#mutate("turn/start", {
          threadId: task.currentThreadId,
          input: [{ type: "text", text: controlText }],
        }, "dispatch");
        const turnId = started.result?.turn?.id;
        if (typeof turnId !== "string" || !turnId) throw new Error("Native Continuity control turn did not return an id");
        const readback = await this.#read("thread/read", { threadId: task.currentThreadId, includeTurns: false }, "dispatch");
        if (threadStatus(readback.result?.thread) !== "active") throw new Error("Native Continuity control turn did not become active");
        this.state.pending.phase = "supervisor-requested";
        this.state.pending.blocker = "Waiting for one exact worker successor and native read-back gates.";
        this.state.pending.action = "Recheck native state; never resend the control request.";
        this.state.pending.dispatch = { status: "confirmed", turnId };
        this.state.pending.updatedAt = isoNow(this.now());
        await this.#save();
      } catch (error) {
        this.state.pending.phase = "dispatch-indeterminate";
        this.state.pending.blocker = "Native dispatch may have occurred but its exact result is not proven.";
        this.state.pending.action = "Manual recovery must reconcile this operation; automatic replay is forbidden.";
        this.state.pending.dispatch.status = "indeterminate";
        this.state.pending.updatedAt = isoNow(this.now());
        await this.#save();
        throw new RequestError("Continuity dispatch is indeterminate and requires recovery; the request will not be replayed", { cause: error });
      }
      this.previews.delete(String(input.digest));
      return { accepted: true, operationHandle, title: task.title, generation: task.generations.length, state: "supervisor-requested" };
    });
  }

  async #rolloverEvidence(task, phase) {
    const response = await this.#readBatch([
      { method: "thread/read", params: { threadId: task.currentThreadId, includeTurns: false } },
      { method: "thread/goal/get", params: { threadId: task.currentThreadId } },
    ], phase);
    const goalEvidence = goalResult(response.results[1]);
    return {
      thread: response.results[0]?.thread,
      goal: goalEvidence.goal,
      goalSupport: goalEvidence.support,
      receipts: [response.evidence],
    };
  }

  async #sync() {
    const response = await this.#readBatch([
      { method: "thread/list", params: { archived: false, limit: this.config.maxTasks, useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc" } },
      { method: "thread/list", params: { archived: true, limit: this.config.maxTasks, useStateDbOnly: true, sortKey: "updated_at", sortDirection: "desc" } },
    ], "reconciliation");
    const live = (response.results[0]?.data ?? []).filter((thread) => !thread.parentThreadId);
    const archivedItems = (response.results[1]?.data ?? []).filter((thread) => !thread.parentThreadId);
    const archived = new Map(archivedItems.map((thread) => [thread.id, thread]));
    const liveById = new Map(live.map((thread) => [thread.id, thread]));
    const allThreads = [...live, ...archivedItems];
    const knownThreads = new Set(this.state.tasks.flatMap((task) => task.generations.map((generation) => generation.threadId)));

    if (!this.state.pending) this.#detectLateDuplicate(allThreads);
    const pendingMatches = this.state.pending
      ? allThreads.filter((thread) => {
          const source = parseContinuitySource(thread.threadSource);
          return source?.operationId === this.state.pending.operationId && source.role === "worker" && source.authority === "rw";
        })
      : [];
    if (this.state.pending && pendingMatches.length > 1) {
      this.#setRecovery("ambiguous-successors", "More than one exact worker/rw successor exists for this operation.", "Stop integration and resolve duplicate native successors manually.");
    } else if (this.state.pending && pendingMatches.length === 1) {
      const successor = pendingMatches[0];
      const task = this.state.tasks.find((item) => item.logicalId === this.state.pending.logicalId);
      if (task) {
        let generation = task.generations.find((item) => item.threadId === successor.id);
        if (!generation) {
          generation = { threadId: successor.id, archived: archived.has(successor.id), prepared: true, createdAt: secondsIso(successor.createdAt) };
          task.generations.push(generation);
          knownThreads.add(successor.id);
        }
        this.state.pending.successor = {
          threadId: successor.id,
          source: { role: "worker", authority: "rw" },
          discoveredAt: isoNow(this.now()),
        };
        const predecessorArchived = archived.has(this.state.pending.predecessor.threadId);
        const successorLive = liveById.has(successor.id);
        if (!predecessorArchived || !successorLive) {
          this.#setRecovery("successor-discovered", "Waiting for exact predecessor archive evidence and a live successor.", "Recheck native state without replaying dispatch.");
        } else {
          const reconciliation = await this.#readBatch([
            { method: "thread/read", params: { threadId: this.state.pending.predecessor.threadId, includeTurns: false } },
            { method: "thread/goal/get", params: { threadId: this.state.pending.predecessor.threadId } },
            { method: "thread/goal/get", params: { threadId: successor.id } },
          ], "reconciliation");
          const predecessor = reconciliation.results[0]?.thread;
          const predecessorGoal = goalResult(reconciliation.results[1]);
          const successorGoal = goalResult(reconciliation.results[2]);
          const gate = reconcileGates({
            predecessor,
            predecessorArchived,
            successor,
            successorLive,
            predecessorGoal,
            successorGoal,
            expectedGoal: this.state.pending.goalBinding,
          });
          if (!gate.accepted) {
            this.#setRecovery(gate.phase, gate.blocker, gate.action);
          } else {
            generation.prepared = false;
            task.currentThreadId = successor.id;
            task.enrolled = true;
            task.updatedAt = secondsIso(successor.updatedAt);
            this.state.completedOperations.push({
              operationId: this.state.pending.operationId,
              recoveryKey: this.state.pending.recoveryKey,
              logicalId: this.state.pending.logicalId,
              predecessorThreadId: this.state.pending.predecessor.threadId,
              successorThreadId: successor.id,
              goalBinding: this.state.pending.goalBinding,
              completedAt: isoNow(this.now()),
            });
            this.state.completedOperations = this.state.completedOperations.slice(-MAX_COMPLETED_OPERATIONS);
            this.state.pending = null;
          }
        }
      }
    }

    for (const thread of live) {
      if (knownThreads.has(thread.id) || pendingMatches.some((candidate) => candidate.id === thread.id) || this.state.tasks.length >= this.config.maxTasks) continue;
      const unmatchedSource = parseContinuitySource(thread.threadSource);
      // A worker/rw thread without retained exact lineage is quarantined rather
      // than laundered into a new logical task. This preserves late-duplicate
      // safety even after bounded completed-operation detail ages out.
      if (unmatchedSource?.role === "worker" && unmatchedSource.authority === "rw") continue;
      const title = normalizeDiscoveredName(thread.name ?? thread.preview ?? "Untitled task");
      this.state.tasks.push({
        logicalId: randomStableId(this.uuid),
        title,
        rootThreadId: thread.id,
        currentThreadId: thread.id,
        enrolled: String(thread.threadSource ?? "").startsWith("continuity:"),
        generations: [{ threadId: thread.id, archived: false, prepared: false, createdAt: secondsIso(thread.createdAt) }],
        createdAt: secondsIso(thread.createdAt),
        updatedAt: secondsIso(thread.updatedAt),
      });
      knownThreads.add(thread.id);
    }
    for (const task of this.state.tasks) {
      for (const generation of task.generations) generation.archived = archived.has(generation.threadId);
    }
    await this.#save();
    return {
      tasks: this.state.tasks.map((task) => ({
        task,
        thread: liveById.get(task.currentThreadId)
          ?? (this.state.pending?.logicalId === task.logicalId ? archived.get(task.currentThreadId) : null),
      })).filter((item) => item.thread)
        .sort((left, right) => taskPriority(right.thread) - taskPriority(left.thread)),
    };
  }

  #detectLateDuplicate(threads) {
    for (const completed of this.state.completedOperations) {
      const matches = threads.filter((thread) => {
        const source = parseContinuitySource(thread.threadSource);
        return source?.operationId === completed.operationId && source.role === "worker" && source.authority === "rw";
      });
      if (matches.length <= 1) continue;
      this.state.pending = {
        operationId: completed.operationId,
        recoveryKey: completed.recoveryKey,
        logicalId: completed.logicalId,
        logicalGeneration: Math.max(1, (this.state.tasks.find((task) => task.logicalId === completed.logicalId)?.generations.findIndex((generation) => generation.threadId === completed.predecessorThreadId) ?? 0) + 1),
        predecessor: { threadId: completed.predecessorThreadId, updatedAt: null, status: "unknown" },
        preview: { digest: null, observedAt: null, threadUpdatedAt: null },
        goalBinding: completed.goalBinding,
        successor: { threadId: completed.successorThreadId, source: { role: "worker", authority: "rw" }, discoveredAt: completed.completedAt },
        phase: "late-duplicate-successor",
        blocker: "A duplicate exact worker/rw successor appeared after prior acceptance.",
        action: "Stop integration and resolve duplicate native successors manually.",
        dispatch: { status: "confirmed", turnId: null },
        evidence: { preview: [], dispatch: [], reconciliation: [] },
        startedAt: completed.completedAt,
        updatedAt: isoNow(this.now()),
      };
      return;
    }
  }

  #setRecovery(phase, blocker, action) {
    this.state.pending.phase = phase;
    this.state.pending.blocker = blocker;
    this.state.pending.action = action;
    this.state.pending.updatedAt = isoNow(this.now());
  }

  async #read(method, params, phase) { return this.#validatedCall([{ method, params }], false, phase); }
  async #readBatch(requests, phase) { return this.#validatedCall(requests, true, phase); }
  async #batch(requests, phase) { return this.#validatedCall(requests, true, phase); }
  async #mutate(method, params, phase) { return this.#validatedCall([{ method, params }], false, phase); }

  async #validatedCall(requests, batch, phase) {
    const methods = requests.map((request) => request.method);
    const response = batch
      ? await this.callBatch(requests, this.#callOptions())
      : await this.call(requests[0].method, requests[0].params, this.#callOptions());
    const results = batch ? response.results : [response.result];
    const evidence = validateCodexAppServerReceipt(response.receipt, {
      methods,
      results,
      sourceBindingDigest: this.state.sourceBindingDigest,
      now: this.now(),
      maximumDurationMs: 60_000,
    });
    validateRequestedResults(requests, results);
    this.state.sourceBindingDigest ??= evidence.sourceBindingDigest;
    const record = {
      phase: boundedPrivateLabel(phase, 40),
      methods,
      receiptDigest: evidence.receiptDigest,
      receiptId: evidence.receiptId,
      requestDigest: digestObject(requests),
      bindingDigest: "",
      completedAt: evidence.completedAt,
    };
    record.bindingDigest = digestObject({ methods: record.methods, receiptDigest: record.receiptDigest, receiptId: record.receiptId, requestDigest: record.requestDigest });
    this.state.provenance.receipts.push(record);
    this.state.provenance.receipts = this.state.provenance.receipts.slice(-MAX_RECEIPTS);
    if (this.state.pending && Object.hasOwn(this.state.pending.evidence, phase)) {
      this.state.pending.evidence[phase].push(record);
      this.state.pending.evidence[phase] = this.state.pending.evidence[phase].slice(-16);
    }
    return batch ? { ...response, evidence: record } : { ...response, evidence: record };
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
    const handle = opaqueHandle("ctask", this.uuid);
    this.handles.set(handle, { logicalId, expiresAt: this.now() + this.config.handleTtlMs });
    trimMap(this.handles, Math.max(32, this.config.maxTasks * 4));
    return handle;
  }
  #newOperationHandle(operationId) {
    const known = [...this.operationHandles].find(([, value]) => value.operationId === operationId && value.expiresAt >= this.now());
    if (known) return known[0];
    const handle = opaqueHandle("cop", this.uuid);
    this.operationHandles.set(handle, { operationId, expiresAt: this.now() + this.config.handleTtlMs });
    trimMap(this.operationHandles, 64);
    return handle;
  }
  #sweepEphemeral() {
    const now = this.now();
    for (const [key, value] of this.handles) if (value.expiresAt < now) this.handles.delete(key);
    for (const [key, value] of this.operationHandles) if (value.expiresAt < now) this.operationHandles.delete(key);
    for (const [key, value] of this.previews) if (value.expiresAt < now) this.previews.delete(key);
  }

  async #load() {
    try {
      await assertSafeStateAncestors(this.config.statePath);
      const info = await lstat(this.config.statePath);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Continuity state must be a regular file");
      if (info.size > MAX_STATE_BYTES) throw new Error("Continuity state exceeds the size limit");
      await chmod(this.config.statePath, 0o600);
      const raw = await readFile(this.config.statePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = parsed?.schemaVersion === 1 ? migrateV1State(parsed, this.uuid, this.now) : validateState(parsed);
      this.loadedDigest = digestText(raw);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      this.state = emptyState();
      this.loadedDigest = null;
    }
  }

  async #save() {
    const parent = dirname(this.config.statePath);
    await assertSafeStateAncestors(this.config.statePath, { allowMissingParent: true });
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await assertSafeStateAncestors(this.config.statePath);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Continuity state parent must be a regular directory");
    const currentDigest = await readDigestIfPresent(this.config.statePath);
    if (currentDigest !== this.loadedDigest) throw stateConflict();
    this.state.revision += 1;
    validateState(this.state);
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporary = `${this.config.statePath}.tmp-${this.processId}-${randomStableId(this.uuid)}`;
    try {
      await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
      if (await readDigestIfPresent(this.config.statePath) !== this.loadedDigest) throw stateConflict();
      await rename(temporary, this.config.statePath);
      this.loadedDigest = digestText(serialized);
    } catch (error) {
      await unlink(temporary).catch((cleanupError) => { if (cleanupError?.code !== "ENOENT") this.logger?.warn?.("continuity-temp-cleanup-failed", { message: cleanupError.message }); });
      throw error;
    }
  }

  #withLock(operation) {
    const run = this.lock.then(operation, operation);
    this.lock = run.catch(() => undefined);
    return run;
  }

  #withClaim(operation) {
    return this.#withLock(async () => {
      const claim = await this.#acquireClaim();
      try {
        await this.#load();
        return await operation();
      } finally {
        await this.#releaseClaim(claim);
      }
    });
  }

  async #acquireClaim() {
    const claimPath = `${this.config.statePath}.claim`;
    await assertSafeStateAncestors(this.config.statePath, { allowMissingParent: true });
    await mkdir(dirname(this.config.statePath), { recursive: true, mode: 0o700 });
    await assertSafeStateAncestors(this.config.statePath);
    const claim = {
      schemaVersion: 1,
      kind: "threadspan-continuity-state-claim",
      claimId: randomStableId(this.uuid),
      ownerId: this.ownerId,
      processId: this.processId,
      host: this.host,
      createdAt: isoNow(this.now()),
    };
    for (let attempt = 0; attempt < CLAIM_RETRIES; attempt += 1) {
      let handle;
      try {
        handle = await open(claimPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(claim)}\n`);
        await handle.close();
        return { path: claimPath, claim };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (error?.code !== "EEXIST") throw error;
        if (attempt < CLAIM_RETRIES - 1) {
          await delay(CLAIM_RETRY_MS);
          continue;
        }
        await readClaimForReview(claimPath);
        throw new RequestError("Continuity mutation claim is unavailable; inspect the private claim file for exact owner/process/host evidence");
      }
    }
    throw new RequestError("Continuity mutation claim is unavailable");
  }

  async #releaseClaim(record) {
    let existing;
    try { existing = JSON.parse(await readFile(record.path, "utf8")); }
    catch (error) {
      if (error?.code === "ENOENT") throw new Error("Continuity mutation claim disappeared before exact-owner release");
      throw error;
    }
    if (existing?.claimId !== record.claim.claimId || existing?.ownerId !== this.ownerId
      || existing?.processId !== this.processId || existing?.host !== this.host) {
      throw new Error("Refusing to release a different Continuity mutation claim");
    }
    await unlink(record.path);
  }
}

function assertRolloverEvidence(evidence) {
  if (!evidence.thread) throw new RequestError("Current native task evidence is required");
  const status = threadStatus(evidence.thread);
  if (!["idle", "notLoaded"].includes(status)) throw new RequestError("Rollover requires the current task to be idle");
  if (evidence.goalSupport !== "supported") throw new RequestError("Native Goal evidence is unsupported; rollover is unavailable");
  if (evidence.goal && !ROLLOVER_GOAL_STATES.has(evidence.goal.status)) throw new RequestError(`Goal status '${evidence.goal.status}' cannot roll over`);
  if (evidence.goal) assertCompleteGoalBinding(captureGoalBinding(evidence.goal));
}

function reconcileGates(input) {
  if (!input.predecessorArchived || !input.successorLive) return recoveryGate("successor-discovered", "Archive/live evidence is incomplete.");
  if (!input.predecessor || !INACTIVE_THREAD_STATES.has(threadStatus(input.predecessor))) return recoveryGate("predecessor-not-stopped", "The exact predecessor is not proven in a recognized inactive state.");
  if (input.predecessorGoal.support !== "supported" || input.successorGoal.support !== "supported") {
    return recoveryGate("goal-evidence-unsupported", "Native Goal read-back is unsupported or ambiguous.");
  }
  const expected = input.expectedGoal;
  if (expected.presence === "absent") {
    if (input.predecessorGoal.goal || input.successorGoal.goal) return recoveryGate("goal-parity-mismatch", "A Goal appeared during a goal-free rollover.");
    return { accepted: true };
  }
  if (!input.successorGoal.goal) return recoveryGate("goal-parity-mismatch", "The exact successor has no transferred Goal.");
  if (input.predecessorGoal.goal) return recoveryGate("predecessor-goal-retained", "The predecessor still retains a native Goal binding.");
  const successor = captureGoalBinding(input.successorGoal.goal);
  try { assertCompleteGoalBinding(successor); } catch { return recoveryGate("goal-evidence-unsupported", "Successor Goal objective, identity, or accounting evidence is incomplete."); }
  if (!goalParity(expected, successor)) return recoveryGate("goal-parity-mismatch", "Successor Goal objective, status, identity, or accounting does not match.");
  return { accepted: true };
}

function recoveryGate(phase, blocker) {
  return { accepted: false, phase, blocker, action: "Recheck exact native evidence without replaying the control request." };
}

function goalResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "goal")) return { support: "unsupported", goal: null };
  if (value.goal !== null && (typeof value.goal !== "object" || Array.isArray(value.goal))) return { support: "unsupported", goal: null };
  return { support: "supported", goal: value.goal };
}

function captureGoalBinding(goal) {
  if (!goal) return { presence: "absent", status: "none", identityDigest: null, identitySupport: "not-applicable", objectiveDigest: null, objectiveSupport: "not-applicable", accountingDigest: null, accountingSupport: "not-applicable" };
  const objectiveValue = typeof goal.objective === "string" ? goal.objective : null;
  const createdAt = typeof goal.createdAt === "string" || Number.isFinite(goal.createdAt) ? goal.createdAt : null;
  const identityValue = objectiveValue !== null && createdAt !== null ? { createdAt, objectiveDigest: digestObject(objectiveValue) } : null;
  const unknownFields = Object.keys(goal).filter((key) => !GOAL_FIELDS.has(key));
  const accounting = {};
  for (const [key, value] of Object.entries(goal)) {
    if (!ACCOUNTING_FIELDS.has(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value) || value === null) accounting[key] = value;
  }
  return {
    presence: "present",
    status: String(goal.status ?? "unknown"),
    identityDigest: identityValue ? digestObject(identityValue) : null,
    identitySupport: identityValue ? "supported" : "unsupported",
    objectiveDigest: objectiveValue !== null ? digestObject(objectiveValue) : null,
    objectiveSupport: objectiveValue !== null ? "supported" : "unsupported",
    accountingDigest: Object.keys(accounting).length > 0 ? digestObject(accounting) : null,
    accountingSupport: unknownFields.length === 0 && Object.keys(accounting).length > 0 ? "supported" : "unsupported",
  };
}

function assertCompleteGoalBinding(binding) {
  if (binding.presence !== "present") return;
  if (binding.identitySupport !== "supported" || binding.objectiveSupport !== "supported" || binding.accountingSupport !== "supported") {
    throw new RequestError("Native Goal identity, objective, or accounting evidence is unsupported; rollover is unavailable");
  }
}

function sameGoalBinding(left, right) { return stableStringify(left) === stableStringify(right); }
function goalParity(expected, successor) {
  return expected.presence === successor.presence
    && expected.status === successor.status
    && expected.objectiveDigest === successor.objectiveDigest
    && expected.accountingDigest === successor.accountingDigest
    && (expected.identitySupport !== "supported" || expected.identityDigest === successor.identityDigest);
}

function publicRecovery(pending, operationHandle) {
  const phase = boundedPublicText(pending.phase, 80) || "recovery-required";
  const successorState = ["ambiguous-successors", "late-duplicate-successor"].includes(phase) ? "ambiguous"
    : pending.successor ? "exact-worker-rw" : "pending";
  const predecessorState = phase === "predecessor-not-stopped" || phase === "predecessor-goal-retained" ? "not-stopped"
    : pending.successor ? "awaiting-read-back" : "pending";
  const goalState = phase === "goal-parity-mismatch" ? "mismatch" : phase === "goal-evidence-unsupported" ? "unsupported"
    : pending.successor ? "awaiting-parity" : "pending";
  return {
    active: true,
    operationHandle,
    phase,
    blocker: boundedPublicText(pending.blocker, 180),
    action: boundedPublicText(pending.action, 160),
    authority: {
      lifecycle: "supervisor-owned",
      dispatch: pending.dispatch.status,
      successor: successorState,
      predecessor: predecessorState,
      goal: goalState,
      receipts: "source-bound-private",
    },
  };
}

/** Closed, identifier-free projection for the public HTTP/UI boundary. */
export function projectContinuityPublicView(raw) {
  if (!raw || raw.enabled !== true) return disabledView(boundedPublicText(raw?.reason, 160) || "disabled");
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.slice(0, 200).map(projectPublicTask).filter(Boolean) : [];
  return {
    enabled: true,
    controlEnabled: raw.controlEnabled === true,
    provider: raw.provider === "codex" ? "codex" : "unknown",
    evidence: boundedPublicText(raw.evidence, 80) || "unavailable",
    presentation: boundedPublicText(raw.presentation, 80),
    tasks,
    capabilities: {
      rename: raw.controlEnabled === true && raw.capabilities?.rename === true,
      rollover: raw.controlEnabled === true && raw.capabilities?.rollover === true,
      nativeChatListGrouping: raw.capabilities?.nativeChatListGrouping === true,
    },
    note: boundedPublicText(raw.note, 320),
  };
}

/** Closed projection for Continuity mutation responses. */
export function projectContinuityPublicResult(raw, kind) {
  if (!raw || typeof raw !== "object") return { accepted: false };
  if (kind === "rename") return { accepted: raw.accepted === true, title: boundedPublicText(raw.title, 120) };
  if (kind === "preview") return {
    accepted: false,
    preview: raw.preview === true,
    digest: /^[0-9a-f]{64}$/u.test(String(raw.digest ?? "")) ? raw.digest : "",
    expiresAt: validIso(raw.expiresAt),
    title: boundedPublicText(raw.title, 120),
    generation: positivePublicInteger(raw.generation),
    effects: Array.isArray(raw.effects) ? raw.effects.slice(0, 8).map((item) => boundedPublicText(item, 180)).filter(Boolean) : [],
  };
  return {
    accepted: raw.accepted === true,
    operationHandle: validOpaqueHandle(raw.operationHandle, "cop") ? raw.operationHandle : "",
    title: boundedPublicText(raw.title, 120),
    generation: positivePublicInteger(raw.generation),
    state: ["supervisor-requested", "dispatch-indeterminate", "recovery-required"].includes(raw.state) ? raw.state : "recovery-required",
  };
}

function projectPublicTask(task) {
  if (!task || !validOpaqueHandle(task.handle, "ctask")) return null;
  const recovery = task.pendingRecovery && typeof task.pendingRecovery === "object" ? projectPublicRecovery(task.pendingRecovery) : false;
  const generations = Array.isArray(task.generations) ? task.generations.slice(0, 128).map((generation) => ({
    index: positivePublicInteger(generation?.index),
    role: ["origin", "current", "previous", "prepared"].includes(generation?.role) ? generation.role : "previous",
    label: boundedPublicText(generation?.label, 120),
    archived: generation?.archived === true,
    status: boundedPublicText(generation?.status, 40) || "unknown",
  })) : [];
  return {
    handle: task.handle,
    title: boundedPublicText(task.title, 120) || "Untitled task",
    project: boundedPublicText(task.project, 120) || "Unknown project",
    selected: task.selected === true,
    enrolled: task.enrolled === true,
    controlsAvailable: task.controlsAvailable === true && !recovery,
    action: PUBLIC_ACTIONS.has(task.action) ? task.action : "Unsupported",
    current: {
      generation: positivePublicInteger(task.current?.generation),
      status: boundedPublicText(task.current?.status, 40) || "unknown",
      goalStatus: boundedPublicText(task.current?.goalStatus, 40) || "unsupported",
    },
    generations,
    pendingRecovery: recovery,
  };
}

function projectPublicRecovery(value) {
  if (value?.active !== true || !validOpaqueHandle(value.operationHandle, "cop")) return false;
  const authority = value.authority ?? {};
  return {
    active: true,
    operationHandle: value.operationHandle,
    phase: boundedPublicText(value.phase, 80),
    blocker: boundedPublicText(value.blocker, 180),
    action: boundedPublicText(value.action, 160),
    authority: {
      lifecycle: authority.lifecycle === "supervisor-owned" ? "supervisor-owned" : "unsupported",
      dispatch: ["journaled", "confirmed", "indeterminate"].includes(authority.dispatch) ? authority.dispatch : "unsupported",
      successor: ["pending", "exact-worker-rw", "ambiguous"].includes(authority.successor) ? authority.successor : "unsupported",
      predecessor: ["pending", "awaiting-read-back", "not-stopped", "stopped"].includes(authority.predecessor) ? authority.predecessor : "unsupported",
      goal: ["pending", "awaiting-parity", "mismatch", "unsupported", "parity"].includes(authority.goal) ? authority.goal : "unsupported",
      receipts: authority.receipts === "source-bound-private" ? "source-bound-private" : "unsupported",
    },
  };
}

function validateState(value) {
  assertClosedObject(value, ["schemaVersion", "revision", "sourceBindingDigest", "tasks", "pending", "completedOperations", "provenance"], "Continuity state");
  if (value.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error("Continuity state schema is invalid");
  if (value.sourceBindingDigest !== null && !hexDigest(value.sourceBindingDigest)) throw new Error("Continuity source binding is invalid");
  if (!Array.isArray(value.tasks) || value.tasks.length > 200 || !Array.isArray(value.completedOperations) || value.completedOperations.length > MAX_COMPLETED_OPERATIONS) throw new Error("Continuity state collections are invalid");
  assertClosedObject(value.provenance, ["migratedFrom", "legacyReceiptDigests", "receipts"], "Continuity provenance");
  if (!Array.isArray(value.provenance.legacyReceiptDigests) || !Array.isArray(value.provenance.receipts)) throw new Error("Continuity provenance is invalid");
  for (const task of value.tasks) validateTask(task);
  if (value.pending !== null) validatePending(value.pending);
  for (const operation of value.completedOperations) validateCompleted(operation);
  for (const digest of value.provenance.legacyReceiptDigests) if (!hexDigest(digest)) throw new Error("Continuity legacy receipt digest is invalid");
  for (const receipt of value.provenance.receipts) validateReceiptRecord(receipt);
  const logicalIds = value.tasks.map((task) => task.logicalId);
  if (new Set(logicalIds).size !== logicalIds.length) throw new Error("Continuity logical task identities are not unique");
  if (value.pending && !logicalIds.includes(value.pending.logicalId)) throw new Error("Continuity pending operation has no exact logical task");
  if (value.pending) {
    const task = value.tasks.find((candidate) => candidate.logicalId === value.pending.logicalId);
    const generationIds = task.generations.map((generation) => generation.threadId);
    const predecessorGeneration = generationIds.indexOf(value.pending.predecessor.threadId) + 1;
    if (!generationIds.includes(value.pending.predecessor.threadId)
      || value.pending.logicalGeneration !== predecessorGeneration
      || (value.pending.phase !== "late-duplicate-successor" && value.pending.predecessor.threadId !== task.currentThreadId)
      || (value.pending.successor && !generationIds.includes(value.pending.successor.threadId))) {
      throw new Error("Continuity pending operation does not match its logical lineage");
    }
  }
  for (const operation of value.completedOperations) {
    const task = value.tasks.find((candidate) => candidate.logicalId === operation.logicalId);
    const generationIds = task?.generations.map((generation) => generation.threadId) ?? [];
    if (!task || !generationIds.includes(operation.predecessorThreadId) || !generationIds.includes(operation.successorThreadId)) throw new Error("Continuity completed operation does not match its logical lineage");
  }
  return value;
}

function validateTask(task) {
  assertClosedObject(task, ["logicalId", "title", "rootThreadId", "currentThreadId", "enrolled", "generations", "createdAt", "updatedAt"], "Continuity task");
  if (!privateId(task.logicalId) || !privateId(task.rootThreadId) || !privateId(task.currentThreadId) || typeof task.title !== "string" || typeof task.enrolled !== "boolean" || !Array.isArray(task.generations) || task.generations.length === 0 || task.generations.length > 128) throw new Error("Continuity task is invalid");
  for (const generation of task.generations) {
    assertClosedObject(generation, ["threadId", "archived", "prepared", "createdAt"], "Continuity generation");
    if (!privateId(generation.threadId) || typeof generation.archived !== "boolean" || typeof generation.prepared !== "boolean" || !validIso(generation.createdAt)) throw new Error("Continuity generation is invalid");
  }
  const generationIds = task.generations.map((generation) => generation.threadId);
  if (new Set(generationIds).size !== generationIds.length || !generationIds.includes(task.rootThreadId) || !generationIds.includes(task.currentThreadId)) throw new Error("Continuity task lineage is inconsistent");
}

function validatePending(pending) {
  assertClosedObject(pending, ["operationId", "recoveryKey", "logicalId", "logicalGeneration", "predecessor", "preview", "goalBinding", "successor", "phase", "blocker", "action", "dispatch", "evidence", "startedAt", "updatedAt"], "Continuity pending operation");
  if (!privateId(pending.operationId) || !privateId(pending.recoveryKey) || !privateId(pending.logicalId) || !Number.isSafeInteger(pending.logicalGeneration) || pending.logicalGeneration < 1 || !validIso(pending.startedAt) || !validIso(pending.updatedAt)) throw new Error("Continuity pending identity is invalid");
  assertClosedObject(pending.predecessor, ["threadId", "updatedAt", "status"], "Continuity predecessor");
  assertClosedObject(pending.preview, ["digest", "observedAt", "threadUpdatedAt"], "Continuity preview");
  assertClosedObject(pending.dispatch, ["status", "turnId"], "Continuity dispatch");
  assertClosedObject(pending.evidence, ["preview", "dispatch", "reconciliation"], "Continuity evidence");
  validateGoalBinding(pending.goalBinding);
  if (!PENDING_PHASES.has(pending.phase) || !["journaled", "confirmed", "indeterminate"].includes(pending.dispatch.status)) throw new Error("Continuity pending phase or dispatch is invalid");
  if (!["idle", "notLoaded", "unknown"].includes(pending.predecessor.status)) throw new Error("Continuity predecessor status is invalid");
  if (pending.dispatch.turnId !== null && !privateId(pending.dispatch.turnId)) throw new Error("Continuity pending turn identity is invalid");
  for (const records of Object.values(pending.evidence)) {
    if (!Array.isArray(records) || records.length > 16) throw new Error("Continuity phase evidence is invalid");
    for (const record of records) validateReceiptRecord(record);
  }
  if (pending.successor !== null) {
    assertClosedObject(pending.successor, ["threadId", "source", "discoveredAt"], "Continuity successor");
    assertClosedObject(pending.successor.source, ["role", "authority"], "Continuity successor source");
    if (!privateId(pending.successor.threadId) || pending.successor.source.role !== "worker" || pending.successor.source.authority !== "rw") throw new Error("Continuity successor is invalid");
  }
}

function validateCompleted(operation) {
  assertClosedObject(operation, ["operationId", "recoveryKey", "logicalId", "predecessorThreadId", "successorThreadId", "goalBinding", "completedAt"], "Continuity completed operation");
  if (![operation.operationId, operation.recoveryKey, operation.logicalId, operation.predecessorThreadId, operation.successorThreadId].every(privateId) || !validIso(operation.completedAt)) throw new Error("Continuity completed operation is invalid");
  validateGoalBinding(operation.goalBinding);
}

function validateGoalBinding(binding) {
  assertClosedObject(binding, ["presence", "status", "identityDigest", "identitySupport", "objectiveDigest", "objectiveSupport", "accountingDigest", "accountingSupport"], "Continuity Goal binding");
  if (!["present", "absent"].includes(binding.presence)) throw new Error("Continuity Goal binding is invalid");
  for (const key of ["identityDigest", "objectiveDigest", "accountingDigest"]) if (binding[key] !== null && !hexDigest(binding[key])) throw new Error("Continuity Goal digest is invalid");
  const supports = [binding.identitySupport, binding.objectiveSupport, binding.accountingSupport];
  if (binding.presence === "absent" && supports.some((value) => value !== "not-applicable")) throw new Error("Goal-free Continuity support markers are inconsistent");
  if (binding.presence === "present" && supports.some((value) => !["supported", "unsupported"].includes(value))) throw new Error("Continuity Goal support markers are invalid");
}

function validateReceiptRecord(record) {
  assertClosedObject(record, ["phase", "methods", "receiptDigest", "receiptId", "requestDigest", "bindingDigest", "completedAt"], "Continuity receipt evidence");
  if (!RECEIPT_PHASES.has(record.phase) || !Array.isArray(record.methods) || record.methods.length === 0 || record.methods.some((method) => typeof method !== "string" || !method) || !hexDigest(record.receiptDigest) || !hexDigest(record.receiptId) || !hexDigest(record.requestDigest) || !hexDigest(record.bindingDigest) || !validIso(record.completedAt)) throw new Error("Continuity receipt evidence is invalid");
  if (record.bindingDigest !== digestObject({ methods: record.methods, receiptDigest: record.receiptDigest, receiptId: record.receiptId, requestDigest: record.requestDigest })) throw new Error("Continuity receipt request binding is invalid");
}

function migrateV1State(value, uuid, now) {
  assertClosedObject(value, ["schemaVersion", "tasks", "pending", "receiptDigests"], "Legacy Continuity state");
  if (!Array.isArray(value.tasks) || !Array.isArray(value.receiptDigests)) throw new Error("Legacy Continuity state is invalid");
  const tasks = value.tasks.map((task) => ({
    logicalId: privateId(task.logicalId) ? task.logicalId : randomStableId(uuid),
    title: normalizeDiscoveredName(task.title),
    rootThreadId: requirePrivateId(task.rootThreadId),
    currentThreadId: requirePrivateId(task.currentThreadId),
    enrolled: task.enrolled === true,
    generations: Array.isArray(task.generations) ? task.generations.map((generation) => ({
      threadId: requirePrivateId(generation.threadId),
      archived: generation.archived === true,
      prepared: false,
      createdAt: validIso(generation.createdAt) || new Date(0).toISOString(),
    })) : [],
    createdAt: validIso(task.createdAt) || new Date(0).toISOString(),
    updatedAt: validIso(task.updatedAt) || new Date(0).toISOString(),
  }));
  const state = emptyState();
  state.tasks = tasks;
  state.provenance.migratedFrom = 1;
  state.provenance.legacyReceiptDigests = value.receiptDigests.filter(hexDigest).slice(-MAX_RECEIPTS);
  if (value.pending) {
    const task = tasks.find((item) => item.logicalId === value.pending.logicalId);
    const predecessorThreadId = requirePrivateId(value.pending.predecessorThreadId);
    const predecessorGeneration = (task?.generations.findIndex((generation) => generation.threadId === predecessorThreadId) ?? -1) + 1;
    const legacySuccessorId = value.pending.successorThreadId ? requirePrivateId(value.pending.successorThreadId) : null;
    if (task && legacySuccessorId && !task.generations.some((generation) => generation.threadId === legacySuccessorId)) {
      task.generations.push({
        threadId: legacySuccessorId,
        archived: false,
        prepared: true,
        createdAt: validIso(value.pending.startedAt) || isoNow(now()),
      });
    }
    state.pending = {
      operationId: privateId(value.pending.operationId) ? value.pending.operationId : randomStableId(uuid),
      recoveryKey: randomStableId(uuid),
      logicalId: task?.logicalId ?? randomStableId(uuid),
      logicalGeneration: Math.max(1, predecessorGeneration),
      predecessor: { threadId: predecessorThreadId, updatedAt: null, status: "unknown" },
      preview: { digest: null, observedAt: null, threadUpdatedAt: null },
      goalBinding: legacyGoalBinding(value.pending.previousGoalStatus),
      successor: legacySuccessorId ? { threadId: legacySuccessorId, source: { role: "worker", authority: "rw" }, discoveredAt: validIso(value.pending.startedAt) || isoNow(now()) } : null,
      phase: "migration-recovery-required",
      blocker: "Legacy state lacks validated phase receipts and exact Goal parity evidence.",
      action: "Manual reconciliation is required; automatic replay is forbidden.",
      dispatch: { status: "indeterminate", turnId: null },
      evidence: { preview: [], dispatch: [], reconciliation: [] },
      startedAt: validIso(value.pending.startedAt) || isoNow(now()),
      updatedAt: isoNow(now()),
    };
  }
  return validateState(state);
}

function legacyGoalBinding(status) {
  if (!status || status === "none") return captureGoalBinding(null);
  return { presence: "present", status: String(status), identityDigest: null, identitySupport: "unsupported", objectiveDigest: null, objectiveSupport: "unsupported", accountingDigest: null, accountingSupport: "unsupported" };
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, sourceBindingDigest: null, tasks: [], pending: null, completedOperations: [], provenance: { migratedFrom: null, legacyReceiptDigests: [], receipts: [] } };
}

function normalizeName(value) {
  const name = String(value ?? "").trim().replace(/[\u0000-\u001f\u007f]/gu, "");
  if (!name || name.length > 120) throw new RequestError("Task name must contain 1 through 120 visible characters");
  return name;
}
function normalizeDiscoveredName(value) { return normalizeName(String(value ?? "Untitled task").slice(0, 120)); }
function threadStatus(thread) { return String(thread?.status?.type ?? "unknown"); }
function taskPriority(thread) { return (threadStatus(thread) === "active" ? 1_000_000_000_000 : 0) + Number(thread.recencyAt ?? thread.updatedAt ?? 0); }
function secondsIso(value) { return new Date(Number(value ?? 0) * 1000).toISOString(); }
function isoNow(value) { return new Date(typeof value === "function" ? value() : value).toISOString(); }
function digestObject(value) { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function digestText(value) { return createHash("sha256").update(value).digest("hex"); }
function hexDigest(value) { return /^[0-9a-f]{64}$/u.test(String(value ?? "")); }
function disabledView(reason) { return { enabled: false, controlEnabled: false, provider: "codex", evidence: "unavailable", tasks: [], capabilities: { rename: false, rollover: false, nativeChatListGrouping: false }, reason }; }
function stateConflict() { const error = new Error("Continuity state changed outside the exact process-shared claim; CAS refused"); error.code = "CONTINUITY_STATE_CONFLICT"; return error; }

function parseContinuitySource(value) {
  const match = /^continuity:([^:]+):([^:]+):(ro|rw)$/u.exec(String(value ?? ""));
  return match ? { role: match[1], operationId: match[2], authority: match[3] } : null;
}

function nativeActionOwnerId(value) {
  const id = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/u.test(id)) throw new RequestError("Action-item owner identifier is invalid");
  return id;
}
function actionItemHandle(value) { const handle = String(value ?? ""); if (!/^act_[0-9a-f]{32}$/u.test(handle)) throw new RequestError("Action-item handle is invalid"); return handle; }
function actionItemNote(value) { if (value === null || value === undefined) return ""; if (typeof value !== "string" || value.length > 500 || /[\u0000-\u001f\u007f]/u.test(value)) throw new RequestError("Action-item note is invalid"); return value; }

async function assertSafeStateAncestors(path, options = {}) {
  let cursor = dirname(path);
  const root = parse(resolve(cursor)).root;
  while (cursor && cursor !== root) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Continuity state path contains an unsafe ancestor");
    } catch (error) {
      if (error?.code === "ENOENT" && options.allowMissingParent) { cursor = dirname(cursor); continue; }
      throw error;
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
}

async function readDigestIfPresent(path) {
  try { return digestText(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function readClaimForReview(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("claim metadata is unsafe");
    const value = JSON.parse(await readFile(path, "utf8"));
    return { ownerId: boundedPrivateLabel(value.ownerId, 80) || "unknown", processId: Number.isSafeInteger(value.processId) ? value.processId : "unknown", host: boundedPrivateLabel(value.host, 120) || "unknown" };
  } catch {
    return { ownerId: "unknown", processId: "unknown", host: "unknown" };
  }
}

function assertClosedObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`${label} contains invalid fields`);
}
function privateId(value) { return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value); }
function requirePrivateId(value) { if (!privateId(value)) throw new Error("Continuity private identifier is invalid"); return value; }
function randomStableId(uuid) { const value = String(uuid()); return privateId(value) ? value : randomUUID(); }
function opaqueHandle(prefix, uuid) { return `${prefix}_${digestObject(`${randomStableId(uuid)}:${randomUUID()}`).slice(0, 40)}`; }
function validOpaqueHandle(value, prefix) { return new RegExp(`^${prefix}_[0-9a-f]{40}$`, "u").test(String(value ?? "")); }
function boundedPrivateLabel(value, maximum) { const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, maximum); return text; }
function boundedPublicText(value, maximum) { return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, maximum) : ""; }
function positivePublicInteger(value) { return Number.isSafeInteger(value) && value > 0 ? value : 1; }
function validIso(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : ""; }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`; return JSON.stringify(value) ?? "undefined"; }
function trimMap(map, maximum) { while (map.size > maximum) map.delete(map.keys().next().value); }

function validateRequestedResults(requests, results) {
  requests.forEach((request, index) => {
    const expectedThreadId = request.params?.threadId;
    const result = results[index];
    if (request.method === "thread/read" && result?.thread?.id !== expectedThreadId) throw new Error("Codex App Server thread/read returned the wrong exact task");
    if (request.method === "thread/goal/get" && Object.hasOwn(result ?? {}, "goal") && result.goal !== null && result.goal?.threadId !== expectedThreadId) throw new Error("Codex App Server Goal read returned the wrong exact task");
    if (request.method === "thread/resume" && result?.thread && result.thread.id !== expectedThreadId) throw new Error("Codex App Server thread/resume returned the wrong exact task");
  });
}
