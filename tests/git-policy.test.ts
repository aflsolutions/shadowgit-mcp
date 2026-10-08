import { describe, it, expect } from 'vitest';
import { refusal, tokenize } from '../src/git.js';

const OPTION_REFUSAL = /is refused: it reads or writes files outside the ShadowGit history\.$/;
const PATH_REFUSAL =
  /is refused: it names a path outside the project\. If it is an option's value, attach it to the option \(--grep=\/api, -L\/\^func\/,\/\^\}\/\)\.$/;

describe('tokenize', () => {
  it('splits on whitespace and keeps quoted text together', () => {
    expect(tokenize(`log --since="1 hour ago" --grep 'fix login' -5`)).toEqual([
      'log', '--since=1 hour ago', '--grep', 'fix login', '-5',
    ]);
  });

  it('keeps an empty quoted argument', () => {
    expect(tokenize('log --grep ""')).toEqual(['log', '--grep', '']);
  });

  it('rejects an unterminated quote', () => {
    expect(() => tokenize('log --grep "fix')).toThrow('Unterminated quote in command.');
  });
});

describe('refusal', () => {
  it.each([
    'log -1 --output=/tmp/x',
    'log -1 --output /tmp/x',
    'show --orderfile=/etc/hosts',
    'diff -O/etc/hosts',
    'log -pO/etc/hosts',
    'diff --no-index /etc/hosts a.txt',
    'blame --contents /etc/hosts a.txt',
    'blame --cont /etc/hosts a.txt',
    'blame --ignore-revs-file /etc/hosts a.txt',
    'blame -wS /etc/hosts a.txt',
    'ls-files --exclude-from=/etc/hosts',
    'ls-files -X /etc/hosts',
    'ls-files --exclude-per-directory=.secret',
    'rev-parse --resolve-git-dir /etc',
    'rev-list --output=/tmp/x HEAD',
    'shortlog --output=/tmp/x HEAD',
    'blame --output=/tmp/x a.txt',
    'rev-list -O/etc/hosts HEAD',
    'shortlog -O/etc/hosts HEAD',
  ])('refuses %s', (command) => {
    expect(refusal(tokenize(command))).toMatch(OPTION_REFUSAL);
  });

  it.each([
    'diff /etc/hosts a.txt',
    'diff ../outside.txt a.txt',
    'diff -- a.txt ../../etc/hosts',
    'diff /dev/null /etc/passwd',
    'diff -- /dev/null /etc/passwd',
    'diff ../outside/secret.txt a.txt',
    'diff C:secret.txt a.txt',
    'diff c:/Windows/win.ini a.txt',
    'diff -- -foo/../../outside/secret.txt a.txt',
    'diff -- --/../../outside/secret.txt a.txt',
  ])('refuses the path in %s', (command) => {
    expect(refusal(tokenize(command))).toMatch(PATH_REFUSAL);
  });

  it.each([
    'log --since="1 hour ago" --stat',
    'log -S needle',
    'log -C --stat',
    'log -c',
    'cat-file -e HEAD',
    'blame --ignore-rev HEAD a.txt',
    'ls-files --others --exclude=*.log',
    'diff --output-indicator-new=+ HEAD~1',
    'log HEAD~2..HEAD --stat',
    'diff main...HEAD -- src/app.ts',
    'rev-list --objects --all',
    'show HEAD:src/app.ts',
    'blame -L/^func/,/^}/ a.txt',
    'log --grep=/api/users',
  ])('allows %s', (command) => {
    expect(refusal(tokenize(command))).toBeNull();
  });

  it('refuses subcommands outside the allowlist', () => {
    expect(refusal(['push'])).toBe(
      'git push is not allowed. Allowed: log, show, diff, status, blame, shortlog, rev-list, rev-parse, ls-files, ls-tree, cat-file, describe, show-branch.',
    );
  });

  it('refuses an empty command', () => {
    expect(refusal([])).toBe('Empty command. Example: log --since="1 hour ago" --stat');
  });
});
