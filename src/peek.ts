/**
 * peek.ts — Lightweight tail/filter view of an agent's result or streaming
 * output file for `get_subagent_result`'s `peek` parameter.
 *
 * Design:
 * - Source precedence: streaming output file (best for running agents) → record
 *   result (finished agents) → "no output yet".
 * - The output file is JSONL (one entry per message). We extract human-readable
 *   text lines (assistant text + tool-result text) so a peek shows useful
 *   progress, not raw JSON.
 * - Semantics: filter-then-tail. If `regex` is given, only matching source lines
 *   are kept; then `after` (return all lines past an index) or `lines` (last N)
 *   is applied. Line numbers always refer to the FULL source so callers can use
 *   `after` for incremental updates without missing anything.
 */

import { existsSync, readFileSync } from "node:fs";
import { clampPeekLines, formatOutputFileHint, limitText, MAX_PEEK_CHARS, MAX_PEEK_LINES } from "./bounded-output.js";
import type { AgentRecord } from "./types.js";

export interface PeekOptions {
  /** Number of trailing lines to return. Default 20. Minimum 1. */
  lines?: number;
  /** Optional regex filter applied to each source line (filter-then-tail). */
  regex?: string;
  /** Return all source lines after this 1-based line number (matches the [N] prefixes in peek output). Use the last line number you saw to fetch only new lines. Overrides `lines`. */
  after?: number;
}

export interface PeekResult {
  /** The formatted peek text (with line-number prefixes and a header). */
  text: string;
  /** Number of source lines available (before filtering). */
  totalLines: number;
  /** Whether the source was the output file (live) or the result. */
  source: "outputFile" | "result";
}

/**
 * Produce a peek view of an agent's output. Returns null when there is no
 * source content at all (the caller renders a "no output yet" message).
 */
export function peekAgentOutput(record: AgentRecord, opts: PeekOptions = {}): PeekResult | null {
  const lines = readSourceLines(record);
  if (lines.length === 0) return null;

  const regex = opts.regex ? compileRegex(opts.regex) : undefined;
  const after = typeof opts.after === "number" ? opts.after : -1;
  const tail = clampPeekLines(opts.lines);

  // Index each source line with its original position (1-based for display).
  const indexed = lines.map((text, i) => ({ no: i + 1, text }));

  // Filter-then-select.
  const filtered = regex ? indexed.filter((l) => regex.test(l.text)) : indexed;
  const matching = after >= 0 ? filtered.filter((l) => l.no > after) : filtered;
  const selected = after >= 0 ? matching.slice(0, MAX_PEEK_LINES) : matching.slice(-tail);
  const lineLimited = matching.length > selected.length;

  const totalLines = lines.length;
  const isRunning = record.status === "running" || record.status === "queued";
  const source: PeekResult["source"] =
    isRunning && record.outputFile && existsSync(record.outputFile) ? "outputFile" : "result";

  const header = buildHeader(opts, selected.length, totalLines, source, tail, lineLimited, matching.length);
  const body = selected.map((l) => `[${l.no}] ${l.text}`).join("\n");
  const limited = limitText(body, MAX_PEEK_CHARS);
  const lastLine = selected.at(-1)?.no;
  const notices: string[] = [];
  if (lineLimited && lastLine !== undefined) {
    notices.push(`Peek limited to ${MAX_PEEK_LINES} lines from ${matching.length} matching lines. Use peek.after: ${lastLine} to continue.`);
  }
  if (limited.truncated) {
    notices.push(`Peek output truncated by ${limited.omittedChars} chars. Use a smaller lines value or regex filter.${formatOutputFileHint(record.outputFile)}`);
  }

  return {
    text: `${header}\n\n${limited.text}${notices.length ? `\n\n---\n${notices.join("\n")}` : ""}`,
    totalLines,
    source,
  };
}

/** Read the most useful text lines from the agent's output. */
function readSourceLines(record: AgentRecord): string[] {
  const isRunning = record.status === "running" || record.status === "queued";
  const outputFileLines =
    record.outputFile && existsSync(record.outputFile) ? parseOutputFileLines(record.outputFile) : [];

  // While running, the live output file is the only source of progress.
  if (isRunning && outputFileLines.length > 0) return outputFileLines;

  // Finished (or no live file): prefer the clean result text.
  if (record.result?.trim()) {
    return record.result.split("\n");
  }

  // Last resort: the output file (e.g. agent errored before producing a result).
  return outputFileLines;
}

/**
 * Parse the JSONL output file and extract human-readable text lines.
 * Each entry has `{ type, message: { role, content } }`. We pull assistant text
 * and tool-result text so a peek reflects actual progress.
 */
function parseOutputFileLines(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: string[] = [];
  const pushRenderedLines = (text: string) => {
    for (const renderedLine of text.trimEnd().split("\n")) {
      if (renderedLine.trim()) out.push(renderedLine);
    }
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: any;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) {
      // Some entries may carry a plain string content.
      if (typeof content === "string" && content.trim()) pushRenderedLines(content);
      continue;
    }
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        pushRenderedLines(block.text);
      }
    }
  }
  return out;
}

function compileRegex(pattern: string): RegExp {
  // Anchor-free; case-sensitive by default. Invalid patterns fall back to a
  // substring literal match so a bad regex never throws into the tool result.
  try {
    return new RegExp(pattern);
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }
}

function buildHeader(
  opts: PeekOptions,
  shown: number,
  total: number,
  source: PeekResult["source"],
  tail: number,
  lineLimited: boolean,
  matching: number,
): string {
  const parts: string[] = [];
  if (typeof opts.after === "number") {
    parts.push(`after line number ${opts.after}`);
    if (lineLimited) parts.push(`limited to ${MAX_PEEK_LINES} lines from ${matching} matching lines`);
  } else {
    parts.push(`last ${tail} lines`);
  }
  if (opts.regex) parts.push(`filtered by regex /${opts.regex}/`);
  parts.push(`of ${total} total (${source === "outputFile" ? "live output file" : "result"})`);
  return `Showing ${shown} ${parts.join(", ")}. Line numbers index the full source.`;
}
