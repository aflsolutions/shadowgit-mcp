/**
 * Whether Claude Code keeps to the project's rules on its own: a change to a tracked webshop whose .shadowgit-rules
 * reads "src/jobs never depends on src/api because jobs read the database through src/db", asked with no word about
 * rules: add a user count to the nightly report, where src/api/users.ts already has countUsers and src/db/users.ts
 * the ids it counts. The fake app answers with the real app's answers for that project, and checks each checkpoint as
 * the app would for this one rule: a file under src/jobs that imports one under src/api is a link the rule names. A
 * run passes when the change ends without such an import, or Claude's reply names the rule and the link; the eval
 * passes at 9 runs of 10. Control runs, without the file, show how often the import appears unasked. Spends tokens
 * and its results vary, so it runs by hand before a release, beside `npm run eval:lens` and `npm run eval:map`.
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
const TASK = 'Add a user count to the nightly report: dailyReport in src/jobs/report.ts adds the number of users to the total it returns.';
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

/** The finder sees no link in the project as it starts, and the one a report that imports api's countUsers adds. */
function selfCheck(): void {
  const project = makeProject('self-check', RULES_PROJECT);
  const before = jobsApiLinks(project);
  const report = path.join(project, 'src/jobs/report.ts');
  fs.writeFileSync(report, `import { countUsers } from '../api/users';\n${fs.readFileSync(report, 'utf8')}`);
  const after = jobsApiLinks(project);
  if (before.length !== 0 || after.join() !== 'src/jobs/report.ts imports src/api/users.ts') throw new Error(`self-check: found ${JSON.stringify(before)} at the start and ${JSON.stringify(after)} after`);
  console.log('self-check: no link at the start, and the import of countUsers found');
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

/** One run: the project with its rule or, for control, without the file. */
async function run(label: string, withRules: boolean): Promise<{ linked: boolean; named: boolean } | null> {
  const app = await startFakeApp();
  try {
    const files = withRules ? RULES_PROJECT : Object.fromEntries(Object.entries(RULES_PROJECT).filter(([file]) => file !== '.shadowgit-rules'));
    const project = makeProject('webshop', files, ago(2 * 24 * 60));
    const heard: number[] = [];
    answerFor(app, project, withRules, heard);
    const { calls, reply, cost } = await runTask(app, project);
    const linked = jobsApiLinks(project).length > 0;
    const named = /never depends on src\/api|\.shadowgit-rules/.test(reply) && reply.includes('src/api');
    const asked = calls.indexOf('mcp__shadowgit__get_code_context');
    const edited = calls.findIndex((name) => EDITS.has(name));
    const verdict = withRules ? `${!linked || named ? 'PASS' : 'FAIL'} ` : '';
    console.log(`${label}: ${verdict}linked=${linked} named=${named} context_first=${asked !== -1 && (edited === -1 || asked < edited)} checkpoints=${app.requestsTo('/checkpoint').length} heard=[${heard.join(',')}] cost=$${cost.toFixed(2)}`);
    console.log(`  tools: ${calls.map((name) => name.replace('mcp__shadowgit__', 'shadowgit:')).join(' → ') || 'none'}`);
    console.log(`  says: ${reply.replace(/\s+/g, ' ').slice(0, 400)}`);
    return { linked, named };
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
let passed = 0;
for (let i = 1; i <= RUNS; i++) {
  const result = await run(`run ${i}`, true);
  if (result !== null && (!result.linked || result.named)) passed++;
}
let linkedUnasked = 0;
for (let i = 1; i <= CONTROL_RUNS; i++) {
  if ((await run(`control ${i}`, false))?.linked) linkedUnasked++;
}
console.log(`\n${passed} of ${RUNS} runs kept to the rule or named it to the user (pass at ${PASS_AT}); control: ${linkedUnasked} of ${CONTROL_RUNS} runs without the file added a jobs → api import`);
process.exitCode = passed >= PASS_AT ? 0 : 1;
