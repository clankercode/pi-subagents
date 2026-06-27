/**
 * dashboard-ui.test.ts — Tests for dashboard UI module registration.
 * Verifies module descriptors, data handlers, and action handlers.
 */
import { describe, expect, it, vi } from "vitest";
import { registerDashboardModules } from "../src/dashboard-ui.js";

function makeManager(overrides?: { agents?: any[] }) {
  const agents = overrides?.agents ?? [];
  return {
    listAgents: vi.fn(() => agents),
    getRecord: vi.fn((id: string) => agents.find(a => a.id === id)),
    abort: vi.fn((id: string) => {
      const a = agents.find(a => a.id === id);
      if (a) a.status = "stopped";
      return !!a;
    }),
  } as any;
}

function makeEvents() {
  const handlers = new Map<string, Set<(data: any) => void>>();
  return {
    on: vi.fn((event: string, handler: any) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
    }),
    emit: vi.fn((event: string, data?: any) => {
      const set = handlers.get(event);
      if (set) {
        for (const h of set) h(data ?? {});
      }
    }),
    _handlers: handlers,
  };
}

function makePi(events?: ReturnType<typeof makeEvents>) {
  return { events: events ?? makeEvents() } as any;
}

const sampleAgent = {
  id: "agent-1",
  type: "general-purpose",
  description: "test task",
  status: "completed",
  toolUses: 5,
  startedAt: Date.now() - 10000,
  completedAt: Date.now(),
  lifetimeUsage: { input: 500, output: 300, cacheWrite: 0 },
  outputFile: "/tmp/output.log",
  result: "Hello from agent",
};

describe("registerDashboardModules", () => {
  it("registers ui:list-modules handler", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager());
    expect(events.on).toHaveBeenCalledWith("ui:list-modules", expect.any(Function));
  });

  it("registers data fetch handler for subagents:rows", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager());
    expect(events.on).toHaveBeenCalledWith("subagents:rows", expect.any(Function));
  });

  it("registers action handlers", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager());
    expect(events.on).toHaveBeenCalledWith("subagents:ui:refresh", expect.any(Function));
    expect(events.on).toHaveBeenCalledWith("subagents:ui:view-result", expect.any(Function));
    expect(events.on).toHaveBeenCalledWith("subagents:ui:abort", expect.any(Function));
    expect(events.on).toHaveBeenCalledWith("subagents:ui:steer", expect.any(Function));
  });

  it("registers lifecycle event listeners for invalidation", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager());
    expect(events.on).toHaveBeenCalledWith("subagents:created", expect.any(Function));
    expect(events.on).toHaveBeenCalledWith("subagents:completed", expect.any(Function));
    expect(events.on).toHaveBeenCalledWith("subagents:failed", expect.any(Function));
  });

  it("returns early when pi.events is undefined", () => {
    const pi = { events: undefined } as any;
    // Should not throw
    registerDashboardModules(pi, makeManager());
  });
});

describe("ui:list-modules probe", () => {
  it("pushes footer-segment and management-modal into probe.modules", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [sampleAgent] }));

    const probe = { modules: [] as any[] };
    events.emit("ui:list-modules", probe);

    expect(probe.modules).toHaveLength(2);

    const footer = probe.modules.find(m => m.kind === "footer-segment");
    expect(footer).toBeDefined();
    expect(footer.namespace).toBe("subagents");
    expect(footer.id).toBe("agent-counts");
    expect(footer.payload.text).toContain("✓ 1 done");

    const modal = probe.modules.find(m => m.kind === "management-modal");
    expect(modal).toBeDefined();
    expect(modal.id).toBe("subagents-overview");
    expect(modal.command).toBe("/subagents");
    expect(modal.title).toBe("Subagents");
    expect(modal.view.kind).toBe("table");
    expect(modal.view.dataEvent).toBe("subagents:rows");
    expect(modal.view.rowKey).toBe("id");
    expect(modal.view.fields.length).toBeGreaterThan(0);
    expect(modal.view.rowActions.length).toBeGreaterThan(0);
  });

  it("shows running count in footer when agents are running", () => {
    const events = makeEvents();
    const runningAgent = { ...sampleAgent, id: "r1", status: "running" };
    registerDashboardModules(makePi(events), makeManager({ agents: [runningAgent, sampleAgent] }));

    const probe = { modules: [] as any[] };
    events.emit("ui:list-modules", probe);

    const footer = probe.modules.find(m => m.kind === "footer-segment");
    expect(footer.payload.text).toContain("● 1 running");
    expect(footer.payload.text).toContain("✓ 1 done");
  });

  it("shows 'No agents' when agent list is empty", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [] }));

    const probe = { modules: [] as any[] };
    events.emit("ui:list-modules", probe);

    const footer = probe.modules.find(m => m.kind === "footer-segment");
    expect(footer.payload.text).toBe("No agents");
  });
});

describe("subagents:rows data handler", () => {
  it("returns agent rows with correct fields", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [sampleAgent] }));

    const data: any = {};
    events.emit("subagents:rows", data);

    expect(data.items).toHaveLength(1);
    expect(data.items[0]).toMatchObject({
      id: "agent-1",
      type: "Agent",
      description: "test task",
      status: "completed",
      toolUses: 5,
      outputFile: "/tmp/output.log",
    });
    expect(data.items[0].tokens).toBeDefined();
    expect(data.items[0].duration).toBeDefined();
  });

  it("returns empty array when no agents", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [] }));

    const data: any = {};
    events.emit("subagents:rows", data);

    expect(data.items).toEqual([]);
  });

  it("returns agents in the order provided by listAgents", () => {
    const events = makeEvents();
    const a1 = { ...sampleAgent, id: "a1", startedAt: 1000 };
    const a2 = { ...sampleAgent, id: "a2", startedAt: 5000 };
    registerDashboardModules(makePi(events), makeManager({ agents: [a1, a2] }));

    const data: any = {};
    events.emit("subagents:rows", data);

    // The mock returns the array as-is; real listAgents sorts by startedAt desc
    expect(data.items).toHaveLength(2);
    expect(data.items[0].id).toBe("a1");
    expect(data.items[1].id).toBe("a2");
  });
});

describe("subagents:ui:view-result handler", () => {
  it("returns agent result in items", () => {
    const events = makeEvents();
    const manager = makeManager({ agents: [sampleAgent] });
    registerDashboardModules(makePi(events), manager);

    // Bridge spreads msg.params into data; withRowParams nests row.
    const data: any = { row: { id: "agent-1" } };
    events.emit("subagents:ui:view-result", data);

    expect(data.items).toHaveLength(1);
    expect(data.items[0].result).toBe("Hello from agent");
    expect(data.items[0].id).toBe("agent-1");
  });

  it("handles missing agent gracefully", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [] }));

    const data: any = { row: { id: "nonexistent" } };
    // Should not throw
    events.emit("subagents:ui:view-result", data);
    expect(data.items).toBeUndefined();
  });

  it("truncates long results to 2000 chars", () => {
    const events = makeEvents();
    const longResult = { ...sampleAgent, result: "x".repeat(5000) };
    registerDashboardModules(makePi(events), makeManager({ agents: [longResult] }));

    const data: any = { row: { id: "agent-1" } };
    events.emit("subagents:ui:view-result", data);

    expect(data.items[0].result.length).toBeLessThan(5000);
    expect(data.items[0].result).toContain("…(truncated)");
  });
});

describe("subagents:ui:abort handler", () => {
  it("calls manager.abort for running agents", () => {
    const events = makeEvents();
    const runningAgent = { ...sampleAgent, id: "r1", status: "running" };
    const manager = makeManager({ agents: [runningAgent] });
    registerDashboardModules(makePi(events), manager);

    events.emit("subagents:ui:abort", { row: { id: "r1" } });
    expect(manager.abort).toHaveBeenCalledWith("r1");
  });

  it("handles missing agent gracefully", () => {
    const events = makeEvents();
    const manager = makeManager({ agents: [] });
    registerDashboardModules(makePi(events), manager);
    // Should not throw
    events.emit("subagents:ui:abort", { row: { id: "nonexistent" } });
  });
});
