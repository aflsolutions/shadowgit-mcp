import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDocs, writeDocs } from '../src/tools/docs.js';
import { APP_WITHOUT_DOCS } from '../src/session-api.js';
import { DOCS_ANSWERS, startFakeApp, type FakeApp } from './helpers/fake-app.js';
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
  app.docsRoutes = true;
  app.docsStatus = 200;
  app.docsAnswer = DOCS_ANSWERS.session;
  app.docsWritten = null;
});

const docsAsked = () => app.requests.filter((request) => request.path.startsWith('/docs?')).map((request) => request.path);
const HEAD = 'f62bdb89d909314bf5ac433a7478502a65bdc26d';

describe('get_docs', () => {
  it("reads the session's pages, with their facts, words and changes", async () => {
    const result = await getDocs({});
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams({ repoPath: project })}`]);
    expect(result.structuredContent).toEqual({ repo: 'webshop', ...DOCS_ANSWERS.session });
    const text = textOf(result);
    expect(text).toContain('Page "billing" (area src/billing): no words yet.');
    expect(text).toContain('Page "jobs" (area src/jobs): no words yet.');
    expect(text).toContain(`Write with write_docs, head "${HEAD}"`);
    expect(text).not.toMatch(JUDGING);
    await expect(text).toMatchFileSnapshot('__snapshots__/get-docs-session.txt');
  });

  it('on a page behind its words, lists what changed since them', async () => {
    app.docsAnswer = DOCS_ANSWERS.area;
    const text = textOf(await getDocs({ areas: ['src/billing'] }));
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams({ repoPath: project, area: 'src/billing' })}`]);
    expect(text).toContain('Page "billing" (area src/billing): 1 change since its words, written by Claude Code at f62bdb89.');
    expect(text).toContain('- splitCents (src/billing/money.ts): code');
    expect(text).toContain('[chargeCard](chargeCard in src/billing/charge.ts)');
    expect(text).toContain('[jobs](area src/jobs)');
    expect(text).not.toMatch(JUDGING);
    await expect(text).toMatchFileSnapshot('__snapshots__/get-docs-area.txt');
  });

  it("passes all's next back whole", async () => {
    app.docsAnswer = DOCS_ANSWERS.all;
    const result = await getDocs({ all: true });
    const next = { after: 6, map: '7645e40324841dedfe41b3d6f0bda4b745e6136d' };
    expect(result.structuredContent).toMatchObject({ next });
    const text = textOf(result);
    expect(text).toContain('Page "Overview" (the Overview): no words yet.');
    expect(text.split('\n').at(-1)).toBe(`More pages without words: get_docs with all and next ${JSON.stringify(next)}.`);
    expect(text).not.toMatch(JUDGING);
    await expect(text).toMatchFileSnapshot('__snapshots__/get-docs-all.txt');
    // next alone asks for the following batch, as next with all does
    await getDocs({ next });
    await getDocs({ all: true, next });
    const following = `/docs?${new URLSearchParams({ repoPath: project, all: 'true', after: '6', map: next.map })}`;
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams({ repoPath: project, all: 'true' })}`, following, following]);
  });

  it('asks for named pages and the Overview together', async () => {
    await getDocs({ areas: ['src/billing', 'src/jobs'], overview: true });
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams([['repoPath', project], ['area', 'src/billing'], ['area', 'src/jobs'], ['overview', 'true']])}`]);
  });

  it('says when no page is asked for', async () => {
    app.docsAnswer = { ...DOCS_ANSWERS.session, pages: [] };
    expect(textOf(await getDocs({}))).toBe("The latest AI session in webshop changed no area whose docs page needs words.");
    app.docsAnswer = { ...DOCS_ANSWERS.all, pages: [], next: null };
    expect(textOf(await getDocs({ all: true }))).toBe("Every page of webshop's map has words.");
  });

  it('refuses all with areas, and says what the app answers while it counts', async () => {
    await expect(getDocs({ all: true, areas: ['src/billing'] })).rejects.toThrow('Ask for all, or name areas and the overview: not both.');
    await expect(getDocs({ next: { after: 6, map: 'm' }, overview: true })).rejects.toThrow('Ask for all, or name areas and the overview: not both.');
    expect(app.requests).toEqual([]);
    app.docsStatus = 202;
    await expect(getDocs({})).rejects.toThrow(
      "ShadowGit: ShadowGit is drawing this project's map or counting the changes since its pages' words; ask again in a minute",
    );
  });
});

describe('write_docs', () => {
  const summary = 'Charges and refunds cards, in cents, and records each payment in the ledger.';
  const link = { text: 'chargeCard', symbol: { file: 'src/billing/charge.ts', name: 'chargeCard' } };

  it('sends each page as the app takes it', async () => {
    const result = await writeDocs(
      { head: HEAD, pages: [{ area: 'src/billing', summary, body: ['Plain.', [link]] }, { overview: true, holds: true }] },
      'Claude Code',
    );
    expect(app.requestsTo('/docs')).toEqual([{
      repoPath: project,
      head: HEAD,
      author: 'Claude Code',
      pages: [{ area: 'src/billing', words: { summary, body: [[{ text: 'Plain.' }], [link]] } }, { overview: true, holds: true }],
    }]);
    expect(textOf(result)).toBe('ShadowGit keeps your words for src/billing and the Overview, at snapshot f62bdb89.');
  });

  it('names the links it made plain text, and the pages it left out', async () => {
    app.docsWritten = DOCS_ANSWERS.written;
    const result = await writeDocs(
      { head: HEAD, pages: [{ area: 'src/billing', summary, body: [[link]] }, { area: 'src/nowhere', summary: 'Nothing.', body: ['Nothing here.'] }] },
      'Claude Code',
    );
    expect(result.structuredContent).toEqual({ repo: 'webshop', ...DOCS_ANSWERS.written });
    const text = textOf(result);
    expect(text).not.toMatch(JUDGING);
    await expect(text).toMatchFileSnapshot('__snapshots__/write-docs.txt');
  });

  it.each([
    [{ area: 'src/billing', overview: true, holds: true }, 'Page 1 names an area and the overview: name one.'],
    [{ holds: true }, 'Page 1 names no area and not the overview: name one.'],
    [{ area: 'src/billing', summary }, 'Page 1 sends neither words (a summary and a body) nor holds: send words, or holds: true where its words still hold.'],
    [{ area: 'src/billing', holds: true, summary, body: ['Plain.'] }, 'Page 1 sends words and holds: send one.'],
  ])("refuses a page it can't send, sending nothing (%o)", async (page, message) => {
    await expect(writeDocs({ head: HEAD, pages: [page] }, 'Claude Code')).rejects.toThrow(message);
    expect(app.requests).toEqual([]);
  });

  it('both tools say an app without docs needs updating', async () => {
    app.docsRoutes = false;
    await expect(getDocs({})).rejects.toThrow(APP_WITHOUT_DOCS);
    await expect(writeDocs({ head: HEAD, pages: [{ overview: true, holds: true }] }, 'Claude Code')).rejects.toThrow(APP_WITHOUT_DOCS);
  });
});
