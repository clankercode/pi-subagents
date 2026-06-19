# Recursive Subagent Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the full recursive subagent tree in the TUI widget, including grandchildren and deeper descendants, with rich default display, automatic compact fallback, configurable compact/rich modes, and a focused path view foundation.

**Architecture:** Introduce a small tree-model/render module that converts flat agent snapshots into recursive render rows. `AgentWidget` will merge local manager records with descendant lifecycle/activity snapshots, then render the tree through rich, compact, or auto modes. Recursive manager instances will publish enough lifecycle/activity event data for the root widget to keep a durable aggregate without directly owning child managers.

**Tech Stack:** TypeScript, Vitest, existing `@earendil-works/pi-tui` truncation utilities, existing `SubagentsSettings` persistence and `/agents → Settings` UI.

## Global Constraints

- Use TDD: add failing tests before implementation changes for each behavior slice.
- Keep widget output width-safe with `truncateToWidth`.
- Keep widget height bounded using the existing `MAX_WIDGET_LINES` budget style.
- Default display behavior is `auto`: rich tree by default, compact fallback when rich output exceeds budget or terminal width is constrained.
- User-configurable display modes: `auto`, `rich`, `compact`.
- Preserve existing status-bar truncation behavior.
- Avoid unrelated refactors; keep new tree logic in a focused module.
- Use at most 2 test/build threads when commands support parallelism.

---

## File Structure

- Create: `src/ui/agent-widget-tree.ts`
  - Pure tree/snapshot types.
  - Merge/sort/build helpers.
  - Rich/compact/focused row rendering helpers.
  - Overflow/collapse helpers.
- Modify: `src/ui/agent-widget.ts`
  - Delegate tree building/rendering to `agent-widget-tree.ts`.
  - Track descendant snapshots supplied by lifecycle/activity events.
  - Keep status bar aggregation over full visible tree.
- Modify: `src/index.ts`
  - Emit richer lifecycle/activity snapshots.
  - Wire `subagents:*` event listeners into `AgentWidget` snapshot updates.
  - Add in-memory widget display mode state and `/agents → Settings` entry.
- Modify: `src/settings.ts`
  - Persist and sanitize `widgetDisplayMode?: "auto" | "rich" | "compact"`.
  - Apply setting through `SettingsAppliers`.
- Modify: `test/agent-widget.test.ts`
  - Add tree rendering, compact/rich/auto fallback, overflow, orphan, and status-bar descendant tests.
- Modify: `test/settings.test.ts`
  - Add settings sanitize/apply/save/load coverage for `widgetDisplayMode`.
- Optional modify: `test/subagents-print-mode-e2e.test.ts`
  - Add a scripted recursive smoke if event propagation needs an integration guard.

---

### Task 1: Add pure tree model tests and helpers

**Files:**
- Create: `src/ui/agent-widget-tree.ts`
- Modify: `test/agent-widget.test.ts`

**Interfaces:**
- Produces:
  - `export type WidgetDisplayMode = "auto" | "rich" | "compact";`
  - `export interface WidgetAgentSnapshot { id: string; parentAgentId?: string; depth?: number; type: SubagentType; description: string; status: string; startedAt: number; completedAt?: number; error?: string; toolUses: number; invocation?: AgentInvocation; activity?: AgentActivity; }`
  - `export interface WidgetTreeNode { snapshot: WidgetAgentSnapshot; children: WidgetTreeNode[]; orphaned?: boolean; }`
  - `export function buildAgentTree(records: WidgetAgentSnapshot[]): WidgetTreeNode[]`

- [ ] **Step 1: Write failing tree tests**

Add to `test/agent-widget.test.ts`:

```ts
import { buildAgentTree, type WidgetAgentSnapshot } from "../src/ui/agent-widget-tree.js";

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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --run test/agent-widget.test.ts`

Expected: FAIL because `src/ui/agent-widget-tree.ts` does not exist.

- [ ] **Step 3: Implement minimal tree helpers**

Create `src/ui/agent-widget-tree.ts`:

```ts
import type { AgentActivity } from "./agent-widget.js";
import type { AgentInvocation, SubagentType } from "../types.js";

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
    if (parent) parent.children.push(node);
    else {
      if (parentId) node.orphaned = true;
      roots.push(node);
    }
  }

  const sortDeep = (items: WidgetTreeNode[]) => {
    items.sort(sortNodes);
    for (const item of items) sortDeep(item.children);
  };
  sortDeep(roots);
  return roots;
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --run test/agent-widget.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/agent-widget-tree.ts test/agent-widget.test.ts
git commit -m "test: add recursive subagent tree model"
```

---

### Task 2: Render recursive compact/rich rows in pure helpers

**Files:**
- Modify: `src/ui/agent-widget-tree.ts`
- Modify: `test/agent-widget.test.ts`

**Interfaces:**
- Consumes: `WidgetTreeNode`, `WidgetAgentSnapshot`, `WidgetDisplayMode` from Task 1.
- Produces:
  - `export interface RenderTreeOptions { mode: WidgetDisplayMode; width: number; maxLines: number; theme: Theme; frame: string; now?: number; }`
  - `export function renderAgentTree(records: WidgetAgentSnapshot[], options: RenderTreeOptions): string[]`
  - `export function chooseEffectiveMode(mode: WidgetDisplayMode, width: number, richLineCount: number, maxLines: number): "rich" | "compact"`

- [ ] **Step 1: Write failing render tests**

Add tests that call pure `renderAgentTree()`:

```ts
import { renderAgentTree } from "../src/ui/agent-widget-tree.js";

const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("agent widget tree rendering", () => {
  it("renders a grandchild with recursive connectors", () => {
    const lines = renderAgentTree([
      snap({ id: "parent", description: "parent task", depth: 1 }),
      snap({ id: "child", description: "child task", parentAgentId: "parent", depth: 2 }),
      snap({ id: "grandchild", description: "grandchild task", parentAgentId: "child", depth: 3 }),
    ], { mode: "compact", width: 120, maxLines: 12, theme: plainTheme, frame: "⠋", now: 10_000 });

    expect(lines.join("\n")).toContain("parent task");
    expect(lines.join("\n")).toContain("│  └─");
    expect(lines.join("\n")).toContain("grandchild task");
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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --run test/agent-widget.test.ts`

Expected: FAIL because render helpers do not exist.

- [ ] **Step 3: Implement render helpers**

Implement in `src/ui/agent-widget-tree.ts`:

- Header line: `● Agents` plus counts/depth for rich mode.
- Compact node row: connector + status icon/spinner + display name + description + terse stats.
- Rich node rows: compact node row plus detail row for running agents.
- Connector calculation using prefix segments (`│  ` vs `   `) and child `├─`/`└─`.
- Width truncation via `truncateToWidth(line, width)`.
- Overflow: if output exceeds `maxLines`, keep the earliest active path rows and append a truncated summary line: `└─ +N more agents hidden`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --run test/agent-widget.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/agent-widget-tree.ts test/agent-widget.test.ts
git commit -m "feat: render recursive subagent tree rows"
```

---

### Task 3: Wire AgentWidget to the recursive tree renderer

**Files:**
- Modify: `src/ui/agent-widget.ts`
- Modify: `test/agent-widget.test.ts`

**Interfaces:**
- Consumes: `renderAgentTree`, `WidgetAgentSnapshot`, `WidgetDisplayMode` from Task 2.
- Produces:
  - `AgentWidget.setDisplayMode(mode: WidgetDisplayMode): void`
  - `AgentWidget.upsertSnapshot(snapshot: WidgetAgentSnapshot): void`
  - `AgentWidget.removeSnapshot(id: string): void`
  - `AgentWidget.clearSnapshots(): void`

- [ ] **Step 1: Write failing AgentWidget integration tests**

Add tests using fake manager and captured widget callback:

```ts
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
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --run test/agent-widget.test.ts`

Expected: FAIL because `upsertSnapshot()` does not exist and widget still uses flat rendering.

- [ ] **Step 3: Implement widget snapshot merging**

In `src/ui/agent-widget.ts`:

- Import tree helpers.
- Add `private descendantSnapshots = new Map<string, WidgetAgentSnapshot>();`
- Add `private displayMode: WidgetDisplayMode = "auto";`
- Implement `setDisplayMode`, `upsertSnapshot`, `removeSnapshot`, `clearSnapshots`.
- Convert local `manager.listAgents()` records to `WidgetAgentSnapshot` with local `agentActivity` attached.
- Merge local records over descendant snapshots by id so local live state wins.
- Replace the current flat render assembly in `renderWidget()` with `renderAgentTree()`.
- Keep `shouldShowFinished()` filtering for local records; apply a timestamp/status filter to descendant snapshots too.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --run test/agent-widget.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/agent-widget.ts test/agent-widget.test.ts
git commit -m "feat: wire widget to recursive tree renderer"
```

---

### Task 4: Add widget display mode settings

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/index.ts`
- Modify: `test/settings.test.ts`

**Interfaces:**
- Consumes: `WidgetDisplayMode` from `src/ui/agent-widget-tree.ts`.
- Produces:
  - `SubagentsSettings.widgetDisplayMode?: WidgetDisplayMode`
  - `SettingsAppliers.setWidgetDisplayMode(mode: WidgetDisplayMode): void`

- [ ] **Step 1: Write failing settings tests**

Add to `test/settings.test.ts`:

```ts
it("sanitize accepts widgetDisplayMode values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-set-"));
  try {
    saveSettings({ widgetDisplayMode: "compact" } as any, dir);
    expect(loadSettings(dir).widgetDisplayMode).toBe("compact");
    saveSettings({ widgetDisplayMode: "rich" } as any, dir);
    expect(loadSettings(dir).widgetDisplayMode).toBe("rich");
    saveSettings({ widgetDisplayMode: "auto" } as any, dir);
    expect(loadSettings(dir).widgetDisplayMode).toBe("auto");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it("drops invalid widgetDisplayMode values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-set-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  try {
    writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({ widgetDisplayMode: "wide" }));
    expect(loadSettings(dir).widgetDisplayMode).toBeUndefined();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

it("applySettings calls setWidgetDisplayMode only for valid values", () => {
  const setWidgetDisplayMode = vi.fn();
  applySettings({ widgetDisplayMode: "rich" } as any, { setWidgetDisplayMode } as never);
  expect(setWidgetDisplayMode).toHaveBeenCalledWith("rich");
  setWidgetDisplayMode.mockClear();
  applySettings({}, { setWidgetDisplayMode } as never);
  expect(setWidgetDisplayMode).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --run test/settings.test.ts`

Expected: FAIL because settings do not support `widgetDisplayMode`.

- [ ] **Step 3: Implement settings support**

In `src/settings.ts`:

- Import or define `WidgetDisplayMode` without creating a circular runtime dependency. Prefer `import type { WidgetDisplayMode } from "./ui/agent-widget-tree.js";`.
- Add `widgetDisplayMode?: WidgetDisplayMode` to `SubagentsSettings`.
- Add `setWidgetDisplayMode` to `SettingsAppliers`.
- Add valid set: `new Set<WidgetDisplayMode>(["auto", "rich", "compact"])`.
- Sanitize and apply the field.

In `src/index.ts`:

- Add local state: `let widgetDisplayMode: WidgetDisplayMode = "auto";`.
- Add setter that updates state and calls `widget.setDisplayMode(mode)`.
- Include mode in `snapshotSettings()`.
- Add a `/agents → Settings` item labeled “Widget display” with values `auto`, `rich`, `compact`.
- Persist changes via existing `notifyApplied()`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --run test/settings.test.ts test/agent-widget.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts src/index.ts test/settings.test.ts test/agent-widget.test.ts
git commit -m "feat: add subagent widget display setting"
```

---

### Task 5: Publish descendant lifecycle/activity snapshots

**Files:**
- Modify: `src/index.ts`
- Modify: `src/ui/agent-widget.ts`
- Modify: `test/agent-widget.test.ts`
- Optional modify: `test/subagents-print-mode-e2e.test.ts`

**Interfaces:**
- Consumes: `AgentWidget.upsertSnapshot()` from Task 3.
- Produces lifecycle payloads that include enough fields for `WidgetAgentSnapshot`.

- [ ] **Step 1: Write failing event aggregation tests**

Add a unit-level test around `AgentWidget.upsertSnapshot()` if event wiring is hard to isolate. If index-level event hooks are easy to capture in existing extension tests, assert that `subagents:started` payloads now include `startedAt`, `status`, `toolUses`, and invocation data.

Minimum payload assertion shape:

```ts
expect(pi.events.emit).toHaveBeenCalledWith("subagents:started", expect.objectContaining({
  id: expect.any(String),
  depth: 1,
  parentAgentId: undefined,
  startedAt: expect.any(Number),
  status: "running",
  toolUses: 0,
}));
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run the specific test file selected in Step 1.

Expected: FAIL because lifecycle payloads are not yet rich enough or widget does not consume them.

- [ ] **Step 3: Implement event snapshot wiring**

In `src/index.ts`:

- Extend `buildEventData(record)` to include `startedAt`, `completedAt`, `invocation`, and `status`.
- Extend `subagents:started` payload to include `startedAt`, `status: "running"`, `toolUses`, `invocation`, and `description`.
- Add a helper converting event payloads to `WidgetAgentSnapshot`.
- Register listeners for `subagents:started`, `subagents:completed`, `subagents:failed`, and `subagents:compacted` that call `widget.upsertSnapshot()`.
- Avoid duplicate regressions by letting local manager snapshots override event snapshots in `AgentWidget`.
- When a session starts/switches/shuts down, clear descendant snapshots alongside existing manager cleanup.

For live activity, emit a narrow activity snapshot from existing activity callbacks when practical:

- On tool start/end, update the local `agentActivity` map as today and emit a `subagents:activity` event with id, status, toolUses, activity text, turn count, token totals, and timestamps.
- Add a listener that updates the widget snapshot for descendants.

If activity propagation is not practical in this task, keep descendants live as `thinking…` until terminal event, and mark richer descendant activity as a follow-up only if tests prove the event data path is insufficient.

- [ ] **Step 4: Run targeted tests and verify pass**

Run selected event tests and `npm test -- --run test/agent-widget.test.ts`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/ui/agent-widget.ts test/agent-widget.test.ts test/subagents-print-mode-e2e.test.ts
git commit -m "feat: aggregate recursive subagent widget snapshots"
```

---

### Task 6: Final validation and cleanup

**Files:**
- Modify only if tests expose issues.

**Interfaces:**
- Consumes all previous tasks.
- Produces verified feature branch ready for review/merge.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- --run test/agent-widget.test.ts test/settings.test.ts test/steer-render.test.ts test/conversation-viewer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run lint**

Run:

```bash
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Review final diff**

Run:

```bash
git diff --stat HEAD
git diff HEAD -- src/ui/agent-widget-tree.ts src/ui/agent-widget.ts src/index.ts src/settings.ts test/agent-widget.test.ts test/settings.test.ts
```

Check:

- No unrelated code changes.
- No temporary preview/server artifacts staged.
- Browser preview remains only in ignored `reviews/` scratch.
- Tree code is isolated and testable.

- [ ] **Step 5: Commit any final fixes**

If Step 4 required changes:

```bash
git add <changed-files>
git commit -m "fix: polish recursive subagent widget tree"
```

- [ ] **Step 6: Report completion**

Final response should include:

- Design preview paths.
- Spec and plan paths.
- Summary of implemented behavior.
- Verification commands and results.
- Any known remaining risks, especially whether live descendant activity is fully rich or initially falls back to `thinking…`.

--- SUMMARY ---

- Build one recursive widget tree model from agent snapshots keyed by id and linked by `parentAgentId`.
- Render the tree through configurable modes: `auto` (default), `rich`, and `compact`.
- `auto` starts rich and falls back to compact when width/line budget makes rich output too large.
- Root widget aggregates descendants through lifecycle/activity event snapshots rather than direct child-manager coupling.
- Focused path view is designed as the subagent-local representation, with full implementation possible after the root recursive tree is stable.
- Validation centers on deterministic Vitest coverage for tree linking, rendering, overflow, settings, descendant counts, and existing width-safety behavior.
