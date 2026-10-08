import { CLIENT_INFO_META_KEY, McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { clientName } from '../src/client-name.js';
import { checkpoint } from '../src/tools/checkpoint.js';
import { endSession } from '../src/tools/end-session.js';
import { startSession } from '../src/tools/start-session.js';
import { closedAppUrl, fakeSession, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { makeProject, removeTempDirs, restoreEnv, tempDir, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let other: string;
let app: FakeApp;

beforeAll(async () => {
  project = makeProject('webshop');
  other = makeProject('blog');
  useStorage([{ name: 'webshop', path: project }, { name: 'blog', path: other }]);
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
  app.sessions.length = 0;
  app.checkpointStatus = 200;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('clientName', () => {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  // The tool only reads ctx.mcpReq.envelope; building the rest of a ServerContext would say nothing.
  const requestFrom = (info: unknown) => ({ mcpReq: { envelope: { [CLIENT_INFO_META_KEY]: info } } }) as unknown as ServerContext;

  it('prefers the title of the client in the request envelope', () => {
    expect(clientName(server, requestFrom({ name: 'claude-code', title: 'Claude Code' }))).toBe('Claude Code');
  });

  it('uses the name when the title is missing or blank', () => {
    expect(clientName(server, requestFrom({ name: 'cursor' }))).toBe('cursor');
    expect(clientName(server, requestFrom({ name: 'cursor', title: '  ' }))).toBe('cursor');
  });

  it('falls back to a generic name when the client names itself blank or not at all', () => {
    expect(clientName(server, requestFrom({ name: ' ', title: ' ' }))).toBe('AI assistant');
    expect(clientName(server, requestFrom(undefined))).toBe('AI assistant');
  });
});

describe('start_session', () => {
  it('starts a session on the current project, named after the client', async () => {
    const result = await startSession({ description: 'Fix login' }, 'Claude Code');
    expect(result.structuredContent).toEqual({ session_id: expect.stringMatching(/^claude-code-\d+$/), repo: 'webshop', already_active: false });
    expect(app.requests.at(-1)).toEqual({
      path: '/session/start', body: { repoPath: project, description: 'Fix login', aiTool: 'Claude Code' },
    });
  });

  it('returns the session already active instead of starting a second one', async () => {
    app.sessions.push(fakeSession({ id: 'cursor-9', repoPath: project, description: 'Other work' }));
    const result = await startSession({ description: 'Fix login' }, 'Claude Code');
    expect(result.structuredContent).toEqual({ session_id: 'cursor-9', repo: 'webshop', already_active: true });
    expect(app.requestsTo('/session/start')).toEqual([]);
  });

  it('says the app is not running when nothing answers', async () => {
    vi.stubEnv('SHADOWGIT_SESSION_API', await closedAppUrl());
    await expect(startSession({ description: 'Fix login' }, 'Claude Code')).rejects.toThrow("ShadowGit isn't running");
  });
});

describe('checkpoint', () => {
  it('asks the app to commit, with the client as author', async () => {
    const result = await checkpoint({ title: 'Fix login redirect', message: 'Loop on expired tokens.' }, 'Claude Code');
    expect(result.structuredContent).toEqual({
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', title: 'Fix login redirect', files_changed: 2, repo: 'webshop',
    });
    expect(app.requests.at(-1)).toEqual({
      path: '/checkpoint',
      body: { repoPath: project, title: 'Fix login redirect', message: 'Loop on expired tokens.', author: 'Claude Code' },
    });
  });

  it('reports nothing to checkpoint as a result, not an error', async () => {
    app.checkpointStatus = 409;
    const result = await checkpoint({ title: 'Nothing' }, 'Claude Code');
    expect(result.structuredContent).toEqual({ commit: null, title: 'Nothing', files_changed: 0, repo: 'webshop' });
    expect(textOf(result)).toBe('No changes since the last snapshot; nothing to checkpoint.');
    expect(app.requests.at(-1)?.body).not.toHaveProperty('message');
  });

  it('asks for an app update when the route is missing', async () => {
    app.checkpointStatus = 404;
    await expect(checkpoint({ title: 'Fix' }, 'Claude Code')).rejects.toThrow("can't create checkpoints for AI assistants");
  });

  it('names the HTTP status when the app fails without JSON', async () => {
    app.checkpointStatus = 500;
    await expect(checkpoint({ title: 'Fix' }, 'Claude Code')).rejects.toThrow('ShadowGit answered HTTP 500.');
  });
});

describe('end_session', () => {
  it('ends the active session of the current project without an id', async () => {
    app.sessions.push(fakeSession({ id: 'claude-code-7', repoPath: project }));
    const result = await endSession({});
    expect(result.structuredContent).toEqual({ ended: ['claude-code-7'], repo: 'webshop' });
    expect(app.requests.at(-1)).toEqual({ path: '/session/end', body: { sessionId: 'claude-code-7' } });
  });

  it('succeeds with nothing to do when no session is active', async () => {
    const result = await endSession({});
    expect(result.structuredContent).toEqual({ ended: [], repo: 'webshop' });
    expect(textOf(result)).toBe('No active session; automatic snapshots are already on.');
  });

  it('ends a session by id on another project without resolving the current one', async () => {
    app.sessions.push(fakeSession({ id: 'cursor-2', repoPath: other, description: 'Blog post' }));
    process.env.CLAUDE_PROJECT_DIR = tempDir('nowhere');
    const result = await endSession({ session_id: 'cursor-2' });
    expect(result.structuredContent).toEqual({ ended: ['cursor-2'], repo: 'blog' });
  });

  it('ends nothing for an id that is not active', async () => {
    const result = await endSession({ session_id: 'claude-code-404' });
    expect(result.structuredContent).toEqual({ ended: [], repo: null });
    expect(app.requestsTo('/session/end')).toEqual([]);
  });
});
