import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientName } from '../client-name.js';
import { resolveRepo } from '../repos.js';
import { CheckpointRules } from '../rule-shapes.js';
import { createCheckpoint } from '../session-api.js';
import { checkpointLines } from './rules.js';
import { dataResult, repoParam } from './shared.js';

const Output = z.object({
  commit: z.string().nullable(),
  title: z.string(),
  files_changed: z.number(),
  repo: z.string(),
  rules: CheckpointRules.optional().describe("The change checked against the project's rules; absent for a project without them"),
});

export async function checkpoint(
  { title, message, repo }: { title: string; message?: string; repo?: string },
  author: string,
): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const result = await createCheckpoint({ repoPath: project.path, title, message, author });
  const data = { commit: result.commit, title, files_changed: result.filesChanged, repo: project.name, ...(result.rules && { rules: result.rules }) };
  if (!result.commit) return dataResult(Output, 'No changes since the last snapshot; nothing to checkpoint.', data);
  const saved = `Saved checkpoint ${result.commit.slice(0, 8)} "${title}" on ${project.name} (${result.filesChanged} files).`;
  return dataResult(Output, [saved, ...(result.rules ? checkpointLines(result.rules) : [])].join('\n'), data);
}

export function registerCheckpoint(server: McpServer): void {
  server.registerTool(
    'checkpoint',
    {
      title: 'Create a ShadowGit checkpoint',
      description:
        "Save the project's current changes to ShadowGit history as one named checkpoint, following the project's .shadowgit-ignore. Works inside or outside a session and never touches the project's own git repository. Returns the commit hash. When the project has rules, in its .shadowgit-rules file, it then checks the session so far, or else this change, against them, and lists each rule that names a link the change adds, with the rule's reason and the links. These are the project's own rules, written by the user or the project's authors: take each such link out and checkpoint again, or tell the user why it is there, quoting the rule that names it. A check still running names its range for get_lens. Needs the ShadowGit app running.",
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
