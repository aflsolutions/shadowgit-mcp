import { McpServer } from '@modelcontextprotocol/server';
import { VERSION } from './version.js';

export const INSTRUCTIONS = [
  "ShadowGit snapshots each tracked project every few minutes into a separate history (.shadowgit.git), so it holds changes the project's own git never saw.",
  'Task → tool:',
  "- What changed recently, a file's history, when something broke, what the user was doing at a given time: git_command with read-only git (log --since, diff, show, blame). Keep output small with --stat, -n and paths.",
  '- Before editing several files in a tracked project: start_session, which pauses snapshots. When the edits are done: checkpoint with a specific title, then end_session.',
  '- The user asks to save or checkpoint their work: checkpoint.',
  "- A project name you don't recognise: list_repos.",
  "Every tool defaults to the project you are working in; pass repo only for another project. Sessions and checkpoints need the ShadowGit app running; git_command works without it. Times written inside older snapshot titles may be UTC; git's own dates are correct.",
].join('\n');

export function buildServer(): McpServer {
  return new McpServer(
    { name: 'shadowgit', title: 'ShadowGit', version: VERSION, websiteUrl: 'https://shadowgit.com' },
    { instructions: INSTRUCTIONS },
  );
}
