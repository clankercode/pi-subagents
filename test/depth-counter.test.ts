/**
 * depth-counter.test.ts — Tests for the recursive subagent depth counter.
 *
 * Validates that:
 * 1. The Agent tool description shows the NEXT spawn depth (not the agent's own depth).
 * 2. buildInvocationTags renders the correct depth from AgentInvocation.
 * 3. The widget suffix maxDepth includes descendant snapshot depths.
 * 4. The depth propagates correctly through the spawn chain.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentToolDescription } from "../src/agent-tool-description.js";
import subagentsExtension from "../src/index.js";
import { buildInvocationTags } from "../src/ui/agent-widget.js";
import { renderAgentTree, type WidgetAgentSnapshot } from "../src/ui/agent-widget-tree.js";

const EXTENSION_DEPTH_KEY = Symbol.for("pi-subagents:extension-depth");

function makePi() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
      registerCommand: vi.fn(),
      registerShortcut: vi.fn(),
      on: vi.fn((event: string, handler: any) => { handlers.set(event, handler); }),
      events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as any,
    tools,
    handlers,
  };
}

// ---- Agent tool description depth display ----

describe("Agent tool description depth display", () => {
  let tmpDir: string;
  let hermeticAgentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let shutdown: (() => Promise<void>) | undefined;

  function setup(depth: number) {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-depth-"));
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-depth-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    process.chdir(tmpDir);

    // Set the global depth key before loading the extension
    const g = globalThis as any;
    if (depth > 0) {
      g[EXTENSION_DEPTH_KEY] = { depth, agentId: `agent-at-depth-${depth}` };
    } else {
      delete g[EXTENSION_DEPTH_KEY];
    }

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };
    return tools;
  }

  afterEach(async () => {
    await shutdown?.();
    shutdown = undefined;
    const g = globalThis as any;
    delete g[EXTENSION_DEPTH_KEY];
    if (prevCwd) process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    if (hermeticAgentDir) rmSync(hermeticAgentDir, { recursive: true, force: true });
  });

  it("main session (depth 0) shows next spawn depth 1/4 in the tool description", () => {
    const tools = setup(0);
    const desc: string = tools.get("Agent").description;
    // The description should show the depth at which the NEXT agent will spawn,
    // not the agent's own depth. Main session is depth 0, next spawn is depth 1.
    expect(desc).toContain("Current recursive depth: 1/4");
    expect(desc).not.toContain("Current recursive depth: 0/4");
  });

  it("depth-1 subagent shows next spawn depth 2/4 in the tool description", () => {
    const tools = setup(1);
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Current recursive depth: 2/4");
    expect(desc).not.toContain("Current recursive depth: 1/4");
  });

  it("depth-3 subagent shows next spawn depth 4/4 in the tool description", () => {
    const tools = setup(3);
    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("Current recursive depth: 4/4");
  });

  it("compact description also shows next spawn depth", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-depth-"));
    hermeticAgentDir = mkdtempSync(join(tmpdir(), "pi-depth-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticAgentDir;
    process.env.HOME = hermeticAgentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ toolDescriptionMode: "compact" }));
    process.chdir(tmpDir);

    const g = globalThis as any;
    g[EXTENSION_DEPTH_KEY] = { depth: 1, agentId: "compact-agent" };

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    shutdown = async () => {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} } as any);
    };

    const desc: string = tools.get("Agent").description;
    expect(desc).toContain("current depth 2/4");
    expect(desc).not.toContain("current depth 1/4");
  });
});

// ---- buildInvocationTags depth rendering ----

describe("buildInvocationTags depth rendering", () => {
  it("renders depth tag from invocation.depth and invocation.maxDepth", () => {
    const { tags } = buildInvocationTags({
      depth: 2,
      maxDepth: 4,
    });
    expect(tags).toContain("depth: 2/4");
  });

  it("defaults maxDepth to 4 when not specified", () => {
    const { tags } = buildInvocationTags({
      depth: 1,
    });
    expect(tags).toContain("depth: 1/4");
  });

  it("omits depth tag when invocation is undefined", () => {
    const { tags } = buildInvocationTags(undefined);
    expect(tags.every(t => !t.startsWith("depth:"))).toBe(true);
  });

  it("omits depth tag when depth is undefined", () => {
    const { tags } = buildInvocationTags({ maxDepth: 4 });
    expect(tags.every(t => !t.startsWith("depth:"))).toBe(true);
  });

  it("renders correct depth for each level in the spawn chain", () => {
    // Main session spawns at depth 1
    const mainSpawn = buildInvocationTags({ depth: 1, maxDepth: 4 });
    expect(mainSpawn.tags).toContain("depth: 1/4");

    // Depth-1 agent spawns at depth 2
    const depth1Spawn = buildInvocationTags({ depth: 2, maxDepth: 4 });
    expect(depth1Spawn.tags).toContain("depth: 2/4");

    // Depth-2 agent spawns at depth 3
    const depth2Spawn = buildInvocationTags({ depth: 3, maxDepth: 4 });
    expect(depth2Spawn.tags).toContain("depth: 3/4");

    // Depth-3 agent spawns at depth 4 (max)
    const depth3Spawn = buildInvocationTags({ depth: 4, maxDepth: 4 });
    expect(depth3Spawn.tags).toContain("depth: 4/4");
  });
});

// ---- Widget suffix maxDepth from descendant snapshots ----

describe("widget suffix maxDepth from descendant snapshots", () => {
  const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function snap(partial: Partial<WidgetAgentSnapshot> & { id: string }): WidgetAgentSnapshot {
    return {
      type: "general-purpose" as any,
      description: partial.id,
      status: "running",
      startedAt: 1,
      toolUses: 0,
      ...partial,
    };
  }

  it("suffix shows depth 1/4 when only a depth-1 agent is visible", () => {
    const lines = renderAgentTree(
      [snap({ id: "agent-a", depth: 1, description: "task A" })],
      { mode: "rich", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 },
    );
    const text = lines.join("\n");
    expect(text).toContain("depth 1/4");
  });

  it("suffix shows depth 2/4 when a depth-2 descendant snapshot is present", () => {
    const lines = renderAgentTree(
      [
        snap({ id: "agent-a", depth: 1, description: "task A" }),
        snap({ id: "agent-b", depth: 2, parentAgentId: "agent-a", description: "task B" }),
      ],
      { mode: "rich", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 },
    );
    const text = lines.join("\n");
    expect(text).toContain("depth 2/4");
  });

  it("suffix shows depth 3/4 when a depth-3 grandchild snapshot is present", () => {
    const lines = renderAgentTree(
      [
        snap({ id: "agent-a", depth: 1, description: "task A" }),
        snap({ id: "agent-b", depth: 2, parentAgentId: "agent-a", description: "task B" }),
        snap({ id: "agent-c", depth: 3, parentAgentId: "agent-b", description: "task C" }),
      ],
      { mode: "rich", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 },
    );
    const text = lines.join("\n");
    expect(text).toContain("depth 3/4");
  });

  it("suffix updates from 1/4 to 2/4 when a descendant snapshot arrives", () => {
    // Start with only the depth-1 parent
    const records: WidgetAgentSnapshot[] = [
      snap({ id: "agent-a", depth: 1, description: "task A" }),
    ];
    const lines1 = renderAgentTree(records, { mode: "rich", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 });
    expect(lines1.join("\n")).toContain("depth 1/4");

    // Add the depth-2 child (simulating the subagents:created event arriving)
    records.push(snap({ id: "agent-b", depth: 2, parentAgentId: "agent-a", description: "task B" }));
    const lines2 = renderAgentTree(records, { mode: "rich", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 });
    expect(lines2.join("\n")).toContain("depth 2/4");
  });
});

// ---- buildAgentToolDescription uses nextSubagentDepth ----

describe("buildAgentToolDescription depth parameter", () => {
  it("full description shows the depth parameter as current recursive depth", () => {
    const desc = buildAgentToolDescription({
      mode: "full",
      nextSubagentDepth: 2,
      schedulingEnabled: false,
    });
    expect(desc).toContain("Current recursive depth: 2/4");
    expect(desc).not.toContain("Current recursive depth: 1/4");
  });

  it("compact description shows the depth parameter", () => {
    const desc = buildAgentToolDescription({
      mode: "compact",
      nextSubagentDepth: 3,
      schedulingEnabled: false,
    });
    expect(desc).toContain("current depth 3/4");
  });
});
