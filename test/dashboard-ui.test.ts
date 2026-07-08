/**
 * dashboard-ui.test.ts — Tests for dashboard UI module registration.
 * Verifies module descriptors, data handlers, and action handlers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture openInViewer's spawn so view-result tests can assert the transcript
// is opened host-side without launching a real viewer process.
const { spawnMock } = vi.hoisted(() => ({
	spawnMock: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
}));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

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
  beforeEach(() => spawnMock.mockClear());

  it("opens the agent's outputFile host-side (no inline reply)", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [sampleAgent] }));

    const data: any = { row: { id: "agent-1" } };
    events.emit("subagents:ui:view-result", data);

    // The dashboard table only renders rows for its bound dataEvent, so a
    // row-action detail reply can't be displayed. The handler opens the
    // transcript externally and must NOT set data.items.
    expect(data.items).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnMock.mock.calls[0][1];
    expect(spawnArgs).toContain("/tmp/output.log");
  });

  it("handles a missing agent gracefully (no open, no throw)", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [] }));

    const data: any = { row: { id: "nonexistent" } };
    events.emit("subagents:ui:view-result", data);

    expect(data.items).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("falls back to a tmp result file when the agent has no outputFile", () => {
    const events = makeEvents();
    const noFile = { ...sampleAgent, outputFile: undefined };
    registerDashboardModules(makePi(events), makeManager({ agents: [noFile] }));

    const data: any = { row: { id: "agent-1" } };
    events.emit("subagents:ui:view-result", data);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnMock.mock.calls[0][1];
    expect(spawnArgs.some((a: string) => /result-agent-1\.txt$/.test(a))).toBe(true);
  });
});

describe("subagents:ui:steer-form handler (steer-with-input)", () => {
  it("probe pushes a /steer-subagent form module when agents are running", () => {
    const events = makeEvents();
    const running = { ...sampleAgent, id: "r1", status: "running" };
    registerDashboardModules(makePi(events), makeManager({ agents: [running] }));

    const probe = { modules: [] as any[] };
    events.emit("ui:list-modules", probe);

    const form = probe.modules.find((m: any) => m.kind === "management-modal" && m.id === "subagents-steer");
    expect(form).toBeDefined();
    expect(form.command).toBe("/steer-subagent");
    expect(form.view.kind).toBe("form");
    const agentField = form.view.fields.find((f: any) => f.key === "agentId");
    expect(agentField.kind).toBe("select");
    expect(agentField.options[0]).toContain("r1");
    const msgField = form.view.fields.find((f: any) => f.key === "message");
    expect(msgField.kind).toBe("textarea");
    expect(form.view.actions[0].event).toBe("subagents:ui:steer-form");
  });

  it("does NOT push the steer form when no agents are running/queued", () => {
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [sampleAgent] }));

    const probe = { modules: [] as any[] };
    events.emit("ui:list-modules", probe);

    expect(probe.modules.find((m: any) => m.id === "subagents-steer")).toBeUndefined();
  });

  it("steers the chosen running agent with the typed message (values nested under row)", () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const running = { ...sampleAgent, id: "r1", status: "running", session: { steer } };
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [running] }));

    events.emit("subagents:ui:steer-form", { row: { agentId: "r1 — test task", message: "ship it" } });

    expect(steer).toHaveBeenCalledWith("ship it");
  });

  it("steers with the typed message when values are spread into data", () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const running = { ...sampleAgent, id: "r1", status: "running", session: { steer } };
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [running] }));

    events.emit("subagents:ui:steer-form", { agentId: "r1", message: "go faster" });

    expect(steer).toHaveBeenCalledWith("go faster");
  });

  it("ignores a submit with no message", () => {
    const steer = vi.fn().mockResolvedValue(undefined);
    const running = { ...sampleAgent, id: "r1", status: "running", session: { steer } };
    const events = makeEvents();
    registerDashboardModules(makePi(events), makeManager({ agents: [running] }));

    events.emit("subagents:ui:steer-form", { row: { agentId: "r1", message: "" } });

    expect(steer).not.toHaveBeenCalled();
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
