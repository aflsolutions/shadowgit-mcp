/**
 * Whether Claude Code words ShadowGit's Lens on its own: a normal two-file task in a tracked project, with no word
 * about the Lens, and the server's instructions as the only hint. Records which ShadowGit routes each run reached,
 * and fails unless every run wrote the Lens's words. Spends tokens and its results vary, so it runs by hand before a
 * release, beside `npm run eval`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { BINARY } from '../tests/helpers/client.js';
import { FAKE_RANGE, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, snapshot, tempDir, useStorage } from '../tests/helpers/fixtures.js';

const run = promisify(execFile);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const RUNS = Number(process.env.RUNS ?? 5);
const TASK =
  'Add a discount code to checkout: create src/discount.ts exporting applyDiscount(total: number, code: string), ' +
  "which takes 10% off when the code is 'SAVE10' and returns the total unchanged otherwise, and use it in " +
  'checkout(total, code) in src/checkout.ts.';

function makeWebshop(): string {
  const project = makeProject('webshop', { 'README.md': '# Webshop\n', 'src/Header.tsx': 'export const Header = () => null;\n' }, ago(2 * 24 * 60));
  snapshot(project, { 'src/checkout.ts': 'export function checkout(total: number): number {\n  return total;\n}\n' }, 'Add checkout', ago(30));
  return project;
}

async function runTask(app: FakeApp, project: string): Promise<string> {
  const storage = useStorage([{ name: 'webshop', path: project }]);
  const config = path.join(tempDir('eval'), 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: { shadowgit: { command: process.execPath, args: [BINARY], env: { SHADOWGIT_STORAGE_DIR: storage, SHADOWGIT_SESSION_API: app.url } } },
  }));
  const claude = run(
    'claude',
    [
      '-p', TASK, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__shadowgit__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      '--output-format', 'json', '--no-session-persistence', '--max-budget-usd', '2',
    ],
    { cwd: project, timeout: 420_000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 },
  );
  claude.child.stdin?.end();
  const { stdout } = await claude.catch((error: unknown) => {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) return { stdout: error.stdout };
    throw error;
  });
  return stdout;
}

/** The Lens the app would draw of the task's change: what a real draw of applyDiscount and checkout shows. */
const DISCOUNT_LENS = {
  title: 'This AI session',
  words: { source: 'offline', author: null },
  summary: null as string | null,
  steps: [{
    id: 'c1', title: 'Add applyDiscount, used by checkout', body: null, components: ['k1', 'k2'], files: ['src/discount.ts', 'src/checkout.ts'],
    diff: "+export function applyDiscount(total: number, code: string): number {\n+  return code === 'SAVE10' ? total * 0.9 : total;\n+}\n-export function checkout(total: number): number {\n-  return total;\n+export function checkout(total: number, code: string): number {\n+  return applyDiscount(total, code);",
  }],
  components: [
    { id: 'k1', name: 'applyDiscount', kind: 'function', delta: 'added', context: false, role: null, path: 'src/discount.ts', symbols: ['applyDiscount'] },
    { id: 'k2', name: 'checkout', kind: 'function', delta: 'modified', context: false, role: null, path: 'src/checkout.ts', symbols: ['checkout'] },
  ],
  layers: [{ id: 'code', name: 'Code' }],
  flows: [{ id: 'f1', from: 'k2', to: 'k1', label: 'applyDiscount()' }],
};

const tally = { session: 0, checkpoint: 0, ended: 0, read: 0, worded: 0 };
for (let i = 1; i <= RUNS; i++) {
  const app = await startFakeApp();
  app.lensAnswer = { range: FAKE_RANGE, lens: DISCOUNT_LENS };
  try {
    const project = makeWebshop();
    const stdout = await runTask(app, project);
    const { result, total_cost_usd: cost } = JSON.parse(stdout) as { result: string; total_cost_usd: number };
    const edited = fs.existsSync(path.join(project, 'src/discount.ts'));
    const hit = {
      session: app.requestsTo('/session/start').length > 0,
      checkpoint: app.requestsTo('/checkpoint').length > 0,
      ended: app.requestsTo('/session/end').length > 0,
      read: app.requests.some((r) => r.path.startsWith('/lens?')),
      worded: app.requestsTo('/lens/words').length > 0,
    };
    for (const key of Object.keys(hit) as (keyof typeof hit)[]) if (hit[key]) tally[key]++;
    console.log(`run ${i}: edited=${edited} ${Object.entries(hit).map(([k, v]) => `${k}=${v}`).join(' ')} cost=$${cost.toFixed(2)}`);
    console.log(`  order: ${app.requests.map((r) => r.path.split('?')[0]).join(' → ') || 'no request'}`);
    console.log(`  says: ${result.replace(/\s+/g, ' ').slice(0, 220)}`);
  } catch (error) {
    console.log(`run ${i}: error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  } finally {
    await app.close();
    removeTempDirs();
  }
}
console.log(`\nof ${RUNS} runs: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
process.exitCode = tally.worded === RUNS ? 0 : 1;
