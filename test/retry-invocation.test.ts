/**
 * retry-invocation.test.ts — covers recoverable Agent invocations.
 *
 * On pre-spawn validation failures (model not found / out of scope), the Agent
 * tool now stashes the full invocation under a short handle and returns a hint
 * telling the orchestrator to re-invoke with { retry, model }. The retry
 * reloads the stashed prompt and overlays the new params. Uses the mock-pi
 * pattern from status-note-wiring.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    on: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        eventHandlers.set(event, handler);
        return vi.fn();
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, eventHandlers };
}

/** A model registry with one available model "faux/ok". */
function registry() {
  const available = [{ id: "ok", name: "Ok", provider: "faux", contextWindow: 200_000 }];
  return {
    find: (provider: string, modelId: string) =>
      provider === "faux" && modelId === "ok" ? available[0] : undefined,
    getAll: () => available,
    getAvailable: () => available,
  } as any;
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: registry(),
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

describe("Agent retry handle (recoverable invocation)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("model-not-found stashes the invocation and returns a retry handle", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const res = await tools.get("Agent").execute(
      "tc1",
      {
        prompt: "Do something elaborate that I do NOT want to retype.",
        description: "work",
        subagent_type: "general-purpose",
        model: "does-not-exist",
      },
      undefined, undefined, ctx(),
    );

    const out = textOf(res);
    expect(out).toContain("Model not found");
    const handle = out.match(/"retry": "([^"]+)"/)?.[1];
    expect(handle, "result must advertise a retry handle").toBeTruthy();
    // The hint explains the prompt is preserved.
    expect(out).toMatch(/do NOT need to retype the prompt/i);
  });

  it("retry with a valid model spawns successfully and preserves the prompt", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "PRESERVED OUTPUT",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools } = makePi();
    subagentsExtension(pi);

    // First call: bad model → get a handle.
    const fail = await tools.get("Agent").execute(
      "tc1",
      { prompt: "ORIGINAL PROMPT BODY", description: "work", subagent_type: "general-purpose", model: "nope" },
      undefined, undefined, ctx(),
    );
    const handle = textOf(fail).match(/"retry": "([^"]+)"/)?.[1];
    expect(handle).toBeTruthy();

    // Retry with the valid model and NO prompt — it must come from the stash.
    const spawn = await tools.get("Agent").execute(
      "tc2",
      { retry: handle, model: "faux/ok", description: "work" } as any,
      undefined, undefined, ctx(),
    );
    const out = textOf(spawn);
    expect(out).toMatch(/started in background|queued/i);

    // The spawned agent's runAgent was called with the PRESERVED prompt.
    const passedPrompt = vi.mocked(runAgent).mock.calls.at(-1)?.[2];
    expect(passedPrompt).toBe("ORIGINAL PROMPT BODY");
  });

  it("repeated failures keep the handle stable so one handle retries N times", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const fail1 = await tools.get("Agent").execute(
      "tc1",
      { prompt: "P", description: "d", subagent_type: "general-purpose", model: "bad-one" },
      undefined, undefined, ctx(),
    );
    const h1 = textOf(fail1).match(/"retry": "([^"]+)"/)?.[1];

    // Retry with ANOTHER bad model → same handle must be returned.
    const fail2 = await tools.get("Agent").execute(
      "tc2",
      { retry: h1, model: "bad-two" } as any,
      undefined, undefined, ctx(),
    );
    const h2 = textOf(fail2).match(/"retry": "([^"]+)"/)?.[1];
    expect(h2).toBe(h1);
  });

  it("an unknown/expired retry handle returns a clear error", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const res = await tools.get("Agent").execute(
      "tc1",
      { retry: "retry-deadbeef", model: "faux/ok" } as any,
      undefined, undefined, ctx(),
    );
    expect(textOf(res)).toMatch(/not found or has expired/i);
  });

  it("retry can override subagent_type from the stashed value", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "OK",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const fail = await tools.get("Agent").execute(
      "tc1",
      { prompt: "P", description: "d", subagent_type: "general-purpose", model: "nope" },
      undefined, undefined, ctx(),
    );
    const handle = textOf(fail).match(/"retry": "([^"]+)"/)?.[1];

    // Retry overriding to Explore (read-only default) with a valid model.
    const spawn = await tools.get("Agent").execute(
      "tc2",
      { retry: handle, model: "faux/ok", subagent_type: "Explore" } as any,
      undefined, undefined, ctx(),
    );
    // Explore is a valid default type → should spawn (not fall back / not error).
    expect(textOf(spawn)).toMatch(/started in background|queued/i);
    const passedType = vi.mocked(runAgent).mock.calls.at(-1)?.[1];
    expect(String(passedType).toLowerCase()).toBe("explore");
  });
});
