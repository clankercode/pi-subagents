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

/**
 * Drop a record when it is removed from its manager.
 * No-op if any process-wide live (running/queued) agent still has this id on
 * its parentAgentId chain — keeps nested rollup working after a parent finishes.
 * Returns true if the id was removed, false if retained for live descendants.
 */
export function unregisterAgentRecord(id: string, force = false): boolean {
  if (!force && isAncestorOfAnyLiveAgent(id)) return false;
  return recordsMap().delete(id);
}

/** Lookup by id across all managers in this process. */
export function getRegisteredAgentRecord(id: string): AgentRecord | undefined {
  return recordsMap().get(id);
}

/**
 * True if any registered running/queued agent has `ancestorId` in its
 * parentAgentId chain (walks the process-wide registry).
 */
export function isAncestorOfAnyLiveAgent(ancestorId: string): boolean {
  for (const r of recordsMap().values()) {
    if (r.status !== "running" && r.status !== "queued") continue;
    const seen = new Set<string>();
    let pid = r.parentAgentId;
    while (pid && !seen.has(pid)) {
      if (pid === ancestorId) return true;
      seen.add(pid);
      pid = recordsMap().get(pid)?.parentAgentId;
    }
  }
  return false;
}

/** All ids currently anchoring a live descendant in the process-wide registry. */
export function ancestorIdsOfLiveAgentsGlobal(): Set<string> {
  const protect = new Set<string>();
  for (const r of recordsMap().values()) {
    if (r.status !== "running" && r.status !== "queued") continue;
    const seen = new Set<string>();
    let pid = r.parentAgentId;
    while (pid && !seen.has(pid)) {
      protect.add(pid);
      seen.add(pid);
      pid = recordsMap().get(pid)?.parentAgentId;
    }
  }
  return protect;
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

/** Test helper: registered ids (for leak assertions). */
export function listRegisteredAgentIds(): string[] {
  return [...recordsMap().keys()];
}
