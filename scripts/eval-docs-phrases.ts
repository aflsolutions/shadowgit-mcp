/**
 * Runs the phrases from docs.shadowgit.com through Claude Code (`claude -p`) against this server, each in a fresh
 * temporary project, and checks what happened. Spends tokens and its results vary, so it runs by hand before a
 * release, not in CI.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as z from 'zod/v4';
import { startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, snapshot, tempDir, useStorage } from '../tests/helpers/fixtures.js';

const BINARY = fileURLToPath(new URL('../dist/shadowgit-mcp-server.js', import.meta.url));
const run = promisify(execFile);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Context {
  app: FakeApp;
  project: string;
  answer: string;
}

const sent = (app: FakeApp, route: string) => app.requests.filter((r) => r.path === route).map((r) => r.body);

// The docs say "my-project"; the temporary project is called webshop.
const CASES: { phrase: string; prepare?: (app: FakeApp, project: string) => void; passed: (c: Context) => boolean }[] = [
  { phrase: 'Show me my ShadowGit repositories', passed: ({ answer }) => answer.includes('webshop') },
  { phrase: 'Show me the last 10 commits in webshop', passed: ({ answer }) => answer.includes('Add checkout page') },
  { phrase: 'What changed in webshop in the last hour?', passed: ({ answer }) => answer.includes('checkout.ts') },
  { phrase: 'Show me the history of Header.tsx', passed: ({ answer }) => answer.includes('Restyle header') },
  {
    phrase: 'Start a ShadowGit session for debugging',
    passed: ({ app, project }) => sent(app, '/session/start').some((b) => b.repoPath === project),
  },
  {
    phrase: "Create a checkpoint with message 'Fixed auth bug'",
    passed: ({ app }) => sent(app, '/checkpoint').some((b) => /fixed auth bug/i.test(String(b.title))),
  },
  {
    phrase: 'End the current ShadowGit session',
    prepare: (app, project) => {
      app.sessions.push({ id: 'claude-code-1', repoPath: project, description: 'debugging', startedAt: '2026-10-08 10:00:00' });
    },
    passed: ({ app }) => sent(app, '/session/end').some((b) => b.sessionId === 'claude-code-1'),
  },
];

async function runCase(phrase: string, prepare: ((app: FakeApp, project: string) => void) | undefined): Promise<Context> {
  const project = makeProject('webshop', { 'README.md': '# Webshop\n', 'src/Header.tsx': 'export const Header = () => null;\n' }, ago(2 * 24 * 60));
  snapshot(project, { 'src/Header.tsx': 'export const Header = () => "header";\n' }, 'Restyle header', ago(20 * 60));
  snapshot(project, { 'src/checkout.ts': 'export const checkout = true;\n' }, 'Add checkout page', ago(10));
  const storage = useStorage([{ name: 'webshop', path: project }]);
  const app = await startFakeApp();
  prepare?.(app, project);
  const config = path.join(tempDir('eval'), 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: { shadowgit: { command: process.execPath, args: [BINARY], env: { SHADOWGIT_STORAGE_DIR: storage, SHADOWGIT_SESSION_API: app.url } } },
  }));
  try {
    const claude = run(
      'claude',
      ['-p', phrase, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__shadowgit__*', '--output-format', 'json'],
      { cwd: project, timeout: 240_000, maxBuffer: 10 * 1024 * 1024 },
    );
    // claude waits 3 s for piped stdin before it starts; there is none.
    claude.child.stdin?.end();
    const { stdout } = await claude;
    return { app, project, answer: z.object({ result: z.string() }).parse(JSON.parse(stdout)).result };
  } finally {
    await app.close();
  }
}

let passedCount = 0;
for (const { phrase, prepare, passed } of CASES) {
  try {
    const context = await runCase(phrase, prepare);
    const ok = passed(context);
    if (ok) passedCount++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${phrase}`);
    if (!ok) console.log(`      ${context.answer.slice(0, 400).replace(/\n/g, '\n      ')}`);
  } finally {
    removeTempDirs();
  }
}
console.log(`\n${passedCount}/${CASES.length} phrases passed`);
process.exitCode = passedCount === CASES.length ? 0 : 1;
