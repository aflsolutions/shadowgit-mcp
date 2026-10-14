import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientName } from '../client-name.js';
import { resolveRepo } from '../repos.js';
import { LensApplied, LensLimits, LensRange, LensSkeleton, readLens, sendLensWords, type LensWords } from '../session-api.js';
import { dataResult, repoParam } from './shared.js';

const LensOutput = z.object({ repo: z.string(), range: LensRange, lens: LensSkeleton.nullable(), limits: LensLimits });
const WordsOutput = z.object({ repo: z.string(), applied: LensApplied, ignored: z.array(z.string()) });

const LIMIT_NAMES: Record<string, string> = { summary: 'summary', stepTitle: 'step title', stepBody: 'step body', role: 'role', layerName: 'layer name', flowLabel: 'flow label' };

/** The lens as the model reads it: what to send back, then every step with its code, every card, layer and flow by id. */
function describeLens(repo: string, range: z.infer<typeof LensRange>, lens: z.infer<typeof LensSkeleton>, limits: Record<string, number>): string {
  const caps = Object.entries(limits).map(([key, max]) => `${LIMIT_NAMES[key] ?? key} ${max}`).join(', ');
  return [
    `The Lens of ${repo}, snapshots ${range.base === null ? 'from the start' : range.base.slice(0, 8)}..${range.head.slice(0, 8)}; its words now: ${lens.words.source}${lens.words.author ? ` (${lens.words.author})` : ''}.`,
    `Word it with write_lens_words, passing base ${range.base === null ? 'null' : `"${range.base}"`} and head "${range.head}": a summary of two sentences, for each step a title and one or two sentences, for each changed card the role it plays. Name only the ids below; text past its limit is cut (characters: ${caps}).`,
    '',
    ...lens.steps.flatMap((step) => [
      `Step ${step.id} "${step.title}": cards ${step.components.join(', ')}; files ${step.files.join(', ') || 'none'}`,
      ...(step.body ? [`  ${step.body}`] : []),
      '```diff',
      step.diff,
      '```',
    ]),
    'Cards:',
    ...lens.components.map((card) => `- ${card.id} ${card.name} (${card.kind}, ${card.context ? 'context, unchanged' : card.delta}) ${card.path}${card.role ? `: ${card.role}` : ''}`),
    'Layers:',
    ...lens.layers.map((layer) => `- ${layer.id} "${layer.name}"`),
    'Flows:',
    ...lens.flows.map((flow) => `- ${flow.id} ${flow.from} → ${flow.to} "${flow.label}"`),
  ].join('\n');
}

export async function getLens({ base, head, repo }: { base?: string | null; head?: string; repo?: string }): Promise<CallToolResult> {
  // A range is both its ends; leave both out for the latest AI session
  if ((head === undefined) !== (base === undefined)) throw new Error('Name base and head together (base null starts from the beginning of the history), or neither for the latest AI session.');
  const project = resolveRepo(repo);
  const read = await readLens({ repoPath: project.path, base, head });
  const data = { repo: project.name, ...read };
  if (read.lens === null) return dataResult(LensOutput, `Nothing in ${project.name}'s range ${read.range.head.slice(0, 8)} changes code: it has no lens to word.`, data);
  return dataResult(LensOutput, describeLens(project.name, read.range, read.lens, read.limits), data);
}

export async function writeLensWords(
  { base, head, repo, ...words }: { base: string | null; head: string; repo?: string } & LensWords,
  author: string,
): Promise<CallToolResult> {
  const project = resolveRepo(repo);
  const { applied, ignored } = await sendLensWords({ repoPath: project.path, base, head, author, words });
  const counts = [applied.summary && 'the summary', applied.steps && `${applied.steps} steps`, applied.components && `${applied.components} roles`, applied.layers && `${applied.layers} layers`, applied.flows && `${applied.flows} flows`].filter(Boolean);
  const text = [
    `ShadowGit's Lens shows your words for ${project.name}: ${counts.join(', ') || 'nothing new'}.`,
    ...(ignored.length > 0 ? [`Left out ids the lens does not hold: ${ignored.join(', ')}. Read them again with get_lens.`] : []),
  ].join(' ');
  return dataResult(WordsOutput, text, { repo: project.name, applied, ignored });
}

const Snapshot = z.string().regex(/^[0-9a-f]{7,40}$/i, 'a snapshot hash');

export function registerLens(server: McpServer): void {
  server.registerTool(
    'get_lens',
    {
      title: "Read a range's Lens",
      description:
        "Read ShadowGit's Lens of a range of snapshots, by default the latest AI session's: its steps with their code, the cards (components) and flows on its canvas, each with an id and its words so far. Read it at the end of a session, after the checkpoint, to word it with write_lens_words. Needs the ShadowGit app running.",
      inputSchema: z.object({
        base: Snapshot.nullable().optional().describe('The snapshot the range starts from, with head (null: the start of the history). Leave both out for the latest AI session'),
        head: Snapshot.optional().describe("The range's newest snapshot; leave out for the latest AI session"),
        repo: repoParam,
      }),
      outputSchema: LensOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => getLens(args),
  );
  server.registerTool(
    'write_lens_words',
    {
      title: "Write a range's Lens words",
      description:
        "Write the words the user reads in ShadowGit's Lens for a range get_lens read: a summary, each step's title and body, each card's role, by the ids get_lens gave. Plain text; text past its limit is cut; unknown ids are left out. The app keeps the words in its history: a card's role shows in any later range while its code is unchanged.",
      inputSchema: z.object({
        base: Snapshot.nullable().describe('The base get_lens answered (null: from the start of the history)'),
        head: Snapshot.describe('The head get_lens answered'),
        summary: z.string().optional().describe('What the change does and why, in two sentences'),
        steps: z.array(z.object({ id: z.string(), title: z.string().optional(), body: z.string().optional() })).optional().describe('Per step: a title naming what it does, and one or two sentences'),
        components: z.array(z.object({ id: z.string(), role: z.string() })).optional().describe('Per changed card: the role it plays, in a few words'),
        layers: z.array(z.object({ id: z.string(), name: z.string() })).optional().describe('Per layer: a short name, where the default does not say where code runs'),
        flows: z.array(z.object({ id: z.string(), label: z.string() })).optional().describe('Per flow: a verb phrase, e.g. "draws a range"'),
        repo: repoParam,
      }),
      outputSchema: WordsOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => writeLensWords(args, clientName(server, ctx)),
  );
}
