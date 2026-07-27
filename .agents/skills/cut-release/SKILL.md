---
name: cut-release
description: Cut a release of this repo — bump the version (major|minor|patch, inferred from the diff and confirmed with the user when omitted), update CHANGELOG, run the full verification suite, commit, push, tag, and watch the release CI until it publishes. Use when the user asks to cut/bump/ship/publish a release or version.
---

# Cut Release

Cut and publish a new version of `@clanker-code/pi-subagents`. Argument: `$ARGUMENTS` — optionally one of `major`, `minor`, `patch`.

## 1. Determine the bump type

- If `$ARGUMENTS` contains `major`, `minor`, or `patch`, use it.
- Otherwise infer it from the changes since the last tag:
  1. Find the last tag: `git tag -l 'v*' | sort -V | tail -1`
  2. Review `git diff <last-tag>...HEAD --stat` and the commits (`git log --oneline <last-tag>...HEAD`).
  3. Judge by semver: breaking user-facing changes → major; new features/settings → minor; fixes, string/wording-only changes, internal changes → patch.
  4. **Confirm with the user via the AskUserQuestion tool** (or the platform equivalent): present the inferred bump (recommended, with a one-line rationale) plus the other two options. Do not proceed until they answer.

## 2. Bump and document

1. `npm version <type> --no-git-tag-version` (updates `package.json` and `package-lock.json`).
2. Add a `## [x.y.z] - <YYYY-MM-DD>` section at the top of `CHANGELOG.md` (right after the header preamble; this repo keeps no `[Unreleased]` section). Use `date +%F` for the date. Summarize user-facing changes under `### Added` / `### Changed` / `### Fixed` as appropriate, matching the existing entry style (bold lead, em-dash, details).
3. Check `README.md`: if the release changes any user-facing feature, the README must document it (AGENTS.md makes this mandatory). If the README is stale, fix it now.

## 3. Verify

Run and require a pass: `npm run lint && npm run typecheck && npm test && npm run build`. If anything fails, fix it before continuing — do not tag a red tree.

## 4. Commit, tag, push

1. `git add -A && git commit` with message `vX.Y.Z` (matching prior release commits).
2. `git push`
3. `git tag vX.Y.Z && git push origin vX.Y.Z`

Pushing the tag triggers `.github/workflows/release.yml`, which publishes to npm and creates the GitHub Release.

## 5. Confirm the release

1. Watch the workflow: `gh run list --workflow=release.yml --limit=1` then `gh run watch <run-id>` (or poll `gh run view`).
2. On failure: read the log (`gh run view --log-failed`), fix, and re-tag if needed. A common failure is npm trusted-publishing setup — see AGENTS.md for the `npm trust github` remedy.
3. On success: verify the npm version is live (`npm view @clanker-code/pi-subagents version`) and the GitHub Release exists (`gh release view vX.Y.Z`). If the release notes are empty, populate them from the CHANGELOG section for this version (`gh release edit vX.Y.Z --notes ...`).
