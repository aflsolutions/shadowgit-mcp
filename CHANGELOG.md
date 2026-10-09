# Changelog

All notable changes to the ShadowGit MCP Server will be documented in this file.

## [2.0.0] - 2026-10-08

Rewritten on the MCP TypeScript SDK v2, serving the 2026-07-28 and 2025-11-25 protocol revisions.

### Changed
- The tools other than `list_repos` work on the current project when `repo` is omitted (Claude Code's project directory,
  or the only tracked project when the client names no project directory). `end_session` no longer needs a session id:
  it ends the project's active session.
- `end_session` takes an optional `session_id` (was `sessionId`); `commitHash` is gone.
- `checkpoint` is made by the ShadowGit app, so it follows `.shadowgit-ignore`; it needs an app release with
  `POST /api/checkpoint`. The `author` parameter is gone (the assistant's name is used), and titles may run to 72
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