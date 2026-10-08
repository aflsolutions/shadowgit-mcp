import { describe, it, expect } from 'vitest';
import { refusal, tokenize } from '../src/git.js';

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
  ])('refuses %s', (command) => {
    expect(refusal(tokenize(command))).toMatch(/is refused: it reads or writes files outside the ShadowGit history\.$/);
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
