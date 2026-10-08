import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRepos, resolveRepo, tildify } from '../src/repos.js';
import { makeProject, removeTempDirs, tempDir, useStorage } from './helpers/fixtures.js';

const saved = { CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, SHADOWGIT_STORAGE_DIR: process.env.SHADOWGIT_STORAGE_DIR };

function restore(name: keyof typeof saved): void {
  const value = saved[name];
  // Assigning undefined to process.env would store the string "undefined".
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  restore('CLAUDE_PROJECT_DIR');
  restore('SHADOWGIT_STORAGE_DIR');
  removeTempDirs();
});

function inside(...segments: string[]): string {
  const dir = path.join(...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('readRepos', () => {
  it('finds no projects when ShadowGit has never run', () => {
    process.env.SHADOWGIT_STORAGE_DIR = tempDir('empty');
    expect(readRepos()).toEqual([]);
  });

  it('fails on a corrupt repos.json instead of pretending it is empty, naming the file', () => {
    const dir = tempDir('corrupt');
    fs.writeFileSync(path.join(dir, 'repos.json'), '{');
    process.env.SHADOWGIT_STORAGE_DIR = dir;
    expect(() => readRepos()).toThrow(`Couldn't read ShadowGit's project list at ${path.join(dir, 'repos.json')}: `);
  });
});

describe('resolveRepo', () => {
  it('picks the project containing CLAUDE_PROJECT_DIR, the most specific one when projects nest', () => {
    const outer = makeProject('outer');
    const inner = inside(outer, 'packages', 'inner');
    useStorage([{ name: 'outer', path: outer }, { name: 'inner', path: inner }]);

    process.env.CLAUDE_PROJECT_DIR = inside(inner, 'src');
    expect(resolveRepo().name).toBe('inner');

    process.env.CLAUDE_PROJECT_DIR = inside(outer, 'docs');
    expect(resolveRepo().name).toBe('outer');
  });

  it('follows a symlinked project directory', () => {
    const real = makeProject('real');
    const other = makeProject('other');
    const link = path.join(tempDir('links'), 'linked');
    fs.symlinkSync(real, link, 'junction');
    useStorage([{ name: 'real', path: real }, { name: 'other', path: other }]);
    process.env.CLAUDE_PROJECT_DIR = link;
    expect(resolveRepo().name).toBe('real');
  });

  it('falls back to the only tracked project', () => {
    const only = makeProject('only');
    useStorage([{ name: 'only', path: only }]);
    process.env.CLAUDE_PROJECT_DIR = tempDir('elsewhere');
    expect(resolveRepo().name).toBe('only');
  });

  it('lists the projects when none contains the directory', () => {
    const a = makeProject('a');
    const b = makeProject('b');
    useStorage([{ name: 'a', path: a }, { name: 'b', path: b }]);
    const elsewhere = tempDir('elsewhere');
    process.env.CLAUDE_PROJECT_DIR = elsewhere;
    expect(() => resolveRepo()).toThrow(`No ShadowGit project contains ${elsewhere}. Pass repo as one of: a (`);
  });

  it('matches a name exactly, then ignoring case', () => {
    const shop = makeProject('Webshop');
    useStorage([{ name: 'Webshop', path: shop }, { name: 'blog', path: makeProject('blog') }]);
    expect(resolveRepo('Webshop').path).toBe(shop);
    expect(resolveRepo('webshop').path).toBe(shop);
    expect(() => resolveRepo('shop')).toThrow('No ShadowGit project is named shop. Pass repo as one of: Webshop (');
  });

  it('asks for a path when two projects share a name', () => {
    useStorage([{ name: 'app', path: makeProject('app') }, { name: 'app', path: makeProject('app') }]);
    expect(() => resolveRepo('app')).toThrow(/^Several ShadowGit projects are named app: .+\. Pass repo as one of these paths\.$/);
  });

  it('accepts an absolute path only for a tracked project', () => {
    const tracked = makeProject('tracked');
    useStorage([{ name: 'tracked', path: tracked }, { name: 'blog', path: makeProject('blog') }]);
    expect(resolveRepo(tracked).name).toBe('tracked');
    const untracked = makeProject('untracked');
    expect(() => resolveRepo(untracked)).toThrow(`${untracked} is not a ShadowGit project. Pass repo as one of: tracked (`);
  });

  it('keeps a folder named like ..x inside its project', () => {
    const a = makeProject('a');
    useStorage([{ name: 'a', path: a }, { name: 'b', path: makeProject('b') }]);
    process.env.CLAUDE_PROJECT_DIR = inside(a, '..cache');
    expect(resolveRepo().name).toBe('a');
  });

  it('skips a tracked project whose folder was deleted', () => {
    const kept = makeProject('kept');
    useStorage([{ name: 'gone', path: path.join(tempDir('gone'), 'deleted') }, { name: 'kept', path: kept }]);
    process.env.CLAUDE_PROJECT_DIR = kept;
    expect(resolveRepo().name).toBe('kept');
  });

  it.skipIf(process.platform === 'linux')('ignores case differences on macOS and Windows', () => {
    const shop = makeProject('Webshop');
    useStorage([{ name: 'Webshop', path: shop }, { name: 'blog', path: makeProject('blog') }]);
    process.env.CLAUDE_PROJECT_DIR = shop.toUpperCase();
    expect(resolveRepo().name).toBe('Webshop');
  });

  it('tells the user to add a project when none is tracked', () => {
    useStorage([]);
    expect(() => resolveRepo()).toThrow('ShadowGit is not tracking any project yet. Ask the user to add one in the ShadowGit app.');
  });
});

describe('tildify', () => {
  it('shortens the home directory and what is inside it, not a sibling sharing its prefix', () => {
    const home = os.homedir();
    expect(tildify(home)).toBe('~');
    expect(tildify(path.join(home, 'code'))).toBe(`~${path.sep}code`);
    expect(tildify(`${home}ine${path.sep}code`)).toBe(`${home}ine${path.sep}code`);
  });
});
