import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import {
  AppNotRunningError, AppTimeoutError, LensRead, activeSessions, createCheckpoint, endSession, readArea, readCodeContext, readLens, readMap, sendLensWords, startSession,
} from '../src/session-api.js';
import { FAKE_CITED_LENS, FAKE_LENS, FAKE_LIMITS, FAKE_RANGE, LENS_ANSWER_WITH_FACTS, MAP_ANSWERS, closedAppUrl, mapAnswers, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { restoreEnv } from './helpers/fixtures.js';

let app: FakeApp;

beforeAll(async () => {
  process.env.TZ = 'Europe/Paris';
  app = await startFakeApp();
});

afterAll(async () => {
  restoreEnv();
  await app.close();
});

beforeEach(() => {
  app.sessions.length = 0;
  app.checkpointStatus = 200;
  app.hang = false;
  app.hangBody = false;
  app.answers = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it('reports an app that does not answer as AppNotRunningError, naming the endpoint it asked', async () => {
    const closed = await closedAppUrl();
    vi.stubEnv('SHADOWGIT_SESSION_API', closed);
    await expect(activeSessions()).rejects.toBeInstanceOf(AppNotRunningError);
    await expect(activeSessions()).rejects.toThrow(`ShadowGit isn't running: nothing answered on ${new URL(closed).host}. Ask the user to open`);
  });

  it('names localhost:45289 when SHADOWGIT_SESSION_API is not set', () => {
    vi.stubEnv('SHADOWGIT_SESSION_API', undefined);
    expect(new AppNotRunningError().message).toBe(
      "ShadowGit isn't running: nothing answered on localhost:45289. Ask the user to open the ShadowGit app, then try again. Reading history with git_command still works.",
    );
  });

  it.each(['', 'nonsense', 'user:secret@localhost:45289/api', 'http://user:secret@/api'])(
    'names the variable, not its value, when SHADOWGIT_SESSION_API %j has no host',
    async (value) => {
      vi.stubEnv('SHADOWGIT_SESSION_API', value);
      await expect(activeSessions()).rejects.toThrow(
        "ShadowGit isn't running: nothing answered on the address in SHADOWGIT_SESSION_API. Ask the user to open",
      );
    },
  );

  it('says the app did not answer, not that it is not running, when a request times out', async () => {
    app.hang = true;
    const error = await activeSessions().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(AppNotRunningError);
    expect(error).toBeInstanceOf(AppTimeoutError);
    expect(error).toHaveProperty(
      'message',
      'ShadowGit did not answer within 3 s. The app may be busy with a large project; try again in a moment.',
    );
  });
});

describe('the lens an app answers', () => {
  it('reads a skeleton from an app that cites no evidence, and one that does', () => {
    expect(LensRead.parse({ range: FAKE_RANGE, lens: FAKE_LENS, limits: FAKE_LIMITS }).lens?.steps[0]?.symbols).toBeUndefined();
    const cited = LensRead.parse({ range: FAKE_RANGE, lens: FAKE_CITED_LENS, limits: FAKE_LIMITS }).lens;
    expect(cited?.quotes).toEqual(['Retry failed charges']);
    expect(cited?.steps[0]?.symbols?.[0]).toEqual({ name: 'ProjectIndex.familyOf', path: 'src/project.ts', basePath: null, base: null, head: { start: 12, end: 40 } });
  });

  it('reads a real lens answer with its dependency facts', () => {
    const lens = LensRead.parse(LENS_ANSWER_WITH_FACTS).lens;
    const [fact] = lens?.dependencies?.facts ?? [];
    expect(fact).toMatchObject({ sentence: 'jobs depends on api for the first time', level: 'area', kind: 'new', from: { label: 'jobs', path: 'src/jobs' }, to: { label: 'api', path: 'src/api' }, steps: ['c1'] });
    expect(fact?.evidence).toContain('src/jobs/report.ts imports src/api/users.ts');
    expect(lens?.steps[0]?.dependencies).toEqual(['jobs depends on api for the first time']);
  });
});

describe('an answer of a shape this version does not read', () => {
  const update = (what: string) => `ShadowGit answered with a ${what} this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server.`;

  it('asks for a server update from every reader, not a parse error', async () => {
    app.answers = {
      '/session/active': { success: true, sessions: 'none' },
      '/session/start': { success: true },
      '/checkpoint': { success: true, commit: 5 },
      '/lens': { success: true, range: FAKE_RANGE, lens: { ...FAKE_LENS, steps: 'none' }, limits: FAKE_LIMITS },
      '/lens/words': { success: true, applied: null },
    };
    await expect(activeSessions()).rejects.toThrow(update('session'));
    await expect(startSession('/projects/webshop', 'Fix login', 'Claude Code')).rejects.toThrow(update('session'));
    await expect(createCheckpoint(checkpointInput)).rejects.toThrow(update('checkpoint'));
    await expect(readLens({ repoPath: '/projects/webshop' })).rejects.toThrow(update('lens'));
    await expect(sendLensWords({ repoPath: '/projects/webshop', base: null, head: FAKE_RANGE.head, author: 'Claude Code', words: {} })).rejects.toThrow(update('lens'));
  });
});

describe('a body that never ends', () => {
  it('times out like an app that does not answer at all, not with a raw TimeoutError', async () => {
    app.hangBody = true;
    const error = await activeSessions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppTimeoutError);
    expect(error).toHaveProperty('message', expect.stringMatching(/^ShadowGit did not answer within 3 s\./));
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
    // Stands in for the 58 s wait: the real timeout is replaced by a 50 ms one, which fails the same way.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(50));
    await expect(createCheckpoint(checkpointInput)).rejects.toThrow(
      'ShadowGit did not answer within 58 s; the checkpoint may still be saving. Check with git_command (log -1) before trying again.',
    );
  });
});

describe('the map', () => {
  const ask = { repoPath: '/projects/webshop', aiTool: 'Claude Code' };
  const context = { ...ask, files: ['src/gone.ts'], symbols: [{ name: 'chargeCard' }] };

  beforeEach(() => {
    app.requests.length = 0;
    app.mapRoutes = true;
    app.mapStatus = 200;
    app.mapAnswer = mapAnswers();
  });

  it("reads the project's summary, and one area by its label, naming the assistant", async () => {
    expect(await readMap(ask)).toEqual(MAP_ANSWERS.summary);
    expect(app.requests.at(-1)?.path).toBe(`/map?${new URLSearchParams(ask)}`);
    expect(await readArea({ ...ask, area: 'billing' })).toEqual(MAP_ANSWERS.area);
    expect(app.requests.at(-1)?.path).toBe(`/map?${new URLSearchParams({ repoPath: ask.repoPath, area: 'billing', aiTool: ask.aiTool })}`);
    app.mapAnswer.map = MAP_ANSWERS.checkoutSummary;
    expect(await readMap(ask)).toEqual(MAP_ANSWERS.checkoutSummary);
  });

  it.each(['context', 'landing', 'unresolved', 'file', 'checkoutSymbol', 'checkoutFiles'] as const)('reads every field of the code context the app answered (%s)', async (name) => {
    app.mapAnswer.context = MAP_ANSWERS[name];
    expect(await readCodeContext(context)).toEqual(MAP_ANSWERS[name]);
    expect(app.requestsTo('/map/context').at(-1)).toEqual(context);
  });

  it.each([
    [202, "ShadowGit: ShadowGit is drawing this project's map; ask again in a minute"],
    [409, 'ShadowGit: This project has no snapshot yet'],
    [500, 'ShadowGit: The map stopped before answering (exit code 1)'],
  ] as const)("passes the app's own words on for a %i", async (status, message) => {
    app.mapStatus = status;
    await expect(readMap(ask)).rejects.toThrow(message);
    await expect(readCodeContext(context)).rejects.toThrow(message);
  });

  it('asks for an app update when the map routes are missing', async () => {
    app.mapRoutes = false;
    const update = 'This version of ShadowGit has no map for AI assistants. Ask the user to update the ShadowGit app.';
    await expect(readMap(ask)).rejects.toThrow(update);
    await expect(readCodeContext(context)).rejects.toThrow(update);
  });

  // The app answers 202 once its own 55 s pass: the server waits past that, so the app's sentence reaches the agent
  it('waits up to 58 s, past the 55 s the app may draw the map for', async () => {
    app.hang = true;
    // Stands in for the 58 s wait: the real timeout is replaced by a 50 ms one, which fails the same way.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const asked = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(50));
    await expect(readCodeContext(context)).rejects.toThrow('ShadowGit did not answer within 58 s.');
    expect(asked).toHaveBeenCalledWith(58_000);
  });

  it('reads the values a newer app may add to a list it names, as they come', async () => {
    const newer = JSON.parse(JSON.stringify(MAP_ANSWERS.unresolved).replace('"reason":"absent"', '"reason":"generated"')) as object;
    app.mapAnswer.context = newer;
    expect(await readCodeContext(context)).toEqual(newer);
    const spread = JSON.parse(JSON.stringify(MAP_ANSWERS.context).replace('"how":["calls"]', '"how":["calls","spreads"]')) as object;
    app.mapAnswer.context = spread;
    expect(await readCodeContext(context)).toEqual(spread);
  });

  it('asks for a server update when an answer lacks what was asked for: the summary, or the area', async () => {
    const mapAsOf = { snapshot: 'a'.repeat(40), time: '2026-10-22T10:00:00+02:00', behind: 0, changedFiles: { items: [], total: 0 } };
    app.mapAnswer = { ...mapAnswers(), map: { mapAsOf }, area: { mapAsOf } };
    await expect(readMap(ask)).rejects.toThrow('this version of shadowgit-mcp-server does not read');
    await expect(readArea({ ...ask, area: 'billing' })).rejects.toThrow('this version of shadowgit-mcp-server does not read');
  });

  it('asks for a server update when the app answers with a shape this version does not read', async () => {
    app.mapAnswer.context = JSON.parse(JSON.stringify(MAP_ANSWERS.unresolved).replace('"kind":"ambiguous"', '"kind":"generated"')) as object;
    await expect(readCodeContext(context)).rejects.toThrow(
      'ShadowGit answered with a map this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server.',
    );
  });

  it('says ShadowGit is not running when nothing answers', async () => {
    vi.stubEnv('SHADOWGIT_SESSION_API', await closedAppUrl());
    await expect(readMap(ask)).rejects.toBeInstanceOf(AppNotRunningError);
  });
});
