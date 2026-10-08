# ShadowGit MCP server

Gives Claude Code, Cursor and Claude Desktop access to [ShadowGit](https://shadowgit.com): the automatic snapshots
ShadowGit takes of your projects every few minutes, kept apart from your own git history. Your assistant can see what
changed and when, and can save its own edits as one named checkpoint instead of many partial snapshots.

## Requirements

- Node.js 20 or later
- The ShadowGit app, tracking at least one project. Reading history works while the app is closed; sessions and
  checkpoints need it running.
- Git on your PATH

## Setup

**Claude Code** (one install for every project):

```bash
claude mcp add --scope user shadowgit -- npx -y shadowgit-mcp-server
```

**Cursor**: in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "shadowgit": { "command": "npx", "args": ["-y", "shadowgit-mcp-server"] } } }
```

**Claude Desktop**: the same entry in `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows).

In Claude Code the server knows which project you are in. In Cursor and Claude Desktop, name the project ("in
webshop") when ShadowGit tracks more than one.

## What to ask

- "What changed in the last hour?"
- "When did the login page break?"
- "Show me the history of Header.tsx"
- "Start a ShadowGit session for this refactor", then "Create a checkpoint: Fixed login redirect", then "End the
  ShadowGit session"

## Tools

| Tool | Does |
|---|---|
| `list_repos` | Lists tracked projects, the current one, their last snapshot and any active session |
| `git_command` | Runs a read-only git command (`log`, `diff`, `show`, `blame`, …) on the snapshot history |
| `start_session` | Pauses automatic snapshots while the assistant edits |
| `checkpoint` | Saves the current changes as one named checkpoint, following `.shadowgit-ignore` |
| `end_session` | Resumes automatic snapshots |

The other tools work on the current project unless given `repo`.

## Security

`git_command` runs only read-only subcommands, without a shell, and refuses the options that would read or write files
outside the snapshot history (`--output`, `--no-index`, `blame --contents` and others, including abbreviated and bundled
forms) and paths outside the project. Checkpoints are made by the ShadowGit app, only in projects you added to it. The
server itself only talks to the ShadowGit app on localhost; what it returns goes to your assistant like any tool result.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SHADOWGIT_TIMEOUT` | `10000` | Milliseconds a git command may run |
| `SHADOWGIT_SESSION_API` | `http://localhost:45289/api` | The ShadowGit app's local API |
| `SHADOWGIT_STORAGE_DIR` | platform default | Where ShadowGit keeps `repos.json` |

## Development

```bash
npm install
npm test        # builds, then runs the unit, integration and end-to-end tests
npm run eval    # runs the phrases from docs.shadowgit.com through Claude Code (spends tokens)
```

## License

MIT
