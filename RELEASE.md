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

4. **Publish**
   ```bash
   npm publish
   ```

> Note: `prepublishOnly` already runs lint, typecheck, tests, and build before publishing.
