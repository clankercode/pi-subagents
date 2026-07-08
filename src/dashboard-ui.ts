/**
 * dashboard-ui.ts — Register dashboard UI modules for subagent visibility.
 *
 * Provides three integration points with pi-agent-dashboard:
 * 1. Footer-segment decorator showing running/completed agent counts
 * 2. Management-modal module with a table view of all subagent history
 * 3. Round-trip event handlers for data fetch, abort, and steer actions
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      options?: string[];
      placeholder?: string;
      required?: boolean;
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
 * Open a file in the host's default viewer (xdg-open / open / start).
 * Fire-and-forget, detached, never throws — used by the View Result row
 * action because the management-modal table can't render a detail/log view.
 */
function openInViewer(filePath: string): boolean {
  if (!filePath) return false;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on?.("error", () => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback for View Result when an agent has no outputFile: write the result
 * text to a tmp .txt so openInViewer can still surface something. Best-effort.
 */
function writeResultToTmp(agentId: string, result: string | undefined): string {
  try {
    const dir = join(tmpdir(), "pi-subagents");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `result-${agentId}.txt`);
    writeFileSync(path, (result ?? "(no result yet)").slice(0, 200_000), "utf-8");
    return path;
  } catch {
    return "";
  }
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

    // Steer-with-input form module. Row actions can't collect text
    // (UiAction only supports a yes/no `confirm`), so a separate form module
    // lets the user pick a running subagent and type a steer message. The
    // agent list is rebuilt on every probe (scheduleInvalidate re-fires
    // ui:list-modules), so it stays current.
    const steerables = agents.filter(a => a.status === "running" || a.status === "queued");
    if (steerables.length > 0) {
      probe.modules.push({
        kind: "management-modal",
        id: "subagents-steer",
        command: "/steer-subagent",
        title: "Steer subagent",
        description: "Send a steering message to a running subagent",
        icon: "mdiMessageArrowRight",
        category: "subagents",
        view: {
          kind: "form",
          fields: [
            {
              key: "agentId",
              label: "Subagent",
              kind: "select",
              options: steerables.map(a => `${a.id} — ${a.description || a.type}`),
              required: true,
            },
            {
              key: "message",
              label: "Message",
              kind: "textarea",
              placeholder: "Steering message to inject into the subagent's turn",
              required: true,
            },
          ],
          actions: [
            {
              id: "steer",
              label: "Steer",
              icon: "mdiSend",
              variant: "primary",
              event: "subagents:ui:steer-form",
            },
          ],
        },
      } as ExtensionUiModule);
    }
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

  // View Result: open the agent's streaming transcript (outputFile) host-side.
  // The management-modal table only renders rows for its bound dataEvent
  // (subagents:rows); a row action that replies ui_data_list on a different
  // event is stored by the dashboard (uiDataMap[event]) but NEVER displayed
  // (confirmed against the dashboard 0.5.4 reducer + table read logic). So a
  // detail/log view is impossible from this row action. Instead, open the
  // agent's outputFile (always present — the streaming transcript) in the
  // user's default viewer. The handler runs in the pi process, so spawning a
  // viewer works. This is the one reliable way to surface the full log here.
  pi.events.on("subagents:ui:view-result", ((data: any) => {
    // The browser sends the whole row under params.row; data.row.id is the id.
    const agentId = data.row?.id ?? data.id;
    if (!agentId) return;
    const record = manager.getRecord(agentId);
    if (!record) return;
    const target = record.outputFile && record.outputFile.length > 0
      ? record.outputFile
      : writeResultToTmp(record.id, record.result);
    if (target) openInViewer(target);
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

  // Steer form submit (subagents:ui:steer-form): the /steer-subagent form's
  // Steer action with a user-typed message. Form field values may arrive
  // spread into `data` or nested under `data.row` (dashboard 0.5.4's
  // form-view value wiring is unverified), so read both. The agent picker
  // option is "<id> — <desc>"; split off the id.
  pi.events.on("subagents:ui:steer-form", ((data: any) => {
    const raw = (data?.row && typeof data.row === "object") ? data.row : data;
    const agentSel = String(raw?.agentId ?? raw?.agent ?? "");
    const message = String(raw?.message ?? "").trim();
    const agentId = agentSel.split(" — ")[0].trim();
    if (!agentId || !message) return;
    const record = manager.getRecord(agentId);
    if (!record) return;
    if (record.status === "running" && record.session) {
      record.session.steer(message).catch(() => {});
    } else if (record.status === "queued") {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
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
