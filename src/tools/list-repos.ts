import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import fs from 'node:fs';
import path from 'node:path';
import * as z from 'zod/v4';
import { SHADOWGIT_DIR, runGit } from '../git.js';
import { currentRepo, readRepos, tildify } from '../repos.js';
import { AppNotRunningError, activeSessions, type ActiveSession } from '../session-api.js';
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
    session: z.object({ id: z.string(), description: z.string(), started_at: z.string() }).nullable(),
  })),
});

type Listing = z.infer<typeof Output>;

export async function listRepos(): Promise<CallToolResult> {
  const repos = readRepos();
  const current = currentRepo(repos);
  const sessions = await sessionsIfRunning();
  const rows = await Promise.all(repos.map(async (repo) => {
    const session = sessions?.find((s) => s.repoPath === repo.path);
    return {
      name: repo.name,
      path: repo.path,
      current: repo === current,
      last_snapshot: await lastSnapshot(repo.path),
      session: session ? { id: session.id, description: session.description, started_at: session.startedAt } : null,
    };
  }));
  const listing: Listing = { current: current?.name ?? null, app_running: sessions !== null, repos: rows };
  return dataResult(render(listing), listing);
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

async function sessionsIfRunning(): Promise<ActiveSession[] | null> {
  try {
    return await activeSessions();
  } catch (error) {
    if (error instanceof AppNotRunningError) return null;
    throw error;
  }
}

async function lastSnapshot(projectPath: string): Promise<string | null> {
  if (!fs.existsSync(path.join(projectPath, SHADOWGIT_DIR))) return null;
  const result = await runGit(projectPath, ['log', '-1', '--format=%ct']);
  // A history without snapshots yet makes git log fail; that project simply has no last snapshot.
  const seconds = result.ok ? Number(result.stdout.trim()) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? toLocalIso(new Date(seconds * 1000)) : null;
}

function render(listing: Listing): string {
  if (listing.repos.length === 0) {
    return 'ShadowGit is not tracking any project yet. Ask the user to add one in the ShadowGit app.';
  }
  const lines = listing.repos.map((r) => [
    `${r.name}${r.current ? ' (current)' : ''}: ${tildify(r.path)}`,
    r.last_snapshot ? `last snapshot ${r.last_snapshot}` : 'no snapshots yet',
    ...(r.session ? [`session "${r.session.description}" active since ${r.session.started_at}`] : []),
  ].join(', '));
  if (!listing.app_running) lines.push('The ShadowGit app is not running, so sessions and checkpoints are unavailable.');
  return lines.join('\n');
}
