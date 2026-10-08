import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const repoParam = z
  .string()
  .min(1)
  .optional()
  .describe('Project name or absolute path. Defaults to the current project.');

/** A result with a sentence for the model and the same facts as structured data, checked against the tool's output schema. */
export function dataResult<S extends z.ZodType>(_schema: S, text: string, data: z.infer<S>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}
