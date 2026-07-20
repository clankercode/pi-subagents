/**
 * subagent-error-status-e2e.test.ts — regression for issue #144: a subagent
 * whose final assistant turn is a provider error must be reported as a
 * failure, not as "completed" with an empty (or stale) result.
 *
 * Full-stack: real pi loader + real extension + real runAgent + real child
 * sessions on a faux model.
 *
 * This fork always runs Agent in the background, so assertions check the
 * manager record (status/error/result) rather than a synchronous Agent tool
 * result. Completion notifications may not land as plain text in the parent
 * session history under the print-mode harness.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  conversationText,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 30_000 });

// Not matched by pi's transient-error patterns → no auto-retry, deterministic.
const FATAL = "invalid request: provider rejected the prompt";

function agentIdFrom(run: PrintModeRun): string {
  const id = conversationText(run.parentSession).match(/Agent ID: (\S+)/)?.[1];
  expect(id, "background spawn should surface an agent id").toBeTruthy();
  return id!;
}

function recordOf(run: PrintModeRun, id: string): {
  status: string;
  error?: string;
  result?: string;
} {
  const rec = run.manager?.getRecord(id) as
    | { status: string; error?: string; result?: string }
    | undefined;
  expect(rec, `manager record for ${id}`).toBeDefined();
  return rec!;
}

describe("issue #144 — empty-error final turns must not be 'completed'", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("a run whose ONLY turn errors with no output is a failure, not an empty success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "doomed", prompt: "Do work." }),
        parentFinal: "parent done",
        // The child's one and only turn: provider error, zero content.
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    const rec = recordOf(run, agentIdFrom(run));
    expect(rec.status).toBe("error");
    expect(rec.error).toBe(FATAL);
    // No salvaged partial output for a pure empty-error run.
    expect(rec.result?.trim() ?? "").toBe("");
  });

  it("an earlier turn's text must not mask a failed final turn as a fresh success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "masked", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: (ctx) => {
          const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
          // Turn 1: real text + a tool call. Turn 2 (after the tool result):
          // provider error with zero content.
          return hasToolResult
            ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
            : fauxAssistantMessage([
                fauxText("EARLIER-PARTIAL-TEXT"),
                fauxToolCall("bash", { command: "echo hi" }),
              ]);
        },
      }),
    });

    const rec = recordOf(run, agentIdFrom(run));
    expect(rec.status).toBe("error");
    expect(rec.error).toBe(FATAL);
    // Partial progress from earlier turns is preserved as result, not presented as success.
    expect(rec.result).toContain("EARLIER-PARTIAL-TEXT");
  });

  it("a pure empty-error run still surfaces the provider error", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "empty", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    const rec = recordOf(run, agentIdFrom(run));
    expect(rec.status).toBe("error");
    expect(rec.error).toBe(FATAL);
  });
});
