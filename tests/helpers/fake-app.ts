import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeSession {
  id: string;
  repoPath: string;
  description: string;
  /** As the app's SQLite writes it: UTC, a space, no zone. */
  startedAt: string;
}

export interface FakeApp {
  url: string;
  /** Every request, with its path relative to /api. */
  requests: { path: string; body: Record<string, unknown> }[];
  sessions: FakeSession[];
  /** 200 commits; 409 has nothing to commit; 404 is an app without the route; 500 is a crash page. */
  checkpointStatus: 200 | 404 | 409 | 500;
  close(): Promise<void>;
}

/** A stand-in for the ShadowGit app's Session API on an ephemeral port; points SHADOWGIT_SESSION_API at it. */
export async function startFakeApp(): Promise<FakeApp> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let nextId = 1;
  const app: FakeApp = {
    url: `http://127.0.0.1:${port}/api`,
    requests: [],
    sessions: [],
    checkpointStatus: 200,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  server.on('request', async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body: Record<string, unknown> = text ? JSON.parse(text) : {};
    const route = (req.url ?? '').replace(/^\/api/, '');
    app.requests.push({ path: route, body });
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
      app.sessions.push({ id, repoPath: String(body.repoPath), description: String(body.description), startedAt: '2026-10-08 10:00:00' });
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
    json(404, { success: false, error: `No route ${route}` });
  });

  process.env.SHADOWGIT_SESSION_API = app.url;
  return app;
}
