import type { AgentInvocation, SubagentType } from "../types.js";
import type { AgentActivity } from "./agent-widget.js";

export type WidgetDisplayMode = "auto" | "rich" | "compact";

export interface WidgetAgentSnapshot {
  id: string;
  parentAgentId?: string;
  depth?: number;
  type: SubagentType;
  description: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  error?: string;
  toolUses: number;
  invocation?: AgentInvocation;
  activity?: AgentActivity;
}

export interface WidgetTreeNode {
  snapshot: WidgetAgentSnapshot;
  children: WidgetTreeNode[];
  orphaned?: boolean;
}

function statusRank(status: string): number {
  if (status === "running") return 0;
  if (status === "queued") return 1;
  return 2;
}

function sortNodes(a: WidgetTreeNode, b: WidgetTreeNode): number {
  const status = statusRank(a.snapshot.status) - statusRank(b.snapshot.status);
  if (status !== 0) return status;
  return a.snapshot.startedAt - b.snapshot.startedAt;
}

export function buildAgentTree(records: WidgetAgentSnapshot[]): WidgetTreeNode[] {
  const nodes = new Map<string, WidgetTreeNode>();
  for (const record of records) nodes.set(record.id, { snapshot: record, children: [] });

  const roots: WidgetTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.snapshot.parentAgentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      if (parentId) node.orphaned = true;
      roots.push(node);
    }
  }

  function sortDeep(items: WidgetTreeNode[]) {
    items.sort(sortNodes);
    for (const item of items) sortDeep(item.children);
  }

  sortDeep(roots);
  return roots;
}
