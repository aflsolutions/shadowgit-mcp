import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientName } from '../client-name.js';
import { resolveRepo } from '../repos.js';
import { activeSessions, startSession as startAppSession } from '../session-api.js';
import { dataResult, repoParam } from './shared.js';

const Output = z.object({ session_id: z.string(), repo: z.string(), already_active: z.boolean() });

export async function startSession({ description, repo }: { description: string; repo?: string }, client: string): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const existing = (await activeSessions()).find((s) => s.repoPath === project.path);
  if (existing) {
    return dataResult(
      Output,
      `A session is already active on ${project.name}: ${existing.id} ("${existing.description}"). Automatic snapshots stay paused until it ends.`,
      { session_id: existing.id, repo: project.name, already_active: true },
    );
  }
  const id = await startAppSession(project.path, description, client);
  return dataResult(
    Output,
    `Started session ${id} on ${project.name}. Automatic snapshots are paused until end_session.`,
    { session_id: id, repo: project.name, already_active: false },
  );
}

export function registerStartSession(server: McpServer): void {
  server.registerTool(
    'start_session',
    {
      title: 'Start a ShadowGit session',
      description:
        "Pause ShadowGit's automatic snapshots for a project while you make a set of related edits, so they can be saved as one checkpoint instead of several partial snapshots. Returns the existing session if one is already active. Needs the ShadowGit app running. To save the edits and resume snapshots, use checkpoint and end_session.",
      inputSchema: z.object({
        description: z.string().min(1).max(200).describe('What you are about to change, e.g. "Fix login redirect"'),
        repo: repoParam,
      }),
      outputSchema: Output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => startSession(args, clientName(server, ctx)),
  );
}
