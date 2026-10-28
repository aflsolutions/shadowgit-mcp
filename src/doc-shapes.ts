import * as z from 'zod/v4';
import { listed, MapAsOf, MapSummary, SymbolRef } from './map-shapes.js';

// The app's docs answers: code-graph 0.9.1's page facts and words (docs/facts, docs/words) and the app's pages for an
// agent (electron/code-graph/docs-agent.ts), mirrored as the map shapes are. A page's state and a symbol's change are
// open strings, which a newer app may add to.

/** A page: an area of the map by its id, or the Overview. */
export const DocKey = z.union([z.object({ area: z.string() }), z.object({ overview: z.literal(true) })]);

/** A run of a paragraph: plain text, or text linking a symbol (its file and name) or an area (its id). */
export const DocPiece = z.object({
  text: z.string(),
  symbol: z.object({ file: z.string(), name: z.string() }).optional(),
  area: z.string().optional(),
});
export const DocWords = z.object({ summary: z.string(), body: z.array(z.array(DocPiece)).describe('Paragraphs, each its pieces') });

const DocRecord = z.object({
  version: z.number().int(),
  words: DocWords,
  author: z.string(),
  at: z.string().describe('The snapshot the words were written at'),
  time: z.string().describe('When, ISO 8601'),
  then: z.object({ areas: z.array(z.string()), layers: z.array(z.string()) }).optional().describe("The Overview's: the map's area ids and layer names at the time"),
});

const AreaEnd = z.object({ id: z.string(), label: z.string() });
const AreaLink = z.object({ ...AreaEnd.shape, count: z.number().int() });
const AreaFacts = z.object({
  ...AreaEnd.shape,
  folder: z.string(),
  at: z.string().describe('The snapshot of the map the facts are drawn from'),
  layers: z.array(z.string()),
  files: z.number().int(),
  symbols: z.number().int(),
  dependsOn: z.array(AreaLink),
  dependedOnBy: z.array(AreaLink),
  processes: listed(z.string()),
  mostDepended: listed(z.object({ symbol: SymbolRef, dependents: z.number().int() })),
});
const OverviewFacts = z.object({
  at: z.string(),
  counts: MapSummary.shape.counts,
  layers: MapSummary.shape.layers,
  areas: listed(z.object({ ...AreaEnd.shape, path: z.string(), files: z.number().int(), symbols: z.number().int(), layers: z.array(z.string()) })),
  links: listed(z.object({ from: AreaEnd, to: AreaEnd, count: z.number().int() })),
  processes: MapSummary.shape.processes,
});

const AddedRemoved = z.object({ added: z.array(z.string()), removed: z.array(z.string()) });
const DocChanges = z.object({
  count: z.number().int(),
  symbols: listed(z.object({ name: z.string(), path: z.string(), change: z.string().describe('code, runtime or exports') })),
  dependencies: z.array(z.string()).describe('The dependency facts naming the area, in words'),
  goneLinks: z.array(z.string()).describe('Links of the words that name nothing now'),
  areas: AddedRemoved.optional().describe("The Overview's: areas the map gained and lost"),
  layers: AddedRemoved.optional(),
});

const DocPage = z.object({
  page: DocKey,
  label: z.string(),
  state: z.string().describe('no-words, current, behind, not-in-map or not-counted'),
  facts: z.union([AreaFacts, OverviewFacts]).nullable().describe('Null for a page no longer in the map'),
  rules: z.array(z.string()).describe("The project's rules naming the area, as written"),
  words: DocRecord.nullable(),
  changes: DocChanges.nullable().describe('What changed since the words; null without words or a count'),
  countFailure: z.string().optional().describe("Why the changes couldn't be counted"),
  former: z.array(z.object({ area: z.string(), words: DocWords })).optional().describe("Pages no longer in the map whose files the area now holds, with their words"),
});

/** Where "all" goes on: a place in the pages' order, and the map it was read off. */
export const DocsCursor = z.object({ after: z.number().int(), map: z.string() });

export const DocsRead = z.object({
  head: z.string().describe('The newest snapshot, which write_docs keeps the words at'),
  mapAsOf: MapAsOf,
  pages: z.array(DocPage),
  next: DocsCursor.nullable().describe('For all: the next batch, to pass back whole; null at the last'),
  limits: z.object({ summary: z.number().int().describe('Characters'), bodyWords: z.number().int().describe('Words') }),
});

export const DocsWritten = z.object({
  head: z.string(),
  pages: z.array(z.union([
    z.object({ page: DocKey, kept: z.literal(true), dropped: z.array(z.string()).describe('Links made plain text, naming nothing at head') }),
    z.object({ page: DocKey, kept: z.literal(false), reason: z.string() }),
  ])),
});
