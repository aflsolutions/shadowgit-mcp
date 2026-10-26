import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientName } from '../client-name.js';
import { resolveRepo } from '../repos.js';
import { LensLines, LensRead, readLens, sendLensWords, WordsWritten, type LensWords } from '../session-api.js';
import { checkLines, failureLine, quote, snapshots } from './rules.js';
import { dataResult, repoParam } from './shared.js';

const LensOutput = z.object({ repo: z.string(), ...LensRead.shape });
const WordsOutput = z.object({ repo: z.string(), ...WordsWritten.shape });
const Snapshot = z.string().regex(/^[0-9a-f]{7,40}$/, 'a snapshot hash');

type Read = z.infer<typeof LensRead>;
type LensSymbol = NonNullable<NonNullable<Read['lens']>['steps'][number]['symbols']>[number];
type LensDependencies = NonNullable<Read['lens']>['dependencies'];

// code-graph's EXCERPT_MAX_LINES: the app leaves out a longer excerpt
const EXCERPT_MAX_LINES = 12;

/** A step's symbol as an excerpt names it: by its path on a side, so a renamed file's base gives its former path. */
function symbolLine({ name, path, basePath, base, head }: LensSymbol): string {
  const sides = [
    head && `head ${head.start}–${head.end}`,
    base && `base ${basePath !== null && basePath !== path ? `${basePath} ` : ''}${base.start}–${base.end}`,
  ].filter(Boolean);
  return `\`${name}\` (${path}, ${sides.join('; ')})`;
}

/** A fact as the Lens lists it under the summary: its sentence, its folders and steps beside it, then its links. */
function factLines({ sentence, from, to, evidence, steps }: NonNullable<LensDependencies>['facts'][number]): string[] {
  const folders = from.path !== null && to.path !== null ? `${from.path} → ${to.path}` : null;
  const beside = [folders, steps.length > 0 ? `steps ${steps.join(', ')}` : null].filter(Boolean).join('; ');
  return [`- ${sentence}${beside ? ` (${beside})` : ''}`, ...evidence.map((link) => `  ${link}`)];
}

/** What the range makes depend on what; nothing for an app that sends no facts. */
function dependencyLines(dependencies: LensDependencies): string[] {
  if (!dependencies?.facts.length) return [];
  return ['Dependencies:', ...dependencies.facts.flatMap(factLines), ...(dependencies.more > 0 ? [`- and ${dependencies.more} more`] : [])];
}

/** The range's check against the project's rules, or why they couldn't be read; nothing for a project without them. */
function rulesLines({ rules, rulesFailure }: Pick<Read, 'rules' | 'rulesFailure'>): string[] {
  if (rulesFailure !== undefined) return [failureLine(rulesFailure)];
  return rules ? checkLines(rules) : [];
}

/** The lens as the model reads it: what to send back, then every step with its code, every card, layer and flow by id. */
function describeLens(repo: string, { range, lens, limits, ...rules }: Read & { lens: NonNullable<Read['lens']> }): string {
  // stepTitle reads "step title"
  const caps = Object.entries(limits).map(([key, max]) => `${key.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)} ${max}`).join(', ');
  return [
    `The Lens of ${repo}, snapshots ${snapshots(range)}; its words now: ${lens.words.source}${lens.words.author ? ` (${lens.words.author})` : ''}.`,
    ...(lens.summary ? [`Summary: ${lens.summary}`] : []),
    `Word it with write_lens_words, passing base ${JSON.stringify(range.base)} and head ${JSON.stringify(range.head)}: a summary of two sentences, for each step a title and one or two sentences, for each changed card the role it plays. Name only the ids below; text past its limit is cut (characters: ${caps}).`,
    ...(lens.quotes?.length ? ['Checkpoint messages a why may quote:', ...lens.quotes.map((quote) => `- ${JSON.stringify(quote)}`)] : []),
    ...rulesLines(rules),
    ...dependencyLines(lens.dependencies),
    '',
    ...lens.steps.flatMap((step) => {
      // Longer than any backtick run in the diff: a Markdown file's own fence would close a shorter one
      const fence = '`'.repeat(Math.max(3, ...[...step.diff.matchAll(/`+/g)].map(([run]) => run.length + 1)));
      return [
        `Step ${step.id} "${step.title}": cards ${step.components.join(', ')}; files ${step.files.join(', ') || 'none'}`,
        ...(step.symbols?.length ? [`  Symbols: ${step.symbols.map(symbolLine).join(', ')}`] : []),
        ...(step.dependencies?.length ? [`  Dependencies: ${step.dependencies.join('; ')}`] : []),
        ...(step.rules?.length ? [`  Rules that name its links: ${step.rules.map(quote).join(', ')}`] : []),
        ...(step.body ? [`  ${step.body}`] : []),
        `${fence}diff`,
        step.diff,
        fence,
      ];
    }),
    'Cards:',
    ...lens.components.map((card) => `- ${card.id} ${card.name} (${card.kind}, ${card.context ? 'context, unchanged' : card.delta}) ${card.path}${card.role ? `: ${card.role}` : ''}`),
    'Layers:',
    ...lens.layers.map((layer) => `- ${layer.id} "${layer.name}"`),
    'Flows:',
    ...lens.flows.map((flow) => `- ${flow.id} ${flow.from} → ${flow.to} "${flow.label}"`),
  ].join('\n');
}

export async function getLens({ base, head, repo }: { base?: string | null; head?: string; repo?: string }): Promise<CallToolResult> {
  if ((head === undefined) !== (base === undefined)) throw new Error('Name base and head together (base null starts from the beginning of the history), or neither for the latest AI session.');
  const project = resolveRepo(repo);
  const read = await readLens({ repoPath: project.path, base, head });
  const data = { repo: project.name, ...read };
  const { lens } = read;
  if (lens === null) {
    const nothing = `Nothing in ${project.name}'s range ${read.range.head.slice(0, 8)} changes code: it has no lens to word.`;
    return dataResult(LensOutput, [nothing, ...rulesLines(read)].join('\n'), data);
  }
  return dataResult(LensOutput, describeLens(project.name, { ...read, lens }), data);
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

export function registerLens(server: McpServer): void {
  server.registerTool(
    'get_lens',
    {
      title: "Read a range's Lens",
      description:
        "Read ShadowGit's Lens of a range of snapshots, by default the latest AI session's: its steps with their code, the cards (components) and flows on its canvas, each with an id and its words so far; what the range makes depend on what: each new, gone or two-way dependency between the project's areas and layers, with the links that make it and the steps that hold it; and each of the project's rules (.shadowgit-rules) that names a link the range adds, with its reason, links and steps, also for a range with no Lens. Read it at the end of a session, after the checkpoint, to word it with write_lens_words; your words may say why a dependency appeared, or why a link a rule names is there: say the rule names it, and quote the rule. Needs the ShadowGit app running.",
      inputSchema: z.object({
        base: Snapshot.nullable().optional().describe('The snapshot the range starts from, with head (null: the start of the history). Leave both out for the latest AI session'),
        head: Snapshot.optional().describe("The range's newest snapshot; leave out for the latest AI session"),
        repo: repoParam,
      }),
      outputSchema: LensOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    getLens,
  );
  server.registerTool(
    'write_lens_words',
    {
      title: "Write a range's Lens words",
      description:
        "Write the words the user reads in ShadowGit's Lens for a range get_lens read: a summary, each step's title and body, with a why and an excerpt, each card's role, by the ids get_lens gave. An older ShadowGit takes plain text alone; text past its limit is cut; unknown ids are left out. The app keeps the words in its history: a card's role shows in any later range while its code is unchanged.",
      inputSchema: z.object({
        base: Snapshot.nullable().describe('The base get_lens answered (null: from the start of the history)'),
        head: Snapshot.describe('The head get_lens answered'),
        summary: z.string().optional().describe('What the change does and why, in two sentences'),
        steps: z
          .array(z.object({
            id: z.string(),
            title: z.string().optional(),
            body: z
              .union([z.string(), z.array(z.object({ text: z.string(), card: z.string().optional() }))])
              .optional()
              .describe("One or two sentences: plain text, or pieces, where a piece with a card links that card of the step by its id, only where the text names it"),
            why: z
              .object({ quote: z.string(), source: z.literal('commit') })
              .optional()
              .describe("Why, in the author's own words: one of get_lens's quotes, or part of one, word for word, within the why limit (a longer quote is left out, not cut); left out where none says why"),
            excerpt: z
              .object({ path: z.string(), name: z.string(), side: z.enum(['base', 'head']), lines: LensLines })
              .optional()
              .describe(`At most ${EXCERPT_MAX_LINES} lines that changed, of one of the step's symbols as get_lens lists them: its path on that side, its name, the side and the lines`),
          }))
          .optional()
          .describe("Per step: a title naming what it does, and its words; a step's entry replaces everything written for that step before, so send its title, body, why and excerpt together"),
        components: z.array(z.object({ id: z.string(), role: z.string() })).optional().describe('Per changed card: the role it plays, in a few words'),
        layers: z.array(z.object({ id: z.string(), name: z.string() })).optional().describe('Per layer: a short name, where the default does not say where code runs'),
        flows: z.array(z.object({ id: z.string(), label: z.string() })).optional().describe('Per flow: a verb phrase, e.g. "draws a range"'),
        repo: repoParam,
      }),
      outputSchema: WordsOutput,
      // Destructive: words written for an id replace the ones it had
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => writeLensWords(args, clientName(server, ctx)),
  );
}
