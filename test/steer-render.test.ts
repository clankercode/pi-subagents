import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

function makePi() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

describe("steer_subagent renderCall", () => {
  it("shows a truncated one-line preview of the steering message", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const rendered = tools.get("steer_subagent").renderCall(
      {
        agent_id: "agent-123",
        message:
          "Please stop the previous approach.\nInstead inspect the parser and summarize the concrete failure mode before editing files. " +
          "This trailing text should not fit in the compact call preview.",
      },
      theme,
    );

    const text = rendered.render(200).join("\n");
    expect(text).toContain("Steer Agent");
    expect(text).toContain("agent-123");
    expect(text).toContain("Please stop the previous approach. Instead inspect");
    expect(text).toContain("…");
    expect(text).not.toContain("This trailing text should not fit");
  });
});

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

describe("Agent prompt preview streaming", () => {
  it("streams the tail of the Agent prompt while the tool call is executing", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const onUpdate = vi.fn();

    await tools.get("Agent").execute(
      "tc-preview",
      {
        subagent_type: "missing-agent",
        description: "preview",
        prompt:
          "First sentence should fall out of the preview. " +
          "Second sentence is also too early. " +
          "The most recent prompt content should stay visible.",
      },
      undefined,
      onUpdate,
      ctx(),
    );

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          status: "running",
          activity: expect.stringContaining("The most recent prompt content should stay visible."),
        }),
      }),
    );
    expect(onUpdate.mock.calls[0][0].details.activity).not.toContain("First sentence");
  });
});

describe("Agent result renderResult", () => {
  it("snips long collapsed responses to first and last 20 lines", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const resultText = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

    const rendered = tools.get("Agent").renderResult(
      {
        content: [{ type: "text", text: resultText }],
        details: {
          displayName: "Agent",
          description: "long result",
          subagentType: "general-purpose",
          toolUses: 0,
          tokens: "",
          durationMs: 1000,
          status: "completed",
        },
      },
      { expanded: false, isPartial: false },
      theme,
    );

    const text = rendered.render(200).join("\n");
    expect(text).toContain("line 1");
    expect(text).toContain("line 20");
    expect(text).toContain("... 10 lines omitted; expand for full output ...");
    expect(text).toContain("line 31");
    expect(text).toContain("line 50");
    expect(text).not.toContain("line 21");
    expect(text).not.toContain("line 30");
  });

  it("shows the full response when expanded", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const resultText = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");

    const rendered = tools.get("Agent").renderResult(
      {
        content: [{ type: "text", text: resultText }],
        details: {
          displayName: "Agent",
          description: "long result",
          subagentType: "general-purpose",
          toolUses: 0,
          tokens: "",
          durationMs: 1000,
          status: "completed",
        },
      },
      { expanded: true, isPartial: false },
      theme,
    );

    const text = rendered.render(200).join("\n");
    expect(text).toContain("line 21");
    expect(text).toContain("line 30");
    expect(text).not.toContain("lines omitted");
  });
});

describe("Agent renderCall", () => {
  it("shows just the agent name and description when no call-time metadata is set", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "general-purpose", description: "summarize repo" },
      theme,
    );
    const text = rendered.render(200).join("\n");
    expect(text).toContain("Agent");
    expect(text).toContain("summarize repo");
    expect(text).not.toContain("·");
    expect(text).not.toMatch(/claude|sonnet|haiku|opus/i);
  });

  it("surfaces an explicit per-call model override", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const rendered = tools.get("Agent").renderCall(
      {
        subagent_type: "general-purpose",
        description: "summarize repo",
        model: "anthropic/claude-sonnet-4-5",
      },
      theme,
    );
    const text = rendered.render(200).join("\n");
    expect(text).toContain("claude-sonnet-4-5");
    expect(text).toContain("Agent");
  });

  it("surfaces a model pinned in the agent's frontmatter config", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    // The Explore default agent pins claude-haiku-4-5 in its frontmatter —
    // no per-call `model` arg needed, renderCall should still surface it.
    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "Explore", description: "scan repo" },
      theme,
    );
    const text = rendered.render(200).join("\n");
    expect(text).toContain("claude-haiku-4-5");
    expect(text).toContain("Explore");
  });

  it("joins multiple call-time badges with a separator and keeps order stable", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const rendered = tools.get("Agent").renderCall(
      {
        subagent_type: "general-purpose",
        description: "fan out",
        model: "haiku",
        isolation: "worktree",
      },
      theme,
    );
    const text = rendered.render(200).join("\n");
    // Order matters: model is always first when present, then flags in source order.
    const modelIdx = text.indexOf("haiku");
    const worktreeIdx = text.indexOf("worktree");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(worktreeIdx).toBeGreaterThan(modelIdx);
    expect(text).toContain("·");
  });

  it("shows resume and schedule as their own dimmed badges with truncated IDs", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const rendered = tools.get("Agent").renderCall(
      {
        subagent_type: "general-purpose",
        description: "follow-up",
        resume: "agent-abcdef1234567890",
        schedule: "every weekday 09:00",
      },
      theme,
    );
    const text = rendered.render(200).join("\n");
    // compactPreview caps resume at 12 chars (incl. ellipsis); the full ID
    // should NOT appear, but the truncated prefix should.
    expect(text).toContain("resume: agent-abcde");
    expect(text).toContain("…");
    expect(text).not.toContain("agent-abcdef1234567890");
    expect(text).toContain("schedule: every weekday 09:00");
  });

  it("truncates long schedule values rather than wrapping the call", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const longSchedule = "every minute of every day of every week of every month of every year forever";
    const rendered = tools.get("Agent").renderCall(
      { subagent_type: "general-purpose", description: "x", schedule: longSchedule },
      theme,
    );
    const text = rendered.render(200).join("\n");
    expect(text).toContain("…");
    expect(text).not.toContain(longSchedule);
  });
});
