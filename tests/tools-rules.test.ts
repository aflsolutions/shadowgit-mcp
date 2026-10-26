import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type * as z from 'zod/v4';
import type { CheckpointRules, RuleCheck } from '../src/rule-shapes.js';
import { checkpoint } from '../src/tools/checkpoint.js';
import { RULES_ANSWERS, startFakeApp, type FakeApp } from './helpers/fake-app.js';
import { makeProject, removeTempDirs, restoreEnv, textOf, useStorage } from './helpers/fixtures.js';

let project: string;
let app: FakeApp;

const CAPTURED = RULES_ANSWERS.checkpoint.rules as z.infer<typeof CheckpointRules> & { status: 'checked' };
const RULE = CAPTURED.check.matches[0]?.rule ?? expect.unreachable('the captured check names a rule');
const HEAD = 'c'.repeat(40);
/** A check of the captured rule, with what the test changes. */
const checked = (check: Partial<z.infer<typeof RuleCheck>>) => ({ range: { base: 'b'.repeat(40), head: HEAD }, status: 'checked', check: { ...CAPTURED.check, ...check } });

beforeAll(async () => {
  project = makeProject('webshop');
  useStorage([{ name: 'webshop', path: project }]);
  app = await startFakeApp();
});

afterAll(async () => {
  restoreEnv();
  await app.close();
  removeTempDirs();
});

beforeEach(() => {
  process.env.CLAUDE_PROJECT_DIR = project;
  app.checkpointStatus = 200;
  app.checkpointRules = null;
});

describe('checkpoint', () => {
  it('lists each rule that names a link the change adds, with its reason, its links and its steps', async () => {
    app.checkpointRules = CAPTURED;
    const result = await checkpoint({ title: 'Count users in the nightly report' }, 'Claude Code');
    expect(result.structuredContent).toEqual({
      commit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', title: 'Count users in the nightly report', files_changed: 2, repo: 'webshop', rules: CAPTURED,
    });
    const [link, call] = CAPTURED.check.matches[0]?.links ?? [];
    expect(textOf(result)).toBe([
      'Saved checkpoint a1b2c3d4 "Count users in the nightly report" on webshop (2 files).',
      `The project's rules (.shadowgit-rules): 1 checked, over snapshots ${CAPTURED.range.base?.slice(0, 8)}..${CAPTURED.range.head.slice(0, 8)}.`,
      '- "src/jobs never depends on src/api" because jobs read the database through src/db: names 2 links this range adds (steps c1)',
      `  ${link}`,
      `  ${call}`,
    ].join('\n'));
    expect(link).toBe('src/jobs/report.ts imports src/api/users.ts');
  });

  it('counts the links past the first, says what the range does to the file, and the rules that name none', async () => {
    const links = ['a', 'b', 'c', 'd', 'e'].map((name) => `src/jobs/${name}.ts imports src/api/users.ts`);
    app.checkpointRules = checked({
      rules: 3,
      matches: [{ rule: RULE, count: 7, links, steps: [] }],
      file: { added: ['nothing depends on lodash'], removed: ['src/ui never depends on src/db'] },
    });
    const text = textOf(await checkpoint({ title: 'Report' }, 'Claude Code'));
    expect(text).toContain('- "src/jobs never depends on src/api" because jobs read the database through src/db: names 7 links this range adds\n');
    expect(text).toContain(`  ${links[4]}\n  and 2 more\n`);
    expect(text).toContain('- The other 2 rules name no link this range adds.\n');
    expect(text).toMatch(/- This range changes \.shadowgit-rules: adds "nothing depends on lodash", removes "src\/ui never depends on src\/db"\.$/);
  });

  it('says the file lost its last rule', async () => {
    app.checkpointRules = checked({ rules: 0, matches: [], file: { added: [], removed: [RULE.text] } });
    const text = textOf(await checkpoint({ title: 'Drop the rules' }, 'Claude Code'));
    expect(text).toContain("The project's rules (.shadowgit-rules): 0 checked, over snapshots bbbbbbbb..cccccccc.\n");
    expect(text).toContain('- This range changes .shadowgit-rules: removes "src/jobs never depends on src/api".');
    expect(text).not.toContain('No rule names');
  });

  it('quotes a reason as written', async () => {
    app.checkpointRules = checked({ rules: 1, matches: [{ rule: { ...RULE, because: 'the "db" layer reads it' }, count: 1, links: ['src/jobs/report.ts imports src/api/users.ts'], steps: ['c1'] }] });
    expect(textOf(await checkpoint({ title: 'Report' }, 'Claude Code'))).toContain('- "src/jobs never depends on src/api" because the "db" layer reads it: names 1 link this range adds (steps c1)');
  });

  it('names the range of a check still running, for get_lens', async () => {
    app.checkpointRules = { range: { base: null, head: HEAD }, status: 'running' };
    expect(textOf(await checkpoint({ title: 'Report' }, 'Claude Code'))).toBe([
      'Saved checkpoint a1b2c3d4 "Report" on webshop (2 files).',
      `The check against the project's rules (.shadowgit-rules) is still running, over snapshots from the start..cccccccc: read it with get_lens, passing base null and head "${HEAD}".`,
    ].join('\n'));
  });

  it("says why the rules weren't checked", async () => {
    app.checkpointRules = { range: null, status: 'failed', error: '.shadowgit-rules is not a file' };
    expect(textOf(await checkpoint({ title: 'Report' }, 'Claude Code'))).toBe(
      'Saved checkpoint a1b2c3d4 "Report" on webshop (2 files).\nThe project\'s rules (.shadowgit-rules) weren\'t checked: .shadowgit-rules is not a file',
    );
  });

  it('answers as before for a project without rules', async () => {
    const result = await checkpoint({ title: 'Report' }, 'Claude Code');
    expect(result.structuredContent).not.toHaveProperty('rules');
    expect(textOf(result)).toBe('Saved checkpoint a1b2c3d4 "Report" on webshop (2 files).');
  });
});
