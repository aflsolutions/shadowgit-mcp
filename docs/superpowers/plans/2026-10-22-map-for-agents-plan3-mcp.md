# Map for Agents, Plan 3: shadowgit-mcp-server 2.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI assistant reads the project's map through two MCP tools, `get_map` and `get_code_context`, and asks before it edits.

**Architecture:** The tools call the ShadowGit app's `GET /api/map` and `POST /api/map/context` (shipped in shadowgit-app #64). The server's own zod schemas mirror the app's answers, since code-graph is private and the server is public. The answers are tested against real answers captured from the real app. The rules (facts only, what isn't counted, member callers a floor) live in the schemas' descriptions, because Claude Code shows the model a tool's `structuredContent` alone.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/server` v2, zod v4, Vitest, esbuild; the app's e2e harness (Playwright on Electron) for the fixture capture and the end-to-end check.

**Spec:** `docs/superpowers/specs/2026-10-21-map-for-agents-design.md` in shadowgit-app (merged at bce26e6), sections "Two tools", "In the MCP server", "The instructions and the eval", "Docs phrases".

## Global Constraints

- Tool names `get_map` and `get_code_context`, no prefix; `repo` defaults to the current project, as for every tool (`repoParam`).
- `get_code_context` takes `files` (repo-relative paths) and `symbols` (`{ name, file? }`): 1 to 20 targets in all.
- 404 answers: "This version of ShadowGit has no map for AI assistants. Ask the user to update the ShadowGit app."
- A closed app gets the message the session tools give (`AppNotRunningError`).
- Every line states a fact. No "careful", "risky", "should" or "consider" anywhere in the tools' text or schemas.
- Dynamic calls, reflection, string-built imports and test files aren't counted, and the descriptions say so. A method's or property's callers are a floor (recall 0.49 against TypeScript, plan 1), and its description says so.
- An answer stays under about 4,000 tokens with the defaults; the app's lists are already capped ("and N more" = `total` beside `items`).
- The new instruction line, verbatim: "- Before changing code in a tracked project: get_code_context for the files or symbols you will change (their area and layer, what depends on them, where the change lands); get_map for how the project is organised."
- `aiTool` is the client's name (`clientName(server, ctx)`), sent as a query field (GET) or body field (POST).
- Requests may build a map inside them: 55 s (`SLOW_REQUEST_TIMEOUT_MS`).
- Version 2.3.0 in `package.json`, `package-lock.json` and `server.json`. The npm publish is Alessandro's.
- `eval:map`: a real Claude Code, Claude Code's defaults, a fixture project of three areas, a change to a function another area depends on, no word about ShadowGit. Pass: `get_code_context` called with that function or its file before the first edit, in 4 of 5 runs.
- Docs phrases into `eval-docs-phrases.ts`: "How is this project organised?" and "What depends on chargeCard?".

## Review Focus

1. **The app's real answers drift from the server's mirror schemas.** A field the app sends differently must fail a test, never an agent's call. Covered by: Task 1's captured answers, which Task 2's tests parse.
2. **The map isn't ready (202) or there's no snapshot yet (409).** The agent gets the app's own sentence, with what to do, not "HTTP 202". Covered by: Task 2.
3. **An old map.** When `behind > 0`, the text names the snapshot and its time, how far behind it is, and the files changed since. Covered by: Task 3.
4. **Unresolved targets.** An ambiguous name lists its matches with `file:line`; a missing one names its reason and near names. Neither guesses. Covered by: Task 3, with captured answers.
5. **An app without the routes, or a closed app.** The update message and the closed-app message, not a parse error. Covered by: Task 2.

---

### Task 1: Real answers from the real app, as fixtures

**Files:**
- Create: `tests/fixtures/map/project.json` (the fixture project: path → content)
- Create: `tests/fixtures/map/{summary,area,context,landing,unresolved}.json` (the app's answers, written by the capture)
- Create (shadowgit-app, gitignored): `e2e/scratch/capture-map-answers.spec.ts`

**Interfaces:**
- Produces: `project.json`, a `Record<string, string>` the eval and the capture both write. The five answer files hold the app's JSON bodies as `GET /api/map` and `POST /api/map/context` send them (`success`, `mapAsOf`, then `summary`, `area` or `context`).

- [ ] **Step 1: Write the fixture project.** A webshop of three folders, `src/api`, `src/billing` and `src/jobs`, with enough symbols that the map cuts at least three areas. The live-map acceptance found one area holds about 40 symbols, so start at about 20 per folder, calling within their folder. `chargeCard(amount: number)` in `src/billing/charge.ts` is called from `src/api/checkout.ts` and `src/jobs/retry.ts`. `src/main.ts` calls `startServer()` at top level.
- [ ] **Step 2: Write the capture spec** in the shadowgit-app worktree. It writes `project.json`'s files into the e2e project and adds it. Then it saves five bodies:
  - `map({repoPath})` → `summary.json`;
  - `map({repoPath, area: <the billing label>})` → `area.json`;
  - `mapContext({symbols: [{name: 'chargeCard'}]})` → `context.json`;
  - `mapContext({symbols: [{name: 'chargeCard'}, {name: 'checkout'}]})` → `landing.json`;
  - `mapContext({files: ['src/gone.ts', 'src/billing/charge.test.ts'], symbols: [{name: <a name defined twice>}, {name: 'chargCard'}]})` → `unresolved.json`.
- [ ] **Step 3: Run it.** `E2E_SCRATCH=1 npm run test:e2e -- scratch/capture-map-answers`. Expected: `summary.areas.total >= 3`, with labels covering api, billing and jobs; `context.json`'s chargeCard has dependents in two areas. If the areas don't split, grow the folders and run again.
- [ ] **Step 4: Commit** the fixtures in the MCP repo: `test: real map answers from the ShadowGit app, as fixtures`.

### Task 2: The two requests, their shapes and their failures

**Files:**
- Modify: `src/session-api.ts` (schemas, `readMap`, `readCodeContext`, `APP_WITHOUT_MAP`)
- Modify: `tests/helpers/fake-app.ts` (map routes, serving Task 1's fixtures)
- Test: `tests/session-api.test.ts`

**Interfaces:**
- Consumes: Task 1's fixtures.
- Produces:
  - `MapAsOf`, `MapSummary`, `AreaView`, `MissingArea`, `CodeContext`: zod mirrors of code-graph 0.6.0's `map/query` types, and of shadowgit-app's `mapAsOf`. Each field carries its rule in `.describe()` where it has one.
  - `MapRead = z.object({ mapAsOf: MapAsOf, summary: MapSummary.optional(), area: z.union([AreaView, MissingArea]).optional() })`.
  - `ContextRead = z.object({ mapAsOf: MapAsOf, context: CodeContext })`.
  - `readMap(input: { repoPath: string; area?: string; aiTool: string }): Promise<z.infer<typeof MapRead>>`.
  - `readCodeContext(input: { repoPath: string; files?: string[]; symbols?: { name: string; file?: string }[]; aiTool: string }): Promise<z.infer<typeof ContextRead>>`.
  - On the fake app: `mapRoutes: boolean` (false: the catch-all 404); `mapStatus: 200 | 202 | 409 | 500`; `mapAnswers` (the fixtures, by route and area).

- [ ] **Step 1: Write the failing tests** in `tests/session-api.test.ts`, in a new `describe('the map', …)`:
  - `readMap` asks `/map?repoPath=…&aiTool=…`, with `area` when given, and parses `summary.json` and `area.json` into the shapes (`toEqual` the fixture minus `success`).
  - `readCodeContext` POSTs `{ repoPath, files, symbols, aiTool }` to `/map/context` and parses `context.json`, `landing.json` and `unresolved.json`.
  - Failures:
    - 202 rejects with "ShadowGit: ShadowGit is drawing this project's map; ask again in a minute";
    - 409 rejects with "ShadowGit: This project has no snapshot yet";
    - `mapRoutes: false` rejects with `APP_WITHOUT_MAP`;
    - a hung app rejects with "did not answer within 55 s";
    - a closed app (`closedAppUrl()`) rejects with `AppNotRunningError`'s message.
- [ ] **Step 2: Run** `npx vitest run tests/session-api.test.ts`. Expected: FAIL, `readMap` is not exported.
- [ ] **Step 3: Implement** the schemas and the two requests. Use `request(…, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS, accept: [404] })`, and map 404 to `APP_WITHOUT_MAP`. 202 and 409 go through `failure()`, so the app's sentence reaches the agent.
- [ ] **Step 4: Run** the file again. Expected: PASS. Then `npm run typecheck && npm run lint`: clean.
- [ ] **Step 5: Commit**: `feat: read the app's map and code context, by shapes its real answers pass`.

### Task 3: The tools

**Files:**
- Create: `src/tools/map.ts`
- Modify: `src/server.ts` (`registerMap(server)`)
- Test: `tests/tools-map.test.ts`; `tests/__snapshots__/tool-list.json` (regenerated)

**Interfaces:**
- Consumes: Task 2's requests and shapes.
- Produces:
  - `getMap(args: { area?: string; repo?: string }, aiTool: string): Promise<CallToolResult>`.
  - `getCodeContext(args: { files?: string[]; symbols?: { name: string; file?: string }[]; repo?: string }, aiTool: string): Promise<CallToolResult>`.
  - `registerMap(server: McpServer): void`.
  - `structuredContent` is `{ repo, ...MapRead }` or `{ repo, ...ContextRead }`. The output schemas are `z.object({ repo: z.string(), ...MapRead.shape })` and the same for context.

- [ ] **Step 1: Write the failing tests** in `tests/tools-map.test.ts`, on the fake app with Task 1's answers:
  - `getMap({})`: `structuredContent` equals `{ repo: 'webshop', ...summary }` (without `success`). The text names the snapshot (8 characters) and its time; the counts; each area as "label (path): N files, M symbols"; each link as "from → to: N calls and imports".
  - `getMap({ area })` with the billing label: the text lists the area's files and its most depended-on symbols with their counts.
  - `getCodeContext({ symbols: [{ name: 'chargeCard' }] })`:
    - the text has "chargeCard (function, src/billing/charge.ts:<line>)", its area and its layer;
    - the dependents counted by area;
    - reach as symbols and files within 3 hops;
    - the request body carries `aiTool` from the client's name.
  - `landing.json`: the text has a "Where they land" section with the areas and the dependents outside the set.
  - `unresolved.json`:
    - ambiguous: the matches as `file:line`;
    - missing: its reason ("not in the snapshot", "a test file", which tests leave out) and near names.
  - An answer with `mapAsOf.behind = 3` (a fixture copy) says "3 snapshots behind the newest" and lists the changed files with "and N more".
  - `getCodeContext({})` and 21 targets reject with "Ask about 1 to 20 files and symbols", and send no request.
  - No judging words: `/\b(careful|risky|should|consider)\b/i` matches neither any text nor `JSON.stringify` of the two tools' listed schemas.
  - Size: for each fixture answer, the text and `JSON.stringify(structuredContent)` are each under 16,000 characters (about 4,000 tokens).
- [ ] **Step 2: Run** `npx vitest run tests/tools-map.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `src/tools/map.ts` in `lens.ts`'s shape: `resolveRepo`, `dataResult`, and `registerTool` with `readOnlyHint: true`.
  - **Descriptions, `get_map`:** "How a ShadowGit-tracked project is organised, from the map of its newest snapshot: counts, layers, areas largest first, the links between areas, processes; with `area`, one area's files, its most depended-on symbols, the areas it depends on and that depend on it."
  - **Descriptions, `get_code_context`:** "Where files and symbols sit in a ShadowGit-tracked project and what depends on them: area and layer, what each calls, its dependents counted by area, reach within 3 hops, processes; for two or more, where they land together. Read it before changing them."
  - **Rules** go on the output schemas' fields:
    - `dependents`: "callers, files whose top-level code calls it, and importers of its name; dynamic calls, reflection, string-built imports and test files aren't counted; for a method or property, callers through a value whose type isn't known are missing, so its count is a floor";
    - `mapAsOf`: "the snapshot the answer is drawn from; when behind > 0, the files changed since may have changed facts";
    - `area` input: "an area's label as get_map gives it, or a folder path, which covers every file under it".
  - **Text:** one fact per line, as the tests pin.
- [ ] **Step 4: Run** the file. Expected: PASS. Then regenerate the tool list with `npx vitest run tests/e2e.test.ts -u`, and read the snapshot's diff: two tools, with their schemas.
- [ ] **Step 5: Commit**: `feat: get_map and get_code_context: the project's map for an AI assistant`.

### Task 4: The instruction line, the README, the release

**Files:**
- Modify: `src/server.ts` (`INSTRUCTIONS`), `tests/e2e.test.ts` (cap)
- Modify: `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `server.json`
- Modify: `scripts/eval-docs-phrases.ts` (two phrases)

- [ ] **Step 1: Write the failing test.** In `tests/e2e.test.ts`, the instructions test asserts that `INSTRUCTIONS` contains the Global Constraints' line, and that the line comes before the `start_session` line. Run it. Expected: FAIL.
- [ ] **Step 2: Add the line** after the `git_command` line. Raise the cap to 1,500, with a comment: Claude Code truncates server instructions at 2,048 characters, and 1,500 leaves room. Run it. Expected: PASS.
- [ ] **Step 3: Update the docs.**
  - **README:** the tools table gets the two rows, and "What to ask" gets the two phrases.
  - **CHANGELOG:** `## [2.3.0] - <date>` under Added, with the two tools and the line. It notes that they need the ShadowGit release that ships the map for AI assistants, and that an older app answers with the update message.
  - **Version:** 2.3.0 in `package.json`, `package-lock.json` (both places) and `server.json`.
  - **`eval-docs-phrases.ts`:** two cases. "How is this project organised?" passes on a `/map?` request without `area`. "What depends on chargeCard?" passes on a `/map/context` body whose symbols name chargeCard. Prepare both with the map fixture project.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run lint`. Expected: all pass (`release.test.ts` included).
- [ ] **Step 5: Commit**: `feat: the instructions ask for the map before an edit; 2.3.0`.

### Task 5: `eval:map`, and the evals the line can move

**Files:**
- Create: `scripts/eval-map-unprompted.ts`; Modify: `package.json` (`"eval:map": "npm run build && tsx scripts/eval-map-unprompted.ts"`)

- [ ] **Step 1: Write the script** in `eval-lens-unprompted.ts`'s shape:
  - the project from `project.json` as snapshots;
  - the fake app serving Task 1's answers;
  - `claude -p` with `--output-format stream-json --verbose`.
  - TASK: "Make chargeCard reject an amount below zero with a RangeError, and keep every caller working." It names no ShadowGit tool, no file and no area.
  - A run passes when the first `mcp__shadowgit__get_code_context` tool_use whose input names `chargeCard` or `src/billing/charge.ts` comes before the first `Edit`/`Write` tool_use.
  - It prints each run's tool order, and exits 0 at 4 of `RUNS` (5).
- [ ] **Step 2: Run the evals** with `claude` on `PATH` as `claude-personal3`:
  - `npm run eval:map`: expected 4 or 5 of 5;
  - `npm run eval:lens`: expected 5 of 5, as 2.1.1 had;
  - `npm run eval`: expected every case, the two new phrases included.

  Keep each run's output in `/work/artifacts/map-for-agents-2026-10-21/plan3-evals/`. If `eval:map` stays under 4, change the line's wording or the tools' descriptions, never the pass rule, and run all three again.
- [ ] **Step 3: Commit**: `test: eval:map, an assistant asks for the code's context before it edits`, with the results in the commit body.

### Task 6: End to end: the real server against the real app

**Files:**
- Create (shadowgit-app, gitignored): `e2e/scratch/mcp-real-app.spec.ts`

- [ ] **Step 1: Write the spec.** It adds the fixture project to the real app. Then it spawns the built server, `node <mcp worktree>/dist/shadowgit-mcp-server.js`, with `SHADOWGIT_STORAGE_DIR` set to the profile's storage and `SHADOWGIT_SESSION_API` set to the app's. Over stdio JSON-RPC it calls `initialize`, `tools/call get_map`, `get_map {area}` and `get_code_context {symbols: [{name: 'chargeCard'}]}`.
- [ ] **Step 2: Run it.** Expected:
  - every call returns `isError` false, with a `structuredContent` that the tool's output schema accepts;
  - the snapshot is the app's newest;
  - chargeCard's dependents are in two areas.
  Keep the answers in the artifacts folder.
- [ ] **Step 3:** Nothing to commit in the MCP repo. The spec is scratch, and the PR body reports the run.
