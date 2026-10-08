import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const repoParam = z
  .string()
  .min(1)
  .optional()
  .describe('Project name or absolute path. Defaults to the current project.');

/** A result with a sentence for the model and the same facts as structured data. */
export function dataResult(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}
