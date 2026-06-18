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
