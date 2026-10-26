/**
 * Whether Claude Code reads ShadowGit's map before it changes code, on its own: a change to a function another area
 * depends on, in a tracked project of three areas, with no word about ShadowGit, the server's instructions the only
 * hint. The fake app answers with the real app's answers for that project. A run passes when get_code_context is
 * called with the function or its file before the first edit; the eval passes at 4 runs of 5. Spends tokens and its
 * results vary, so it runs by hand before a release, beside `npm run eval` and `npm run eval:lens`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { MAP_ANSWERS, MAP_PROJECT, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs } from '../tests/helpers/fixtures.js';
import { EDITS, STREAM_ARGS, ago, readStream, runClaude } from './claude.js';

const RUNS = Number(process.env.RUNS ?? 5);
const PASS_AT = 4;
const TASK = 'Make chargeCard reject an amount below zero with a RangeError, and keep every caller working.';
const TARGETS = ['chargeCard', 'src/billing/charge.ts'];
async function runTask(app: FakeApp, project: string) {
  return readStream(await runClaude({ prompt: TASK, project, app, timeoutMs: 420_000, args: STREAM_ARGS }));
}

let passed = 0;
for (let i = 1; i <= RUNS; i++) {
  const app = await startFakeApp();
  // The real app's answer for what was asked: a file, or chargeCard (with checkout, where they land together)
  Object.defineProperty(app.mapAnswer, 'context', {
    get: () => {
      const asked = JSON.stringify(app.requestsTo('/map/context').at(-1) ?? {});
      if (asked.includes('src/billing/charge.ts')) return MAP_ANSWERS.file;
      return asked.includes('"checkout"') ? MAP_ANSWERS.landing : MAP_ANSWERS.context;
    },
  });
  try {
    const project = makeProject('webshop', MAP_PROJECT, ago(2 * 24 * 60));
    const { calls, cost } = await runTask(app, project);
    const asked = calls.findIndex((call) => call.name === 'mcp__shadowgit__get_code_context' && TARGETS.some((target) => JSON.stringify(call.input).includes(target)));
    const edited = calls.findIndex((call) => EDITS.has(call.name));
    const changed = fs.readFileSync(path.join(project, 'src/billing/charge.ts'), 'utf8') !== MAP_PROJECT['src/billing/charge.ts'];
    const ok = asked !== -1 && edited !== -1 && asked < edited;
    if (ok) passed++;
    console.log(`run ${i}: ${ok ? 'PASS' : 'FAIL'} asked=${asked} first_edit=${edited} changed=${changed} cost=$${cost.toFixed(2)}`);
    console.log(`  tools: ${calls.map((call) => call.name.replace('mcp__shadowgit__', 'shadowgit:')).join(' → ') || 'none'}`);
  } catch (error) {
    console.log(`run ${i}: error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  } finally {
    await app.close();
    removeTempDirs();
  }
}
console.log(`\n${passed} of ${RUNS} runs asked for the code's context before the first edit (pass at ${PASS_AT})`);
process.exitCode = passed >= Math.min(PASS_AT, RUNS) ? 0 : 1;
