/** What the evals share: a real Claude Code run on a project, with this server alone, pointed at the fake app. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as z from 'zod/v4';
import { BINARY } from '../tests/helpers/client.js';
import type { FakeApp } from '../tests/helpers/fake-app.js';
import { tempDir, useStorage } from '../tests/helpers/fixtures.js';

const run = promisify(execFile);

/** An ISO time `minutes` ago, for a snapshot's date. */
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * `claude -p prompt` in the project, tracked as webshop, with this server alone pointed at `app`: its stdout, also
 * when it exits with an error, whose reason is in its output. `args` adds the tools, the output format and the budget.
 */
export async function runClaude({ prompt, project, app, args, timeoutMs }: { prompt: string; project: string; app: FakeApp; args: string[]; timeoutMs: number }): Promise<string> {
  const storage = useStorage([{ name: 'webshop', path: project }]);
  const config = path.join(tempDir('eval'), 'mcp.json');
  fs.writeFileSync(config, JSON.stringify({
    mcpServers: { shadowgit: { command: process.execPath, args: [BINARY], env: { SHADOWGIT_STORAGE_DIR: storage, SHADOWGIT_SESSION_API: app.url } } },
  }));
  const claude = run('claude', ['-p', prompt, '--mcp-config', config, '--strict-mcp-config', '--no-session-persistence', ...args], {
    cwd: project,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 20 * 1024 * 1024,
  });
  // claude waits 3 s for piped stdin before it starts; there is none.
  claude.child.stdin?.end();
  const { stdout } = await claude.catch((error: unknown) => {
    if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' && error.stdout) return { stdout: error.stdout };
    throw error;
  });
  return stdout;
}

/** Claude Code's edit tools, for "before the first edit". */
export const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The tools an eval allows, its stream-json output and its budget: `runClaude`'s args for an eval that reads the stream. */
export const STREAM_ARGS = ['--allowedTools', 'mcp__shadowgit__*', 'Read', 'Edit', 'Write', 'Glob', 'Grep', '--output-format', 'stream-json', '--verbose', '--max-budget-usd', '2'];

// One line of `--output-format stream-json`: the assistant's turns carry its tool calls, the last line its reply and cost
const Line = z.object({
  type: z.string(),
  message: z.object({ content: z.array(z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() })).optional() }).optional(),
  result: z.string().optional(),
  total_cost_usd: z.number().optional(),
});

/** A stream-json run's tool calls in order, with their input, its reply and its cost. */
export function readStream(stdout: string): { calls: { name: string; input: unknown }[]; reply: string; cost: number } {
  const calls: { name: string; input: unknown }[] = [];
  let reply = '';
  let cost = 0;
  for (const text of stdout.split('\n')) {
    if (text.trim() === '') continue;
    const line = Line.safeParse(JSON.parse(text));
    if (!line.success) continue;
    if (line.data.total_cost_usd !== undefined) cost = line.data.total_cost_usd;
    if (line.data.result !== undefined) reply = line.data.result;
    if (line.data.type !== 'assistant') continue;
    for (const part of line.data.message?.content ?? []) if (part.type === 'tool_use' && part.name) calls.push({ name: part.name, input: part.input });
  }
  return { calls, reply, cost };
}
