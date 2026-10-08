import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

export const BINARY = fileURLToPath(new URL('../../dist/shadowgit-mcp-server.js', import.meta.url));

/** Both protocol revisions a client may speak: 2026-07-28 opens with server/discover, 2025-11-25 with initialize. */
export const ERAS = [
  { era: '2026-07-28', mode: { pin: '2026-07-28' } },
  { era: '2025-11-25', mode: 'legacy' },
] as const;

/** Spawns the built server over stdio, the way an MCP client does. */
export async function connect(mode: (typeof ERAS)[number]['mode'], env: Record<string, string> = {}): Promise<Client> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const client = new Client({ name: 'shadowgit-e2e', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BINARY], env: { ...inherited, ...env } }));
  return client;
}
