import * as z from 'zod/v4';

// The app's map answers, as code-graph 0.6.0's map/query writes them: the package is private, so its shapes are
// mirrored here. Claude Code shows the model the structured answer alone, so each rule rides on its field.

/** A list as the app caps it: its first items, and how many there are in all. */
const listed = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().describe('How many there are in all; items holds the first of them') });

const AreaCount = z.object({ area: z.string(), count: z.number().int() });
const How = z.enum(['calls', 'imports', 'extends', 'implements', 'overrides']);
const SymbolRef = z.object({
  name: z.string(),
  kind: z.string(),
  file: z.string(),
  line: z.number().int().describe('1-based, as an editor shows it'),
  area: z.string().describe("The area's label, as ShadowGit's Map shows it"),
  layer: z.string(),
});
const UseRef = z.object({ symbol: SymbolRef, how: z.array(How) });
const DependentRef = z.union([
  UseRef,
  z.object({ file: z.string(), area: z.string(), how: z.array(How) }).describe('A file whose top-level code calls it, or that imports it'),
]);
const DEPENDENTS =
  'Code outside it that calls it, takes it as a base or imports it by name, and files whose top-level code calls it. ' +
  'Dynamic calls, reflection, string-built imports and test files are not counted. For a method or property, callers ' +
  'through a value whose type the map does not know are missing: its count is a floor.';
const Reach = z
  .object({ byHop: z.tuple([z.number().int(), z.number().int(), z.number().int()]), symbols: z.number().int(), files: z.number().int(), byArea: z.array(AreaCount) })
  .describe('The symbols and files within 3 hops of its callers, counted by hop and by area');

const SymbolContext = z.object({
  kind: z.literal('symbol'),
  target: z.string(),
  symbol: SymbolRef,
  uses: listed(UseRef).describe('What it calls, imports or takes as a base'),
  usesByArea: z.array(AreaCount),
  dependents: listed(DependentRef).describe(DEPENDENTS),
  dependentsByArea: z.array(AreaCount),
  reach: Reach,
  processes: listed(z.string()).describe('The processes (flows through the code) it is in'),
});
const FileContext = z.object({
  kind: z.literal('file'),
  target: z.string(),
  file: z.string(),
  area: z.string(),
  layer: z.string().nullable().describe('Null for a file that defines no symbol'),
  symbols: listed(SymbolRef),
  imports: listed(z.string()),
  importedBy: listed(z.string()).describe('Files that import it; test files are not counted'),
  dependentsByArea: z.array(AreaCount),
});
const AmbiguousTarget = z
  .object({ kind: z.literal('ambiguous'), target: z.string(), matches: listed(z.object({ file: z.string(), name: z.string().nullable(), line: z.number().int().nullable() })) })
  .describe('A name several symbols have: none is picked. Ask again with the file of the one meant');
const MissingTarget = z.object({
  kind: z.literal('missing'),
  target: z.string(),
  reason: z
    .enum(['test', 'folder', 'absent', 'language'])
    .nullable()
    .describe("test: tests are not on the map; folder: a folder, which get_map's area answers; absent: not in the map's snapshot; language: a language the map does not read"),
  near: z.array(z.string()).describe('Names on the map spelled close to it'),
});
const Landing = z
  .object({ areas: z.array(AreaCount), dependents: listed(DependentRef).describe(DEPENDENTS), dependentsByArea: z.array(AreaCount), reach: Reach })
  .describe('Where the targets land together: the areas they are in, and the code outside them that depends on them');

export const CodeContext = z.object({
  targets: z.array(z.discriminatedUnion('kind', [SymbolContext, FileContext, AmbiguousTarget, MissingTarget])),
  landing: Landing.nullable().describe('For two or more targets that resolve; null otherwise'),
});

export const MapSummary = z.object({
  repo: z.string(),
  commit: z.string(),
  counts: z.object({ files: z.number().int(), symbols: z.number().int(), areas: z.number().int(), calls: z.number().int(), processes: z.number().int() }),
  layers: z.array(z.object({ name: z.string(), kind: z.string(), files: z.number().int() })),
  areas: listed(z.object({ label: z.string(), path: z.string(), files: z.number().int(), symbols: z.number().int(), layers: z.array(z.string()) })).describe(
    'Largest first. An area is named by its label; its path is the folder it covers',
  ),
  links: listed(z.object({ from: z.string(), to: z.string(), count: z.number().int() })).describe('Calls and imports from one area into another, heaviest first'),
  processes: listed(z.object({ label: z.string(), areas: z.array(z.string()) })).describe('Flows through the code, each with the areas it passes through in order'),
});

export const AreaView = z.object({
  kind: z.literal('area'),
  target: z.string(),
  areas: z.array(z.string()).describe('The labels of the areas the label or folder covers'),
  files: listed(z.string()),
  symbols: z.number().int(),
  mostDepended: listed(z.object({ symbol: SymbolRef, dependents: z.number().int() })).describe('Its symbols something depends on, most dependents first'),
  dependsOn: z.array(AreaCount),
  dependedOnBy: z.array(AreaCount),
  processes: listed(z.string()),
});

export const MissingArea = z.object({ kind: z.literal('missing'), target: z.string(), near: z.array(z.string()).describe('Area labels spelled close to it') });

export const MapAsOf = z
  .object({
    snapshot: z.string(),
    time: z.string().describe("The snapshot's time, ISO 8601"),
    behind: z.number().int().describe('How many newer snapshots there are'),
    changedFiles: listed(z.string()).describe("Files changed since: their facts may differ from the newest snapshot's"),
  })
  .describe('The snapshot the answer is drawn from');
