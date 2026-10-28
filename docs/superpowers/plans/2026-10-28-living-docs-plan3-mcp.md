# Living docs, plan 3: shadowgit-mcp-server 2.6.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent keeps the project's docs pages current as it works. After it words its session's Lens, `write_lens_words` asks it to update the pages its session changed, through `get_docs` and `write_docs`. `get_map` and `get_code_context` give it each area's page summary before it edits. `npm run eval:docs` measures this with a real Claude Code.

**Architecture:**
- The app (shadowgit-app #79, merged at 13500b48) serves:
  - `GET /api/docs`, which answers `{ head, mapAsOf, pages, next, limits }`. A request with no `area` and no `all` reads the latest session; `area` (repeatable) and `overview=true` name pages; `all=true` with `after` and `map` gives the next batch.
  - `POST /api/docs`, which takes `{ repoPath, head, author, pages }` and answers `{ head, pages: [{ page, kept, dropped | reason }] }`.
  - The map routes' new `docs` field.
  - 202 while a count or a map build passes the app's deadline, and 404 from apps older than 0.3.14.
- The server mirrors these shapes in zod, tested against answers captured from the real app, so `structuredContent` carries them.
- The descriptions, the instructions and `write_lens_words`' `next` tell the agent when to use them.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/server` v2, zod v4, Vitest, esbuild; the app's e2e harness (Playwright on Electron) for the capture.

**Spec:** `docs/superpowers/specs/2026-10-27-living-docs-design.md` in shadowgit-app (main since #79), section "The agent's flow". The app's shapes are in `electron/code-graph/docs-agent.ts` on shadowgit-app main:
- `AgentDocPage`, `AgentDocChanges`, `DocsReadAnswer` (`next: { after, map } | null`), `DocsWriteAnswer`, `DocWrite`;
- `mapDocs` (`{ area, summary, behind: number | null }`) and `contextDocs` (`{ area, label, summary }`).

The facts are code-graph 0.9.1's `AreaPageFacts` and `OverviewFacts` (`docs/facts`), and the words its `DocWords` and `DocRecord` (`docs/words`).

## Global Constraints

- **Optional fields.** Every new field is optional: with an app before 0.3.14 every answer reads as before, and no structured answer gains a `docs` key.
- **Older apps.** `GET` and `POST /api/docs` answer 404 there. `get_docs` and `write_docs` then say, verbatim: "This version of ShadowGit has no docs pages for AI assistants. Ask the user to update the ShadowGit app." `write_lens_words` adds no `next`.
- **Never slower, never failed by docs.**
  - `write_lens_words` keeps its answer when the docs probe fails, times out (`DOCS_PROBE_MS = 20_000`), answers 202 or answers 404; it then adds no `next`.
  - `get_map` and `get_code_context` parse with `docs` optional and never call `/docs`.
- **Open values.** A page's `state` is an open string (`no-words`, `current`, `behind`, `not-in-map`, `not-counted` today), and so is a change's `change`.
- **The words.** ShadowGit's own words describe and never judge: no "violation", "violates", "breaks", "forbidden", "not allowed", "warning", "error", "bad", "should", "circular", "coupling" or "risky", in a description, the instructions or any text answer. The agent is asked to describe what the code does and how, never to judge it.
- **Descriptions** of `get_docs` and `write_docs`, the instruction line and `write_lens_words`' `next` are verbatim in Tasks 3 and 4.
- **Timeouts.** `/docs` calls use the 58 s `SLOW_REQUEST_TIMEOUT_MS`, which is above the app's 55 s deadline.
- **Version.** 2.6.0 in `package.json`, `package-lock.json` and `server.json`. README.md and CHANGELOG.md keep CRLF (`tests/release.test.ts`).
- **Publishing.** The npm publish is Alessandro's, after the ShadowGit release that carries plan 2 (0.3.14).
- **House rules.** No `any`, no non-null `!`, no `eslint-disable`. `npm run lint`, `npx tsc --noEmit` and `npm test` stay at 0.

## Calls this plan makes

1. **`write_docs` input is flat, for a model to fill.** Each page is `{ area?: string; overview?: true; holds?: true; summary?: string; body?: (string | Piece[])[] }`, where a body paragraph may be plain text.
   - The server builds the app's `DocWrite` and refuses, before any request, a page with both or neither of `area` and `overview`, or with neither `holds` nor a summary and a body.
   - A plain paragraph becomes `[{ text }]`.
2. **`get_docs` input:** `areas?: string[]`, `overview?: boolean`, `all?: boolean`, `next?: { after, map }` (the cursor `get_docs` answered, passed back whole), `repo?`. `all` with `areas` is refused by the server.
3. **The docs probe after `write_lens_words`** is a `GET /api/docs` with no arguments. Its `next` names the pages (by area id, and "the Overview"), and only when the probe answered pages.
4. **`get_map`'s text** gives each listed area its page summary, and "N changes behind" when the app counted one. **`get_code_context`'s text** gives a "Pages:" line for the areas holding its targets.
5. **`eval:docs`** runs a real Claude Code against the fake app on the map webshop, with a task touching `src/billing` and `src/jobs` and no word about docs. The fake app answers `GET /api/docs` with the captured session answer. A run passes when, after `write_lens_words`, it calls `write_docs` with both pages, each with a summary and a body (or `holds`). The eval passes at 4 of 5 runs.
6. **`npm run eval`** (the phrases from docs.shadowgit.com) gains "What does the billing area do?" (`get_docs` for `src/billing`) and "Document this project in ShadowGit" (`get_docs` with `all`), and the README's "What to ask" gains them.

## Review Focus

1. **An app before 0.3.14.**
   - `get_docs` and `write_docs` give the update message.
   - `write_lens_words` answers as 2.5.1 did, with no `next`.
   - `get_map` and `get_code_context` parse and gain no `docs` key.

   Covered by Tasks 2–4.
2. **The app counting past its deadline (202).** `get_docs` says to ask again in a minute, in the app's words. `write_lens_words` gives no `next` and keeps its answer. Covered by Tasks 3–4.
3. **A write the server can't send.**
   - A page with both `area` and `overview` is refused, and nothing is sent.
   - So is one with no words and no `holds`.
   - A body of plain-text paragraphs is sent as pieces.

   Covered by Task 3.
4. **The `all` cursor.** `next` from one answer is sent back whole (`after` and `map`) as the next request's query. Covered by Task 3.
5. **A judging word** in a description, the instructions or any docs text. Covered by Task 4's judging test over every tool's description and every text answer built from the fixtures.

---

### Task 1: Real app answers carrying docs pages, as fixtures

**Files:**
- Create: `tests/fixtures/docs/` with the six answers below, as the app sent them (with `success`), formatted as `tests/fixtures/rules/*.json` are.
- Create (in the shadowgit-app worktree `/work/.t3/worktrees/shadowgit-app/t3code-eddd8fec`, on main, gitignored): `e2e/scratch/capture-docs-answers.spec.ts`.

**Interfaces:**
- Produces the six fixtures, all of the map webshop (`tests/fixtures/map/project.json`):
  - `session.json`: `GET /api/docs` after a session whose edit adds `lateFee(amount: number): number` (returning `amount * 1.05`) to `src/billing/charge.ts`, and makes `retryFailedCharges` in `src/jobs/retry.ts` charge `lateFee(amount)`. Its `pages` hold `src/billing` and `src/jobs`, each `no-words` with its facts.
  - `area.json`: `GET area=src/billing` after words for `src/billing` were written at that head, then a code edit to `src/billing/money.ts`. The page reads `behind`, with `changes.count` ≥ 1 and `words.author` `Claude Code`.
  - `all.json`: `GET all=true`, the first batch, with `next: { after, map }`.
  - `written.json`: `POST /api/docs` of `src/billing` with one link that names nothing (`ghost in src/billing/charge.ts`) and `src/nowhere`. It answers one page kept with `dropped`, and one refused with its `reason`.
  - `map-summary.json`: `GET /api/map` with `docs` holding `src/billing`.
  - `context.json`: `POST /api/map/context` for `src/billing/charge.ts`, with `docs` holding `src/billing`.

- [ ] **Step 1: Write the capture spec** with the e2e helpers (`e2e/support/session-api.ts`: `docs`, `writeDocs`, `map`, `mapContext`, `sessionOf`, `checkpoint`). It writes `project.json`'s files into the e2e `project`, adds it, then makes and saves each answer above in order. Each save is preceded by expectations on the facts the Interfaces block names.
- [ ] **Step 2: Run it** in the app worktree: `E2E_SCRATCH=1 npm run test:e2e -- scratch/capture-docs-answers`. Expected: PASS, and the six files are written.
- [ ] **Step 3: Commit** the fixtures: `test: real app answers carrying docs pages, captured from the app`.

### Task 2: The mirror carries the docs, and the map routes their summaries

**Files:**
- Create: `src/doc-shapes.ts`
- Modify: `src/session-api.ts`, `src/map-shapes.ts`, `tests/helpers/fake-app.ts`
- Test: `tests/session-api.test.ts`

**Interfaces:**
- Produces: `src/doc-shapes.ts`, a leaf importing zod and `map-shapes`' `listed` and `SymbolRef`. It holds zod schemas for:
  - `DocPiece = { text; symbol?: { file; name }; area? }`;
  - `DocWords = { summary; body: DocPiece[][] }`;
  - `DocRecord = { version; words; author; at; time; then? }`;
  - `AreaFacts` and `OverviewFacts`, mirroring code-graph 0.9.1;
  - `DocChanges = { count; symbols: listed({ name, path, change }); dependencies: string[]; goneLinks: string[]; areas?; layers? }`;
  - `DocPage = { page: { area } | { overview: true }; label; state: string; facts: AreaFacts | OverviewFacts | null; rules: string[]; words: DocRecord | null; changes: DocChanges | null; countFailure?; former?: { area; words }[] }`;
  - `DocsCursor = { after: int; map: string }`;
  - `DocsRead = { head; mapAsOf; pages: DocPage[]; next: DocsCursor | null; limits: { summary; bodyWords } }`;
  - `DocsWritten = { head; pages: ({ page; kept: true; dropped: string[] } | { page; kept: false; reason })[] }`;
  - `MapDocs = { area; summary; behind: int | null }[]` and `ContextDocs = { area; label; summary }[]`.
- Produces, in `src/session-api.ts`:
  ```ts
  export const APP_WITHOUT_DOCS = 'This version of ShadowGit has no docs pages for AI assistants. Ask the user to update the ShadowGit app.';
  /** Docs pages for the agent: the latest session's without areas or all, those named, or a batch of those without words. */
  export function readDocs(input: { repoPath: string; areas?: string[]; overview?: boolean; all?: boolean; next?: DocsCursor; timeoutMs?: number }): Promise<z.infer<typeof DocsRead>>;
  /** The agent's words for pages, kept at `head`. */
  export function sendDocs(input: { repoPath: string; head: string; author: string; pages: AppDocWrite[] }): Promise<z.infer<typeof DocsWritten>>;
  ```
  - 404 throws `APP_WITHOUT_DOCS`. A 202 throws the app's own sentence (`failure`).
  - The query is `repoPath`, each `area`, then `overview=true` and `all=true` (only when true), and `after` and `map` from `next`.
  - `AppDocWrite` is `({ area } | { overview: true }) & ({ words: DocWords } | { holds: true })`.
- `SummaryRead` gains `docs: MapDocs.optional()`, and `ContextRead` gains `docs: ContextDocs.optional()`.
- The fake app gains:
  - `docsRoutes` (false answers the catch-all 404);
  - `docsStatus` (200 | 202);
  - `docsAnswer` (by default `session.json` without `success`);
  - `docsWritten` (by default `written.json`);
  - each POST to `/docs` recorded as any request is.

- [ ] **Step 1: Write the failing tests** in `tests/session-api.test.ts`, `describe('docs')`:
  - **"reads the real app's docs answers"**: each of the six fixtures parses with its schema.
  - **"asks for the session's pages, named pages, and the next batch"**: `readDocs` sends the query of each mode, with `next` as `after` and `map`.
  - **"says an app without docs needs updating, and passes on the app's sentence while it counts"**: 404 and 202.
  - **"reads a map answer from an app before docs"**: `SummaryRead` of `tests/fixtures/rules/summary.json` has no `docs`.
- [ ] **Step 2: Run them.** `npx vitest run tests/session-api.test.ts`. Expected: FAIL; `doc-shapes` is not found.
- [ ] **Step 3: Implement** the shapes, the client and the fake app.
- [ ] **Step 4: Run them, then everything.** PASS; then lint, tsc and test stay at 0.
- [ ] **Step 5: Commit:** `feat: read and write the app's docs pages, and the map's page summaries`

### Task 3: `get_docs` and `write_docs`

**Files:**
- Create: `src/tools/docs.ts`
- Modify: `src/server.ts` (register)
- Test: `tests/tools-docs.test.ts`, with a snapshot of each text answer in `tests/__snapshots__/`

**Interfaces:**
- `registerDocs(server)` registers:
  - **`get_docs`**, titled "Read docs pages":
    - input: `areas?: string[]` ("Area ids, as get_map and get_docs name them"), `overview?: boolean`, `all?: boolean`, `next?: { after, map }` ("The next get_docs answered, as given"), `repo`;
    - annotations: readOnly, idempotent.
  - **`write_docs`**, titled "Write docs pages":
    - input: `head` (a snapshot hash), `pages` (1–10, each `{ area?, overview?, holds?, summary?, body? }`, with `body: (string | DocPiece[])[]`), `repo`;
    - annotations: destructive, since words written for a page replace the ones it had; idempotent.
- **`get_docs` description**, verbatim:
  "Read the docs pages ShadowGit keeps for a tracked project: one per area of its map, plus an Overview, each written by an AI assistant. A page comes with the facts ShadowGit draws from the map (folder, sizes, layers, what it depends on and what depends on it, processes, its most depended-on symbols, the project's rules that name it), its words so far with who wrote them and at which snapshot, and what changed in the area since them: symbols changed in their code, dependency facts, links that no longer name anything. With no arguments: the pages the latest AI session changed whose words are missing or behind. With areas, and overview: those pages. With all: pages without words, largest area first, five at a time, with next for the following batch. Answers head, the snapshot write_docs keeps the words at. Needs the ShadowGit app running."
- **`write_docs` description**, verbatim:
  "Write the words of docs pages get_docs read, at the head it answered. For each page, an area by its id or overview: true, then a summary, one sentence on what it is for (at most 200 characters), and a body, short paragraphs on how it works (at most 400 words), each paragraph text or pieces, a piece linking a symbol (its file and name, as get_docs and get_code_context name them) or an area by its id, where the text names it. Or holds: true, when the words still hold after the changes get_docs listed: they are kept again at head, unchanged. Describe what the code does and how it works; links that name nothing at head are made plain text and named back. ShadowGit keeps every version in its own history, never in the project's files."
- **`get_docs`' text**, per page:
  - a line `<label> (<area id>, or Overview): <state>`, with "written by <author> at <head 8>", "N changes since", the count failure, and "no longer in the map" as they apply;
  - the facts in brief: folder, files and symbols, layers, depends on and depended on by (labels with counts), processes, most depended on (name in file);
  - the rules quoted, then the words (summary, then each paragraph as text with each link named `name (file)` or `area <id>`);
  - the changes (symbols with their change, dependency sentences, gone links, areas and layers gained or lost), and former pages' words.

  Then the line: "Write with write_docs, head <head>: for each page a summary of one sentence (at most <summary> characters) and a body of short paragraphs (at most <bodyWords> words), naming symbols and areas with links; or holds: true where the words still hold." An `all` answer with `next` ends with "More pages without words: get_docs with all and next <json>."
- **`write_docs`' text:**
  - "ShadowGit keeps your words for <pages>." Pages are named by area id or "the Overview".
  - Then, when any: "Made plain text, naming nothing at <head 8>: <dropped>."
  - Then, when any: "Left out: <area>: <reason>; …".

- [ ] **Step 1: Write the failing tests** (`tests/tools-docs.test.ts`, fake app):
  - **"get_docs reads the session's pages, with their facts, words and changes"**: `session.json`. The text names both pages `no-words`, and the structured answer equals the fixture's fields. Snapshot the text.
  - **"get_docs on a page behind its words lists what changed since them"**: `area.json`. Snapshot.
  - **"get_docs passes all's next back whole"**: answering `all.json`. The text ends with the next line, and a second call with that `next` sends `after` and `map` (Review Focus 4).
  - **"get_docs refuses all with areas, and says what the app answers while it counts"**: 202 (Review Focus 2).
  - **"write_docs sends each page as the app takes it"**:
    - `{ area: 'src/billing', summary, body: ['Plain.', [{ text: 'chargeCard', symbol: { file: 'src/billing/charge.ts', name: 'chargeCard' } }]] }` and `{ overview: true, holds: true }` send `[{ area, words: { summary, body: [[{ text: 'Plain.' }], [{ text, symbol }]] } }, { overview: true, holds: true }]` with `author` the client's name;
    - the text of `written.json` names the kept page, the dropped link and the refused page. Snapshot.
  - **"write_docs refuses a page it can't send, sending nothing"**: both `area` and `overview`, neither, and no words without `holds` (Review Focus 3). `requestsTo('/docs')` is empty.
  - **"both tools say an app without docs needs updating"**: `docsRoutes = false` (Review Focus 1).
- [ ] **Step 2: Run them.** Expected: FAIL; the tools don't exist.
- [ ] **Step 3: Implement** `src/tools/docs.ts` and register it.
- [ ] **Step 4: Run them, then everything.** PASS; lint, tsc and test stay at 0.
- [ ] **Step 5: Commit:** `feat: get_docs and write_docs, the project's docs pages for the agent to keep`

### Task 4: The flow: write_lens_words' next, the map's summaries, the instructions

**Files:**
- Modify: `src/tools/lens.ts`, `src/tools/map.ts`, `src/server.ts` (the instructions)
- Test: `tests/tools-lens.test.ts`, `tests/tools-map.test.ts`, `tests/tools-read.test.ts` (the instructions and the judging test)

**Interfaces:**
- **`write_lens_words`'s answer** gains `next?: string` in its text and structure, when a `readDocs({ repoPath, timeoutMs: DOCS_PROBE_MS })` after the words answers pages. Verbatim: "Update the docs pages this session changed: get_docs, then write_docs (<area ids, then "the Overview">)." Any failure of the probe (404, 202, timeout, a shape it doesn't read) gives no `next`, and is never thrown. `DOCS_PROBE_MS = 20_000`.
- **`get_map`'s summary text:** each listed area's line gains `: <summary>` and `(N changes behind)` from `docs`.
- **`get_code_context`'s text** gains `Pages: <label> (<area>): <summary>; …` before `Next:`.
- **The instructions** gain, after the session line, verbatim: "- The user asks what a part of the project does, or asks to document it: get_docs (with areas, or all: true for the whole project), then write_docs."

- [ ] **Step 1: Write the failing tests:**
  - `tests/tools-lens.test.ts`:
    - **"write_lens_words asks to update the session's pages when the app lists some"**: the `next` names `src/billing, src/jobs`.
    - **"write_lens_words answers as before when the app has no docs, counts past its deadline, or has none to update"**: 404, 202, `pages: []`. There's no `next` key, and the words' text is unchanged (Review Focus 1 and 2).
  - `tests/tools-map.test.ts`:
    - **"get_map gives each area its page summary, and how far behind it is"**: `map-summary.json`.
    - **"get_code_context names the pages of its targets' areas"**: `context.json`.
    - **"an app before docs answers as before"**: the rules fixtures, with no `docs` key and no `Pages:` line.
  - `tests/tools-read.test.ts`:
    - **"the instructions send the user's questions about a part of the project to get_docs"**.
    - **"no description, instruction or docs text judges"**: every registered tool's description, `INSTRUCTIONS`, and the text answers of Task 3's and this task's tests built from the fixtures, against the judging-word list (Review Focus 5).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then everything.** PASS; lint, tsc and test stay at 0.
- [ ] **Step 5: Commit:** `feat: the session flow asks for the pages it changed, and the map's tools carry their summaries`

### Task 5: `eval:docs`, the phrases, and 2.6.0

**Files:**
- Create: `scripts/eval-docs.ts`
- Modify:
  - `package.json` (`eval:docs`, version 2.6.0), `package-lock.json` and `server.json` (2.6.0);
  - `scripts/eval-docs-phrases.ts` (two phrases);
  - `README.md` (the tools table, What to ask) and `CHANGELOG.md` (2.6.0), in CRLF.

**Interfaces:**
- **`eval-docs.ts`.** It runs `RUNS` (default 5) Claude Code sessions in the map webshop, with the task, verbatim: "Retry failed charges with a late fee: add lateFee(amount: number): number to src/billing/charge.ts, returning the amount plus 5%, and make retryFailedCharges in src/jobs/retry.ts charge lateFee(amount) for each failed charge."
  - The fake app keeps real checkpoints and answers the Lens eval's way.
  - It answers `GET /api/docs` with no arguments with `session.json`, with `head` set to the history's HEAD.
  - A run passes when, after the run's `POST /lens/words`, a `POST /docs` holds `{ area: 'src/billing' }` and `{ area: 'src/jobs' }`, each with a non-empty summary and body, or `holds`.
  - It prints each run's route order, cost and the pages written. It exits 1 below 4 passing runs.
- **The phrases:**
  - "What does the billing area do?" passes when a `GET /docs` names `area=src/billing`;
  - "Document this project in ShadowGit" passes when a `GET /docs` has `all=true`.
- **CHANGELOG 2.6.0 (Added):** `get_docs` and `write_docs`; `write_lens_words`' `next`; `get_map`'s and `get_code_context`'s page summaries; `eval:docs` with its result. It needs ShadowGit 0.3.14.

- [ ] **Step 1: Write `eval-docs.ts`** and the phrases. Run `npm run build`, and a self-check run of the fake app's answers (the script's own `selfCheck`, as `eval-rules.ts` has).
- [ ] **Step 2: Run the evals** with Claude Code. `PATH=<a folder whose claude is ~/.local/bin/claude-personal3>:$PATH npm run eval:docs`; then `npm run eval` for the two new phrases (`ONLY` to filter, if the script has it). Expected: eval:docs passes at 4 of 5 or more, and both phrases pass. Record the results in the CHANGELOG.
- [ ] **Step 3: Version and docs.** Set 2.6.0, update README and CHANGELOG, and keep CRLF. `npm test` passes `tests/release.test.ts`.
- [ ] **Step 4: Commit:** `feat: eval:docs, the docs phrases, and 2.6.0`

### After the tasks

- **Review, then `/simplify`.** Run the whole-branch review (most capable model), then `/simplify`.
- **Acceptance.** A real Claude Code (`claude-personal3`) with this branch's server, against the real app from main (0.3.14 build), on the map webshop:
  - **AC-1.** A session's change ends with the touched pages written, unprompted. The app's Docs shows them current, with "Words by Claude Code".
  - **AC-2.** "What does the billing area do?" reads the page and answers from it.
  - **AC-3.** "Document this project in ShadowGit" writes the pages in batches until `next` is null.
  - **AC-4.** An app before 0.3.14 (2.5.1's flow): `write_lens_words` answers as before.
- **The PR.** Open it, then run `pr-loop`. After merge, the ShadowGit release 0.3.14 goes out, then Alessandro publishes 2.6.0. The tag and the GitHub release follow as before.
