import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import {
  buildClearSubagentsDetails,
  buildListSubagentsDetails,
  clearSubagentRecords,
  renderClearSubagentsDetails,
  renderListSubagentsDetails,
} from "../src/subagent-list-clear.js";
import type { AgentRecord } from "../src/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => text,
};

function record(partial: Partial<AgentRecord> & Pick<AgentRecord, "id" | "status">): AgentRecord {
  return {
    type: "general-purpose",
    description: partial.id,
    toolUses: 0,
    startedAt: 1_000,
    depth: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...partial,
  } as AgentRecord;
}

function renderLines(component: { render: (width: number) => string[] }, width = 120): string[] {
  return component.render(width).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

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

describe("list_subagents selection", () => {
  it("shows active and non-success terminal agents plus the two most recent successes by default", () => {
    const details = buildListSubagentsDetails([
      record({ id: "run", status: "running", startedAt: 10_000, description: "running work" }),
      record({ id: "queued", status: "queued", startedAt: 9_000, description: "queued work" }),
      record({ id: "err", status: "error", startedAt: 8_000, completedAt: 8_500, description: "errored work" }),
      record({ id: "stop", status: "stopped", startedAt: 7_000, completedAt: 7_500, description: "stopped work" }),
      record({ id: "done-new", status: "completed", startedAt: 6_000, completedAt: 6_500, description: "new success" }),
      record({ id: "steered", status: "steered", startedAt: 5_000, completedAt: 5_500, description: "steered success" }),
      record({ id: "done-old", status: "completed", startedAt: 4_000, completedAt: 4_500, description: "old success" }),
    ], { all: false, now: 12_000 });

    expect(details.visible.map((a) => a.id)).toEqual(["run", "queued", "err", "stop", "done-new", "steered"]);
    expect(details.hiddenDoneCount).toBe(1);
    expect(details.total).toBe(7);
  });

  it("shows every retained agent when all is requested", () => {
    const details = buildListSubagentsDetails([
      record({ id: "done-new", status: "completed", startedAt: 6_000, completedAt: 6_500 }),
      record({ id: "done-old", status: "completed", startedAt: 4_000, completedAt: 4_500 }),
    ], { all: true, now: 12_000 });

    expect(details.visible.map((a) => a.id)).toEqual(["done-new", "done-old"]);
    expect(details.hiddenDoneCount).toBe(0);
  });

  it("returns clone-safe renderer details without live AgentRecord internals", () => {
    const details = buildListSubagentsDetails([
      record({
        id: "run-with-internals",
        status: "running",
        description: "running work",
        promise: Promise.resolve("done"),
        abortController: new AbortController(),
        outputCleanup: () => {},
        session: { dispose: vi.fn() } as any,
      }),
    ], { now: 12_000 });

    expect(() => structuredClone(details)).not.toThrow();
    expect(details.visible[0]).toEqual({
      id: "run-with-internals",
      type: "general-purpose",
      status: "running",
      description: "running work",
      startedAt: 1_000,
    });
  });

  it("snapshots agent row status when details are built", () => {
    const source = record({ id: "run", status: "running", startedAt: 10_000, description: "running work" });
    const details = buildListSubagentsDetails([source], { now: 12_000 });

    source.status = "completed";
    source.completedAt = 12_000;

    expect(details.activeCount).toBe(1);
    expect(details.visible[0]?.status).toBe("running");
    const lines = renderLines(renderListSubagentsDetails(details, theme));
    expect(lines[0]).toContain("1 active");
    expect(lines[1]).toContain("running");
    expect(lines[1]).not.toContain("done");
  });
});

describe("clear_subagents selection", () => {
  it("clears successful agents older than five minutes by default", () => {
    const now = 10 * 60_000;
    const records = [
      record({ id: "old-done", status: "completed", completedAt: now - 6 * 60_000 }),
      record({ id: "old-steered", status: "steered", completedAt: now - 7 * 60_000 }),
      record({ id: "new-done", status: "completed", completedAt: now - 2 * 60_000 }),
      record({ id: "old-error", status: "error", completedAt: now - 8 * 60_000 }),
      record({ id: "run", status: "running", startedAt: now - 9 * 60_000 }),
    ];

    const result = clearSubagentRecords(records, { now });

    expect(result.clearIds).toEqual(["old-done", "old-steered"]);
    expect(result.keptActiveCount).toBe(1);
    expect(result.keptFailedCount).toBe(1);
    expect(result.keptYoungSuccessCount).toBe(1);
  });

  it("clears explicit terminal IDs but reports running IDs as errors", () => {
    const result = clearSubagentRecords([
      record({ id: "done-123456", status: "completed", completedAt: 100 }),
      record({ id: "run-123456", status: "running", startedAt: 100 }),
    ], { agentIds: ["done", "run"], now: 1_000 });

    expect(result.clearIds).toEqual(["done-123456"]);
    expect(result.errors).toEqual(["run matched running agent run-123456"]);
  });
});

describe("subagent compact renderers", () => {
  it("renders list_subagents as a compact List Agents block with hidden done count", () => {
    const details = buildListSubagentsDetails([
      record({ id: "46ea2e0f-aaaa", type: "Explore", status: "running", startedAt: 10_000, description: "Review parser edge cases" }),
      record({ id: "62873453-bbbb", type: "Explore", status: "error", startedAt: 8_000, completedAt: 8_500, description: "Test failure investigation" }),
      record({ id: "f0a1b2c3-cccc", status: "completed", startedAt: 6_000, completedAt: 6_500, description: "Summarize docs" }),
      record({ id: "recent-2", status: "completed", startedAt: 4_000, completedAt: 4_500, description: "Second recent done" }),
      record({ id: "old", status: "completed", startedAt: 1_000, completedAt: 1_500, description: "Hidden done" }),
    ], { all: false, now: 12_000 });

    const lines = renderLines(renderListSubagentsDetails(details, theme));

    expect(lines[0]).toContain("List Agents");
    expect(lines[0]).toContain("4 visible");
    expect(lines[0]).toContain("1 hidden done");
    expect(lines.join("\n")).toContain("46ea2e0f");
    expect(lines.join("\n")).toContain("Explore");
    expect(lines.join("\n")).toContain("Review parser edge cases");
  });

  it("renders clear_subagents as a compact Clear Agents summary", () => {
    const details = buildClearSubagentsDetails({
      clearIds: ["done-1", "done-2"],
      errors: [],
      requestedCount: 0,
      keptActiveCount: 2,
      keptFailedCount: 1,
      keptYoungSuccessCount: 1,
    });

    const lines = renderLines(renderClearSubagentsDetails(details, theme));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Clear Agents");
    expect(lines[0]).toContain("cleared 2 records");
    expect(lines[0]).toContain("1 failed kept");
    expect(lines[0]).toContain("2 active kept");
  });

  it("registers list_subagents and clear_subagents with self-mode compact renderers", async () => {
    const { pi, tools } = makePi();
    subagentsExtension(pi);

    const listTool = tools.get("list_subagents");
    const clearTool = tools.get("clear_subagents");

    expect(listTool.renderShell).toBe("self");
    expect(clearTool.renderShell).toBe("self");

    const listResult = await listTool.execute("tc-list", {}, undefined, undefined, undefined);
    const clearResult = await clearTool.execute("tc-clear", {}, undefined, undefined, undefined);

    expect(renderLines(listTool.renderResult(listResult, {}, theme))[0]).toContain("List Agents");
    expect(renderLines(clearTool.renderResult(clearResult, {}, theme))[0]).toContain("Clear Agents");
  });
});
