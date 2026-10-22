// S9 acceptance tests (stories/epic-schema.md S9) — CLI-level over throwaway
// DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map (the ticket's Gherkin):
//   1. `hub __complete ""`        → all verbs, one per line
//   2. `hub __complete "add-"`    → add-* verbs
//   3. `hub __complete "add-interaction --"` → that verb's flags
//   4. `hub __complete add-task --person ""` → live person slugs
//   5. `hub __complete add-task --status ""` → ready/in-progress/completed
// Extra contracts: hidden verb stays out of verb completions, --db routes
// live lookups, trackable verbs offer their own status set, distinct
// interaction kinds come from live data, the generated shell script exists
// and is syntactically valid bash, and a bare trailing flag word fails soft.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');
const COMPLETION_SH = resolve(import.meta.dirname, '..', 'completion', 'hub-completion.sh');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s9-'));
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [HUB, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Lines of stdout, ignoring the single trailing newline. */
function lines(out: string): string[] {
  return out.split('\n').filter((l) => l.length > 0);
}

/** The verb list the S8 CLI serves (kept explicit so the assertion is a contract). */
const ALL_VERBS = [
  'init',
  'add-person',
  'get-person',
  'list-people',
  'add-channel',
  'list-channels',
  'remove-channel',
  'set-primary',
  'add-task',
  'set-task-status',
  'list-tasks',
  'add-subtask',
  'mark-subtask',
  'add-interaction',
  'list-interactions',
  'add-trackable',
  'set-trackable-status',
  'list-trackables',
  'add-trackable-event',
  'list-trackable-events',
  'add-entity',
  'list-entities',
  'link-entity',
  'list-entity-links',
  'unlink-entity',
  'add-file',
  'list-files',
  'log-sync',
  'list-sync-log',
];

const ADD_VERBS = ALL_VERBS.filter((v) => v.startsWith('add-'));

// Shared seed: two people + one interaction kind, in a throwaway DB.
function seedDb(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  for (const name of ['Casey Smith', 'Dana Jones']) {
    const add = runCli(['add-person', '--name', name], env);
    assert.equal(add.status, 0, add.stderr);
  }
  const inter = runCli(
    ['add-interaction', '--kind', 'interview', '--date', '2026-10-20', '--channel', 'discord', '--summary', 'screen'],
    env,
  );
  assert.equal(inter.status, 0, inter.stderr);
  return env;
}

// Scenario 1 — empty partial completes to every verb, one per line. The
// quoted-empty form and the bare no-arg form must behave identically.
test('S9: empty partial completes all verbs one per line', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = seedDb(join(tmp, 'life.db'));
  for (const args of [['__complete', ''], ['__complete']]) {
    const r = runCli(args, env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), ALL_VERBS);
  }
});

// Scenario 2 — "add-" prefix narrows to the add-* verbs, still one per line.
test('S9: "add-" prefix completes the add-* verbs', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const r = runCli(['__complete', 'add-'], { HUB_DB: join(tmp, 'life.db') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ADD_VERBS);
});

// Scenario 3 — completing after a verb offers that verb's flags (plus the
// global ones), one per line. Both the quoted single-argument Gherkin form
// and the per-word shell form must work.
test('S9: "add-interaction --" completes that verb flags', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const expected = ['--kind', '--date', '--channel', '--summary', '--person', '--db', '--json', '--help'];
  for (const args of [
    ['__complete', 'add-interaction --'], // quoted form, as written in the ticket
    ['__complete', 'add-interaction', '--'], // per-word form, as the shell sends it
  ]) {
    const r = runCli(args, { HUB_DB: join(tmp, 'life.db') });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), expected);
  }
});

// Scenario 4 — --person value completion offers the live slugs, and honors
// a typed prefix. The per-word form also exercises the parseArgs-swallowed
// value recovery: parseArgs consumes "--person ca" before the handler runs.
test('S9: --person completes live slugs from the DB', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = seedDb(join(tmp, 'life.db'));
  const all = runCli(['__complete', 'add-task', '--person', ''], env);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(lines(all.stdout), ['casey-smith', 'dana-jones']);

  const prefix = runCli(['__complete', 'add-task', '--person', 'ca'], env);
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.deepEqual(lines(prefix.stdout), ['casey-smith']);
});

// Scenario 5 — --status on a task verb offers exactly the task statuses;
// the agent path and the shell path are the same call, so both forms agree.
test('S9: add-task --status offers ready/in-progress/completed', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = { HUB_DB: join(tmp, 'life.db') };
  // The ticket form (per-word, empty final arg — what a shell sends on Tab)
  // and prefix narrowing (an agent asking "which statuses start with re?").
  const all = runCli(['__complete', 'add-task', '--status', ''], env);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(lines(all.stdout), ['ready', 'in-progress', 'completed']);

  const prefix = runCli(['__complete', 'add-task', '--status', 're'], env);
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.deepEqual(lines(prefix.stdout), ['ready']);
});

// Extra — trackable verbs complete --status from TRACKABLE_STATUSES, not the
// task set: the same flag name serves two lifecycles and the verb picks.
test('S9: trackable verbs offer active/closed for --status', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const r = runCli(['__complete', 'set-trackable-status', '--status', ''], { HUB_DB: join(tmp, 'life.db') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['active', 'closed']);
});

// Extra — interaction --kind mines the live distinct kinds (the dynamic tier
// the ticket names); an empty DB offers nothing rather than crashing.
test('S9: interaction --kind completes distinct kinds from live data', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = seedDb(join(tmp, 'life.db'));
  const r = runCli(['__complete', 'add-interaction', '--kind', ''], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['interview']);

  const empty = runCli(['__complete', 'add-interaction', '--kind', ''], { HUB_DB: join(tmp, 'empty.db') });
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');
});

// Extra — the hidden verb must not leak into its own verb-name completions,
// and --db typed on the line routes the live lookups to that database.
test('S9: __complete stays hidden and --db routes live lookups', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const dbPath = join(tmp, 'routed.db');
  const env = seedDb(dbPath);
  // A person exists ONLY in elsewhere.db, and HUB_DB points there — so if
  // the line-level --db did not win, completion would offer routed-person.
  const other = runCli(['add-person', '--name', 'Routed Person'], { HUB_DB: join(tmp, 'elsewhere.db') });
  assert.equal(other.status, 0, other.stderr);

  const verbs = runCli(['__complete', ''], env);
  assert.ok(!verbs.stdout.includes('__complete'), 'hidden verb leaked into verb completions');

  const routed = runCli(['__complete', '--db', dbPath, 'add-task', '--person', 'ca'], {
    HUB_DB: join(tmp, 'elsewhere.db'),
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.deepEqual(lines(routed.stdout), ['casey-smith']);
});

// Extra — the generated wiring script must exist and parse as bash (the
// shipped artifact is what shells source; a broken script fails silently).
test('S9: generated completion script exists and is valid bash', () => {
  assert.ok(existsSync(COMPLETION_SH), 'completion/hub-completion.sh missing — run scripts/generate-completion.mjs');
  const check = spawnSync('bash', ['-n', COMPLETION_SH], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const body = readFileSync(COMPLETION_SH, 'utf8');
  assert.ok(body.includes('hub __complete'), 'script must call the __complete verb');
  assert.ok(!body.includes('--compzsh --compgen'), 'script must not require omelette at runtime');
});

// Extra — a partial flag word with no value yet (the case that makes
// parseArgs throw "argument missing") fails soft with no candidates.
test('S9: bare trailing flag word fails soft', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const r = spawnSync(process.execPath, [HUB, '__complete', 'add-task', '--person'], {
    env: { ...process.env, HUB_DB: join(tmp, 'life.db') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
