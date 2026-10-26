import * as z from 'zod/v4';

// The project's rules as the app sends them: code-graph 0.8.0's rule shapes (lens/rule-checks) and the app's agent
// check (electron/code-graph/lens-agent.ts), mirrored as the map shapes are. A rule's form is an open string, which a
// newer app may add to.

/** A range of snapshots: a null base is the start of the history. */
export const Range = z.object({ base: z.string().nullable(), head: z.string() });

/** A rule as read from the project's .shadowgit-rules. */
export const Rule = z.object({
  line: z.number().int(),
  text: z.string().describe('The rule as written, without its reason'),
  form: z.string().describe('never, only or nothing'),
  from: z.array(z.string()).describe('The names on its first side; none for a nothing-rule'),
  to: z.array(z.string()),
  because: z.string().nullable().describe('Its reason, as written after "because"'),
});

/** The project's .shadowgit-rules as read: its rules, the lines that are none, and where reading stopped. */
export const RulesRead = z.object({
  rules: z.array(Rule),
  unread: z.array(z.object({ line: z.number().int(), text: z.string() })).describe('Lines read as no rule, as written'),
  cutAt: z.number().int().nullable().describe('The first line left unread past 100 rules or 64 KB'),
});

/** A range checked against the rules: each rule that names links it adds, and what it does to the rules file. */
export const RuleCheck = z.object({
  rules: z.number().int().describe('How many rules it was checked against'),
  matches: z.array(z.object({
    rule: Rule,
    count: z.number().int().describe('How many links the range adds that the rule names'),
    links: z.array(z.string()).describe('The first links, in words; count has them all'),
    steps: z.array(z.string()).describe('The ids of the steps that hold them'),
  })),
  file: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).nullable().describe(
    'The rules the range adds to and removes from .shadowgit-rules; null when it leaves the file alone',
  ),
});

/** The rules that hold for files asked about, each with those files. */
export const RulesFor = z.array(z.object({ rule: Rule, files: z.array(z.string()) }));

/** Why the project's rules couldn't be read: sent only then, and never by an app older than the rules. */
export const RulesFailure = z.string().optional().describe("Why the project's rules couldn't be read");

/** A checkpoint's check: of the session so far, or else of the checkpoint's own change. */
export const CheckpointRules = z.discriminatedUnion('status', [
  z.object({ status: z.literal('checked'), range: Range, check: RuleCheck }),
  z.object({ status: z.literal('running'), range: Range.describe('Read its check with get_lens, passing this base and head') }),
  z.object({ status: z.literal('failed'), range: Range.nullable(), error: z.string() }),
]);
