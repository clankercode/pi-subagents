import { Text } from "@earendil-works/pi-tui";
import { getModelLabelFromConfig } from "../agent-tool-description.js";
import { getAgentConfig } from "../agent-types.js";
import { extractText } from "../context.js";
import { type AgentDetails, formatMs, formatTurns, getDisplayName, SPINNER } from "./agent-widget.js";

export function compactPreview(text: string, maxLen = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 1).trimEnd() + "…";
}

export function tailPreview(text: string, maxLen = 100): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return "…" + oneLine.slice(oneLine.length - (maxLen - 1));
}

export function snipMiddleLines(text: string, edgeLines = 20): string[] {
  const lines = text.split("\n");
  const maxLines = edgeLines * 2;
  if (lines.length <= maxLines) return lines;
  const omitted = lines.length - maxLines;
  return [
    ...lines.slice(0, edgeLines),
    `─────── ⋐ ${omitted} lines hidden from preview ⋑ ───────`,
    ...lines.slice(-edgeLines),
  ];
}

/**
 * Shape of the args passed to the Agent tool's `renderCall`. Mirrors the tool
 * parameter schema — only the fields whose presence changes the call-time
 * header are listed. Anything we can't decide at call time (e.g. an agent that
 * inherits its model from the parent) is intentionally omitted here and is
 * surfaced later by `renderResult`.
 */
export interface AgentCallArgs {
  subagent_type?: string;
  description?: string;
  /** Explicit per-call model override (`provider/modelId` or fuzzy name). */
  model?: string;
  /** Agent ID being resumed; only set on resume calls. */
  resume?: string;
  /** Schedule expression; only set on schedule calls. */
  schedule?: string;
  /** Drop parent extension tools for this run. */
  isolated?: boolean;
  /** Isolation mode — currently only "worktree". */
  isolation?: "worktree";
}

/**
 * Resolve the model that this call will use, if it's knowable before execute().
 * Resolution order: explicit `args.model` > agent config frontmatter > none.
 * Inheritance from the parent session is decided inside execute() and surfaced
 * by `renderResult` once the resolved model is available.
 */
function resolveCallModel(args: any): string | undefined {
  if (typeof args.model === "string" && args.model) return args.model;
  if (typeof args.subagent_type === "string") return getAgentConfig(args.subagent_type)?.model;
  return undefined;
}

/** Build the dimmed badge list shown between the agent name and the description. */
function buildCallBadges(args: any, theme: any): string {
  const badges: string[] = [];
  const callModel = resolveCallModel(args);
  if (callModel) badges.push(getModelLabelFromConfig(callModel));
  if (typeof args.resume === "string" && args.resume) {
    badges.push(`resume: ${compactPreview(args.resume, 12)}`);
  }
  if (typeof args.schedule === "string" && args.schedule) {
    badges.push(`schedule: ${compactPreview(args.schedule, 20)}`);
  }
  if (args.isolation === "worktree") badges.push("worktree");
  if (args.isolated) badges.push("isolated");
  if (badges.length === 0) return "";
  const sep = " " + theme.fg("dim", "·") + " ";
  return "  " + badges.map((b) => theme.fg("dim", b)).join(sep);
}

export function renderAgentCall(args: any, theme: any): Text {
  const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
  const desc = args.description ?? "";
  const badges = buildCallBadges(args, theme);
  const descPart = desc ? "  " + theme.fg("muted", desc) : "";
  return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + badges + descPart, 0, 0);
}

function getResultText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return extractText(content);
}

export function renderAgentResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any): Text {
  const details = result.details as AgentDetails | undefined;
  if (!details) {
    return new Text(getResultText(result.content), 0, 0);
  }

  const stats = (d: AgentDetails) => {
    const parts: string[] = [];
    if (d.modelName) parts.push(d.modelName);
    if (d.tags) parts.push(...d.tags);
    if (d.turnCount != null && d.turnCount > 0) {
      parts.push(formatTurns(d.turnCount, d.maxTurns));
    }
    if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
    if (d.tokens) parts.push(d.tokens);
    return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
  };

  if (isPartial || details.status === "running") {
    const frame = SPINNER[details.spinnerFrame ?? 0];
    const s = stats(details);
    let line = theme.fg("accent", frame) + (s ? " " + s : "");
    line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
    return new Text(line, 0, 0);
  }

  if (details.status === "background") {
    return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
  }

  if (details.status === "completed" || details.status === "steered") {
    const duration = formatMs(details.durationMs);
    const isSteered = details.status === "steered";
    const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
    const s = stats(details);
    let line = icon + (s ? " " + s : "");
    line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

    const resultText = getResultText(result.content).trim();
    if (expanded) {
      if (resultText) {
        for (const lineText of resultText.split("\n")) {
          line += "\n" + theme.fg("dim", `  ${lineText}`);
        }
      }
    } else {
      const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
      if (resultText) {
        for (const lineText of snipMiddleLines(resultText)) {
          line += "\n" + theme.fg("dim", `  ${lineText}`);
        }
      } else {
        line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
      }
    }
    return new Text(line, 0, 0);
  }

  if (details.status === "stopped") {
    const s = stats(details);
    let line = theme.fg("dim", "■") + (s ? " " + s : "");
    line += "\n" + theme.fg("dim", "  ⎿  Stopped");
    return new Text(line, 0, 0);
  }

  const s = stats(details);
  let line = theme.fg("error", "✗") + (s ? " " + s : "");
  if (details.status === "error") {
    line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
  } else {
    line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
  }
  return new Text(line, 0, 0);
}

export function renderSteerCall(args: { agent_id?: string; message?: string }, theme: any): Text {
  const agentId = args.agent_id ? ` ${theme.fg("muted", args.agent_id)}` : "";
  const preview = args.message ? `  ${theme.fg("dim", `“${compactPreview(args.message)}”`)}` : "";
  return new Text(`▸ ${theme.fg("toolTitle", theme.bold("Steer Agent"))}${agentId}${preview}`, 0, 0);
}
