/**
 * dashboard-ui.ts — Register dashboard UI modules for subagent visibility.
 *
 * Provides three integration points with pi-agent-dashboard:
 * 1. Footer-segment decorator showing running/completed agent counts
 * 2. Management-modal module with a table view of all subagent history
 * 3. Round-trip event handlers for data fetch, abort, and steer actions
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agent-manager.js";
import { formatMs, getDisplayName } from "./ui/agent-widget.js";
import { getLifetimeTotal } from "./usage.js";

// Dashboard shared types (inlined to avoid adding a dependency)
interface DecoratorDescriptor {
  kind: "footer-segment" | "agent-metric" | "breadcrumb" | "gate" | "toast";
  namespace: string;
  id: string;
  payload: Record<string, unknown>;
}

interface ExtensionUiModule {
  kind: "management-modal";
  id: string;
  command: string;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  view: {
    kind: "table" | "grid" | "form";
    dataEvent?: string;
    rowKey?: string;
    fields?: Array<{
      key: string;
      label: string;
      kind: string;
      width?: string | number;
    }>;
    rowActions?: Array<{
      id: string;
      label: string;
      icon?: string;
      variant?: "primary" | "secondary" | "danger";
      event: string;
      confirm?: string;
    }>;
    emptyState?: string;
    actions?: Array<{
      id: string;
      label: string;
      icon?: string;
      variant?: "primary" | "secondary" | "danger";
      event: string;
    }>;
  };
}

type ModuleProbe = { modules: Array<ExtensionUiModule | DecoratorDescriptor> };

const NAMESPACE = "subagents";
const MODULE_ID = "subagents-overview";
const DATA_EVENT = "subagents:rows";
const INVALIDATE_DEBOUNCE_MS = 500;

/**
 * Build a row for the management-modal table from an AgentRecord.
 */
function buildAgentRow(record: any) {
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    type: getDisplayName(record.type),
    description: record.description ?? "",
    model: record.invocation?.modelName ?? "—",
    status: record.status,
    toolUses: record.toolUses ?? 0,
    tokens: totalTokens > 0 ? formatTokenCount(totalTokens) : "—",
    duration: formatMs(durationMs),
    outputFile: record.outputFile ?? "",
    startedAt: record.startedAt,
  };
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Register all dashboard UI integration points.
 * Call once during extension setup when pi.events is available.
 */
export function registerDashboardModules(pi: ExtensionAPI, manager: AgentManager): void {
  if (!pi.events) return;

  let invalidateTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleInvalidate() {
    if (invalidateTimer) return;
    invalidateTimer = setTimeout(() => {
      invalidateTimer = undefined;
      pi.events.emit("ui:invalidate", {});
    }, INVALIDATE_DEBOUNCE_MS);
  }

  // ── 1. Module Discovery (ui:list-modules) ──────────────────────────
  // Guard against duplicate pushes: the bridge may call refreshUiModules
  // multiple times per probe cycle when multiple sessions each register
  // their own ui:invalidate listener. Check if our modules are already
  // present before pushing.
  pi.events.on("ui:list-modules", ((probe: ModuleProbe) => {
    const alreadyContributed = probe.modules.some(
      (m: any) => m.kind === "management-modal" && m.id === MODULE_ID,
    );
    if (alreadyContributed) return;

    const agents = manager.listAgents();
    const running = agents.filter(a => a.status === "running").length;
    const completed = agents.filter(a => a.status === "completed").length;
    const total = agents.length;

    // Footer-segment: running/completed counts
    const parts: string[] = [];
    if (running > 0) parts.push(`● ${running} running`);
    if (completed > 0) parts.push(`✓ ${completed} done`);
    if (total === 0) parts.push("No agents");

    probe.modules.push({
      kind: "footer-segment",
      namespace: NAMESPACE,
      id: "agent-counts",
      payload: {
        text: parts.join(" · "),
        tooltip: `${total} total agents (${running} running, ${completed} completed)`,
        icon: "mdiRobot",
      },
    } as DecoratorDescriptor);

    // Management-modal: subagent overview table
    probe.modules.push({
      kind: "management-modal",
      id: MODULE_ID,
      command: "/subagents",
      title: "Subagents",
      description: "View and manage background subagents",
      icon: "mdiRobotOutline",
      category: "subagents",
      view: {
        kind: "table",
        dataEvent: DATA_EVENT,
        rowKey: "id",
        fields: [
          { key: "id", label: "ID", kind: "text", width: 120 },
          { key: "type", label: "Type", kind: "text", width: 100 },
          { key: "description", label: "Description", kind: "text" },
          { key: "model", label: "Model", kind: "text", width: 80 },
          { key: "status", label: "Status", kind: "text", width: 90 },
          { key: "toolUses", label: "Tools", kind: "number", width: 60 },
          { key: "tokens", label: "Tokens", kind: "text", width: 80 },
          { key: "duration", label: "Duration", kind: "text", width: 80 },
        ],
        rowActions: [
          {
            id: "view-result",
            label: "View Result",
            icon: "mdiEye",
            variant: "primary",
            event: "subagents:ui:view-result",
          },
          {
            id: "abort",
            label: "Abort",
            icon: "mdiStop",
            variant: "danger",
            event: "subagents:ui:abort",
            confirm: "Abort this running agent?",
          },
          {
            id: "steer",
            label: "Steer",
            icon: "mdiMessageArrowRight",
            variant: "secondary",
            event: "subagents:ui:steer",
          },
        ],
        emptyState: "No subagents have been spawned in this session.",
        actions: [
          {
            id: "refresh",
            label: "Refresh",
            icon: "mdiRefresh",
            variant: "secondary",
            event: "subagents:ui:refresh",
          },
        ],
      },
    } as ExtensionUiModule);
  }) as any);

  // ── 2. Data Fetch Handler ──────────────────────────────────────────
  pi.events.on(DATA_EVENT, ((data: any) => {
    const agents = manager.listAgents();
    data.items = agents.map(buildAgentRow);
  }) as any);

  // ── 3. Action Handlers ─────────────────────────────────────────────

  // Refresh: just invalidate to re-probe + re-fetch
  pi.events.on("subagents:ui:refresh", (() => {
    scheduleInvalidate();
  }) as any);

  // View Result: return the agent's result as table rows so the modal
  // displays it. The bridge's synchronous fast path calls `_reply(items)`
  // when `data.items` is populated by the handler — do NOT call
  // `scheduleInvalidate()` here as the subsequent re-probe would
  // overwrite the returned rows with the original table data.
  pi.events.on("subagents:ui:view-result", ((data: any) => {
    // Bridge spreads msg.params into data; row identity is at data.row.id.
    const agentId = data.row?.id ?? data.id;
    if (!agentId) return;
    const record = manager.getRecord(agentId);
    if (!record) return;

    const resultText = record.result?.trim() || "No output yet.";
    const preview = resultText.length > 2000
      ? resultText.slice(0, 2000) + "\n…(truncated)"
      : resultText;

    // Populate data.items — the bridge's synchronous fast path forwards
    // this as a `ui_data_list` message back to the dashboard.
    data.items = [{
      id: record.id,
      type: getDisplayName(record.type),
      description: record.description,
      status: record.status,
      result: preview,
      outputFile: record.outputFile ?? "",
    }];
  }) as any);

  // Abort: stop the running agent via the manager's abort() method
  // which properly cancels the AbortController and cleans up state.
  pi.events.on("subagents:ui:abort", ((data: any) => {
    const agentId = data.row?.id ?? data.id;
    if (!agentId) return;
    manager.abort(agentId);
    scheduleInvalidate();
  }) as any);

  // Steer: send a steering message to a running agent's session.
  // The management-modal row action carries the row identity; we steer
  // with a default "Continue" nudge. A future form view could accept
  // custom text.
  pi.events.on("subagents:ui:steer", ((data: any) => {
    const agentId = data.row?.id ?? data.id;
    if (!agentId) return;
    const record = manager.getRecord(agentId);
    if (!record) return;

    if (record.status === "running" && record.session) {
      // Session is live — steer immediately
      record.session.steer("Continue").catch(() => {});
    } else if (record.status === "queued") {
      // Session not yet created — queue the steer for flush on start
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push("Continue");
    }
    scheduleInvalidate();
  }) as any);

  // ── 4. Invalidate on agent lifecycle events ────────────────────────
  const lifecycleEvents = [
    "subagents:created",
    "subagents:started",
    "subagents:completed",
    "subagents:failed",
    "subagents:compacted",
  ];

  for (const event of lifecycleEvents) {
    pi.events.on(event, (() => scheduleInvalidate()) as any);
  }
}
