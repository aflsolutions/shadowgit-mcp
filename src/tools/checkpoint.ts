import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientName } from '../client-name.js';
import { resolveRepo } from '../repos.js';
import { createCheckpoint } from '../session-api.js';
import { dataResult, repoParam } from './shared.js';

const Output = z.object({ commit: z.string().nullable(), title: z.string(), files_changed: z.number(), repo: z.string() });

export async function checkpoint(
  { title, message, repo }: { title: string; message?: string; repo?: string },
  author: string,
): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const result = await createCheckpoint({ repoPath: project.path, title, message, author });
  const data = { commit: result.commit, title, files_changed: result.filesChanged, repo: project.name };
  if (!result.commit) return dataResult('No changes since the last snapshot; nothing to checkpoint.', data);
  return dataResult(`Saved checkpoint ${result.commit.slice(0, 8)} "${title}" on ${project.name} (${result.filesChanged} files).`, data);
}

export function registerCheckpoint(server: McpServer): void {
  server.registerTool(
    'checkpoint',
    {
      title: 'Create a ShadowGit checkpoint',
      description:
        "Save the project's current changes to ShadowGit history as one named checkpoint, applying the project's .shadowgit-ignore rules. Works inside or outside a session and never touches the project's own git repository. Returns the commit hash. Needs the ShadowGit app running.",
      inputSchema: z.object({
        title: z.string().trim().min(1).max(72).describe('One line saying what changed, e.g. "Fix login redirect loop"'),
        message: z.string().max(1_000).optional().describe('Optional details: why, and anything a reviewer should know'),
        repo: repoParam,
      }),
      outputSchema: Output,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args, ctx) => checkpoint(args, clientName(server, ctx)),
  );
}
