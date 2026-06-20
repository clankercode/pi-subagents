# CLAUDE.md — Notes for Claude / Coding Agents

This is a fork of [`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

## Fork Relationship

- We track upstream for useful changes but do **not** auto-merge.
- This is a pseudo-fork: cherry-pick upstream commits when they apply cleanly and fit our direction; otherwise reimplement the same behavior in our own commits.
- `package.json`, `README.md`, and `CHANGELOG.md` must reflect this fork (`@clankercode/pi-subagents`).

## Release Checklist

Every release must:

1. Bump `version` in `package.json`.
2. Update `CHANGELOG.md` with a dated `[x.y.z]` section under `[Unreleased]`.
3. **Update `README.md` to document any new or changed user-facing features.**
4. Run and pass: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
5. Commit and push.
6. User publishes with `npm publish` from a clean `master` checkout.

## Keeping Upstream In Sync

Periodically run:

```bash
git fetch upstream
git log --oneline --right-only --no-merges HEAD...upstream/master
```

Cherry-pick commits that are wanted and clean; reimplement anything that conflicts with fork-specific changes.
