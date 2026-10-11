/**
 * Runs the phrases from docs.shadowgit.com through Claude Code (`claude -p`) against this server, each in a fresh
 * temporary project, and checks what happened. Spends tokens and its results vary, so it runs by hand before a
 * release, not in CI.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as z from 'zod/v4';
import { BINARY } from '../tests/helpers/client.js';
import { fakeSession, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, snapshot, tempDir, useStorage } from '../tests/helpers/fixtures.js';

const run = promisify(execFile);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

interface Context {
  app: FakeApp;
  project: string;
  answer: string;
}

// The phrases as docs.shadowgit.com writes them; its example project is webshop, like the temporary one.
const CASES: { phrase: string; prepare?: (app: FakeApp, project: string) => void; passed: (c: Context) => boolean }[] = [
  {
    phrase: 'Show me my ShadowGit repositories',
    // list_repos asks the app for its active sessions; the answer alone could come from the working directory.
    passed: ({ app, answer }) => answer.includes('webshop') && app.requestsTo('/session/active').length > 0,
  },
  { phrase: 'What changed in the last hour?', passed: ({ answer }) => answer.includes('checkout.ts') },
  { phrase: 'Show me the history of Header.tsx', passed: ({ answer }) => answer.includes('Restyle header') },
  { phrase: 'What changed in webshop in the last hour?', passed: ({ answer }) => answer.includes('checkout.ts') },
  { phrase: 'Show me the last 10 commits in webshop', passed: ({ answer }) => answer.includes('Add checkout page') },
  {
    phrase: 'Start a ShadowGit session for debugging',
    passed: ({ app, project }) => app.requestsTo('/session/start').some((b) => b.repoPath === project),
  },
  {
    phrase: "Create a checkpoint with message 'Fixed auth bug'",
    passed: ({ app }) => app.requestsTo('/checkpoint').some((b) => /fixed auth bug/i.test(String(b.title))),
  },
  {
    phrase: 'End the current ShadowGit session',
    prepare: (app, project) => {
      app.sessions.push(fakeSession({ repoPath: project, description: 'debugging' }));
    },
    passed: ({ app }) => app.requestsTo('/session/end').some((b) => b.sessionId === 'claude-code-1'),
  },
];

const Output = z.object({ is_error: z.boolean(), result: z.string() });
const firstLines = (text: string) => text.split('\n').slice(0, 5).join('\n').slice(0, 400);
const indent = (text: string) => `      ${text.replace(/\n/g, '\n      ')}`;

function makeWebshop(): string {
  const project = makeProject('webshop', { 'README.md': '# Webshop\n', 'src/Header.tsx': 'export const Header = () => null;\n' }, ago(2 * 24 * 60));
  snapshot(project, { 'src/Header.tsx': 'export const Header = () => "header";\n' }, 'Restyle header', ago(20 * 60));
  snapshot(project, { 'src/checkout.ts': 'export const checkout = true;\n' }, 'Add checkout page', ago(10));
  // Only the history may know checkout.ts, so Claude cannot answer from the working tree.
  fs.rmSync(path.join(project, 'src/checkout.ts'));
  return project;
}

async function askClaude(phrase: string, app: FakeApp, project: string): Promise<z.infer<typeof Output>> {
  const storage = useStorage([{ name: 'webshop', path: project }]);
  const config = path.join(tempDir('eval'), 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: { shadowgit: { command: process.execPath, args: [BINARY], env: { SHADOWGIT_STORAGE_DIR: storage, SHADOWGIT_SESSION_API: app.url } } },
  }));
  const claude = run(
    'claude',
    [
      '-p', phrase, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__shadowgit__*',
      '--output-format', 'json', '--no-session-persistence', '--max-budget-usd', '1',
    ],
    { cwd: project, timeout: 240_000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 },
  );
  // claude waits 3 s for piped stdin before it starts; there is none.
  claude.child.stdin?.end();
  const { stdout } = await claude.catch((error: unknown) => {
    // claude exits 1 when it reports an error, with the reason in the JSON on stdout.
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) return { stdout: error.stdout };
    throw error;
  });
  return Output.parse(JSON.parse(stdout));
}

let passedCount = 0;
for (const { phrase, prepare, passed } of CASES) {
  const app = await startFakeApp();
  let failure: string | undefined;
  try {
    const project = makeWebshop();
    prepare?.(app, project);
    const { is_error, result } = await askClaude(phrase, app, project);
    if (is_error) failure = `Claude Code reported an error: ${result}`;
    else if (!passed({ app, project, answer: result })) failure = result;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    await app.close();
    removeTempDirs();
  }
  if (failure === undefined) {
    passedCount++;
    console.log(`PASS  ${phrase}`);
    continue;
  }
  console.log(`FAIL  ${phrase}`);
  console.log(indent(firstLines(failure)));
  console.log(indent(app.requests.map((r) => `${r.path} ${JSON.stringify(r.body)}`.slice(0, 300)).join('\n') || 'no request reached the fake app'));
}
console.log(`\n${passedCount}/${CASES.length} phrases passed`);
process.exitCode = passedCount === CASES.length ? 0 : 1;
