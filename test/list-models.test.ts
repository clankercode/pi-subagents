import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";

/** Fake pi where registerTool captures into a Map for inspection. */
function makePi() {
  const tools = new Map<string, any>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn(),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
  };
}

function ctxWithRegistry(modelRegistry: any, model?: any) {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: "/tmp",
    model,
    modelRegistry,
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const SAMPLE_MODELS = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", contextWindow: 200_000, reasoning: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", provider: "anthropic", contextWindow: 200_000, reasoning: false },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", contextWindow: 128_000, reasoning: false },
];

describe("list_models tool", () => {
  it("is registered as an extension tool", () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    expect(tools.has("list_models")).toBe(true);
    const tool = tools.get("list_models");
    expect(tool.label).toBe("List Models");
    expect(tool.description).toMatch(/model registry/i);
  });

  it("lists every model from ctx.modelRegistry.getAvailable()", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = {
      find: vi.fn(),
      getAvailable: vi.fn(() => SAMPLE_MODELS),
      getAll: vi.fn(() => SAMPLE_MODELS),
    };
    const result = await tools.get("list_models").execute("tc-1", {}, undefined, undefined, ctxWithRegistry(registry));
    expect(result.content[0].type).toBe("text");
    const text = result.content[0].text as string;
    expect(text).toContain("anthropic/claude-sonnet-4-5");
    expect(text).toContain("anthropic/claude-haiku-4-5");
    expect(text).toContain("openai/gpt-4o");
    expect(text).toContain("3 models available");
    // Human-readable labels too
    expect(text).toContain("Claude Sonnet 4.5");
  });

  it("marks the active model with a leading marker", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = { find: vi.fn(), getAvailable: vi.fn(() => SAMPLE_MODELS) };
    const ctx = ctxWithRegistry(
      registry,
      { id: "claude-haiku-4-5", provider: "anthropic" },
    );
    const result = await tools.get("list_models").execute("tc-2", {}, undefined, undefined, ctx);
    const text = result.content[0].text as string;
    const lines = text.split("\n");
    const haikuLine = lines.find((l: string) => l.includes("claude-haiku-4-5"));
    expect(haikuLine.startsWith("* ")).toBe(true);
    const sonnetLine = lines.find((l: string) => l.includes("claude-sonnet-4-5"));
    expect(sonnetLine.startsWith("  ")).toBe(true);
    expect(text).toContain("* = active");
  });

  it("includes context window and reasoning annotations when present", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = { find: vi.fn(), getAvailable: vi.fn(() => SAMPLE_MODELS) };
    const result = await tools.get("list_models").execute("tc-3", {}, undefined, undefined, ctxWithRegistry(registry));
    const text = result.content[0].text as string;
    expect(text).toContain("ctx 200k");
    // Sonnet has reasoning:true, Haiku and GPT-4o do not
    const sonnetLine = text.split("\n").find((l: string) => l.includes("claude-sonnet-4-5"));
    expect(sonnetLine).toContain("reasoning");
    const haikuLine = text.split("\n").find((l: string) => l.includes("claude-haiku-4-5"));
    expect(haikuLine).not.toContain("reasoning");
  });

  it("filters by provider case-insensitively", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = { find: vi.fn(), getAvailable: vi.fn(() => SAMPLE_MODELS) };
    const result = await tools
      .get("list_models")
      .execute("tc-4", { provider: "OpenAI" }, undefined, undefined, ctxWithRegistry(registry));
    const text = result.content[0].text as string;
    expect(text).toContain("openai/gpt-4o");
    expect(text).not.toContain("anthropic");
    expect(text).toContain('for provider "OpenAI"');
  });

  it("explains a provider filter that matches nothing", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = { find: vi.fn(), getAvailable: vi.fn(() => SAMPLE_MODELS) };
    const result = await tools
      .get("list_models")
      .execute("tc-5", { provider: "google" }, undefined, undefined, ctxWithRegistry(registry));
    const text = result.content[0].text as string;
    expect(text).toContain('No models available for provider "google"');
    expect(text).toContain("anthropic");
    expect(text).toContain("openai");
  });

  it("returns an explanatory message when no models are available", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = { find: vi.fn(), getAvailable: vi.fn(() => []), getAll: vi.fn(() => []) };
    const result = await tools.get("list_models").execute("tc-6", {}, undefined, undefined, ctxWithRegistry(registry));
    const text = result.content[0].text as string;
    expect(text).toContain("No models are available");
  });

  it("falls back to getAll() when getAvailable() is undefined", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const registry = { find: vi.fn(), getAll: vi.fn(() => SAMPLE_MODELS) };
    const result = await tools.get("list_models").execute("tc-7", {}, undefined, undefined, ctxWithRegistry(registry));
    const text = result.content[0].text as string;
    expect(registry.getAll).toHaveBeenCalled();
    expect(text).toContain("3 models available");
  });

  it("returns an explanatory message when no modelRegistry is on ctx", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);
    const result = await tools.get("list_models").execute("tc-8", {}, undefined, undefined, ctxWithRegistry(undefined));
    const text = result.content[0].text as string;
    expect(text).toContain("No model registry is available");
  });
});
