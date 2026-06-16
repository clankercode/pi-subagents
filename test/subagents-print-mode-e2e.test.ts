/**
 * subagents-print-mode-e2e.test.ts — REAL end-to-end subagent runs through the
 * headless print-mode host (`test/helpers/print-mode-runner.ts`).
 *
 * Unlike agent-runner-e2e / ext-templates-e2e (which assert on the gated tool
 * set captured at construction and never drive a turn), these tests drive a real
 * parent turn that calls the `Agent` tool, lets the extension spawn a real child
 * session via the real `runAgent`, and waits for it through the real subagent
 * hold condition — then asserts on what actually flowed back.
 *
 * Deterministic by default: a scripted faux model drives both parent and child
 * (no network). The same runner also drives a real LLM when PI_E2E_LIVE=1 — the
 * `live` describe below is a smoke test for that opt-in path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  agentToolCalls,
  agentToolResults,
  conversationText,
  invokedToolNames,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

// Real pi-mono (loader + dynamic extension import + two live sessions) — a cold
// run under full-suite CPU contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const LIVE = /^(1|true|yes)$/i.test(process.env.PI_E2E_LIVE ?? "");

describe.skipIf(LIVE)("subagents print-mode e2e (scripted faux, real pi-mono)", () => {
  let run: PrintModeRun | undefined;
  const tmpDirs: string[] = [];

  afterEach(async () => {
    await run?.dispose();
    run = undefined;
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("spawns a BACKGROUND subagent and routes its real output back to the parent", async () => {
    run = await runPrintMode({
      prompt: "Delegate the greeting to a subagent.",
      respond: routeBySession({
        parentInitial: agentCall({
          subagent_type: "general-purpose",
          description: "greet",
          prompt: "Say hello.",
        }),
        // NON-circular: the parent's final answer echoes whatever the child's
        // result actually was in context. For a background spawn the result
        // arrives via a held follow-up nudge, not the synchronous tool result.
        parentFinal: (ctx: Context) => {
          const allText = ctx.messages
            .flatMap((m) => (Array.isArray((m as any).content) ? (m as any).content : []))
            .map((b: any) => (b.type === "text" ? b.text ?? "" : ""))
            .join("\n");
          return `Parent relays: ${allText.includes("CHILD_GREETING_OK") ? "CHILD_GREETING_OK" : "CHILD_MISSING"}`;
        },
        subagent: "CHILD_GREETING_OK",
      }),
    });

    // The child actually ran: its output reached the parent via the held
    // background completion nudge, and the parent's final answer was derived
    // from that result — not a value the test hard-coded into the parent.
    expect(conversationText(run.parentSession)).toContain("CHILD_GREETING_OK");
    expect(run.responseText).toContain("CHILD_GREETING_OK");
    expect(run.responseText).not.toContain("CHILD_MISSING");
    // Parent t1 (Agent call) + parent t2 (held nudge processed) + child t1 (reply) + parent t3 (final) = 4 calls.
    expect(run.modelCalls).toBeGreaterThanOrEqual(4);
  });

  it("the hold condition is load-bearing: it keeps a BACKGROUND child alive (vs abandoned without it)", async () => {
    // The child takes a beat to "think" (a real delay in its faux turn). That
    // delay is what makes the contrast causal and deterministic:
    //   - WITHOUT the hold, the parent's turn ends and the runner tears down
    //     before the child ever streams → the child is abandoned (2 model calls:
    //     parent's tool-call turn + its summary turn; the child never runs).
    //   - WITH the hold, the parent loop blocks in waitForAll() until the child
    //     finishes → the child's own model turn actually runs (≥3 calls).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const respond = async (ctx: Context) => {
      const isParent = (ctx.tools ?? []).some((t) => t.name === "Agent");
      if (!isParent) {
        await sleep(80); // child takes long enough that a non-held parent exits first
        return "CHILD_BG_RAN";
      }
      const spawned = ctx.messages.some(
        (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
      );
      return spawned
        ? "summarized"
        : agentCall({ description: "bg work", prompt: "Do background work.", run_in_background: true });
    };

    // Control: no hold → the child hasn't run by the time the parent turn ends.
    // `modelCalls` is snapshotted at that moment (it's a plain number on the
    // result), so draining afterwards to tear down cleanly doesn't change it.
    const noHold = await runPrintMode({ prompt: "go", hold: false, respond });
    const abandonedCalls = noHold.modelCalls;
    await noHold.manager?.waitForAll(); // let the orphan finish before dispose (avoids stale-ctx)
    await noHold.dispose();

    // Subject: hold on → child runs to completion before the parent finishes.
    run = await runPrintMode({ prompt: "go", hold: true, respond });

    // Background spawn returns its envelope synchronously either way.
    expect(agentToolResults(run.parentSession)[0]).toMatch(/background/i);
    // The hold is load-bearing: only with it does the child's turn actually run.
    expect(abandonedCalls).toBe(2); // parent tool-call + summary; child never streamed
    expect(run.modelCalls).toBeGreaterThan(abandonedCalls);
    expect(run.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("spawns a FRONTMATTER-defined (.pi/agents/*.md) background agent and its prompt reaches the child", async () => {
    // A project agent whose body is a distinctive system prompt. Proving the
    // child SAW it proves the full chain: the extension discovers the .md from
    // process.cwd(), parses its frontmatter, and runAgent's buildAgentPrompt
    // feeds the body into the real child session.
    const MARKER = "SPYMARKER_FRONTMATTER_REACHED_CHILD";
    const cwd = mkdtempSync(join(tmpdir(), "subagents-fm-"));
    tmpDirs.push(cwd);
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "agents", "echo-spy.md"),
      `---\ndescription: "Echoes a marker proving its frontmatter prompt reached the child."\n---\n${MARKER}\n`,
    );

    let agentId: string | undefined;
    run = await runPrintMode({
      prompt: "Delegate to the echo-spy agent.",
      cwd, // runner chdir's here so the extension discovers echo-spy.md
      respond: (ctx: Context) => {
        const isParent = (ctx.tools ?? []).some((t) => t.name === "Agent");
        if (!isParent) {
          return `child saw: ${ctx.systemPrompt?.includes(MARKER) ? MARKER : "MISSING"}`;
        }
        const spawned = ctx.messages.some(
          (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
        );
        if (!spawned) {
          return agentCall({
            subagent_type: "echo-spy",
            description: "echo",
            prompt: "Report what you were told.",
          });
        }
        if (!agentId) {
          const toolResult = ctx.messages
            .filter((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent")
            .pop();
          const text = (toolResult?.content as Array<{ type?: string; text?: string }> ?? [])
            .map((b) => (b.type === "text" ? b.text ?? "" : ""))
            .join("");
          agentId = text.match(/Agent ID: (\S+)/)?.[1];
          if (agentId) {
            return fauxToolCall("get_subagent_result", { agent_id: agentId, wait: true });
          }
        }
        // After get_subagent_result, summarize what we learned.
        const transcript = conversationText(ctx as any);
        return transcript.includes(MARKER) ? `PARENT_SAW_${MARKER}` : "PARENT_SAW_MISSING";
      },
    });

    // The child output should be retrievable and contain the marker.
    expect(conversationText(run.parentSession)).toContain(MARKER);
    expect(conversationText(run.parentSession)).not.toContain("MISSING");
    expect(run.responseText).toContain(MARKER);
    expect(run.responseText).not.toContain("MISSING");
    // The custom type resolved — it did NOT silently fall back to general-purpose.
    expect(conversationText(run.parentSession)).not.toMatch(/Unknown agent type/i);
  });

  it("errors clearly when faux mode is given no script", async () => {
    await expect(runPrintMode({ prompt: "x" })).rejects.toThrow(/provide `respond` or `steps`/);
  });
});

// Opt-in real-LLM smoke tests — exercise the SAME runner against a live model
// (auto-resolved from the local `pi` login). Skipped unless PI_E2E_LIVE=1.
//
// These are SMOKE tests, not strict assertions: a live model decides whether and
// how to call the tool, so we cover the subset it can be reliably steered into
// (foreground spawn, background spawn + get_subagent_result, an Explore spawn)
// and assert robust invariants (a real spawn happened and produced output).
// Per-feature determinism lives in the faux suite above, which scripts exact calls.
const LIVE_TIMEOUT = 150_000;

describe.runIf(LIVE)("subagents print-mode e2e (live LLM, opt-in)", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it(
    "BACKGROUND spawn — real model spawns a subagent and reports its output",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use the Agent tool to spawn a general-purpose subagent whose only task is to reply " +
          "with the exact word PONG. Wait for it to complete, then tell me what it replied.",
        timeoutMs: LIVE_TIMEOUT,
      });
      expect(run.modelCalls).toBe(0); // live mode doesn't use the faux counter
      expect(invokedToolNames(run.parentSession)).toContain("Agent");
      // The child actually ran and its output materialized in the conversation.
      expect(conversationText(run.parentSession)).toMatch(/PONG/i);
      expect(run.responseText).toMatch(/PONG/i);
    },
    LIVE_TIMEOUT,
  );

  it(
    "BACKGROUND spawn + get_subagent_result — model backgrounds work then retrieves it",
    async () => {
      run = await runPrintMode({
        prompt:
          "Spawn a general-purpose subagent whose only task is to reply with the exact word " +
          "BGPONG. After it finishes, use the get_subagent_result tool to fetch its result, " +
          "then tell me exactly what it said.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      // Agents always run in the background now.
      expect(calls.some((c) => c.run_in_background !== false || c.run_in_background == null)).toBe(true);
      // The spawn returned the "started in background" envelope…
      expect(agentToolResults(run.parentSession).join("\n")).toMatch(/background/i);
      // …and the background child genuinely ran (its result surfaced somewhere:
      // via get_subagent_result and/or the held final answer).
      expect(run.responseText).toMatch(/BGPONG/i);
    },
    LIVE_TIMEOUT,
  );

  it(
    "Explore subagent_type — model dispatches a non-default agent type",
    async () => {
      run = await runPrintMode({
        prompt:
          "Use the Agent tool with subagent_type 'Explore' to look at the current working " +
          "directory and report a one-line summary of what's there.",
        timeoutMs: LIVE_TIMEOUT,
      });
      const calls = agentToolCalls(run.parentSession);
      // The non-default type was actually selected (case-insensitive per README).
      expect(
        calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "explore"),
      ).toBe(true);
      expect(run.responseText.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT,
  );

  it(
    "SELF-SMOKE — the agent drives a multi-feature smoke of its own Agent toolset",
    async () => {
      // Agent-driven (not puppeted): one prompt, the model itself exercises three
      // Agent capabilities in a single session and self-reports. We then assert it
      // genuinely invoked each feature (not just that it claimed to in prose).
      run = await runPrintMode({
        prompt: [
          "You are smoke-testing your own Agent toolset. Do these steps IN ORDER, then print a",
          "final report with one PASS/FAIL line per step:",
          "1) FIRST SPAWN: spawn a general-purpose subagent whose only task is to reply with the",
          "   exact token FG_OK. Confirm you got FG_OK back.",
          "2) SECOND SPAWN + get_subagent_result: spawn another general-purpose subagent whose only",
          "   task is to reply with the exact token BG_OK. After it finishes, call get_subagent_result",
          "   to retrieve its output. Confirm you got BG_OK.",
          "3) EXPLORE: spawn a subagent with subagent_type 'Explore' to summarize the current",
          "   working directory in one line.",
          "Finish with: 'SELF-SMOKE COMPLETE' followed by the PASS/FAIL lines.",
        ].join("\n"),
        timeoutMs: LIVE_TIMEOUT,
      });

      const calls = agentToolCalls(run.parentSession);
      const tools = invokedToolNames(run.parentSession);

      // Each capability was actually exercised at the tool layer (not just narrated):
      // — at least one agent was spawned
      expect(calls.length).toBeGreaterThanOrEqual(2);
      // — the result-retrieval tool was called
      expect(tools).toContain("get_subagent_result");
      // — the Explore type was dispatched
      expect(calls.some((c) => String(c.subagent_type ?? "").toLowerCase() === "explore")).toBe(true);
      // — and the real child outputs materialized in the conversation.
      const transcript = conversationText(run.parentSession);
      expect(transcript).toMatch(/FG_OK/i);
      expect(transcript).toMatch(/BG_OK/i);
      // The agent ran the whole script to completion and self-reported.
      expect(run.responseText).toMatch(/SELF-SMOKE COMPLETE/i);
    },
    LIVE_TIMEOUT,
  );
});
