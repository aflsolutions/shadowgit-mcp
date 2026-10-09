# Releasing

1. Ship any app change the release depends on first (2.0.0 needs the app's `POST /api/checkpoint`).
2. Set the new version in `package.json` and in both places in `server.json`; add the CHANGELOG entry.
3. `npm test` and `npm run eval`: the eval must pass every phrase.
4. Merge to `main`, then from `main`:

```bash
npm publish
mcp-publisher login github
mcp-publisher publish
```

`npm publish` runs typecheck, lint and tests first (`prepublishOnly`). The MCP Registry checks that `mcpName` in the
published `package.json` matches `server.json`'s `name`, so publish to npm before the registry.

## Why vite is pinned

`vite` is pinned to 7 in devDependencies although nothing imports it: with vite 8, npm 10 (Node 20, what CI runs)
crashes resolving vitest 4 and rejects the lockfile in `npm ci`. Keep it at 7 until the npm that CI uses (Node 20's npm
10) resolves vitest with vite 8.
