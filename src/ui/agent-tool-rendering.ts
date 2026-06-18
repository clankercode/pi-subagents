import { Text } from "@earendil-works/pi-tui";
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
    `... ${omitted} lines omitted; expand for full output ...`,
    ...lines.slice(-edgeLines),
  ];
}

export function renderAgentCall(args: { subagent_type?: string; description?: string }, theme: any): Text {
  const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
  const desc = args.description ?? "";
  return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
}

export function renderAgentResult(result: any, { expanded, isPartial }: { expanded: boolean; isPartial: boolean }, theme: any): Text {
  const details = result.details as AgentDetails | undefined;
  if (!details) {
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    return new Text(text, 0, 0);
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

    if (expanded) {
      const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
      if (resultText) {
        for (const lineText of resultText.split("\n")) {
          line += "\n" + theme.fg("dim", `  ${lineText}`);
        }
      }
    } else {
      const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
      const resultText = result.content[0]?.type === "text" ? result.content[0].text.trim() : "";
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
