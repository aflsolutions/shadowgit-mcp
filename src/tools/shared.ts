import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { repoArgument, type Repo } from '../repos.js';

export const repoParam = z
  .string()
  .min(1)
  .optional()
  .describe('Project name or absolute path. Defaults to the current project.');

/** Steps that follow, for a project other than the current one: each tool needs it named. */
export const forRepo = (repo?: string) => (repo === undefined ? '' : `For ${repo}, pass repo "${repo}" to each tool. `);

/** forRepo for `project`, when the call named it with `repo`. */
export const forProject = (repo: string | undefined, project: Repo) => forRepo(repo === undefined ? undefined : repoArgument(project));

export const Snapshot = z.string().regex(/^[0-9a-f]{7,40}$/, 'a snapshot hash');

/** A result with a sentence for the model and the same facts as structured data, checked against the tool's output schema. */
export function dataResult<S extends z.ZodType>(_schema: S, text: string, data: z.infer<S>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}
