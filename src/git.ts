import path from 'node:path';

export const ALLOWED_SUBCOMMANDS = [
  'log', 'show', 'diff', 'status', 'blame', 'shortlog', 'rev-list', 'rev-parse', 'ls-files', 'ls-tree', 'cat-file',
  'describe', 'show-branch',
] as const;

interface DeniedOptions {
  long: string[];
  /** Letters of short options; they bundle, so `-pO<file>` carries `-O<file>`. */
  short: string[];
  /** Real options a denied name starts with, which git never reads as abbreviations. */
  except?: string[];
}

/**
 * Options that make a subcommand read or write files outside the history (checked against git 2.47). The subcommand
 * comes first, so git's global options (-C, -c, --git-dir) never apply and need no entry. The revision walkers (log,
 * show, diff, rev-list, shortlog, blame) accept --output and -O, so those are refused for every subcommand.
 */
const DENIED_EVERYWHERE: DeniedOptions = { long: ['--output', '--orderfile'], short: ['O'] };

const DENIED: Record<string, DeniedOptions> = {
  diff: { long: ['--no-index'], short: [] },
  blame: { long: ['--contents', '--ignore-revs-file'], short: ['S'], except: ['--ignore-rev'] },
  'ls-files': { long: ['--exclude-from', '--exclude-per-directory'], short: ['X'], except: ['--exclude'] },
  'rev-parse': { long: ['--resolve-git-dir'], short: [] },
};

/** Splits a command line into arguments: whitespace separates, single or double quotes group. No shell is involved. */
export function tokenize(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArgument = false;
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inArgument = true;
    } else if (/\s/.test(char)) {
      if (inArgument) args.push(current);
      current = '';
      inArgument = false;
    } else {
      current += char;
      inArgument = true;
    }
  }
  if (quote) throw new Error('Unterminated quote in command.');
  if (inArgument) args.push(current);
  return args;
}

/** Why these git arguments are refused, or null when they may run. */
export function refusal(args: string[]): string | null {
  const [subcommand, ...options] = args;
  if (subcommand === undefined) return 'Empty command. Example: log --since="1 hour ago" --stat';
  if (!ALLOWED_SUBCOMMANDS.some((allowed) => allowed === subcommand)) {
    return `git ${subcommand} is not allowed. Allowed: ${ALLOWED_SUBCOMMANDS.join(', ')}.`;
  }
  const denied = DENIED[subcommand];
  const offending = options.find((arg) =>
    arg.startsWith('-')
      ? isDenied(arg, DENIED_EVERYWHERE) || (denied !== undefined && isDenied(arg, denied))
      : leavesProject(arg),
  );
  return offending
    ? `${offending.split('=')[0]} is refused: it reads or writes files outside the ShadowGit history.`
    : null;
}

/** A path outside the project: git diff compares such a path with --no-index by itself. Ranges like a..b pass. */
function leavesProject(arg: string): boolean {
  return path.isAbsolute(arg) || /(^|[\\/])\.\.([\\/]|$)/.test(arg);
}

function isDenied(option: string, denied: DeniedOptions): boolean {
  if (option.startsWith('--')) {
    const name = option.split('=')[0] ?? option;
    if (name.length <= 2 || denied.except?.includes(name)) return false;
    // git expands unambiguous abbreviations: blame --cont runs as --contents.
    return denied.long.some((long) => long.startsWith(name));
  }
  return option.startsWith('-') && denied.short.some((letter) => option.slice(1).includes(letter));
}
