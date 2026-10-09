import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/shadowgit-mcp-server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // The SDK pulls in CommonJS dependencies that call require(), which ESM output does not define.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
  legalComments: 'none',
});
