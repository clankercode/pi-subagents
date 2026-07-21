import { afterEach, describe, expect, it } from "vitest";
import type { AgentRecord } from "../src/types.js";
import {
  ancestorIdsOfLiveAgentsGlobal,
  clearAgentRecordRegistry,
  getRegisteredAgentRecord,
  isAncestorOfAnyLiveAgent,
  registerAgentRecord,
  rollupUsageToAncestors,
  unregisterAgentRecord,
} from "../src/usage-registry.js";

function rec(partial: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    type: "general-purpose",
    description: partial.id,
    status: "running",
    toolUses: 0,
    startedAt: 1,
    depth: 1,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...partial,
  } as AgentRecord;
}

afterEach(() => clearAgentRecordRegistry());

describe("usage-registry", () => {
  it("registers and unregisters records", () => {
    const a = rec({ id: "a" });
    registerAgentRecord(a);
    expect(getRegisteredAgentRecord("a")).toBe(a);
    unregisterAgentRecord("a");
    expect(getRegisteredAgentRecord("a")).toBeUndefined();
  });

  it("does not roll up when disabled", () => {
    const parent = rec({ id: "p" });
    const child = rec({ id: "c", parentAgentId: "p", depth: 2 });
    registerAgentRecord(parent);
    registerAgentRecord(child);
    rollupUsageToAncestors(child, { input: 10, output: 5, cacheWrite: 1 }, false);
    expect(parent.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
  });

  it("rolls usage into parent and grandparent recursively", () => {
    const gp = rec({ id: "gp", depth: 1 });
    const p = rec({ id: "p", parentAgentId: "gp", depth: 2 });
    const c = rec({ id: "c", parentAgentId: "p", depth: 3 });
    registerAgentRecord(gp);
    registerAgentRecord(p);
    registerAgentRecord(c);

    rollupUsageToAncestors(c, { input: 100, output: 20, cacheWrite: 3 }, true);

    expect(c.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 }); // child not self-added here
    expect(p.lifetimeUsage).toEqual({ input: 100, output: 20, cacheWrite: 3 });
    expect(gp.lifetimeUsage).toEqual({ input: 100, output: 20, cacheWrite: 3 });
  });

  it("stops cleanly when a parent link is missing", () => {
    const c = rec({ id: "c", parentAgentId: "missing", depth: 2 });
    registerAgentRecord(c);
    expect(() =>
      rollupUsageToAncestors(c, { input: 1, output: 0, cacheWrite: 0 }, true),
    ).not.toThrow();
  });

  it("refuses to unregister an ancestor of a live agent unless forced", () => {
    const p = rec({ id: "p", status: "completed" });
    const c = rec({ id: "c", parentAgentId: "p", depth: 2, status: "running" });
    registerAgentRecord(p);
    registerAgentRecord(c);
    expect(isAncestorOfAnyLiveAgent("p")).toBe(true);
    expect(ancestorIdsOfLiveAgentsGlobal().has("p")).toBe(true);
    expect(unregisterAgentRecord("p")).toBe(false);
    expect(getRegisteredAgentRecord("p")).toBe(p);
    // Further child usage still rolls up
    rollupUsageToAncestors(c, { input: 7, output: 0, cacheWrite: 0 }, true);
    expect(p.lifetimeUsage.input).toBe(7);
    expect(unregisterAgentRecord("p", true)).toBe(true);
    expect(getRegisteredAgentRecord("p")).toBeUndefined();
  });
});
