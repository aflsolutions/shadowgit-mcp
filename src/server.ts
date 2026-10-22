import { McpServer } from '@modelcontextprotocol/server';
import { registerCheckpoint } from './tools/checkpoint.js';
import { registerEndSession } from './tools/end-session.js';
import { registerGitCommand } from './tools/git-command.js';
import { registerLens } from './tools/lens.js';
import { registerListRepos } from './tools/list-repos.js';
import { registerMap } from './tools/map.js';
import { registerStartSession } from './tools/start-session.js';
import { VERSION } from './version.js';

export const INSTRUCTIONS = [
  "ShadowGit snapshots each tracked project every few minutes into a separate history (.shadowgit.git), so it holds changes the project's own git never saw.",
  'Task → tool:',
  "- What changed recently, a file's history, when something broke, what the user was doing at a given time: git_command with read-only git (log --since, diff, show, blame). Keep output small with --stat, -n and paths.",
  "- Before editing several files in a tracked project: start_session, which pauses snapshots. When a session's edits are done, whoever started it: checkpoint with a specific title, end_session, then get_lens and write_lens_words (a summary, a title and a sentence for each step, a role for each changed card), so the user reads your change in ShadowGit's Lens in your words.",
  '- The user asks to save or checkpoint their work: checkpoint.',
  "- A project name you don't recognise: list_repos.",
  "Every tool defaults to the project you are working in; pass repo only for another project. Sessions and checkpoints need the ShadowGit app running; git_command works without it. Times written inside older snapshot titles may be UTC; git's own dates are correct.",
].join('\n');

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'shadowgit', title: 'ShadowGit', version: VERSION, websiteUrl: 'https://shadowgit.com' },
    { instructions: INSTRUCTIONS },
  );
  registerListRepos(server);
  registerGitCommand(server);
  registerMap(server);
  registerStartSession(server);
  registerCheckpoint(server);
  registerEndSession(server);
  registerLens(server);
  return server;
}
