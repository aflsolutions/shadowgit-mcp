import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { INSTRUCTIONS } from '../src/server.js';
import { ERAS, connect } from './helpers/client.js';
import { FAKE_RANGE, fakeSession, startFakeApp, type FakeApp } from './helpers/fake-app.js';
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

  // Claude Code shows the model a tool's structured output alone, never its text: the rules must be in the schema
  it("puts the rules for links, a why and an excerpt in write_lens_words' schema, never in get_lens's text", async () => {
    const { tools } = await client.listTools();
    const write = JSON.stringify(tools.find((tool) => tool.name === 'write_lens_words'));
    expect(write).toContain('only where the text names it');
    expect(write).toContain('word for word');
    expect(write).toContain('At most 12 lines that changed');
    expect(write).not.toMatch(/get_lens (says|describes)/);
    // The app leaves out a why past its limit, where other text is cut; and a step's entry replaces its earlier one
    expect(write).toContain('a longer quote is left out, not cut');
    expect(write).toContain('replaces everything written for that step before');
  });

  it('lists the seven tools exactly as pinned', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_repos', 'git_command', 'start_session', 'checkpoint', 'end_session', 'get_lens', 'write_lens_words']);
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

    const lens = await client.callTool({ name: 'get_lens', arguments: {} });
    expect(lens.structuredContent).toMatchObject({ repo: 'demo', range: FAKE_RANGE });
    const words = await client.callTool({ name: 'write_lens_words', arguments: { ...FAKE_RANGE, steps: [{ id: 'c1', title: 'Queue failed charges' }] } });
    expect(words.structuredContent).toMatchObject({ repo: 'demo', applied: { steps: 1 } });

    expect(app.requestsTo('/session/start')[0]).toMatchObject({ aiTool: 'shadowgit-e2e', repoPath: project });
    expect(app.requestsTo('/checkpoint')[0]).toMatchObject({ author: 'shadowgit-e2e' });
    expect(app.requestsTo('/lens/words')[0]).toMatchObject({ author: 'shadowgit-e2e', repoPath: project, words: { steps: [{ id: 'c1', title: 'Queue failed charges' }] } });
  });

  it('sends linked pieces, a why and an excerpt as given', async () => {
    const step = {
      id: 'c1',
      body: [{ text: 'RetryQueue', card: 'k1' }, { text: ' calls chargeCard again.' }],
      why: { quote: 'Retry failed charges', source: 'commit' },
      excerpt: { path: 'src/retry-queue.ts', name: 'RetryQueue', side: 'head', lines: { start: 1, end: 4 } },
    };
    const words = await client.callTool({ name: 'write_lens_words', arguments: { ...FAKE_RANGE, steps: [step] } });
    expect(words.isError).not.toBe(true);
    expect(app.requestsTo('/lens/words').at(-1)).toMatchObject({ words: { steps: [step] } });
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
