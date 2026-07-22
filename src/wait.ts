import { AgentSession } from "@earendil-works/pi-coding-agent";

export type WaitOutcome = "completed" | "timeout" | "aborted" | "pending_message";

/**
 * Context shape used to detect mid-wait interruptions.
 *
 * Prefer steering-only APIs when present. `hasPendingMessages` alone is NOT
 * sufficient: in pi it is true for both Enter (steering) and Alt+Enter
 * (follow-up) queues, and follow-ups must not interrupt wait:true.
 */
export type WaitPendingCtx = {
  /** Explicit steering-queue check (tests / future pi APIs). */
  hasSteeringMessages?: () => boolean;
  /** Explicit steering-queue accessor (tests / future pi APIs). */
  getSteeringMessages?: () => readonly unknown[];
  /**
   * pi ExtensionContext: true when any message is queued (steer OR follow-up).
   * Used only to identify the parent AgentSession so we can inspect its
   * steering queue separately.
   */
  hasPendingMessages?: () => boolean;
};

type SessionLike = {
  getSteeringMessages?: () => readonly unknown[];
};

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
 *   has queued *steering* messages waiting to be delivered. When it resolves,
 *   the wait ends early so the parent turn can process the steer. Follow-up
 *   messages must not resolve this promise.
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

/**
 * Guidance included on every get_subagent_result response while the agent is
 * still running or queued. Reminds callers they can block with wait:true, and
 * that completion notifications are delivered automatically (no need to poll).
 */
export const STILL_RUNNING_GUIDANCE =
  "Use wait: true to wait for the agent to finish. Parents are automatically notified when their subagents complete.";

/** Message returned when a wait ends with the agent still running. */
export function waitTimeoutMessage(outcome: WaitOutcome, timeoutSeconds: number): string {
  let head: string;
  if (outcome === "timeout") {
    head =
      `Agent is still running. The wait timed out after ${formatWaitTimeout(timeoutSeconds)} to avoid blocking the parent session longer than the configured limit.\n` +
      `Call get_subagent_result with wait: true again to keep waiting, or omit wait to check status.`;
  } else if (outcome === "aborted") {
    head =
      `Agent is still running. The wait was cancelled by the user (parent turn aborted). The subagent was NOT stopped — it continues in the background.\n` +
      `Call get_subagent_result with wait: true again to keep waiting, use peek to check progress, or omit wait to check status.`;
  } else if (outcome === "pending_message") {
    head =
      `Agent is still running. The wait was interrupted by an incoming steering message. The subagent was NOT stopped — it continues in the background.\n` +
      `The queued steering message will be delivered after this tool returns.\n` +
      `Call get_subagent_result with wait: true again to keep waiting, use peek to check progress, or omit wait to check status.`;
  } else {
    head =
      "Agent is still running. Use peek to check recent progress, wait: true to block until it finishes, or check back later.";
  }
  return `${head}\n${STILL_RUNNING_GUIDANCE}`;
}

// --- Steering-only pending detection -----------------------------------------
//
// pi's ctx.hasPendingMessages() is true for BOTH:
//   - steering (Enter while streaming) — should interrupt wait:true
//   - follow-up (Alt+Enter while streaming) — must NOT interrupt wait:true
//
// ExtensionContext does not expose getSteeringMessages(). AgentSession does.
// hasPendingMessages() is implemented as `() => this.pendingMessageCount > 0`
// (or `() => session.pendingMessageCount > 0`), so calling it always reads the
// parent session's pendingMessageCount getter. We briefly observe that access
// to recover the parent session, then check its steering queue only.

let pendingCountProbeInstalled = false;
/** Nested-call-safe capture slot for the session whose pendingMessageCount ran. */
let captureSlot: { session: SessionLike | null } | null = null;

/** Install once: observe AgentSession.pendingMessageCount reads. */
export function installSteeringPendingProbe(): void {
  if (pendingCountProbeInstalled) return;
  pendingCountProbeInstalled = true;

  const desc = Object.getOwnPropertyDescriptor(AgentSession.prototype, "pendingMessageCount");
  if (!desc?.get) return;

  Object.defineProperty(AgentSession.prototype, "pendingMessageCount", {
    configurable: true,
    enumerable: desc.enumerable ?? false,
    get: function pendingMessageCountProbe(this: SessionLike) {
      if (captureSlot) captureSlot.session = this;
      return desc.get!.call(this);
    },
  });
}

/**
 * True when the parent session has at least one queued *steering* message.
 * Follow-up-only queues return false so wait:true keeps blocking.
 */
export function hasSteeringPending(ctx: WaitPendingCtx): boolean {
  if (typeof ctx.hasSteeringMessages === "function") {
    return ctx.hasSteeringMessages();
  }
  if (typeof ctx.getSteeringMessages === "function") {
    return ctx.getSteeringMessages().length > 0;
  }
  if (typeof ctx.hasPendingMessages !== "function") {
    return false;
  }

  installSteeringPendingProbe();
  const slot: { session: SessionLike | null } = { session: null };
  const prev = captureSlot;
  captureSlot = slot;
  try {
    // Always invoke so the pendingMessageCount getter runs even when empty.
    ctx.hasPendingMessages();
  } finally {
    captureSlot = prev;
  }

  const session = slot.session;
  if (session && typeof session.getSteeringMessages === "function") {
    return session.getSteeringMessages().length > 0;
  }

  // Could not resolve a steering-only view. Do not fall back to
  // hasPendingMessages() — that would reintroduce follow-up false positives.
  return false;
}

/**
 * Create a promise that resolves when the parent session has queued *steering*
 * messages. Polls at the given interval. Follow-up messages do not resolve.
 * The caller should race this against agent completion / timeout.
 */
export function pollPendingMessages(
  hasSteering: () => boolean,
  intervalMs = 1000,
): { promise: Promise<void>; cancel: () => void } {
  let settled = false;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });

  // Check immediately in case a steer arrived between the tool call start and
  // this poll setup.
  if (hasSteering()) {
    settled = true;
    resolve();
    return { promise, cancel: () => {} };
  }

  const timer = setInterval(() => {
    if (settled) return;
    if (hasSteering()) {
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
