/**
 * get-subagent-result.test.ts — covers the `wait` race (timeout + abort) and the
 * `peek` parameter. Uses the same mock-pi pattern as status-note-wiring.test.ts:
 * mock runAgent so completion is deterministic, then drive the real
 * get_subagent_result tool handler.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { DEFAULT_WAIT_TIMEOUT_SECONDS } from "../src/settings.js";

function makePi() {
  const tools = new Map<string, any>();
  const eventHandlers = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
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

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

/** Spawn a background agent whose promise is controllable for the test. */
async function spawnControllable(tools: Map<string, any>, runAgentMock: ReturnType<typeof vi.fn>) {
  // runAgent returns a never-settling promise; we resolve it on demand.
  let resolveRun!: (v: any) => void;
  runAgentMock.mockReturnValue(
    new Promise((res) => {
      resolveRun = res;
    }),
  );
  const spawn = await tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "d", subagent_type: "general-purpose" },
    undefined, undefined, ctx(),
  );
  const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];
  return { id: id!, resolveRun };
}

describe("get_subagent_result wait race", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wait:true times out and returns status without aborting the subagent", async () => {
    vi.useFakeTimers();
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const { id, resolveRun } = await spawnControllable(tools, vi.mocked(runAgent));
    expect(id).toBeTruthy();

    // Fire the wait with a 1s timeout via settings setter on the tool path is
    // internal; instead advance past DEFAULT_WAIT_TIMEOUT_SECONDS directly.
    const waitPromise = tools.get("get_subagent_result").execute(
      "tc-wait", { agent_id: id, wait: true }, undefined, undefined, ctx(),
    );

    // Subagent is NOT resolved — simulate the timeout firing.
    await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_TIMEOUT_SECONDS * 1000 + 50);

    const res = await waitPromise;
    const out = textOf(res);
    expect(out).toContain("still running");
    expect(out).toMatch(/timed out/i);
    expect(out).toContain("Call get_subagent_result with wait: true again");

    // The subagent promise was never aborted — resolving it later still works.
    resolveRun({ responseText: "LATE", session: { dispose: vi.fn() }, aborted: false, steered: false });
    vi.useRealTimers();
  });

  it("wait:true is cancelled by the user via the parent abort signal", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const { id } = await spawnControllable(tools, vi.mocked(runAgent));
    expect(id).toBeTruthy();

    const ac = new AbortController();
    const waitPromise = tools.get("get_subagent_result").execute(
      "tc-wait", { agent_id: id, wait: true }, ac.signal, undefined, ctx(),
    );

    ac.abort();
    const res = await waitPromise;
    const out = textOf(res);
    expect(out).toContain("still running");
    expect(out).toMatch(/cancelled by the user/i);
    expect(out).toContain("NOT stopped");
  });

  it("wait:true resolves normally when the agent completes first", async () => {
    vi.useFakeTimers();
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const { id, resolveRun } = await spawnControllable(tools, vi.mocked(runAgent));
    expect(id).toBeTruthy();

    const waitPromise = tools.get("get_subagent_result").execute(
      "tc-wait", { agent_id: id, wait: true }, undefined, undefined, ctx(),
    );

    resolveRun({ responseText: "ALL DONE", session: { dispose: vi.fn() }, aborted: false, steered: false });
    const res = await waitPromise;
    expect(textOf(res)).toContain("ALL DONE");
    vi.useRealTimers();
  });
});

describe("get_subagent_result peek", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the last N lines of the result with line numbers", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    // Spawn + complete with multi-line result.
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "line one\nline two\nline three",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const spawn = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const res = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: id!, peek: { lines: 2 } }, undefined, undefined, ctx(),
    );
    const out = textOf(res);
    expect(out).toContain("[2] line two");
    expect(out).toContain("[3] line three");
    expect(out).not.toContain("[1] line one");
    expect(out).toContain("last 2 lines");
  });

  it("filter-then-tail applies regex before selecting lines", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    vi.mocked(runAgent).mockResolvedValue({
      responseText: "alpha\nbeta\ngamma\nALPHA\ndelta",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const spawn = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const res = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: id!, peek: { regex: "alpha", lines: 1 } }, undefined, undefined, ctx(),
    );
    const out = textOf(res);
    // Only lines matching /alpha/ (case-sensitive): line 1 "alpha", line 4 "ALPHA" does NOT match.
    expect(out).toContain("[1] alpha");
    expect(out).not.toContain("[4] ALPHA");
    expect(out).not.toContain("[2] beta");
    expect(out).toContain("filtered by regex /alpha/");
  });

  it("after returns all lines past the given index", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    vi.mocked(runAgent).mockResolvedValue({
      responseText: "a\nb\nc\nd",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const spawn = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const res = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: id!, peek: { after: 2 } }, undefined, undefined, ctx(),
    );
    const out = textOf(res);
    // after line number 2 → lines 3 and 4
    expect(out).toContain("[3] c");
    expect(out).toContain("[4] d");
    expect(out).not.toContain("[2] b");
    expect(out).toContain("after line number 2");
  });

  it("peek is ignored when verbose is true", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    vi.mocked(runAgent).mockResolvedValue({
      responseText: "result body",
      session: { messages: [], dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });
    const spawn = await tools.get("Agent").execute(
      "tc", { prompt: "go", description: "d", subagent_type: "general-purpose" },
      undefined, undefined, ctx(),
    );
    const id = textOf(spawn).match(/Agent ID: (\S+)/)?.[1];

    const res = await tools.get("get_subagent_result").execute(
      "tc", { agent_id: id!, verbose: true, peek: { lines: 2 } }, undefined, undefined, ctx(),
    );
    // verbose path runs (no peek header), result body present.
    expect(textOf(res)).toContain("result body");
    expect(textOf(res)).not.toContain("last 2 lines");
  });
});
