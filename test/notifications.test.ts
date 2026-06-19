import { describe, expect, it, vi } from "vitest";
import { buildNotificationDetails, formatTaskNotification, registerSubagentNotificationRenderer } from "../src/notifications.js";
import type { AgentRecord } from "../src/types.js";

function completedRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-123",
    type: "general-purpose",
    description: "summarize logs",
    status: "completed",
    toolUses: 1,
    startedAt: 1_000,
    completedAt: 2_500,
    result: "FINAL OUTPUT TOKEN\nsecond line",
    outputFile: "/tmp/pi-subagents/agent-123.jsonl",
    lifetimeUsage: { input: 10, output: 20, cacheWrite: 0 },
    compactionCount: 0,
    ...overrides,
  } as AgentRecord;
}

describe("subagent completion notifications", () => {
  it("include final output plus explicit full-log retrieval guidance", () => {
    const record = completedRecord();

    const text = formatTaskNotification(record, 500);
    const details = buildNotificationDetails(record, 500);

    expect(text).toContain("FINAL OUTPUT TOKEN");
    expect(text).toContain("/tmp/pi-subagents/agent-123.jsonl");
    expect(text).toMatch(/get_subagent_result/i);
    expect(text).toMatch(/full (output|transcript|log)/i);
    expect(details.resultPreview).toContain("FINAL OUTPUT TOKEN");
    expect(details.outputFile).toBe("/tmp/pi-subagents/agent-123.jsonl");
  });

  it("renders visible full-output guidance in the custom notification UI", () => {
    const pi = { registerMessageRenderer: vi.fn() } as any;
    registerSubagentNotificationRenderer(pi);
    const renderer = pi.registerMessageRenderer.mock.calls[0][1];
    const details = buildNotificationDetails(completedRecord(), 500);
    const theme = {
      fg: (_name: string, value: string) => value,
      bold: (value: string) => value,
    };

    const rendered = renderer({ details }, { expanded: false }, theme).render(200).join("\n");

    expect(rendered).toContain("FINAL OUTPUT TOKEN");
    expect(rendered).toContain("/tmp/pi-subagents/agent-123.jsonl");
    expect(rendered).toMatch(/get_subagent_result/i);
  });
});
