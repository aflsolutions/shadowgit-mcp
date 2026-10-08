import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { capOutput, runGit } from '../src/git.js';
import { makeProject, removeTempDirs, snapshot } from './helpers/fixtures.js';

let project: string;

beforeAll(() => {
  project = makeProject('demo', { 'a.txt': 'hello\n' });
});

afterAll(removeTempDirs);

describe('runGit', () => {
  it('runs git against the ShadowGit history', async () => {
    expect(await runGit(project, ['log', '--format=%s'])).toEqual({
      ok: true, stdout: 'Initial ShadowGit Snapshot\n', overflowed: false,
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
    expect(result.ok && result.stdout).toContain('a.txt');
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
});

describe('capOutput', () => {
  it('passes short output through', () => {
    expect(capOutput('abc\n', false)).toBe('abc\n');
  });

  it('names empty output', () => {
    expect(capOutput('', false)).toBe('(no output)');
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
