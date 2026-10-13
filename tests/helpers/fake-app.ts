import http from 'node:http';
import type { AddressInfo } from 'node:net';

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
  /** 200 answers; 404 is an app without the Lens routes; 409 is a range that changes no code. */
  lensStatus: 200 | 404 | 409;
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
  summary: null,
  steps: [{ id: 'c1', title: 'Add RetryQueue', body: null, components: ['k1', 'k2'], files: ['src/retry-queue.ts'], diff: '+export class RetryQueue {}' }],
  components: [
    { id: 'k1', name: 'RetryQueue', kind: 'class', delta: 'added', context: false, role: null, path: 'src/retry-queue.ts', symbols: ['RetryQueue', 'RetryQueue.retry'] },
    { id: 'k2', name: 'chargeCard', kind: 'function', delta: 'unchanged', context: true, role: null, path: 'src/charge.ts', symbols: ['chargeCard'] },
  ],
  layers: [{ id: 'code', name: 'Code' }],
  flows: [{ id: 'f1', from: 'k1', to: 'k2', label: 'chargeCard()' }],
};

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
    lensStatus: 200,
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
      return json(200, { success: true, commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', filesChanged: 2 });
    }
    if (route.startsWith('/lens?') || route === '/lens/words') {
      if (app.lensStatus === 404) return json(404, { success: false, error: 'Not found' });
      if (app.lensStatus === 409) return json(409, { success: false, error: 'Nothing in this range changes code: it has no lens to word' });
      if (route === '/lens/words') return json(200, { success: true, applied: { summary: true, steps: 1, components: 1, layers: 0, flows: 0 }, ignored: ['c99'] });
      return json(200, { success: true, range: FAKE_RANGE, lens: FAKE_LENS, limits: FAKE_LIMITS });
    }
    json(404, { success: false, error: `No route ${route}` });
  });

  return app;
}
