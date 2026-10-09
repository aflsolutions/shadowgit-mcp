import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { readRepos, resolveRepo } from '../repos.js';
import { activeSessions, endSession as endAppSession } from '../session-api.js';
import { dataResult, repoParam } from './shared.js';

const Output = z.object({ ended: z.array(z.string()), repo: z.string().nullable() });

const projectName = (repoPath: string) => readRepos().find((r) => r.path === repoPath)?.name ?? repoPath;

export async function endSession({ repo, session_id }: { repo?: string; session_id?: string }): Promise<CallToolResult> {
  const sessions = await activeSessions();
  if (session_id) {
    // The app's /session/end reports success even for unknown ids, so only an active session gets ended.
    const session = sessions.find((s) => s.id === session_id);
    if (!session) return dataResult(Output, `No active session ${session_id}; nothing to end.`, { ended: [], repo: null });
    await endAppSession(session.id);
    const name = projectName(session.repoPath);
    return dataResult(Output, `Ended session ${session.id} on ${name}. Automatic snapshots resumed.`, { ended: [session.id], repo: name });
  }
  const project = resolveRepo(repo);
  const ended = sessions.filter((s) => s.repoPath === project.path).map((s) => s.id);
  for (const id of ended) await endAppSession(id);
  if (ended.length > 0) {
    return dataResult(Output, `Ended ${ended.join(', ')} on ${project.name}. Automatic snapshots resumed.`, { ended, repo: project.name });
  }
  if (sessions.length === 0) return dataResult(Output, 'No active session; automatic snapshots are already on.', { ended, repo: project.name });
  // Every session is on another project, usually the one the person meant.
  const elsewhere = sessions.map((s) => `${projectName(s.repoPath)} (session ${s.id})`).join(', ');
  const text = `No active session on ${project.name}; its automatic snapshots are already on. Active elsewhere: ${elsewhere}. Pass session_id to end one.`;
  return dataResult(Output, text, { ended, repo: project.name });
}

export function registerEndSession(server: McpServer): void {
  server.registerTool(
    'end_session',
    {
      title: 'End a ShadowGit session',
      description:
        'Resume automatic snapshots for a project by ending its active ShadowGit session. Without session_id it ends whatever session is active on the project, and succeeds with nothing to do if there is none. Changes not saved with checkpoint are picked up by the next automatic snapshot.',
      inputSchema: z.object({
        repo: repoParam,
        session_id: z.string().min(1).optional().describe('Defaults to the active session of the project'),
      }),
      outputSchema: Output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    endSession,
  );
}
