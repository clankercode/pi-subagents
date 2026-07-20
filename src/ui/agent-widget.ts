/**
 * agent-widget.ts — Persistent widget showing running/completed agents above the editor.
 *
 * Displays a tree of agents with animated spinners, live stats, and activity descriptions.
 * Uses the callback form of setWidget for themed rendering.
 */

import type { AgentManager } from "../agent-manager.js";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, SubagentType, WidgetMode } from "../types.js";
import type { LifetimeUsage, SessionLike } from "../usage.js";
import {
  renderAgentTree,
  type WidgetAgentSnapshot,
  type WidgetDisplayMode,
} from "./agent-widget-tree.js";

// ---- Constants ----

/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;
/** Default cap for the status-bar text before the widget knows the terminal width. */
const DEFAULT_STATUS_TEXT_WIDTH = 20;

/** Braille spinner frames for animated running indicator. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome (used for linger behavior and icon rendering). */
export const ERROR_STATUSES = new Set(["error", "aborted", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Lifetime usage breakdown — see LifetimeUsage docs. */
  lifetimeUsage: LifetimeUsage;
  /** Last rendered activity description and the time it became current. */
  activityDescription?: string;
  activityDescriptionUpdatedAt?: number;
}

/** Metadata attached to Agent tool results for custom rendering. */
export interface AgentDetails {
  displayName: string;
  description: string;
  subagentType: string;
  toolUses: number;
  tokens: string;
  durationMs: number;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error" | "background";
  /** Human-readable description of what the agent is currently doing. */
  activity?: string;
  /** Current spinner frame index (for animated running indicator). */
  spinnerFrame?: number;
  /** Short model name if different from parent (e.g. "haiku", "sonnet"). */
  modelName?: string;
  /** Notable config tags (e.g. ["thinking: high", "isolated"]). */
  tags?: string[];
  /** Current turn count. */
  turnCount?: number;
  /** Effective max turns (undefined = unlimited). */
  maxTurns?: number;
  agentId?: string;
  error?: string;
}

// ---- Formatting helpers ----

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
export function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
  const styledEmpty = theme.fg(color, "");
  const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
  return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, reset => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
  return `${count} token`;
}

/** Format a model context window: "200k", "1M". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/**
 * Token count with optional context-fill % and compaction-count annotations.
 * Thresholds for percent: <70% dim, 70–85% warning, ≥85% error.
 * Compaction count rendered as `⇊N` in dim.
 *
 *   "12.3k token"               — no annotations
 *   "12.3k token (45%)"         — percent only
 *   "12.3k token (⇊2)"          — compactions only (e.g. right after compact)
 *   "12.3k token (45% · ⇊2)"    — both
 */
export function formatSessionTokens(
  tokens: number,
  percent: number | null,
  theme: Theme,
  compactions = 0,
): string {
  const tokenStr = formatTokens(tokens);
  const annot: string[] = [];
  if (percent !== null) {
    const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
    annot.push(theme.fg(color, `${Math.round(percent)}%`));
  }
  if (compactions > 0) {
    annot.push(theme.fg("dim", `⇊${compactions}`));
  }
  if (annot.length === 0) return tokenStr;
  return `${tokenStr} (${annot.join(" · ")})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/**
 * Format milliseconds as a compact, humanized duration using the two largest
 * relevant units: "12.3s", "5m 12s", "1h 5m". A bare seconds value keeps one
 * decimal (matches the old output for sub-minute durations); larger units drop
 * decimals so "12m 3s" never reads "12.0m 3s".
 */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (totalMinutes < 60) return `${totalMinutes}m${seconds > 0 ? ` ${seconds}s` : ""}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
}

/** Format duration from start/completed timestamps. */
export function formatDuration(startedAt: number, completedAt?: number): string {
  if (completedAt) return formatMs(completedAt - startedAt);
  return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Get display name for any agent type (built-in or custom). */
export function getDisplayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

/** Short label for prompt mode: "twin" for append, nothing for replace (the default). */
export function getPromptModeLabel(type: SubagentType): string | undefined {
  const config = getConfig(type);
  return config.promptMode === "append" ? "twin" : undefined;
}

function truncatePlainText(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const max = Math.floor(width);
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Status bar text for the subagents entry, truncated to the available width. */
export function formatSubagentStatusText(
  runningCount: number,
  queuedCount: number,
  width = DEFAULT_STATUS_TEXT_WIDTH,
): string | undefined {
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (queuedCount > 0) parts.push(`${queuedCount} queued`);
  if (parts.length === 0) return undefined;
  const total = runningCount + queuedCount;
  return truncatePlainText(`${parts.join(", ")} agent${total === 1 ? "" : "s"}`, width);
}

/** Mode label is not included — callers add it where they want it. */
export function buildInvocationTags(
  invocation: AgentInvocation | undefined,
): { modelName?: string; tags: string[] } {
  const tags: string[] = [];
  if (!invocation) return { tags };
  if (invocation.thinking) tags.push(`thinking: ${invocation.thinking}`);
  if (invocation.isolated) tags.push("isolated");
  if (invocation.isolation === "worktree") tags.push("worktree");
  if (invocation.inheritContext) tags.push("inherit context");
  if (invocation.maxTurns != null) tags.push(`max turns: ${invocation.maxTurns}`);
  if (invocation.depth != null) tags.push(`depth: ${invocation.depth}/${invocation.maxDepth ?? 4}`);
  return { modelName: invocation.modelName, tags };
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
  const line = text.split("\n").find(l => l.trim())?.trim() ?? "";
  if (line.length <= len) return line;
  return line.slice(0, len) + "…";
}

/** Build a human-readable activity string from currently-running tools or response text. */
export function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
  if (activeTools.size > 0) {
    const groups = new Map<string, number>();
    for (const toolName of activeTools.values()) {
      const action = TOOL_DISPLAY[toolName] ?? toolName;
      groups.set(action, (groups.get(action) ?? 0) + 1);
    }

    const parts: string[] = [];
    for (const [action, count] of groups) {
      if (count > 1) {
        parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
      } else {
        parts.push(action);
      }
    }
    return parts.join(", ") + "…";
  }

  // No tools active — show truncated response text if available
  if (responseText && responseText.trim().length > 0) {
    return truncateLine(responseText);
  }

  return "thinking…";
}

export function describeActivityWithAge(
  activeTools: Map<string, string>,
  responseText?: string,
  updatedAt?: number,
  now = Date.now(),
): string {
  const activity = describeActivity(activeTools, responseText);
  if (updatedAt == null) return activity;
  return `${activity} · ${formatMs(now - updatedAt)}`;
}

// ---- Widget manager ----

export class AgentWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
  private finishedTurnAge = new Map<string, number>();
  /** Tracks wall-clock finish time so long-running turns cannot keep completed rows forever. */
  private finishedAt = new Map<string, number>();
  /** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
  private static readonly ERROR_LINGER_TURNS = 2;
  /** Max wall-clock linger for successful completions when no new parent turn starts. */
  private static readonly COMPLETED_LINGER_MS = 30_000;
  /** Max wall-clock linger for non-success outcomes when no new parent turn starts. */
  private static readonly ERROR_LINGER_MS = 120_000;

  /** Whether the widget callback is currently registered with the TUI. */
  private widgetRegistered = false;
  /** Cached TUI reference from widget factory callback, used for requestRender(). */
  private tui: any | undefined;
  /** Last status bar text, used to avoid redundant setStatus calls. */
  private lastStatusText: string | undefined;
  /** Descendant snapshots observed from recursive child managers. */
  private descendantSnapshots = new Map<string, WidgetAgentSnapshot>();
  /** User-selected widget display mode. */
  private displayMode: WidgetDisplayMode = "auto";

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Selects which agents the widget shows — see
     * `WidgetMode`. Defaults to `"all"` when a caller supplies no policy; the
     * extension supplies one defaulting to `"background"`.
     */
    private mode: () => WidgetMode = () => "all",
  ) {}

  setDisplayMode(mode: WidgetDisplayMode) {
    this.displayMode = mode;
    this.update();
  }

  /**
   * Agents eligible for the widget, per the current `WidgetMode`:
   *   - `off`: none (the widget's existing empty-state path hides it entirely).
   *   - `background`: drop only agents *known* to be foreground
   *     (`isBackground === false`); keep everything else — background, queued,
   *     scheduled, or RPC-spawned (`undefined`). Keying off the `isBackground`
   *     record flag rather than the UI-only `invocation` snapshot (which only the
   *     Agent-tool path sets), and excluding rather than allow-listing, means
   *     only proven-foreground runs drop out — nothing else silently vanishes.
   *   - `all`: every agent.
   */
  private widgetAgents() {
    const all = this.manager.listAgents();
    switch (this.mode()) {
      case "off": return [];
      case "background": return all.filter(a => a.isBackground !== false);
      default: return all;
    }
  }

  upsertSnapshot(snapshot: WidgetAgentSnapshot) {
    this.descendantSnapshots.set(snapshot.id, snapshot);
    if (snapshot.status === "running" || snapshot.status === "queued") {
      this.finishedTurnAge.delete(snapshot.id);
      this.finishedAt.delete(snapshot.id);
    } else {
      this.markFinished(snapshot.id, snapshot.completedAt);
    }
    this.update();
  }

  removeSnapshot(id: string) {
    this.descendantSnapshots.delete(id);
    this.finishedTurnAge.delete(id);
    this.finishedAt.delete(id);
    this.update();
  }

  clearSnapshots() {
    this.descendantSnapshots.clear();
    this.finishedTurnAge.clear();
    this.finishedAt.clear();
    this.update();
  }


  /** Set the UI context (grabbed from first tool execution). */
  setUICtx(ctx: UICtx) {
    if (ctx !== this.uiCtx) {
      // UICtx changed — the widget registered on the old context is gone.
      // Force re-registration on next update().
      this.uiCtx = ctx;
      this.widgetRegistered = false;
      this.tui = undefined;
      this.lastStatusText = undefined;
    }
  }

  /**
   * Called on each new turn (tool_execution_start).
   * Ages finished agents and clears those that have lingered long enough.
   */
  onTurnStart() {
    // Age all finished agents
    for (const [id, age] of this.finishedTurnAge) {
      this.finishedTurnAge.set(id, age + 1);
    }
    // Trigger a widget refresh (will filter out expired agents)
    this.update();
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), 80);
    }
  }

  /** Check if a finished agent should still be shown in the widget. */
  private shouldShowFinished(agentId: string, status: string, completedAt?: number): boolean {
    const age = this.finishedTurnAge.get(agentId) ?? 0;
    const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
    if (age >= maxAge) return false;

    const finishedAt = this.finishedAt.get(agentId) ?? completedAt;
    if (finishedAt == null) return true;
    const maxMs = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_MS : AgentWidget.COMPLETED_LINGER_MS;
    return Date.now() - finishedAt < maxMs;
  }

  /** Record an agent as finished (call when agent completes). */
  markFinished(agentId: string, completedAt = Date.now()) {
    if (!this.finishedTurnAge.has(agentId)) {
      this.finishedTurnAge.set(agentId, 0);
    }
    if (!this.finishedAt.has(agentId)) {
      this.finishedAt.set(agentId, completedAt);
    }
  }

  private recordToSnapshot(a: any): WidgetAgentSnapshot {
    const activity = this.agentActivity.get(a.id);
    return {
      id: a.id,
      type: a.type,
      description: a.description,
      status: a.status,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      error: a.error,
      toolUses: activity?.toolUses ?? a.toolUses ?? 0,
      depth: a.depth,
      parentAgentId: a.parentAgentId,
      invocation: a.invocation,
      activity,
    };
  }

  private visibleSnapshots(): WidgetAgentSnapshot[] {
    const merged = new Map(this.descendantSnapshots);
    const allAgents = this.widgetAgents();
    for (const a of allAgents) {
      if (a.status === "running" || a.status === "queued") {
        this.finishedTurnAge.delete(a.id);
        this.finishedAt.delete(a.id);
        merged.set(a.id, this.recordToSnapshot(a));
      } else if (a.completedAt && this.shouldShowFinished(a.id, a.status, a.completedAt)) {
        merged.set(a.id, this.recordToSnapshot(a));
      }
    }
    const liveRecordIds = new Set(allAgents.map(a => a.id));
    for (const [id, snapshot] of merged) {
      if (snapshot.status !== "running" && snapshot.status !== "queued" && !this.shouldShowFinished(id, snapshot.status, snapshot.completedAt)) {
        merged.delete(id);
        if (this.descendantSnapshots.has(id)) this.descendantSnapshots.delete(id);
        if (!liveRecordIds.has(id)) {
          this.finishedTurnAge.delete(id);
          this.finishedAt.delete(id);
        }
      }
    }
    return [...merged.values()];
  }

  /**
   * Render the widget content. Called from the registered widget's render() callback,
   * reading live state each time instead of capturing it in a closure.
   */
  private renderWidget(tui: any, theme: Theme): string[] {
    const snapshots = this.visibleSnapshots();
    if (snapshots.length === 0) return [];

    return renderAgentTree(snapshots, {
      mode: this.displayMode,
      width: tui.terminal.columns,
      maxLines: MAX_WIDGET_LINES,
      theme,
      frame: SPINNER[this.widgetFrame % SPINNER.length],
    });
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const allAgents = this.manager.listAgents();
    const snapshots = this.visibleSnapshots();

    // Lightweight existence checks — full categorization happens in renderWidget()
    let runningCount = 0;
    let queuedCount = 0;
    let hasFinished = false;
    for (const a of snapshots) {
      if (a.status === "running") { runningCount++; }
      else if (a.status === "queued") { queuedCount++; }
      else if (this.shouldShowFinished(a.id, a.status, a.completedAt)) { hasFinished = true; }
    }
    const hasActive = runningCount > 0 || queuedCount > 0;

    // Nothing to show — clear widget
    if (!hasActive && !hasFinished) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("agents", undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.lastStatusText !== undefined) {
        this.uiCtx.setStatus("subagents", undefined);
        this.lastStatusText = undefined;
      }
      if (this.widgetInterval) { clearInterval(this.widgetInterval); this.widgetInterval = undefined; }
      // Clean up stale entries
      for (const [id] of this.finishedTurnAge) {
        if (!allAgents.some(a => a.id === id) && !this.descendantSnapshots.has(id)) {
          this.finishedTurnAge.delete(id);
          this.finishedAt.delete(id);
        }
      }
      return;
    }

    this.ensureTimer();

    // Status bar — only call setStatus when the text actually changes
    const statusWidth = this.tui?.terminal.columns ?? DEFAULT_STATUS_TEXT_WIDTH;
    const newStatusText = hasActive
      ? formatSubagentStatusText(runningCount, queuedCount, statusWidth)
      : undefined;
    if (newStatusText !== this.lastStatusText) {
      this.uiCtx.setStatus("subagents", newStatusText);
      this.lastStatusText = newStatusText;
    }

    this.widgetFrame++;

    // Register widget callback once; subsequent updates use requestRender()
    // which re-invokes render() without replacing the component (avoids layout thrashing).
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("agents", (tui, theme) => {
        this.tui = tui;
        return {
          render: () => this.renderWidget(tui, theme),
          invalidate: () => {
            // Theme changed — force re-registration so factory captures fresh theme.
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else {
      // Widget already registered — just request a re-render of existing components.
      this.tui?.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("agents", undefined);
      this.uiCtx.setStatus("subagents", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.lastStatusText = undefined;
    this.descendantSnapshots.clear();
    this.finishedTurnAge.clear();
    this.finishedAt.clear();
  }
}
