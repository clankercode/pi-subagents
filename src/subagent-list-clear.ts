import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import type { AgentManager } from "./agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import type { AgentRecord } from "./types.js";

const DEFAULT_RECENT_SUCCESS_LIMIT = 2;
const DEFAULT_CLEAR_AGE_MS = 5 * 60_000;
const INDENT = " ";
const HEADER_GLYPH = "⏣";
const TREE_MID = "├─";
const TREE_END = "└─";
const TREE_GAP = " ";
const TREE_PREFIX_LEN = INDENT.length + TREE_MID.length + TREE_GAP.length;

const SUCCESS_STATUSES = new Set(["completed", "steered"]);
const ACTIVE_STATUSES = new Set(["running", "queued"]);
const PROBLEM_STATUSES = new Set(["error", "aborted", "stopped"]);

export interface ListSubagentsOptions {
  all?: boolean;
  now?: number;
  recentSuccessLimit?: number;
}

export interface ListSubagentsAgentDetails {
  id: string;
  type: AgentRecord["type"];
  description: string;
  status: AgentRecord["status"];
  startedAt: number;
  completedAt?: number;
}

export interface ListSubagentsDetails {
  total: number;
  all: boolean;
  visible: ListSubagentsAgentDetails[];
  hiddenDoneCount: number;
  activeCount: number;
  problemCount: number;
  recentDoneCount: number;
  now: number;
}

export interface ClearSubagentsOptions {
  agentIds?: string[];
  now?: number;
  olderThanMs?: number;
  includeErrors?: boolean;
}

export interface ClearSelectionResult {
  clearIds: string[];
  errors: string[];
  requestedCount: number;
  keptActiveCount: number;
  keptFailedCount: number;
  keptYoungSuccessCount: number;
}

export interface ClearSubagentsDetails extends ClearSelectionResult {
  clearedCount: number;
}

export type RenderTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

class LineListComponent implements Component {
  constructor(private readonly getLines: (width: number) => string[]) {}
  render(width: number): string[] { return this.getLines(width); }
  invalidate(): void {}
}

function isActive(record: AgentRecord): boolean {
  return ACTIVE_STATUSES.has(record.status);
}

function isSuccess(record: AgentRecord): boolean {
  return SUCCESS_STATUSES.has(record.status);
}

function isProblem(record: AgentRecord): boolean {
  return PROBLEM_STATUSES.has(record.status);
}

function recency(record: AgentRecord): number {
  return record.completedAt ?? record.startedAt;
}

function newestFirst(a: AgentRecord, b: AgentRecord): number {
  return recency(b) - recency(a);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function toListSubagentsAgentDetails(record: AgentRecord): ListSubagentsAgentDetails {
  const details: ListSubagentsAgentDetails = {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    startedAt: record.startedAt,
  };
  if (record.completedAt !== undefined) details.completedAt = record.completedAt;
  return details;
}

function formatAge(record: ListSubagentsAgentDetails, now: number): string {
  const start = record.completedAt ?? record.startedAt;
  const elapsed = Math.max(0, now - start);
  if (elapsed < 1_000) return "0s";
  const seconds = Math.floor(elapsed / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function displayType(type: AgentRecord["type"]): string {
  return type === "general-purpose" ? "general" : type;
}

function statusLabel(status: AgentRecord["status"]): string {
  if (status === "completed") return "done";
  if (status === "steered") return "done";
  return status;
}

function statusIcon(status: AgentRecord["status"]): string {
  switch (status) {
    case "running": return "⠋";
    case "queued": return "◼";
    case "completed":
    case "steered": return "✓";
    case "error":
    case "aborted": return "✗";
    case "stopped": return "■";
    default: return "•";
  }
}

function statusColor(status: AgentRecord["status"]): string {
  switch (status) {
    case "running":
    case "queued": return "accent";
    case "completed":
    case "steered": return "success";
    case "stopped": return "dim";
    default: return "error";
  }
}

function labeledPrefix(label: string, theme: RenderTheme): string {
  return `${INDENT}${theme.fg("accent", HEADER_GLYPH)} ${theme.fg("accent", label)}${theme.fg("dim", " · ")}`;
}

function normalizeIds(agentIds: string[] | undefined): string[] {
  return [...new Set((agentIds ?? []).map((id) => id.trim()).filter(Boolean))];
}

function resolveId(records: AgentRecord[], query: string): { id?: string; error?: string } {
  const exact = records.find((record) => record.id === query);
  if (exact) return { id: exact.id };
  const matches = records.filter((record) => record.id.startsWith(query));
  if (matches.length === 0) return { error: `${query} not found` };
  if (matches.length > 1) return { error: `${query} matched multiple agents: ${matches.map((r) => shortId(r.id)).join(", ")}` };
  return { id: matches[0].id };
}

export function buildListSubagentsDetails(records: AgentRecord[], options: ListSubagentsOptions = {}): ListSubagentsDetails {
  const now = options.now ?? Date.now();
  const all = options.all === true;
  const sorted = [...records].sort(newestFirst);
  const active = sorted.filter(isActive);
  const problems = sorted.filter(isProblem);
  const successes = sorted.filter(isSuccess);
  const recentSuccessLimit = options.recentSuccessLimit ?? DEFAULT_RECENT_SUCCESS_LIMIT;
  const recentSuccesses = successes.slice(0, recentSuccessLimit);
  const visible = all ? sorted : [...active, ...problems, ...recentSuccesses];

  return {
    total: records.length,
    all,
    visible: visible.map(toListSubagentsAgentDetails),
    hiddenDoneCount: all ? 0 : Math.max(0, successes.length - recentSuccesses.length),
    activeCount: active.length,
    problemCount: problems.length,
    recentDoneCount: all ? successes.length : recentSuccesses.length,
    now,
  };
}

export function clearSubagentRecords(records: AgentRecord[], options: ClearSubagentsOptions = {}): ClearSelectionResult {
  const now = options.now ?? Date.now();
  const olderThanMs = options.olderThanMs ?? DEFAULT_CLEAR_AGE_MS;
  const requestedIds = normalizeIds(options.agentIds);
  const errors: string[] = [];
  const clearIds: string[] = [];

  if (requestedIds.length > 0) {
    for (const query of requestedIds) {
      const resolved = resolveId(records, query);
      if (resolved.error || !resolved.id) {
        errors.push(resolved.error ?? `${query} not found`);
        continue;
      }
      const record = records.find((r) => r.id === resolved.id)!;
      if (isActive(record)) {
        errors.push(`${query} matched ${record.status} agent ${record.id}`);
        continue;
      }
      clearIds.push(record.id);
    }
  } else {
    for (const record of records) {
      const age = now - (record.completedAt ?? record.startedAt);
      if (age < olderThanMs) continue;
      if (isSuccess(record) || (options.includeErrors && isProblem(record))) {
        clearIds.push(record.id);
      }
    }
  }

  const clearIdSet = new Set(clearIds);
  const remaining = records.filter((record) => !clearIdSet.has(record.id));
  const keptActiveCount = remaining.filter(isActive).length;
  const keptFailedCount = remaining.filter(isProblem).length;
  const keptYoungSuccessCount = remaining.filter((record) => isSuccess(record) && now - (record.completedAt ?? record.startedAt) < olderThanMs).length;

  return { clearIds, errors, requestedCount: requestedIds.length, keptActiveCount, keptFailedCount, keptYoungSuccessCount };
}

export function buildClearSubagentsDetails(result: ClearSelectionResult): ClearSubagentsDetails {
  return { ...result, clearedCount: result.clearIds.length };
}

function renderAgentLine(record: ListSubagentsAgentDetails, theme: RenderTheme, now: number): string {
  const icon = theme.fg(statusColor(record.status), statusIcon(record.status));
  const id = theme.fg("muted", shortId(record.id));
  const type = theme.fg("text", pad(displayType(record.type), 8));
  const status = theme.fg(statusColor(record.status), pad(statusLabel(record.status), 8));
  const age = theme.fg("dim", pad(formatAge(record, now), 4));
  return `${icon} ${id} ${type} ${status} ${age} ${theme.fg("muted", record.description)}`;
}

function listSummary(details: ListSubagentsDetails, theme: RenderTheme): string {
  if (details.total === 0) return `${theme.fg("text", "0 visible")} ${theme.fg("dim", "(empty)")}`;
  if (details.all) return `${theme.fg("text", plural(details.visible.length, "agent"))} ${theme.fg("dim", "(full list)")}`;
  const parts = [
    plural(details.activeCount, "active"),
    plural(details.problemCount, "problem"),
    `${plural(details.recentDoneCount, "recent done", "recent done")}`,
  ];
  const hidden = details.hiddenDoneCount > 0 ? `; ${plural(details.hiddenDoneCount, "hidden done", "hidden done")}` : "";
  return `${theme.fg("text", `${details.visible.length} visible`)} ${theme.fg("dim", `(${parts.join(", ")}${hidden})`)}`;
}

export function renderListSubagentsDetails(details: ListSubagentsDetails, theme: RenderTheme): Component {
  return new LineListComponent((width) => {
    const header = `${labeledPrefix("List Agents", theme)}${listSummary(details, theme)}`;
    if (details.visible.length === 0) return [truncateToWidth(header, width)];
    const lines = [truncateToWidth(header, width)];
    const avail = Math.max(1, width - TREE_PREFIX_LEN);
    details.visible.forEach((record, i) => {
      const connector = i === details.visible.length - 1 ? TREE_END : TREE_MID;
      const line = truncateToWidth(renderAgentLine(record, theme, details.now), avail);
      lines.push(`${INDENT}${connector}${TREE_GAP}${line}`);
    });
    return lines;
  });
}

function clearSummary(details: ClearSubagentsDetails, theme: RenderTheme): string {
  const primary = theme.fg("text", `cleared ${plural(details.clearedCount, "record")}`);
  const extra: string[] = [];
  if (details.keptYoungSuccessCount) extra.push(`${plural(details.keptYoungSuccessCount, "new done", "new done")} kept`);
  if (details.keptFailedCount) extra.push(`${plural(details.keptFailedCount, "failed", "failed")} kept`);
  if (details.keptActiveCount) extra.push(`${plural(details.keptActiveCount, "active", "active")} kept`);
  if (details.errors.length) extra.push(theme.fg("error", `${plural(details.errors.length, "error")}`));
  if (extra.length === 0) return primary;
  return `${primary}${theme.fg("dim", " (")}${extra.join(theme.fg("dim", ", "))}${theme.fg("dim", ")")}`;
}

export function renderClearSubagentsDetails(details: ClearSubagentsDetails, theme: RenderTheme): Component {
  return new LineListComponent((width) => [truncateToWidth(`${labeledPrefix("Clear Agents", theme)}${clearSummary(details, theme)}`, width)]);
}

export function renderEmptyCall(): Component {
  return new LineListComponent(() => []);
}

export function formatListSubagentsText(details: ListSubagentsDetails): string {
  const lines = [`${details.visible.length} visible of ${details.total} retained subagents.`];
  for (const record of details.visible) {
    lines.push(`${record.id} | ${displayType(record.type)} | ${record.status} | ${record.description}`);
  }
  if (details.hiddenDoneCount > 0) {
    lines.push(`${details.hiddenDoneCount} successful completed subagent(s) hidden. Pass all: true for the full retained list.`);
  }
  return lines.join("\n");
}

export function formatClearSubagentsText(details: ClearSubagentsDetails): string {
  const lines = [`Cleared ${details.clearedCount} subagent record(s).`];
  if (details.clearIds.length) lines.push(`Cleared IDs: ${details.clearIds.join(", ")}`);
  if (details.keptYoungSuccessCount) lines.push(`Kept ${details.keptYoungSuccessCount} successful subagent(s) newer than the age threshold.`);
  if (details.keptFailedCount) lines.push(`Kept ${details.keptFailedCount} failed/stopped/aborted subagent(s).`);
  if (details.keptActiveCount) lines.push(`Kept ${details.keptActiveCount} active subagent(s).`);
  if (details.errors.length) lines.push(`Errors: ${details.errors.join("; ")}`);
  return lines.join("\n");
}

function textResult(msg: string, details?: unknown) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

export function registerSubagentListClearTools(pi: ExtensionAPI, manager: AgentManager): void {
  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.LIST_SUBAGENTS,
    label: "List Agents",
    description:
      "List retained subagent records. By default shows queued/running agents, failed/stopped/aborted agents, " +
      "and the most recent 2 successful agents that have not been cleaned up. Also reports how many successful " +
      "completed agents are hidden. Pass all: true to show the full retained list.",
    promptSnippet: "List retained subagents and their current status",
    parameters: Type.Object({
      all: Type.Optional(
        Type.Boolean({
          description: "If true, show every retained subagent record instead of the default compact view.",
        }),
      ),
    }),
    renderShell: "self",
    renderCall: () => renderEmptyCall(),
    renderResult: (result: any, _options: any, theme: any) => {
      const details = result?.details;
      return details ? renderListSubagentsDetails(details, theme) : renderEmptyCall();
    },
    execute: async (_toolCallId, params) => {
      const details = buildListSubagentsDetails(manager.listAgents(), { all: params.all === true });
      return textResult(formatListSubagentsText(details), details);
    },
  }));

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.CLEAR_SUBAGENTS,
    label: "Clear Agents",
    description:
      "Clear retained terminal subagent records. By default clears successful completed/steered subagents older than 5 minutes. " +
      "Provide agent_ids to clear specific terminal subagents by exact ID or unique prefix. Running and queued subagents are never cleared; " +
      "specific attempts to clear them are reported as errors.",
    promptSnippet: "Clear completed subagent records that are still retained",
    parameters: Type.Object({
      agent_ids: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional exact IDs or unique prefixes to clear. When provided, the age threshold is ignored for those IDs.",
        }),
      ),
      older_than_minutes: Type.Optional(
        Type.Number({
          description: "Default-mode age threshold in minutes. Defaults to 5. Ignored when agent_ids is provided.",
          minimum: 0,
        }),
      ),
      include_errors: Type.Optional(
        Type.Boolean({
          description: "In default mode, also clear failed/stopped/aborted terminal records older than the age threshold. Default false.",
        }),
      ),
    }),
    renderShell: "self",
    renderCall: () => renderEmptyCall(),
    renderResult: (result: any, _options: any, theme: any) => {
      const details = result?.details;
      return details ? renderClearSubagentsDetails(details, theme) : renderEmptyCall();
    },
    execute: async (_toolCallId, params) => {
      const selection = clearSubagentRecords(manager.listAgents(), {
        agentIds: params.agent_ids,
        olderThanMs: (params.older_than_minutes ?? 5) * 60_000,
        includeErrors: params.include_errors === true,
      });
      const removed = manager.clearRecords(selection.clearIds);
      const details = buildClearSubagentsDetails({ ...selection, clearIds: removed });
      return textResult(formatClearSubagentsText(details), details);
    },
  }));
}
