/**
 * Shared caps for tool responses that may otherwise flood the parent context.
 * Full subagent logs remain available via the per-agent output file.
 */

export const MAX_RESULT_CHARS = 20_000;
export const MAX_VERBOSE_CHARS = 20_000;
export const MAX_PEEK_CHARS = 20_000;
export const MAX_PEEK_LINES = 200;

export interface LimitedText {
  text: string;
  truncated: boolean;
  omittedChars: number;
}

export function limitText(text: string, maxChars: number): LimitedText {
  if (text.length <= maxChars) {
    return { text, truncated: false, omittedChars: 0 };
  }
  return {
    text: text.slice(0, maxChars),
    truncated: true,
    omittedChars: text.length - maxChars,
  };
}

export function clampPeekLines(lines: number | undefined): number {
  if (typeof lines !== "number" || !Number.isFinite(lines) || lines < 1) return 20;
  return Math.min(Math.floor(lines), MAX_PEEK_LINES);
}

export function formatOutputFileHint(outputFile?: string): string {
  return outputFile ? ` Full output/log: ${outputFile}` : "";
}
