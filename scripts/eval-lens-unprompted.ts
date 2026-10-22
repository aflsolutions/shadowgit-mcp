/**
 * Whether Claude Code words ShadowGit's Lens on its own: a normal two-file task in a tracked project, with no word
 * about the Lens, and the server's instructions as the only hint. Its checkpoints are real, and the Lens it reads is
 * of its own change: from the snapshot before the task to its checkpoint. Records which ShadowGit routes each run
 * reached, and fails unless every run went through the session, then wrote the Lens's words. Spends tokens and its results vary, so it runs by hand before a
 * release, beside `npm run eval`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import type { LensWords } from '../src/session-api.js';
import { makeProject, removeTempDirs, shadowGit, snapshot } from '../tests/helpers/fixtures.js';
import { ago, runClaude } from './claude.js';

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

function runTask(app: FakeApp, project: string): Promise<string> {
  return runClaude({
    prompt: TASK, project, app, timeoutMs: 420_000,
    args: ['--allowedTools', 'mcp__shadowgit__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--output-format', 'json', '--max-budget-usd', '2'],
  });
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

/**
 * Whether words cover a lens as the server's instructions ask: a summary, a title and a sentence for every step, and a
 * role for every changed card, each by the lens's own ids.
 */
function coversLens(words: LensWords | undefined, lens: typeof DISCOUNT_LENS): boolean {
  const said = (text: string | undefined) => Boolean(text?.trim());
  return (
    said(words?.summary) &&
    // A body of pieces says what its pieces' text says
    lens.steps.every(({ id }) => words?.steps?.some((step) => step.id === id && said(step.title) && said(typeof step.body === 'string' ? step.body : step.body?.map(({ text }) => text).join(''))) === true) &&
    lens.components.filter((card) => !card.context).every(({ id }) => words?.components?.some((card) => card.id === id && said(card.role)) === true)
  );
}

const tally = { session: 0, checkpoint: 0, ended: 0, read: 0, worded: 0, flowed: 0 };
for (let i = 1; i <= RUNS; i++) {
  const app = await startFakeApp();
  try {
    const project = makeWebshop();
    // The Lens of the task's own change, read when it is asked for: the snapshot before the task to the checkpoint
    const base = shadowGit(project, ['rev-parse', 'HEAD']);
    const range = () => ({ base, head: shadowGit(project, ['rev-parse', 'HEAD']) });
    app.checkpointsIn = project;
    Object.defineProperty(app, 'lensAnswer', { get: () => ({ range: range(), lens: DISCOUNT_LENS }) });
    const stdout = await runTask(app, project);
    const { result, total_cost_usd: cost } = JSON.parse(stdout) as { result: string; total_cost_usd: number };
    const edited = fs.existsSync(path.join(project, 'src/discount.ts'));
    const hit = {
      session: app.requestsTo('/session/start').length > 0,
      checkpoint: app.requestsTo('/checkpoint').length > 0,
      ended: app.requestsTo('/session/end').length > 0,
      read: app.requests.some((r) => r.path.startsWith('/lens?')),
      // Words for this very range that cover the lens: a call with partial words or another range is no wording
      worded: app.requestsTo('/lens/words').some((body) => {
        const { head } = range();
        return body.base === base && body.head === head && head !== base && coversLens(body.words as LensWords | undefined, DISCOUNT_LENS);
      }),
    };
    // The session, then the Lens, in the order the instructions give: start, checkpoint, end, read, write
    const order = app.requests.map((r) => r.path.split('?')[0]);
    const steps = ['/session/start', '/checkpoint', '/session/end', '/lens', '/lens/words'].map((route) => order.indexOf(route));
    const flowed = hit.worded && steps.every((at, k) => at !== -1 && (k === 0 || at > (steps[k - 1] ?? -1)));
    for (const key of Object.keys(hit) as (keyof typeof hit)[]) if (hit[key]) tally[key]++;
    if (flowed) tally.flowed++;
    console.log(`run ${i}: edited=${edited} ${Object.entries(hit).map(([k, v]) => `${k}=${v}`).join(' ')} flowed=${flowed} cost=$${cost.toFixed(2)}`);
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
process.exitCode = tally.flowed === RUNS ? 0 : 1;
