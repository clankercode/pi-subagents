# Recursive Subagent Widget Design

## Goal

Show the full recursive subagent delegation tree in the TUI widget, including grandchildren and deeper descendants, with a rich default view, automatic compact fallback, and a focused path view for subagent-local context.

## Verified current behavior

The current `AgentWidget` renders only `manager.listAgents()` from its own extension instance. It groups records by status (`finished`, `running`, `queued`) and renders them as flat sibling lines. It does not build a tree from `parentAgentId`/`depth`, and descendants spawned by recursive subagents are owned by child extension/manager instances rather than the root widget manager.

Evidence from source inspection:

- `src/ui/agent-widget.ts` calls `this.manager.listAgents()` and renders flat `finishedLines`, `runningLines`, and `queuedLine` arrays.
- `src/agent-manager.ts` records already include `depth` and `parentAgentId` metadata.
- `src/index.ts` emits recursive lifecycle events with `depth` and `parentAgentId`, but the widget does not consume those events into a recursive aggregate.

## Settled visual direction

The browser preview lives at:

- `reviews/recursive-subagent-widget-preview.html`
- `reviews/recursive-subagent-widget-preview-rev2.png`

Approved direction:

1. Rich tree is the default.
2. The widget automatically falls back to compact rendering when the terminal width, line budget, or tree size makes rich rendering too noisy.
3. Users can configure rendering mode in settings.
4. A focused path view is used inside subagent-local UI context to show “where this subagent sits in the tree.”

## Render modes

### Rich mode

Rich mode is the default root widget view.

Example shape:

```text
● Agents 3 running · 1 queued · depth 3/4
├─ ⠋ Plan opus split task
│  ⎿ ↻3≤20 · 4 tools · 22.8k token (38%) · 1m 12s
│  ├─ ⠹ Explore inspect widget data flow
│  │  ⎿ reading agent-widget.ts · 14.2s
│  │  └─ ⠼ general-purpose trace manager ownership
│  │     ⎿ searching tests · 4.8s
│  └─ ✓ auditor review plan · 31s
├─ ◦ Explore queued after concurrency cap
└─ ✗ Plan old attempt error: model unavailable
```

Node content:

- Connector glyphs show parent/child relationships.
- Status icon/spinner shows queued/running/success/error/stopped/aborted.
- Agent type and optional model/tags are shown on the main line.
- Description is shown on the main line.
- Activity/stat detail line is shown for active agents.
- Terminal/error line can include a short error or terminal status.

### Compact mode

Compact mode renders one line per agent using the same tree structure and ordering, but omits the active detail line.

Example shape:

```text
● Agents
├─ ⠋ Plan split task · ↻3 · 2 tools · 1m 12s
│  ├─ ⠹ Explore inspect UI · reading…
│  └─ ✓ auditor review paths · 42s
└─ ⠼ general-purpose write tests · editing…
```

### Auto fallback

Default behavior is `rich` with automatic fallback to compact when rich mode would exceed the widget budget.

Fallback triggers:

- Terminal width is too narrow for readable rich lines.
- Rich tree would exceed the configured widget line cap after subtree overflow summaries are applied.
- Tree density is high enough that compact mode communicates more useful information than rich mode.

Exact thresholds should be conservative and test-covered; the first implementation should prefer readability and bounded output over displaying every detail.

### Focused path view

Focused path view is for a subagent-local widget or future selectable mode. It answers: “where is this subagent in the recursive delegation tree?”

Example shape:

```text
● Agents 7 total · showing active branch
├─ ⠋ Plan split task · 1m 12s
│  └─ ⠹ Explore inspect UI · reading…
│     └─ ⠼ general-purpose trace manager · searching…
├─ +2 completed siblings hidden
└─ +2 queued / stale descendants hidden
```

## Tree data model

Create a tree model separate from rendering. The model should be built from agent records and/or lifecycle snapshots.

Required fields per node:

- `id`
- `parentAgentId`
- `depth`
- `type`
- `description`
- `status`
- `startedAt`
- `completedAt`
- `error`
- `toolUses`
- `invocation`
- live activity state when available
- usage/turn/compaction stats when available

The tree builder should:

- Key all records by id.
- Link children to parents by `parentAgentId`.
- Treat missing parent records as orphans under an `Other agents` group.
- Sort parent before descendants.
- Sort active nodes before queued before recently terminal siblings within a sibling set.
- Preserve stable ordering between renders to avoid visual jitter.

## Recursive visibility source

The root widget needs a durable aggregate that includes descendants from child manager instances. The design should prefer using existing lifecycle events over tight manager coupling:

- `subagents:started`
- `subagents:completed`
- `subagents:failed`
- `subagents:compacted`
- existing direct manager records for live activity and direct children

If lifecycle events do not carry enough live detail for rich rendering, extend event payloads narrowly rather than exposing child managers directly.

## Settings

Add a widget display setting with these values:

- `auto` — default: rich rendering with compact fallback.
- `rich` — prefer rich rendering; still apply subtree overflow to remain bounded.
- `compact` — always render compact tree.

The settings UI should label this as something like “Subagent widget display” with choices “Auto”, “Rich tree”, and “Compact tree.”

## Overflow and truncation

The widget must remain bounded.

Rules:

- Keep the existing `MAX_WIDGET_LINES` style cap, but apply it to a tree-aware layout.
- Collapse whole subtrees where possible instead of arbitrary middle lines.
- Show summary lines such as `└─ +4 descendants hidden (2 running, 1 queued, 1 finished)`.
- Prioritize visible active paths over completed siblings.
- Preserve width safety using existing `truncateToWidth` behavior.

## Testing requirements

Add deterministic tests for:

1. A parent → child → grandchild tree renders with proper indentation/connectors.
2. Grandchildren appear in the root widget aggregate.
3. Compact mode uses one line per node.
4. Auto mode falls back to compact under constrained width/height.
5. Overflow collapses subtrees and reports correct hidden counts.
6. Orphan records render under `Other agents`.
7. Status bar counts include descendants.
8. Existing width-safety and status-bar truncation tests continue to pass.

## Non-goals for first implementation

- Interactive expand/collapse controls inside the widget.
- Persisted historical trees beyond the existing short linger window.
- New public API for external extensions unless required by implementation evidence.
- Reworking core subagent scheduling or completion delivery.

## Open implementation notes

- Verify whether child lifecycle events already propagate to the root extension’s event bus in real recursive sessions. If they do, use them. If not, add a narrow bridge for descendant lifecycle snapshots.
- Keep rendering logic isolated from data aggregation so the tree model can be tested without the TUI.
- Avoid changing the current Agent tool result renderer as part of this feature unless a test proves shared behavior is required.
