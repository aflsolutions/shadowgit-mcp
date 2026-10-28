/**
 * Whether Claude Code keeps the project's docs pages current on its own: a normal two-area task in the map webshop
 * (a late fee in src/billing, charged from src/jobs), with no word about docs, and the server's instructions and
 * write_lens_words' next step as the only hints. Its checkpoints are real, the Lens it reads is of its own change, and
 * the docs the fake app answers are the real app's answer for this very change: billing's and jobs' pages, no words
 * yet. A run passes when, after it wrote the Lens's words, it wrote both pages: each a summary and a body that say
 * something, or holds. The eval passes at 4 runs of 5. Spends tokens and its results vary, so it runs by hand before a
 * release, beside `npm run eval:lens`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DOCS_ANSWERS, MAP_ANSWERS, MAP_PROJECT, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, shadowGit } from '../tests/helpers/fixtures.js';
import { STREAM_ARGS, ago, readStream, runClaude } from './claude.js';

const RUNS = Number(process.env.RUNS ?? 5);
const PASS_AT = Math.ceil(0.8 * RUNS);
const TASK =
  'Retry failed charges with a late fee: add lateFee(amount: number): number to src/billing/charge.ts, returning the amount plus 5%, ' +
  'and make retryFailedCharges in src/jobs/retry.ts charge lateFee(amount) for each failed charge.';
const PAGES = ['src/billing', 'src/jobs'];
// A folder to keep each run's stream-json in, to read what the model said between its calls
const STREAMS = process.env.EVAL_STREAMS;

type Request = FakeApp['requests'][number];
type SentPage = { area?: string; overview?: true; holds?: true; words?: { summary: string; body: { text: string }[][] } };

/** The areas whose pages a run wrote after the Lens's words: words that say something, or holds. */
function pagesWritten(requests: readonly Request[]): Set<string> {
  const worded = requests.findIndex((request) => request.path === '/lens/words');
  if (worded === -1) return new Set();
  const said = (page: SentPage) =>
    page.holds === true || (Boolean(page.words?.summary.trim()) && page.words?.body.some((pieces) => pieces.some((piece) => piece.text.trim() !== '')) === true);
  const sent = requests.slice(worded + 1).filter((request) => request.path === '/docs').flatMap((request) => request.body.pages as SentPage[]);
  return new Set(sent.flatMap((page) => (page.area !== undefined && said(page) ? [page.area] : [])));
}

/** The pass rule reads written pages after the words alone, and both of them. */
function selfCheck(): void {
  const words: Request = { path: '/lens/words', body: {} };
  const docs = (...pages: SentPage[]): Request => ({ path: '/docs', body: { pages } });
  const worded = (area: string): SentPage => ({ area, words: { summary: 'Charges cards.', body: [[{ text: 'Charges cards.' }]] } });
  const cases: [Request[], string[]][] = [
    [[words, docs(worded('src/billing'), { area: 'src/jobs', holds: true })], PAGES],
    [[docs(worded('src/billing'), worded('src/jobs')), words], []],
    [[words, docs(worded('src/billing')), docs({ area: 'src/jobs', words: { summary: ' ', body: [] } })], ['src/billing']],
  ];
  for (const [requests, expected] of cases) {
    const found = [...pagesWritten(requests)].sort();
    if (found.join() !== expected.join()) throw new Error(`self-check: found ${JSON.stringify(found)}, not ${JSON.stringify(expected)}`);
  }
  console.log('self-check: pages written after the words are found, empty words and pages before them are not');
}

/** The Lens the app would draw of the task's change, laid on the range from the snapshot before it to its checkpoint. */
function lensOf(project: string, base: string) {
  const head = shadowGit(project, ['rev-parse', 'HEAD']);
  const files = shadowGit(project, ['diff', '--name-only', base, head]).split('\n').filter(Boolean);
  const lens = files.length === 0 ? null : {
    title: 'This AI session', words: { source: 'offline', author: null }, summary: null,
    steps: [{ id: 'c1', title: 'Add lateFee, charged by retryFailedCharges', body: null, components: ['k1', 'k2'], files, diff: shadowGit(project, ['diff', base, head]) }],
    components: [
      { id: 'k1', name: 'lateFee', kind: 'function', delta: 'added', context: false, role: null, path: 'src/billing/charge.ts', symbols: ['lateFee'] },
      { id: 'k2', name: 'retryFailedCharges', kind: 'function', delta: 'modified', context: false, role: null, path: 'src/jobs/retry.ts', symbols: ['retryFailedCharges'] },
    ],
    layers: [{ id: 'billing', name: 'billing' }, { id: 'jobs', name: 'jobs' }],
    flows: [{ id: 'f1', from: 'k2', to: 'k1', label: 'lateFee()' }],
  };
  return { range: { base, head }, lens };
}

/**
 * The captured pages as the app answers them for this run: drawn at its newest snapshot, and without lateFee among
 * the symbols most depended on, whose line is where the capture wrote it, not where this run's agent does.
 */
function docsAt(head: string): object {
  const answer = JSON.parse(JSON.stringify(DOCS_ANSWERS.session).replaceAll((DOCS_ANSWERS.session as { head: string }).head, head)) as {
    pages: { facts: { mostDepended: { items: { symbol: { name: string } }[]; total: number } } }[];
  };
  for (const { facts } of answer.pages) {
    const kept = facts.mostDepended.items.filter(({ symbol }) => symbol.name !== 'lateFee');
    facts.mostDepended = { items: kept, total: facts.mostDepended.total - (facts.mostDepended.items.length - kept.length) };
  }
  return answer;
}

async function run(i: number): Promise<boolean | null> {
  const app = await startFakeApp();
  try {
    const project = makeProject('webshop', MAP_PROJECT, ago(2 * 24 * 60));
    const base = shadowGit(project, ['rev-parse', 'HEAD']);
    app.checkpointsIn = project;
    // The real app's map answers for this webshop: a question about files reads charge.ts, about symbols chargeCard
    Object.defineProperty(app.mapAnswer, 'context', {
      get: () => (JSON.stringify(app.requestsTo('/map/context').at(-1) ?? {}).includes('"files"') ? MAP_ANSWERS.file : MAP_ANSWERS.context),
    });
    Object.defineProperty(app, 'lensAnswer', { get: () => lensOf(project, base) });
    // The real app's pages for this change, at the project's newest snapshot
    Object.defineProperty(app, 'docsAnswer', { get: () => docsAt(shadowGit(project, ['rev-parse', 'HEAD'])) });
    const stdout = await runClaude({ prompt: TASK, project, app, timeoutMs: 600_000, args: STREAM_ARGS });
    if (STREAMS !== undefined) fs.writeFileSync(path.join(STREAMS, `run-${i}.jsonl`), stdout);
    const { calls, reply, cost } = readStream(stdout);
    const written = pagesWritten(app.requests);
    const passed = PAGES.every((area) => written.has(area));
    const order = app.requests.map((request) => request.path.split('?')[0]);
    console.log(`run ${i}: ${passed ? 'PASS' : 'FAIL'} pages=[${[...written].join(', ')}] docs_writes=${app.requestsTo('/docs').length} cost=$${cost.toFixed(2)}`);
    console.log(`  routes: ${order.join(' → ') || 'no request'}`);
    console.log(`  tools: ${calls.map((call) => call.name.replace('mcp__shadowgit__', 'shadowgit:')).join(' → ') || 'none'}`);
    console.log(`  says: ${reply.replace(/\s+/g, ' ').slice(0, 300)}`);
    return passed;
  } catch (error) {
    console.log(`run ${i}: error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    return null;
  } finally {
    await app.close();
    removeTempDirs();
  }
}

selfCheck();
const results: (boolean | null)[] = [];
for (let i = 1; i <= RUNS; i++) results.push(await run(i));
const passed = results.filter((result) => result === true).length;
const errors = results.filter((result) => result === null).length;
console.log(`\n${passed} of ${RUNS} runs wrote both pages the session changed after the Lens's words (pass at ${PASS_AT})${errors > 0 ? `; ${errors} errored` : ''}`);
process.exitCode = passed >= PASS_AT ? 0 : 1;
