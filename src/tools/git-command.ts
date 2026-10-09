import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { capOutput, refusal, runGit, tokenize } from '../git.js';
import { resolveRepo } from '../repos.js';
import { repoParam } from './shared.js';

export async function gitCommand({ command, repo }: { command: string; repo?: string }): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const tokens = tokenize(command);
  const args = tokens[0] === 'git' ? tokens.slice(1) : tokens;
  const refused = refusal(args);
  if (refused) throw new Error(refused);
  const result = await runGit(project.path, args);
  if (!result.ok) throw new Error(result.error);
  return { content: [{ type: 'text', text: withExitStatus(result) }] };
}

/** The output as the model gets it. A non-zero exit is a finding (cat-file -e on a missing object), so it is never left silent. */
function withExitStatus({ stdout, overflowed, exitCode }: { stdout: string; overflowed: boolean; exitCode: number }): string {
  if (exitCode === 0) return capOutput(stdout, overflowed);
  const status = `git exited with status ${exitCode}`;
  if (stdout === '') return `(no output; ${status})`;
  const text = capOutput(stdout, overflowed);
  return `${text}${text.endsWith('\n') ? '' : '\n'}[${status}]`;
}

export function registerGitCommand(server: McpServer): void {
  server.registerTool(
    'git_command',
    {
      title: 'Query snapshot history with git',
      description:
        "Run a read-only git command on a project's ShadowGit history: automatic snapshots taken every few minutes, kept apart from the project's own .git. Use it for what changed recently, a file's history, when something broke, or a diff between two points in time. Allowed: log, show, diff, status, blame, shortlog, rev-list, rev-parse, ls-files, ls-tree, cat-file, describe, show-branch. Commands that write, and options that read or write files outside the history (such as --output and --no-index), are refused. Output is capped at 25,000 characters; narrow it with -n, --since, --stat or a path.",
      inputSchema: z.object({
        command: z
          .string()
          .min(1)
          .max(1_000)
          .describe('A git command without the leading "git", e.g. log --since="1 hour ago" --stat'),
        repo: repoParam,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    gitCommand,
  );
}
