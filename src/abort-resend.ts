import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Register a keyboard shortcut that aborts the current streaming turn and
 * auto-sends any queued follow-up message(s) as the next turn — instead of the
 * default Escape behavior (restore the queue into the editor for editing).
 *
 * Key precedence: PI_ABORT_RESEND_KEY env var > the `abortResendKey` setting >
 * "f9" (the default — a distinct key on every terminal; shift+escape is
 * indistinguishable from escape on terminals that don't negotiate the kitty
 * keyboard protocol).
 *
 * This is a workaround for a core-harness behavior: Escape always calls
 * `restoreQueuedMessagesToEditor({ abort: true })`, putting queued messages back
 * in the editor. There is no extension API to flush the internal queue as a turn
 * atomically. This shortcut reads the text that abort just restored into the
 * editor, clears it, and re-queues it as a followUp so it fires automatically as
 * the next turn — no manual re-submit needed.
 *
 * Mechanics:
 *  1. `ctx.abort()` is synchronous: it calls restoreQueuedMessagesToEditor which
 *     sets the editor text, THEN agent.abort(). So getEditorText() right after
 *     captures the restored queue.
 *  2. `pi.sendUserMessage(text, { deliverAs: "followUp" })` is safe in both
 *     states: if the turn has wound down (idle) it starts a fresh turn; if still
 *     streaming it queues as the next turn. It never injects into a running
 *     subagent (that would be deliverAs: "steer").
 *
 * State handling:
 *  - idle                       → no-op (preserves any editor draft)
 *  - streaming, nothing queued  → plain abort (preserves editor draft)
 *  - streaming, queued messages → abort + clear restored text + resend as followUp
 *
 * The shortcut is registered once at session start, so changing the setting
 * applies on the next pi session (consistent with schedulingEnabled /
 * toolDescriptionMode).
 */
export function registerAbortResend(pi: ExtensionAPI, settingKey?: string): void {
  const ABORT_RESEND_SHORTCUT: KeyId = (process.env.PI_ABORT_RESEND_KEY ?? settingKey ?? "f9") as KeyId;
  pi.registerShortcut(ABORT_RESEND_SHORTCUT, {
    description: "Abort current turn and auto-send queued message(s) as the next turn",
    handler: (ctx) => {
      // Idle: nothing to abort; leave any editor draft untouched.
      if (ctx.isIdle()) return;

      // Snapshot whether anything is queued BEFORE abort — abort clears the
      // internal queue and restores it to the editor, so hasPendingMessages()
      // would read false afterwards.
      const hadQueued = ctx.hasPendingMessages();

      // Abort restores queued messages to the editor synchronously, then aborts.
      ctx.abort();

      // No queued message → this was a plain abort; preserve the editor draft.
      if (!hadQueued) return;

      // Read the text abort just restored into the editor, clear it, and re-queue
      // it as a followUp so it auto-runs as the next turn.
      const text = ctx.ui.getEditorText().trim();
      ctx.ui.setEditorText("");
      if (text) {
        pi.sendUserMessage(text, { deliverAs: "followUp" });
      }
    },
  });
}
