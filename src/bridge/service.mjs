import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyModePolicy } from "../core/policies.mjs";
import { asBridgeError, ProviderError, RequestError } from "../core/errors.mjs";
import { createId, createTraceId } from "../core/ids.mjs";
import { normalizeConsultInput, normalizeResponsesInput, toBridgeResponsesInput } from "../core/input-normalizer.mjs";
import { KeyedSerialQueue } from "../core/keyed-serial-queue.mjs";
import { Logger } from "../core/logger.mjs";
import { boundedRedactedJson } from "../core/redact.mjs";
import { SessionStore } from "../core/session-store.mjs";
import { ProviderRegistry } from "../providers/registry.mjs";
import { CODEX_NATIVE_USAGE_LIMIT_KIND } from "../providers/codex-worker.mjs";
import { UsageLedger } from "../core/usage-ledger.mjs";
import { AccountStore, UNKNOWN_ACCOUNT_ID } from "../core/account-store.mjs";
import { DesktopCompatibilityWatch } from "../maintenance/desktop-update.mjs";
import { ResponsesAssembler } from "./responses.mjs";
import { listHostSurfaces } from "../core/host-surfaces.mjs";
import { MaximumUtilizationController, needsDisabledMaximumUtilizationRecovery } from "../core/maximum-utilization-controller.mjs";
import { MaximumUtilizationJournal } from "../core/maximum-utilization-journal.mjs";
import { CodexNativeQuotaAdapter } from "../core/codex-native-quota.mjs";
import { selectTip, tipById } from "../core/tips.mjs";
import { renderVoiceInstruction, resolveVoiceProfile } from "../core/voice-profiles.mjs";
import { applyIntentBriefUpdates, deriveIntentBrief } from "../core/intent-brief.mjs";
import { CodexContinuityController } from "../codex/continuity-controller.mjs";
import { AutomaticTakeoverController } from "../core/automatic-takeover-controller.mjs";
import { naturalizeCopy } from "../core/copy-naturalizer.mjs";
import { checkCopy, describeCopyCheck, sanitizeCopyCheckRecord } from "../core/copy-check.mjs";
import { reviewReleaseCopy } from "../core/release-copy-review.mjs";
import { ActionItemStore } from "../core/action-items.mjs";

const TIP_CONVERSATION_TTL_MS = 30 * 60 * 1000;
const TIP_CONVERSATION_LIMIT = 16;

/**
 * Core bridge orchestrator shared by HTTP, MCP, and CLI surfaces.
 */
export class BridgeService {
  /**
   * @param {Record<string, any>} config Validated bridge configuration.
   * @param {{logger?: Logger, registry?: ProviderRegistry, sessions?: SessionStore, accountStore?: AccountStore, actionItemStore?: ActionItemStore, actionItemDeliveryAdapter?: Function|{deliver: Function}, continuityController?: CodexContinuityController, automaticTakeoverController?: AutomaticTakeoverController, maximumUtilizationController?: any, maximumUtilizationCapabilities?: Record<string, Function>, maximumUtilizationJournal?: MaximumUtilizationJournal}} [dependencies] Injectable dependencies.
   */
  constructor(config, dependencies = {}) {
    this.config = config;
    this.copyCheckEffects = dependencies.copyCheckEffects ?? {};
    this.copyCheckRecords = [];
    this.logger = dependencies.logger ?? new Logger({ level: config.logging?.level ?? "info" });
    this.sessions = dependencies.sessions ?? new SessionStore(config.sessions);
    this.usageLedger = dependencies.usageLedger ?? new UsageLedger({ ...(config.usageLedger ?? {}), enabled: config.usageLedger?.enabled === true });
    this.accountStore = dependencies.accountStore ?? dependencies.registry?.accountStore ?? new AccountStore(config.accounts);
    const actionItemLocation = dependencies.actionItemStore ? null : actionItemStateLocation(config);
    this.actionItemStore = dependencies.actionItemStore ?? new ActionItemStore({ path: actionItemLocation.path });
    this.actionItemTemporaryDirectory = actionItemLocation?.temporaryDirectory ?? null;
    this.actionItemDeliveryAdapter = dependencies.actionItemDeliveryAdapter;
    this.actionItemsReady = null;
    this.registry = dependencies.registry ?? new ProviderRegistry(config, { logger: this.logger, usageLedger: this.usageLedger, accountStore: this.accountStore });
    this.automaticTakeoverTargets = new Map();
    this.inlineTakeovers = new Map();
    this.automaticTakeoverController = config.automaticTakeover?.enabled === true
      ? dependencies.automaticTakeoverController ?? new AutomaticTakeoverController({
          statePath: config.automaticTakeover.statePath ?? join(dirname(config.configPath ?? join(process.cwd(), "threadspan-config.jsonc")), "automatic-takeover-state.json"),
          policy: {
            enabled: true,
            crossProviderEnabled: config.automaticTakeover.crossProviderEnabled,
            batchSize: config.automaticTakeover.maxSubagentsPerTick,
            staggerMs: config.automaticTakeover.subagentSpacingMs,
            tickIntervalMs: config.automaticTakeover.externalMonitoringEnabled ? config.automaticTakeover.pollIntervalMs : 0,
          },
          adapters: {
            readLiveness: async (target) => this.automaticTakeoverTargets.get(target.targetId)?.status ?? "unknown",
            listCandidates: async (target) => structuredClone(this.automaticTakeoverTargets.get(target.targetId)?.candidates ?? []),
            startReplacement: async (request) => {
              const runtime = this.automaticTakeoverTargets.get(request.target.targetId);
              if (!runtime) return { supported: false };
              const key = takeoverRouteKey(request.candidate);
              if (runtime.failedRouteKeys.has(key)) return { status: "exhausted" };
              if (runtime.activeRoute && takeoverRouteKey(runtime.activeRoute) === key) {
                return { status: "active", receipt: { evidence: "bridge-inline-completed", provider: runtime.activeRoute.providerId } };
              }
              return { supported: false };
            },
          },
          logger: this.logger,
        })
      : null;
    this.continuityController = config.continuity?.enabled === true
      ? dependencies.continuityController ?? new CodexContinuityController({
          ...config.continuity,
          command: config.providers?.["openai-codex"]?.command ?? "codex",
        }, { logger: this.logger })
      : null;
    if (!this.actionItemDeliveryAdapter && this.continuityController?.deliverActionItem) {
      this.actionItemDeliveryAdapter = { deliver: (entry) => this.continuityController.deliverActionItem(entry) };
    }
    this.maximumUtilizationController = config.maximumUtilization?.enabled === true && dependencies.maximumUtilizationController
      ? dependencies.maximumUtilizationController
      : createMaximumUtilizationController(config, { ...dependencies, accountStore: this.accountStore }, this.logger);
    this.maximumUtilizationRecovery = this.maximumUtilizationController || config.maximumUtilization?.enabled === true
      ? null
      : {
          journal: maximumUtilizationJournal(config, dependencies),
          capabilities: dependencies.maximumUtilizationCapabilities,
        };
    this.maximumUtilizationReady = null;
    this.compatibilityWatch = dependencies.compatibilityWatch ?? new DesktopCompatibilityWatch(config.compatibilityWatch ?? {});
    this.compatibilityReport = undefined;
    this.compatibilityPolling = undefined;
    if (config.compatibilityWatch?.enabled === true && config.compatibilityWatch?.pollingEnabled === true) {
      this.compatibilityPolling = this.compatibilityWatch.startPolling(
        (report) => { this.compatibilityReport = report; },
        { runImmediately: true, onError: (report) => { this.compatibilityReport = report; } },
      );
    }
    this.convenienceThreads = dependencies.convenienceThreads ?? new KeyedSerialQueue();
    this.connectionHealth = new Map();
    this.tipConversations = new Map();
    this.tipConversationTimers = new Map();
    this.tipRefinementLastAt = 0;
    this.desktopRouteSelection = null;
    this.closed = false;
  }

  /** Restore persistent controller state and replay its durable outbox. */
  async initialize() {
    this.#assertOpen();
    this.maximumUtilizationReady ??= this.#initializeMaximumUtilization();
    this.actionItemsReady ??= this.#initializeActionItems();
    await Promise.all([this.maximumUtilizationReady, this.automaticTakeoverController?.initialize?.(), this.actionItemsReady]);
  }

  async #initializeActionItems() {
    await this.actionItemStore.initialize();
    await this.#drainActionItemOutbox();
  }

  async #ensureActionItems() {
    this.actionItemsReady ??= this.#initializeActionItems();
    await this.actionItemsReady;
  }

  /** Drain one bounded initialization batch only when an exact-owner adapter was injected. */
  async #drainActionItemOutbox() {
    const deliver = typeof this.actionItemDeliveryAdapter === "function"
      ? this.actionItemDeliveryAdapter
      : this.actionItemDeliveryAdapter?.deliver?.bind(this.actionItemDeliveryAdapter);
    if (!deliver) return;
    const claimed = await this.actionItemStore.claimOutbox({ limit: 20, leaseMs: 30_000 });
    for (const entry of claimed) {
      try {
        const result = await deliver(structuredClone(entry));
        if (result?.supported === false) {
          await this.actionItemStore.failOutbox(entry.idempotencyKey, {
            claimToken: entry.claimToken,
            error: "Exact-owner delivery is unsupported",
          });
          continue;
        }
        await this.actionItemStore.ackOutbox(entry.idempotencyKey, {
          claimToken: entry.claimToken,
          ...(result?.deliveryRef ? { deliveryRef: result.deliveryRef } : {}),
        });
      } catch {
        await this.actionItemStore.failOutbox(entry.idempotencyKey, {
          claimToken: entry.claimToken,
          error: "Exact-owner delivery failed",
        });
      }
    }
  }

  async #initializeMaximumUtilization() {
    if (!this.maximumUtilizationController && this.maximumUtilizationRecovery) {
      const snapshot = await this.maximumUtilizationRecovery.journal.loadExisting();
      if (needsDisabledMaximumUtilizationRecovery(snapshot)) {
        this.maximumUtilizationController = new MaximumUtilizationController({
          policy: { ...(this.config.maximumUtilization ?? {}), enabled: false },
          journal: this.maximumUtilizationRecovery.journal,
          capabilities: this.maximumUtilizationRecovery.capabilities,
          logger: this.logger,
        });
      }
      this.maximumUtilizationRecovery = null;
    }
    await this.maximumUtilizationController?.initialize?.();
  }

  /**
   * Execute an OpenAI Responses-style request.
   *
   * `onEvent` is awaited to provide backpressure to an SSE writer. The method returns the exact
   * terminal response object used in `response.completed`, so buffered and streaming paths share one implementation.
   *
   * @param {Record<string, any>} request Responses request.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>, onIntentBrief?: (brief: Record<string, any>) => void|Promise<void>}} [options] Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async executeResponse(request, options = {}) {
    this.#assertOpen();
    validateResponseRequest(request);
    const traceId = createTraceId();
    const previousRecord = request.previous_response_id ? this.sessions.getResponse(request.previous_response_id) : undefined;
    if (request.previous_response_id && !previousRecord) {
      throw new RequestError(`Unknown or expired previous_response_id '${request.previous_response_id}'`);
    }

    const route = this.registry.resolveRoute(shouldUseDesktopRouteSelection(request, this.desktopRouteSelection)
      ? desktopRouteInput(request, this.desktopRouteSelection)
      : {
          model: request.model,
          mode: request.metadata?.bridge_mode,
          providerId: request.metadata?.bridge_provider,
          accountId: request.metadata?.bridge_account_id ?? request.metadata?.bridge_account,
        });
    const routeChange = previousRecord ? continuationRouteChange(previousRecord, route) : undefined;
    if (routeChange && !metadataBoolean(request.metadata?.bridge_continuity_handoff)) {
      throw new RequestError(
        `previous_response_id is bound to ${routeChange.from}; set bridge_continuity_handoff=true to continue through ${routeChange.to}`,
      );
    }
    const threadId = String(request.metadata?.bridge_thread_id ?? previousRecord?.threadId ?? createId("thread"));
    const workspace = request.metadata?.bridge_workspace ?? request.metadata?.cwd;
    if (route.mode === "delegate" && !workspace) {
      throw new RequestError("Delegate requires an explicit workspace through metadata.bridge_workspace or metadata.cwd");
    }
    const normalizedMessages = normalizeResponsesInput(request, previousRecord);
    const messages = applyModePolicy(normalizedMessages, route.mode);
    let intentBrief;
    if (request.metadata?.bridge_intent_brief !== undefined) {
      try {
        intentBrief = applyIntentBriefUpdates(
          deriveIntentBrief(request.metadata.bridge_intent_brief),
          request.metadata.bridge_intent_updates ?? [],
        );
      } catch (error) {
        throw new RequestError(error instanceof Error ? error.message : String(error));
      }
    } else if (request.metadata?.bridge_intent_updates !== undefined) {
      throw new RequestError("Intent brief updates require bridge_intent_brief in the same request");
    }
    if (intentBrief && options.onIntentBrief) await options.onIntentBrief(intentBrief);
    let voiceProfile;
    try {
      voiceProfile = resolveVoiceProfile(this.config.voice, request.metadata?.bridge_voice_profile);
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
    const userFacingProsePolicy = {
      profileId: voiceProfile.id,
      instruction: renderVoiceInstruction(voiceProfile),
      scope: "user-facing-assistant-prose-and-progress-cadence-only",
    };
    const responseVisibleRequest = request.metadata === undefined
      ? request
      : { ...request, metadata: providerVisibleMetadata(request.metadata) };
    const assembler = new ResponsesAssembler(responseVisibleRequest, {
      ...route,
      threadId,
      exposeReasoning: request.metadata?.bridge_expose_reasoning === true || request.metadata?.bridge_expose_reasoning === "true" || this.config.responses?.exposeReasoning === true,
    });

    this.logger.info("Starting response", {
      traceId,
      responseId: assembler.responseId,
      threadId,
      provider: route.providerId,
      accountId: route.accountId,
      mode: route.mode,
      model: route.model,
      stream: request.stream === true,
    });
    if (this.config.logging?.logBodies === true) {
      this.logger.info("Response request body", {
        traceId,
        responseId: assembler.responseId,
        body: boundedRedactedJson(responseVisibleRequest),
      });
    }

    let detachedTakeover = false;
    let takeoverDeferred;
    let takeoverTargetId;
    const emitResponseEvents = async (events) => {
      try {
        await emitAll(events, options.onEvent);
      } catch (error) {
        if (!detachedTakeover) throw error;
        this.logger.warn("Client event sink disconnected after certified automatic takeover; daemon completion continues", {
          traceId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };
    let responseBegan = false;
    const ensureResponseBegan = async () => {
      if (responseBegan) return;
      responseBegan = true;
      await emitResponseEvents(assembler.begin());
    };

    try {
      let terminal;
      let activeRoute = route;
      const selectAssemblerRoute = (selected) => {
        activeRoute = selected;
        assembler.route = { ...assembler.route, ...selected };
        assembler.request.model = `${selected.mode}/${selected.providerId}/${selected.model}`;
        assembler.request.metadata = {
          ...(assembler.request.metadata ?? {}),
          bridge_provider: selected.providerId,
          bridge_account_id: selected.accountId,
          bridge_upstream_model: selected.model,
          ...(selected.providerId !== route.providerId ? {
            bridge_route_change: "automatic-takeover",
            bridge_takeover_from_provider: route.providerId,
          } : selected.accountId !== route.accountId ? { bridge_route_change: "same-provider-account" } : {}),
        };
      };
      const providerRequest = {
        mode: route.mode,
        model: route.model,
        messages,
        tools: route.mode === "integrated" ? request.tools : undefined,
        toolChoice: route.mode === "integrated" ? request.tool_choice : undefined,
        parallelToolCalls: route.mode === "integrated" ? request.parallel_tool_calls : undefined,
        temperature: request.temperature,
        maxOutputTokens: request.max_output_tokens,
        signal: options.signal,
        threadId,
        workspace: workspace ? String(workspace) : undefined,
        timeoutMs: numberFromMetadata(request.metadata?.bridge_timeout_ms),
        metadata: providerVisibleMetadata(request.metadata),
      };
      const automaticTakeoverEnabled = this.config.automaticTakeover?.enabled === true
        && ((route.smart === true && route.explicitAccount !== true) || metadataBoolean(request.metadata?.bridge_automatic_takeover));
      const maximumAtStart = automaticTakeoverEnabled ? await sanitizedMaximumUtilizationReadModel(this.maximumUtilizationController) : null;
      const protectedDelegate = route.mode === "delegate" && ["maximum-utilization", "exhausted"].includes(maximumAtStart?.phase);
      const fallbackEnabled = automaticTakeoverEnabled
        || (this.config.accounts?.fallback?.enabled === true && metadataBoolean(request.metadata?.bridge_account_fallback));
      const candidates = fallbackEnabled && !protectedDelegate
        ? this.registry.fallbackRoutes(route, this.config.accounts.fallback.maxCandidates).slice(0, 1)
        : [];
      const takeoverCandidates = automaticTakeoverEnabled && !protectedDelegate && this.config.automaticTakeover.crossProviderEnabled === true
        ? this.registry.takeoverRoutes(route, {
            maximum: this.config.automaticTakeover.maxCrossProviderCandidates,
            minimumIntelligence: Number(this.config.routing?.providerProfiles?.[route.providerId]?.intelligence ?? 0) * this.config.automaticTakeover.minimumIntelligenceRatio,
            requiredContextWindow: numberFromMetadata(request.metadata?.bridge_required_context_tokens) ?? 1,
            privacyClass: this.config.routing?.providerProfiles?.[route.providerId]?.privacyClass,
          })
        : [];
      const attempts = [route, ...candidates, ...takeoverCandidates];
      const attemptGroupId = createId("attempt_group");
      const takeoverIntentDigest = createHash("sha256").update(JSON.stringify({ threadId, mode: route.mode, workspace: workspace ?? null, messages })).digest("hex");
      let takeoverRegistered = false;
      const failedRouteKeys = new Set();
      for (const [index, attemptRoute] of attempts.entries()) {
        const attemptId = createId("attempt");
        const attemptStartedAt = Date.now();
        let meaningfulOutput = false;
        let observedSideEffect = false;
        let attemptTerminal;
        let attemptCommitted = false;
        const pendingEvents = [];
        const baseAttemptRequest = {
          ...providerRequest,
          signal: detachedTakeover ? undefined : providerRequest.signal,
          model: attemptRoute.model,
          accountId: attemptRoute.accountId,
          metadata: {
            ...providerRequest.metadata,
            bridge_provider: attemptRoute.providerId,
            bridge_account_id: attemptRoute.accountId,
            bridge_upstream_model: attemptRoute.model,
          },
        };
        const attemptRequest = attemptRoute.mode === "consult" && attemptRoute.provider.capabilities?.().userFacingProsePolicy === true
          ? attemptRoute.provider.attachUserFacingProsePolicy(baseAttemptRequest, userFacingProsePolicy)
          : baseAttemptRequest;
        const effectiveSettings = attemptRoute.provider.effectiveSettings?.(attemptRequest);
        const commitAttempt = async () => {
          if (attemptCommitted) return;
          attemptCommitted = true;
          selectAssemblerRoute(attemptRoute);
          await ensureResponseBegan();
          for (const event of pendingEvents.splice(0)) await emitResponseEvents(assembler.accept(event));
        };
        try {
          for await (const providerEvent of attemptRoute.provider.run(attemptRequest)) {
            const connectionLifecycle = providerEvent.type === "done"
              ? attemptRoute.provider.connectionLifecycle?.({
                  accountId: attemptRoute.accountId,
                  providerHealth: "available",
                  accountHealth: "available",
                  transportHealth: "connected",
                })
              : undefined;
            const event = providerEvent.type === "done" && (effectiveSettings || connectionLifecycle)
              ? { ...providerEvent, providerMetadata: { ...(providerEvent.providerMetadata ?? {}), ...(effectiveSettings ? { effectiveSettings } : {}), ...(connectionLifecycle ? { connectionLifecycle } : {}) } }
              : providerEvent;
            if (options.signal?.aborted && !detachedTakeover) throw options.signal.reason ?? new Error("Request aborted");
            if (["text-delta", "reasoning-delta", "tool-call-delta"].includes(event.type)) meaningfulOutput = true;
            if (["tool-call-delta", "usage"].includes(event.type)) observedSideEffect = true;
            if (event.type === "done") attemptTerminal = event;
            if (attemptCommitted) {
              await emitResponseEvents(assembler.accept(event));
            } else {
              pendingEvents.push(event);
              if (meaningfulOutput || observedSideEffect) await commitAttempt();
            }
            if (assembler.output.length > 0) meaningfulOutput = true;
          }
          if (!attemptTerminal) {
            throw new ProviderError(attemptRoute.providerId, "Provider stream ended without a terminal done event", {
              retryable: false,
              details: { kind: "missing-terminal-event", retryPolicy: "no-automatic-retry" },
            });
          }
          await commitAttempt();
          terminal = attemptTerminal;
          this.connectionHealth.set(connectionKey(activeRoute.providerId, activeRoute.accountId), {
            providerHealth: "available",
            accountHealth: "available",
            transportHealth: "connected",
            lastSuccessAt: new Date().toISOString(),
            failure: null,
          });
          await this.registry.recordSuccess(activeRoute, assembler.usage, { durationMs: Date.now() - attemptStartedAt, ...usageEvidence(assembler.response.bridge_provider_metadata), attemptId, attemptGroupId, attemptOrdinal: index + 1, fallbackFromAccountId: attemptRoute.fallbackFromAccountId });
          break;
        } catch (error) {
          const bridgeError = asBridgeError(error);
          const failure = classifyConnectionFailure(bridgeError, {
            meaningfulOutput,
            observedSideEffect,
            parentInterrupted: options.signal?.aborted === true,
          });
          const recoveryAudit = options.signal?.aborted
            ? await attemptRoute.provider.auditRecovery?.({ threadId, workspace, error: bridgeError })
            : undefined;
          const connectionLifecycle = attemptRoute.provider.connectionLifecycle?.({
            accountId: attemptRoute.accountId,
            providerHealth: failure.providerHealth,
            accountHealth: failure.accountHealth,
            transportHealth: failure.transportHealth,
            lastFailure: { ...failure, ...(recoveryAudit ? { recoveryAudit } : {}) },
          });
          bridgeError.details = {
            ...(bridgeError.details && typeof bridgeError.details === "object" ? bridgeError.details : {}),
            ...(connectionLifecycle ? { connectionLifecycle } : {}),
            selfHealPolicy: this.selfHealPolicy(),
          };
          this.connectionHealth.set(connectionKey(attemptRoute.providerId, attemptRoute.accountId), {
            ...failure,
            failure: connectionLifecycle?.failure ?? failure,
            observedAt: new Date().toISOString(),
          });
          await this.#observeCodexNativeUsageLimit(attemptRoute, bridgeError);
          failedRouteKeys.add(takeoverRouteKey(attemptRoute));
          if (!options.signal?.aborted && (bridgeError.code === "provider_error" || bridgeError.status >= 500)) {
            await this.registry.recordFailure(attemptRoute, bridgeError, { durationMs: Date.now() - attemptStartedAt, partial: meaningfulOutput || observedSideEffect, attemptId, attemptGroupId, attemptOrdinal: index + 1, fallbackFromAccountId: attemptRoute.fallbackFromAccountId });
          }
          const nextRoute = attempts[index + 1];
          const hasNext = Boolean(nextRoute);
          const safeToContinue = nextRoute?.providerId === attemptRoute.providerId
            ? canSafelyFallbackAccount(bridgeError, { meaningfulOutput, observedSideEffect, mode: attemptRoute.mode })
            : canSafelyTakeoverProvider(bridgeError, { meaningfulOutput, observedSideEffect, mode: attemptRoute.mode });
          if (!hasNext || !safeToContinue) throw bridgeError;
          if (automaticTakeoverEnabled) {
            detachedTakeover = this.config.automaticTakeover.externalMonitoringEnabled === true;
            if (this.automaticTakeoverController && !takeoverRegistered) {
              const quotaWindowId = String(bridgeError.details?.upstream?.resetAt ?? "unknown-window");
              takeoverTargetId = `${threadId}:${takeoverIntentDigest}:${route.providerId}:${route.accountId}:${quotaWindowId}`;
              const existingTakeover = this.inlineTakeovers.get(takeoverTargetId);
              if (existingTakeover) {
                const recovered = structuredClone(await existingTakeover.promise);
                if (options.onEvent) {
                  await options.onEvent({ type: "response.created", sequence_number: 0, response: { ...recovered, status: "in_progress", output: [] } }).catch(() => undefined);
                  await options.onEvent({ type: "response.completed", sequence_number: 1, response: recovered }).catch(() => undefined);
                }
                return recovered;
              }
              let resolveTakeover;
              let rejectTakeover;
              const takeoverPromise = new Promise((resolve, reject) => { resolveTakeover = resolve; rejectTakeover = reject; });
              takeoverPromise.catch(() => undefined);
              takeoverDeferred = { resolve: resolveTakeover, reject: rejectTakeover };
              this.inlineTakeovers.set(takeoverTargetId, { promise: takeoverPromise, createdAt: Date.now() });
              const frozen = takeoverFrozen(route, request, workspace, this.config.routing?.providerProfiles?.[route.providerId]);
              this.automaticTakeoverTargets.set(takeoverTargetId, {
                status: "failed",
                activeRoute: null,
                failedRouteKeys,
                candidates: attempts.slice(1).map((candidate) => takeoverCandidate(candidate, frozen, quotaWindowId)),
              });
              await this.automaticTakeoverController.registerTarget({
                targetId: takeoverTargetId,
                providerId: route.providerId,
                accountId: route.accountId,
                quotaWindowId,
                role: "coordinator",
                frozen,
                explicitRoute: route.smart !== true,
                automaticTakeoverOptIn: metadataBoolean(request.metadata?.bridge_automatic_takeover),
                crossProviderEnabled: this.config.automaticTakeover.crossProviderEnabled,
                maximumUtilizationProtected: protectedDelegate,
                successorLaneEnabled: !protectedDelegate,
              });
              const observed = await this.automaticTakeoverController.observeFailure({
                targetId: takeoverTargetId,
                providerId: route.providerId,
                accountId: route.accountId,
                quotaWindowId,
                kind: "quota",
              });
              if (observed.duplicate && observed.phase === "replacement-active") {
                throw new ProviderError(route.providerId, "A prior automatic takeover is active but this daemon has no resumable response receipt", { retryable: false, details: { kind: "takeover-resume-required" } });
              }
              takeoverRegistered = true;
            }
          }
          terminal = undefined;
        }
      }
      selectAssemblerRoute(activeRoute);
      if (takeoverRegistered) {
        const runtime = this.automaticTakeoverTargets.get(takeoverTargetId);
        runtime.activeRoute = activeRoute;
        for (let index = 0; index <= attempts.length; index += 1) {
          const takeover = await this.automaticTakeoverController.tick();
          if (takeover.counts.active > 0 || takeover.phase === "blocked" || takeover.phase === "unsupported") break;
        }
      }
      await ensureResponseBegan();
      await emitResponseEvents(assembler.finish(terminal));

      const assistant = assembler.assistantMessage();
      const storedMessages = [...messages, assistant];
      if (request.metadata?.bridge_ephemeral_tip !== true) {
        const thread = this.sessions.getOrCreateThread(threadId, {
          providerId: activeRoute.providerId,
          accountId: activeRoute.accountId,
          mode: activeRoute.mode,
          model: activeRoute.model,
          workspace: workspace ? String(workspace) : undefined,
        });
        thread.messages = structuredClone(storedMessages);
        thread.providerId = activeRoute.providerId;
        thread.accountId = activeRoute.accountId;
        thread.mode = activeRoute.mode;
        thread.model = activeRoute.model;
        thread.workspace = workspace ? String(workspace) : undefined;
        thread.updatedAt = Date.now();
        this.sessions.putResponse(assembler.response, {
          threadId,
          messages: storedMessages,
          providerId: activeRoute.providerId,
          accountId: activeRoute.accountId,
          mode: activeRoute.mode,
          model: activeRoute.model,
        });
      }

      this.logger.info("Completed response", {
        traceId,
        responseId: assembler.responseId,
        threadId,
        provider: activeRoute.providerId,
        accountId: activeRoute.accountId,
        mode: activeRoute.mode,
        model: activeRoute.model,
        finishReason: assembler.finishReason,
        usage: assembler.usage,
      });
      if (this.config.logging?.logBodies === true) {
        this.logger.info("Response result body", {
          traceId,
          responseId: assembler.responseId,
          body: boundedRedactedJson(assembler.response),
        });
      }
      if (takeoverDeferred && takeoverTargetId) {
        takeoverDeferred.resolve(structuredClone(assembler.response));
        const timer = setTimeout(() => this.inlineTakeovers.delete(takeoverTargetId), 5 * 60 * 1000);
        timer.unref?.();
      }
      return assembler.response;
    } catch (error) {
      const bridgeError = asBridgeError(error);
      if (takeoverDeferred && takeoverTargetId) {
        takeoverDeferred.reject(bridgeError);
        this.inlineTakeovers.delete(takeoverTargetId);
      }
      await ensureResponseBegan().catch(() => undefined);
      await emitResponseEvents(assembler.fail({ code: bridgeError.code, message: bridgeError.message })).catch(() => undefined);
      this.logger.error("Response failed", {
        traceId,
        responseId: assembler.responseId,
        threadId,
        code: bridgeError.code,
        message: bridgeError.message,
      });
      throw bridgeError;
    }
  }

  /**
   * Invoke Consult as an in-thread advisory call suitable for MCP and CLI consumers.
   * @param {{
   *   question: string,
   *   context?: string,
   *   artifacts?: Array<{label?: string, path?: string, content?: string}>,
   *   system?: string,
   *   provider?: string,
   *   model?: string,
   *   threadId?: string,
   *   workspace?: string,
   *   timeoutMs?: number,
   *   profile?: string,
   *   reasoningEffort?: string,
   *   maxTurns?: number,
   *   noPlan?: boolean,
   *   expectedTurns?: number,
   *   acceptanceCommands?: string[],
   *   allowSubagents?: boolean,
   *   allowWebSearch?: boolean,
   *   coordinatorId?: string,
   *   workerGroup?: string,
   *   metadata?: Record<string, any>,
   * }} input Consult input.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} [options] Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async consult(input, options = {}) {
    return this.#runConvenienceMode("consult", input, options);
  }

  /**
   * Invoke Delegate as a bounded execution handoff suitable for MCP and CLI consumers.
   * @param {Record<string, any>} input Delegate input.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} [options] Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async delegate(input, options = {}) {
    return this.#runConvenienceMode("delegate", input, options);
  }

  /**
   * Return provider capabilities and discovered/configured models.
   * @param {{refreshCatalog?: boolean}} [options] Catalog refresh policy.
   */
  async describeProviders(options = {}) {
    this.#assertOpen();
    const providers = await this.registry.describe(options);
    return providers.map((item) => {
      const provider = this.registry.providers.get(item.id);
      const observed = this.connectionHealth.get(connectionKey(item.id, item.accountId));
      return {
        ...item,
        ...(provider?.providerWebMetadata?.() ?? {}),
        effectiveSettings: provider?.effectiveSettings?.(),
        connectionLifecycle: provider?.connectionLifecycle?.({
          accountId: item.accountId,
          health: item.health,
          accountHealth: observed?.accountHealth ?? item.health?.status ?? "unknown",
          transportHealth: observed?.transportHealth ?? "not-probed",
          lastFailure: observed?.failure ?? null,
        }),
      };
    });
  }

  /** Return the provider-neutral, host-default-preserving branch policy. */
  branchingPolicy() {
    return publicBranchingPolicy(this.config.branching);
  }

  /** Return bounded lifecycle policy; this never authorizes a generic retry. */
  connectionRecoveryPolicy() {
    return publicConnectionRecoveryPolicy(this.config.connectionRecovery);
  }

  /** Return the bounded repair/meta/meta-meta contract. */
  selfHealPolicy() {
    return publicSelfHealPolicy(this.config.selfHeal);
  }

  /** Return OpenAI-shaped routed model entries. */
  async listModels() {
    this.#assertOpen();
    return this.registry.listRoutedModels();
  }

  /** Return read-only account descriptors and telemetry. */
  async describeAccounts() {
    this.#assertOpen();
    const described = await this.registry.describeAccounts();
    return {
      ...described,
      accounts: (described.accounts ?? []).map((account) => ({
        ...account,
        connectionHealth: this.connectionHealth.get(connectionKey(account.providerId, account.id)) ?? {
          providerHealth: account.health?.status ?? "unknown",
          accountHealth: account.health?.status ?? "unknown",
          transportHealth: "not-probed",
        },
      })),
    };
  }

  /** Add a machine-local ref-only account descriptor. */
  async createAccount(input) {
    this.#assertOpen();
    this.registry.validateAccountDescriptor(input);
    return this.accountStore.create(input);
  }

  /** Persist the active account for its provider. */
  async selectAccount(accountId) {
    this.#assertOpen();
    return this.accountStore.select(accountId);
  }

  /** Remove one machine-local account descriptor. */
  async removeAccount(accountId) {
    this.#assertOpen();
    const removed = await this.accountStore.remove(accountId);
    await this.registry.releaseAccount(accountId);
    return removed;
  }

  /** Return the closed public action queue; native owner references remain server-side. */
  async actionItemsState(options = {}) {
    this.#assertOpen();
    await this.#ensureActionItems();
    return sanitizeActionItemsReadModel(await this.actionItemStore.readModel(options));
  }

  /** Complete one opaque action item and durably enqueue its exact-owner delivery. */
  async completeActionItem(handle, input) {
    this.#assertOpen();
    await this.#ensureActionItems();
    const receipt = await this.actionItemStore.complete(handle, input);
    await this.#drainActionItemOutbox().catch((error) => this.logger.warn("Could not drain action-item owner delivery", {
      error: error instanceof Error ? error.message : String(error),
    }));
    return receipt;
  }

  /** @internal Publish a source-owned action item; this is intentionally absent from HTTP and MCP. */
  async publishActionItem(input) {
    this.#assertOpen();
    await this.#ensureActionItems();
    return this.actionItemStore.upsert(input);
  }

  /** Select the route used by Threadspan auto requests and convenience-mode defaults. */
  selectDesktopRoute(input) {
    this.#assertOpen();
    const routeId = typeof input?.routeId === "string" ? input.routeId.trim() : "";
    if (!routeId) throw new RequestError("Desktop route selection requires routeId");
    const route = this.registry.resolveRoute({ model: routeId });
    this.desktopRouteSelection = {
      routeId: canonicalRouteId(route),
      mode: route.mode,
      provider: route.providerId,
      accountId: route.accountId,
      model: route.model,
    };
    return this.desktopRouteState();
  }

  /** Return the current sanitized Desktop route selection. */
  desktopRouteState() {
    return this.desktopRouteSelection ? structuredClone(this.desktopRouteSelection) : { routeId: null };
  }

  /** Return a non-discovering Desktop bootstrap snapshot for cold app startup. */
  desktopState() {
    this.#assertOpen();
    const pickerRoutes = [];
    const nodes = [];
    for (const [id, provider] of this.registry.providers) {
      const capabilities = provider.capabilities();
      const configuredModels = Array.isArray(provider.config.models) ? provider.config.models : [provider.config.model ?? "auto"];
      const models = configuredModels.map((model) => typeof model === "string" ? model : model?.id).filter(Boolean);
      const modes = Object.entries(capabilities.modes ?? {}).filter(([, entry]) => entry?.supported).map(([mode]) => mode);
      nodes.push({ id, availability: "configured", modes, models });
      for (const mode of modes) for (const model of models) {
        pickerRoutes.push({ id: `${mode}/${id}/${model}`, mode, provider: id, model, availability: "configured", free: provider.config.free === true });
      }
    }
    const selected = this.desktopRouteSelection;
    return {
      status: "ready",
      route: selected ? { id: selected.routeId, mode: selected.mode, provider: selected.provider, accountId: selected.accountId, model: selected.model } : null,
      desktopRouteSelection: this.desktopRouteState(),
      routeMap: { nodes },
      pickerRoutes,
      evidence: "configured-fast-path",
    };
  }

  /** Return sanitized live state for the loopback-only Threadspan sidecar. */
  async threadspanState() {
    this.#assertOpen();
    const mode = this.desktopRouteSelection?.mode ?? this.config.defaults?.mode ?? "consult";
    const requestedProvider = this.desktopRouteSelection?.provider ?? this.config.defaults?.provider ?? "threadspan";
    const requestedModel = this.desktopRouteSelection?.routeId ?? this.config.defaults?.model ?? "auto";
    const routedModels = await this.registry.listRoutedModels();
    const routing = this.registry.routingSnapshot({
      routedModels,
      mode,
      providerId: requestedProvider,
      model: requestedModel,
      accountId: this.desktopRouteSelection?.accountId ?? this.config.defaults?.accountId,
    });
    const providers = routing.providers.map((item) => {
      const provider = this.registry.providers.get(item.id);
      const observed = this.connectionHealth.get(connectionKey(item.id, item.accountId));
      return {
        ...item,
        ...(provider?.providerWebMetadata?.() ?? {}),
        effectiveSettings: provider?.effectiveSettings?.(),
        connectionLifecycle: provider?.connectionLifecycle?.({
          accountId: item.accountId,
          health: item.health,
          accountHealth: observed?.accountHealth ?? item.health?.status ?? "unknown",
          transportHealth: observed?.transportHealth ?? "not-probed",
          lastFailure: observed?.failure ?? null,
        }),
      };
    });
    const providersById = new Map(providers.map((provider) => [provider.id, provider]));
    const registryRouteMap = routing.routeMap;
    const routeMap = {
      ...registryRouteMap,
      nodes: registryRouteMap.nodes.map((node) => ({
        ...node,
        ...publicProviderWebMetadata(providersById.get(node.id)),
      })),
    };
    const pickerRoutes = routing.routedModels
      .map((entry) => publicPickerRoute(entry, providersById.get(entry?.metadata?.provider)))
      .filter(Boolean);
    const route = routing.route;
    const routeError = routing.routeError;
    const [usageSummary, accounts, actionItems] = await Promise.all([
      this.registry.usageSummary({ recentLimit: 50 }),
      this.describeAccounts(),
      this.actionItemsState({ status: "open", sort: "updated-desc", limit: 100 }),
    ]);
    const activeAccount = accounts.accounts.find((account) => account.providerId === route.providerId && account.id === route.accountId);
    const activeForecast = activeAccount?.forecast
      ?? usageSummary.forecasts?.accounts?.find((forecast) => forecast.scope.provider === route.providerId && forecast.scope.accountId === route.accountId)
      ?? null;
    const selected = providers.find((item) => item.id === route.providerId);
    const candidates = routeMap.edges.filter((edge) => edge.mode === mode && edge.provider !== route.providerId).slice(0, 2);
    const runtime = this.registry.runtimeStats();
    const utilization = Object.entries(runtime).flatMap(([id, item]) => {
      const active = Number(item.active ?? item.activeJobs ?? item.retained ?? NaN);
      const limit = Number(item.maxActive ?? item.capacity ?? item.maxRetained ?? NaN);
      if (!Number.isFinite(active) || !Number.isFinite(limit) || limit <= 0) return [];
      return [{ id, label: `${id} active`, used: active, limit, note: "Daemon-local utilization; not a provider entitlement guarantee." }];
    });
    const maximumUtilization = await sanitizedMaximumUtilizationReadModel(this.maximumUtilizationController);
    const compatibility = summarizeCompatibility(this.config.compatibilityWatch, this.compatibilityReport);
    let continuity;
    try {
      continuity = this.continuityController ? await this.continuityController.view() : { enabled: false, tasks: [], reason: "disabled" };
    } catch (error) {
      continuity = { enabled: true, controlEnabled: false, provider: "codex", evidence: "unavailable", tasks: [], capabilities: { rename: false, rollover: false, nativeChatListGrouping: false }, reason: error instanceof Error ? error.message : String(error) };
    }
    const tip = this.config.tips?.enabled === true
      ? selectTip({
          mode,
          routeVerified: route.health?.status === "available",
          qualifiedFallbackCount: candidates.filter((edge) => routeMap.nodes.find((node) => node.id === edge.provider)?.availability !== "unavailable").length,
          compatibilityChanged: compatibility.changed === true,
        })
      : null;
    const tipModel = tip ? publishedTipModel(this.config.tips, providers) : null;
    return {
      hostSurfaces: listHostSurfaces(),
      status: "ready",
      product: { name: "Threadspan", tagline: "One task. Every model." },
      hud: {
        assumedInjection: false,
        placeholder: "Local route control beneath the host agent HUD when the host supports it.",
        ...(tip ? {
          tip: {
            id: tip.id,
            text: tip.text,
            cooldownMs: this.config.tips.cooldownMs,
            glossaryHref: `#glossary-${tip.glossaryTerm}`,
            ...(tipModel ? { model: tipModel } : {}),
          },
        } : {}),
      },
      route: {
        id: `${mode}/${route.providerId}/${route.accountId === UNKNOWN_ACCOUNT_ID ? "" : `@${route.accountId}/`}${route.model}`,
        mode,
        provider: route.providerId,
        accountId: route.accountId,
        model: route.model,
        verified: route.health?.status === "available",
        verifiedAt: route.health?.catalogCheckedAt ? new Date(route.health.catalogCheckedAt).toISOString() : "",
        verificationSource: routeError ?? (selected?.modelError ? "Configured fallback; live catalog unavailable." : "Live daemon catalog and capability check."),
        ...publicProviderWebMetadata(selected),
        effectiveSettings: selected?.effectiveSettings ?? null,
        connectionLifecycle: selected?.connectionLifecycle ?? null,
      },
      quota: publishedQuota(activeAccount?.quota),
      forecast: activeForecast,
      context: null,
      fallbacks: candidates.map((edge) => {
        const node = routeMap.nodes.find((candidate) => candidate.id === edge.provider);
        const model = node?.models?.[0] ?? "auto";
        return { id: `${mode}/${edge.provider}/${model}`, mode, provider: edge.provider, model, qualified: node?.availability !== "unavailable", reason: `Priority ${edge.priority}; weight ${edge.weight}; ${node?.specialties?.join(", ") ?? "general"}.` };
      }),
      checkpoint: null,
      utilization,
      history: usageSummary.recentEvents.map((event) => ({ at: event.timestamp, route: `${event.mode}/${event.provider}/${event.accountId === UNKNOWN_ACCOUNT_ID ? "" : `@${event.accountId}/`}${event.model}`, accountId: event.accountId, mode: event.mode, event: event.status, verified: event.evidenceClass === "live-provider" })),
      reroute: null,
      filters: { mode: "all", verifiedOnly: false },
      routeMap,
      pickerRoutes,
      desktopRouteSelection: this.desktopRouteState(),
      accounts,
      compatibility,
      continuity,
      actionItems,
      automaticTakeover: this.automaticTakeoverController ? await this.automaticTakeoverController.readModel() : { phase: "disabled", counts: { targets: 0, monitors: 0, queued: 0, active: 0, unsupported: 0, blocked: 0 }, monitors: [] },
      branching: this.branchingPolicy(),
      connectionRecovery: this.connectionRecoveryPolicy(),
      selfHeal: this.selfHealPolicy(),
      ...(maximumUtilization ? { maximumUtilization } : {}),
      copyCheck: describeCopyCheck({
        ...this.config.copyCheck,
        records: this.copyCheckRecords,
      }),
    };
  }

  async continuityState() {
    this.#assertOpen();
    if (!this.continuityController) return { enabled: false, tasks: [], reason: "disabled" };
    return this.continuityController.view();
  }

  async renameContinuityTask(input) {
    this.#assertOpen();
    if (!this.continuityController) throw new RequestError("Continuity is disabled");
    return this.continuityController.rename(input);
  }

  async previewContinuityRollover(input) {
    this.#assertOpen();
    if (!this.continuityController) throw new RequestError("Continuity is disabled");
    return this.continuityController.previewRollover(input);
  }

  async requestContinuityRollover(input) {
    this.#assertOpen();
    if (!this.continuityController) throw new RequestError("Continuity is disabled");
    return this.continuityController.rollover(input);
  }

  async disableAutomaticTakeover() {
    this.#assertOpen();
    if (!this.automaticTakeoverController) return { accepted: false, reason: "disabled" };
    return this.automaticTakeoverController.ownerDisable();
  }

  async reviewCopy(input = {}) {
    this.#assertOpen();
    const policy = this.config.copyNaturalizer ?? {};
    if (policy.enabled !== true) throw new RequestError("Copy review is disabled");
    const profile = input.profile ?? policy.profile;
    const voice = resolveVoiceProfile(this.config.voice, input.voiceProfile);
    const rewriteAdapter = policy.useModel === true
      ? async (text, context) => {
          const result = await this.consult({
            provider: policy.provider,
            model: policy.model,
            question: text,
            system: [context.profile.guidance, ...context.rules, "Return only the rewritten text; do not add framing or commentary."].join("\n"),
            maxOutputTokens: policy.maxOutputTokens,
            timeoutMs: policy.timeoutMs,
            allowWebSearch: false,
            allowSubagents: false,
          });
          return { text: result.text, usage: result.usage };
        }
      : null;
    try {
      return await naturalizeCopy(String(input.text ?? ""), {
        enabled: true,
        profile,
        maxInputChars: policy.maxInputChars,
        maxPasses: policy.maxPasses,
        adapterTimeoutMs: policy.timeoutMs,
        rewriteAdapter,
        voiceConstraints: {
          id: voice.id,
          parameters: voice.parameters,
          preferredTerms: voice.preferredTerms,
          avoidedTerms: voice.avoidedTerms,
        },
      });
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Owner-started external copy check. Credentials existing never enable it.
   * Results are advisory and are stored only as sanitized records.
   */
  async checkCopy(input = {}) {
    this.#assertOpen();
    try {
      const result = await checkCopy(String(input.text ?? ""), {
        ...this.config.copyCheck,
        trigger: input.trigger,
        action: input.action,
        confirmed: input.confirmed,
        requestedAdapters: input.adapters,
        acknowledgeRetention: input.acknowledgeRetention,
        pangramResult: input.pangramResult ?? input.result ?? input.displayText,
        environment: this.copyCheckEffects.environment ?? process.env,
        fetch: this.copyCheckEffects.fetch ?? globalThis.fetch,
        openUrl: this.copyCheckEffects.openUrl,
        writeClipboard: this.copyCheckEffects.writeClipboard,
        signal: input.signal,
      });
      this.#rememberCopyCheck(result.results);
      return result;
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * User-started release companion. External timeout/failure/skip cannot fail it.
   */
  async reviewReleaseCopy(input = {}) {
    this.#assertOpen();
    if (input.userStarted !== true) throw new RequestError("Release copy review runs only when a user starts it");
    const policy = this.config.copyNaturalizer ?? {};
    const voice = resolveVoiceProfile(this.config.voice, input.voiceProfile);
    const rewriteAdapter = policy.useModel === true
      ? async (text, context) => {
          const result = await this.consult({
            provider: policy.provider,
            model: policy.model,
            question: text,
            system: [context.profile.guidance, ...context.rules, "Return only the rewritten text; do not add framing or commentary."].join("\n"),
            maxOutputTokens: policy.maxOutputTokens,
            timeoutMs: policy.timeoutMs,
            allowWebSearch: false,
            allowSubagents: false,
          });
          return { text: result.text, usage: result.usage };
        }
      : null;
    try {
      const result = await reviewReleaseCopy(String(input.text ?? ""), {
        userStarted: true,
        copyNaturalizer: policy,
        copyCheck: this.config.copyCheck,
        rewriteAdapter,
        voiceConstraints: {
          id: voice.id,
          parameters: voice.parameters,
          preferredTerms: voice.preferredTerms,
          avoidedTerms: voice.avoidedTerms,
        },
        confirmed: input.confirmed,
        requestedAdapters: input.adapters,
        acknowledgeRetention: input.acknowledgeRetention,
        pangramResult: input.pangramResult ?? input.result,
        environment: this.copyCheckEffects.environment ?? process.env,
        fetch: this.copyCheckEffects.fetch ?? globalThis.fetch,
        openUrl: this.copyCheckEffects.openUrl,
        writeClipboard: this.copyCheckEffects.writeClipboard,
        signal: input.signal,
      });
      this.#rememberCopyCheck(result.external?.results);
      return result;
    } catch (error) {
      throw new RequestError(error instanceof Error ? error.message : String(error));
    }
  }

  #rememberCopyCheck(results) {
    if (!Array.isArray(results)) return;
    for (const item of results) {
      const sanitized = sanitizeCopyCheckRecord(item);
      if (sanitized) this.copyCheckRecords.push(sanitized);
    }
    if (this.copyCheckRecords.length > 8) this.copyCheckRecords = this.copyCheckRecords.slice(-8);
  }

  /** Request a daemon-owned native quota refresh for the selected Codex account. */
  async refreshMaximumUtilizationNative() {
    this.#assertOpen();
    if (this.config.maximumUtilization?.enabled !== true || !this.maximumUtilizationController?.refreshNative) return { accepted: false, reason: "disabled" };
    await this.initialize();
    return this.maximumUtilizationController.refreshNative();
  }

  /** Enter quota-independent owner-requested manual full-push mode. */
  async enterManualMaximumUtilization(input) {
    this.#assertOpen();
    if (this.config.maximumUtilization?.enabled !== true || !this.maximumUtilizationController?.enterManual) return { accepted: false, reason: "disabled" };
    await this.initialize();
    return this.maximumUtilizationController.enterManual(input);
  }

  async leaveManualMaximumUtilization() {
    this.#assertOpen();
    if (!this.maximumUtilizationController?.leaveManual) return { accepted: false, reason: "disabled" };
    await this.initialize();
    return this.maximumUtilizationController.leaveManual();
  }

  async disableMaximumUtilization() {
    this.#assertOpen();
    if (!this.maximumUtilizationController?.ownerDisable) return { accepted: false, reason: "disabled" };
    await this.initialize();
    return this.maximumUtilizationController.ownerDisable();
  }

  /** Return count-only service diagnostics. */
  stats() {
    return {
      status: this.closed ? "closed" : "ok",
      sessions: this.sessions.stats(),
      providers: this.registry.providers.size,
      providerRuntime: this.registry.runtimeStats(),
      accounts: this.accountStore.stats(),
      configPath: this.config.configPath,
      branching: this.branchingPolicy(),
      connectionRecovery: this.connectionRecoveryPolicy(),
      selfHeal: this.selfHealPolicy(),
    };
  }

  /** Dispose provider resources. */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.maximumUtilizationReady?.catch(() => undefined);
    await this.actionItemsReady?.catch(() => undefined);
    await this.maximumUtilizationController?.close?.();
    await this.automaticTakeoverController?.close?.();
    this.compatibilityPolling?.stop();
    for (const timer of this.tipConversationTimers.values()) clearTimeout(timer);
    this.tipConversationTimers.clear();
    this.tipConversations.clear();
    await this.registry.close();
    await this.usageLedger.flush();
    if (this.actionItemTemporaryDirectory) await rm(this.actionItemTemporaryDirectory, { recursive: true, force: true });
  }

  async #observeCodexNativeUsageLimit(route, error) {
    const details = error?.details?.upstream;
    if (details?.kind !== CODEX_NATIVE_USAGE_LIMIT_KIND || details.preOutput !== true || details.noSideEffects !== true) return;
    const observedAt = validIsoTimestamp(details.observedAt) ?? new Date().toISOString();
    const resetAt = validIsoTimestamp(details.resetAt);
    if (typeof this.accountStore.observeQuota === "function") {
      try {
        await this.accountStore.observeQuota(route.accountId, {
          remaining: 0,
          resetAt: resetAt ?? null,
          renewalAt: null,
          charge: null,
          source: "codex-cli-usage-limit",
          observedAt,
        });
      } catch (error) {
        this.logger.warn("Could not persist native Codex quota observation", {
          accountId: route.accountId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    try {
      await this.refreshMaximumUtilizationNative();
    } catch (error) {
      this.logger.warn("Maximum-utilization native refresh failed after a Codex usage limit", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Execute one convenience mode by mapping it through the same Responses implementation.
   * @param {"consult"|"delegate"} mode Convenience mode.
   * @param {Record<string, any>} input Input object.
   * @param {{signal?: AbortSignal, onEvent?: (event: Record<string, any>) => void|Promise<void>}} options Execution options.
   * @returns {Promise<Record<string, any>>}
   */
  async #runConvenienceMode(mode, input, options) {
    if (!input || typeof input !== "object") throw new RequestError(`${mode} input must be an object`);
    if (typeof input.question !== "string" || input.question.trim().length === 0) {
      throw new RequestError(`${mode} requires a non-empty question`);
    }
    const threadId = input.threadId ?? createId("thread");
    return this.convenienceThreads.run(threadId, options.signal, async () => {
      const tipCall = input.metadata?.threadspan_tip_kind
        ? await this.#authorizeTipCall(mode, input, threadId)
        : null;
      const effectiveInput = tipCall ? tipCall.input : input;
      const desktop = this.desktopRouteSelection?.mode === mode ? this.desktopRouteSelection : null;
      const provider = effectiveInput.provider ?? desktop?.provider ?? this.config.defaults?.provider;
      if (!provider) throw new RequestError(`No provider supplied and no defaults.provider configured`);
      const resolved = this.registry.resolveRoute({ providerId: provider, mode, model: effectiveInput.model ?? desktop?.model, accountId: effectiveInput.accountId ?? effectiveInput.account_id ?? desktop?.accountId });
      const model = resolved.model;
      const priorThread = tipCall?.kind === "ask"
        ? this.tipConversations.get(threadId)
        : effectiveInput.threadId ? this.sessions.getThread(effectiveInput.threadId) : undefined;
      const priorBinding = priorThread ? continuationRouteChange(priorThread, resolved) : undefined;
      if (priorBinding && !tipCall && !metadataBoolean(effectiveInput.continuityHandoff ?? effectiveInput.continuity_handoff)) {
        throw new RequestError(`Thread '${threadId}' is bound to ${priorBinding.from}; explicit continuity handoff is required for ${priorBinding.to}`);
      }
      const newMessages = normalizeConsultInput(effectiveInput);
      const messages = priorThread?.messages?.length
        ? [...structuredClone(priorThread.messages), ...newMessages]
        : newMessages;
      const responseRequest = {
        model: `${mode}/${resolved.providerId}/${resolved.accountId === UNKNOWN_ACCOUNT_ID ? "" : `@${resolved.accountId}/`}${model}`,
        input: toBridgeResponsesInput(messages),
        stream: false,
        store: false,
        ...(Number.isInteger(effectiveInput.maxOutputTokens) ? { max_output_tokens: effectiveInput.maxOutputTokens } : {}),
        metadata: {
          ...(effectiveInput.metadata && typeof effectiveInput.metadata === "object" && !Array.isArray(effectiveInput.metadata) ? effectiveInput.metadata : {}),
          ...(effectiveInput.profile ? { bridge_profile: String(effectiveInput.profile) } : {}),
          ...(effectiveInput.voiceProfile ? { bridge_voice_profile: String(effectiveInput.voiceProfile) } : {}),
          ...(effectiveInput.intentBrief ? { bridge_intent_brief: effectiveInput.intentBrief } : {}),
          ...(effectiveInput.intentUpdates ? { bridge_intent_updates: effectiveInput.intentUpdates } : {}),
          ...(effectiveInput.reasoningEffort ? { bridge_reasoning_effort: String(effectiveInput.reasoningEffort) } : {}),
          ...(effectiveInput.maxTurns ? { bridge_max_turns: String(effectiveInput.maxTurns) } : {}),
          ...(effectiveInput.expectedTurns ? { bridge_expected_turns: String(effectiveInput.expectedTurns) } : {}),
          ...(effectiveInput.noPlan !== undefined ? { bridge_no_plan: effectiveInput.noPlan === true } : {}),
          ...(effectiveInput.allowSubagents !== undefined ? { bridge_allow_subagents: effectiveInput.allowSubagents === true } : {}),
          ...(effectiveInput.allowWebSearch !== undefined ? { bridge_allow_web_search: effectiveInput.allowWebSearch === true } : {}),
          ...(effectiveInput.coordinatorId ? { bridge_coordinator_id: String(effectiveInput.coordinatorId) } : {}),
          ...(effectiveInput.workerGroup ? { bridge_worker_group: String(effectiveInput.workerGroup) } : {}),
          ...(Array.isArray(effectiveInput.acceptanceCommands) && effectiveInput.acceptanceCommands.length > 0
            ? { bridge_acceptance_commands: effectiveInput.acceptanceCommands.map(String) }
            : {}),
          ...(effectiveInput.scope && typeof effectiveInput.scope === "object"
            ? { bridge_scope: effectiveInput.scope }
            : Array.isArray(effectiveInput.allowedPaths)
              ? { bridge_scope: { allowed: effectiveInput.allowedPaths.map(String), denied: Array.isArray(effectiveInput.deniedPaths) ? effectiveInput.deniedPaths.map(String) : [], nonGoals: Array.isArray(effectiveInput.nonGoals) ? effectiveInput.nonGoals.map(String) : [] } }
              : {}),
          bridge_mode: mode,
          bridge_provider: resolved.providerId,
          bridge_account_id: resolved.accountId,
          ...(effectiveInput.accountFallback === true || effectiveInput.account_fallback === true ? { bridge_account_fallback: true } : {}),
          bridge_thread_id: threadId,
          ...(effectiveInput.workspace
            ? { bridge_workspace: effectiveInput.workspace }
            : { bridge_no_default_workspace: true }),
          ...(effectiveInput.timeoutMs ? { bridge_timeout_ms: String(effectiveInput.timeoutMs) } : {}),
          ...(tipCall ? { bridge_ephemeral_tip: true } : {}),
        },
      };
      const executionOptions = tipCall
        ? {
            ...options,
            signal: options.signal
              ? AbortSignal.any([options.signal, AbortSignal.timeout(effectiveInput.timeoutMs)])
              : AbortSignal.timeout(effectiveInput.timeoutMs),
          }
        : options;
      const response = await this.executeResponse(responseRequest, executionOptions);
      const text = response.output_text ?? extractOutputText(response.output);
      if (tipCall?.kind === "ask") {
        const conversation = this.tipConversations.get(threadId);
        if (conversation) {
          conversation.messages = [...messages, { role: "assistant", content: text }];
          conversation.providerId = resolved.providerId;
          conversation.accountId = resolved.accountId;
          conversation.mode = mode;
          conversation.model = model;
          conversation.updatedAt = Date.now();
        }
      }
      if (tipCall) return { ...(tipCall.kind === "ask" ? { threadId } : {}), text };
      return {
        responseId: response.id,
        threadId,
        provider: resolved.providerId,
        accountId: response.metadata?.bridge_account_id ?? resolved.accountId,
        mode,
        model,
        text,
        usage: response.usage,
        ...(response.bridge_provider_metadata ? { providerMetadata: response.bridge_provider_metadata } : {}),
        response,
      };
    });
  }

  async #authorizeTipCall(mode, input, threadId) {
    if (mode !== "consult") throw new RequestError("Tips may use only Consult");
    if (this.config.tips?.enabled !== true) throw new RequestError("Tips are disabled");
    const metadata = input.metadata;
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new RequestError("Tip call metadata is required");
    const metadataKeys = Object.keys(metadata);
    if (metadataKeys.some((key) => !["threadspan_tip_kind", "threadspan_tip_id"].includes(key))) throw new RequestError("Tip call metadata contains unsupported fields");
    const kind = metadata.threadspan_tip_kind;
    if (!["refine", "ask"].includes(kind)) throw new RequestError("Unknown tip call kind");
    const tip = tipById(metadata.threadspan_tip_id);
    if (!tip) throw new RequestError("Unknown tip catalog key");
    if (input.threadId !== undefined && (typeof input.threadId !== "string" || !/^thread_[0-9a-f]{32}$/.test(input.threadId))) {
      throw new RequestError("Tip conversation threadId is malformed");
    }
    if (input.accountId !== undefined || input.account_id !== undefined || input.accountFallback !== undefined || input.account_fallback !== undefined
      || input.context !== undefined || input.artifacts !== undefined || input.workspace !== undefined || input.profile !== undefined
      || input.reasoningEffort !== undefined || input.reasoning_effort !== undefined || input.maxTurns !== undefined || input.max_turns !== undefined
      || input.expectedTurns !== undefined || input.expected_turns !== undefined || input.scope !== undefined || input.allowedPaths !== undefined) {
      throw new RequestError("Tip calls cannot carry account identifiers, host context, artifacts, workspace, or execution overrides");
    }

    const providers = await this.describeProviders();
    const warranted = await this.#warrantedTip(providers);
    if (!warranted || warranted.id !== tip.id) throw new RequestError("The current local heuristic did not warrant this tip");
    const policy = publishedTipModel(this.config.tips, providers);
    if (!policy || input.provider !== policy.provider || input.model !== policy.model) {
      throw new RequestError("Tip model provider, privacy, capability, model, or live-availability gate failed");
    }
    const now = Date.now();
    this.#sweepTipConversations(now);
    if (kind === "refine") {
      if (input.threadId !== undefined || now - this.tipRefinementLastAt < policy.cooldownMs) throw new RequestError("Tip refinement budget or cooldown is active");
      this.tipRefinementLastAt = now;
      return {
        kind,
        input: {
          question: `Tip key: ${tip.id}\nCurrent copy: ${tip.text}`,
          system: "Refine one Threadspan product tip. Return one plain sentence under 180 characters. Do not add facts, links, identifiers, or calls to action.",
          provider: policy.provider,
          model: policy.model,
          maxOutputTokens: policy.maxOutputTokens,
          timeoutMs: policy.maxLatencyMs,
          allowWebSearch: false,
          allowSubagents: false,
          metadata,
        },
      };
    }

    if (!policy.ask) throw new RequestError("Tip conversation is disabled");
    const question = input.question.trim();
    if (question.length > 240) throw new RequestError("Tip conversation question exceeds 240 characters");
    let conversation = input.threadId ? this.tipConversations.get(threadId) : undefined;
    if (input.threadId && (!conversation || conversation.tipId !== tip.id)) throw new RequestError("Unknown or expired tip conversation");
    if (!conversation) {
      if (this.tipConversations.size >= TIP_CONVERSATION_LIMIT) throw new RequestError("Tip conversation capacity is full");
      conversation = { tipId: tip.id, messages: [], turns: 0, createdAt: now, updatedAt: now };
      this.tipConversations.set(threadId, conversation);
    }
    if (conversation.turns >= policy.ask.maxTurnsPerSession) throw new RequestError("Tip conversation turn budget is exhausted");
    conversation.turns += 1;
    conversation.updatedAt = now;
    this.#scheduleTipConversationExpiry(threadId, now);
    return {
      kind,
      input: {
        question,
        ...(!input.threadId ? { system: `Explain only this Threadspan product tip and its documented boundary: ${tip.text}. Do not infer or request the host prompt, identifiers, credentials, memory, files, or account details.` } : {}),
        provider: policy.provider,
        model: policy.model,
        threadId: input.threadId,
        maxOutputTokens: policy.ask.maxOutputTokens,
        timeoutMs: policy.ask.maxLatencyMs,
        allowWebSearch: false,
        allowSubagents: false,
        metadata,
      },
    };
  }

  #sweepTipConversations(now = Date.now()) {
    const cutoff = now - TIP_CONVERSATION_TTL_MS;
    for (const [id, conversation] of this.tipConversations.entries()) {
      if (conversation.updatedAt < cutoff) {
        this.tipConversations.delete(id);
        clearTimeout(this.tipConversationTimers.get(id));
        this.tipConversationTimers.delete(id);
      }
    }
  }

  #scheduleTipConversationExpiry(threadId, updatedAt) {
    clearTimeout(this.tipConversationTimers.get(threadId));
    const timer = setTimeout(() => {
      if (this.tipConversations.get(threadId)?.updatedAt === updatedAt) this.tipConversations.delete(threadId);
      this.tipConversationTimers.delete(threadId);
    }, TIP_CONVERSATION_TTL_MS);
    timer.unref?.();
    this.tipConversationTimers.set(threadId, timer);
  }

  async #warrantedTip(providers) {
    const mode = this.config.defaults?.mode ?? "consult";
    const requestedProvider = this.config.defaults?.provider ?? "threadspan";
    let route;
    try {
      route = this.registry.resolveRoute({ mode, providerId: requestedProvider, model: this.config.defaults?.model ?? "auto", accountId: this.config.defaults?.accountId });
    } catch {
      route = { providerId: requestedProvider };
    }
    const routeMap = await this.registry.routeMap(providers);
    const selected = providers.find((item) => item.id === route.providerId);
    const candidates = routeMap.edges.filter((edge) => edge.mode === mode && edge.provider !== route.providerId).slice(0, 2);
    return selectTip({
      mode,
      routeVerified: selected?.health?.status === "available",
      qualifiedFallbackCount: candidates.filter((edge) => routeMap.nodes.find((node) => node.id === edge.provider)?.availability !== "unavailable").length,
      compatibilityChanged: summarizeCompatibility(this.config.compatibilityWatch, this.compatibilityReport).changed === true,
    });
  }

  /** Throw when a caller uses a closed service. */
  #assertOpen() {
    if (this.closed) throw new Error("BridgeService is closed");
  }
}

function usageEvidence(metadata) {
  const grok = metadata?.grokBuild ?? {};
  const worker = metadata?.codexWorker ?? metadata?.codexNativeWorker ?? {};
  const upstream = metadata?.upstream ?? {};
  const costTicks = Number.isSafeInteger(grok.totalCostUsdTicks)
    ? grok.totalCostUsdTicks
    : Number.isFinite(upstream.cost) && upstream.cost >= 0
      ? Math.round(upstream.cost * 10_000_000_000)
      : undefined;
  return {
    evidenceClass: "live-provider",
    ...(costTicks === undefined ? {} : { costTicks }),
    ...(worker.process ? { processCount: 1 } : {}),
    ...(Number.isSafeInteger(grok.actualTurns) ? { turnCount: grok.actualTurns } : {}),
  };
}

function publicBranchingPolicy(config = {}) {
  return {
    enabled: config.enabled === true,
    automaticRecognition: config.automaticRecognition === true,
    activationReasons: [...(config.activationReasons ?? [])],
    routingFactors: [...(config.routingFactors ?? [])],
    limits: {
      maxBranches: config.maxBranches,
      maxTurnsPerBranch: config.maxTurnsPerBranch,
      maxCostUsd: config.maxCostUsd,
    },
    stopOnConvergence: config.stopOnConvergence === true,
    nativeDefaults: config.nativeDefaults,
    toolPolicy: config.toolPolicy,
    imageDivergenceTool: config.imageDivergenceTool,
    synthesisOwner: config.synthesisOwner,
    note: "Branch only when independent evidence, genuine ideation divergence, or disjoint writes justify coordination cost; tool/plugin availability alone is never a trigger.",
  };
}

function publicConnectionRecoveryPolicy(config = {}) {
  return {
    bounds: {
      maxReconnectAttempts: config.maxReconnectAttempts,
      maxRebindAttempts: config.maxRebindAttempts,
      maxHandleAudits: config.maxHandleAudits,
    },
    preserveResumableState: config.preserveResumableState === true,
    staleDetection: { processes: config.detectStaleProcesses === true, config: config.detectStaleConfig === true },
    auditHandlesOnParentInterruption: config.auditHandlesOnParentInterruption === true,
    requireAdapterSpecificRecovery: config.requireAdapterSpecificRecovery === true,
    reroutePolicy: config.reroutePolicy,
    reauthPolicy: config.reauthPolicy,
    note: "Pre-output transport/auth failures and mid-turn provider failures remain distinct. Recovery and rollback stay adapter-specific; generic unavailable status is not recovery authority.",
  };
}

function publicSelfHealPolicy(config = {}) {
  return {
    enabled: config.enabled === true,
    subsystemOwner: config.subsystemOwner ?? "compatibility-watch",
    maxAnalysisDepth: config.maxAnalysisDepth,
    phases: [...(config.phases ?? [])],
    immediateRecoveryFirst: config.immediateRecoveryFirst === true,
    stopAfterMetaMeta: config.stopAfterMetaMeta === true,
    requirements: {
      owner: config.requireConcreteOwner === true,
      evidence: config.requireEvidence === true,
      regression: config.requireRegression === true,
      hostRollout: config.requireHostRollout === true,
      rollbackOrExpiryWhenRelevant: config.requireRollbackOrExpiryWhenRelevant === true,
    },
    updateRecognizerAndProcess: config.updateRecognizerAndProcess === true,
    analyzeRetryChurn: config.analyzeRetryChurn === true,
    contribution: {
      policy: config.contributionPolicy,
      destinations: [...(config.proposalDestinations ?? [])],
      requiredEvidence: [...(config.requiredProposalEvidence ?? [])],
      localMonitorReview: config.localMonitorReview,
      localApplyAfterAcceptance: config.localApplyAfterAcceptance === true,
      sanitizeMachineLocalData: config.sanitizeMachineLocalData === true,
      autoMerge: config.autoMerge === true,
    },
    note: "Compatibility Watch detects app/provider drift, restores compatibility, runs bounded direct/meta/meta-meta hardening, and produces reviewed sanitized issue/PR proposals.",
  };
}

function classifyConnectionFailure(error, state) {
  const upstream = error.details?.upstream ?? error.details ?? {};
  const message = String(error.message ?? "");
  const upstreamClass = [upstream?.kind, upstream?.code, upstream?.retryPolicy, upstream?.cause]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(" ");
  if (state.parentInterrupted) {
    return {
      class: "parent-turn-interruption",
      stage: state.meaningfulOutput || state.observedSideEffect ? "mid-turn" : "pre-output",
      providerHealth: "interrupted",
      accountHealth: "unknown",
      transportHealth: "audit-required",
      safeReroute: false,
      recovery: "audit-provider-handles-before-resume-or-retry",
    };
  }
  if (state.meaningfulOutput || state.observedSideEffect) {
    return {
      class: "mid-turn-provider-failure",
      stage: "mid-turn",
      providerHealth: "degraded",
      accountHealth: "unknown",
      transportHealth: "unknown-after-output",
      safeReroute: false,
      recovery: "preserve-resumable-state-and-use-adapter-specific-resume-or-rollback",
    };
  }
  if ([401, 403].includes(error.status) || /\b(?:auth|credential|sign[ -]?in|login|token)\b/i.test(message)) {
    return {
      class: "pre-output-auth-failure",
      stage: "pre-output",
      providerHealth: "unknown",
      accountHealth: "reauth-required",
      transportHealth: "not-authorized",
      safeReroute: "existing-privacy-account-authority-gates-only",
      recovery: "reauthenticate-through-provider-native-profile-then-rebind-same-account",
    };
  }
  if (error.status === 408 || error.status >= 500 || /\b(?:transport|timeout|connection|socket|spawn|network)\b/i.test(`${message} ${upstreamClass}`)) {
    return {
      class: "pre-output-transport-failure",
      stage: "pre-output",
      providerHealth: "unknown",
      accountHealth: "unknown",
      transportHealth: "disconnected",
      safeReroute: "existing-privacy-account-authority-gates-only",
      recovery: "bounded-adapter-specific-reconnect-or-rebind",
    };
  }
  return {
    class: "pre-output-provider-failure",
    stage: "pre-output",
    providerHealth: "degraded",
    accountHealth: "unknown",
    transportHealth: "connected-or-unknown",
    safeReroute: "existing-privacy-account-authority-gates-only",
    recovery: "adapter-specific-diagnosis-required",
  };
}

function connectionKey(providerId, accountId) {
  return `${providerId}\u0000${accountId ?? UNKNOWN_ACCOUNT_ID}`;
}

function publishedTipModel(config, providers) {
  const policy = config?.modelRefinement;
  if (policy?.enabled !== true || policy.privacy !== "sanitized-tip-context-only") return null;
  if (typeof policy.provider !== "string" || typeof policy.model !== "string") return null;
  const provider = providers.find((item) => item.id === policy.provider);
  const liveModels = (provider?.models ?? []).map((item) => item?.id).filter(Boolean);
  if (provider?.health?.status !== "available" || provider.capabilities?.modes?.consult?.supported !== true || !liveModels.includes(policy.model)) return null;
  const ask = config.ask?.enabled === true
    ? {
        maxTurnsPerSession: config.ask.maxTurnsPerSession,
        maxOutputTokens: config.ask.maxOutputTokens,
        maxLatencyMs: config.ask.maxLatencyMs,
      }
    : null;
  return {
    provider: policy.provider,
    model: policy.model,
    maxCallsPerSession: policy.maxCallsPerSession,
    maxOutputTokens: policy.maxOutputTokens,
    maxLatencyMs: policy.maxLatencyMs,
    cooldownMs: policy.cooldownMs,
    ...(ask ? { ask } : {}),
    settings: {
      mode: "consult",
      accountRouting: "inherit-selected-provider-account",
      providerAndHostSettings: "inherit",
      privacy: "sanitized-tip-context-only",
      web: false,
      subagents: false,
    },
  };
}

function summarizeCompatibility(config, report) {
  if (config?.enabled !== true) return { status: "disabled", changed: false, products: [], changes: [] };
  if (!report) return { status: "loading", changed: false, products: [], changes: [] };
  const statuses = new Set(["ok", "attention", "error", "disabled", "unknown"]);
  const productStatuses = new Set(["detected", "missing", "error", "unknown"]);
  const changeKinds = new Set(["baseline", "changed", "removed"]);
  return {
    status: statuses.has(report.status) ? report.status : "unknown",
    changed: report.changed === true,
    observedAt: validIsoTimestamp(report.observedAt) ?? null,
    products: Array.isArray(report.products) ? report.products.slice(0, 12).flatMap((product) => {
      if (!product || typeof product !== "object" || Array.isArray(product)) return [];
      const id = safeCompatibilityText(product.id, 80);
      if (!id) return [];
      return [{
        id,
        label: safeCompatibilityText(product.label, 120) || id,
        status: productStatuses.has(product.status) ? product.status : "unknown",
        version: safeCompatibilityText(product.version, 120) || null,
      }];
    }) : [],
    changes: Array.isArray(report.changes) ? report.changes.slice(0, 20).flatMap((change) => {
      if (!change || typeof change !== "object" || Array.isArray(change)) return [];
      const productId = safeCompatibilityText(change.productId, 80);
      if (!productId || !changeKinds.has(change.kind)) return [];
      return [{ productId, kind: change.kind }];
    }) : [],
  };
}

function safeCompatibilityText(value, maximum) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "";
}

/** Conditionally publish validated provider links without adding account or quota state. */
function publicProviderWebMetadata(provider) {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return {};
  return Object.fromEntries(["officialUrl", "accountUrl", "usageUrl"]
    .filter((key) => typeof provider[key] === "string")
    .map((key) => [key, provider[key]]));
}

/** Publish the registry's executable model catalog without account labels or provider-private data. */
function publicPickerRoute(entry, provider) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string") return null;
  const metadata = entry.metadata && typeof entry.metadata === "object" && !Array.isArray(entry.metadata) ? entry.metadata : {};
  const mode = typeof metadata.bridge_mode === "string" ? metadata.bridge_mode : "";
  const providerId = typeof metadata.provider === "string" ? metadata.provider : "";
  const model = typeof metadata.upstream_model === "string" ? metadata.upstream_model : "";
  if (!mode || !providerId || !model) return null;
  const availability = ["available", "degraded", "unavailable", "unknown"].includes(metadata.availability)
    ? metadata.availability
    : "unknown";
  const contextWindow = Number(metadata.context_window);
  const reasoningLevels = Array.isArray(metadata.supported_reasoning_levels)
    ? metadata.supported_reasoning_levels.slice(0, 12).flatMap((level) => {
        if (typeof level === "string") return [{ effort: level.slice(0, 40), description: "" }];
        if (!level || typeof level !== "object" || Array.isArray(level) || typeof level.effort !== "string") return [];
        return [{ effort: level.effort.slice(0, 40), description: typeof level.description === "string" ? level.description.slice(0, 240) : "" }];
      })
    : [];
  return {
    id: entry.id,
    mode,
    provider: providerId,
    accountId: typeof metadata.account_id === "string" ? metadata.account_id.slice(0, 160) : UNKNOWN_ACCOUNT_ID,
    model,
    availability,
    catalogDegraded: metadata.catalog_degraded === true,
    configuredFallback: metadata.configured_fallback === true,
    ...(typeof metadata.catalog_reason === "string" ? { catalogReason: metadata.catalog_reason.slice(0, 240) } : {}),
    ...(typeof metadata.free === "boolean" ? { free: metadata.free } : {}),
    ...(Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    ...(reasoningLevels.length > 0 ? { supportedReasoningLevels: reasoningLevels } : {}),
    ...(typeof metadata.default_reasoning_level === "string" ? { defaultReasoningLevel: metadata.default_reasoning_level.slice(0, 40) } : {}),
    ...(metadata.images === true ? { images: true } : {}),
    ...publicProviderWebMetadata(provider),
  };
}

/** Keep authoritative quota facts separate, and collapse wholly unknown snapshots to null. */
function publishedQuota(quota) {
  if (!quota || typeof quota !== "object" || Array.isArray(quota)) return null;
  const hasNumber = [quota.allowance, quota.remaining].some((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const hasBoundary = [quota.resetAt, quota.renewalAt].some((value) => typeof value === "string" && Number.isFinite(Date.parse(value)));
  if (!hasNumber && !hasBoundary) return null;
  return {
    allowance: typeof quota.allowance === "number" && Number.isFinite(quota.allowance) && quota.allowance >= 0 ? quota.allowance : null,
    remaining: typeof quota.remaining === "number" && Number.isFinite(quota.remaining) && quota.remaining >= 0 ? quota.remaining : null,
    unit: typeof quota.unit === "string" ? quota.unit : null,
    resetAt: typeof quota.resetAt === "string" && Number.isFinite(Date.parse(quota.resetAt)) ? new Date(quota.resetAt).toISOString() : null,
    renewalAt: typeof quota.renewalAt === "string" && Number.isFinite(Date.parse(quota.renewalAt)) ? new Date(quota.renewalAt).toISOString() : null,
    source: typeof quota.source === "string" ? quota.source : "unspecified",
    observedAt: typeof quota.observedAt === "string" && Number.isFinite(Date.parse(quota.observedAt)) ? new Date(quota.observedAt).toISOString() : null,
  };
}

function continuationRouteChange(previousRecord, route) {
  const previous = [previousRecord.mode, previousRecord.providerId, previousRecord.accountId ?? UNKNOWN_ACCOUNT_ID, previousRecord.model].map((value) => String(value ?? ""));
  const next = [route.mode, route.providerId, route.accountId ?? UNKNOWN_ACCOUNT_ID, route.model].map((value) => String(value ?? ""));
  if (previous[0] === "" && previous[1] === "" && previous[2] === UNKNOWN_ACCOUNT_ID && previous[3] === "") return undefined;
  if (previous.every((value, index) => value === next[index])) return undefined;
  return { from: previous.join("/"), to: next.join("/") };
}

/** Require explicit provider evidence that a retryable failure preceded all output and side effects. */
function canSafelyFallbackAccount(error, state) {
  if (state.meaningfulOutput === true || state.observedSideEffect === true || error?.retryable !== true) return false;
  const upstream = error?.details?.upstream;
  const nativeUsageLimit = upstream?.kind === CODEX_NATIVE_USAGE_LIMIT_KIND
    && upstream.preOutput === true
    && upstream.noSideEffects === true
    && upstream.safeToFallbackBeforeOutput === true;
  return nativeUsageLimit || (state.mode !== "delegate" && upstream?.safeToFallbackBeforeOutput === true);
}

function canSafelyTakeoverProvider(error, state) {
  return canSafelyFallbackAccount(error, state);
}

function takeoverFrozen(route, request, workspace, profile = {}) {
  return {
    providerId: route.providerId,
    mode: route.mode,
    tools: Array.isArray(request.tools) ? request.tools.map((tool) => String(tool?.name ?? tool?.function?.name ?? tool?.type ?? "")).filter(Boolean).sort() : [],
    workspace: String(workspace ?? "no-workspace"),
    privacy: Number(profile.privacy ?? 0),
    context: Math.max(1, numberFromMetadata(request.metadata?.bridge_required_context_tokens) ?? 1),
    intelligence: Math.max(0, Number(profile.intelligence ?? 0)),
  };
}

function takeoverCandidate(route, frozen, quotaWindowId) {
  return {
    providerId: route.providerId,
    accountId: route.accountId,
    quotaWindowId,
    certifiedHealthy: route.certifiedHealthy === true || route.providerId === frozen.providerId,
    mode: route.mode,
    tools: route.mode === "integrated" ? frozen.tools : Array.isArray(route.takeoverTools) ? route.takeoverTools : [],
    workspace: frozen.workspace,
    privacy: Number(route.privacy ?? frozen.privacy),
    context: Math.max(frozen.context, Number(route.contextWindow ?? route.provider?.config?.contextWindow ?? frozen.context)),
    intelligence: Math.max(frozen.intelligence, Number(route.intelligence ?? frozen.intelligence)),
  };
}

function takeoverRouteKey(route) {
  return `${route.providerId}\0${route.accountId}`;
}

async function sanitizedMaximumUtilizationReadModel(controller) {
  if (!controller || typeof controller.readModel !== "function") return null;
  let raw;
  try { raw = await controller.readModel(); } catch { raw = {}; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const phases = new Set(["disabled", "idle", "maximum-utilization", "exhausted"]);
  const readiness = new Set(["disabled", "awaiting-native-quota", "native-quota-observed", "direct-exhaustion-observed", "active", "awaiting-exact-native-recovery", "native-recovery-confirmed", "owner-disabled"]);
  const counts = raw.counts && typeof raw.counts === "object" ? raw.counts : {};
  const statuses = raw.statuses && typeof raw.statuses === "object" ? raw.statuses : {};
  const outbox = statuses.outbox && typeof statuses.outbox === "object" ? statuses.outbox : {};
  const quota = raw.quota && typeof raw.quota === "object" ? raw.quota : {};
  const automatic = raw.automatic && typeof raw.automatic === "object" ? raw.automatic : {};
  const manual = raw.manual && typeof raw.manual === "object" ? raw.manual : {};
  return {
    phase: phases.has(raw.phase) ? raw.phase : "idle",
    readiness: readiness.has(raw.readiness) ? raw.readiness : "awaiting-native-quota",
    epoch: nonNegativeIntegerOrNull(raw.epoch),
    quota: {
      usedRatio: ratioOrNull(quota.usedRatio),
      observedAt: validIsoTimestamp(quota.observedAt) ?? null,
      resetAt: validIsoTimestamp(quota.resetAt) ?? null,
    },
    counts: {
      protectedTasks: nonNegativeIntegerOrNull(counts.protectedTasks) ?? 0,
      notices: nonNegativeIntegerOrNull(counts.notices) ?? 0,
      inboxPending: nonNegativeIntegerOrNull(counts.inboxPending) ?? 0,
      suspendedMonitors: nonNegativeIntegerOrNull(counts.suspendedMonitors) ?? 0,
      overruns: nonNegativeIntegerOrNull(counts.overruns) ?? 0,
      provisionalOutputs: nonNegativeIntegerOrNull(counts.provisionalOutputs) ?? 0,
    },
    statuses: {
      pendingActions: nonNegativeIntegerOrNull(outbox.pending) ?? 0,
      unsupportedActions: nonNegativeIntegerOrNull(outbox.unsupported) ?? 0,
      executedActions: nonNegativeIntegerOrNull(outbox.executed) ?? 0,
      manifest: ["not-requested", "requested"].includes(statuses.manifest) ? statuses.manifest : "not-requested",
      fastCanary: ["not-requested", "requested"].includes(statuses.fastCanary) ? statuses.fastCanary : "not-requested",
      recovery: ["unconfirmed", "confirmed"].includes(statuses.recovery) ? statuses.recovery : "unconfirmed",
    },
    automatic: {
      enabled: automatic.enabled === true,
      active: automatic.active === true,
      scope: automatic.scope && typeof automatic.scope === "object" ? {
        provider: String(automatic.scope.provider ?? "OpenAI Codex").slice(0, 80),
        account: String(automatic.scope.account ?? "selected account").slice(0, 80),
        bucket: String(automatic.scope.bucket ?? "native bucket").slice(0, 80),
      } : null,
    },
    manual: {
      active: manual.active === true,
      scope: manual.scope && ["provider", "app", "account"].includes(manual.scope.kind) && typeof manual.scope.label === "string"
        ? { kind: manual.scope.kind, label: manual.scope.label.slice(0, 80) }
        : null,
      manifestCount: nonNegativeIntegerOrNull(manual.manifestCount) ?? 0,
    },
  };
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function ratioOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
}

function nonNegativeIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function actionItemStateLocation(config) {
  const configPath = typeof config.configPath === "string" ? config.configPath : "";
  if (configPath && !/^<[^>]+>$/.test(configPath)) {
    return { path: join(dirname(configPath), "state", "action-items.json"), temporaryDirectory: null };
  }
  const temporaryDirectory = join(tmpdir(), `threadspan-action-items-${process.pid}-${createId("state")}`);
  return { path: join(temporaryDirectory, "action-items.json"), temporaryDirectory };
}

/** Project only the documented public action-item schema, even for injected stores. */
function sanitizeActionItemsReadModel(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sanitizeItem = (item, projectKey, projectLabel) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const handle = typeof item.handle === "string" && /^act_[0-9a-f]{32}$/.test(item.handle) ? item.handle : "";
    const status = ["open", "completed", "stale", "closed"].includes(item.status) ? item.status : "";
    const revision = Number.isSafeInteger(item.revision) && item.revision > 0 ? item.revision : 0;
    const title = safeActionItemText(item.title, 240);
    const summary = item.summary === null ? null : safeActionItemText(item.summary, 2_000);
    const createdAt = canonicalActionItemTimestamp(item.createdAt);
    const updatedAt = canonicalActionItemTimestamp(item.updatedAt);
    const completedAt = item.completedAt === null ? null : canonicalActionItemTimestamp(item.completedAt);
    if (!handle || !status || !revision || !title || summary === undefined || !createdAt || !updatedAt || completedAt === undefined) return null;
    return { handle, projectKey, projectLabel, title, summary, status, revision, createdAt, updatedAt, completedAt };
  };
  const globalSource = source.global && typeof source.global === "object" ? source.global.items : [];
  const globalItems = Array.isArray(globalSource)
    ? globalSource.slice(0, 500).map((item) => sanitizeItem(item, null, null)).filter(Boolean)
    : [];
  const projects = Array.isArray(source.projects) ? source.projects.slice(0, 200).flatMap((project) => {
    const key = safeActionItemKey(project?.key);
    const label = safeActionItemText(project?.label, 120);
    if (!key || !label || !Array.isArray(project?.items)) return [];
    const items = project.items.slice(0, 500).map((item) => sanitizeItem(item, key, label)).filter(Boolean);
    return [{ key, label, count: items.length, items }];
  }) : [];
  const returned = globalItems.length + projects.reduce((sum, project) => sum + project.items.length, 0);
  return {
    schemaVersion: 1,
    total: Math.min(1_000, Math.max(returned, Number.isSafeInteger(source.total) && source.total >= 0 ? source.total : 0)),
    global: { count: globalItems.length, items: globalItems },
    projects,
  };
}

function safeActionItemText(value, maximum) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function safeActionItemKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(value) ? value : "";
}

function canonicalActionItemTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value ? value : undefined;
}

function createMaximumUtilizationController(config, dependencies, logger) {
  if (config.maximumUtilization?.enabled !== true) return null;
  const journal = maximumUtilizationJournal(config, dependencies);
  return new MaximumUtilizationController({
    policy: config.maximumUtilization,
    journal,
    quotaAdapter: dependencies.codexNativeQuotaAdapter ?? new CodexNativeQuotaAdapter({ accountStore: dependencies.accountStore, config }),
    snapshotProvider: dependencies.maximumUtilizationSnapshotProvider,
    capabilities: dependencies.maximumUtilizationCapabilities,
    logger,
  });
}

function maximumUtilizationJournal(config, dependencies) {
  return dependencies.maximumUtilizationJournal ?? new MaximumUtilizationJournal({
    path: join(dirname(config.configPath), "state", "maximum-utilization.json"),
  });
}

/**
 * Validate the subset of Responses request fields required by this bridge.
 * @param {Record<string, any>} request Request.
 */
function validateResponseRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new RequestError("Request body must be an object");
  if (request.model !== undefined && typeof request.model !== "string") throw new RequestError("model must be a string");
  if (request.stream !== undefined && typeof request.stream !== "boolean") throw new RequestError("stream must be boolean");
  if (request.metadata !== undefined && (!request.metadata || typeof request.metadata !== "object" || Array.isArray(request.metadata))) {
    throw new RequestError("metadata must be an object");
  }
}

/**
 * Emit an event list sequentially to preserve stream ordering and backpressure.
 * @param {Array<Record<string, any>>} events Events.
 * @param {((event: Record<string, any>) => void|Promise<void>)|undefined} onEvent Event sink.
 * @returns {Promise<void>}
 */
async function emitAll(events, onEvent) {
  if (!onEvent) return;
  for (const event of events) await onEvent(event);
}

/**
 * Extract assistant text from final Responses output items.
 * @param {Array<Record<string, any>>} output Response output.
 * @returns {string}
 */
function extractOutputText(output) {
  return (output ?? []).filter((item) => item.type === "message").flatMap((item) => item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "").join("");
}

/**
 * Parse an optional timeout metadata value.
 * @param {unknown} value Metadata value.
 * @returns {number|undefined}
 */
function numberFromMetadata(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/** Parse a permissive boolean metadata value. */
function metadataBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Keep request-local intent material out of provider adapter metadata and wire extensions. */
function providerVisibleMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const { bridge_intent_brief: _intentBrief, bridge_intent_updates: _intentUpdates, ...visible } = metadata;
  return visible;
}

function canonicalRouteId(route) {
  return `${route.mode}/${route.providerId}/${route.accountId === UNKNOWN_ACCOUNT_ID ? "" : `@${route.accountId}/`}${route.model}`;
}

function shouldUseDesktopRouteSelection(request, selection) {
  if (!selection) return false;
  if (request.metadata?.bridge_provider || request.metadata?.bridge_account_id || request.metadata?.bridge_account) return false;
  return request.model === undefined || /^(consult|integrated|delegate)\/threadspan\/auto$/.test(request.model);
}

function desktopRouteInput(request, selection) {
  const modelMode = /^(consult|integrated|delegate)\//.exec(request.model ?? "")?.[1];
  return {
    mode: request.metadata?.bridge_mode ?? modelMode ?? selection.mode,
    providerId: selection.provider,
    accountId: selection.accountId,
    model: selection.model,
  };
}
