# ShadowGit MCP server 2.0

## Today

A customer followed the session phrases on docs.shadowgit.com ("Start a ShadowGit session for debugging", "End the
current ShadowGit session") and needed 15 minutes of back-and-forth before Claude got them right. The product's tagline
is "Stop re-explaining your codebase to Claude", so that failure hits the product's core promise. The server, unchanged
since 1.1.2 (September 2025), explains it:

- **The phrases ask for what the tools cannot do.** `start_session` requires `repo`, and the phrase names none.
  `end_session` requires the `sessionId` from `start_session`, which a new conversation no longer has, and no tool can
  look it up, although the app serves `GET /api/session/active`.
- **No server instructions.** Claude Code defers MCP tools by default (tool search) and loads only tool names and server
  instructions at session start, so Claude gets no hint of when to reach for ShadowGit.
- **Out of date.** `@modelcontextprotocol/sdk` 0.5.0 with the low-level `Server`, hand-written JSON schemas, no `title`,
  no annotations, no `outputSchema`, a custom `success: false` field instead of `isError`. Anthropic's directory review
  would reject the `start_session` description ("MUST be called BEFORE making any changes"), which instructs the model.
- **"Read-only" is false.** `git_command` allows `log --output=<file>` (writes any file), `diff --no-index` (reads any
  file), `blame --contents` (prints any file) and `blame --ignore-revs-file` (leaks a file's first line in its error),
  all reproduced with git 2.47. Its blocklist instead refuses useful options: `-C` and `-c` are copy detection and
  combined diffs once they follow the subcommand, and `-e` is `cat-file`'s existence check.
- **Checkpoints ignore `.shadowgit-ignore`.** `checkpoint` runs `git add -A`; the app's own staging filter never applies,
  so a checkpoint can commit `node_modules` or build output.
- **Context waste.** No output cap (up to 10 MB), and emoji banners appended to results and errors alike.
- **Housekeeping.** No CI, a `lint` script without an ESLint config, 175 Jest tests that mock `child_process`, `fs` and
  the SDK itself (none of the bugs above could fail them), `repos.json` read once at startup, `SHADOWGIT_STORAGE_DIR`
  ignored.

The app has two bugs on the same path. Sessions expire at the next 30-minute sweep instead of after an hour:
`cleanupExpiredSessions` compares SQLite's `CURRENT_TIMESTAMP` (`2026-10-08 12:00:00`) with a JavaScript ISO string
(`2026-10-08T11:00:00.000Z`) as text, and a space sorts before `T`. Automatic snapshot titles carry UTC times without a
zone (`commit-message-generator.ts:17`), the customer's other report.

## Goal

Every phrase in the docs works on the first try in a fresh Claude Code session, with no argument the user has to
supply. Cursor and Claude Desktop keep working. The server passes Anthropic's directory criteria, its read-only tool is
read-only, and its tests run real git and the real SDK client.

Out of scope here: the docs rewrite (next sub-project, using this spec's eval as its acceptance test) and a Claude Code
plugin whose hooks start and end sessions automatically (after that).

## Design

Grounded in the MCP specification 2026-07-28, the TypeScript SDK v2 documentation, Claude Code's MCP documentation,
Anthropic's "Writing effective tools for agents" and directory review criteria, and doc0-commercial's MCP layer
(`src/lib/mcp/`).

### Runtime and packaging

- **SDK:** `@modelcontextprotocol/server` ^2.3 and `zod` ^4 (imported as `zod/v4`), an ESM package, Node ≥ 20 (the SDK's
  floor; Node 18 reached end of life in April 2025).
- **Transport:** `serveStdio(buildServer)`. Its default (`legacy: 'serve'`) answers both the 2026-07-28
  `server/discover` probe and the 2025 `initialize` handshake, so every client connects on the revision it speaks
  (verified with SDK 2.3.1 against a pinned 2026-07-28 client and a legacy one).
- **Build:** esbuild bundles the server, the SDK and zod into one ESM file (a `createRequire` banner serves the SDK's
  CommonJS dependencies); both move to `devDependencies`, so `npx -y shadowgit-mcp-server` fetches one small package
  within Claude Code's 30-second first-start window. The server reads its version from `package.json` at runtime,
  replacing the hard-coded `'1.1.2'`.
- **Quality gates:** Vitest replaces Jest; an ESLint flat config makes `npm run lint` work; `tsc --noEmit`. A GitHub
  Actions workflow runs all three on every pull request on Ubuntu, macOS and Windows, since storage paths differ by OS.
- **Registry:** `mcpName: "io.github.aflsolutions/shadowgit"` in `package.json` and a `server.json` for the official MCP
  Registry (GitHub authentication; a `com.shadowgit/…` name would need a DNS TXT record and can come later).
- **Recommended setup:** `claude mcp add --scope user shadowgit -- npx -y shadowgit-mcp-server`. User scope makes one
  install serve every project ShadowGit tracks.
- **Version 2.0.0:** tool parameters and responses change. The CHANGELOG lists what changes for users.

### Tools

The five capabilities stay, under their current names, so permission allowlists such as `mcp__shadowgit__git_command`
keep working.

- `repo` is optional on every tool: `"Project name or absolute path. Defaults to the current project."`
- Tools that return data return `structuredContent` with an `outputSchema`, plus a short text rendering.
- Descriptions say what the tool does, when to use it and when to use a sibling. They never tell the model what it must
  do; the server instructions carry the workflow.
- A project has one pause state: `start_session` returns the session already active on the project, and `end_session`
  without an id ends every active session on it, returning the ids it ended.
- Every tool sets `title`, `readOnlyHint`, `destructiveHint` (the three the directory requires, `false` on the read-only
  tools too) and `openWorldHint: false`. Timestamps are ISO 8601 with the local offset (`2026-10-08T12:29:00+02:00`).

| Tool | Title | Annotations | Input | Output |
|---|---|---|---|---|
| `list_repos` | List ShadowGit projects | read-only | none | `{ current, app_running, repos: [{ name, path, current, last_snapshot, session }] }` |
| `git_command` | Query snapshot history with git | read-only, idempotent | `command`, `repo?` | git output as text |
| `start_session` | Start a ShadowGit session | not read-only, not destructive, idempotent | `description` (1–200), `repo?` | `{ session_id, repo, already_active }` |
| `checkpoint` | Create a ShadowGit checkpoint | not read-only, not destructive | `title` (1–72), `message?` (≤ 1000), `repo?` | `{ commit, title, files_changed, repo }` |
| `end_session` | End a ShadowGit session | not read-only, not destructive, idempotent | `repo?`, `session_id?` | `{ ended, repo }` |

In `list_repos`, `current` names the project the other tools default to (`resolveRepo()` without an argument), or is
`null` when that fails; `session` is `{ id, description, started_at }` or `null`; `last_snapshot` is `null` for a project
without snapshots. `checkpoint` returns `commit: null` and `files_changed: 0` when nothing changed. `end_session` with a
`session_id` skips project resolution: it ends that session if it is active and reports its project as `repo`, and
returns `ended: []` otherwise (the app's `/api/session/end` reports success even for unknown ids).

Descriptions, verbatim:

- **`list_repos`:** "List the projects ShadowGit is snapshotting: name, path, time of the last snapshot, any active
  session, and which one matches the project you are working in. Other ShadowGit tools default to that current
  project. Use this when the user names a project you don't recognise."
- **`git_command`:** "Run a read-only git command on a project's ShadowGit history: automatic snapshots taken every few
  minutes, kept apart from the project's own .git. Use it for what changed recently, a file's history, when something
  broke, or a diff between two points in time. Allowed: log, show, diff, status, blame, shortlog, rev-list, rev-parse,
  ls-files, ls-tree, cat-file, describe, show-branch. Commands that write, and options that read or write files outside
  the history (such as --output and --no-index), are refused. Output is capped at 25,000 characters; narrow it with -n,
  --since, --stat or a path." The `command` parameter: "A git command without the leading "git", e.g.
  log --since="1 hour ago" --stat".
- **`start_session`:** "Pause ShadowGit's automatic snapshots for a project while you make a set of related edits, so
  they can be saved as one checkpoint instead of several partial snapshots. Returns the existing session if one is
  already active. Needs the ShadowGit app running. To save the edits and resume snapshots, use checkpoint and
  end_session." The `description` parameter: "What you are about to change, e.g. "Fix login redirect"".
- **`checkpoint`:** "Save the project's current changes to ShadowGit history as one named checkpoint, applying the
  project's .shadowgit-ignore rules. Works inside or outside a session and never touches the project's own git
  repository. Returns the commit hash. Needs the ShadowGit app running."
- **`end_session`:** "Resume automatic snapshots for a project by ending its active ShadowGit session. Without
  session_id it ends whatever session is active on the project, and succeeds with nothing to do if there is none.
  Changes not saved with checkpoint are picked up by the next automatic snapshot."

`checkpoint` drops the `author` parameter: the author is the calling client's name, read from the request
(`ctx.mcpReq.envelope[CLIENT_INFO_META_KEY]` on 2026-07-28; on 2025 connections, which carry no envelope, the deprecated
`server.getClientVersion()`, the only source there), falling back to "AI assistant". `start_session` sends the same name
as the app's `aiTool`, so session ids read `claude-code-…` instead of `mcp-client-…`. The title limit rises from 50 to
72 characters, git's hard wrap width.

### Project resolution

One `resolveRepo(repo?)` serves every tool.

1. It reads `repos.json` on every call (a few hundred bytes), so projects added in the app appear without restarting
   the client. The storage directory follows the app's `getStorageLocation()` (`electron/core/native.ts`) exactly:
   `SHADOWGIT_STORAGE_DIR` first, then `~/.shadowgit` on macOS, `%LOCALAPPDATA%\shadowgit` on Windows,
   `$XDG_DATA_HOME/shadowgit` or `~/.local/share/shadowgit` elsewhere.
2. **`repo` given.** An absolute path, or one starting with `~`, must be a tracked project. A name matches exactly, then
   case-insensitively; when two tracked projects share a folder name, the error lists both paths.
3. **`repo` omitted.** The start directory is `CLAUDE_PROJECT_DIR`, which Claude Code sets for stdio servers, else the
   working directory. The tracked project whose path contains it wins, the most specific one when projects nest. Both
   sides go through `realpath` first, so symlinks and case-insensitive file systems match.
4. Else, if exactly one project is tracked, that one.
5. Else an error: "No ShadowGit project contains /Users/x/code. Pass repo as one of: app (~/code/app), site
   (~/code/site)."

A folder that holds a `.shadowgit.git` but is not tracked is no longer accepted, which matches what the app's
checkpoint endpoint accepts.

### Sessions

The server finds sessions with one `GET /api/session/active`, filtered to `repoPath` equal to the resolved path. The
match is exact because the server itself sent that `repos.json` path when it started the session. `start_session` looks
before it starts one, `end_session` ends what it finds, and `list_repos` fills its `session` column from the same call.
When the app does not answer, `list_repos` reports `app_running: false` and the tools that need the app return the error
in [Errors](#errors).

### Server instructions

A test caps them at 1,250 characters (doc0's limit). Routing by task type, not by tool list, follows doc0's benchmark:
agents ignored its server in about 30% of runs while the instructions only listed tools.

```
ShadowGit snapshots each tracked project every few minutes into a separate history (.shadowgit.git), so it holds changes the project's own git never saw.
Task → tool:
- What changed recently, a file's history, when something broke, what the user was doing at a given time: git_command with read-only git (log --since, diff, show, blame). Keep output small with --stat, -n and paths.
- Before editing several files in a tracked project: start_session, which pauses snapshots. When the edits are done: checkpoint with a specific title, then end_session.
- The user asks to save or checkpoint their work: checkpoint.
- A project name you don't recognise: list_repos.
Every tool defaults to the project you are working in; pass repo only for another project. Sessions and checkpoints need the ShadowGit app running; git_command works without it. Times written inside older snapshot titles may be UTC; git's own dates are correct.
```

The last sentence covers histories written before the app's timestamp fix; their titles keep UTC times for good.

The untracked `CLAUDE.md` in the repository's main checkout, a "You MUST follow this exact workflow" snippet built on
the 1.x arguments (`sessionId`, `author`), is not published; these instructions replace it.

### `git_command`

**Invariant.** The first token must be an allowed subcommand: `log`, `show`, `diff`, `status`, `blame`, `shortlog`,
`rev-list`, `rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `describe`, `show-branch`. Git's global options
(`-C <dir>`, `-c key=value`, `--git-dir`, `--exec-path`) are therefore unreachable, and every later token is an option
of that subcommand. The deny list holds the subcommand options that read or write files outside the history, each backed
by a test that shows the escape:

| Denied | Subcommands | Escape |
|---|---|---|
| `--output` | log, show, diff | writes any file |
| `--no-index` | diff | reads any two paths |
| `-O`, `--orderfile` | log, show, diff | reads any file |
| `--contents` | blame | prints any file |
| `--ignore-revs-file`, `-S` | blame | reads any file; `-S` stays allowed elsewhere (pickaxe in `log`) |
| `--exclude-from`, `-X`, `--exclude-per-directory` | ls-files | reads any file |
| `--resolve-git-dir` | rev-parse | probes any path |

A long option is denied when its name, before any `=`, is a prefix of a denied name: git expands unambiguous
abbreviations, and `blame --cont <file>` prints the file like `--contents`. Two real options start with a denied name and
stay allowed: `blame --ignore-rev` and `ls-files --exclude`. Short options bundle (`log -pO<file>` is `-p` plus
`-O<file>`; `blame -wS <file>` leaks the file as "bad graft data"), so a single-dash token is denied when any of its
letters is a denied short option. The old entries `-C`, `-c`, `-e`, `--exec`,
`--upload-pack`, `--receive-pack`, `--git-dir`, `--work-tree` and `--config` go: after the subcommand they are harmless
or useful. The quote-aware tokenizer and the 1,000-character limit stay.

**Execution.** Async `execFile` (`git --git-dir=<project>/.shadowgit.git --work-tree=<project> …`), so a slow
`log -p` no longer blocks the server; a 10-second timeout (`SHADOWGIT_TIMEOUT`); stdin closed, so `--stdin` and
`--batch` cannot hang; a 1 MB buffer. Environment: `GIT_OPTIONAL_LOCKS=0`, so `status` never rewrites the shadow index
the app stages into, `GIT_TERMINAL_PROMPT=0` and `GIT_PAGER=cat`.

**Output.** At most 25,000 characters, below Claude Code's 10,000-token warning. A cut output starts with
`[Truncated: showing the first 25,000 characters of 312,480 characters. Narrow it with -n, --since, --stat or a path.]`;
when git's output overflows the 1 MB buffer, git is stopped and the note reads "of more than 1 MB". A non-zero exit
with nothing on stderr is git reporting a result (`diff --exit-code` found differences) and returns the output. A failing
git returns `isError: true` with git's stderr, trimmed to 2,000 characters; empty output reads `(no output)`. The emoji
banners and `SHADOWGIT_HINTS` go.

### Errors

The SDK rejects arguments that fail the zod schema before a handler runs. A handler throws an `Error` whose message
names the cause and the next step; the SDK turns it into `isError: true`. The `success` field goes.

| Situation | Result |
|---|---|
| App not answering (session tools, checkpoint) | Error: "ShadowGit isn't running: nothing answered on localhost:45289. Ask the user to open the ShadowGit app, then try again. Reading history with git_command still works." |
| App too old (`POST /api/checkpoint` returns 404 for the route) | Error: "This version of ShadowGit can't create checkpoints for AI assistants. Ask the user to update the ShadowGit app." |
| Project not found or ambiguous | Error: the messages in [Project resolution](#project-resolution) |
| Nothing to checkpoint (409) | Result `{ commit: null, files_changed: 0 }`: "No changes since the last snapshot; nothing to checkpoint." |
| No session to end | Result `{ ended: [] }`: "No active session; automatic snapshots are already on." |

The only log line is a transport error, written to stderr; `SHADOWGIT_LOG_LEVEL` and `SHADOWGIT_HINTS` go. The server
sends no telemetry: it reads private code history on the user's machine.

### Module layout

`src/index.ts` (`serveStdio`, the binary), `src/server.ts` (`buildServer`: server info, instructions, tool
registration), `src/version.ts`, `src/repos.ts` (storage location, `resolveRepo`), `src/session-api.ts` (the app's HTTP
API: sessions and checkpoints), `src/git.ts` (tokenizer, argument policy, execution, output cap), `src/time.ts` (local
ISO timestamps), `src/client-name.ts`, and one file per tool under `src/tools/` with the shared `repo` parameter and
result helper beside them.

## App changes (shadowgit-app)

Released before the server's 2.0.0.

1. **Session expiry.** `cleanupExpiredSessions` compares inside SQLite: `started_at < datetime('now', ?)` with
   `-1 hours`, so both sides share one format. The app also runs the cleanup once at startup, so a session left by a
   crash no longer pauses snapshots for up to 30 minutes after a restart.
2. **`POST /api/checkpoint`** `{ repoPath, title, message?, author? }`. It calls
   `CommitOrchestrator.createManualCheckpoint` with a new optional `{ message, author }`, which stages through the same
   filter as automatic snapshots, so `.shadowgit-ignore` applies. `GitOperations.commit` takes an optional author; the
   committer stays ShadowGit. Responses: `200 { success: true, commit, filesChanged }`;
   `400 { success: false, error }` for a missing field or a `repoPath` that is not a tracked project, so the endpoint
   commits only into shadow repositories the user added; `409 { success: false, error: 'No changes to commit' }`. A
   `404` therefore only ever means an app without this route.
3. **Host check.** The Session API answers only requests whose `Host` is `127.0.0.1:45289` or `localhost:45289`. It
   has no authentication and gains a write endpoint; the check stops DNS rebinding, which lets a web page reach a
   localhost server through a host name it controls. The MCP specification asks the same of local HTTP servers.
4. **Snapshot titles in local time.** Shipped in shadowgit-app PR #36 (`localTimestamp()`), which also strips the
   written time from titles in the app's commit list.

## Testing

Vitest. The Jest suite and its SDK stubs go.

1. **Argument policy.** Each denied option, abbreviated and attached forms included (`--cont`, `-O/x`), and allowed
   look-alikes that must pass (`log -S`, `log -C`, `cat-file -e`).
2. **Real git.** Temporary projects with a real `.shadowgit.git`, a temporary `repos.json` through
   `SHADOWGIT_STORAGE_DIR`, and a fake Session API on an ephemeral port (`SHADOWGIT_SESSION_API`) that records requests.
   Every escape in the deny table runs through the tool against a canary file: no file appears, and the canary's
   content never reaches the output. Resolution covers nested projects, symlinks, case, the one-project fallback and
   shared folder names.
3. **Protocol.** The built binary, spawned over stdio by the SDK v2 `Client`, once pinned to 2026-07-28
   (`versionNegotiation: { mode: { pin: '2026-07-28' } }`) and once on 2025-11-25 (`initialize`): the instructions arrive and stay
   within 1,250 characters, and every tool answers.
4. **Tool-list snapshot.** Names, titles, descriptions, schemas and annotations are pinned; changing them is a
   deliberate snapshot update, as in doc0.
5. **App.** A 30-minute-old session survives cleanup and a 2-hour-old one expires; a checkpoint never commits an
   ignored file; the untracked-project, nothing-to-commit and author cases; a foreign `Host` gets refused.
6. **Docs-phrase eval.** `scripts/eval-docs-phrases.ts` runs each phrase from the docs through `claude -p` inside a
   temporary tracked project, with only this server loaded (`--strict-mcp-config`) and the fake Session API, then checks
   the outcome: the session call arrived with the project's path, the checkpoint commit exists, the "last hour" answer
   names the changed file. It reports a pass rate, runs by hand before each release (it spends tokens and its results
   vary), and becomes the docs sub-project's acceptance test.

## Release

1. The app pull requests (items 1–3, then item 4), then a stable app release.
2. This repository: the 2.0.0 pull request with CI green and the eval passing; then `npm publish` and
   `mcp-publisher publish`, each confirmed with the maintainer first.
3. The docs sub-project.
4. The Claude Code plugin.
