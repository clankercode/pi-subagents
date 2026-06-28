/**
 * event-forwarding.test.ts — Tests for the cross-session event forwarding bus.
 *
 * Validates that:
 * 1. The forwarding bus creates an isolated local bus for the child session.
 * 2. Lifecycle events (subagents:*) are forwarded to the parent bus.
 * 3. Non-lifecycle events are NOT forwarded to the parent bus.
 * 4. Parent bus events do NOT leak into the child bus.
 */

import { describe, expect, it, vi } from "vitest";
import { createForwardingEventBus } from "../src/agent-runner.js";
import type { EventBus } from "../src/cross-extension-rpc.js";

function mockEventBus(): EventBus & { events: Map<string, unknown[]> } {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const events = new Map<string, unknown[]>();
  return {
    events,
    on(event: string, handler: (data: unknown) => void) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return () => { handlers.get(event)?.delete(handler); };
    },
    emit(event: string, data: unknown) {
      if (!events.has(event)) events.set(event, []);
      events.get(event)!.push(data);
      for (const h of handlers.get(event) ?? []) h(data);
    },
  };
}

describe("createForwardingEventBus", () => {
  it("forwards subagents:created to parent bus", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    childBus.emit("subagents:created", { id: "child-1", type: "Explore" });

    expect(parentBus.events.get("subagents:created")).toEqual([
      { id: "child-1", type: "Explore" },
    ]);
  });

  it("forwards all lifecycle events to parent bus", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    const lifecycleEvents = [
      "subagents:created",
      "subagents:started",
      "subagents:completed",
      "subagents:failed",
      "subagents:compacted",
    ];

    for (const event of lifecycleEvents) {
      childBus.emit(event, { id: "test" });
    }

    for (const event of lifecycleEvents) {
      expect(parentBus.events.get(event)).toHaveLength(1);
      expect(parentBus.events.get(event)![0]).toEqual({ id: "test" });
    }
  });

  it("does NOT forward non-lifecycle events to parent bus", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    childBus.emit("subagents:rpc:ping", { requestId: "r1" });
    childBus.emit("custom:event", { data: "test" });
    childBus.emit("subagents:ready", {});

    expect(parentBus.events.get("subagents:rpc:ping")).toBeUndefined();
    expect(parentBus.events.get("custom:event")).toBeUndefined();
    expect(parentBus.events.get("subagents:ready")).toBeUndefined();
  });

  it("child bus on() does NOT see parent bus events", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    const handler = vi.fn();
    childBus.on("subagents:created", handler);

    // Parent emits — child should NOT see it
    parentBus.emit("subagents:created", { id: "sibling" });

    expect(handler).not.toHaveBeenCalled();
  });

  it("child bus on() sees its own emitted events", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    const handler = vi.fn();
    childBus.on("subagents:created", handler);

    childBus.emit("subagents:created", { id: "my-agent" });

    expect(handler).toHaveBeenCalledWith({ id: "my-agent" });
  });

  it("forwarded events trigger parent bus listeners", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    const parentHandler = vi.fn();
    parentBus.on("subagents:created", parentHandler);

    childBus.emit("subagents:created", { id: "depth-2-agent", depth: 2 });

    expect(parentHandler).toHaveBeenCalledWith({ id: "depth-2-agent", depth: 2 });
  });

  it("multiple forwarded events accumulate on parent bus", () => {
    const parentBus = mockEventBus();
    const childBus = createForwardingEventBus(parentBus);

    childBus.emit("subagents:created", { id: "a" });
    childBus.emit("subagents:started", { id: "a" });
    childBus.emit("subagents:completed", { id: "a" });

    expect(parentBus.events.get("subagents:created")).toHaveLength(1);
    expect(parentBus.events.get("subagents:started")).toHaveLength(1);
    expect(parentBus.events.get("subagents:completed")).toHaveLength(1);
  });
});
