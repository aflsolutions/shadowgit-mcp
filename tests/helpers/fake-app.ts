import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { LensRead } from '../../src/session-api.js';
import { shadowGit } from './fixtures.js';

export interface FakeSession {
  id: string;
  repoPath: string;
  description: string;
  /** As the app's SQLite writes it: UTC, a space, no zone. */
  startedAt: string;
}

/** A session as the app lists it; the overrides say which project and what it is about. */
export function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return { id: 'claude-code-1', repoPath: '/projects/webshop', description: 'Fix login', startedAt: '2026-10-08 10:00:00', ...overrides };
}

export interface FakeApp {
  url: string;
  /** Every request, with its path relative to /api. */
  requests: { path: string; body: Record<string, unknown> }[];
  /** The bodies of the requests to one route, in order. */
  requestsTo(route: string): Record<string, unknown>[];
  sessions: FakeSession[];
  /** 200 commits; 409 has nothing to commit; 404 is an app without the route; 500 is a crash page. */
  checkpointStatus: 200 | 404 | 409 | 500;
  /**
   * A project whose checkpoints are real, as the app's are: one commits the project's files into its history and
   * answers that commit, or 409 when nothing changed. Null answers a canned commit.
   */
  checkpointsIn: string | null;
  /** The check a 200 checkpoint answers beside its commit, as an app that checks rules sends it; null sends none. */
  checkpointRules: object | null;
  /** False is an app without the Lens routes: they answer the catch-all 404. */
  lensRoutes: boolean;
  /** What GET /lens answers: a range, and its lens or null for a range that changes no code. */
  lensAnswer: { range: { base: string | null; head: string }; lens: typeof FAKE_LENS | null };
  /** 200 keeps the words; 400 is an app older than linked words refusing them; 409 is a range that changes no code. */
  wordsStatus: 200 | 400 | 409;
  /** False is an app without the map routes: they answer the catch-all 404. */
  mapRoutes: boolean;
  /** 200 answers `mapAnswer`; 202 is a map still drawing; 409 a project with no snapshot; 500 a build that failed. */
  mapStatus: 200 | 202 | 409 | 500;
  /** The bodies the map routes answer: GET /map without an area, with one, and POST /map/context. */
  mapAnswer: { map: object; area: object; context: object };
  /** A body that answers a route (its path, without the query) with 200 in place of its usual one: a newer app's shape. */
  answers: Partial<Record<string, object>>;
  /** Leaves every request unanswered, like an app busy with a large project. */
  hang: boolean;
  /** Sends the headers and part of the body, then never ends it, like an app that stalls mid-answer. */
  hangBody: boolean;
  close(): Promise<void>;
}

export const FAKE_RANGE = { base: 'b'.repeat(40), head: 'c'.repeat(40) };
export const FAKE_LIMITS = { summary: 400, stepTitle: 60, stepBody: 280, role: 120, layerName: 24, flowLabel: 32 };
/** A lens of one step as GET /api/lens answers it: a retry queue over chargeCard, offline words. */
export const FAKE_LENS = {
  title: 'This AI session',
  words: { source: 'offline', author: null },
  summary: null as string | null,
  steps: [{ id: 'c1', title: 'Add RetryQueue', body: null, components: ['k1', 'k2'], files: ['src/retry-queue.ts'], diff: '+export class RetryQueue {}' }],
  components: [
    { id: 'k1', name: 'RetryQueue', kind: 'class', delta: 'added', context: false, role: null, path: 'src/retry-queue.ts', symbols: ['RetryQueue', 'RetryQueue.retry'] },
    { id: 'k2', name: 'chargeCard', kind: 'function', delta: 'unchanged', context: true, role: null, path: 'src/charge.ts', symbols: ['chargeCard'] },
  ],
  layers: [{ id: 'code', name: 'Code' }],
  flows: [{ id: 'f1', from: 'k1', to: 'k2', label: 'chargeCard()' }],
};

/** The lens as an app that cites its evidence answers it: the range's checkpoint quotes, each step's symbols with their lines. */
export const FAKE_CITED_LENS = {
  ...FAKE_LENS,
  quotes: ['Retry failed charges'],
  steps: FAKE_LENS.steps.map((step) => ({
    ...step,
    symbols: [
      { name: 'ProjectIndex.familyOf', path: 'src/project.ts', basePath: null, base: null, head: { start: 12, end: 40 } },
      { name: 'chargeCard', path: 'src/charge.ts', basePath: 'src/old-charge.ts', base: { start: 2, end: 8 }, head: { start: 2, end: 10 } },
    ],
  })),
};

const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
// Without the success the app sends beside each answer: the map routes add it, as the Lens route does
const withoutSuccess = (answer: Record<string, unknown>): object => {
  delete answer.success;
  return answer;
};
const mapFixture = (name: string) => withoutSuccess(fixture(`map/${name}`));
/**
 * The app's real answers for the webshop of `tests/fixtures/map/project.json`: its summary, its billing area,
 * chargeCard's context, chargeCard with checkout, targets that don't resolve, and src/billing/charge.ts.
 */
export const MAP_ANSWERS = {
  summary: mapFixture('summary'),
  area: mapFixture('area'),
  context: mapFixture('context'),
  landing: mapFixture('landing'),
  unresolved: mapFixture('unresolved'),
  file: mapFixture('file'),
  // The Lens eval's project: checkout, its file and a file not written yet, and its summary
  checkoutSymbol: mapFixture('checkout-symbol'),
  checkoutFiles: mapFixture('checkout-files'),
  checkoutSummary: mapFixture('checkout-summary'),
};
/** The webshop the map answers are of: path → content. */
export const MAP_PROJECT = JSON.parse(readFileSync(new URL('../fixtures/map/project.json', import.meta.url), 'utf8')) as Record<string, string>;
/** The real app's GET /api/lens body for a session that makes the webshop's jobs depend on api. */
export const LENS_ANSWER_WITH_FACTS = JSON.parse(readFileSync(new URL('../fixtures/lens/dependencies.json', import.meta.url), 'utf8')) as object;
const captured = LensRead.parse(LENS_ANSWER_WITH_FACTS).lens;
if (captured?.dependencies === undefined) throw new Error('tests/fixtures/lens/dependencies.json holds no dependency facts');
/** FAKE_LENS with the facts the real app drew in that answer, its step holding them as the app's step did. */
export const FAKE_FACTS_LENS = {
  ...FAKE_LENS,
  dependencies: captured.dependencies,
  steps: FAKE_LENS.steps.map((step) => ({ ...step, dependencies: captured.steps[0]?.dependencies ?? [] })),
};
/**
 * The real app's answers for the webshop of `tests/fixtures/rules/project.json`, whose .shadowgit-rules reads
 * "src/jobs never depends on src/api because jobs read the database through src/db": its summary, the context of
 * src/jobs/report.ts and src/api/users.ts, a session's checkpoint and Lens that make report.ts import api's countUsers
 * (as sent, with success), and the Lens of a session that adds a rule alone.
 */
export const RULES_ANSWERS = {
  summary: withoutSuccess(fixture('rules/summary')),
  context: withoutSuccess(fixture('rules/context')),
  checkpoint: fixture('rules/checkpoint'),
  lens: fixture('rules/lens'),
  rulesOnly: fixture('rules/rules-only'),
};
/** The webshop the rules answers are of, its .shadowgit-rules included: path → content. */
export const RULES_PROJECT = fixture('rules/project') as Record<string, string>;
/** What the map routes answer by default: the summary, the billing area, and chargeCard's context. */
export const mapAnswers = () => ({ map: MAP_ANSWERS.summary, area: MAP_ANSWERS.area, context: MAP_ANSWERS.context });

/** A stand-in for the ShadowGit app's Session API on an ephemeral port; points SHADOWGIT_SESSION_API at it. */
export async function startFakeApp(): Promise<FakeApp> {
  const app = await listen();
  process.env.SHADOWGIT_SESSION_API = app.url;
  return app;
}

/** The URL of an app that is not running: a port that answered a moment ago and no longer does. Leaves process.env alone. */
export async function closedAppUrl(): Promise<string> {
  const stopped = await listen();
  await stopped.close();
  return stopped.url;
}

async function listen(): Promise<FakeApp> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let nextId = 1;
  const app: FakeApp = {
    url: `http://127.0.0.1:${port}/api`,
    requests: [],
    requestsTo: (route) => app.requests.filter((r) => r.path === route).map((r) => r.body),
    sessions: [],
    checkpointStatus: 200,
    checkpointsIn: null,
    checkpointRules: null,
    lensRoutes: true,
    lensAnswer: { range: FAKE_RANGE, lens: FAKE_LENS },
    answers: {},
    wordsStatus: 200,
    mapRoutes: true,
    mapStatus: 200,
    mapAnswer: mapAnswers(),
    hang: false,
    hangBody: false,
    close: () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // A hung request keeps its connection open, and close() waits for every connection.
      server.closeAllConnections();
      return closed;
    },
  };

  server.on('request', async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body: Record<string, unknown> = text ? JSON.parse(text) : {};
    const route = (req.url ?? '').replace(/^\/api/, '');
    app.requests.push({ path: route, body });
    if (app.hang) return;
    if (app.hangBody) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"sessions":[');
      return;
    }
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const page = (status: number, html: string) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(html);
    };

    const answer = app.answers[route.split('?')[0] ?? route];
    if (answer !== undefined) return json(200, answer);
    if (route === '/session/active') {
      return json(200, { success: true, sessions: app.sessions.map((s) => ({ ...s, aiTool: 'test', duration: 0 })) });
    }
    if (route === '/session/start') {
      const id = `${String(body.aiTool).toLowerCase().replace(/\s+/g, '-')}-${nextId++}`;
      app.sessions.push(fakeSession({ id, repoPath: String(body.repoPath), description: String(body.description) }));
      return json(200, { success: true, sessionId: id });
    }
    if (route === '/session/end') {
      app.sessions = app.sessions.filter((s) => s.id !== body.sessionId);
      return json(200, { success: true });
    }
    if (route === '/checkpoint') {
      if (app.checkpointStatus === 404) return page(404, '<pre>Cannot POST /api/checkpoint</pre>');
      if (app.checkpointStatus === 409) return json(409, { success: false, error: 'No changes to commit' });
      if (app.checkpointStatus === 500) return page(500, '<h1>Internal Server Error</h1>');
      // Read once the commit is made: a check of the project reads its new HEAD
      const rules = () => (app.checkpointRules === null ? {} : { rules: app.checkpointRules });
      if (app.checkpointsIn === null) return json(200, { success: true, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', filesChanged: 2, ...rules() });
      shadowGit(app.checkpointsIn, ['add', '-A']);
      const changed = shadowGit(app.checkpointsIn, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      if (changed.length === 0) return json(409, { success: false, error: 'No changes to commit' });
      shadowGit(app.checkpointsIn, ['commit', '--quiet', '-m', String(body.title)]);
      return json(200, { success: true, commit: shadowGit(app.checkpointsIn, ['rev-parse', 'HEAD']), filesChanged: changed.length, ...rules() });
    }
    if (app.lensRoutes && route.startsWith('/lens?')) return json(200, { success: true, ...app.lensAnswer, limits: FAKE_LIMITS });
    if (app.lensRoutes && route === '/lens/words') {
      if (app.wordsStatus === 409) return json(409, { success: false, error: 'Nothing in this range changes code: it has no lens to word' });
      if (app.wordsStatus === 400) return json(400, { success: false, error: "Not the Lens's words: ✖ Invalid input: expected string, received array\n  → at steps[0].body" });
      return json(200, { success: true, applied: { summary: true, steps: 1, components: 1, layers: 0, flows: 0 }, ignored: ['c99'] });
    }
    if (app.mapRoutes && (route.startsWith('/map?') || route === '/map/context')) {
      if (app.mapStatus === 202) return json(202, { success: false, error: "ShadowGit is drawing this project's map; ask again in a minute" });
      if (app.mapStatus === 409) return json(409, { success: false, error: 'This project has no snapshot yet' });
      if (app.mapStatus === 500) return json(500, { success: false, error: 'The map stopped before answering (exit code 1)' });
      if (route === '/map/context') {
        // The app's own refusal: 1 to 20 files and symbols
        const asked = [body.files, body.symbols].reduce((sum: number, targets) => sum + (Array.isArray(targets) ? targets.length : 0), 0);
        if (asked < 1 || asked > 20) return json(400, { success: false, error: `Ask about 1 to 20 files and symbols, not ${asked}` });
        return json(200, { success: true, ...app.mapAnswer.context });
      }
      return json(200, { success: true, ...(new URLSearchParams(route.slice('/map?'.length)).has('area') ? app.mapAnswer.area : app.mapAnswer.map) });
    }
    json(404, { success: false, error: `No route ${route}` });
  });

  return app;
}
