/** What the evals share: a real Claude Code run on a project, with this server alone, pointed at the fake app. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
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
