# Dependency facts, plan 3: shadowgit-mcp-server 2.4.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's `get_lens` says what the range makes depend on what, and every Lens and session reader asks for a server update, not a parse error, when the app answers in a shape it doesn't read.

**Architecture:**
- The app's `GET /api/lens` (shadowgit-app #67, merged) already sends the facts:
  - the range's `dependencies: { facts, more }`, each fact with its sentence, level, kind, two ends (`{ label, path }`), evidence sentences and step ids;
  - each step's `dependencies`, its facts' sentences.
- The server mirrors that shape in its zod schema, tested against an answer captured from the real app, so `structuredContent` carries the facts.
- `get_lens`'s description says what they are, because Claude Code shows the model `structuredContent` alone.
- The text answer lists them for clients that show text.
- The map readers' rule (`mapAnswer`: `safeParse`, then a server-update message) becomes the rule for every reader.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/server` v2, zod v4, Vitest, esbuild; the app's e2e harness (Playwright on Electron) for the capture.

**Spec:** `docs/superpowers/specs/2026-10-22-dependency-facts-design.md` in shadowgit-app (merged at a5f9c77), sections "For the agent" and "Docs". Plan 2 (the app) is shadowgit-app #67.

## Global Constraints

- The mirror's new fields are optional: an app before the facts sends none, and reads as before.
- `level` and `kind` are open strings, as the map shapes' open values are: a newer app may add to them.
- The facts' words are the app's (code-graph's sentences). The server adds no word of its own about a fact, and no judging word: "violation", "circular", "bad", "should", "coupling", "risky".
- The update message for a shape the server doesn't read, one per reader kind:
  - `ShadowGit answered with a <map|lens|session|checkpoint> this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server.`
  - The map's sentence stays word for word, as its test pins it.
- 404 answers keep their own messages ("This version of ShadowGit has no Lens for AI assistants…"), as today.
- `get_lens`'s new description, verbatim: "Read ShadowGit's Lens of a range of snapshots, by default the latest AI session's: its steps with their code, the cards (components) and flows on its canvas, each with an id and its words so far, and what the range makes depend on what: each new, gone or two-way dependency between the project's areas and layers, with the links that make it and the steps that hold it. Read it at the end of a session, after the checkpoint, to word it with write_lens_words; your words may say why a dependency appeared. Needs the ShadowGit app running."
- Version 2.4.0 in `package.json`, `package-lock.json` and `server.json`.
- The npm publish is Alessandro's, after the ShadowGit release that carries plan 2.
- House rules: no `any`, no non-null `!`, no `eslint-disable`. `npm run lint`, `npx tsc --noEmit` and `npm test` stay at 0.

## Review Focus

1. **The app's real answer drifts from the mirror.** The captured answer must parse, with its facts, and a test fails when it doesn't. Covered by: Task 1's capture, parsed in Task 2.
2. **An app before the facts.** The answer parses, the text has no Dependencies block, and `structuredContent` has no `dependencies`. Covered by: Task 2, with the existing `FAKE_LENS`.
3. **A reader meets an answer it can't read**, such as a session list without `sessions` or a checkpoint without `commit`. The agent gets the update message, not a ZodError. Covered by: Task 2, one test per reader.
4. **A fact past the cap, and a fact no step holds.** The text says "and N more", and a fact with no steps lists none. Covered by: Task 3.
5. **The description change costs the unprompted Lens flow.** `eval:lens` must still flow in 5 of 5 runs. Covered by: Task 4.

---

### Task 1: A real lens answer with facts, as a fixture

**Files:**
- Create: `tests/fixtures/lens/dependencies.json`, the app's `GET /api/lens` body as it sends it (`success`, `range`, `lens`, `limits`)
- Create (shadowgit-app worktree on `main`, gitignored): `e2e/scratch/capture-lens-answer.spec.ts`

**Interfaces:**
- Produces: `dependencies.json`, whose `lens.dependencies.facts` holds "jobs depends on api for the first time", with a step id and evidence, and whose steps carry `dependencies`.

- [ ] **Step 1: Write the capture spec.**
  - It writes `tests/fixtures/map/project.json`'s webshop into the e2e project and adds it.
  - It runs a session (`startSession`, an edit, a `checkpoint`, `endSession`) whose edit makes `src/jobs/report.ts` import `countUsers` from `src/api/users.ts` and call it.
  - It saves the body of `lens({ repoPath })` to the fixture path in this worktree, its hashes as the app sent them.
- [ ] **Step 2: Run it** with `E2E_SCRATCH=1 npm run test:e2e -- scratch/capture-lens-answer` in the shadowgit-app worktree. Expected: PASS, and the file holds the fact.
- [ ] **Step 3: Commit** the fixture: `test: a real lens answer with dependency facts, captured from the app`

### Task 2: The mirror carries the facts, and every reader asks for a server update

**Files:**
- Modify: `src/session-api.ts`
- Test: `tests/session-api.test.ts`

**Interfaces:**
- Produces: in `src/session-api.ts`:
  - `LensSkeleton` gains `dependencies?: { facts: LensDependency[]; more: number }` and each step `dependencies?: string[]`;
  - `LensDependency = { sentence, level, kind, from: { label, path: string | null }, to, evidence: string[], steps: string[] }`;
  - one helper, `read<S extends z.ZodType>(shape: S, json: unknown, what: 'map' | 'lens' | 'session' | 'checkpoint'): z.infer<S>`, which `safeParse`s and throws the update message. `mapAnswer`, `activeSessions`, `startSession`, `createCheckpoint`, `readLens` and `sendLensWords` all read through it.

- [ ] **Step 1: Write the failing tests:**
  - **"reads a real lens answer with its dependency facts":** `LensRead.parse` of the captured fixture keeps the fact's sentence, its `from`, its evidence and its steps, and the step's `dependencies`.
  - **"asks for a server update when a reader meets a shape it does not read":** the fake app answers `/session/active` with `{ sessions: 'none' }`, `/session/start` with `{}`, `/checkpoint` with `{ commit: 5 }`, `/lens` with a lens whose `steps` is not an array, and `/lens/words` with `{ applied: null }`. Each reader rejects with its message, e.g. `ShadowGit answered with a lens this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server.`
  - **The existing tests stay:** the map's sentence word for word, the 404 messages, and an app without the facts.
- [ ] **Step 2: Run them.** `npx vitest run tests/session-api.test.ts`. Expected: FAIL. The facts are dropped, and the readers throw ZodErrors.
- [ ] **Step 3: Implement** the mirror and `read`, and route every reader through it. The fake app needs a way to answer those routes with a given body: add `answers: Partial<Record<string, unknown>>`, a body per route that overrides its usual one.
- [ ] **Step 4: Run them.** PASS, then `npm test`, `npx tsc --noEmit` and `npm run lint` all stay at 0.
- [ ] **Step 5: Commit:** `feat: get_lens reads the app's dependency facts; every reader asks for a server update on a shape it does not read`

### Task 3: `get_lens` says the facts

**Files:**
- Modify: `src/tools/lens.ts` (`describeLens`, the tool's description)
- Modify: `tests/helpers/fake-app.ts`: `FAKE_FACTS_LENS`, `FAKE_LENS` with the captured answer's facts and step sentences
- Test: `tests/tools-lens.test.ts`, `tests/__snapshots__/tool-list.json`

**Interfaces:**
- Consumes: Task 2's `LensSkeleton` fields.

- [ ] **Step 1: Write the failing tests:**
  - **"lists what the range makes depend on what, with each fact's links and steps":**
    - with `FAKE_FACTS_LENS`, `structuredContent.lens.dependencies` equals the fake's;
    - the text holds a block that starts `Dependencies:`, then `- jobs depends on api for the first time (src/jobs → src/api; steps c1)`, then one indented line per evidence sentence;
    - the step's line is followed by `  Dependencies: jobs depends on api for the first time`.
  - **"counts the facts past the cap, and lists a fact no step holds without steps":** `more: 2` gives `- and 2 more`, and a fact with `steps: []` ends `(src/jobs → src/api)`. A layer fact's ends have no path, so the parenthesis holds only its steps.
  - **"says nothing of dependencies for an app that sends none":** with `FAKE_LENS`, no `Dependencies:` in the text.
  - **The description:** the tool list snapshot holds the new `get_lens` description, verbatim.
- [ ] **Step 2: Run them.** `npx vitest run tests/tools-lens.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the block, after the checkpoint quotes and before the steps, and each step's line, after its symbols. Change the description. Update the snapshot with `npx vitest run -u tests/` only after reading its diff.
- [ ] **Step 4: Run them, then everything.** PASS; `npm test`, tsc and lint at 0.
- [ ] **Step 5: Commit:** `feat: get_lens says what the range makes depend on what`

### Task 4: 2.4.0

**Files:**
- Modify: `package.json`, `package-lock.json`, `server.json` (2.4.0)
- Modify: `CHANGELOG.md`, a `## [2.4.0]` entry: the facts in `get_lens`, the update rule for every reader, and the ShadowGit release it needs. `README.md`: `get_lens`'s line, if it lists what the tool reads.

- [ ] **Step 1: Bump and write the entry.** `npm test` stays green, `tests/release.test.ts` included.
- [ ] **Step 2: Run `npm run eval:lens`** (`claude-personal3` as `claude` on `PATH`, as before). Expected: flowed in 5 of 5. Below that, the description cost the flow: rule on its wording, re-run once, and report.
- [ ] **Step 3: Commit:** `chore(release): 2.4.0`

### After the tasks

- Run the whole-branch review (most capable model), then `/simplify`.
- Run acceptance with a real Claude Code (`claude-personal3`), this branch's built server and the app from `main`, on the webshop:
  - **AC-1:** Claude adds a user count to the nightly report. Its `get_lens` result holds "jobs depends on api for the first time", with its evidence and steps.
  - **AC-2:** Claude's words reach the Lens. Report whether they mention the dependency; the spec says words may, not must.
  - **AC-3:** a session inside one area: `get_lens` holds no facts.
- Open the PR, then run `pr-loop`.
- Release order: ShadowGit's beta, then stable on Alessandro's go; then his npm publish of 2.4.0; docs (plan 4) the same day.
