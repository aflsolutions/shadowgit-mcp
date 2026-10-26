import type * as z from 'zod/v4';
import type { CheckpointRules, Range, Rule, RuleCheck } from '../rule-shapes.js';

// The project's rules as the tools' text says them: a rule "names" a link, quoted as its authors wrote it. Whether a
// link is wanted is the rule's to say, never these words'.

type Check = z.infer<typeof RuleCheck>;

/** "1a2b3c4d..5e6f7a8b", from the start of the history for a null base. */
export const snapshots = ({ base, head }: z.infer<typeof Range>) => `${base === null ? 'from the start' : base.slice(0, 8)}..${head.slice(0, 8)}`;

/** The rule as written, quoted, then its reason. */
export const ruleLine = ({ text, because }: z.infer<typeof Rule>) => `${JSON.stringify(text)}${because === null ? '' : ` because ${because}`}`;

const links = (count: number) => (count === 1 ? '1 link' : `${count} links`);

/** What the range does to the rules file; nothing when it leaves the file alone. */
function fileLines(file: Check['file']): string[] {
  if (file === null) return [];
  const quoted = (texts: string[]) => texts.map((text) => JSON.stringify(text)).join(', ');
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
      ...shown.map((link) => `  ${link}`),
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
        `The check against the project's rules (.shadowgit-rules) is still running, over snapshots ${snapshots(rules.range)}: read it with get_lens, passing base ${JSON.stringify(rules.range.base)} and head ${JSON.stringify(rules.range.head)}.`,
      ];
    case 'failed':
      return [`The project's rules (.shadowgit-rules) weren't checked: ${rules.error}`];
  }
}

/** Why the project's rules couldn't be read. */
export const failureLine = (failure: string) => `The project's rules (.shadowgit-rules) could not be read: ${failure}`;
