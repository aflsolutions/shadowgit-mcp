import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getCodeContext, getMap } from '../src/tools/map.js';
import { DOCS_ANSWERS, MAP_ANSWERS, RULES_ANSWERS, mapAnswers, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { JUDGING, makeProject, removeTempDirs, restoreEnv, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let app: FakeApp;

/** The app's answer drawn from an older snapshot: three behind, with 25 files changed since. */
const behind = (body: object) => ({
  ...body,
  mapAsOf: { snapshot: '9db22aff6995f96b23115191533b2162656765e0', time: '2026-10-22T08:46:03+02:00', behind: 3, changedFiles: { items: ['src/a.ts', 'src/b.ts'], total: 25 } },
});

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
  app.mapStatus = 200;
  app.mapAnswer = mapAnswers();
});

describe('get_map', () => {
  it("gives the project's summary: its snapshot, counts, areas, the links between them and its processes", async () => {
    const result = await getMap({}, 'Claude Code');
    expect(app.requests.at(-1)?.path).toBe(`/map?${new URLSearchParams({ repoPath: project, aiTool: 'Claude Code' })}`);
    expect(result.structuredContent).toEqual({ repo: 'webshop', ...MAP_ANSWERS.summary });
    const text = textOf(result);
    expect(text).toContain("webshop's map, drawn from snapshot 9db22aff (2026-10-22T08:46:03+02:00), the newest.");
    expect(text).toContain('19 files, 44 symbols, 3 areas, 33 calls, 13 processes.');
    expect(text).toContain('Layers: api (folder, 7 files), billing (folder, 6 files), jobs (folder, 5 files).');
    expect(text).toContain('- api (src/api): 8 files, 17 symbols; layers api');
    expect(text).toContain('- api → billing: 3 calls and imports');
    expect(text).toContain('- StartServer -> RoundCents: api → billing');
    expect(text).toContain('…and 3 more processes');
  });

  it('gives one area by its label: its files, its symbols most depended on, the areas around it', async () => {
    const text = textOf(await getMap({ area: 'billing' }, 'Claude Code'));
    expect(app.requests.at(-1)?.path).toBe(`/map?${new URLSearchParams({ repoPath: project, area: 'billing', aiTool: 'Claude Code' })}`);
    expect(text).toContain("The billing area of webshop's map, drawn from snapshot 9db22aff");
    expect(text).toContain('6 files, 15 symbols: src/billing/charge.ts, src/billing/discount.ts');
    expect(text).toContain('Most depended on: roundCents (src/billing/money.ts:1): 4 dependents; chargeCard (src/billing/charge.ts:5): 2 dependents');
    expect(text).toContain('Depends on no other area. Depended on by api (3) and jobs (3).');
  });

  it('names an area it does not find, the ones spelled close to it, and how old the map is', async () => {
    app.mapAnswer.area = behind({ ...MAP_ANSWERS.area, area: { kind: 'missing', target: 'bill', near: ['billing'] } });
    const text = textOf(await getMap({ area: 'bill' }, 'Claude Code'));
    expect(text).toContain('No area or folder "bill" on webshop\'s map. Near: billing.');
    // A newer snapshot may hold the area: the answer says the map is behind it
    expect(text).toContain('3 snapshots behind the newest');
  });

  it('says how far behind the newest snapshot its map is, and which files changed since', async () => {
    app.mapAnswer.map = behind(MAP_ANSWERS.summary);
    expect(textOf(await getMap({}, 'Claude Code'))).toContain(
      "webshop's map, drawn from snapshot 9db22aff (2026-10-22T08:46:03+02:00), 3 snapshots behind the newest. 25 files changed since, whose facts may differ: src/a.ts, src/b.ts …and 23 more.",
    );
  });
});

describe('get_code_context', () => {
  it('says where chargeCard sits, what it uses, what depends on it by area, and its reach', async () => {
    const result = await getCodeContext({ symbols: [{ name: 'chargeCard' }] }, 'Claude Code');
    expect(app.requestsTo('/map/context').at(-1)).toEqual({ repoPath: project, symbols: [{ name: 'chargeCard' }], aiTool: 'Claude Code' });
    // The flow that follows, in the answer the model reads before it edits
    expect(result.structuredContent).toEqual({ repo: 'webshop', ...MAP_ANSWERS.context, next: expect.stringMatching(/^Before editing several files: start_session/) });
    const text = textOf(result);
    expect(text).toContain("From webshop's map, drawn from snapshot 9db22aff");
    expect(text).toContain('chargeCard (function, src/billing/charge.ts:5): area billing, layer billing.');
    expect(text).toContain('Uses: recordPayment (src/billing/ledger.ts:3, calls), roundCents (src/billing/money.ts:1, calls).');
    expect(text).toContain('2 depend on chargeCard, from api (1) and jobs (1): checkout (src/api/checkout.ts:5, calls), retryFailedCharges (src/jobs/retry.ts:5, calls).');
    expect(text).toContain('Reach within 3 hops: 4 symbols in 5 files (2, 1 and 1 by hop), from api (4) and jobs (1).');
    expect(text).toContain('Processes: StartServer -> RoundCents, StartServer -> RecordPayment');
  });

  it("names the project in the steps that follow when it is not the current one", async () => {
    const result = await getCodeContext({ symbols: [{ name: 'chargeCard' }], repo: 'webshop' }, 'Claude Code');
    expect(result.structuredContent).toMatchObject({ next: expect.stringMatching(/^For webshop, pass repo "webshop" to each tool\. Before editing several files: start_session/) });
  });

  it('names the project by its path in the steps that follow when another project shares its name', async () => {
    const twin = makeProject('webshop');
    useStorage([{ name: 'webshop', path: project }, { name: 'webshop', path: twin }]);
    try {
      const result = await getCodeContext({ symbols: [{ name: 'chargeCard' }], repo: project }, 'Claude Code');
      expect((result.structuredContent as { next: string }).next).toContain(`pass repo "${project}" to each tool`);
    } finally {
      useStorage([{ name: 'webshop', path: project }]);
    }
  });

  it('says what a file holds, what it imports and what imports it', async () => {
    app.mapAnswer.context = MAP_ANSWERS.file;
    const text = textOf(await getCodeContext({ files: ['src/billing/charge.ts'] }, 'Claude Code'));
    expect(text).toContain('src/billing/charge.ts: area billing, layer billing. Symbols: chargeCard (function, line 5), refundCard (function, line');
    expect(text).toContain('Imports: src/billing/ledger.ts, src/billing/money.ts.');
    expect(text).toContain('Imported by: src/api/checkout.ts, src/jobs/retry.ts; depended on from api (1) and jobs (1).');
  });

  it('says where several targets land together, and what outside them depends on them', async () => {
    app.mapAnswer.context = MAP_ANSWERS.landing;
    const text = textOf(await getCodeContext({ symbols: [{ name: 'chargeCard' }, { name: 'checkout' }] }, 'Claude Code'));
    expect(text).toContain('Where they land: api (1) and billing (1).');
    expect(text).toContain('2 depend on them from outside, from api (1) and jobs (1): route (src/api/router.ts:4, calls), retryFailedCharges (src/jobs/retry.ts:5, calls).');
  });

  it('lists the matches of an ambiguous name and says why a target is not on the map, guessing none', async () => {
    app.mapAnswer.context = MAP_ANSWERS.unresolved;
    const text = textOf(await getCodeContext({ files: ['src/gone.ts', 'src/billing/charge.test.ts'], symbols: [{ name: 'formatAmount' }, { name: 'chargCard' }] }, 'Claude Code'));
    expect(text).toContain('"src/gone.ts" is not on the map: it is not in the map\'s snapshot.');
    expect(text).toContain('"src/billing/charge.test.ts" is not on the map: tests are not on the map.');
    expect(text).toContain('"formatAmount" names 2 symbols: src/api/format.ts:1, src/billing/format.ts:1. Ask again with the file of the one meant.');
    expect(text).toContain('"chargCard" is not on the map. Near: chargeCard.');
  });

  it("passes on a reason a newer app gives as it is", async () => {
    app.mapAnswer.context = JSON.parse(JSON.stringify(MAP_ANSWERS.unresolved).replace('"reason":"absent"', '"reason":"generated"')) as object;
    expect(textOf(await getCodeContext({ files: ['src/gone.ts'] }, 'Claude Code'))).toContain('"src/gone.ts" is not on the map: generated.');
  });

  it.each([[{}, 0], [{ symbols: Array.from({ length: 21 }, () => ({ name: 'chargeCard' })) }, 21]] as const)(
    "passes on the app's refusal of fewer than 1 or more than 20 files and symbols (%#)",
    async (args, count) => {
      await expect(getCodeContext(args, 'Claude Code')).rejects.toThrow(`ShadowGit: Ask about 1 to 20 files and symbols, not ${count}`);
    },
  );

  it('states facts only, within about 4,000 tokens, for every answer the app gave', async () => {
    const answers = [await getMap({}, 'Claude Code'), await getMap({ area: 'billing' }, 'Claude Code')];
    for (const name of ['context', 'landing', 'unresolved', 'file'] as const) {
      app.mapAnswer.context = MAP_ANSWERS[name];
      answers.push(await getCodeContext({ symbols: [{ name: 'chargeCard' }] }, 'Claude Code'));
    }
    for (const result of answers) {
      expect(textOf(result)).not.toMatch(JUDGING);
      expect(textOf(result).length).toBeLessThan(16_000);
      expect(JSON.stringify(result.structuredContent).length).toBeLessThan(16_000);
    }
  });
});

describe('the docs pages on the map', () => {
  const SUMMARY = 'Charges and refunds cards, in cents, and records each payment in the ledger.';

  it("get_map lists each page summary by its area's id, and how far behind its words are", async () => {
    app.mapAnswer.map = DOCS_ANSWERS.mapSummary;
    const result = await getMap({}, 'Claude Code');
    expect(result.structuredContent).toEqual({ repo: 'webshop', ...DOCS_ANSWERS.mapSummary });
    const text = textOf(result);
    expect(text).toContain(`Docs pages (get_docs reads them):\n- src/billing: ${SUMMARY} (1 change since its words)\nLinks between areas`);
    expect(text).not.toMatch(JUDGING);
    const at = (behind: number | null) => ({ ...DOCS_ANSWERS.mapSummary, docs: [{ area: 'src/billing', summary: SUMMARY, behind }] });
    app.mapAnswer.map = at(0);
    expect(textOf(await getMap({}, 'Claude Code'))).toContain(`- src/billing: ${SUMMARY} (current)\n`);
    app.mapAnswer.map = at(null);
    expect(textOf(await getMap({}, 'Claude Code'))).toContain(`- src/billing: ${SUMMARY}\n`);
  });

  it("get_code_context names the pages of its targets' areas", async () => {
    app.mapAnswer.context = DOCS_ANSWERS.context;
    const result = await getCodeContext({ files: ['src/billing/charge.ts'] }, 'Claude Code');
    expect(result.structuredContent).toMatchObject({ docs: [{ area: 'src/billing', label: 'billing', summary: SUMMARY }] });
    const text = textOf(result);
    expect(text).toContain(`\n\nDocs pages of their areas (get_docs reads them):\n- billing (area src/billing): ${SUMMARY}\n\nNext: `);
    expect(text).not.toMatch(JUDGING);
  });

  it('answers as before for an app before docs, and for pages without words', async () => {
    for (const [map, context] of [[MAP_ANSWERS.summary, MAP_ANSWERS.context], [RULES_ANSWERS.summary, RULES_ANSWERS.context], [{ ...DOCS_ANSWERS.mapSummary, docs: [] }, { ...DOCS_ANSWERS.context, docs: [] }]] as const) {
      app.mapAnswer = { ...mapAnswers(), map, context };
      const summary = await getMap({}, 'Claude Code');
      const where = await getCodeContext({ files: ['src/billing/charge.ts'] }, 'Claude Code');
      expect(textOf(summary)).not.toContain('Docs pages');
      expect(textOf(where)).not.toContain('Docs pages');
    }
    expect((await getMap({}, 'Claude Code')).structuredContent).toHaveProperty('docs', []);
    app.mapAnswer = mapAnswers();
    expect((await getMap({}, 'Claude Code')).structuredContent).not.toHaveProperty('docs');
    expect((await getCodeContext({ files: ['src/billing/charge.ts'] }, 'Claude Code')).structuredContent).not.toHaveProperty('docs');
  });
});
