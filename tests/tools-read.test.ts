import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runGit, tokenize } from '../src/git.js';
import { tildify } from '../src/repos.js';
import { gitCommand } from '../src/tools/git-command.js';
import { listRepos } from '../src/tools/list-repos.js';
import { startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { makeProject, removeTempDirs, shadowGit, snapshot, tempDir, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let other: string;
let deleted: string;
let app: FakeApp;
const savedEnv = {
  TZ: process.env.TZ,
  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
  SHADOWGIT_SESSION_API: process.env.SHADOWGIT_SESSION_API,
  SHADOWGIT_STORAGE_DIR: process.env.SHADOWGIT_STORAGE_DIR,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    // Assigning undefined to process.env would store the string "undefined".
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeAll(async () => {
  process.env.TZ = 'Europe/Paris';
  project = makeProject('webshop', { 'README.md': '# Webshop\n', 'src/login.ts': 'export {};\n' }, '2026-10-08T10:00:00Z');
  snapshot(project, { 'src/login.ts': 'export const fixed = true;\n' }, 'Fix login redirect', '2026-10-08T10:29:00Z');
  other = makeProject('blog');
  deleted = path.join(tempDir('gone'), 'deleted');
  useStorage([{ name: 'webshop', path: project }, { name: 'blog', path: other }, { name: 'deleted', path: deleted }]);
  app = await startFakeApp();
  process.env.CLAUDE_PROJECT_DIR = project;
});

afterAll(async () => {
  restoreEnv();
  await app.close();
  removeTempDirs();
});

describe('git_command', () => {
  it('runs read-only git on the current project', async () => {
    expect(textOf(await gitCommand({ command: 'log --format=%s' }))).toBe('Fix login redirect\nInitial ShadowGit Snapshot\n');
  });

  it('accepts a leading "git" and quoted arguments with spaces', async () => {
    expect(textOf(await gitCommand({ command: 'git log --grep "login redirect" --format=%s' }))).toBe('Fix login redirect\n');
  });

  it('runs on another project by name', async () => {
    expect(textOf(await gitCommand({ command: 'log --format=%s', repo: 'blog' }))).toBe('Initial ShadowGit Snapshot\n');
  });

  it("turns a git failure into an error carrying git's message", async () => {
    await expect(gitCommand({ command: 'log HEAD~50' })).rejects.toThrow(/unknown revision|ambiguous argument/);
  });

  it('refuses subcommands outside the allowlist', async () => {
    await expect(gitCommand({ command: 'push' })).rejects.toThrow('git push is not allowed.');
  });

  it('truncates long output and says so first', async () => {
    snapshot(other, { 'big.txt': 'z'.repeat(40_000) }, 'Big file');
    const text = textOf(await gitCommand({ command: 'show HEAD:big.txt', repo: 'blog' }));
    expect(text.startsWith('[Truncated: showing the first 25,000 characters of 40,000 characters.')).toBe(true);
  });
});

describe('git_command file escapes', () => {
  const CANARY = 'CANARY-7f3a';
  let outside: string;
  let canary: string;

  beforeAll(() => {
    outside = tempDir('outside');
    canary = path.join(outside, 'canary.txt');
    fs.writeFileSync(canary, `${CANARY}\n`);
  });

  it('refuses each escape that plain git would run', async () => {
    const written = path.join(outside, 'written.txt');
    const escapes = [
      `log -1 --output=${written}`,
      `diff --no-index ${canary} README.md`,
      `blame --contents ${canary} README.md`,
      `blame --cont ${canary} README.md`,
      `blame --ignore-revs-file ${canary} README.md`,
      `diff ${canary} README.md`,
      `rev-list --output=${written} HEAD`,
      `shortlog --output=${written} HEAD`,
      `blame --output=${written} README.md`,
    ];
    for (const command of escapes) {
      const raw = await runGit(project, tokenize(command));
      const leaked = (raw.ok ? raw.stdout : raw.error).includes(CANARY) || fs.existsSync(written);
      expect(leaked, `plain git escapes with: ${command}`).toBe(true);
      fs.rmSync(written, { force: true });

      await expect(gitCommand({ command })).rejects.toThrow(/is refused/);
      expect(fs.existsSync(written)).toBe(false);
    }
  });

  // git reads a -S file as graft data and reports its lines on stderr only, which runGit drops: nothing to prove above.
  it.each([
    'blame -wS secret.txt README.md',
    'log -p -O/etc/hosts',
    'log -pO/etc/hosts',
    'show --orderfile=/etc/hosts',
    'ls-files --exclude-from=/etc/hosts',
    'ls-files -X secret.txt',
    'ls-files --exclude-per-directory=.secret',
    'rev-parse --resolve-git-dir secret',
  ])('refuses %s', async (command) => {
    // Relative values keep the path rule out of it: only the option rules can produce this wording.
    await expect(gitCommand({ command })).rejects.toThrow(/is refused: it reads or writes files outside the ShadowGit history\./);
  });
});

describe('list_repos', () => {
  it('reports every project, the current one, the last snapshot and any session', async () => {
    app.sessions.push({ id: 'claude-code-1', repoPath: project, description: 'Fix login', startedAt: '2026-10-08 10:00:00' });
    const result = await listRepos();
    app.sessions.length = 0;

    expect(result.structuredContent).toEqual({
      current: 'webshop',
      app_running: true,
      repos: [
        {
          name: 'webshop', path: project, current: true, last_snapshot: '2026-10-08T12:29:00+02:00',
          session: { id: 'claude-code-1', description: 'Fix login', started_at: '2026-10-08T12:00:00+02:00' },
        },
        { name: 'blog', path: other, current: false, last_snapshot: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/), session: null },
        { name: 'deleted', path: deleted, current: false, last_snapshot: null, session: null },
      ],
    });
    expect(textOf(result)).toContain('webshop (current)');
  });

  it('still lists the projects when the app is not running', async () => {
    const stopped = await startFakeApp();
    await stopped.close();
    const result = await listRepos();
    process.env.SHADOWGIT_SESSION_API = app.url;

    expect(result.structuredContent).toMatchObject({ app_running: false });
    expect(textOf(result)).toContain('The ShadowGit app is not running, so sessions and checkpoints are unavailable.');
  });
});

describe('list_repos with a history that has no snapshots or is broken', () => {
  function trackOnly(name: string, setup: (project: string) => void): string {
    const project = path.join(tempDir('project'), name);
    fs.mkdirSync(project);
    setup(project);
    useStorage([{ name, path: project }]);
    return project;
  }

  it('reports last_snapshot null for a history with zero commits', async () => {
    const project = trackOnly('fresh', (dir) => {
      shadowGit(dir, ['init', '--quiet']);
      fs.writeFileSync(path.join(dir, '.shadowgit.git', 'info', 'exclude'), '/.shadowgit.git/\n');
    });
    const result = await listRepos();

    expect(result.structuredContent).toMatchObject({ repos: [{ name: 'fresh', path: project, last_snapshot: null }] });
    expect(textOf(result)).toContain('no snapshots yet');
  });

  it('fails when git cannot read the history, instead of reporting no snapshots', async () => {
    const project = trackOnly('broken', (dir) => fs.mkdirSync(path.join(dir, '.shadowgit.git')));

    await expect(listRepos()).rejects.toThrow(
      `Couldn't read the ShadowGit history of broken (${tildify(project)}): fatal: not a git repository`,
    );
  });
});
