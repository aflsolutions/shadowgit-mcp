import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { SHADOWGIT_DIR, runGit } from '../git.js';
import { currentRepo, readRepos, tildify, type Repo } from '../repos.js';
import { AppNotRunningError, AppTimeoutError, activeSessions, type ActiveSession } from '../session-api.js';
import { toLocalIso } from '../time.js';
import { dataResult } from './shared.js';

const Output = z.object({
  current: z.string().nullable(),
  app_running: z.boolean(),
  repos: z.array(z.object({
    name: z.string(),
    path: z.string(),
    current: z.boolean(),
    last_snapshot: z.string().nullable(),
    error: z.string().nullable(),
    session: z.object({ id: z.string(), description: z.string(), started_at: z.string() }).nullable(),
  })),
});

type Listing = z.infer<typeof Output>;
type Row = Listing['repos'][number];

export async function listRepos(): Promise<CallToolResult> {
  const repos = readRepos();
  const current = currentRepo(repos);
  const { sessions, timedOut } = await askApp();
  const rows = await Promise.all(repos.map(async (repo) => {
    const session = sessions?.find((s) => s.repoPath === repo.path);
    return {
      name: repo.name,
      path: repo.path,
      current: repo === current,
      ...(await lastSnapshot(repo)),
      session: session ? { id: session.id, description: session.description, started_at: session.startedAt } : null,
    };
  }));
  const listing: Listing = { current: current?.name ?? null, app_running: sessions !== null, repos: rows };
  return dataResult(render(listing, timedOut), listing);
}

export function registerListRepos(server: McpServer): void {
  server.registerTool(
    'list_repos',
    {
      title: 'List ShadowGit projects',
      description:
        "List the projects ShadowGit is snapshotting: name, path, time of the last snapshot, any active session, and which one matches the project you are working in. Other ShadowGit tools default to that current project. Use this when the user names a project you don't recognise.",
      outputSchema: Output,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    () => listRepos(),
  );
}

/** The active sessions, or null when the app did not answer: closed, or too busy to (timedOut). */
async function askApp(): Promise<{ sessions: ActiveSession[] | null; timedOut: boolean }> {
  try {
    return { sessions: await activeSessions(), timedOut: false };
  } catch (error) {
    if (error instanceof AppNotRunningError) return { sessions: null, timedOut: false };
    if (error instanceof AppTimeoutError) return { sessions: null, timedOut: true };
    throw error;
  }
}

const unreadablePrefix = (repo: Pick<Repo, 'name' | 'path'>) =>
  `Couldn't read the ShadowGit history of ${repo.name} (${tildify(repo.path)}): `;

async function lastSnapshot(repo: Repo): Promise<Pick<Row, 'last_snapshot' | 'error'>> {
  if (!fs.existsSync(path.join(repo.path, SHADOWGIT_DIR))) return { last_snapshot: null, error: null };
  // --all makes a history without snapshots yet exit 0 with no output; any real failure (git, disk, corruption) is the row's error.
  const result = await runGit(repo.path, ['log', '-1', '--all', '--format=%ct']);
  if (!result.ok) return { last_snapshot: null, error: unreadablePrefix(repo) + result.error };
  const seconds = result.stdout.trim();
  return { last_snapshot: seconds === '' ? null : toLocalIso(new Date(Number(seconds) * 1000)), error: null };
}

function snapshotText(row: Row): string {
  if (row.error) return `history unreadable: ${row.error.slice(unreadablePrefix(row).length)}`;
  return row.last_snapshot ? `last snapshot ${row.last_snapshot}` : 'no snapshots yet';
}

function render(listing: Listing, timedOut: boolean): string {
  if (listing.repos.length === 0) {
    return 'ShadowGit is not tracking any project yet. Ask the user to add one in the ShadowGit app.';
  }
  const lines = listing.repos.map((r) => [
    `${r.name}${r.current ? ' (current)' : ''}: ${tildify(r.path)}`,
    snapshotText(r),
    ...(r.session ? [`session "${r.session.description}" active since ${r.session.started_at}`] : []),
  ].join(', '));
  if (timedOut) lines.push('The ShadowGit app did not answer in time, so sessions and checkpoints may be unavailable.');
  else if (!listing.app_running) lines.push('The ShadowGit app is not running, so sessions and checkpoints are unavailable.');
  return lines.join('\n');
}
