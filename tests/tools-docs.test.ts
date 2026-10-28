import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDocs, writeDocs } from '../src/tools/docs.js';
import { APP_WITHOUT_DOCS } from '../src/session-api.js';
import { DOCS_ANSWERS, pagesOf, startFakeApp, type FakeApp } from './helpers/fake-app.js';
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
/** The write step get_docs answers, where the model reads it: in the structured answer. */
const step = (pages: string, head: string, more = '') =>
  `Write the words of ${pages} with write_docs, head "${head}": for each page a summary of one sentence (at most 200 characters) and a body of short paragraphs (at most 400 words) on what the code you read does, linking the symbols and areas it names; a page with no words can start short, from its facts and the code you read, and later sessions add to it; or holds: true where its words still hold.${more}`;
/** An app's answer as get_docs gives it: the app's cursor as more, and the step as next. */
const asGiven = (answer: object, next: string) => {
  const { next: more, ...rest } = answer as { next: unknown };
  return { repo: 'webshop', ...rest, more, next };
};

describe('get_docs', () => {
  it("reads the session's pages, with their facts, words and changes", async () => {
    const result = await getDocs({});
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams({ repoPath: project })}`]);
    expect(result.structuredContent).toEqual(asGiven(DOCS_ANSWERS.session, step('src/billing and src/jobs', HEAD)));
    const text = textOf(result);
    expect(text).toContain('Page "billing" (area src/billing): no words yet.');
    expect(text).toContain('Page "jobs" (area src/jobs): no words yet.');
    expect(text.split('\n').at(-1)).toBe(`Next: ${step('src/billing and src/jobs', HEAD)}`);
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

  it("passes all's cursor back whole, as more", async () => {
    app.docsAnswer = DOCS_ANSWERS.all;
    const result = await getDocs({ all: true });
    const more = { after: 6, map: '7645e40324841dedfe41b3d6f0bda4b745e6136d' };
    const next = step('the Overview, src/api, src/admin, src/mail and src/search', '7645e40324841dedfe41b3d6f0bda4b745e6136d', ` Then get_docs with more ${JSON.stringify(more)} for the next pages without words.`);
    expect(result.structuredContent).toEqual(asGiven(DOCS_ANSWERS.all, next));
    const text = textOf(result);
    expect(text).toContain('Page "Overview" (the Overview): no words yet.');
    expect(text.split('\n').at(-1)).toBe(`Next: ${next}`);
    expect(text).not.toMatch(JUDGING);
    await expect(text).toMatchFileSnapshot('__snapshots__/get-docs-all.txt');
    // more alone asks for the following batch, as more with all does
    await getDocs({ more });
    await getDocs({ all: true, more });
    const following = `/docs?${new URLSearchParams({ repoPath: project, all: 'true', after: '6', map: more.map })}`;
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams({ repoPath: project, all: 'true' })}`, following, following]);
  });

  it('asks to write only the pages that need words: never a current page, nor one the map no longer holds', async () => {
    const pages = pagesOf(DOCS_ANSWERS.area);
    app.docsAnswer = { ...DOCS_ANSWERS.area, pages: pages.map((page) => ({ ...page, state: 'current' })) };
    const current = await getDocs({ areas: ['src/billing'] });
    expect(current.structuredContent).not.toHaveProperty('next');
    expect(textOf(current)).not.toContain('Next:');
    expect(textOf(current)).toContain('Page "billing" (area src/billing): current: words written by Claude Code at f62bdb89.');
    const gone = { ...pages[0], page: { area: 'src/old' }, label: 'src/old', state: 'not-in-map', facts: null, changes: null };
    app.docsAnswer = { ...DOCS_ANSWERS.session, pages: [...pagesOf(DOCS_ANSWERS.session).slice(0, 1), gone] };
    const mixed = await getDocs({ areas: ['src/billing', 'src/old'] });
    expect(mixed.structuredContent).toMatchObject({ next: expect.stringMatching(/^Write the words of src\/billing with write_docs/) });
  });

  it('says an id the map never held is not an area of the map, and a page that left the map keeps its words', async () => {
    const [billing] = pagesOf(DOCS_ANSWERS.area);
    const unknown = { page: { area: 'billng' }, label: 'billng', state: 'not-in-map', facts: null, rules: [], words: null, changes: null };
    const gone = { ...billing, page: { area: 'src/payments' }, label: 'src/payments', state: 'not-in-map', facts: null, changes: null };
    app.docsAnswer = { ...DOCS_ANSWERS.area, pages: [unknown, gone] };
    const result = await getDocs({ areas: ['billng', 'src/payments'] });
    const text = textOf(result);
    expect(text).toContain('Page "billng" (area billng): not an area of the map.');
    expect(text).toContain('Page "src/payments" (area src/payments): no longer in the map; words written by Claude Code at f62bdb89.');
    expect(result.structuredContent).not.toHaveProperty('next');
  });

  it("says why the changes since a page's words weren't counted, and passes on a state a newer app adds", async () => {
    const [billing] = pagesOf(DOCS_ANSWERS.area);
    app.docsAnswer = {
      ...DOCS_ANSWERS.area,
      pages: [
        { ...billing, state: 'not-counted', changes: null, countFailure: 'This range is too large to draw' },
        { ...billing, page: { area: 'src/jobs' }, label: 'jobs', state: 'drafted', changes: null },
        { ...billing, page: { area: 'src/api' }, label: 'api', state: 'drafted', words: null, changes: null },
      ],
    };
    const text = textOf(await getDocs({ areas: ['src/billing', 'src/jobs', 'src/api'] }));
    expect(text).toContain('Page "billing" (area src/billing): words written by Claude Code at f62bdb89; the changes since them could not be counted: This range is too large to draw.');
    expect(text).toContain('Page "jobs" (area src/jobs): drafted: words written by Claude Code at f62bdb89.');
    expect(text).toContain('Page "api" (area src/api): drafted.');
  });

  it('offers the words of a page that left the map to the area that took its files', async () => {
    const [billing] = pagesOf(DOCS_ANSWERS.area);
    const words = { summary: 'Charges cards.', body: [[{ text: 'Through ' }, { text: 'chargeCard', symbol: { file: 'src/payments/charge.ts', name: 'chargeCard' } }, { text: '.' }]] };
    app.docsAnswer = { ...DOCS_ANSWERS.area, pages: [{ ...billing, former: [{ area: 'src/payments', words }] }] };
    const text = textOf(await getDocs({ areas: ['src/billing'] }));
    expect(text).toContain(
      ['  Former page of area src/payments, whose files this area now holds:', '    Summary: Charges cards.', '    Through [chargeCard](chargeCard in src/payments/charge.ts).'].join('\n'),
    );
  });

  it("lists the areas and layers the Overview's project gained and lost since its words", async () => {
    const [billing = {}] = pagesOf(DOCS_ANSWERS.area);
    const [overview] = pagesOf(DOCS_ANSWERS.all);
    const changes = { count: 3, symbols: { items: [], total: 0 }, dependencies: [], goneLinks: [], areas: { added: ['src/ledger'], removed: ['src/legacy'] }, layers: { added: ['ledger'], removed: [] } };
    app.docsAnswer = { ...DOCS_ANSWERS.area, pages: [{ ...overview, state: 'behind', words: billing.words, changes }] };
    const text = textOf(await getDocs({ overview: true }));
    expect(text).toContain('  Areas added: src/ledger; removed: src/legacy.');
    expect(text).toContain('  Layers added: ledger; removed: none.');
  });

  it('counts one file, one symbol and one dependent in the singular', async () => {
    const [billing = {}] = pagesOf(DOCS_ANSWERS.area);
    const facts = billing.facts as { mostDepended: { items: { dependents: number }[] } };
    const [first] = facts.mostDepended.items;
    app.docsAnswer = { ...DOCS_ANSWERS.area, pages: [{ ...billing, facts: { ...facts, files: 1, symbols: 1, mostDepended: { items: [{ ...first, dependents: 1 }], total: 1 } } }] };
    const text = textOf(await getDocs({ areas: ['src/billing'] }));
    expect(text).toContain('folder src/billing; 1 file, 1 symbol;');
    expect(text).toContain('roundCents (src/billing/money.ts:1): 1 dependent.');
  });

  it("names the project in its steps when it is not the current one, so the next batch and the words go to it", async () => {
    app.docsAnswer = DOCS_ANSWERS.all;
    const result = await getDocs({ all: true, repo: 'webshop' });
    expect(result.structuredContent).toMatchObject({ next: expect.stringMatching(/^For webshop, pass repo "webshop" to each tool\. Write the words of /) });
    expect(textOf(result)).toContain('Next: For webshop, pass repo "webshop" to each tool. Write the words of');
  });

  it('asks for named pages and the Overview together', async () => {
    await getDocs({ areas: ['src/billing', 'src/jobs'], overview: true });
    expect(docsAsked()).toEqual([`/docs?${new URLSearchParams([['repoPath', project], ['area', 'src/billing'], ['area', 'src/jobs'], ['overview', 'true']])}`]);
  });

  it('says when no page is asked for, with no step to take', async () => {
    app.docsAnswer = { ...DOCS_ANSWERS.session, pages: [] };
    const none = await getDocs({});
    expect(textOf(none)).toBe("The latest AI session in webshop changed no area whose docs page needs words.");
    expect(none.structuredContent).not.toHaveProperty('next');
    app.docsAnswer = { ...DOCS_ANSWERS.all, pages: [], next: null };
    expect(textOf(await getDocs({ all: true }))).toBe("Every page of webshop's map has words.");
  });

  it('refuses all with areas, and says what the app answers while it counts', async () => {
    await expect(getDocs({ all: true, areas: ['src/billing'] })).rejects.toThrow('Ask for all, or name areas and the overview: not both.');
    await expect(getDocs({ more: { after: 6, map: 'm' }, overview: true })).rejects.toThrow('Ask for all, or name areas and the overview: not both.');
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

  it("leaves out a page past the app's rules for words, with why, and sends the others", async () => {
    const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
    const result = await writeDocs(
      {
        head: HEAD,
        pages: [
          { area: 'src/billing', summary: 'x'.repeat(201), body: ['Charges cards.'] },
          { area: 'src/api', summary: 'Routes requests.', body: [[{ ...link, area: 'src/api' }]] },
          { area: 'src/jobs', summary: 'Retries charges.', body: [[], ''] },
          // A paragraph ends its last word; pieces join without a space, as the app reads them
          { area: 'src/admin', summary: 'Admin tools.', body: [words(200), [{ text: words(199) }, { text: ' ' }, { text: 'last', area: 'src/jobs' }], 'over'] },
          { overview: true, summary: '  A small webshop.  ', body: [words(200), [{ text: words(199) }, { text: ' ' }, { text: 'last', area: 'src/jobs' }]] },
        ],
      },
      'Claude Code',
    );
    const [sent] = app.requestsTo('/docs') as { pages: object[] }[];
    expect(sent?.pages).toEqual([{ overview: true, words: { summary: 'A small webshop.', body: [[{ text: words(200) }], [{ text: words(199) }, { text: ' ' }, { text: 'last', area: 'src/jobs' }]] } }]);
    expect(textOf(result)).toBe(
      'ShadowGit keeps your words for the Overview, at snapshot f62bdb89. Left out: src/billing: summary: at most 200 characters; src/api: body.0.0: links a symbol or an area, not both; src/jobs: body.0: a paragraph has pieces; body.1.0.text: a piece has text; src/admin: the body has 401 words: write at most 400.',
    );
    expect(result.structuredContent).toMatchObject({ pages: [{ page: { overview: true }, kept: true }, { page: { area: 'src/billing' }, kept: false }, {}, {}, {}] });
    expect(textOf(result)).not.toMatch(JUDGING);
  });

  it('sends nothing when every page is left out', async () => {
    const result = await writeDocs({ head: HEAD, pages: [{ area: 'src/billing', summary: '   ', body: ['Charges cards.'] }] }, 'Claude Code');
    expect(app.requests).toEqual([]);
    expect(textOf(result)).toBe('ShadowGit kept no words. Left out: src/billing: summary: one sentence, not empty.');
  });

  it('both tools say an app without docs needs updating', async () => {
    app.docsRoutes = false;
    await expect(getDocs({})).rejects.toThrow(APP_WITHOUT_DOCS);
    await expect(writeDocs({ head: HEAD, pages: [{ overview: true, holds: true }] }, 'Claude Code')).rejects.toThrow(APP_WITHOUT_DOCS);
  });
});
