import type * as z from 'zod/v4';
import type { CheckpointRules, Range, Rule, RuleCheck, RulesFor, RulesRead } from '../rule-shapes.js';

// The project's rules as the tools' text says them: a rule "names" a link, quoted as its authors wrote it. Whether a
// link is wanted is the rule's to say, never these words'. Every text from the project (a rule, its reason, a link's
// paths, an error naming a file) is quoted: a cloned project's file is its author's, and a line break in it must
// never stand as a line of ShadowGit's own.

const quote = (text: string) => JSON.stringify(text);

type Check = z.infer<typeof RuleCheck>;

/** "1a2b3c4d..5e6f7a8b", from the start of the history for a null base. */
export const snapshots = ({ base, head }: z.infer<typeof Range>) => `${base === null ? 'from the start' : base.slice(0, 8)}..${head.slice(0, 8)}`;

/** The rule as written, quoted, then its reason. */
export const ruleLine = ({ text, because }: z.infer<typeof Rule>) => `${quote(text)}${because === null ? '' : ` because ${quote(because)}`}`;

const links = (count: number) => (count === 1 ? '1 link' : `${count} links`);

/** What the range does to the rules file; nothing when it leaves the file alone. */
function fileLines(file: Check['file']): string[] {
  if (file === null) return [];
  const quoted = (texts: string[]) => texts.map(quote).join(', ');
  const parts = [file.added.length > 0 && `adds ${quoted(file.added)}`, file.removed.length > 0 && `removes ${quoted(file.removed)}`].filter(Boolean);
  return [parts.length === 0 ? '- This range changes .shadowgit-rules.' : `- This range changes .shadowgit-rules: ${parts.join(', ')}.`];
}

/** The rules that name no link the range adds: all of them, or the others. */
function quietLines(check: Check): string[] {
  const left = check.rules - check.matches.length;
  if (left <= 0) return [];
  if (check.matches.length === 0) return ['- No rule names a link this range adds.'];
  return [`- ${left === 1 ? 'The other rule names' : `The other ${left} rules name`} no link this range adds.`];
}

/** A range's check: how many rules, each that names links the range adds with those links, the rest, the file's changes. */
export function checkLines(check: Check, range?: z.infer<typeof Range>): string[] {
  return [
    `The project's rules (.shadowgit-rules): ${check.rules} checked${range === undefined ? '' : `, over snapshots ${snapshots(range)}`}.`,
    ...check.matches.flatMap(({ rule, count, links: shown, steps }) => [
      `- ${ruleLine(rule)}: names ${links(count)} this range adds${steps.length > 0 ? ` (steps ${steps.join(', ')})` : ''}`,
      ...shown.map((link) => `  ${quote(link)}`),
      ...(count > shown.length ? [`  and ${count - shown.length} more`] : []),
    ]),
    ...quietLines(check),
    ...fileLines(check.file),
  ];
}

/** A checkpoint's check: its lines, that it still runs and where get_lens reads it, or why it didn't run. */
export function checkpointLines(rules: z.infer<typeof CheckpointRules>): string[] {
  switch (rules.status) {
    case 'checked':
      return checkLines(rules.check, rules.range);
    case 'running':
      return [
        `The check against the project's rules (.shadowgit-rules) is still running, over snapshots ${snapshots(rules.range)}: read it with get_lens, passing base ${JSON.stringify(rules.range.base)} and head ${quote(rules.range.head)}.`,
      ];
    case 'failed':
      return [`The project's rules (.shadowgit-rules) weren't checked: ${quote(rules.error)}`];
  }
}

/** Why the project's rules couldn't be read. */
export const failureLine = (failure: string) => `The project's rules (.shadowgit-rules) could not be read: ${quote(failure)}`;

/** The project's rules as read, with the lines read as none and where reading stopped; nothing without a file. */
export function readLines(read: z.infer<typeof RulesRead> | null | undefined, failure?: string): string[] {
  if (failure !== undefined) return [failureLine(failure)];
  if (!read) return [];
  if (read.rules.length === 0 && read.unread.length === 0) return ["The project's .shadowgit-rules holds no rule."];
  return [
    "The project's rules, from its .shadowgit-rules:",
    ...read.rules.map((rule) => `- line ${rule.line}: ${ruleLine(rule)}`),
    ...read.unread.map(({ line, text }) => `- line ${line} is no rule: ${quote(text)}`),
    ...(read.cutAt === null ? [] : [`- From line ${read.cutAt} on, nothing was read: past 100 rules or 64 KB.`]),
  ];
}

/** The rules that hold for the files asked about, each with those files; nothing when none holds. */
export function holdLines(rules: z.infer<typeof RulesFor> | null | undefined, failure?: string): string[] {
  if (failure !== undefined) return [failureLine(failure)];
  if (!rules?.length) return [];
  return ["The project's rules (.shadowgit-rules) that hold for these files:", ...rules.map(({ rule, files }) => `- ${ruleLine(rule)}: ${files.map(quote).join(', ')}`)];
}
