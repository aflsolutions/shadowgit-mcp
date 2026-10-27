import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { readRepos, repoArgument, resolveRepo } from '../repos.js';
import { activeSessions, endSession as endAppSession } from '../session-api.js';
import { dataResult, forRepo, repoParam } from './shared.js';

// The steps after a session, in the answer the model reads at that moment: the Lens of what it changed. The Lens reads
// snapshots: an app before 0.3.13 leaves edits ended without a checkpoint out of one, so they come first there
const next = (repo: string | undefined, snapshotted: boolean) =>
  `${forRepo(repo)}${snapshotted ? '' : 'If its edits are in a checkpoint: '}get_lens, then write_lens_words for the range it gives (a summary, a title and a sentence for each step, a role for each changed card), so the user reads your change in ShadowGit's Lens in your words${snapshotted ? '.' : '; if not, checkpoint them first.'}`;
/** Where a session ended, when the app took its unsaved edits into a snapshot as it did. */
const at = (commit: string | undefined) => (commit === undefined ? '' : ` at snapshot ${commit.slice(0, 8)}, which holds its edits`);
const Output = z.object({ ended: z.array(z.string()), repo: z.string().nullable(), next: z.string().optional().describe('The step that follows a session') });

const projectName = (repoPath: string) => readRepos().find((r) => r.path === repoPath)?.name ?? repoPath;

export async function endSession({ repo, session_id }: { repo?: string; session_id?: string }): Promise<CallToolResult> {
  const sessions = await activeSessions();
  if (session_id) {
    // The app's /session/end reports success even for unknown ids, so only an active session gets ended.
    const session = sessions.find((s) => s.id === session_id);
    if (!session) return dataResult(Output, `No active session ${session_id}; nothing to end.`, { ended: [], repo: null });
    const commit = await endAppSession(session.id);
    const name = projectName(session.repoPath);
    // A session found by its id may be another project's: its steps name it, by its path where its name is shared
    const listed = readRepos().find((r) => r.path === session.repoPath);
    const ended = `Ended session ${session.id} on ${name}${at(commit)}. Automatic snapshots resumed.`;
    // A project ShadowGit no longer tracks: no tool reaches it, so no step follows
    if (!listed) return dataResult(Output, ended, { ended: [session.id], repo: name });
    const steps = next(repoArgument(listed), commit !== undefined);
    return dataResult(Output, `${ended} Next: ${steps}`, { ended: [session.id], repo: name, next: steps });
  }
  const project = resolveRepo(repo);
  const ended = sessions.filter((s) => s.repoPath === project.path).map((s) => s.id);
  const commits: (string | undefined)[] = [];
  for (const id of ended) commits.push(await endAppSession(id));
  if (ended.length > 0) {
    // Each end snapshots what is left unsaved, so the last holds every session's edits
    const snapshotted = commits.every((commit) => commit !== undefined);
    const steps = next(repo === undefined ? undefined : repoArgument(project), snapshotted);
    const text = `Ended ${ended.join(', ')} on ${project.name}${at(snapshotted ? commits.at(-1) : undefined)}. Automatic snapshots resumed. Next: ${steps}`;
    return dataResult(Output, text, { ended, repo: project.name, next: steps });
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
        'Resume automatic snapshots for a project by ending its active ShadowGit session. Without session_id it ends whatever session is active on the project, and succeeds with nothing to do if there is none. ShadowGit takes changes not saved with checkpoint into a snapshot as the session ends (before ShadowGit 0.3.13, the next automatic snapshot takes them).',
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
