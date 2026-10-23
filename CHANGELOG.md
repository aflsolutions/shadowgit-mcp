# Changelog

All notable changes to the ShadowGit MCP Server will be documented in this file.

## [2.4.0] - 2026-10-23

### Added
- `get_lens` says what the range makes depend on what: each new, gone or two-way dependency between the project's
  areas and layers ("jobs depends on api for the first time"), the links that make it ("dailyReport
  (src/jobs/report.ts:4) calls countUsers (src/api/users.ts:15)") and the steps that hold it, and each step's own.
  Its description says so, and that the assistant's words may say why a dependency appeared. They are facts, as
  ShadowGit words them: whether a dependency is wanted is not said. With the new description the unprompted Lens
  flow still ran in 5 of 5 runs (`npm run eval:lens`).

### Changed
- Every reader of ShadowGit's answers (sessions, checkpoints, the Lens and its words, as the map already did) asks
  for a server update when the app answers in a shape this version doesn't read, in place of a parse error.

The facts need a ShadowGit release after 0.3.10; an older app sends none, and `get_lens` reads as before.

## [2.3.0] - 2026-10-22

### Added
- `get_map` gives how a project is organised, from ShadowGit's map of it: its counts, layers, areas largest first,
  the calls and imports between areas, and its processes; with `area`, one area's files, its symbols most depended
  on, and the areas around it. Each answer names the snapshot it is drawn from and how far behind the newest it is.
- `get_code_context` gives where files and symbols sit and what depends on them: area and layer, what each uses, its
  dependents counted by area, its reach within 3 hops, its processes, and where several land together. An ambiguous
  name lists its matches and a missing one says why; none is guessed. What isn't counted (dynamic calls, reflection,
  string-built imports, test files), that a method's callers are a floor, and that edits not yet in a snapshot are
  not on the map are in its description.
- The server instructions ask for `get_code_context` on the code an assistant will change, before its first edit.
  Asked to change chargeCard without a word about ShadowGit, Claude Code called it before its first edit in 20 of 20
  runs, with its default tool search on (`npm run eval:map`).
- Each step's answer names the step after it, read at the moment the assistant acts: `get_code_context`'s gives the
  session flow, and `end_session`'s, when it ended a session, gives `get_lens` then `write_lens_words`. With the map
  rule alone the Lens flow fell to 7 of 10 runs; with the next steps, and the eval's own project's map, it ran in 5
  of 5 (`npm run eval:lens`).

The map tools need a ShadowGit release after 0.3.9; an older app answers with a message asking for the update.

## [2.2.0] - 2026-10-16

### Added
- `write_lens_words` takes a step's body as pieces: runs of text, and runs naming one of the step's components, by id,
  which the Lens links to that component. A step may also carry a why, quoted word for word from one of the range's
  checkpoint messages, and an excerpt: up to 12 changed lines of one of its symbols, by path, name, side and lines.
- `get_lens` lists each step's symbols with their lines on each side and the checkpoint messages a why may quote.
  The rules for links, a why and an excerpt are in `write_lens_words`' own schema: Claude Code shows the model a
  tool's structured output alone, never its text.

Links, a why and an excerpt need a ShadowGit release after 0.3.7. Plain text still works with every release that has
the Lens; an older one refuses a body of pieces with a message asking for the update.

## [2.1.1] - 2026-10-15

### Changed
- The server instructions put wording the Lens inside the session flow: checkpoint, end_session, then get_lens and
  write_lens_words. Asked for a normal two-file task without a word about the Lens, Claude Code wrote the Lens's words
  in 5 of 5 runs, against 3 of 5 when it was a separate line (`npm run eval:lens`).

## [2.1.0] - 2026-10-15

### Added
- `get_lens` reads ShadowGit's Lens of a range of snapshots, by default the latest AI session's: each step with its
  files and diff, the components and flows on its canvas, each by id with its words so far.
- `write_lens_words` writes the Lens's words for that range by those ids: a summary, step titles and sentences,
  component roles, layer names and flow labels. The app keeps them in its history; a component's role shows in later
  ranges while its code is unchanged.
- Server instructions suggest wording the Lens at the end of a session, after its checkpoint.

Both tools need a ShadowGit release after 0.3.5.

## [2.0.0] - 2026-10-11

Rewritten on the MCP TypeScript SDK v2, serving the 2026-07-28 and 2025-11-25 protocol revisions.

### Changed
- The tools other than `list_repos` work on the current project when `repo` is omitted (Claude Code's project directory,
  or the only tracked project when the client names no project directory). `end_session` no longer needs a session id:
  it ends the project's active session.
- `end_session` takes an optional `session_id` (was `sessionId`); `commitHash` is gone.
- `end_session` with no session on the current project names the project that has one, with its session id.
- `checkpoint` is made by the ShadowGit app, so it follows `.shadowgit-ignore`; it needs ShadowGit 0.3.4 or
  later. The `author` parameter is gone (the assistant's name is used), and titles may run to 72
  characters.
- A slow ShadowGit app is reported as slow, not as closed; checkpoints wait up to 55 s.
- The "ShadowGit isn't running" error names the host that `SHADOWGIT_SESSION_API` points at.
- Server instructions tell the assistant when to use each tool; tools carry titles, annotations and output schemas.
- `git_command` output is capped at 25,000 characters, git runs asynchronously, and `status` no longer touches the
  snapshot index.
- `SHADOWGIT_STORAGE_DIR` points the server at a non-default ShadowGit storage folder, as it does for the app.
- `git_command` accepts `-C`, `-c` and `-e` again (copy detection, combined diffs, `cat-file -e`).
- `git_command` ends its output with `[git exited with status N]` when git exits non-zero, so `cat-file -e` on a missing
  object does not read as success.
- Tool failures come back as MCP errors (`isError`) instead of a `success: false` field.
- `list_repos` reports a project whose history cannot be read in its own row, and keeps listing the others.
- Requires Node.js 20 or later.

### Security
- `git_command` refuses options that read or write files outside the snapshot history: `--output` and
  `-O`/`--orderfile` on every subcommand, `diff --no-index`, `blame --contents`/`--ignore-revs-file`/`-S`,
  `ls-files --exclude-from`/`-X`/`--exclude-per-directory` and `rev-parse --resolve-git-dir`, abbreviated or bundled,
  and any path outside the project (which `diff` would otherwise compare with `--no-index`).
- `git_command` refuses `--ext-diff`, `--textconv` and `--filters` on every subcommand, which would run helper commands
  from the history's git configuration, and `--submodule` and `--recurse-submodules`, which would open a submodule's
  repository outside the project. git always runs with `core.fsmonitor`, `diff.submodule` and `submodule.recurse` fixed,
  so the history's own config cannot run a program or switch submodule recursion on.
- `git_command` refuses `--help`, which would open git's manual.
- `git_command` runs git without the `GIT_*` variables the server inherited, in any case (`GIT_INDEX_FILE`,
  `GIT_OBJECT_DIRECTORY`, `GIT_DIR`...), which would otherwise point it at another repository when a client starts from
  a git hook.
- Projects not tracked by ShadowGit are refused even when they contain a `.shadowgit.git` folder.

### Removed
- `SHADOWGIT_HINTS`, `SHADOWGIT_LOG_LEVEL` and the workflow banners appended to results.

## [1.1.2] - 2025-09-05

### Security Improvements
- **Critical**: Removed `branch`, `tag`, `reflog` commands to prevent destructive operations
- Added `-C` flag to blocked arguments to prevent directory changes
- Enhanced repository validation to check for .shadowgit.git on raw paths

### Bug Fixes
- Fixed remaining error responses in SessionHandler to use createErrorResponse
- Aligned email domains to consistently use @shadowgit.local

## [1.1.1] - 2025-09-05

### Security Improvements
- **Critical**: Block `--git-dir` and `--work-tree` flags to prevent repository escape attacks
- Switched internal commands to array-based execution, eliminating command injection risks
- Enhanced Git error reporting to include stderr/stdout for better debugging
- Fixed command length validation to only apply to external commands

### Features
- Added `SHADOWGIT_HINTS` environment variable to toggle workflow hints (set to `0` to disable)
- Standardized all error responses with consistent `success: false` flag

### Bug Fixes
- Fixed string command parser to handle all whitespace characters (tabs, spaces, etc.)
- Fixed Jest configuration for extensionless imports
- Removed .js extensions from TypeScript imports for better compatibility
- Improved error handling for Git commands with exit codes

### Developer Experience
- Added comprehensive test coverage for security features
- Improved documentation with security updates and troubleshooting tips
- All 175 tests passing with improved coverage

## [1.1.0] - 2025-09-04

### Features
- Added session management with start_session and end_session
- Added checkpoint command for creating AI-authored commits
- Integrated with ShadowGit Session API for auto-commit control
- Added workflow reminders in git command outputs

### Security
- Implemented comprehensive command validation
- Added dangerous argument blocking
- Path traversal protection
- Repository validation

## [1.0.0] - 2025-09-03

### Initial Release
- MCP server implementation for ShadowGit
- Support for read-only git commands
- Repository listing functionality
- Integration with Claude Code and Claude Desktop
- Basic security restrictions