import { describe, expect, it } from "vitest";
import {
  formatWaitTimeout,
  hasSteeringPending,
  STILL_RUNNING_GUIDANCE,
  type WaitOutcome,
  waitTimeoutMessage,
} from "../src/wait.js";

describe("formatWaitTimeout", () => {
  it("formats seconds, minutes, and mixed durations", () => {
    expect(formatWaitTimeout(45)).toBe("45s");
    expect(formatWaitTimeout(60)).toBe("1m");
    expect(formatWaitTimeout(270)).toBe("4m 30s");
  });
});

describe("waitTimeoutMessage", () => {
  const outcomes: WaitOutcome[] = ["timeout", "aborted", "pending_message", "completed"];

  it.each(outcomes)("includes wait:true and auto-notification guidance for outcome=%s", (outcome) => {
    const msg = waitTimeoutMessage(outcome, 270);
    expect(msg).toContain("still running");
    expect(msg).toMatch(/wait:\s*true/);
    expect(msg).toContain(STILL_RUNNING_GUIDANCE);
    expect(msg).toMatch(/automatically notified/i);
    expect(msg).toMatch(/Parents are automatically notified when their subagents complete/);
  });

  it("describes timeout duration", () => {
    expect(waitTimeoutMessage("timeout", 270)).toMatch(/timed out after 4m 30s/i);
  });

  it("describes user abort without stopping the subagent", () => {
    const msg = waitTimeoutMessage("aborted", 270);
    expect(msg).toMatch(/cancelled by the user/i);
    expect(msg).toContain("NOT stopped");
  });

  it("describes steering-message interruption", () => {
    const msg = waitTimeoutMessage("pending_message", 270);
    expect(msg).toMatch(/interrupted by an incoming steering message/i);
    expect(msg).toContain("queued steering message will be delivered");
  });
});

describe("hasSteeringPending", () => {
  it("prefers hasSteeringMessages when provided", () => {
    expect(hasSteeringPending({
      hasSteeringMessages: () => true,
      hasPendingMessages: () => false,
    })).toBe(true);
    expect(hasSteeringPending({
      hasSteeringMessages: () => false,
      hasPendingMessages: () => true,
    })).toBe(false);
  });

  it("uses getSteeringMessages length when provided", () => {
    expect(hasSteeringPending({ getSteeringMessages: () => ["steer me"] })).toBe(true);
    expect(hasSteeringPending({ getSteeringMessages: () => [] })).toBe(false);
  });

  it("does not treat bare hasPendingMessages as a steering interrupt", () => {
    // Follow-up-only queues make hasPendingMessages true; without a steering
    // view we must keep waiting.
    expect(hasSteeringPending({ hasPendingMessages: () => true })).toBe(false);
  });

  it("resolves parent session via pendingMessageCount probe and checks steering only", async () => {
    // Build a minimal AgentSession-like object isn't practical (heavy ctor).
    // Instead: simulate pi's hasPendingMessages binding against a real session
    // if we can construct one cheaply — otherwise verify the duck-typed paths
    // above and the probe install path via a fake that reads pendingMessageCount.
    const { AgentSession } = await import("@earendil-works/pi-coding-agent");

    // Minimal stand-in: a plain object with the same getter shape is not on
    // AgentSession.prototype. Use a real instance only if cheap; skip if not.
    // We verify the probe by temporarily assigning a fake session through a
    // closure that reads AgentSession.prototype.pendingMessageCount after
    // installing the probe on a disposable object that inherits the prototype.
    const fake = Object.create(AgentSession.prototype) as {
      _steeringMessages: string[];
      _followUpMessages: string[];
      getSteeringMessages: () => readonly string[];
      getFollowUpMessages: () => readonly string[];
    };
    fake._steeringMessages = [];
    fake._followUpMessages = ["follow-up only"];
    fake.getSteeringMessages = () => fake._steeringMessages;
    fake.getFollowUpMessages = () => fake._followUpMessages;

    // hasPendingMessages mirrors pi: reads pendingMessageCount on the session.
    const hasPendingMessages = () => (fake as { pendingMessageCount: number }).pendingMessageCount > 0;

    // Follow-up only → should not interrupt.
    expect(hasSteeringPending({ hasPendingMessages })).toBe(false);

    // Add a steering message → should interrupt.
    fake._steeringMessages.push("redirect");
    expect(hasSteeringPending({ hasPendingMessages })).toBe(true);
  });
});
