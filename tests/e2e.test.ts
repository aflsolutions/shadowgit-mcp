import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { INSTRUCTIONS } from '../src/server.js';
import { ERAS, connect } from './helpers/client.js';
import { fakeSession, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { makeProject, removeTempDirs, restoreEnv, useStorage } from './helpers/fixtures.js';

// The two protocol revisions put "$schema" in different places; key order is not content.
function sortKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

describe.each(ERAS)('protocol $era', ({ era, mode }) => {
  let app: FakeApp;
  let project: string;
  let client: Client;

  beforeAll(async () => {
    project = makeProject('demo', { 'a.txt': 'hello\n' });
    const storage = useStorage([{ name: 'demo', path: project }]);
    app = await startFakeApp();
    client = await connect(mode, { SHADOWGIT_STORAGE_DIR: storage, SHADOWGIT_SESSION_API: app.url, CLAUDE_PROJECT_DIR: project });
  });

  afterAll(async () => {
    await client.close();
    await app.close();
    removeTempDirs();
    restoreEnv();
  });

  it('runs the protocol revision it names', () => {
    expect(client.getProtocolEra()).toBe(era === '2026-07-28' ? 'modern' : 'legacy');
  });

  it('serves the instructions, within 1,250 characters', () => {
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(1250);
  });

  it('lists the five tools exactly as pinned', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_repos', 'git_command', 'start_session', 'checkpoint', 'end_session']);
    await expect(JSON.stringify(tools, sortKeys, 2)).toMatchFileSnapshot('__snapshots__/tool-list.json');
  });

  it('answers every tool, naming the client in what it sends the app', async () => {
    const list = await client.callTool({ name: 'list_repos', arguments: {} });
    expect(list.structuredContent).toMatchObject({ current: 'demo', app_running: true });

    const log = await client.callTool({ name: 'git_command', arguments: { command: 'log --format=%s' } });
    expect(log.content).toEqual([{ type: 'text', text: 'Initial ShadowGit Snapshot\n' }]);

    const start = await client.callTool({ name: 'start_session', arguments: { description: 'e2e' } });
    expect(start.structuredContent).toMatchObject({ repo: 'demo', already_active: false });

    const saved = await client.callTool({ name: 'checkpoint', arguments: { title: 'E2E checkpoint' } });
    expect(saved.structuredContent).toMatchObject({ files_changed: 2, repo: 'demo' });

    const end = await client.callTool({ name: 'end_session', arguments: {} });
    expect(end.structuredContent).toMatchObject({ ended: [expect.any(String)], repo: 'demo' });

    expect(app.requestsTo('/session/start')[0]).toMatchObject({ aiTool: 'shadowgit-e2e', repoPath: project });
    expect(app.requestsTo('/checkpoint')[0]).toMatchObject({ author: 'shadowgit-e2e' });
  });

  it('names the project that has the session when the current one has none', async () => {
    app.sessions.push(fakeSession({ id: 'cursor-9', repoPath: '/projects/elsewhere' }));
    const end = await client.callTool({ name: 'end_session', arguments: {} });
    app.sessions.length = 0;
    expect(end.content).toEqual([{
      type: 'text',
      text: 'No active session on demo; its automatic snapshots are already on. Active elsewhere: /projects/elsewhere (session cursor-9). Pass session_id to end one.',
    }]);
  });

  it('trims a checkpoint title and refuses a blank one', async () => {
    const blank = await client.callTool({ name: 'checkpoint', arguments: { title: '   ' } });
    expect(blank.isError).toBe(true);

    await client.callTool({ name: 'checkpoint', arguments: { title: '  Padded title  ' } });
    expect(app.requestsTo('/checkpoint').at(-1)).toMatchObject({ title: 'Padded title' });
  });

  it('returns a refused git command as a tool error', async () => {
    const result = await client.callTool({ name: 'git_command', arguments: { command: 'log --output=out.txt' } });
    expect(result.isError).toBe(true);
  });
});
