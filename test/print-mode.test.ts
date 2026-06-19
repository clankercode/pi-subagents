import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
    resumeAgent: vi.fn(),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const eventHandlers = new Map<string, any>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn((event: string, handler: any) => {
          eventHandlers.set(event, handler);
          return vi.fn();
        }),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(() => {
        throw new Error("stale extension context");
      }),
    } as any,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as any;
}

describe("print mode background notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("ignores stale-context errors from delayed completion nudges", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    vi.useFakeTimers();

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    await vi.advanceTimersByTimeAsync(100); // smart-join batch debounce
    await vi.advanceTimersByTimeAsync(200); // notification hold window

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      expect.objectContaining({ deliverAs: "steer", triggerTurn: true }),
    );

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("emits started lifecycle snapshots rich enough for recursive widget aggregation", async () => {
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);

    const agentTool = tools.get("Agent");
    await agentTool.execute(
      "tool-call-1",
      {
        prompt: "reply done",
        description: "tiny child",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    expect(pi.events.emit).toHaveBeenCalledWith("subagents:started", expect.objectContaining({
      id: expect.any(String),
      description: "tiny child",
      status: "running",
      toolUses: 0,
      startedAt: expect.any(Number),
      depth: 1,
    }));

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });

  it("returns immediately for resume and sends the resumed result as a steering notification", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: { dispose: vi.fn() } as any,
      aborted: false,
      steered: false,
    });

    const { pi, tools, handlers } = makePi();
    pi.sendMessage = vi.fn();
    subagentsExtension(pi);

    const agentTool = tools.get("Agent");
    const first = await agentTool.execute(
      "tool-call-1",
      {
        prompt: "start",
        description: "resumable child",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );
    const id = first.content[0].text.match(/Agent ID: (\S+)/)?.[1];
    expect(id).toBeTruthy();

    await vi.advanceTimersByTimeAsync(250);
    vi.mocked(pi.sendMessage).mockClear();

    let resolveResume!: (value: string) => void;
    vi.mocked(resumeAgent).mockReturnValue(
      new Promise((resolve) => {
        resolveResume = resolve;
      }),
    );

    const resumed = await agentTool.execute(
      "tool-call-2",
      {
        resume: id,
        prompt: "continue",
        description: "ignored on resume",
        subagent_type: "general-purpose",
      },
      undefined,
      undefined,
      makeHeadlessCtx(),
    );

    expect(resumed.content[0].text).toContain("Agent resumed in background.");
    expect(resumed.content[0].text).toContain(`Agent ID: ${id}`);
    expect(resumed.content[0].text).not.toContain("resumed output");

    resolveResume("resumed output");
    await vi.advanceTimersByTimeAsync(250);

    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("resumed output"),
      }),
      expect.objectContaining({ deliverAs: "steer", triggerTurn: true }),
    );

    await handlers.get("session_shutdown")?.({}, makeHeadlessCtx());
  });
});
