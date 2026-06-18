/**
 * Opt-in live notification e2e tests.
 *
 * These call the local `pi --list-models` CLI to discover the requested
 * Minimax M2.7 highspeed model, then drive the real print-mode runner against
 * that model. They are skipped unless PI_E2E_LIVE=1 and the model is available.
 *
 * Run the live path from the repo root with:
 * PATH="$PWD/node_modules/.bin:$PATH" PI_E2E_LIVE=1 npm test -- test/notification-live-pi-e2e.test.ts
 */
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokedToolNames,
  type PrintModeRun,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

const LIVE_TIMEOUT = 180_000;

function discoverMinimaxHighspeed(
  env: NodeJS.ProcessEnv = process.env,
  exec: typeof spawnSync = spawnSync,
): { provider: string; model: string } | undefined {
  if (!/^(1|true|yes)$/i.test(env.PI_E2E_LIVE ?? "")) return undefined;
  try {
    const result = exec("pi", ["--list-models"], {
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return undefined;
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    for (const line of out.split("\n")) {
      const [provider, model] = line.trim().split(/\s+/, 3);
      const haystack = `${provider ?? ""} ${model ?? ""}`.toLowerCase();
      if (
        provider &&
        model &&
        haystack.includes("minimax") &&
        haystack.includes("m2") &&
        haystack.includes("highspeed")
      ) {
        return { provider, model };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

const LIVE_MODEL = discoverMinimaxHighspeed();

function customNotificationText(run: PrintModeRun): string {
  return run.parentSession.messages
    .filter((m) => (m as { role?: string; customType?: string }).role === "custom" &&
      (m as { customType?: string }).customType === "subagent-notification")
    .map((m) => {
      const content = (m as { content?: unknown }).content;
      const text = Array.isArray(content)
        ? content.map((b) => ((b as { type?: string; text?: string }).type === "text" ? (b as { text?: string }).text ?? "" : "")).join("")
        : typeof content === "string"
          ? content
          : "";
      const details = (m as { details?: { resultPreview?: string; others?: Array<{ resultPreview?: string }> } }).details;
      return [text, details?.resultPreview, ...(details?.others ?? []).map((d) => d.resultPreview ?? "")]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

function expectDeliveredNotification(run: PrintModeRun, ...tokens: string[]) {
  const notification = customNotificationText(run);
  expect(notification).toContain("<task-notification>");
  for (const token of tokens) {
    expect(notification).toMatch(new RegExp(token, "i"));
  }
}

function expectNoResultPolling(run: PrintModeRun) {
  expect(invokedToolNames(run.parentSession)).not.toContain("get_subagent_result");
}

describe("Minimax live model discovery", () => {
  it("is strictly gated by PI_E2E_LIVE and ignores PI_PROVIDER/PI_MODEL overrides", () => {
    const exec = vi.fn(() => {
      throw new Error("pi --list-models should not be called when live mode is off");
    }) as unknown as typeof spawnSync;

    expect(discoverMinimaxHighspeed({ PI_PROVIDER: "anthropic", PI_MODEL: "claude" }, exec)).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("discovers Minimax M2.7 highspeed only from local pi --list-models output", () => {
    const exec = vi.fn(() => ({
      status: 0,
      signal: null,
      error: undefined,
      stdout: "",
      stderr: "anthropic claude-sonnet\nminimax minimax-m2.7-highspeed\n",
      pid: 1,
      output: [null, "", "anthropic claude-sonnet\nminimax minimax-m2.7-highspeed\n"],
    })) as unknown as typeof spawnSync;

    expect(discoverMinimaxHighspeed({ PI_E2E_LIVE: "1", PI_PROVIDER: "ignored", PI_MODEL: "ignored" }, exec)).toEqual({
      provider: "minimax",
      model: "minimax-m2.7-highspeed",
    });
    expect(exec).toHaveBeenCalledWith("pi", ["--list-models"], expect.any(Object));
  });
});

describe.runIf(Boolean(LIVE_MODEL))("subagent notification delivery live e2e (Minimax M2.7 highspeed)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it(
    "delivers a completion notification while the parent agent is still busy",
    async () => {
      run = await runPrintMode({
        live: LIVE_MODEL!,
        prompt: [
          "Use the Agent tool to spawn a general-purpose subagent whose only task is to reply with BUSY_NOTIFY_TOKEN.",
          "After spawning it, keep working in the parent for a short paragraph before reporting the subagent result.",
          "Do not call get_subagent_result. Wait for the automatic completion notification.",
          "Your final answer must include BUSY_NOTIFY_TOKEN only if you actually received that notification.",
        ].join("\n"),
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(invokedToolNames(run.parentSession)).toContain("Agent");
      expectNoResultPolling(run);
      expectDeliveredNotification(run, "BUSY_NOTIFY_TOKEN");
    },
    LIVE_TIMEOUT,
  );

  it(
    "delivers a completion notification after the parent becomes idle and triggers the next turn",
    async () => {
      run = await runPrintMode({
        live: LIVE_MODEL!,
        prompt: [
          "Use the Agent tool to spawn a general-purpose subagent whose only task is to reply with IDLE_NOTIFY_TOKEN.",
          "After the spawn tool returns, do not call get_subagent_result.",
          "End this turn immediately with exactly: WAITING_FOR_NOTIFICATION",
        ].join("\n"),
        hold: false,
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(invokedToolNames(run.parentSession)).toContain("Agent");
      expectNoResultPolling(run);
      expect(run.responseText).toMatch(/WAITING_FOR_NOTIFICATION/i);

      await run.manager?.waitForAll();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expectDeliveredNotification(run, "IDLE_NOTIFY_TOKEN");

      await run.parentSession.prompt(
        "Continue from the delivered subagent notification. Answer with only the token you received.",
        { streamingBehavior: "steer" } as any,
      );
      expectNoResultPolling(run);
    },
    LIVE_TIMEOUT,
  );

  it(
    "delivers multiple completion notifications from parallel background agents",
    async () => {
      run = await runPrintMode({
        live: LIVE_MODEL!,
        prompt: [
          "In one response, call the Agent tool twice in parallel.",
          "First subagent replies exactly MULTI_NOTIFY_ONE. Second subagent replies exactly MULTI_NOTIFY_TWO.",
          "Do not call get_subagent_result. Use the automatic completion notifications to produce a final answer containing both tokens.",
        ].join("\n"),
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(invokedToolNames(run.parentSession).filter((n) => n === "Agent").length).toBeGreaterThanOrEqual(2);
      expectNoResultPolling(run);
      const notification = customNotificationText(run);
      expect(notification).toContain("<task-notification>");
      expect(notification).toMatch(/MULTI_NOTIFY_ONE|MULTI_NOTIFY_TWO/i);
    },
    LIVE_TIMEOUT,
  );
});

describe.skipIf(Boolean(LIVE_MODEL))("subagent notification delivery live e2e (Minimax M2.7 highspeed)", () => {
  it("is skipped until PI_E2E_LIVE=1 and `pi --list-models` exposes Minimax M2.7 highspeed", () => {
    expect(LIVE_MODEL).toBeUndefined();
  });
});
