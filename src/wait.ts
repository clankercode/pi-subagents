export type WaitOutcome = "completed" | "timeout" | "aborted" | "pending_message";

/** Human-readable "Xm Ys" for a duration in seconds. */
export function formatWaitTimeout(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m${s > 0 ? ` ${s}s` : ""}` : `${s}s`;
}

/**
 * Race an agent completion promise against the configured wait timeout, the
 * parent abort signal, and an optional pending-message check. The subagent is
 * never aborted here.
 *
 * @param pendingCheck - Optional promise that resolves when the parent session
 *   has queued user messages waiting to be delivered. When it resolves, the
 *   wait ends early so the parent turn can process the incoming message.
 */
export function raceWait(
  promise: Promise<string>,
  signal: AbortSignal | undefined,
  timeoutSeconds: number,
  pendingCheck?: Promise<void>,
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
    pendingCheck?.then(() => finish("pending_message"));
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
  if (outcome === "pending_message") {
    return `Agent is still running. The wait was interrupted by an incoming user message. The subagent was NOT stopped — it continues in the background.\nThe queued message will be delivered after this tool returns.\nCall get_subagent_result with wait: true again to keep waiting, use peek to check progress, or omit wait to check status.`;
  }
  return "Agent is still running. Use peek to check recent progress, wait: true to block until it finishes, or check back later.";
}

/**
 * Create a promise that resolves when the parent session has queued user
 * messages. Polls at the given interval until `hasPendingMessages()` returns
 * true. The caller should race this against the agent completion / timeout.
 */
export function pollPendingMessages(
  hasPendingMessages: () => boolean,
  intervalMs = 1000,
): { promise: Promise<void>; cancel: () => void } {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });

  // Check immediately in case a message arrived between the tool call
  // start and this poll setup.
  if (hasPendingMessages()) {
    settled = true;
    resolve();
    return { promise, cancel: () => {} };
  }

  const timer = setInterval(() => {
    if (settled) return;
    if (hasPendingMessages()) {
      settled = true;
      clearInterval(timer);
      resolve();
    }
  }, intervalMs);

  return {
    promise,
    cancel: () => {
      if (!settled) {
        settled = true;
        clearInterval(timer);
        resolve();
      }
    },
  };
}
