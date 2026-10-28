import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { getLens, writeLensWords } from '../src/tools/lens.js';
import { DOCS_ANSWERS, FAKE_CITED_LENS, FAKE_FACTS_LENS, FAKE_LENS, FAKE_LIMITS, FAKE_RANGE, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { JUDGING, makeProject, removeTempDirs, restoreEnv, textOf, useStorage } from './helpers/fixtures.js';

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
  app.docsRoutes = true;
  app.docsStatus = 200;
  app.docsAnswer = DOCS_ANSWERS.session;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DOCS_STEP = "The session's last step: the docs pages of the areas it changed, src/billing and src/jobs, need words, so the pages the user reads in ShadowGit describe the code as it is now. A page with no words can start short, from its facts and the code you read. get_docs, then write_docs.";

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

  it("lists each step's symbols with their lines and the range's checkpoint quotes", async () => {
    app.lensAnswer = { range: FAKE_RANGE, lens: FAKE_CITED_LENS };
    const text = textOf(await getLens({}));
    expect(text).toContain('`ProjectIndex.familyOf` (src/project.ts, head 12–40)');
    // A renamed file's base is read at its old path: an excerpt on the base side names that one
    expect(text).toContain('`chargeCard` (src/charge.ts, head 2–10; base src/old-charge.ts 2–8)');
    expect(text).toContain('"Retry failed charges"');
  });

  it("lists the checkpoint messages a why may quote, as data: the rules are write_lens_words' schema", async () => {
    app.lensAnswer = { range: FAKE_RANGE, lens: FAKE_CITED_LENS };
    const text = textOf(await getLens({}));
    expect(text).toContain('Checkpoint messages a why may quote:\n- "Retry failed charges"');
    expect(text).not.toContain('only where the text names it');
  });

  it("lists what the range makes depend on what, with each fact's links and steps", async () => {
    app.lensAnswer = { range: FAKE_RANGE, lens: FAKE_FACTS_LENS };
    const result = await getLens({});
    expect(result.structuredContent).toMatchObject({ lens: { dependencies: FAKE_FACTS_LENS.dependencies } });
    const text = textOf(result);
    expect(text).toContain(
      [
        'Dependencies:',
        '- jobs depends on api for the first time (src/jobs → src/api; steps c1)',
        '  src/jobs/report.ts imports src/api/users.ts',
        '  dailyReport (src/jobs/report.ts:4) calls countUsers (src/api/users.ts:15)',
      ].join('\n'),
    );
    expect(text).toMatch(/Step c1 "Add RetryQueue"[^\n]*\n {2}Dependencies: jobs depends on api for the first time\n/);
  });

  it("counts the facts past the cap, and lists a fact no step holds, or a layer's, without what it lacks", async () => {
    const [fact] = FAKE_FACTS_LENS.dependencies.facts;
    if (fact === undefined) throw new Error('no fact');
    const layer = { ...fact, sentence: 'renderer depends on main for the first time', level: 'layer', from: { label: 'renderer', path: null }, to: { label: 'main', path: null }, evidence: [] };
    const lens = { ...FAKE_FACTS_LENS, dependencies: { facts: [{ ...fact, steps: [] }, layer], more: 2 } };
    app.lensAnswer = { range: FAKE_RANGE, lens };
    const text = textOf(await getLens({}));
    expect(text).toContain('- jobs depends on api for the first time (src/jobs → src/api)\n');
    expect(text).toContain('- renderer depends on main for the first time (steps c1)\n');
    expect(text).toContain('- and 2 more\n');
  });

  it('says nothing of dependencies for an app that sends none', async () => {
    expect(textOf(await getLens({}))).not.toContain('Dependencies');
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
    // The docs step is asked for alongside: the words are the one request to /lens/words
    expect(app.requestsTo('/lens/words')).toEqual([{
      repoPath: project,
      ...FAKE_RANGE,
      author: 'Claude Code',
      words: { summary: 'Failed payments wait for another try.', steps: [{ id: 'c1', title: 'Queue failed charges' }], components: [{ id: 'k1', role: 'Retries failed charges' }] },
    }]);
    expect(result.structuredContent).toEqual({ repo: 'webshop', applied: { summary: true, steps: 1, components: 1, layers: 0, flows: 0 }, ignored: ['c99'], next: DOCS_STEP });
    expect(textOf(result)).toContain("ShadowGit's Lens shows your words for webshop");
    expect(textOf(result)).toContain('c99');
  });

  it('asks to update the docs pages the session changed when the app lists some', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const result = await writeLensWords({ ...FAKE_RANGE, summary: 'Failed payments wait for another try.' }, 'Claude Code');
    expect(app.requests.filter((request) => request.path.startsWith('/docs?')).map((request) => request.path)).toEqual([`/docs?${new URLSearchParams({ repoPath: project })}`]);
    // The words' 58 s, and the docs' 20 s: the step is never worth a long wait
    expect(timeout.mock.calls).toEqual(expect.arrayContaining([[20_000]]));
    expect(result.structuredContent).toMatchObject({ next: DOCS_STEP });
    expect(textOf(result).endsWith(` Next: ${DOCS_STEP}`)).toBe(true);
    expect(textOf(result)).not.toMatch(JUDGING);
    const pages = (answer: object) => (answer as { pages: object[] }).pages;
    app.docsAnswer = { ...DOCS_ANSWERS.session, pages: [...pages(DOCS_ANSWERS.all).slice(0, 1), ...pages(DOCS_ANSWERS.session).slice(0, 1)] };
    expect(textOf(await writeLensWords({ ...FAKE_RANGE, summary: 'A summary.' }, 'Claude Code'))).toContain('the docs pages of the areas it changed, the Overview and src/billing, need words');
  });

  it('answers as before when the app has no docs, counts past its deadline, has none to update, or answers a shape it does not read', async () => {
    const words = { ...FAKE_RANGE, summary: 'Failed payments wait for another try.' };
    app.docsRoutes = false;
    const before = await writeLensWords(words, 'Claude Code');
    expect(before.structuredContent).not.toHaveProperty('next');
    expect(textOf(before)).toBe("ShadowGit's Lens shows your words for webshop: the summary, 1 steps, 1 roles. Left out ids the lens does not hold: c99. Read them again with get_lens.");
    app.docsRoutes = true;
    for (const docs of [{ status: 202 as const }, { answer: { ...DOCS_ANSWERS.session, pages: [] } }, { answer: { pages: 'none' } }]) {
      app.docsStatus = docs.status ?? 200;
      app.docsAnswer = docs.answer ?? DOCS_ANSWERS.session;
      const result = await writeLensWords(words, 'Claude Code');
      expect(result).toEqual(before);
    }
  });

  it('asks for an app update when the route is missing', async () => {
    app.lensRoutes = false;
    await expect(writeLensWords({ ...FAKE_RANGE, steps: [{ id: 'c1', title: 'A title' }] }, 'Claude Code')).rejects.toThrow('no Lens for AI assistants');
  });

  it('tells the agent to update an app that refuses pieces', async () => {
    app.wordsStatus = 400;
    const linked = { ...FAKE_RANGE, steps: [{ id: 'c1', body: [{ text: 'RetryQueue', card: 'k1' }, { text: ' calls chargeCard again.' }] }] };
    const refused = writeLensWords(linked, 'Claude Code');
    await expect(refused).rejects.toThrow('update the ShadowGit app');
    await expect(writeLensWords(linked, 'Claude Code')).rejects.toThrow('plain text');
  });
});
