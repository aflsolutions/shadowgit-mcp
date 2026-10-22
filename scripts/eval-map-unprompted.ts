/**
 * Whether Claude Code reads ShadowGit's map before it changes code, on its own: a change to a function another area
 * depends on, in a tracked project of three areas, with no word about ShadowGit, the server's instructions the only
 * hint. The fake app answers with the real app's answers for that project. A run passes when get_code_context is
 * called with the function or its file before the first edit; the eval passes at 4 runs of 5. Spends tokens and its
 * results vary, so it runs by hand before a release, beside `npm run eval` and `npm run eval:lens`.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as z from 'zod/v4';
import { BINARY } from '../tests/helpers/client.js';
import { MAP_ANSWERS, MAP_PROJECT, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, tempDir, useStorage } from '../tests/helpers/fixtures.js';

const run = promisify(execFile);
const RUNS = Number(process.env.RUNS ?? 5);
const PASS_AT = 4;
const TASK = 'Make chargeCard reject an amount below zero with a RangeError, and keep every caller working.';
const TARGETS = ['chargeCard', 'src/billing/charge.ts'];
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// One line of `--output-format stream-json`: the assistant's turns carry its tool calls, in order
const Line = z.object({
  type: z.string(),
  message: z.object({ content: z.array(z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })).optional() }).optional(),
  total_cost_usd: z.number().optional(),
});

async function runTask(app: FakeApp, project: string): Promise<{ calls: { name: string; input: unknown }[]; cost: number }> {
  const storage = useStorage([{ name: 'webshop', path: project }]);
  const config = path.join(tempDir('eval'), 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: { shadowgit: { command: process.execPath, args: [BINARY], env: { SHADOWGIT_STORAGE_DIR: storage, SHADOWGIT_SESSION_API: app.url } } },
  }));
  const claude = run(
    'claude',
    [
      '-p', TASK, '--mcp-config', config, '--strict-mcp-config', '--allowedTools', 'mcp__shadowgit__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-budget-usd', '2',
    ],
    { cwd: project, timeout: 420_000, killSignal: 'SIGKILL', maxBuffer: 20 * 1024 * 1024 },
  );
  claude.child.stdin?.end();
  const { stdout } = await claude.catch((error: unknown) => {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) return { stdout: error.stdout };
    throw error;
  });
  const calls: { name: string; input: unknown }[] = [];
  let cost = 0;
  for (const text of stdout.split('\n')) {
    if (text.trim() === '') continue;
    const line = Line.safeParse(JSON.parse(text));
    if (!line.success) continue;
    if (line.data.total_cost_usd !== undefined) cost = line.data.total_cost_usd;
    if (line.data.type !== 'assistant') continue;
    for (const part of line.data.message?.content ?? []) if (part.type === 'tool_use' && part.name) calls.push({ name: part.name, input: part.input });
  }
  return { calls, cost };
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
    const project = makeProject('webshop', MAP_PROJECT, new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString());
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
