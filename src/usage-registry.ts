/**
 * usage-registry.ts — Process-wide AgentRecord index for recursive usage rollup.
 *
 * Nested subagents live on different AgentManager instances (each child session
 * re-activates the extension). A single Map keyed by agent id lets usage deltas
 * walk the parentAgentId chain across those managers.
 */

import type { AgentRecord } from "./types.js";
import { addUsage, type LifetimeUsage } from "./usage.js";

const RECORDS_KEY = Symbol.for("pi-subagents:records");

function recordsMap(): Map<string, AgentRecord> {
  const g = globalThis as Record<symbol, Map<string, AgentRecord> | undefined>;
  let map = g[RECORDS_KEY];
  if (!map) {
    map = new Map();
    g[RECORDS_KEY] = map;
  }
  return map;
}

/** Register a live agent record (call on spawn). Overwrites any prior id. */
export function registerAgentRecord(record: AgentRecord): void {
  recordsMap().set(record.id, record);
}

/** Drop a record when it is removed from its manager. */
export function unregisterAgentRecord(id: string): void {
  recordsMap().delete(id);
}

/** Lookup by id across all managers in this process. */
export function getRegisteredAgentRecord(id: string): AgentRecord | undefined {
  return recordsMap().get(id);
}

/**
 * Add `usage` to every ancestor along `from.parentAgentId` (recursive).
 * No-op when `enabled` is false. Stops at a missing parent link.
 *
 * Accounting only — does not change provider billing. Mutates each ancestor's
 * `lifetimeUsage` in place.
 */
export function rollupUsageToAncestors(
  from: AgentRecord,
  usage: LifetimeUsage,
  enabled: boolean,
): void {
  if (!enabled) return;
  const seen = new Set<string>([from.id]);
  let pid = from.parentAgentId;
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const parent = recordsMap().get(pid);
    if (!parent) break;
    addUsage(parent.lifetimeUsage, usage);
    pid = parent.parentAgentId;
  }
}

/** Test helper: clear the process-wide map. */
export function clearAgentRecordRegistry(): void {
  recordsMap().clear();
}
