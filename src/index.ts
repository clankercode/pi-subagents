/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *   list_models          — LLM-callable: enumerate available models in the current registry
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { registerAbortResend } from "./abort-resend.js";
import { buildDetails, formatLifetimeTokens } from "./agent-details.js";
import { AgentManager } from "./agent-manager.js";
import { getAgentConversation, getCurrentExtensionAgentId, getCurrentExtensionDepth, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, steerAgent } from "./agent-runner.js";
import { buildAgentToolDescription, getModelLabelFromConfig } from "./agent-tool-description.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, isDefaultsDisabled, registerAgents, resolveType, setDefaultsDisabled } from "./agent-types.js";
import { formatOutputFileHint, limitText, MAX_RESULT_CHARS, MAX_VERBOSE_CHARS } from "./bounded-output.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { GroupJoinManager } from "./group-join.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { buildNotificationDetails, formatTaskNotification, registerSubagentNotificationRenderer } from "./notifications.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { type PeekOptions, peekAgentOutput } from "./peek.js";
import { SubagentScheduler } from "./schedule.js";
import { resolveStorePath, ScheduleStore } from "./schedule-store.js";
import { applyAndEmitLoaded, DEFAULT_WAIT_TIMEOUT_SECONDS, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { type AgentConfig, type AgentInvocation, type AgentRecord, type JoinMode, MAX_RECURSIVE_DEPTH, type NotificationDetails, type SubagentType } from "./types.js";
import { renderAgentCall, renderAgentResult, renderSteerCall, tailPreview } from "./ui/agent-tool-rendering.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  formatContextWindow,
  formatDuration,
  getDisplayName,
  getPromptModeLabel,
  type UICtx,
} from "./ui/agent-widget.js";
import type { WidgetAgentSnapshot, WidgetDisplayMode } from "./ui/agent-widget-tree.js";
import { menuSelect } from "./ui/menu-select.js";
import { showSchedulesMenu } from "./ui/schedule-menu.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.js";
import { formatWaitTimeout, raceWait, type WaitOutcome, waitTimeoutMessage } from "./wait.js";

// ---- Shared helpers ----

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by the background spawn path to track tool usage.
 */
export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const initialActivityDescription = "thinking…";
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    activityDescription: initialActivityDescription,
    activityDescriptionUpdatedAt: Date.now(),
  };

  const updateActivityDescription = () => {
    const next = describeActivity(state.activeTools, state.responseText);
    if (next !== state.activityDescription) {
      state.activityDescription = next;
      state.activityDescriptionUpdatedAt = Date.now();
    }
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      updateActivityDescription();
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      updateActivityDescription();
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

export default function (pi: ExtensionAPI) {
  const extensionDepth = getCurrentExtensionDepth();
  const extensionAgentId = getCurrentExtensionAgentId();
  const nextSubagentDepth = extensionDepth + 1;
  registerSubagentNotificationRenderer(pi);

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Abort + resend queued message (default F9) ----
  // Escape dumps the queue into the editor; this shortcut aborts and auto-sends
  // the queue as the next turn instead. General harness workaround. Read at
  // session start; the env var PI_ABORT_RESEND_KEY and the setting both override
  // the "f9" default (env > setting > default). A setting change applies next
  // session, like other start-time settings.
  let abortResendKey: string | undefined;

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Retry stash (recoverable Agent invocations) ----
  // On pre-spawn validation failures (model not found / out of scope / worktree
  // validation), the full invocation is stashed under a short handle so the
  // orchestrator can re-invoke via { retry: "<handle>", model: "<valid>" } and
  // pick a valid model/agent WITHOUT re-emitting the (expensive, uncached)
  // prompt. Session-scoped: cleared on session switch/shutdown. 10-min TTL.
  interface StashedInvocation {
    params: Record<string, unknown>;
    stashedAt: number;
  }
  const RETRY_TTL_MS = 10 * 60_000;
  const retryStash = new Map<string, StashedInvocation>();

  /** Prune expired retry handles. Called lazily on stash read/write. */
  function sweepRetryStash() {
    const cutoff = Date.now() - RETRY_TTL_MS;
    for (const [h, entry] of retryStash) {
      if (entry.stashedAt < cutoff) retryStash.delete(h);
    }
  }

  /** Stash an invocation (preserving a stable handle on re-stash). Returns the handle.
   *  `omit` drops the given keys from the stash (used when the failing field itself
   *  shouldn't be retried as-is — e.g. an `isolation` that just failed). */
  function stashInvocation(
    params: Record<string, unknown>,
    handle?: string,
    omit: string[] = [],
  ): string {
    sweepRetryStash();
    const h = handle ?? `retry-${randomUUID().slice(0, 8)}`;
    const copy: Record<string, unknown> = { ...params };
    for (const k of omit) delete copy[k];
    retryStash.set(h, { params: copy, stashedAt: Date.now() });
    return h;
  }

  /** Category of recoverable failure — drives the tailored retry hint. */
  type RetryKind = "model" | "subagent_type" | "isolation";

  /** Build a recoverable failure result whose retry hint matches the failure kind. */
  function retryableResult(handle: string, body: string, kind: RetryKind) {
    const tail = `\n\nYour prompt was saved — you do NOT need to retype the prompt. To continue, re-invoke the Agent tool with:`;
    const json = `  { "retry": "${handle}"${kindOverrideSnippet(kind)}}`;
    const isolationNote =
      kind === "isolation"
        ? `\n(The isolation that failed has been dropped for this handle, so retrying runs normally. If you have since fixed the repo — git init + commit — and want a worktree, add "isolation": "worktree".)`
        : "";
    return textResult(`${body}${tail}\n${json}${isolationNote}`);
  }

  /** The override snippet appended to the retry JSON, tailored to the failure kind. */
  function kindOverrideSnippet(kind: RetryKind): string {
    switch (kind) {
      case "model":
        return `, "model": "<a valid model from the list above>"`;
      case "subagent_type":
        return `, "subagent_type": "<a valid type from the list above>"`;
      case "isolation":
        return "";
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
    }, { deliverAs: "steer", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for a bounded preview; inspect the transcript file path for full output when needed.`,
          display: true,
          details,
        }, { deliverAs: "steer", triggerTurn: true });
      });
      widget.update();
    },
    30_000,
  );

  function widgetSnapshotFromEvent(payload: any): WidgetAgentSnapshot | undefined {
    if (!payload || typeof payload.id !== "string" || typeof payload.type !== "string") return undefined;
    return {
      id: payload.id,
      type: payload.type,
      description: String(payload.description ?? payload.type),
      status: String(payload.status ?? "running"),
      startedAt: typeof payload.startedAt === "number" ? payload.startedAt : Date.now(),
      completedAt: typeof payload.completedAt === "number" ? payload.completedAt : undefined,
      error: typeof payload.error === "string" ? payload.error : undefined,
      toolUses: typeof payload.toolUses === "number" ? payload.toolUses : 0,
      depth: typeof payload.depth === "number" ? payload.depth : undefined,
      parentAgentId: typeof payload.parentAgentId === "string" ? payload.parentAgentId : undefined,
      invocation: payload.invocation,
    };
  }

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      depth: record.depth,
      parentAgentId: record.parentAgentId,
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      invocation: record.invocation,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (currentBatchAgents.some(a => a.id === record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
      depth: record.depth,
      parentAgentId: record.parentAgentId,
      status: "running",
      startedAt: record.startedAt,
      toolUses: record.toolUses,
      invocation: record.invocation,
    });
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
      depth: record.depth,
      parentAgentId: record.parentAgentId,
    });
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  (globalThis as any)[MANAGER_KEY] = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  };

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;

  // ---- Subagent scheduler ----
  // Session-scoped: store is constructed inside session_start once sessionId
  // is available. Mirrors pi-chonky-tasks's session-scoped task store —
  // schedules reset on /new, restore on /resume.
  const scheduler = new SubagentScheduler();

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;  // sessionId not yet available — try again on next event
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      // Scheduling is non-essential — log and move on so the rest of the
      // extension keeps working if e.g. .pi/ is unwritable.
      console.warn("[pi-subagents] Failed to start scheduler:", err);
    }
  }

  // Capture ctx from session_start for RPC spawn handler + start the scheduler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted();
    widget.clearSnapshots();
    retryStash.clear();
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted();
    widget.clearSnapshots();
    retryStash.clear();
    scheduler.stop();
  });

  const { unsubPing: unsubPingRpc, unsubSpawn: unsubSpawnRpc, unsubStop: unsubStopRpc } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager,
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("subagents:ready", {});

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    unsubWidgetStarted?.();
    unsubWidgetCompleted?.();
    unsubWidgetFailed?.();
    currentCtx = undefined;
    delete (globalThis as any)[MANAGER_KEY];
    scheduler.stop();
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    retryStash.clear();
    manager.dispose();
  });

  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity);
  const upsertWidgetEventSnapshot = (payload: unknown) => {
    const snapshot = widgetSnapshotFromEvent(payload);
    if (snapshot) widget.upsertSnapshot(snapshot);
  };
  const unsubWidgetStarted = pi.events.on("subagents:started", upsertWidgetEventSnapshot);
  const unsubWidgetCompleted = pi.events.on("subagents:completed", upsertWidgetEventSnapshot);
  const unsubWidgetFailed = pi.events.on("subagents:failed", upsertWidgetEventSnapshot);

  // ---- Widget display configuration ----
  let widgetDisplayMode: WidgetDisplayMode = "auto";
  function getWidgetDisplayMode(): WidgetDisplayMode { return widgetDisplayMode; }
  function setWidgetDisplayMode(mode: WidgetDisplayMode): void {
    widgetDisplayMode = mode;
    widget.setDisplayMode(mode);
  }

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'async';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // Master switch for the schedule subagent feature. Defaults to enabled.
  // Read once at extension init (before tool registration) so the Agent tool's
  // param schema reflects the persisted setting. Runtime toggles via /agents
  // → Settings short-circuit the menu entry + the execute-time addJob path
  // immediately, but the schema-level removal only takes effect on next
  // extension load (next pi session). Documented in CHANGELOG/README.
  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  // ---- Scope models configuration ----
  // When enabled, subagent model choices are validated against `enabledModels`
  // from pi's settings — both global `<agentDir>/settings.json` and
  // project-local `<cwd>/.pi/settings.json` (project overrides global).
  // Off by default; opt-in via `/agents → Settings`. See docstring on
  // SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
  // policy and its rationale.
  let scopeModelsEnabled = false;
  function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
  function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from .pi/agents/*.md are
  // completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or subagents.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Wait timeout configuration ----
  // How long get_subagent_result wait:true blocks before returning current
  // status. Bounds the parent turn; the caller re-invokes to keep waiting.
  let waitTimeoutSeconds = DEFAULT_WAIT_TIMEOUT_SECONDS;
  function getWaitTimeoutSeconds(): number { return waitTimeoutSeconds; }
  function setWaitTimeoutSeconds(seconds: number): void {
    waitTimeoutSeconds = Math.min(3600, Math.max(30, Math.trunc(seconds)));
  }

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    widget.onTurnStart();
  });

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setWaitTimeoutSeconds,
      setAbortResendKey: (key: string) => { abortResendKey = key; },
      setWidgetDisplayMode,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // Register the abort+resend shortcut AFTER settings load so the persisted
  // key is honored (env > setting > "f9").
  registerAbortResend(pi, abortResendKey);

  // ---- Agent tool ----

  // Schedule param + its guideline are gated on `schedulingEnabled` (read once
  // at registration; flipping the setting later requires next pi session for
  // the schema to update). Defining the shape once and spreading it via Partial
  // preserves Type.Object's inference when present and produces a
  // `schedule`-free schema when absent — zero LLM-context cost in disabled mode.
  const scheduleParamShape = {
    schedule: Type.Optional(
      Type.String({
        description:
          'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
          'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
          'Forces background; incompatible with inherit_context and resume. Returns job ID.',
      }),
    ),
  };
  const scheduleParam: Partial<typeof scheduleParamShape> =
    isSchedulingEnabled() ? scheduleParamShape : {};

  const agentToolDescription = buildAgentToolDescription({
    mode: getToolDescriptionMode(),
    extensionDepth,
    schedulingEnabled: isSchedulingEnabled(),
  });

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "Agents always run in the background. You will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.Optional(
        Type.String({
          description: "The task for the agent to perform. OMIT this when retrying with a saved handle — it is preserved by the retry.",
        }),
      ),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.Optional(
        Type.String({
          description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available. OMIT when retrying (preserved by the handle) unless you want to override it.`,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      retry: Type.Optional(
        Type.String({
          description: "Retry handle returned by a recoverable failure (model not found / out of scope / worktree validation). Reloads your original prompt and settings so you don't retype them; pass `model` (and optionally `subagent_type`) to override what failed. Other params you pass override the stashed values.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork the parent conversation into the agent so it sees the chat history. Recommended for questions or requests that require current context. Default: false (fresh context).",
        }),
      ),
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description: 'Set to "worktree" to run the agent in a temporary git worktree that is automatically created from the current repo state at HEAD and removed on completion. Changes are saved to a branch. Requires the working directory to be a git repo with at least one commit.',
        }),
      ),
      ...scheduleParam,
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      return renderAgentCall(args, theme);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      return renderAgentResult(result, { expanded, isPartial }, theme);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new .pi/agents/*.md files are picked up without restart
      reloadCustomAgents();

      const emitPromptPreview = (prompt: string | undefined, description: string | undefined, subagentType?: string) => {
        if (!prompt?.trim()) return;
        const displayName = subagentType && resolveType(subagentType as SubagentType)
          ? getDisplayName(resolveType(subagentType as SubagentType)!)
          : "Agent";
        onUpdate?.(textResult("", {
          displayName,
          description: description ?? "",
          subagentType: subagentType ?? "Agent",
          toolUses: 0,
          tokens: "",
          durationMs: 0,
          status: "running",
          activity: `Prompt: ${tailPreview(prompt)}`,
          spinnerFrame: 0,
        }));
      };

      // ---- Retry: reload a stashed invocation, overlaying any newly-passed params ----
      // `P` is the effective params object used for all spawn-relevant reads below.
      // `retryHandle` is preserved across repeated failures so one handle retries N times.
      let retryHandle: string | undefined;
      let P: typeof params = params;
      if (params.retry) {
        sweepRetryStash();
        const stashed = retryStash.get(params.retry);
        if (!stashed) {
          return textResult(
            `Retry handle "${params.retry}" was not found or has expired. ` +
            `Re-invoke the Agent tool directly with your prompt and a valid model.`,
          );
        }
        retryHandle = params.retry;
        const { retry: _omit, ...overrides } = params;
        P = { ...stashed.params, ...overrides } as typeof params;
      }
      emitPromptPreview(P.prompt, P.description, P.subagent_type);

      // Retry supplied the prompt/type from the stash; otherwise both are required.
      if (!retryHandle && (!P.prompt || !P.subagent_type)) {
        return textResult(
          `Missing required argument${!P.prompt && !P.subagent_type ? "s" : ""}: ` +
          [!P.prompt && "prompt", !P.subagent_type && "subagent_type"].filter(Boolean).join(", ") +
          ".",
        );
      }

      const rawType = P.subagent_type as SubagentType;
      const resolved = resolveType(rawType);
      if (!resolved) {
        // Unknown agent type — recoverable. List valid types so the orchestrator
        // can retry (overlaying subagent_type) without re-typing the prompt.
        const valid = getAvailableTypes();
        const list = valid.length > 0 ? valid.join(", ") : "(none — define one in .pi/agents/*.md)";
        const h = stashInvocation(P, retryHandle);
        return retryableResult(h, `Unknown agent type "${rawType}". Available types: ${list}.`, "subagent_type");
      }
      const subagentType = resolved;

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, P);

      // Resolve model from agent config first; tool-call params only fill gaps.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) {
            // Caller-supplied model not found — stash the invocation so the
            // orchestrator can retry with a valid model without re-typing the prompt.
            const h = stashInvocation(P, retryHandle);
            return retryableResult(h, resolved, "model");
          }
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list (read in `enabled-models.ts`).
      //
      // Design: scopeModels guards against *runtime* LLM choices, not user-level config.
      //   - Caller-supplied out-of-scope → hard error (the orchestrator made an explicit
      //     out-of-scope choice; surface it so it picks differently).
      //   - Frontmatter-pinned or parent-inherited out-of-scope → warn but proceed (the
      //     user authored/installed this agent or chose the parent's model; trust it).
      // See SubagentsSettings.scopeModels docstring for the full policy.
      if (isScopeModelsEnabled() && model) {
        const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
        if (allowed && !isModelInScope(model, allowed)) {
          if (resolvedConfig.modelFromParams) {
            const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
            const h = stashInvocation(P, retryHandle);
            return retryableResult(
              h,
              `Model not in scope: "${resolvedConfig.modelInput}".\n\nAllowed models (from enabledModels):\n${list}`,
              "model",
            );
          }
          // Frontmatter-pinned or parent-inherited: warn + proceed.
          const agentLabel = customConfig?.displayName ?? subagentType;
          const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
          ctx.ui.notify(
            `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
            "warning",
          );
        }
      }

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const modelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        thinking,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        isolation,
        depth: nextSubagentDepth,
        parentAgentId: extensionAgentId,
        maxDepth: MAX_RECURSIVE_DEPTH,
      };
      // Tool-result render shows the mode label too; viewer's header already does.
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: P.description,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // ---- Schedule: register a job, don't spawn now ----
      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            subagent_type: subagentType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking: thinking,
            max_turns: effectiveMaxTurns,
            isolated: isolated,
            isolation: isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }
        const { state, callbacks } = createActivityTracker(effectiveMaxTurns);
        const record = manager.resume(params.resume, params.prompt!, { signal, ...callbacks });
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        agentActivity.set(record.id, state);
        widget.ensureTimer();
        widget.update();
        const resumeDetails = { displayName: getDisplayName(record.type), description: record.description, subagentType: record.type, modelName: record.invocation?.modelName };
        return textResult(
          `Agent resumed in background.\nAgent ID: ${record.id}\nType: ${resumeDetails.displayName}\nDescription: ${record.description}\n\n` +
          `You will be notified when this agent completes.\nUse get_subagent_result to inspect bounded result previews, or steer_subagent to send it messages.\nDo not duplicate this agent's work.`,
          buildDetails(resumeDetails, record, state, { status: "background" }),
        );
      }

      // Background execution
      const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

      // Wrap onSessionCreated to wire output file streaming.
      // The callback lazily reads record.outputFile (set right after spawn)
      // rather than closing over a value that doesn't exist yet.
      let id: string;
      const origBgOnSession = bgCallbacks.onSessionCreated;
      bgCallbacks.onSessionCreated = (session: any) => {
        origBgOnSession(session);
        const rec = manager.getRecord(id);
        if (rec?.outputFile) {
          rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
        }
      };

      try {
        id = manager.spawn(pi, ctx, subagentType, P.prompt!, {
          description: P.description,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          depth: nextSubagentDepth,
          parentAgentId: extensionAgentId,
          outputFileForAgent: (agentId) => createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId()),
          onOutputFileCreated: (outputFile, agentId) => writeInitialEntry(outputFile, agentId, P.prompt!, ctx.cwd),
          ...bgCallbacks,
        });
      } catch (err) {
        // Pre-spawn failure (typically strict worktree-isolation). Stash WITHOUT
        // isolation so a plain retry safely runs normally; the tailored hint tells
        // the orchestrator how to re-add isolation once the repo is ready.
        const h = stashInvocation(P, retryHandle, ["isolation"]);
        return retryableResult(h, err instanceof Error ? err.message : String(err), "isolation");
      }

      // Set join mode synchronously after spawn. The output file path is
      // attached inside AgentManager.spawn(), before the agent can complete.
      const joinMode = resolveJoinMode(defaultJoinMode);
      const record = manager.getRecord(id);
      if (record) {
        record.joinMode = joinMode;
        record.toolCallId = toolCallId;
      }

      if (joinMode === 'async') {
        // No join mode or explicit async — not part of any batch
      } else {
        // smart or group — add to current batch
        currentBatchAgents.push({ id, joinMode });
        // Debounce: reset timer on each new agent so parallel tool calls
        // dispatched across multiple event loop ticks are captured together
        if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
        batchFinalizeTimer = setTimeout(finalizeBatch, 100);
      }

      agentActivity.set(id, bgState);
      widget.ensureTimer();
      widget.update();

      // Emit created event
      pi.events.emit("subagents:created", {
        id,
        type: subagentType,
        description: P.description,
        isBackground: true,
        depth: record?.depth ?? nextSubagentDepth,
        parentAgentId: extensionAgentId,
      });

      const isQueued = record?.status === "queued";
      return textResult(
        `Agent ${isQueued ? "queued" : "started"} in background.\nAgent ID: ${id}\nType: ${displayName}\nDescription: ${P.description}\n` +
        (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
        `\nYou will be notified when this agent completes.\nUse get_subagent_result to inspect bounded result previews, or steer_subagent to send it messages.\nDo not duplicate this agent's work.`,
        { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
      );
    },
  }));

  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: `If true, block until the agent completes before returning. Blocks up to the configured wait timeout (${formatWaitTimeout(getWaitTimeoutSeconds())} by default); if the agent is still running when the timeout is reached, returns its current status — call again with wait: true to keep waiting. Interruptible by the parent turn. Default: false.`,
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include a bounded preview of the agent's conversation (messages + tool calls). Default: false.",
        }),
      ),
      peek: Type.Optional(
        Type.Object({
          lines: Type.Optional(Type.Number({ minimum: 1, description: "Number of trailing lines to return. Default: 20." })),
          regex: Type.Optional(Type.String({ description: "Optional regex filter applied to each source line (filter-then-tail). Only matching lines are returned." })),
          after: Type.Optional(Type.Number({ minimum: 0, description: "Return all source lines after this line number (1-based, matching the [N] prefixes). Use the last [N] you saw to fetch only new lines without missing anything. Overrides `lines`." })),
        }, {
          description: "Return a lightweight tail/filter view of the agent's result or live output file, with line numbers. Ignored when verbose is true.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      // PEEK — lightweight view; ignored when verbose is true.
      if (params.peek && !params.verbose) {
        const peek = peekAgentOutput(record, params.peek as PeekOptions);
        return textResult(
          peek
            ? `${peek.text}\n\n---\nUse verbose: true for a bounded conversation preview, or omit peek for a bounded result preview.`
            : "No output yet for this agent.",
        );
      }

      // WAIT — race the agent's completion against the configured timeout and
      // the parent abort signal. On timeout/abort we return current status
      // WITHOUT aborting the subagent (background agents are detached).
      let waitOutcome: WaitOutcome = "completed";
      if (params.wait && record.status === "running" && record.promise) {
        cancelNudge(params.agent_id);
        waitOutcome = await raceWait(record.promise, signal, getWaitTimeoutSeconds());
        if (waitOutcome === "completed") {
          record.resultConsumed = true;
        }
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n` +
        (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        `\n`;

      if (record.status === "running") {
        // The wait returned while the agent was still running (timeout or abort).
        output += waitTimeoutMessage(waitOutcome, getWaitTimeoutSeconds());
      } else if (record.status === "error") {
        const limited = limitText(record.error ?? "unknown", MAX_RESULT_CHARS);
        output += `Error: ${limited.text}`;
        if (limited.truncated) {
          output += `\n\n---\nError truncated: omitted ${limited.omittedChars} chars. Inspect the output file for the full error when available.${formatOutputFileHint(record.outputFile)}`;
        }
      } else {
        const resultText = record.result?.trim() || "No output.";
        const limited = limitText(resultText, MAX_RESULT_CHARS);
        output += limited.text;
        if (limited.truncated) {
          output += `\n\n---\nResult truncated: omitted ${limited.omittedChars} chars. Use peek for targeted retrieval, or inspect the output file for the full log.${formatOutputFileHint(record.outputFile)}`;
        }
      }

      // Mark result as consumed — suppresses the completion notification
      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        cancelNudge(params.agent_id);
      }

      // Verbose: include a bounded conversation preview
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          const limited = limitText(conversation, MAX_VERBOSE_CHARS);
          output += `\n\n--- Agent Conversation ---\n${limited.text}`;
          if (limited.truncated) {
            output += `\n\n---\nAgent conversation truncated: omitted ${limited.omittedChars} chars. Use peek for targeted retrieval, or inspect the output file for the full log.${formatOutputFileHint(record.outputFile)}`;
          }
        }
      }

      return textResult(output);
    },
  }));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    renderCall(args, theme) {
      return renderSteerCall(args, theme);
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));

  // ---- list_models tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.LIST_MODELS,
    label: "List Models",
    description:
      "List every model available in the current session's model registry (the same set the `model:` param on Agent accepts). " +
      "Returns one model per line as `provider/id (name)` with the active model marked. " +
      "Useful when dispatching work and you want to pick a model explicitly, or to confirm a model name before passing it to `model:`.",
    promptSnippet: "Enumerate available models in the current registry",
    parameters: Type.Object({
      provider: Type.Optional(
        Type.String({
          description: "Optional provider name filter (case-insensitive). When set, only models from that provider are returned.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const registry = ctx.modelRegistry as ModelRegistry | undefined;
      if (!registry) {
        return textResult("No model registry is available in the current session.");
      }
      const all = ((registry.getAvailable?.() ?? registry.getAll()) ?? []) as Array<{
        id: string;
        name: string;
        provider: string;
        contextWindow?: number;
        reasoning?: boolean;
      }>;
      const providerFilter = params.provider?.trim().toLowerCase();
      const filtered = providerFilter
        ? all.filter((m) => m.provider.toLowerCase() === providerFilter)
        : all;
      if (filtered.length === 0) {
        return textResult(
          providerFilter
            ? `No models available for provider "${params.provider}". Available providers: ${[...new Set(all.map((m) => m.provider))].sort().join(", ") || "(none)"}.`
            : "No models are available in the current registry.",
        );
      }
      const currentId = (ctx.model as { id?: string } | undefined)?.id;
      const currentProvider = (ctx.model as { provider?: string } | undefined)?.provider;
      const sorted = [...filtered].sort((a, b) =>
        a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider),
      );
      const lines = sorted.map((m) => {
        const isCurrent = currentId === m.id && (!currentProvider || currentProvider === m.provider);
        const ctxInfo = m.contextWindow ? ` · ctx ${formatContextWindow(m.contextWindow)}` : "";
        const reasoning = m.reasoning ? " · reasoning" : "";
        const marker = isCurrent ? "* " : "  ";
        return `${marker}${m.provider}/${m.id} (${m.name})${ctxInfo}${reasoning}`;
      });
      const header = `${sorted.length} model${sorted.length === 1 ? "" : "s"} available${providerFilter ? ` for provider "${params.provider}"` : ""}${currentId ? " — * = active" : ""}:`;
      return textResult(`${header}\n${lines.join("\n")}`);
    },
  }));

  // ---- /agents interactive menu ----

  const projectAgentsDir = () => join(process.cwd(), ".pi", "agents");
  const personalAgentsDir = () => join(getAgentDir(), "agents");

  /** Find the file path of a custom agent by name (project first, then global). */
  function findAgentFile(name: string): { path: string; location: "project" | "personal" } | undefined {
    const projectPath = join(projectAgentsDir(), `${name}.md`);
    if (existsSync(projectPath)) return { path: projectPath, location: "project" };
    const personalPath = join(personalAgentsDir(), `${name}.md`);
    if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
    return undefined;
  }

  function getModelLabel(type: string, registry?: ModelRegistry): string {
    const cfg = getAgentConfig(type);
    if (!cfg?.model) return "inherit";
    // If registry provided, check if the model actually resolves
    if (registry) {
      const resolved = resolveModel(cfg.model, registry);
      if (typeof resolved === "string") return "inherit"; // model not available
    }
    return getModelLabelFromConfig(cfg.model);
  }

  async function showAgentsMenu(ctx: ExtensionCommandContext) {
    reloadCustomAgents();
    const allNames = getAllTypes();

    // Build select options
    const options: string[] = [];

    // Running agents entry (only if there are active agents)
    const agents = manager.listAgents();
    if (agents.length > 0) {
      const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
      const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
      options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
    }

    // Agent types list
    if (allNames.length > 0) {
      options.push(`Agent types (${allNames.length})`);
    }

    // Scheduled jobs entry (always present when scheduler is active)
    if (scheduler.isActive()) {
      const jobCount = scheduler.list().length;
      options.push(`Scheduled jobs (${jobCount})`);
    }

    // Actions
    options.push("Create new agent");
    options.push("Settings");

    const noAgentsMsg = allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

    if (noAgentsMsg) {
      ctx.ui.notify(noAgentsMsg, "info");
    }

    const choice = await menuSelect(ctx, { title: "Agents", options });
    if (!choice) return;

    if (choice.startsWith("Running agents (")) {
      await showRunningAgents(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Agent types (")) {
      await showAllAgentsList(ctx);
      await showAgentsMenu(ctx);
    } else if (choice.startsWith("Scheduled jobs (")) {
      await showSchedulesMenu(ctx, scheduler);
      await showAgentsMenu(ctx);
    } else if (choice === "Create new agent") {
      await showCreateWizard(ctx);
    } else if (choice === "Settings") {
      await showSettings(ctx);
      await showAgentsMenu(ctx);
    }
  }

  async function showAllAgentsList(ctx: ExtensionCommandContext) {
    const allNames = getAllTypes();
    if (allNames.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
    // Disabled agents get ✕ prefix
    const sourceIndicator = (cfg: AgentConfig | undefined) => {
      const disabled = cfg?.enabled === false;
      if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
      if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
      if (disabled) return "✕  ";
      return "   ";
    };

    const entries = allNames.map(name => {
      const cfg = getAgentConfig(name);
      const disabled = cfg?.enabled === false;
      const model = getModelLabel(name, ctx.modelRegistry);
      const indicator = sourceIndicator(cfg);
      const prefix = `${indicator}${name} · ${model}`;
      const desc = disabled ? "(disabled)" : (cfg?.description ?? name);
      return { name, prefix, desc };
    });
    const maxPrefix = Math.max(...entries.map(e => e.prefix.length));

    const hasCustom = allNames.some(n => { const c = getAgentConfig(n); return c && !c.isDefault && c.enabled !== false; });
    const hasDisabled = allNames.some(n => getAgentConfig(n)?.enabled === false);
    const legendParts: string[] = [];
    if (hasCustom) legendParts.push("• = project  ◦ = global");
    if (hasDisabled) legendParts.push("✕ = disabled");
    const legend = legendParts.length ? "\n" + legendParts.join("  ") : "";

    const options = entries.map(({ prefix, desc }) =>
      `${prefix.padEnd(maxPrefix)} — ${desc}`,
    );
    if (legend) options.push(legend);

    const choice = await menuSelect(ctx, { title: "Agent types", options });
    if (!choice) return;

    const agentName = choice.split(" · ")[0].replace(/^[•◦✕\s]+/, "").trim();
    if (getAgentConfig(agentName)) {
      await showAgentDetail(ctx, agentName);
      await showAllAgentsList(ctx);
    }
  }

  async function showRunningAgents(ctx: ExtensionCommandContext) {
    const agents = manager.listAgents();
    if (agents.length === 0) {
      ctx.ui.notify("No agents.", "info");
      return;
    }

    const options = agents.map(a => {
      const dn = getDisplayName(a.type);
      const dur = formatDuration(a.startedAt, a.completedAt);
      return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
    });

    const choice = await menuSelect(ctx, { title: "Running agents", options });
    if (!choice) return;

    // Find the selected agent by matching the option index
    const idx = options.indexOf(choice);
    if (idx < 0) return;
    const record = agents[idx];

    await viewAgentConversation(ctx, record);
    // Back-navigation: re-show the list
    await showRunningAgents(ctx);
  }

  async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord) {
    if (!record.session) {
      ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
      return;
    }

    const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./ui/conversation-viewer.js");
    const session = record.session;
    const activity = agentActivity.get(record.id);

    await ctx.ui.custom<undefined>(
      (tui, theme, keybindings, done) => {
        return new ConversationViewer(tui, session, record, activity, theme, done, () => {
          if (manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        }, keybindings);
      },
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      },
    );
  }

  async function showAgentDetail(ctx: ExtensionCommandContext, name: string) {
    const cfg = getAgentConfig(name);
    if (!cfg) {
      ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
      return;
    }

    const file = findAgentFile(name);
    const isDefault = cfg.isDefault === true;
    const disabled = cfg.enabled === false;

    let menuOptions: string[];
    if (disabled && file) {
      // Disabled agent with a file — offer Enable
      menuOptions = isDefault
        ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
        : ["Enable", "Edit", "Delete", "Back"];
    } else if (isDefault && !file) {
      // Default agent with no .md override
      menuOptions = ["Eject (export as .md)", "Disable", "Back"];
    } else if (isDefault && file) {
      // Default agent with .md override (ejected)
      menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
    } else {
      // User-defined agent
      menuOptions = ["Edit", "Disable", "Delete", "Back"];
    }

    const choice = await menuSelect(ctx, { title: name, options: menuOptions });
    if (!choice || choice === "Back") return;

    if (choice === "Edit" && file) {
      const content = readFileSync(file.path, "utf-8");
      const edited = await ctx.ui.editor(`Edit ${name}`, content);
      if (edited !== undefined && edited !== content) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file.path, edited, "utf-8");
        reloadCustomAgents();
        ctx.ui.notify(`Updated ${file.path}`, "info");
      }
    } else if (choice === "Delete") {
      if (file) {
        const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
        if (confirmed) {
          unlinkSync(file.path);
          reloadCustomAgents();
          ctx.ui.notify(`Deleted ${file.path}`, "info");
        }
      }
    } else if (choice === "Reset to default" && file) {
      const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
      if (confirmed) {
        unlinkSync(file.path);
        reloadCustomAgents();
        ctx.ui.notify(`Restored default ${name}`, "info");
      }
    } else if (choice.startsWith("Eject")) {
      await ejectAgent(ctx, name, cfg);
    } else if (choice === "Disable") {
      await disableAgent(ctx, name);
    } else if (choice === "Enable") {
      await enableAgent(ctx, name);
    }
  }

  /** Eject a default agent: write its embedded config as a .md file. */
  async function ejectAgent(ctx: ExtensionCommandContext, name: string, cfg: AgentConfig) {
    const location = await menuSelect(ctx, {
      title: "Choose location",
      options: [
        "Project (.pi/agents/)",
        `Personal (${personalAgentsDir()})`,
      ],
    });
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    // Build the .md file content
    const fmFields: string[] = [];
    fmFields.push(`description: ${JSON.stringify(cfg.description)}`);
    if (cfg.displayName) fmFields.push(`display_name: ${cfg.displayName}`);
    fmFields.push(`tools: ${cfg.builtinToolNames?.join(", ") || "all"}`);
    if (cfg.model) fmFields.push(`model: ${cfg.model}`);
    if (cfg.thinking) fmFields.push(`thinking: ${cfg.thinking}`);
    if (cfg.maxTurns) fmFields.push(`max_turns: ${cfg.maxTurns}`);
    fmFields.push(`prompt_mode: ${cfg.promptMode}`);
    if (cfg.extensions === false) fmFields.push("extensions: false");
    else if (Array.isArray(cfg.extensions)) fmFields.push(`extensions: ${cfg.extensions.join(", ")}`);
    if (cfg.excludeExtensions?.length) fmFields.push(`exclude_extensions: ${cfg.excludeExtensions.join(", ")}`);
    if (cfg.skills === false) fmFields.push("skills: false");
    else if (Array.isArray(cfg.skills)) fmFields.push(`skills: ${cfg.skills.join(", ")}`);
    if (cfg.disallowedTools?.length) fmFields.push(`disallowed_tools: ${cfg.disallowedTools.join(", ")}`);
    if (cfg.inheritContext) fmFields.push("inherit_context: true");
    if (cfg.isolated) fmFields.push("isolated: true");
    if (cfg.memory) fmFields.push(`memory: ${cfg.memory}`);
    if (cfg.isolation) fmFields.push(`isolation: ${cfg.isolation}`);

    const content = `---\n${fmFields.join("\n")}\n---\n\n${cfg.systemPrompt}\n`;

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
  }

  /** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
  async function disableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (file) {
      // Existing file — set enabled: false in frontmatter (idempotent)
      const content = readFileSync(file.path, "utf-8");
      if (content.includes("\nenabled: false\n")) {
        ctx.ui.notify(`${name} is already disabled.`, "info");
        return;
      }
      const updated = content.replace(/^---\n/, "---\nenabled: false\n");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
      return;
    }

    // No file (built-in default) — create a stub
    const location = await menuSelect(ctx, {
      title: "Choose location",
      options: [
        "Project (.pi/agents/)",
        `Personal (${personalAgentsDir()})`,
      ],
    });
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();
    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
  }

  /** Enable a disabled agent by removing enabled: false from its frontmatter. */
  async function enableAgent(ctx: ExtensionCommandContext, name: string) {
    const file = findAgentFile(name);
    if (!file) return;

    const content = readFileSync(file.path, "utf-8");
    const updated = content.replace(/^(---\n)enabled: false\n/, "$1");
    const { writeFileSync } = await import("node:fs");

    // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
    if (updated.trim() === "---\n---" || updated.trim() === "---\n---\n") {
      unlinkSync(file.path);
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
    } else {
      writeFileSync(file.path, updated, "utf-8");
      reloadCustomAgents();
      ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
    }
  }

  async function showCreateWizard(ctx: ExtensionCommandContext) {
    const location = await menuSelect(ctx, {
      title: "Choose location",
      options: [
        "Project (.pi/agents/)",
        `Personal (${personalAgentsDir()})`,
      ],
    });
    if (!location) return;

    const targetDir = location.startsWith("Project") ? projectAgentsDir() : personalAgentsDir();

    const method = await menuSelect(ctx, {
      title: "Creation method",
      options: [
        "Generate with Claude (recommended)",
        "Manual configuration",
      ],
    });
    if (!method) return;

    if (method.startsWith("Generate")) {
      await showGenerateWizard(ctx, targetDir);
    } else {
      await showManualWizard(ctx, targetDir);
    }
  }

  async function showGenerateWizard(ctx: ExtensionCommandContext, targetDir: string) {
    const description = await ctx.ui.input("Describe what this agent should do");
    if (!description) return;

    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    mkdirSync(targetDir, { recursive: true });

    const targetPath = join(targetDir, `${name}.md`);
    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    ctx.ui.notify("Generating agent definition...", "info");

    const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5-20251001". Omit to inherit parent model>
thinking: <optional thinking level: off, minimal, low, medium, high, xhigh. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Recommended for tasks needing current context. Default: false>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>
memory: <"user" (global), "project" (per-project), or "local" (gitignored per-project) for persistent memory. Omit for none>
isolation: <"worktree" to run in isolated git worktree. Omit for normal>
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

    const record = await manager.spawnAndWait(pi, ctx, "general-purpose", generatePrompt, {
      description: `Generate ${name} agent`,
      maxTurns: 5,
    });

    if (record.status === "error") {
      ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
      return;
    }

    reloadCustomAgents();

    if (existsSync(targetPath)) {
      ctx.ui.notify(`Created ${targetPath}`, "info");
    } else {
      ctx.ui.notify("Agent generation completed but file was not created. Check the agent output.", "warning");
    }
  }

  async function showManualWizard(ctx: ExtensionCommandContext, targetDir: string) {
    // 1. Name
    const name = await ctx.ui.input("Agent name (filename, no spaces)");
    if (!name) return;

    // 2. Description
    const description = await ctx.ui.input("Description (one line)");
    if (!description) return;

    // 3. Tools
    const toolChoice = await menuSelect(ctx, {
      title: "Tools",
      options: ["all", "none", "read-only (read, bash, grep, find, ls)", "custom..."],
    });
    if (!toolChoice) return;

    let tools: string;
    if (toolChoice === "all") {
      tools = BUILTIN_TOOL_NAMES.join(", ");
    } else if (toolChoice === "none") {
      tools = "none";
    } else if (toolChoice.startsWith("read-only")) {
      tools = "read, bash, grep, find, ls";
    } else {
      const customTools = await ctx.ui.input("Tools (comma-separated)", BUILTIN_TOOL_NAMES.join(", "));
      if (!customTools) return;
      tools = customTools;
    }

    // 4. Model
    const modelChoice = await menuSelect(ctx, {
      title: "Model",
      options: [
        "inherit (parent model)",
        "haiku",
        "sonnet",
        "opus",
        "custom...",
      ],
    });
    if (!modelChoice) return;

    let modelLine = "";
    if (modelChoice === "haiku") modelLine = "\nmodel: anthropic/claude-haiku-4-5-20251001";
    else if (modelChoice === "sonnet") modelLine = "\nmodel: anthropic/claude-sonnet-4-6";
    else if (modelChoice === "opus") modelLine = "\nmodel: anthropic/claude-opus-4-6";
    else if (modelChoice === "custom...") {
      const customModel = await ctx.ui.input("Model (provider/modelId)");
      if (customModel) modelLine = `\nmodel: ${customModel}`;
    }

    // 5. Thinking
    const thinkingChoice = await menuSelect(ctx, {
      title: "Thinking level",
      options: [
        "inherit",
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
      ],
    });
    if (!thinkingChoice) return;

    let thinkingLine = "";
    if (thinkingChoice !== "inherit") thinkingLine = `\nthinking: ${thinkingChoice}`;

    // 6. System prompt
    const systemPrompt = await ctx.ui.editor("System prompt", "");
    if (systemPrompt === undefined) return;

    // Build the file
    const content = `---
description: ${description}
tools: ${tools}${modelLine}${thinkingLine}
prompt_mode: replace
---

${systemPrompt}
`;

    mkdirSync(targetDir, { recursive: true });
    const targetPath = join(targetDir, `${name}.md`);

    if (existsSync(targetPath)) {
      const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
      if (!overwrite) return;
    }

    const { writeFileSync } = await import("node:fs");
    writeFileSync(targetPath, content, "utf-8");
    reloadCustomAgents();
    ctx.ui.notify(`Created ${targetPath}`, "info");
  }

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      schedulingEnabled: isSchedulingEnabled(),
      scopeModels: isScopeModelsEnabled(),
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      waitTimeoutSeconds: getWaitTimeoutSeconds(),
      abortResendKey: abortResendKey,
      widgetDisplayMode: getWidgetDisplayMode(),
    };
  }

  const NUMERIC_IDS = new Set(["maxConcurrent", "defaultMaxTurns", "graceTurns", "waitTimeoutSeconds"]);
  const TEXT_IDS = new Set(["abortResendKey"]);

  async function showSettings(ctx: ExtensionCommandContext) {
    function buildItems(): SettingItem[] {
      const mc = manager.getMaxConcurrent();
      const dmt = getDefaultMaxTurns() ?? 0;
      const gt = getGraceTurns();

      return [
        {
          id: "maxConcurrent",
          label: "Max concurrency",
          description: "Max concurrent background agents (Enter to type)",
          currentValue: String(mc),
          values: [String(mc)],
        },
        {
          id: "defaultMaxTurns",
          label: "Default max turns",
          description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
          currentValue: String(dmt),
          values: [String(dmt)],
        },
        {
          id: "graceTurns",
          label: "Grace turns",
          description: "Grace turns after wrap-up steer (Enter to type)",
          currentValue: String(gt),
          values: [String(gt)],
        },
        {
          id: "joinMode",
          label: "Join mode",
          description: "Default join mode for background agents",
          currentValue: getDefaultJoinMode(),
          values: ["smart", "async", "group"],
        },
        {
          id: "schedulingEnabled",
          label: "Scheduling",
          description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
          currentValue: isSchedulingEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "scopeModels",
          label: "Scope models",
          description: "Validate subagent models against scoped models (/scoped-models)",
          currentValue: isScopeModelsEnabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "disableDefaultAgents",
          label: "Disable defaults",
          description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
          currentValue: isDefaultsDisabled() ? "on" : "off",
          values: ["on", "off"],
        },
        {
          id: "toolDescriptionMode",
          label: "Tool description",
          description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
          currentValue: getToolDescriptionMode(),
          values: ["full", "compact", "custom"],
        },
        {
          id: "widgetDisplayMode",
          label: "Widget display",
          description: "Recursive subagent widget display: auto (rich with compact fallback), rich, or compact",
          currentValue: getWidgetDisplayMode(),
          values: ["auto", "rich", "compact"],
        },
        {
          id: "waitTimeoutSeconds",
          label: "Wait timeout",
          description: "Seconds get_subagent_result wait:true blocks before returning status (30–3600, Enter to type)",
          currentValue: String(getWaitTimeoutSeconds()),
          values: [String(getWaitTimeoutSeconds())],
        },
        {
          id: "abortResendKey",
          label: "Abort+resend key",
          description: "Key that aborts the current turn AND auto-sends queued message(s) as the next turn (vs Escape, which restores the queue to the editor). Default f9. Enter to type (e.g. f8, shift+escape). Applies next session.",
          currentValue: abortResendKey ?? "f9",
          values: [abortResendKey ?? "f9"],
        },
      ];
    }

    function applyValue(id: string, value: string) {
      if (id === "maxConcurrent") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          manager.setMaxConcurrent(n);
          notifyApplied(ctx, `Max concurrency set to ${n}`);
        }
      } else if (id === "defaultMaxTurns") {
        const n = parseInt(value, 10);
        if (n === 0) {
          setDefaultMaxTurns(undefined);
          notifyApplied(ctx, "Default max turns set to unlimited");
        } else if (n >= 1) {
          setDefaultMaxTurns(n);
          notifyApplied(ctx, `Default max turns set to ${n}`);
        }
      } else if (id === "graceTurns") {
        const n = parseInt(value, 10);
        if (n >= 1) {
          setGraceTurns(n);
          notifyApplied(ctx, `Grace turns set to ${n}`);
        }
      } else if (id === "joinMode") {
        setDefaultJoinMode(value as JoinMode);
        notifyApplied(ctx, `Default join mode set to ${value}`);
      } else if (id === "schedulingEnabled") {
        const enabled = value === "on";
        if (enabled === isSchedulingEnabled()) {
          ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        } else {
          setSchedulingEnabled(enabled);
          if (!enabled) scheduler.stop();  // immediate kill — outstanding fires stop ticking
          notifyApplied(
            ctx,
            `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          );
        }
      } else if (id === "scopeModels") {
        const enabled = value === "on";
        setScopeModelsEnabled(enabled);
        notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
      } else if (id === "disableDefaultAgents") {
        const enabled = value === "on";
        setDisableDefaultAgents(enabled);
        notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`);
      } else if (id === "toolDescriptionMode") {
        setToolDescriptionMode(value as ToolDescriptionMode);
        notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`);
      } else if (id === "widgetDisplayMode") {
        setWidgetDisplayMode(value as WidgetDisplayMode);
        notifyApplied(ctx, `Widget display set to ${value}`);
      } else if (id === "waitTimeoutSeconds") {
        const n = parseInt(value, 10);
        if (n >= 30 && n <= 3600) {
          setWaitTimeoutSeconds(n);
          notifyApplied(ctx, `Wait timeout set to ${formatWaitTimeout(n)}`);
        }
      } else if (id === "abortResendKey") {
        const key = value.trim();
        if (key) {
          abortResendKey = key;
          notifyApplied(ctx, `Abort+resend key set to ${key}. Takes effect on next pi session.`);
        }
      }
    }

    let list: SettingsList;
    // Track current selection index directly (SettingsList doesn't expose it).
    // Updated on arrow keys so Enter knows which field is selected immediately.
    let currentIndex = 0;

    const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
      const items = buildItems();

      list = new SettingsList(
        items,
        items.length + 2,
        getSettingsListTheme(),
        (id, newValue) => {
          applyValue(id, newValue);
        },
        () => done(undefined as undefined),
      );

      const container = new Container();
      container.addChild(new Text("⚙  Subagent Settings", 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(list);

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          // Back out of the settings menu (left arrow mirrors Esc)
          if (matchesKey(data, "left") || matchesKey(data, "escape")) {
            done(undefined as undefined);
            return;
          }

          // Track navigation so Enter knows the current field
          if (matchesKey(data, "up")) {
            currentIndex = Math.max(0, currentIndex - 1);
          } else if (matchesKey(data, "down")) {
            currentIndex = Math.min(items.length - 1, currentIndex + 1);
          }

          // Right arrow selects/activates the current item, just like Enter
          if (matchesKey(data, "right")) {
            const item = items[currentIndex];
            if (NUMERIC_IDS.has(item.id) || TEXT_IDS.has(item.id)) {
              done(item.id);
              return;
            }
            // For toggle items, SettingsList treats Space as activate
            list.handleInput?.(" ");
            return;
          }

          // Enter on numeric or text field → close and prompt for typed input
          if (matchesKey(data, Key.enter) && (NUMERIC_IDS.has(items[currentIndex].id) || TEXT_IDS.has(items[currentIndex].id))) {
            done(items[currentIndex].id);
            return;
          }
          list.handleInput?.(data);
        },
      };
    });

    // If a numeric field ID was returned, prompt for typed input
    if (result && NUMERIC_IDS.has(result)) {
      const current = result === "maxConcurrent"
        ? String(manager.getMaxConcurrent())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : result === "waitTimeoutSeconds"
            ? String(getWaitTimeoutSeconds())
            : String(getGraceTurns());

      const label = result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : result === "waitTimeoutSeconds"
            ? "Wait timeout seconds (30–3600)"
            : "Grace turns (1+)";

      // Loop until user enters a valid integer or cancels (Esc / null).
      // Silently trims whitespace; rejects non-numeric input by re-prompting.
      let input: string | undefined = await ctx.ui.input(label, current);
      while (input != null) {
        const trimmed = input.trim();
        const n = Number(trimmed);
        if (trimmed !== "" && Number.isInteger(n)) {
          applyValue(result, String(n));
          await showSettings(ctx);
          return;
        }
        // Invalid — re-prompt with the user's last entry so they can edit it
        input = await ctx.ui.input(label, trimmed);
      }
    } else if (result && TEXT_IDS.has(result)) {
      // Free-form text field (e.g. a key id). Prompt once; apply if non-empty.
      const current = result === "abortResendKey" ? (abortResendKey ?? "f9") : "";
      const label = "Abort+resend key (e.g. f9, f8, shift+escape)";
      const input = await ctx.ui.input(label, current);
      if (input != null && input.trim() !== "") {
        applyValue(result, input.trim());
        await showSettings(ctx);
      }
    }
  }

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });
}
