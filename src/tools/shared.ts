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

/** "1 file", "2 files", "3 processes". */
export const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : noun.endsWith('s') ? `${noun}es` : `${noun}s`}`;

/** "a, b and c". */
export const andList = (words: readonly string[]) => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

export type Listed<T> = { items: readonly T[]; total: number };

/** A capped list as text: its items, then how many more there are, of `noun` when given. */
export function list<T>({ items, total }: Listed<T>, show: (item: T) => string, separator = ', ', noun?: string): string {
  const more = total - items.length;
  if (more <= 0) return items.map(show).join(separator);
  return `${items.map(show).join(separator)} …and ${noun === undefined ? `${more} more` : plural(more, `more ${noun}`)}`;
}

export const Snapshot = z.string().regex(/^[0-9a-f]{7,40}$/, 'a snapshot hash');

/** A result with a sentence for the model and the same facts as structured data, checked against the tool's output schema. */
export function dataResult<S extends z.ZodType>(_schema: S, text: string, data: z.infer<S>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: data };
}
