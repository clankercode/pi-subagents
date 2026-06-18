export type WaitOutcome = "completed" | "timeout" | "aborted";

/** Human-readable "Xm Ys" for a duration in seconds. */
export function formatWaitTimeout(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${s > 0 ? ` ${s}s` : ""}` : `${s}s`;
}

/**
 * Race an agent completion promise against the configured wait timeout and the
 * parent abort signal. The subagent is never aborted here.
 */
export function raceWait(
  promise: Promise<string>,
  signal: AbortSignal | undefined,
  timeoutSeconds: number,
): Promise<WaitOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: WaitOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutSeconds * 1000);
    const onAbort = () => finish("aborted");
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(() => finish("completed"));
  });
}

/** Message returned when a wait ends with the agent still running. */
export function waitTimeoutMessage(outcome: WaitOutcome, timeoutSeconds: number): string {
  if (outcome === "timeout") {
    return `Agent is still running. The wait timed out after ${formatWaitTimeout(timeoutSeconds)} to avoid blocking the parent session longer than the configured limit.\nCall get_subagent_result with wait: true again to keep waiting, or omit wait to check status.`;
  }
  if (outcome === "aborted") {
    return `Agent is still running. The wait was cancelled by the user (parent turn aborted). The subagent was NOT stopped — it continues in the background.\nCall get_subagent_result with wait: true again to keep waiting, use peek to check progress, or omit wait to check status.`;
  }
  return "Agent is still running. Use peek to check recent progress, wait: true to block until it finishes, or check back later.";
}
