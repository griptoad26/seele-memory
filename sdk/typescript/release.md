# `@seele/memory-client` release checklist

This file documents the exact steps to release a new version of
`@seele/memory-client` to npm. The publish step itself is **automated**
through GitHub Actions — no human ever handles the npm token.

## One-time setup (per repo)

1. Generate a granular access token at https://www.npmjs.com/settings/YOUR-USER/tokens
   with **publish** scope. As of 2026, this MUST be the "Automation" token
   type (`npm_******` prefix), not a legacy manual token.
2. Add the token to this repo's GitHub Actions secrets:
   - Repository → Settings → Secrets and variables → Actions → New repository secret.
   - Name: `NPM_AUTH_TOKEN`
   - Value: paste the token.

   The user does this once. The token never appears in the codebase.

3. Verify the GitHub Actions workflow at `.github/workflows/npm-publish.yml`
   is present and references `NPM_AUTH_TOKEN`.

## Per-release steps

1. **Bump version** in `sdk/typescript/package.json`. Use SemVer:
   - `0.1.0` → `0.2.0` for new (backward-compatible) features.
   - `0.2.0` → `0.3.0` for changes that require consumer updates.
   - `0.x.y` → `1.0.0` ONLY when the public API stabilizes.

2. **Run the tests locally**:
   ```bash
   cd sdk/typescript
   npm install
   npm run lint   # typecheck
   npm run test   # 52 tests, all green
   npm run build  # tsup produces dist/
   ```

3. **Commit** the bump:
   ```bash
   git add sdk/typescript/package.json
   git commit -m "chore(sdk): bump @seele/memory-client to v0.X.0"
   ```

4. **Open a PR** against `main` with the version bump. Reviewer merges.
   (Future: replace with auto-merge once we trust the workflow.)

5. **Tag the merged commit** on `main`:
   ```bash
   git tag npm-publish-v0.X.0 main
   git push origin npm-publish-v0.X.0
   ```

6. GitHub Actions picks up the tag push and runs `.github/workflows/npm-publish.yml`:
   - Installs deps.
   - Runs `npm run lint`, `npm run test`, `npm run build`.
   - Publishes via `npm publish --access public` with the `NODE_AUTH_TOKEN=$NPM_AUTH_TOKEN`
     env var.

7. **Verify on npm**:
   ```bash
   npm view @seele/memory-client@0.X.0
   ```
   Confirm the version, `dist.tarball`, and the `repository.url` field
   point at https://github.com/griptoad26/seele-memory.

8. **Update the README** badge (auto-updates once npm-sync webhook fires).

## Troubleshooting

- **"Invalid auth token"**: the token in `NPM_AUTH_TOKEN` is expired or
  revoked. Generate a new one and re-set the secret.
- **"You do not have permission to publish"**: the npm account owning the
  `@seele` scope must include the publishing user. The token's
  `npm whoami` should be the org owner.
- **Tag already exists**: delete it locally + remotely, re-tag at HEAD:
  ```bash
  git tag -d npm-publish-v0.X.0
  git push origin :refs/tags/npm-publish-v0.X.0
  git tag npm-publish-v0.X.0
  git push origin npm-publish-v0.X.0
  ```

## Tokens

**Never** paste an `npm_` token into a file, an issue, a PR comment, or
a chat. They are bearer credentials and bypass all your npm 2FA.
