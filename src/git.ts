import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SHADOWGIT_DIR = '.shadowgit.git';
const OUTPUT_LIMIT = 25_000;
const MAX_BUFFER = 1024 * 1024;

const MAX_TIMEOUT_MS = 2_147_483_647; // a larger delay makes Node fire the timeout after 1 ms

/** SHADOWGIT_TIMEOUT in milliseconds. Anything but an integer Node accepts as a delay falls back to 10 s. */
function timeoutMs(): number {
  const value = Number(process.env.SHADOWGIT_TIMEOUT);
  return Number.isInteger(value) && value >= 1 && value <= MAX_TIMEOUT_MS ? value : 10_000;
}

/** exitCode is git's own: non-zero with an ok result means git reported a finding (diff --exit-code, cat-file -e), not a failure. */
type GitResult = { ok: true; stdout: string; overflowed: boolean; exitCode: number } | { ok: false; error: string };

const ALLOWED_SUBCOMMANDS = [
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
 * Options that make a subcommand read or write files outside the history, or run helper commands from git's
 * configuration (checked against git 2.47). The subcommand comes first, so git's global options (-C, -c, --git-dir)
 * never apply and need no entry. These are refused for every subcommand:
 * - --output and -O (revision walkers: log, show, diff, rev-list, shortlog, blame);
 * - --ext-diff, --textconv and --filters (the diff machinery of log, show, diff and blame; cat-file takes the last two);
 * - --submodule (diff, log, show) and --recurse-submodules (ls-files), which open a submodule's repository, and that
 *   can live anywhere.
 * --text (treat files as text) and --filter (object filtering) are real options there; only cat-file reads them as
 * abbreviations, and it has its own entry below.
 */
const DENIED_EVERYWHERE: DeniedOptions = {
  long: ['--output', '--orderfile', '--ext-diff', '--textconv', '--filters', '--submodule', '--recurse-submodules'],
  short: ['O'],
  except: ['--text', '--filter'],
};

const DENIED: Record<string, DeniedOptions> = {
  'cat-file': { long: ['--textconv', '--filters'], short: [] },
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

/**
 * Why these git arguments are refused, or null when they may run. Options are checked first. Then every argument is
 * checked as a path, because after `--` git reads even a `-foo` name as one.
 */
export function refusal(args: string[]): string | null {
  const [subcommand, ...options] = args;
  if (subcommand === undefined) return 'Empty command. Example: log --since="1 hour ago" --stat';
  if (!ALLOWED_SUBCOMMANDS.some((allowed) => allowed === subcommand)) {
    return `git ${subcommand} is not allowed. Allowed: ${ALLOWED_SUBCOMMANDS.join(', ')}.`;
  }
  const help = options.find(isHelp);
  if (help !== undefined) return `${help} is refused: it opens git's manual instead of answering.`;
  const denied = DENIED[subcommand];
  const option = options.find(
    (arg) =>
      arg.startsWith('-') && (isDenied(arg, DENIED_EVERYWHERE) || (denied !== undefined && isDenied(arg, denied))),
  );
  if (option !== undefined) {
    return `${option.split('=')[0]} is refused: it reads or writes files outside the ShadowGit history.`;
  }
  const outside = options.find(leavesProject);
  if (outside === undefined) return null;
  return `${outside} is refused: it names a path outside the project. If it is an option's value, attach it to the option (--grep=/api, -L/^func/,/^}/).`;
}

/**
 * A path outside the project: git diff compares such a path with --no-index by itself. Checked on every argument, option
 * or not. Ranges like a..b pass. Windows drive-qualified paths (C:\x, C:/x, and drive-relative C:file) are refused too; a
 * revision on a one-letter branch such as a:file is refused as a false positive.
 */
function leavesProject(arg: string): boolean {
  return path.isAbsolute(arg) || /(^|[\\/])\.\.([\\/]|$)/.test(arg) || /^[A-Za-z]:/.test(arg);
}

/** `--help` or an abbreviation of it (--he, --hel): git opens its manual, in a browser on Git for Windows and in man elsewhere. */
function isHelp(arg: string): boolean {
  return arg.length >= 4 && arg.startsWith('--') && '--help'.startsWith(arg);
}

function isDenied(option: string, denied: DeniedOptions): boolean {
  if (option.startsWith('--')) {
    const name = option.split('=')[0] ?? option;
    if (name.length <= 2 || denied.except?.includes(name)) return false;
    // git expands unambiguous abbreviations: blame --cont runs as --contents.
    return denied.long.some((long) => long.startsWith(name));
  }
  return denied.short.some((letter) => option.slice(1).includes(letter));
}

/**
 * Settings the server fixes whatever the history's own config says (-c outranks it). The history is data the server
 * did not write, and a config line must not reach beyond it or run a program.
 */
const GIT_SETTINGS = [
  // With core.autocrlf=true (Git for Windows' default) a diff that exits 1 also warns on stderr, which would hide it.
  'core.safecrlf=false',
  // A program named here runs on status, diff and ls-files.
  'core.fsmonitor=false',
  // git's defaults. A config can switch on opening submodule repositories, which can live outside the project.
  'diff.submodule=short',
  'submodule.recurse=false',
].flatMap((setting) => ['-c', setting]);

/** Runs git on a project's ShadowGit history. The arguments go to git as they are; no shell is involved. */
export function runGit(projectPath: string, args: string[]): Promise<GitResult> {
  const timeout = timeoutMs();
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      [...GIT_SETTINGS, `--git-dir=${path.join(projectPath, SHADOWGIT_DIR)}`, `--work-tree=${projectPath}`, ...args],
      {
        cwd: projectPath,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
        timeout,
        windowsHide: true,
        // GIT_OPTIONAL_LOCKS=0: status must not rewrite the index the app stages snapshots into.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout, overflowed: false, exitCode: 0 });
        // Node killed git, so there is no exit status; the truncation note tells the story.
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return resolve({ ok: true, stdout, overflowed: true, exitCode: 0 });
        if (error.code === 'ENOENT') {
          // Node reports a missing cwd as `spawn git ENOENT` too, so look at which of the two is missing.
          return resolve({
            ok: false,
            error: fs.existsSync(projectPath) ? 'git is not installed or not on PATH.' : `The project folder ${projectPath} no longer exists.`,
          });
        }
        if (error.killed) {
          return resolve({ ok: false, error: `git took longer than ${timeout / 1000} s. Narrow the command with -n, --since or a path.` });
        }
        // A non-zero exit with nothing on stderr is git reporting a result (diff --exit-code found differences).
        if (typeof error.code === 'number' && !stderr.trim()) return resolve({ ok: true, stdout, overflowed: false, exitCode: error.code });
        // A signal we did not send (the OOM killer, a crash) leaves partial output that must not pass for a result.
        if (error.signal) return resolve({ ok: false, error: `git was stopped by ${error.signal} before it finished.` });
        resolve({ ok: false, error: stderr.trim().slice(0, 2_000) || error.message });
      },
    );
    // --stdin and --batch would otherwise wait for input until the timeout.
    child.stdin?.end();
  });
}

/** git output as the model gets it: at most OUTPUT_LIMIT characters, with a note first when cut. */
export function capOutput(stdout: string, overflowed: boolean): string {
  if (!overflowed && stdout.length <= OUTPUT_LIMIT) return stdout === '' ? '(no output)' : stdout;
  const total = overflowed ? 'more than 1 MB' : `${stdout.length.toLocaleString('en-US')} characters`;
  return `[Truncated: showing the first ${OUTPUT_LIMIT.toLocaleString('en-US')} characters of ${total}. Narrow it with -n, --since, --stat or a path.]\n${stdout.slice(0, OUTPUT_LIMIT)}`;
}
