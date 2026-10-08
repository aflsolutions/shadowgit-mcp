import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';

export interface Repo {
  name: string;
  path: string;
}

const ReposFile = z.array(z.object({ name: z.string(), path: z.string() }));

/** ShadowGit's storage directory; mirrors getStorageLocation() in the app (electron/core/native.ts). */
export function storageDir(): string {
  if (process.env.SHADOWGIT_STORAGE_DIR) return process.env.SHADOWGIT_STORAGE_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), '.shadowgit');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'shadowgit');
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'shadowgit');
}

/** The tracked projects, read on every call so projects added in the app show up without a restart. */
export function readRepos(): Repo[] {
  const file = path.join(storageDir(), 'repos.json');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return [];
    throw error;
  }
  try {
    return ReposFile.parse(JSON.parse(text));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't read ShadowGit's project list at ${file}: ${reason}`, { cause: error });
  }
}

/**
 * The project the tools default to: the one containing the client's project directory. When the client names none
 * (Cursor, Claude Desktop: CLAUDE_PROJECT_DIR unset), the only tracked project; a named directory no project contains
 * must not fall back to another project's history.
 */
export function currentRepo(repos: Repo[]): Repo | null {
  const start = canonical(startDir());
  const containing = repos
    .map((repo) => ({ repo, root: canonical(repo.path) }))
    .filter(({ root }) => isInside(start, root))
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (containing) return containing.repo;
  return repos.length === 1 && !process.env.CLAUDE_PROJECT_DIR ? (repos[0] ?? null) : null;
}

export function resolveRepo(repo?: string): Repo {
  const repos = readRepos();
  if (repos.length === 0) {
    throw new Error('ShadowGit is not tracking any project yet. Ask the user to add one in the ShadowGit app.');
  }
  if (repo) return repoByArgument(repos, repo);
  const current = currentRepo(repos);
  if (current) return current;
  throw new Error(`No ShadowGit project contains ${startDir()}. Pass repo as one of: ${listed(repos)}.`);
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

function repoByArgument(repos: Repo[], repo: string): Repo {
  if (path.isAbsolute(repo) || repo.startsWith('~')) {
    const wanted = canonical(expandHome(repo));
    const match = repos.find((r) => canonical(r.path) === wanted);
    if (match) return match;
    throw new Error(`${repo} is not a ShadowGit project. Pass repo as one of: ${listed(repos)}.`);
  }
  const exact = (r: Repo) => r.name === repo;
  const ignoringCase = (r: Repo) => r.name.toLowerCase() === repo.toLowerCase();
  for (const same of [exact, ignoringCase]) {
    const [first, ...others] = repos.filter(same);
    if (first && others.length === 0) return first;
    if (first) {
      const paths = [first, ...others].map((r) => tildify(r.path)).join(', ');
      throw new Error(`Several ShadowGit projects are named ${repo}: ${paths}. Pass repo as one of these paths.`);
    }
  }
  throw new Error(`No ShadowGit project is named ${repo}. Pass repo as one of: ${listed(repos)}.`);
}

/** Claude Code sets CLAUDE_PROJECT_DIR for stdio servers; other clients start the server in the project. */
function startDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/** The real path, case-folded where file systems usually ignore case, so two spellings of a path compare equal. */
function canonical(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch (error) {
    if (!hasCode(error, 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP')) throw error;
    // A tracked project can be deleted or unreadable; its recorded path still names it, and git on it reports the real failure.
    resolved = path.resolve(p);
  }
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && codes.includes(error.code);
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

function listed(repos: Repo[]): string {
  return repos.map((r) => `${r.name} (${tildify(r.path)})`).join(', ');
}
