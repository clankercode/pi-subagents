import { truncateToWidth } from "@earendil-works/pi-tui";
import { getConfig } from "../agent-types.js";
import type { AgentInvocation, SubagentType } from "../types.js";
import { getSessionTokens } from "../usage.js";
import type { AgentActivity, Theme } from "./agent-widget.js";

export type WidgetDisplayMode = "auto" | "rich" | "compact";

export interface WidgetAgentSnapshot {
  id: string;
  parentAgentId?: string;
  depth?: number;
  type: SubagentType;
  description: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  toolUses: number;
  invocation?: AgentInvocation;
  activity?: AgentActivity;
}

export interface WidgetTreeNode {
  snapshot: WidgetAgentSnapshot;
  children: WidgetTreeNode[];
  orphaned?: boolean;
}

function statusRank(status: string): number {
  if (status === "running") return 0;
  if (status === "queued") return 1;
  return 2;
}

function sortNodes(a: WidgetTreeNode, b: WidgetTreeNode): number {
  const status = statusRank(a.snapshot.status) - statusRank(b.snapshot.status);
  if (status !== 0) return status;
  return a.snapshot.startedAt - b.snapshot.startedAt;
}

export interface RenderTreeOptions {
  mode: WidgetDisplayMode;
  width: number;
  maxLines: number;
  theme: Theme;
  frame: string;
  now?: number;
}

export function buildAgentTree(records: WidgetAgentSnapshot[]): WidgetTreeNode[] {
  const nodes = new Map<string, WidgetTreeNode>();
  for (const record of records) nodes.set(record.id, { snapshot: record, children: [] });

  const roots: WidgetTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.snapshot.parentAgentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      if (parentId) node.orphaned = true;
      roots.push(node);
    }
  }

  function sortDeep(items: WidgetTreeNode[]) {
    items.sort(sortNodes);
    for (const item of items) sortDeep(item.children);
  }

  sortDeep(roots);
  return roots;
}

export function chooseEffectiveMode(
  mode: WidgetDisplayMode,
  width: number,
  richLineCount: number,
  maxLines: number,
): "rich" | "compact" {
  if (mode === "rich" || mode === "compact") return mode;
  if (width < 88) return "compact";
  if (richLineCount > maxLines) return "compact";
  return "rich";
}

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** Compact token count for widget rows: "12.3k tok", "1.2M tok". */
function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
  return `${count} tok`;
}

function statusIcon(snapshot: WidgetAgentSnapshot, frame: string, theme: Theme): string {
  if (snapshot.status === "running") return theme.fg("accent", frame);
  if (snapshot.status === "queued") return theme.fg("muted", "◦");
  if (snapshot.status === "completed") return theme.fg("success", "✓");
  if (snapshot.status === "steered") return theme.fg("warning", "✓");
  if (snapshot.status === "stopped") return theme.fg("dim", "■");
  return theme.fg("error", "✗");
}

function displayName(type: SubagentType): string {
  return getConfig(type).displayName;
}

function collectRows(
  nodes: WidgetTreeNode[],
  options: RenderTreeOptions,
  mode: "rich" | "compact",
  prefix = "",
): string[] {
  const rows: string[] = [];
  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const connector = isLast ? "└─" : "├─";
    const childPrefix = prefix + (isLast ? "   " : "│  ");
    const s = node.snapshot;
    const name = displayName(s.type);
    const elapsedUntil = s.status === "running" || s.status === "queued" ? (options.now ?? Date.now()) : (s.completedAt ?? options.now ?? Date.now());
    const elapsed = formatElapsed(s.startedAt, elapsedUntil);
    const stats: string[] = [];
    if (s.activity?.turnCount) stats.push(`↻${s.activity.turnCount}`);
    if (s.toolUses > 0) stats.push(`${s.toolUses} tool${s.toolUses === 1 ? "" : "s"}`);
    stats.push(elapsed);
    if (s.activity?.session) {
      const tokens = getSessionTokens(s.activity.session);
      if (tokens > 0) stats.push(formatCompactTokens(tokens));
    }
    const orphan = node.orphaned ? " ⚠ orphan" : "";
    const error = s.error ? ` error: ${s.error}` : "";
    rows.push(`${prefix}${connector} ${statusIcon(s, options.frame, options.theme)} ${options.theme.bold(name)}  ${options.theme.fg("muted", s.description)} ${options.theme.fg("dim", `· ${stats.join(" · ")}${orphan}${error}`)}`);

    if (mode === "rich" && s.status === "running") {
      const activity = s.activity?.activityDescription ?? "thinking…";
      rows.push(`${childPrefix}${options.theme.fg("dim", `⎿ ${activity}`)}`);
    }

    rows.push(...collectRows(node.children, options, mode, childPrefix));
  });
  return rows;
}

function applyOverflow(lines: string[], maxLines: number, width: number, hiddenLabel = "agents"): string[] {
  if (lines.length <= maxLines) return lines.map(line => truncateToWidth(line, width));
  if (maxLines <= 1) return [truncateToWidth(`+${lines.length} more ${hiddenLabel} hidden`, width)];
  const visible = lines.slice(0, maxLines - 1);
  const hidden = lines.length - visible.length;
  visible.push(`└─ +${hidden} more ${hiddenLabel} hidden`);
  return visible.map(line => truncateToWidth(line, width));
}

export function renderAgentTree(records: WidgetAgentSnapshot[], options: RenderTreeOptions): string[] {
  const tree = buildAgentTree(records);
  const now = options.now ?? Date.now();
  const active = records.filter(r => r.status === "running").length;
  const queued = records.filter(r => r.status === "queued").length;
  const maxDepth = records.reduce((max, r) => Math.max(max, r.depth ?? 0), 0);
  let mode: "rich" | "compact";
  let rows: string[];
  if (options.mode === "rich" || options.mode === "compact") {
    mode = options.mode;
    rows = collectRows(tree, { ...options, now }, mode);
  } else {
    const richRows = collectRows(tree, { ...options, now }, "rich");
    mode = chooseEffectiveMode(options.mode, options.width, richRows.length + 1, options.maxLines);
    rows = mode === "rich" ? richRows : collectRows(tree, { ...options, now }, "compact");
  }
  const suffix = mode === "rich" && records.length > 0
    ? options.theme.fg("dim", ` ${active} running · ${queued} queued · depth ${maxDepth}/4`)
    : "";
  const heading = `${active > 0 ? options.theme.fg("accent", "●") : options.theme.fg("dim", "○")} ${options.theme.fg(active > 0 ? "accent" : "dim", "Agents")}${suffix}`;
  return applyOverflow([heading, ...rows], options.maxLines, options.width, mode === "rich" ? "lines" : "agents");
}
