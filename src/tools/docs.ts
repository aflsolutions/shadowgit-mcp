import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { clientName } from '../client-name.js';
import { DocPiece, DocsCursor, DocsRead, DocsWritten, type DocKey, type DocWords } from '../doc-shapes.js';
import { resolveRepo } from '../repos.js';
import { readDocs, sendDocs, type AppDocWrite } from '../session-api.js';
import { andList, drawnFrom, list, plural } from './map.js';
import { quote } from './rules.js';
import { dataResult, forProject, repoParam, Snapshot } from './shared.js';

// The app's cursor for all is more here: next is the step that follows, in every tool's answer, and the model reads
// the structured answer alone
const DocsOutput = z.object({
  repo: z.string(),
  ...DocsRead.omit({ next: true }).shape,
  more: DocsCursor.nullable().describe('For all: the following batch, to pass back as more; null at the last'),
  next: z.string().optional().describe('The step that follows: write these pages with write_docs'),
});
const WrittenOutput = z.object({ repo: z.string(), ...DocsWritten.shape });

type Read = z.infer<typeof DocsRead>;
type Page = Read['pages'][number];
type Facts = NonNullable<Page['facts']>;
type Words = z.infer<typeof DocWords>;

const BOTH = 'Ask for all, or name areas and the overview: not both.';

/** A page as the answers name it: the Overview, or an area by its id. */
export const pageName = (key: z.infer<typeof DocKey>) => ('area' in key ? key.area : 'the Overview');

/** A paragraph as text, each link after its text as the app names it: a symbol in its file, or an area by its id. */
const paragraph = (pieces: readonly z.infer<typeof DocPiece>[]) =>
  pieces.map(({ text, symbol, area }) => (symbol ? `[${text}](${symbol.name} in ${symbol.file})` : area !== undefined ? `[${text}](area ${area})` : text)).join('');

function wordsLines(words: Words, indent = '  '): string[] {
  return [`${indent}Summary: ${words.summary}`, ...words.body.map((pieces) => `${indent}${paragraph(pieces)}`)];
}

function stateLine({ state, words, changes, countFailure }: Page): string {
  const by = words === null ? '' : `written by ${words.author} at ${words.at.slice(0, 8)}`;
  switch (state) {
    case 'no-words':
      return 'no words yet';
    case 'current':
      return `current: words ${by}`;
    case 'behind':
      return `${plural(changes?.count ?? 0, 'change')} since its words, ${by}`;
    case 'not-in-map':
      return `no longer in the map${by && `; words ${by}`}`;
    case 'not-counted':
      return `words ${by}; the changes since them could not be counted${countFailure === undefined ? '' : `: ${countFailure}`}`;
    default:
      // A state a newer app adds goes on as it is
      return by ? `${state}: words ${by}` : state;
  }
}

function factLines(facts: Facts): string[] {
  const links = (each: readonly { label: string; count: number }[]) => (each.length === 0 ? 'none' : each.map(({ label, count }) => `${label} (${count})`).join(', '));
  if ('folder' in facts) {
    return [
      `  Facts: folder ${facts.folder}; ${facts.files} files, ${facts.symbols} symbols; layers ${facts.layers.join(', ') || 'none'}.`,
      `  Depends on: ${links(facts.dependsOn)}. Depended on by: ${links(facts.dependedOnBy)}.`,
      ...(facts.processes.total > 0 ? [`  Processes: ${list(facts.processes, (process) => process)}.`] : []),
      ...(facts.mostDepended.total > 0
        ? [`  Most depended on: ${list(facts.mostDepended, ({ symbol, dependents }) => `${symbol.name} (${symbol.file}:${symbol.line}): ${dependents} dependents`, '; ')}.`]
        : []),
    ];
  }
  const { files, symbols, areas, calls, processes } = facts.counts;
  return [
    `  Facts: ${files} files, ${symbols} symbols, ${areas} areas, ${calls} calls, ${processes} processes.`,
    `  Layers: ${facts.layers.map((layer) => `${layer.name} (${layer.kind}, ${layer.files} files)`).join(', ')}.`,
    `  Areas: ${list(facts.areas, (area) => `${area.label} (area ${area.id}): ${area.files} files, ${area.symbols} symbols`, '; ')}.`,
    ...(facts.links.total > 0 ? [`  Links between areas: ${list(facts.links, ({ from, to, count }) => `${from.label} → ${to.label} (${count})`)}.`] : []),
    ...(facts.processes.total > 0 ? [`  Processes: ${list(facts.processes, ({ label, areas: through }) => `${label} (${through.join(' → ')})`, '; ')}.`] : []),
  ];
}

function changeLines(changes: NonNullable<Page['changes']>): string[] {
  const moved = (what: string, { added, removed }: { added: string[]; removed: string[] }) =>
    added.length + removed.length === 0 ? [] : [`  ${what} added: ${added.join(', ') || 'none'}; removed: ${removed.join(', ') || 'none'}.`];
  return [
    ...(changes.symbols.total > 0 ? ['  Symbols changed since the words:', list(changes.symbols, ({ name, path, change }) => `  - ${name} (${path}): ${change}`, '\n', 'symbols')] : []),
    ...changes.dependencies.map((sentence) => `  Dependency: ${sentence}`),
    ...(changes.goneLinks.length > 0 ? [`  Links of the words that name nothing now: ${changes.goneLinks.join('; ')}.`] : []),
    ...(changes.areas ? moved('Areas', changes.areas) : []),
    ...(changes.layers ? moved('Layers', changes.layers) : []),
  ];
}

function pageLines(page: Page): string[] {
  const name = 'area' in page.page ? `area ${page.page.area}` : 'the Overview';
  return [
    `Page ${quote(page.label)} (${name}): ${stateLine(page)}.`,
    ...(page.facts === null ? [] : factLines(page.facts)),
    ...(page.rules.length > 0 ? [`  The project's rules naming it: ${page.rules.map(quote).join(', ')}`] : []),
    ...(page.words === null ? [] : ['  Its words:', ...wordsLines(page.words.words, '    ')]),
    ...(page.changes === null ? [] : changeLines(page.changes)),
    ...(page.former ?? []).flatMap((former) => [`  Former page of area ${former.area}, whose files this area now holds:`, ...wordsLines(former.words, '    ')]),
  ];
}

/** Whether a page asks for words: a current one doesn't, and the map no longer holds an area whose page left it. */
const needsWords = ({ state }: Page) => state !== 'current' && state !== 'not-in-map';

/** The pages to write, named, at head, then the next batch of all; none when every page read is current. */
function writeStep({ head, limits, pages, next: more }: Read): string | undefined {
  const asked = pages.filter(needsWords);
  if (asked.length === 0) return undefined;
  const words = `for each page a summary of one sentence (at most ${limits.summary} characters) and a body of short paragraphs (at most ${limits.bodyWords} words) on what the code you read does, linking the symbols and areas it names; a page with no words can start short, from its facts and the code you read, and later sessions add to it; or holds: true where its words still hold`;
  const following = more === null ? '' : ` Then get_docs with more ${JSON.stringify(more)} for the next pages without words.`;
  // A first page needs no whole folder read: it says what the facts and the code read show, and grows with the work
  return `Write the words of ${andList(asked.map(({ page }) => pageName(page)))} with write_docs, head ${JSON.stringify(head)}: ${words}.${following}`;
}

function describeDocs(repo: string, read: Read, all: boolean, step: string | undefined): string {
  if (read.pages.length === 0) {
    return all ? `Every page of ${repo}'s map has words.` : `The latest AI session in ${repo} changed no area whose docs page needs words.`;
  }
  return [
    `${repo}'s docs pages, at snapshot ${read.head.slice(0, 8)}; the map is ${drawnFrom(read.mapAsOf)}`,
    ...read.pages.flatMap((page) => ['', ...pageLines(page)]),
    ...(step === undefined ? [] : ['', `Next: ${step}`]),
  ].join('\n');
}

export async function getDocs({
  areas = [],
  overview = false,
  all = false,
  more,
  repo,
}: {
  areas?: string[];
  overview?: boolean;
  all?: boolean;
  more?: z.infer<typeof DocsCursor>;
  repo?: string;
}): Promise<CallToolResult> {
  // more goes on from all's answer: it is a batch of all
  const batch = all || more !== undefined;
  if (batch && (areas.length > 0 || overview)) throw new Error(BOTH);
  const project = resolveRepo(repo);
  const read = await readDocs({ repoPath: project.path, areas, overview, all: batch, next: more });
  // Another project's steps name it: get_docs with more, or write_docs, without repo would read the current one
  const written = writeStep(read);
  const step = written === undefined ? undefined : `${forProject(repo, project)}${written}`;
  const { next: cursor, ...rest } = read;
  return dataResult(DocsOutput, describeDocs(project.name, read, batch, step), { repo: project.name, ...rest, more: cursor, ...(step !== undefined && { next: step }) });
}

/** A page as write_docs takes it: flat, for a model to fill. */
const PageInput = z.object({
  area: z.string().min(1).optional().describe("The area's id, as get_docs names it"),
  overview: z.boolean().optional().describe('The Overview page, in place of an area'),
  holds: z.boolean().optional().describe('The words the page has still hold: kept again at head, unchanged'),
  summary: z.string().optional().describe('One sentence on what the area is for'),
  body: z
    .array(z.union([z.string(), z.array(DocPiece)]))
    .optional()
    .describe('Short paragraphs on how it works: each plain text, or pieces, a piece linking a symbol (file and name) or an area (id) where its text names it'),
});

/** A page as the app takes it, or why it can't be sent. */
function appPage({ area, overview, holds, summary, body }: z.infer<typeof PageInput>, place: number): AppDocWrite {
  const page = `Page ${place + 1}`;
  if (area !== undefined && overview) throw new Error(`${page} names an area and the overview: name one.`);
  const key = overview ? { overview: true as const } : area !== undefined ? { area } : null;
  if (key === null) throw new Error(`${page} names no area and not the overview: name one.`);
  if (holds) {
    if (summary !== undefined || body !== undefined) throw new Error(`${page} sends words and holds: send one.`);
    return { ...key, holds: true };
  }
  if (summary === undefined || body === undefined) {
    throw new Error(`${page} sends neither words (a summary and a body) nor holds: send words, or holds: true where its words still hold.`);
  }
  // A plain paragraph is one piece of text
  return { ...key, words: { summary, body: body.map((pieces) => (typeof pieces === 'string' ? [{ text: pieces }] : pieces)) } };
}

export async function writeDocs({ head, pages, repo }: { head: string; pages: z.infer<typeof PageInput>[]; repo?: string }, author: string): Promise<CallToolResult> {
  const sent = pages.map(appPage);
  const project = resolveRepo(repo);
  const written = await sendDocs({ repoPath: project.path, head, author, pages: sent });
  const at = written.head.slice(0, 8);
  const kept = written.pages.filter((page) => page.kept);
  const left = written.pages.filter((page) => !page.kept);
  const text = [
    kept.length > 0 ? `ShadowGit keeps your words for ${andList(kept.map(({ page }) => pageName(page)))}, at snapshot ${at}.` : 'ShadowGit kept no words.',
    ...kept.flatMap(({ page, dropped }) => (dropped.length > 0 ? [`Made plain text in ${pageName(page)}, naming nothing at ${at}: ${dropped.join('; ')}.`] : [])),
    ...(left.length > 0 ? [`Left out: ${left.map(({ page, reason }) => `${pageName(page)}: ${reason}`).join('; ')}.`] : []),
  ].join(' ');
  return dataResult(WrittenOutput, text, { repo: project.name, ...written });
}

export function registerDocs(server: McpServer): void {
  server.registerTool(
    'get_docs',
    {
      title: 'Read docs pages',
      description:
        "Read the docs pages ShadowGit keeps for a tracked project: one per area of its map, plus an Overview, each written by an AI assistant. A page comes with the facts ShadowGit draws from the map (folder, sizes, layers, what it depends on and what depends on it, processes, its most depended-on symbols, the project's rules that name it), its words so far with who wrote them and at which snapshot, and what changed in the area since them: symbols changed in their code, dependency facts, links that no longer name anything. With no arguments: the pages the latest AI session changed whose words are missing or behind. With areas, and overview: those pages. With all: pages without words, largest area first, five at a time, with more for the following batch. Answers head, the snapshot write_docs keeps the words at, and next: write the pages' words with write_docs. Needs the ShadowGit app running.",
      inputSchema: z.object({
        areas: z.array(z.string().min(1)).max(20).optional().describe("Area ids, as get_docs names them: most are the area's folder, as get_map lists it"),
        overview: z.boolean().optional().describe('The Overview page, alone or with areas'),
        all: z.boolean().optional().describe('Pages without words, five at a time'),
        more: DocsCursor.optional().describe('The more get_docs answered with all, as given: the following batch'),
        repo: repoParam,
      }),
      outputSchema: DocsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    getDocs,
  );
  server.registerTool(
    'write_docs',
    {
      title: 'Write docs pages',
      description:
        "Write the words of docs pages get_docs read, at the head it answered. For each page, an area by its id or overview: true, then a summary, one sentence on what it is for (at most 200 characters), and a body, short paragraphs on how it works (at most 400 words), each paragraph text or pieces, a piece linking a symbol (its file and name, as get_docs and get_code_context name them) or an area by its id, where the text names it. Or holds: true, when the words still hold after the changes get_docs listed: they are kept again at head, unchanged. Describe what the code does and how it works, from the code you read and the facts get_docs gave: a page with no words can start short, and later sessions add to it. Links that name nothing at head are made plain text and named back. ShadowGit keeps every version in its own history, never in the project's files.",
      inputSchema: z.object({
        head: Snapshot.describe('The head get_docs answered'),
        pages: z.array(PageInput).min(1).max(10),
        repo: repoParam,
      }),
      outputSchema: WrittenOutput,
      // Destructive: words written for a page replace the ones it had
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, ctx) => writeDocs(args, clientName(server, ctx)),
  );
}
