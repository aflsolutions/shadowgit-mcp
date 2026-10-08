import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { capOutput, runGit } from '../src/git.js';
import { makeProject, removeTempDirs, shadowGit, snapshot, tempDir } from './helpers/fixtures.js';

let project: string;

/** Puts a `git` that runs this shell script first on PATH, for the rest of the test. POSIX only. */
function stubGit(script: string): void {
  const bin = tempDir('fake-git');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
}

beforeAll(() => {
  project = makeProject('demo', { 'a.txt': 'hello\n' });
});

afterAll(removeTempDirs);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runGit', () => {
  it('runs git against the ShadowGit history', async () => {
    expect(await runGit(project, ['log', '--format=%s'])).toEqual({
      ok: true, stdout: 'Initial ShadowGit Snapshot\n', overflowed: false, exitCode: 0,
    });
  });

  it("returns git's own message when git fails", async () => {
    const result = await runGit(project, ['log', 'HEAD~50']);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/unknown revision|ambiguous argument/);
  });

  it('returns the diff when --exit-code reports differences', async () => {
    fs.writeFileSync(path.join(project, 'a.txt'), 'hello again\n');
    const result = await runGit(project, ['diff', '--exit-code', '--stat']);
    fs.writeFileSync(path.join(project, 'a.txt'), 'hello\n');
    expect(result).toMatchObject({ ok: true, stdout: expect.stringContaining('a.txt'), exitCode: 1 });
  });

  it('returns a silent non-zero exit as a result carrying its exit code', async () => {
    expect(await runGit(project, ['cat-file', '-e', '0'.repeat(40)])).toEqual({
      ok: true, stdout: '', overflowed: false, exitCode: 1,
    });
  });

  // Git for Windows sets core.autocrlf=true, and then a diff that exits 1 also warns about line endings on stderr.
  it('returns the diff when core.autocrlf warns about line endings', async () => {
    const crlf = makeProject('crlf', { 'a.txt': 'hello\n' });
    shadowGit(crlf, ['config', 'core.autocrlf', 'true']);
    fs.writeFileSync(path.join(crlf, 'a.txt'), 'hello again\n');
    const result = await runGit(crlf, ['diff', '--exit-code', '--stat']);
    expect(result).toMatchObject({ ok: true, stdout: expect.stringContaining('a.txt') });
  });

  it("leaves the history's index alone on status", async () => {
    const index = path.join(project, '.shadowgit.git', 'index');
    const before = fs.statSync(index).mtimeMs;
    fs.writeFileSync(path.join(project, 'a.txt'), 'hello\n'); // same content, new mtime: a refresh would rewrite the index
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runGit(project, ['status', '--short']);
    expect(fs.statSync(index).mtimeMs).toBe(before);
  });

  it('does not wait for input on stdin', async () => {
    expect((await runGit(project, ['cat-file', '--batch'])).ok).toBe(true);
  }, 5_000);

  it('marks output past the 1 MB buffer as overflowed', async () => {
    snapshot(project, { 'big.txt': 'x'.repeat(2_000_000) }, 'Big file');
    const result = await runGit(project, ['show', 'HEAD:big.txt']);
    expect(result.ok && result.overflowed).toBe(true);
  });

  it('names a project folder that no longer exists', async () => {
    const gone = path.join(tempDir('gone'), 'never-created');
    expect(await runGit(gone, ['log'])).toEqual({ ok: false, error: `The project folder ${gone} no longer exists.` });
  });

  // A real git can finish inside a 1 ms timeout, so a git that never answers makes this deterministic.
  it.skipIf(process.platform === 'win32')('stops git at SHADOWGIT_TIMEOUT and says so', async () => {
    stubGit('exec sleep 5');
    vi.stubEnv('SHADOWGIT_TIMEOUT', '50');
    const result = await runGit(project, ['log']);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toMatch(/^git took longer than 0\.05 s\./);
  });

  it.each(['-1', '0', '0.5', '2147483648', 'soon'])('ignores SHADOWGIT_TIMEOUT=%s and uses the default', async (value) => {
    vi.stubEnv('SHADOWGIT_TIMEOUT', value);
    expect((await runGit(project, ['log', '--format=%s'])).ok).toBe(true);
  });

  // A git that dies from a signal the way the OOM killer or a crash ends it: partial output, no exit code.
  it.skipIf(process.platform === 'win32')('reports a git stopped by a signal as an error, not as a result', async () => {
    stubGit('echo partial; kill -KILL $$');
    expect(await runGit(project, ['log'])).toEqual({ ok: false, error: 'git was stopped by SIGKILL before it finished.' });
  });
});

describe('capOutput', () => {
  it('passes short output through', () => {
    expect(capOutput('abc\n', false)).toBe('abc\n');
  });

  it('names empty output', () => {
    expect(capOutput('', false)).toBe('(no output)');
  });

  it('keeps output of exactly 25,000 characters whole', () => {
    expect(capOutput('y'.repeat(25_000), false)).toBe('y'.repeat(25_000));
  });

  it('cuts output one character over the limit', () => {
    const lines = capOutput('y'.repeat(25_001), false).split('\n');
    expect(lines[0]).toBe(
      '[Truncated: showing the first 25,000 characters of 25,001 characters. Narrow it with -n, --since, --stat or a path.]',
    );
    expect(lines[1]).toHaveLength(25_000);
  });

  it('cuts long output and says so first', () => {
    const lines = capOutput('y'.repeat(30_000), false).split('\n');
    expect(lines[0]).toBe(
      '[Truncated: showing the first 25,000 characters of 30,000 characters. Narrow it with -n, --since, --stat or a path.]',
    );
    expect(lines[1]).toHaveLength(25_000);
  });

  it('describes overflowed output as more than 1 MB', () => {
    expect(capOutput('z', true).split('\n')[0]).toBe(
      '[Truncated: showing the first 25,000 characters of more than 1 MB. Narrow it with -n, --since, --stat or a path.]',
    );
  });
});
