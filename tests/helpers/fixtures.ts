import type { CallToolResult } from '@modelcontextprotocol/server';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** A temporary directory, deleted by removeTempDirs(). */
export function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sg-${label}-`));
  created.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

/** git on a project's ShadowGit history, with a fixed identity so tests run on machines without one. */
export function shadowGit(project: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', [
    '-c', 'user.name=ShadowGit', '-c', 'user.email=shadowgit@local', '-c', 'commit.gpgsign=false',
    `--git-dir=${path.join(project, '.shadowgit.git')}`, `--work-tree=${project}`, ...args,
  ], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

/** Writes the files and commits them as one snapshot, optionally at a given ISO date. */
export function snapshot(project: string, files: Record<string, string>, title: string, date?: string): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), content);
  }
  shadowGit(project, ['add', '-A']);
  shadowGit(project, ['commit', '--quiet', '-m', title], date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {});
}

/** A project laid out as the app lays it out: its files, plus a .shadowgit.git history beside them. */
export function makeProject(name: string, files: Record<string, string> = { 'README.md': '# demo\n' }, date?: string): string {
  const project = path.join(tempDir('project'), name);
  fs.mkdirSync(project);
  shadowGit(project, ['init', '--quiet']);
  // The app keeps its history directory out of the history the same way (electron/core/git-operations.ts).
  fs.writeFileSync(path.join(project, '.shadowgit.git', 'info', 'exclude'), '/.shadowgit.git/\n');
  snapshot(project, files, 'Initial ShadowGit Snapshot', date);
  return project;
}

/** Points the server at a temporary storage directory holding this project list; returns the directory. */
export function useStorage(repos: { name: string; path: string }[]): string {
  const dir = tempDir('storage');
  fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify(repos, null, 2));
  process.env.SHADOWGIT_STORAGE_DIR = dir;
  return dir;
}

export function textOf(result: CallToolResult): string {
  return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}
