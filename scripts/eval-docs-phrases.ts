/**
 * Runs the phrases from docs.shadowgit.com through Claude Code (`claude -p`) against this server, each in a fresh
 * temporary project, and checks what happened. Spends tokens and its results vary, so it runs by hand before a
 * release, not in CI.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { FAKE_LENS, MAP_PROJECT, fakeSession, startFakeApp, type FakeApp } from '../tests/helpers/fake-app.js';
import { makeProject, removeTempDirs, shadowGit, snapshot } from '../tests/helpers/fixtures.js';
import type { LensWords } from '../src/session-api.js';
import { ago, runClaude } from './claude.js';


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
  {
    phrase: 'How is this project organised?',
    // The webshop the fake app's map answers are of, so the code and the map agree
    prepare: (_app, project) => snapshot(project, MAP_PROJECT, 'Add the webshop'),
    passed: ({ app }) => app.requests.some((r) => r.path.startsWith('/map?') && !new URLSearchParams(r.path.slice('/map?'.length)).has('area')),
  },
  {
    phrase: 'What depends on chargeCard?',
    prepare: (_app, project) => snapshot(project, MAP_PROJECT, 'Add the webshop'),
    passed: ({ app, answer }) =>
      app.requestsTo('/map/context').some((b) => JSON.stringify(b.symbols ?? []).includes('chargeCard')) && answer.includes('retryFailedCharges'),
  },
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
  {
    phrase: 'Write the Lens words for this session',
    // The Lens of a change the project's history really holds: an assistant that checks it against git finds it there
    prepare: (app, project) => {
      app.lensAnswer = { range: { base: shadowGit(project, ['rev-parse', 'HEAD~1']), head: shadowGit(project, ['rev-parse', 'HEAD']) }, lens: CHECKOUT_LENS };
    },
    // It reads the lens, and words a step by the id the lens gave
    passed: ({ app }) =>
      app.requests.some((r) => r.path.startsWith('/lens?')) &&
      app.requestsTo('/lens/words').some((b) => {
        const words = b.words as LensWords | undefined;
        return words?.steps?.some((step) => step.id === 'c1' && Boolean(step.title?.trim())) === true;
      }),
  },
];

/** The Lens the app would draw of webshop's last snapshot, "Add checkout page": src/checkout.ts added. */
const CHECKOUT_LENS: typeof FAKE_LENS = {
  ...FAKE_LENS,
  steps: [{ id: 'c1', title: 'Add checkout', body: null, components: ['k1'], files: ['src/checkout.ts'], diff: '+export const checkout = true;' }],
  components: [{ id: 'k1', name: 'checkout', kind: 'constant', delta: 'added', context: false, role: null, path: 'src/checkout.ts', symbols: ['checkout'] }],
  flows: [],
};

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
  const stdout = await runClaude({
    prompt: phrase, project, app, timeoutMs: 240_000,
    args: ['--allowedTools', 'mcp__shadowgit__*', '--output-format', 'json', '--max-budget-usd', '1'],
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
