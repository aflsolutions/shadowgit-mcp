import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getLens, writeLensWords } from '../src/tools/lens.js';
import { FAKE_LENS, FAKE_LIMITS, FAKE_RANGE, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { makeProject, removeTempDirs, restoreEnv, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let app: FakeApp;

beforeAll(async () => {
  project = makeProject('webshop');
  useStorage([{ name: 'webshop', path: project }]);
  app = await startFakeApp();
});

afterAll(async () => {
  restoreEnv();
  await app.close();
  removeTempDirs();
});

beforeEach(() => {
  process.env.CLAUDE_PROJECT_DIR = project;
  app.requests.length = 0;
  app.lensRoutes = true;
  app.lensAnswer = { range: FAKE_RANGE, lens: FAKE_LENS };
  app.wordsStatus = 200;
});

describe('get_lens', () => {
  it("reads the latest session's lens of the current project, every id with its code, and says how to word it", async () => {
    const result = await getLens({});
    expect(app.requests.at(-1)?.path).toBe(`/lens?${new URLSearchParams({ repoPath: project })}`);
    expect(result.structuredContent).toEqual({ repo: 'webshop', range: FAKE_RANGE, lens: FAKE_LENS, limits: FAKE_LIMITS });
    const text = textOf(result);
    expect(text).toContain('write_lens_words');
    expect(text).toContain(`base "${FAKE_RANGE.base}" and head "${FAKE_RANGE.head}"`);
    expect(text).toContain('Step c1 "Add RetryQueue": cards k1, k2');
    expect(text).toContain('+export class RetryQueue {}');
    expect(text).toContain('k1 RetryQueue (class, added) src/retry-queue.ts');
    expect(text).toContain('f1 k1 → k2 "chargeCard()"');
    expect(text).toContain('step title 60');
  });

  it('asks for the snapshots it is given, a null base from the start of the history', async () => {
    await getLens({ base: 'abc1234', head: 'def5678' });
    expect(app.requests.at(-1)?.path).toBe(`/lens?${new URLSearchParams({ repoPath: project, base: 'abc1234', head: 'def5678' })}`);
    await getLens({ base: null, head: 'def5678' });
    expect(app.requests.at(-1)?.path).toBe(`/lens?${new URLSearchParams({ repoPath: project, base: '', head: 'def5678' })}`);
  });

  it('says to pass a range from the start of the history with base null, not the string "null"', async () => {
    app.lensAnswer = { range: { base: null, head: FAKE_RANGE.head }, lens: FAKE_LENS };
    const text = textOf(await getLens({}));
    expect(text).toContain(`base null and head "${FAKE_RANGE.head}"`);
  });

  it('shows the summary written so far, so a model can keep or improve it', async () => {
    app.lensAnswer = { range: FAKE_RANGE, lens: { ...FAKE_LENS, summary: 'Failed payments wait for another try.' } };
    expect(textOf(await getLens({}))).toContain('Summary: Failed payments wait for another try.');
  });

  it("fences a step's diff past the longest backtick run inside it, so a Markdown fence in the diff cannot close it", async () => {
    const diff = ' ````ts\n+const a = 1;\n ````';
    app.lensAnswer = { range: FAKE_RANGE, lens: { ...FAKE_LENS, steps: FAKE_LENS.steps.map((step) => ({ ...step, diff })) } };
    expect(textOf(await getLens({}))).toContain(`\`\`\`\`\`diff\n${diff}\n\`\`\`\`\`\n`);
  });

  it('asks for base and head together, before calling the app', async () => {
    await expect(getLens({ head: 'def5678' })).rejects.toThrow('base and head together');
    await expect(getLens({ base: 'abc1234' })).rejects.toThrow('base and head together');
    expect(app.requests).toHaveLength(0);
  });

  it('asks for an app update when the routes are missing', async () => {
    app.lensRoutes = false;
    await expect(getLens({})).rejects.toThrow('no Lens for AI assistants');
  });

  it('says a range that changes no code has no lens to word', async () => {
    app.lensAnswer = { range: FAKE_RANGE, lens: null };
    const result = await getLens({});
    expect(textOf(result)).toContain('has no lens to word');
    expect(result.structuredContent).toEqual({ repo: 'webshop', range: FAKE_RANGE, lens: null, limits: FAKE_LIMITS });
  });
});

describe('write_lens_words', () => {
  it("passes on the app's reason when it keeps no words: a range that changes no code", async () => {
    app.wordsStatus = 409;
    await expect(writeLensWords({ ...FAKE_RANGE, summary: 'A summary.' }, 'Claude Code')).rejects.toThrow('Nothing in this range changes code');
  });

  it('sends the words for the range, with the client as author, and says what the lens took', async () => {
    const result = await writeLensWords(
      { ...FAKE_RANGE, summary: 'Failed payments wait for another try.', steps: [{ id: 'c1', title: 'Queue failed charges' }], components: [{ id: 'k1', role: 'Retries failed charges' }] },
      'Claude Code',
    );
    expect(app.requests.at(-1)).toEqual({
      path: '/lens/words',
      body: {
        repoPath: project,
        ...FAKE_RANGE,
        author: 'Claude Code',
        words: { summary: 'Failed payments wait for another try.', steps: [{ id: 'c1', title: 'Queue failed charges' }], components: [{ id: 'k1', role: 'Retries failed charges' }] },
      },
    });
    expect(result.structuredContent).toEqual({ repo: 'webshop', applied: { summary: true, steps: 1, components: 1, layers: 0, flows: 0 }, ignored: ['c99'] });
    expect(textOf(result)).toContain("ShadowGit's Lens shows your words for webshop");
    expect(textOf(result)).toContain('c99');
  });

  it('asks for an app update when the route is missing', async () => {
    app.lensRoutes = false;
    await expect(writeLensWords({ ...FAKE_RANGE, steps: [{ id: 'c1', title: 'A title' }] }, 'Claude Code')).rejects.toThrow('no Lens for AI assistants');
  });
});
