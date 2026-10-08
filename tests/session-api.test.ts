import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import {
  AppNotRunningError, activeSessions, createCheckpoint, endSession, startSession,
} from '../src/session-api.js';
import { startFakeApp, type FakeApp } from './helpers/fake-app.js';

let app: FakeApp;
const savedEnv = { TZ: process.env.TZ, SHADOWGIT_SESSION_API: process.env.SHADOWGIT_SESSION_API };

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  process.env.TZ = 'Europe/Paris';
  app = await startFakeApp();
});

afterAll(async () => {
  restoreEnv();
  await app.close();
});

beforeEach(() => {
  process.env.SHADOWGIT_SESSION_API = app.url;
  app.sessions.length = 0;
  app.checkpointStatus = 200;
  app.hang = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const checkpointInput = { repoPath: '/projects/webshop', title: 'Fix login', author: 'Claude Code' };

describe('sessions', () => {
  it('starts, lists in local time, and ends a session', async () => {
    const id = await startSession('/projects/webshop', 'Fix login', 'Claude Code');
    expect(id).toBe('claude-code-1');
    expect(await activeSessions()).toEqual([
      { id, repoPath: '/projects/webshop', description: 'Fix login', startedAt: '2026-10-08T12:00:00+02:00' },
    ]);
    await endSession(id);
    expect(await activeSessions()).toEqual([]);
  });

  it('reports an app that does not answer as AppNotRunningError', async () => {
    const stopped = await startFakeApp();
    await stopped.close();
    await expect(activeSessions()).rejects.toBeInstanceOf(AppNotRunningError);
    await expect(activeSessions()).rejects.toThrow("ShadowGit isn't running: nothing answered on localhost:45289.");
  });

  it('says the app did not answer, not that it is not running, when a request times out', async () => {
    app.hang = true;
    const error = await activeSessions().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AppNotRunningError);
    expect(error).toHaveProperty('message', 'ShadowGit did not answer within 3 s.');
  });
});

describe('createCheckpoint', () => {
  it('returns the commit and the number of files', async () => {
    expect(await createCheckpoint(checkpointInput)).toEqual({ commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', filesChanged: 2 });
  });

  it('returns no commit when nothing changed', async () => {
    app.checkpointStatus = 409;
    expect(await createCheckpoint(checkpointInput)).toEqual({ commit: null, filesChanged: 0 });
  });

  it('asks for an app update when the route is missing', async () => {
    app.checkpointStatus = 404;
    await expect(createCheckpoint(checkpointInput)).rejects.toThrow(
      "This version of ShadowGit can't create checkpoints for AI assistants. Ask the user to update the ShadowGit app.",
    );
  });

  it('names the HTTP status when the app fails without JSON', async () => {
    app.checkpointStatus = 500;
    await expect(createCheckpoint(checkpointInput)).rejects.toThrow('ShadowGit answered HTTP 500.');
  });

  it('warns that the checkpoint may still be saving when the app does not answer', async () => {
    app.hang = true;
    // Stands in for the 55 s wait: the real timeout is replaced by a 50 ms one, which fails the same way.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(50));
    await expect(createCheckpoint(checkpointInput)).rejects.toThrow(
      'ShadowGit did not answer within 55 s; the checkpoint may still be saving. Check with git_command (log -1) before trying again.',
    );
  });
});
