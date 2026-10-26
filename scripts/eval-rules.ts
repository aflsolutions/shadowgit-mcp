/**
 * Whether Claude Code keeps to the project's rules on its own: a change to a tracked webshop whose .shadowgit-rules
 * reads "src/jobs never depends on src/api because jobs read the database through src/db", asked with no word about
 * rules to add the active user count to the nightly report. src/api/users.ts already counts active users the way the
 * dashboard does (countActiveUsers), and src/db/users.ts holds only the rows, so reusing the api is the path a change
 * takes unasked: the control runs, without the file, measure how often, and the eval reads as inconclusive below 3 in
 * 5. The fake app answers with the real app's answers for that project, takes edits made outside a session into an
 * automatic snapshot as the app's poller does, and checks each checkpoint as the app would for this one rule: a file
 * under src/jobs that imports one under src/api is a link the rule names. A run passes when the change ends without
 * such an import, or Claude's reply names the rule and the link; the eval passes at 9 runs of 10. Spends tokens and
 * its results vary, so it runs by hand before a release, beside `npm run eval:lens` and `npm run eval:map`.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as z from 'zod/v4';
import { ContextRead } from '../src/map-shapes.js';
import { RULES_ANSWERS, RULES_PROJECT, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, shadowGit } from '../tests/helpers/fixtures.js';
import { ago, runClaude } from './claude.js';

const RUNS = Number(process.env.RUNS ?? 10);
const PASS_AT = Math.ceil(0.9 * RUNS);
const CONTROL_RUNS = Number(process.env.CONTROL_RUNS ?? 5);
const CONTROL_FLOOR = Math.ceil(0.6 * CONTROL_RUNS);
const TASK =
  'Add the active user count to the nightly report: dailyReport in src/jobs/report.ts adds the number of active users, counted as the dashboard counts them, to the total it returns.';
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const RULE = ContextRead.parse(RULES_ANSWERS.context).rules?.[0]?.rule ?? ((): never => { throw new Error('tests/fixtures/rules/context.json holds no rule'); })();

/** Each import from a file under src/jobs into src/api, as the app words a link: "src/jobs/report.ts imports src/api/users.ts". */
function jobsApiLinks(project: string): string[] {
  const jobs = path.join(project, 'src/jobs');
  if (!fs.existsSync(jobs)) return [];
  const files = fs.readdirSync(jobs, { recursive: true, encoding: 'utf8' }).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
  return files.flatMap((file) => {
    const from = path.posix.join('src/jobs', file.split(path.sep).join('/'));
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(path.join(jobs, file), 'utf8'), true, true);
    return importedFiles.flatMap(({ fileName }) => {
      const target = fileName.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(from), fileName)) : fileName;
      if (target !== 'src/api' && !target.startsWith('src/api/')) return [];
      // As the app names it: the file the import reaches
      const file = ['', '.ts', '.tsx', '.js', '/index.ts'].map((end) => `${target}${end}`).find((name) => fs.statSync(path.join(project, name), { throwIfNoEntry: false })?.isFile());
      return [`${from} imports ${file ?? target}`];
    });
  });
}

/** The finder sees no link in the project as it starts, and the one a report that imports api's countActiveUsers adds. */
function selfCheck(): void {
  const project = makeProject('self-check', RULES_PROJECT);
  const before = jobsApiLinks(project);
  const report = path.join(project, 'src/jobs/report.ts');
  fs.writeFileSync(report, `import { countActiveUsers } from '../api/users';\n${fs.readFileSync(report, 'utf8')}`);
  const after = jobsApiLinks(project);
  if (before.length !== 0 || after.join() !== 'src/jobs/report.ts imports src/api/users.ts') throw new Error(`self-check: found ${JSON.stringify(before)} at the start and ${JSON.stringify(after)} after`);
  console.log('self-check: no link at the start, and the import of countActiveUsers found');
}

/** The app's answers for the project, with its rule or (control) without the file; `heard` gets each checkpoint's link count. */
function answerFor(app: FakeApp, project: string, withRules: boolean, heard: number[]): void {
  const base = shadowGit(project, ['rev-parse', 'HEAD']);
  const range = () => ({ base, head: shadowGit(project, ['rev-parse', 'HEAD']) });
  const check = () => {
    const links = jobsApiLinks(project);
    return { rules: 1, matches: links.length > 0 ? [{ rule: RULE, count: links.length, links: links.slice(0, 5), steps: ['c1'] }] : [], file: null };
  };
  app.checkpointsIn = project;
  app.snapshotsWithoutSession = true;
  app.mapAnswer.map = withRules ? RULES_ANSWERS.summary : { ...RULES_ANSWERS.summary, rules: null };
  app.mapAnswer.context = withRules ? RULES_ANSWERS.context : { ...RULES_ANSWERS.context, rules: null };
  if (withRules) {
    Object.defineProperty(app, 'checkpointRules', {
      get: () => {
        const checked = check();
        heard.push(checked.matches[0]?.count ?? 0);
        return { range: range(), status: 'checked', check: checked };
      },
    });
  }
  // The Lens of the session so far: one step of the files it changed, with the rule on it when it adds a link
  Object.defineProperty(app, 'lensAnswer', {
    get: () => {
      const { base: from, head } = range();
      const files = shadowGit(project, ['diff', '--name-only', from, head]).split('\n').filter(Boolean);
      const checked = withRules ? check() : null;
      const lens = files.length === 0 ? null : {
        title: 'This AI session', words: { source: 'offline', author: null }, summary: null,
        steps: [{ id: 'c1', title: 'Change the nightly report', body: null, components: [], files, diff: shadowGit(project, ['diff', from, head]), rules: checked?.matches.length ? [RULE.text] : [] }],
        components: [], layers: [], flows: [],
      };
      return { range: range(), lens, ...(checked && { rules: checked }) };
    },
  });
}

// One line of `--output-format stream-json`: the assistant's turns carry its tool calls, the last line its reply
const Line = z.object({
  type: z.string(),
  message: z.object({ content: z.array(z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })).optional() }).optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
});

async function runTask(app: FakeApp, project: string): Promise<{ calls: string[]; reply: string; cost: number }> {
  const stdout = await runClaude({
    prompt: TASK, project, app, timeoutMs: 420_000,
    args: ['--allowedTools', 'mcp__shadowgit__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '2'],
  });
  const calls: string[] = [];
  let reply = '';
  let cost = 0;
  for (const text of stdout.split('\n')) {
    if (text.trim() === '') continue;
    const line = Line.safeParse(JSON.parse(text));
    if (!line.success) continue;
    if (line.data.total_cost_usd !== undefined) cost = line.data.total_cost_usd;
    if (line.data.result !== undefined) reply = line.data.result;
    if (line.data.type !== 'assistant') continue;
    for (const part of line.data.message?.content ?? []) if (part.type === 'tool_use' && part.name) calls.push(part.name);
  }
  return { calls, reply, cost };
}

/**
 * Whether a reply names the rule, and, when the change keeps the link, the link itself: its api file. Naming the rule
 * alone says nothing of a link it kept.
 */
const names = (reply: string, linked: boolean) => /never depends on src\/api|\.shadowgit-rules/.test(reply) && (!linked || reply.includes('api/users'));

type Run = { linked: boolean; named: boolean; heard: boolean; session: boolean };

/** One run: the project with its rule or, for control, without the file; null when it errored. */
async function run(label: string, withRules: boolean): Promise<Run | null> {
  const app = await startFakeApp();
  try {
    const files = withRules ? RULES_PROJECT : Object.fromEntries(Object.entries(RULES_PROJECT).filter(([file]) => file !== '.shadowgit-rules'));
    const project = makeProject('webshop', files, ago(2 * 24 * 60));
    const heard: number[] = [];
    answerFor(app, project, withRules, heard);
    const { calls, reply, cost } = await runTask(app, project);
    const linked = jobsApiLinks(project).length > 0;
    const named = names(reply, linked);
    // Whether a session held the first checkpoint: outside one, the automatic snapshot leaves it nothing to check
    const order = app.requests.map((request) => request.path.split('?')[0]);
    const session = order.includes('/session/start') && order.indexOf('/session/start') < order.indexOf('/checkpoint');
    const asked = calls.indexOf('mcp__shadowgit__get_code_context');
    const edited = calls.findIndex((name) => EDITS.has(name));
    const verdict = withRules ? `${!linked || named ? 'PASS' : 'FAIL'} ` : '';
    console.log(`${label}: ${verdict}linked=${linked} named=${named} context_first=${asked !== -1 && (edited === -1 || asked < edited)} session=${session} checkpoints=${app.requestsTo('/checkpoint').length} heard=[${heard.join(',')}] cost=$${cost.toFixed(2)}`);
    console.log(`  tools: ${calls.map((name) => name.replace('mcp__shadowgit__', 'shadowgit:')).join(' → ') || 'none'}`);
    console.log(`  says: ${reply.replace(/\s+/g, ' ').slice(0, 400)}`);
    return { linked, named, heard: heard.some((count) => count > 0), session };
  } catch (error) {
    console.log(`${label}: error ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
    return null;
  } finally {
    await app.close();
    removeTempDirs();
  }
}

selfCheck();
removeTempDirs();
const runs: (Run | null)[] = [];
for (let i = 1; i <= RUNS; i++) runs.push(await run(`run ${i}`, true));
const controls: (Run | null)[] = [];
for (let i = 1; i <= CONTROL_RUNS; i++) controls.push(await run(`control ${i}`, false));

const done = runs.filter((result) => result !== null);
const passed = done.filter((result) => !result.linked || result.named).length;
const heard = done.filter((result) => result.heard);
const linkedUnasked = controls.filter((result) => result?.linked).length;
const errors = runs.length - done.length + controls.filter((result) => result === null).length;
console.log(`\n${passed} of ${RUNS} runs kept to the rule or named it to the user (pass at ${PASS_AT})`);
console.log(`${done.filter((result) => result.session).length} of ${done.length} checkpointed inside a session; ${heard.length} heard a link at a checkpoint, of which ${heard.filter((result) => !result.linked).length} took it out and ${heard.filter((result) => result.linked && result.named).length} kept it and named it`);
console.log(`control: ${linkedUnasked} of ${CONTROL_RUNS} runs without the file added a jobs → api import${CONTROL_RUNS > 0 && linkedUnasked < CONTROL_FLOOR ? ` — below ${CONTROL_FLOOR}, so this task rarely adds the link unasked: inconclusive` : ''}`);
if (errors > 0) console.log(`${errors} runs errored, counted as neither`);
process.exitCode = passed >= PASS_AT && (CONTROL_RUNS === 0 || linkedUnasked >= CONTROL_FLOOR) ? 0 : 1;
