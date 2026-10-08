import { CLIENT_INFO_META_KEY, type McpServer, type ServerContext } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// Trimmed because the session id is built from the name, so a blank one must not get through.
const ClientInfo = z.object({ name: z.string().trim(), title: z.string().trim().optional() });

/** The calling client's name: from the request envelope on 2026-07-28, from the initialize handshake on 2025-11-25. */
export function clientName(server: McpServer, ctx: ServerContext): string {
  const envelope: Record<string, unknown> = ctx.mcpReq.envelope ?? {};
  // Deprecated, but 2025-era connections carry no envelope, so it is their only source.
  const { data } = ClientInfo.safeParse(envelope[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion());
  return data?.title || data?.name || 'AI assistant';
}
