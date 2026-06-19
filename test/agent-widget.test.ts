import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createActivityTracker } from "../src/index.js";
import { AgentWidget, describeActivityWithAge, formatMs, formatSessionTokens, formatSubagentStatusText } from "../src/ui/agent-widget.js";
import { buildAgentTree, renderAgentTree, type WidgetAgentSnapshot } from "../src/ui/agent-widget-tree.js";

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

describe("agent widget tree model", () => {
  it("links parent child and grandchild records by parentAgentId", () => {
    const tree = buildAgentTree([
      snap({ id: "parent", depth: 1 }),
      snap({ id: "child", parentAgentId: "parent", depth: 2 }),
      snap({ id: "grandchild", parentAgentId: "child", depth: 3 }),
    ]);

    expect(tree.map(n => n.snapshot.id)).toEqual(["parent"]);
    expect(tree[0].children.map(n => n.snapshot.id)).toEqual(["child"]);
    expect(tree[0].children[0].children.map(n => n.snapshot.id)).toEqual(["grandchild"]);
  });

  it("keeps orphaned descendants visible as roots", () => {
    const tree = buildAgentTree([
      snap({ id: "orphan", parentAgentId: "missing-parent", depth: 3 }),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].snapshot.id).toBe("orphan");
    expect(tree[0].orphaned).toBe(true);
  });
});

describe("agent widget tree rendering", () => {
  it("renders a grandchild with recursive connectors", () => {
    const lines = renderAgentTree([
      snap({ id: "parent", description: "parent task", depth: 1 }),
      snap({ id: "child", description: "child task", parentAgentId: "parent", depth: 2 }),
      snap({ id: "grandchild", description: "grandchild task", parentAgentId: "child", depth: 3 }),
      snap({ id: "sibling", description: "sibling task", parentAgentId: "parent", depth: 2, status: "queued" }),
    ], { mode: "compact", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 });

    const text = lines.join("\n");
    expect(text).toContain("parent task");
    expect(text).toContain("│  └─");
    expect(text).toContain("grandchild task");
  });

  it("auto mode falls back to compact when rich output exceeds the line budget", () => {
    const lines = renderAgentTree([
      snap({ id: "parent", description: "parent task" }),
      snap({ id: "child", description: "child task", parentAgentId: "parent" }),
      snap({ id: "grandchild", description: "grandchild task", parentAgentId: "child" }),
    ], { mode: "auto", width: 120, maxLines: 4, theme: plainTheme, frame: "⠋", now: 10_000 });

    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.some(l => l.includes("⎿"))).toBe(false);
  });

  it("collapses overflow by reporting hidden descendants", () => {
    const records = Array.from({ length: 8 }, (_, i) => snap({
      id: `agent-${i}`,
      description: `agent ${i}`,
      parentAgentId: i === 0 ? undefined : `agent-${i - 1}`,
    }));

    const lines = renderAgentTree(records, { mode: "compact", width: 120, maxLines: 5, theme: plainTheme, frame: "⠋", now: 10_000 });
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(lines.join("\n")).toMatch(/hidden|more/);
  });
});

describe("AgentWidget recursive rendering", () => {
  it("ages completed descendant snapshots out after their linger window", () => {
    const manager = { listAgents: () => [] } as any;
    const ui = { setStatus: vi.fn(), setWidget: vi.fn() } as any;
    const widget = new AgentWidget(manager, new Map());
    widget.setUICtx(ui);
    widget.upsertSnapshot(snap({
      id: "done-grandchild",
      parentAgentId: "missing-parent",
      description: "done grandchild",
      status: "completed",
      completedAt: 2,
    }));

    widget.update();
    const factory = ui.setWidget.mock.calls.at(-1)[1];
    const component = factory({ terminal: { columns: 120 }, requestRender: vi.fn() }, plainTheme);
    expect(component.render().join("\n")).toContain("done grandchild");

    widget.onTurnStart();
    expect(ui.setWidget).toHaveBeenLastCalledWith("agents", undefined);
  });

  it("renders descendant snapshots that are not in the local manager", () => {
    const manager = { listAgents: () => [snap({ id: "parent", description: "parent", status: "running" })] } as any;
    const ui = { setStatus: vi.fn(), setWidget: vi.fn() } as any;
    const widget = new AgentWidget(manager, new Map());
    widget.setUICtx(ui);
    widget.upsertSnapshot(snap({ id: "child", parentAgentId: "parent", description: "child", status: "running" }));
    widget.upsertSnapshot(snap({ id: "grandchild", parentAgentId: "child", description: "grandchild", status: "running" }));

    widget.update();
    const factory = ui.setWidget.mock.calls.at(-1)[1];
    const component = factory({ terminal: { columns: 120 }, requestRender: vi.fn() }, plainTheme);
    const text = component.render().join("\n");

    expect(text).toContain("parent");
    expect(text).toContain("child");
    expect(text).toContain("grandchild");
  });
});

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compact, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });
});

describe("formatMs (humanized duration)", () => {
  it("keeps one decimal under a minute", () => {
    expect(formatMs(0)).toBe("0.0s");
    expect(formatMs(12_300)).toBe("12.3s");
    expect(formatMs(59_999)).toBe("60.0s");
  });

  it("uses m+s from one minute up to one hour", () => {
    expect(formatMs(60_000)).toBe("1m");
    expect(formatMs(72_000)).toBe("1m 12s");
    expect(formatMs(723_100)).toBe("12m 3s");
    expect(formatMs(3_599_999)).toBe("59m 59s");
  });

  it("uses h+m at one hour and above", () => {
    expect(formatMs(3_600_000)).toBe("1h");
    expect(formatMs(3_900_000)).toBe("1h 5m");
    expect(formatMs(7_470_000)).toBe("2h 4m");
  });
});

describe("subagent status text", () => {
  it("keeps the full status text when it fits", () => {
    expect(formatSubagentStatusText(3, 2, 80)).toBe("3 running, 2 queued agents");
  });

  it("truncates the status text to the available width", () => {
    const text = formatSubagentStatusText(123, 456);
    expect(text).toBeTruthy();
    expect(visibleWidth(text!)).toBeLessThanOrEqual(20);
    expect(text).toContain("…");
  });

  it("feeds the truncated line into the status bar update", () => {
    const manager = {
      listAgents: () => [
        { id: "a1", status: "running" },
        { id: "a2", status: "queued" },
        { id: "a3", status: "running" },
        { id: "a4", status: "queued" },
        { id: "a5", status: "running" },
        { id: "a6", status: "queued" },
      ],
    } as any;
    const ui = { setStatus: vi.fn(), setWidget: vi.fn() } as any;
    const widget = new AgentWidget(manager, new Map());
    widget.setUICtx(ui);

    widget.update();

    expect(ui.setStatus).toHaveBeenCalledWith("subagents", formatSubagentStatusText(3, 3));
  });
});

describe("describeActivityWithAge", () => {
  it("shows how long the current activity description has been current", () => {
    const active = new Map([["read-1", "read"]]);
    expect(describeActivityWithAge(active, "", 1_000, 3_400)).toBe("reading… · 2.4s");
  });

  it("omits the age until an activity timestamp exists", () => {
    expect(describeActivityWithAge(new Map(), "drafting answer")).toBe("drafting answer");
  });
});

describe("createActivityTracker", () => {
  it("initializes initial thinking with an activity age timestamp", () => {
    const { state } = createActivityTracker();

    expect(state.activityDescription).toBe("thinking…");
    expect(typeof state.activityDescriptionUpdatedAt).toBe("number");
    expect(describeActivityWithAge(
      state.activeTools,
      state.responseText,
      state.activityDescriptionUpdatedAt,
      state.activityDescriptionUpdatedAt! + 2_400,
    )).toBe("thinking… · 2.4s");
  });
});
