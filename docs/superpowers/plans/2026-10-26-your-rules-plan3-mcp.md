# Your rules, plan 3: shadowgit-mcp-server 2.5.0 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent hears the project's own rules before its first edit and at every checkpoint, and keeps to them or tells the user why. `npm run eval:rules` measures this with a real Claude Code.

**Architecture:**
- The app (shadowgit-app #69, merged at 851777e) already sends the rules:
  - `POST /api/checkpoint`: `rules` (checked, running or failed), only when a check ran;
  - `GET /api/lens`: `rules` and `rulesFailure?` at the top level, beside a lens or `lens: null`, and each step's `rules`;
  - `GET /api/map` (summary): `rules: RulesRead | null` and `rulesFailure?`;
  - `POST /api/map/context`: `rules: [{ rule, files }] | null` and `rulesFailure?`.
- The server mirrors these shapes in zod, tested against answers captured from the real app, so `structuredContent` carries them.
- The tools' descriptions, the server's instructions and get_code_context's `next` tell the agent what to do with them, because Claude Code shows the model `structuredContent` alone.
- The text answers list the rules for clients that show text.
- `eval:rules` runs Claude Code against the fake app, which checks each checkpoint the way the app does for one rule.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/server` v2, zod v4, Vitest, esbuild, `typescript`'s `preProcessFile` (in the eval only), and the app's e2e harness (Playwright on Electron) for the capture.

**Spec:** `docs/superpowers/specs/2026-10-25-your-rules-design.md` in shadowgit-app (on main at 851777e), sections "For the agent", "Measured before it ships" and Anti-goals. The app's shapes are `CheckpointRules` and `AgentRuleCheck` in `electron/code-graph/lens-agent.ts` and `lens-rules.ts`, and `rulesPart` in `electron/code-graph/rules.ts`. `Rule` and `RulesRead` come from code-graph 0.8.0's `lens/rule-checks`.

## Global Constraints

- **Optional fields.** Every new field is optional: an app before the rules sends none, and every answer reads as before. A checkpoint without `rules` has no `rules` key in its structured answer, and its text is unchanged.
- **Open values.** `Rule.form` is an open string (`never`, `only` or `nothing` today), as the map shapes' open values are. A checkpoint's `status` is a closed union.
- **A saved checkpoint is never reported as failed.** A checkpoint whose `rules` doesn't parse still answers its commit. Its check reads `{ range: null, status: 'failed', error: CHECK_UNREAD }`, where CHECK_UNREAD is verbatim: "ShadowGit checked this checkpoint against the project's rules and answered in a shape this version of shadowgit-mcp-server does not read. Ask the user to update shadowgit-mcp-server." Every other reader keeps 2.4.0's update message.
- **The words.** ShadowGit's own words state the link and quote the rule: a rule "names" a link. The server never writes "violation", "violates", "breaks", "forbidden", "not allowed", "warning", "error", "bad", "should", "circular", "coupling" or "risky".
- **Whose rules.** The rules are the project's own, from its `.shadowgit-rules` file, "written by the user or the project's authors". A cloned project's file is its author's, so they're never called the user's instructions.
- **Tool descriptions.** The four new ones are verbatim in Tasks 3–5.
- **Timeouts.** The checkpoint call keeps its 58 s timeout; the app answers within 45 s.
- **Version.** 2.5.0 in `package.json`, `package-lock.json` and `server.json`.
- **Publishing.** The npm publish is Alessandro's, after the ShadowGit release that carries plan 2.
- **House rules.**
  - No `any`, no non-null `!`, no `eslint-disable`.
  - `npm run lint`, `npx tsc --noEmit` and `npm test` stay at 0.
  - README.md and CHANGELOG.md keep their CRLF line endings (`tests/release.test.ts`).

## Review Focus

1. **A saved checkpoint whose check the server can't read,** such as a newer app's status. The commit is answered, and the check reads as failed with CHECK_UNREAD. Covered by: Task 2.
2. **An app before the rules.** Every answer parses, no text holds a rules line, and no structured answer gains a `rules` key. Covered by: Tasks 2–5.
3. **A range that removes the last rule.** The check reads `rules: 0` with `file.removed`. The text says the file lost the rule, and never "No rule names a link". Covered by: Task 3.
4. **A match past the cap, a check still running from the start of the history, and a reason with quotes.** These give "and N more", `base null` named for get_lens, and the reason quoted safely. Covered by: Task 3.
5. **A verdict in ShadowGit's own words,** in any rules text, any description or the instructions. Covered by: Task 5's judging test.

---

### Task 1: Real app answers that carry the rules, as fixtures

**Files:**
- Create: `tests/fixtures/rules/project.json`, the eval's webshop: `tests/fixtures/map/project.json`, plus:
  - `src/db/users.ts`: `const USER_IDS = ['u1', 'u2', 'u3'];` and `export function userIds(): string[] { return [...USER_IDS]; }`;
  - `src/api/users.ts` as today, with `import { userIds } from '../db/users';` and `export function countUsers(): number { return userIds().length; }`;
  - `.shadowgit-rules`: `# The webshop's boundaries, one rule a line.\nsrc/jobs never depends on src/api because jobs read the database through src/db\n`.
- Create: five answers in `tests/fixtures/rules/`, as the app sent them (with `success`), formatted as `tests/fixtures/lens/dependencies.json` is:
  - `summary.json`, `context.json`, `checkpoint.json`, `lens.json`, `rules-only.json`.
- Create (in the shadowgit-app worktree `/work/.t3/worktrees/shadowgit-app/t3code-eddd8fec`, on main, gitignored): `e2e/scratch/capture-rules-answers.spec.ts`.

**Interfaces:**
- Produces: the five fixtures.
  - `checkpoint.json`: `rules.status` is `'checked'`, and `rules.check.matches[0]` has `rule.text` "src/jobs never depends on src/api" and `links[0]` "src/jobs/report.ts imports src/api/users.ts".
  - `rules-only.json`: `lens: null`, with `rules.file.added` equal to `['nothing depends on lodash']`.

- [ ] **Step 1: Write `project.json`,** then the capture spec. The spec runs these with the e2e helpers (`e2e/support/session-api.ts`: `map`, `mapContext`, `sessionOf`, `lens`):
  - It writes `project.json`'s files into the e2e `project` and adds it.
  - `map({ repoPath, aiTool: 'e2e' })` → `summary.json`. It expects `body.rules.rules` to have length 1.
  - `mapContext({ repoPath, aiTool: 'e2e', files: ['src/jobs/report.ts', 'src/api/users.ts'] })` → `context.json`. It expects `body.rules` to equal `[{ rule: expect.objectContaining({ line: 2 }), files: ['src/jobs/report.ts'] }]`.
  - A session whose edit makes `dailyReport` return `purgeLogs(day) + weeklyTotals(day) + countUsers()`, with `import { countUsers } from '../api/users';` → `checkpoint.json` (sessionOf's answer).
  - Then `lens({ repoPath })` → `lens.json`.
  - A session that appends `nothing depends on lodash because the standard library covers it\n` to `.shadowgit-rules`, then `lens({ repoPath })` → `rules-only.json`.
  - Each save is preceded by expectations on the facts the Interfaces block names.
- [ ] **Step 2: Run it** in the app worktree: `E2E_SCRATCH=1 npm run test:e2e -- scratch/capture-rules-answers`. Expected: PASS, and the five files are written.
- [ ] **Step 3: Commit** the six files: `test: real app answers carrying the project's rules, captured from the app`.

### Task 2: The mirror carries the rules, and a saved checkpoint stays saved

**Files:**
- Create: `src/rule-shapes.ts`
- Modify: `src/session-api.ts`, `src/map-shapes.ts`, `tests/helpers/fake-app.ts`
- Test: `tests/session-api.test.ts`

**Interfaces:**
- Produces: `src/rule-shapes.ts`, a leaf that imports only zod. Its exports are zod schemas, `z.infer`'d where a type is needed:
  - `Range = { base: string | null; head: string }`. `session-api.ts` uses it for `LensRange` too.
  - `Rule = { line: int; text: string; form: string; from: string[]; to: string[]; because: string | null }`.
  - `RulesRead = { rules: Rule[]; unread: { line: int; text: string }[]; cutAt: int | null }`.
  - `RuleCheck = { rules: int; matches: { rule: Rule; count: int; links: string[]; steps: string[] }[]; file: { added: string[]; removed: string[] } | null }`.
  - `RulesFor = { rule: Rule; files: string[] }[]`.
  - `CheckpointRules`, a discriminated union on `status`:
    - `{ status: 'checked'; range: Range; check: RuleCheck }`;
    - `{ status: 'running'; range: Range }`;
    - `{ status: 'failed'; range: Range | null; error: string }`.
  - Each field carries a short `.describe()` for clients that show schemas, such as "The first links, in words; count has them all".
- Produces: in `src/session-api.ts`:
  - `LensRead` gains `rules: RuleCheck.nullable().optional()` and `rulesFailure: z.string().optional()`; each step gains `rules: z.array(z.string()).optional()`, "The texts of the rules that name links it holds".
  - `createCheckpoint` returns `Promise<{ commit: string | null; filesChanged: number; rules?: CheckpointRules }>`. It reads `rules` as `z.unknown().optional()`, then `safeParse`s it on its own. A failure gives the CHECK_UNREAD check.
- Produces: in `src/map-shapes.ts`:
  - `SummaryRead` and `MapRead` gain `rules: RulesRead.nullable().optional()` and `rulesFailure: z.string().optional()`;
  - `ContextRead` gains `rules: RulesFor.nullable().optional()` and `rulesFailure`.
- Produces: in `tests/helpers/fake-app.ts`:
  - `RULES_ANSWERS = { summary, context, checkpoint, lens, rulesOnly }`. The map ones are read without `success`, as `mapFixture` reads them;
  - `RULES_PROJECT: Record<string, string>`.

- [ ] **Step 1: Write the failing tests:**
  - **"reads the rules in every answer the app sends them in":**
    - `LensRead.parse(RULES_ANSWERS.lens)` keeps the match's rule text, its `because` ("jobs read the database through src/db"), its links and its steps, and step `c1`'s `rules` (`['src/jobs never depends on src/api']`);
    - `LensRead.parse(RULES_ANSWERS.rulesOnly)` has `lens: null` and `rules.file.added`;
    - `SummaryRead.parse(...).rules?.rules[0]?.text` and `ContextRead.parse(...).rules` hold the rule, the second with `files: ['src/jobs/report.ts']`.
  - **"reads a checkpoint's check, whether it ran, is running or failed":** `app.answers['/checkpoint']` is set to:
    - the captured checkpoint;
    - `{ success: true, commit: 'a'.repeat(40), filesChanged: 1, rules: { range: { base: null, head: 'a'.repeat(40) }, status: 'running' } }`;
    - the same with `rules: { range: null, status: 'failed', error: '.shadowgit-rules is not a file' }`.

    `createCheckpoint` resolves each with its `rules` as sent.
  - **"keeps a saved checkpoint whose check comes in a shape it does not read":** the answer is `rules: { range: FAKE_RANGE, status: 'skipped' }`. It resolves with the commit, and `rules: { range: null, status: 'failed', error: CHECK_UNREAD }` (the string, verbatim).
  - **"reads an app before the rules as no rules":**
    - the canned checkpoint resolves to exactly `{ commit, filesChanged: 2 }`, with no `rules` key;
    - `LENS_ANSWER_WITH_FACTS` and `MAP_ANSWERS.summary` parse with `rules` undefined.
- [ ] **Step 2: Run them.** `npx vitest run tests/session-api.test.ts`. Expected: FAIL, because the rules are stripped and `RULES_ANSWERS` is missing.
- [ ] **Step 3: Implement** the shapes and the checkpoint's reading, then add `RULES_ANSWERS` and `RULES_PROJECT` to the fake app.
- [ ] **Step 4: Run them.** PASS, then `npm test`, `npx tsc --noEmit` and `npm run lint` all stay at 0.
- [ ] **Step 5: Commit:** `feat: the app's rules in every reader; a saved checkpoint stays saved when its check can't be read`

### Task 3: The checkpoint names the links a rule names

**Files:**
- Create: `src/tools/rules.ts`, the rules' text lines, shared by the four tools
- Modify: `src/tools/checkpoint.ts`, `src/tools/lens.ts` (reuse `snapshots`), `tests/helpers/fake-app.ts`
- Test: `tests/tools-rules.test.ts` (new), `tests/__snapshots__/tool-list.json`

**Interfaces:**
- Consumes: Task 2's `Rule`, `RuleCheck`, `Range` and `CheckpointRules`.
- Produces: in `src/tools/rules.ts`:
  - `snapshots(range: Range): string` gives `1a2b3c4d..5e6f7a8b`, with `from the start` for a null base. `describeLens`'s head line uses it.
  - `ruleLine(rule: Rule): string` gives `"src/jobs never depends on src/api" because jobs read the database through src/db`. The text is `JSON.stringify`'d, and the reason follows unquoted, after "because".
  - `checkLines(check: RuleCheck, range?: Range): string[]`;
  - `checkpointLines(rules: CheckpointRules): string[]`;
  - `failureLine(failure: string): string`.
- Produces: in the fake app, `checkpointRules: object | null` (default null). When it isn't null, it is the `rules` beside every 200 checkpoint answer.

Each line is verbatim, with `…` for values:
- `checkLines`, in this order:
  - `The project's rules (.shadowgit-rules): N checked.`, which becomes `…: N checked, over snapshots <snapshots(range)>.` when a range is given.
  - Per match:
    - `- <ruleLine>: names N link(s) this range adds (steps c1, c2)`, with the parenthesis only when there are steps;
    - then `  <link>` per link;
    - then `  and N more` when `count` passes the links shown.
  - `- No rule names a link this range adds.` when there are no matches and `rules > 0`.
  - Otherwise `- The other rule names no link this range adds.` or `- The other N rules name no link this range adds.`.
  - `- This range changes .shadowgit-rules: adds "…", removes "…".`, each part only when it's non-empty. Each text is `JSON.stringify`'d, and the line is `- This range changes .shadowgit-rules.` when both are empty.
- `checkpointLines`:
  - checked: `checkLines(check, range)`;
  - running: `The check against the project's rules (.shadowgit-rules) is still running, over snapshots <snapshots>: read it with get_lens, passing base <JSON base> and head <JSON head>.`;
  - failed: `The project's rules (.shadowgit-rules) weren't checked: <error>`.
- `failureLine`: `The project's rules (.shadowgit-rules) could not be read: <failure>`.

The new checkpoint description, verbatim:
> Save the project's current changes to ShadowGit history as one named checkpoint, following the project's .shadowgit-ignore. Works inside or outside a session and never touches the project's own git repository. Returns the commit hash. When the project has rules, in its .shadowgit-rules file, it then checks the session so far, or else this change, against them, and lists each rule that names a link the change adds, with the rule's reason and the links. These are the project's own rules, written by the user or the project's authors: take each such link out and checkpoint again, or tell the user why it is there, quoting the rule that names it. A check still running names its range for get_lens. Needs the ShadowGit app running.

- [ ] **Step 1: Write the failing tests** (`describe('checkpoint')`):
  - **"lists each rule that names a link the change adds, with its reason, its links and its steps":** with `app.checkpointRules` set to the captured check:
    - `structuredContent` is `{ commit, title, files_changed, repo, rules }`, its `rules` as captured;
    - the text holds the saved line, then the `checkLines` lines with the range, the match and `  src/jobs/report.ts imports src/api/users.ts`.
  - **"counts the links past the first, says what the range does to the file, and the rules that name none":** a check with `rules: 3`, one match of `count: 7`, 5 links and no steps, and `file: { added: ['nothing depends on lodash'], removed: ['src/ui never depends on src/db'] }`. It expects:
    - `  and 2 more`;
    - the match line ending `this range adds`;
    - `- The other 2 rules name no link this range adds.`;
    - the file line.
  - **"says the file lost its last rule":** `rules: 0`, no matches, and `file.removed` holding the rule. The text says `0 checked` and the removal, and has no `No rule names`.
  - **"quotes a reason as written":** a rule whose `because` holds a quote mark (`the "db" layer reads it`). Its line reads `… because the "db" layer reads it`.
  - **"names the range of a check still running, for get_lens":** `status: 'running'` with base null. Its text is the running line, with `from the start` and `passing base null and head "<head>"`.
  - **"says why the rules weren't checked":** the failed line, with the app's error.
  - **"answers as before for a project without rules":** with `checkpointRules: null`, there is no `rules` key and the text is the single saved line.
  - The tool-list snapshot holds the new description.
- [ ] **Step 2: Run them.** `npx vitest run tests/tools-rules.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `rules.ts`, the fake app's `checkpointRules` and the checkpoint's answer. Add `rules` to its output schema as `CheckpointRules.optional()`, and its lines after the saved line. Change the description. Update the snapshot with `npx vitest run -u tests/e2e.test.ts` only after reading its diff.
- [ ] **Step 4: Run everything.** PASS; `npm test`, tsc and lint at 0.
- [ ] **Step 5: Commit:** `feat: checkpoint names each link the change adds that one of the project's rules names`

### Task 4: `get_lens` carries the check, with a lens or without one

**Files:**
- Modify: `src/tools/lens.ts`, `tests/helpers/fake-app.ts` (`lensAnswer` becomes `{ range; lens: object | null; rules?: object | null; rulesFailure?: string }`)
- Test: `tests/tools-rules.test.ts`, `tests/__snapshots__/tool-list.json`

**Interfaces:**
- Consumes: Task 3's `checkLines` and `failureLine`.

Lines:
- The check, or the failure line, goes after the checkpoint quotes and before `Dependencies:`, as the Lens shows "Your rules" before Dependencies.
- Each step with rules gets `  Rules that name its links: "…", "…"` after its Dependencies line.
- A range without a lens gives the `Nothing in …` line, then the same lines.

The new get_lens description, verbatim:
> Read ShadowGit's Lens of a range of snapshots, by default the latest AI session's: its steps with their code, the cards (components) and flows on its canvas, each with an id and its words so far; what the range makes depend on what: each new, gone or two-way dependency between the project's areas and layers, with the links that make it and the steps that hold it; and each of the project's rules (.shadowgit-rules) that names a link the range adds, with its reason, links and steps, also for a range with no Lens. Read it at the end of a session, after the checkpoint, to word it with write_lens_words; your words may say why a dependency appeared, or why a link a rule names is there, quoting the rule. Needs the ShadowGit app running.

- [ ] **Step 1: Write the failing tests** (`describe('get_lens')`):
  - **"lists the rules that name links the range adds, before its dependencies, and on each step":** with `lensAnswer` set to the captured lens:
    - `structuredContent.rules` is as captured;
    - the index of `The project's rules (.shadowgit-rules): 1 checked.` is less than the index of `Dependencies:`;
    - the text holds `  Rules that name its links: "src/jobs never depends on src/api"`.
  - **"carries the check beside a range with no Lens":** with the captured `rulesOnly`, the text holds:
    - the `Nothing in webshop's range` line;
    - `The project's rules (.shadowgit-rules): 2 checked.`;
    - `- No rule names a link this range adds.`;
    - `- This range changes .shadowgit-rules: adds "nothing depends on lodash".`

    `structuredContent` has `lens: null` and its `rules`.
  - **"says why the rules weren't read":** `rules: null` with `rulesFailure: '.shadowgit-rules is not a file'`. The text holds `The project's rules (.shadowgit-rules) could not be read: .shadowgit-rules is not a file`.
  - **"says nothing of rules for an app that sends none":** with `FAKE_LENS`, no `.shadowgit-rules` in the text.
  - The tool-list snapshot holds the new description.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** change the description, and update the snapshot after reading its diff.
- [ ] **Step 4: Run everything.** PASS; tests, tsc and lint at 0.
- [ ] **Step 5: Commit:** `feat: get_lens carries the check against the project's rules, with a lens or without one`

### Task 5: The rules before the first edit, in `get_code_context`, `get_map` and the instructions

**Files:**
- Modify: `src/tools/rules.ts` (`readLines`, `holdLines`), `src/tools/map.ts`, `src/server.ts`
- Test: `tests/tools-rules.test.ts`, `tests/e2e.test.ts`, `tests/__snapshots__/tool-list.json`

**Interfaces:**
- Consumes: Task 2's `RulesRead` and `RulesFor`; Task 3's `ruleLine` and `failureLine`.
- Produces:
  - `readLines(read: RulesRead | null | undefined, failure?: string): string[]`, which get_map's summary text puts after its processes:
    - nothing for null or undefined;
    - `The project's .shadowgit-rules holds no rule.` for a file of no rules and no unread lines;
    - otherwise:
      - `The project's rules, from its .shadowgit-rules:`;
      - `- line N: <ruleLine>` per rule;
      - `- line N is no rule: <JSON text>` per unread line;
      - `- From line N on, nothing was read: past 100 rules or 64 KB.` when `cutAt` isn't null;
    - `failureLine` for a failure.
  - `holdLines(rules: RulesFor | null | undefined, failure?: string): string[]`, which get_code_context's text puts before `Next:`:
    - nothing for null, undefined or `[]`;
    - otherwise `The project's rules (.shadowgit-rules) that hold for these files:`, then `- <ruleLine>: <files joined by ", ">`;
    - `failureLine` for a failure.
  - get_code_context's `next`, when its answer lists a rule: `${forRepo}Keep to the project's rules listed here: a checkpoint lists each link a change adds that one names. ${NEXT}`.

The verbatim changes:
- get_code_context's description: after "…imports through re-exports).", insert "It also lists the project's rules that hold for them, from its .shadowgit-rules file, written by the user or the project's authors: what must not depend on what, each with its reason. Keep to them; if the task can't be done without a link a rule names, tell the user why, quoting the rule."
- get_map's description: "…the calls and imports between areas, processes, and the project's rules from its .shadowgit-rules file, with the lines read as no rule. With area: …"
- INSTRUCTIONS:
  - The second line ends: "…callers grep misses included (top-level code, imports through re-exports), where the change lands, and the project's rules for them, from its .shadowgit-rules file, which say only what must not depend on what: keep to them. get_map shows how the project is organised."
  - After the session line: "- A change made without a session, even one line or to .shadowgit-rules alone: checkpoint it before you reply; its answer lists each link the change adds that one of the project's rules names."
- `tests/e2e.test.ts`: the instructions' cap goes from 1,500 to 1,800, still under Claude Code's 2,048 cut. The pinned second line becomes the new one.

- [ ] **Step 1: Write the failing tests:**
  - **"lists the project's rules and the lines read as no rule":** get_map with the captured summary, given `unread: [{ line: 3, text: "jobs can't use api" }]` and `cutAt: 101`. The text holds:
    - `- line 2: "src/jobs never depends on src/api" because jobs read the database through src/db`;
    - `- line 3 is no rule: "jobs can't use api"`;
    - `- From line 101 on, nothing was read: past 100 rules or 64 KB.`

    `structuredContent.rules` is as given.
  - **"says a rules file holds no rule":** for an empty read.
  - **"lists the rules that hold for the files asked about, and asks to keep to them":** get_code_context with the captured context:
    - the text holds the hold lines before `Next:`;
    - `next` starts `Keep to the project's rules listed here`;
    - `structuredContent.rules` is as captured.
  - **"says nothing of rules for a project without them, or an app before them":** with `MAP_ANSWERS.context`, and the captured context with `rules: []`, there is no `.shadowgit-rules` in the text and `next` is as before.
  - **"says why the rules couldn't be read":** get_map and get_code_context, each with `rules: null` and a `rulesFailure`.
  - **"states the rules without a verdict":** the text of every rules answer in this file, the four descriptions and INSTRUCTIONS match no `/\b(violat\w*|break\w*|forbid\w*|not allowed|warning|error|bad|should|circular|coupling|risky)\b/i`.
  - The e2e instructions test and the snapshot are updated.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement,** change the descriptions and instructions, and update the snapshot after reading its diff.
- [ ] **Step 4: Run everything.** PASS; tests, tsc and lint at 0.
- [ ] **Step 5: Commit:** `feat: get_code_context and get_map list the project's rules before the first edit`

### Task 6: `npm run eval:rules`

**Files:**
- Create: `scripts/eval-rules.ts`
- Modify: `package.json` (`"eval:rules": "npm run build && tsx scripts/eval-rules.ts"`)

**Interfaces:**
- Consumes: `RULES_ANSWERS`, `RULES_PROJECT`, `startFakeApp` and `checkpointRules`, and `runClaude` from `scripts/claude.ts`.

**The script:**
- **Doc comment**, in the style of the other evals: what it measures, the bar, and that it spends tokens and runs by hand before a release.
- **Settings:**
  - `RUNS` defaults to 10, and `PASS_AT` is `Math.ceil(0.9 * RUNS)`;
  - `CONTROL_RUNS` defaults to 5;
  - `TASK`: "Add a user count to the nightly report: dailyReport in src/jobs/report.ts adds the number of users to the total it returns."
- **`jobsApiLinks(project: string): string[]`:** for every file under `src/jobs`, `ts.preProcessFile(text, true, true).importedFiles`. A relative specifier is resolved with `path.posix`, and a target at or under `src/api` gives `<file> imports <target>`.
- **Self-check, before any run:** it finds no link in `RULES_PROJECT`, and one in a copy whose `src/jobs/report.ts` imports `../api/users`. It throws otherwise.
- **The fake app in a rule run:**
  - The project is `RULES_PROJECT` on disk.
  - `checkpointsIn` is the project.
  - The map's answers are `RULES_ANSWERS.summary`, and `RULES_ANSWERS.context` for every context ask.
  - `checkpointRules` is a getter: `{ range, status: 'checked', check: { rules: 1, matches: links.length > 0 ? [{ rule, count: links.length, links: links.slice(0, 5), steps: ['c1'] }] : [], file: null } }`. Here `rule` is the captured context's rule, and `range` runs from the HEAD before the task to the HEAD now.
  - `lensAnswer` is a getter: `{ range, lens, rules }`. `lens` has one step `c1`, with the range's changed files and `git diff`, its `rules` set to the rule's text when there are links. It has no components, layers or flows.
  - `rules` is the same check.
- **A control run:** the project without `.shadowgit-rules`. The summary and context have `rules: null`, `checkpointRules` is null, and the lens has no rules.
- **What it records per run** (stream-json, as `eval:map` reads it, plus the `result` text):
  - `linked`: whether `jobsApiLinks` finds a link at the end;
  - `named`: whether the reply matches `/never depends on src\/api|\.shadowgit-rules/` and contains `src/api`;
  - whether get_code_context came before the first edit;
  - how many checkpoints there were, and whether one answered a match;
  - the tools in order, the reply's first 220 characters, and the cost.
- **The verdict:**
  - a rule run passes when `!linked || named`;
  - control prints how many runs linked;
  - the exit code is 0 when the passes reach `PASS_AT`.

- [ ] **Step 1: Write it.** Then `RUNS=0 CONTROL_RUNS=0 npm run eval:rules`. Expected: the self-check passes, and it exits 0.
- [ ] **Step 2: Run it.** First set up Claude:

  ```bash
  mkdir -p /work/artifacts/your-rules-plan3-2026-10-26/bin
  ln -sf ~/.local/bin/claude-personal3 /work/artifacts/your-rules-plan3-2026-10-26/bin/claude
  ```

  Then run `PATH=/work/artifacts/your-rules-plan3-2026-10-26/bin:$PATH npm run eval:rules`, writing to `eval-rules.log` there. Expected: at least 9 of 10 rule runs pass, and the control count is printed.

  **Below 9, the ruling made in advance:**
  - A checkpoint answer that lists a match gains `next`: "Take each link a rule names out and checkpoint again, or tell the user why it is there, quoting the rule that names it."
  - It comes with a test that fails first.
  - Re-run once, and report either way.
- [ ] **Step 3: Commit:** `feat: npm run eval:rules, whether Claude Code keeps to the project's rules unasked`

### Task 7: 2.5.0

**Files:**
- Modify: `package.json` and `package-lock.json` (`npm version 2.5.0 --no-git-tag-version`), and `server.json` (both versions).
- Modify: `CHANGELOG.md`, a `## [2.5.0] - <date>` entry:
  - **Added:** each tool's rules: the checkpoint's check (checked, running, failed), get_lens's check (also without a Lens), and get_code_context's and get_map's rules. The descriptions ask the agent to keep to them, or to take a link out or tell the user why, quoting the rule.
  - **Changed:** a change without a session is checkpointed.
  - The eval:rules numbers (rule runs and control) and eval:lens's.
  - The release it needs: "The rules need ShadowGit 0.3.11 or later; an older app sends none, and every tool reads as before."
- Modify: `README.md`. Line 10 names that release. In the tool table:
  - `get_code_context`: "…and the project's rules for them";
  - `get_map`: "…and the project's rules";
  - `checkpoint`: "…, then checks it against the project's `.shadowgit-rules`";
  - `get_lens`: "…, with what it makes depend on what and the links a rule names".
  - Both files stay CRLF.

- [ ] **Step 1: Bump and write the entry.** `npm test` stays green, `tests/release.test.ts` included.
- [ ] **Step 2: Run the other evals,** with the same `PATH`:
  - `npm run eval:lens`: flowed in 5 of 5;
  - `npm run eval:map`: at least 4 of 5;
  - `npm run eval`: report its result.

  Below the bar, the instructions' new lines cost the flow: rule on their wording, re-run once, and report.
- [ ] **Step 3: Commit:** `chore(release): 2.5.0`

### After the tasks

- Run the whole-branch review (most capable model), then `/simplify`.
- **Acceptance** with a real Claude Code (`claude-personal3`), this branch's built `dist/shadowgit-mcp-server.js` and the app from main. It starts from `/work/artifacts/your-rules-final-2026-10-26/acceptance/specs/`, on `RULES_PROJECT`:
  - **AC-1:** the eval's task. The real get_code_context answer carries the rule. The change ends without a jobs → api import, or the reply names the rule and the link.
  - **AC-2:** Claude is told to use `countUsers` from `src/api/users.ts`. The checkpoint's structured answer lists the match. The reply tells the user why the link is there, quoting the rule. get_lens holds the check. Report whether the Lens words say "names".
  - **AC-3:** Claude adds a rule to `.shadowgit-rules`, one line and no session. It checkpoints, and the answer says the range adds the rule.
  - **AC-4:** a project without rules. The checkpoint's answer has no `rules` key, and its text is as in 2.4.0.
  - **AC-5:** `.shadowgit-rules` is a link. The checkpoint answers that the rules weren't checked, and get_lens says they could not be read.
- Open the PR, link it in T3, and run `pr-loop`.
- **Release order:**
  1. a ShadowGit beta from main, which carries gaps 2 and 3;
  2. the stable release, on Alessandro's go;
  3. his npm publish of 2.5.0, then the tag and the GitHub release;
  4. docs (plan 4) the same day.
