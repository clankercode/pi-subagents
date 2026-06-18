# Default extension tool exposure

## Problem

Subagents have two separate controls:

- `extensions:` decides which extensions load.
- `tools:` decides which tools surface to the model.

That split is useful for least privilege, but some extensions provide
infrastructure tools that should usually be present whenever the extension is
loaded. `pi-c2c` is the first concrete example: a subagent that loads it needs
the c2c tools to identify itself and message its parent, even when the agent's
`tools:` field narrows other extension tools with `ext:` selectors.

## Current v1 behavior

`pi-c2c` is special-cased in `agent-runner.ts` as an auto-exposed extension.
When a non-isolated subagent loads an extension whose canonical name is
`pi-c2c`, all tools registered by that extension are included in the session
allowlist.

The existing safety controls still apply:

- `isolated: true` forces `extensions: false`, so no pi-c2c tools surface.
- `extensions: false` loads no extension tools.
- `exclude_extensions: pi-c2c` removes pi-c2c before tool enumeration.
- `disallowed_tools` can remove individual pi-c2c tools.

All other extensions keep the existing `ext:` opt-in behavior.

## Future generic convention

A future version could let extensions declare this behavior themselves through
metadata, for example:

```ts
export const piExtensionMetadata = {
  subagents: {
    defaultExposeTools: true,
  },
};
```

Open questions before implementing a generic convention:

- Where should metadata live so both source-loaded and packaged extensions can
  expose it without running arbitrary factory code first?
- Should the metadata expose all tools, a named subset, or tool tags?
- How should conflicts be reported when `tools:` explicitly narrows an
  auto-exposed extension?
- Should this be limited to extensions that are already trusted by the parent
  session, or can project extensions opt in too?

This design note intentionally does not implement generic metadata. The v1
implementation is limited to the known `pi-c2c` integration.
