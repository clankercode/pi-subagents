# Release Process

1. **Prepare changes**
   - Ensure all work is on `master` and CI/tests pass:
     ```bash
     npm run lint
     npm run typecheck
     npm test
     npm run build
     ```

2. **Update documentation**
   - Bump `version` in `package.json`.
   - Add a dated `[x.y.z]` section to `CHANGELOG.md` under `[Unreleased]`.
   - **Update `README.md` to describe any new or changed user-facing features.**

3. **Commit and push**
   ```bash
   git add package.json CHANGELOG.md README.md
   git commit -m "chore(release): bump version to x.y.z"
   git push
   ```

4. **Push the version tag**
   The `release.yml` workflow publishes to npm and creates the GitHub Release automatically:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. **Verify**
   - Check the [Actions run](https://github.com/clankercode/pi-subagents/actions) succeeded.
   - Confirm the package version appears on npm: `npm view @clanker-code/pi-subagents`.
   - Confirm the GitHub Release has the changelog notes.

One-time npm trusted-publisher setup:
```bash
npm trust github @clanker-code/pi-subagents --repo=clankercode/pi-subagents --file=release.yml
```

If `npm trust` fails, open `https://www.npmjs.com/package/@clanker-code/pi-subagents/access` and add a GitHub Actions trusted publisher for the `release.yml` workflow.

See `~/.llm-general/npm-autopublish-via-ci.md` for general instructions.

> Note: `prepublishOnly` already runs lint, typecheck, tests, and build before publishing.
