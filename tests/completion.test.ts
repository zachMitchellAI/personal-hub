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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { HUB, makeTmp, runHub } from './helpers.ts';

const COMPLETION_SH = resolve(import.meta.dirname, '..', 'completion', 'hub-completion.sh');

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
  'move-file',
  'import-vcf',
  'log-sync',
  'list-sync-log',
  'search',
  'reindex-embeddings',
  'edit-person',
  'edit-channel',
  'edit-task',
  'delete-task',
  'delete-entity',
  'merge-person',
  // S11 — Trello adapter (config surface + the one-way sync flow).
  'trello-config',
  'sync-trello',
  // S14 — completion installer.
  'install-completion',
];

const ADD_VERBS = ALL_VERBS.filter((v) => v.startsWith('add-'));

// Shared seed: two people + one interaction kind, in a throwaway DB.
function seedDb(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  for (const name of ['Casey Smith', 'Dana Jones']) {
    const add = runHub(['add-person', '--name', name], env);
    assert.equal(add.status, 0, add.stderr);
  }
  const inter = runHub(
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
    const r = runHub(args, env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), ALL_VERBS);
  }
});

// Scenario 2 — "add-" prefix narrows to the add-* verbs, still one per line.
test('S9: "add-" prefix completes the add-* verbs', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const r = runHub(['__complete', 'add-'], { HUB_DB: join(tmp, 'life.db') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ADD_VERBS);
});

// Scenario 3 — completing after a verb offers that verb's flags (plus the
// global ones), one per line. Required flags carry a trailing `*` marker
// (REQUIRED_FLAGS) — the marker is display-only; the wiring strips it
// exactly when a lone candidate would be inserted whole. Both the quoted
// single-argument Gherkin form and the per-word shell form must work.
test('S9: "add-interaction --" completes that verb flags', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const expected = ['--kind*', '--date*', '--channel*', '--summary*', '--person', '--db', '--json', '--help'];
  for (const args of [
    ['__complete', 'add-interaction --'], // quoted form, as written in the ticket
    ['__complete', 'add-interaction', '--'], // per-word form, as the shell sends it
  ]) {
    const r = runHub(args, { HUB_DB: join(tmp, 'life.db') });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(lines(r.stdout), expected);
  }
});

// Requiredness is verb-dependent: the same flag name is marked under one verb
// and clean under another. Prefix matching works on the marked string.
test('S9: required flags are marked with a trailing asterisk', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = { HUB_DB: join(tmp, 'life.db') };
  const addTask = runHub(['__complete', 'add-task', '--'], env);
  assert.equal(addTask.status, 0, addTask.stderr);
  assert.ok(lines(addTask.stdout).includes('--title*'), 'required --title must be marked');
  assert.ok(lines(addTask.stdout).includes('--context*'), 'required --context must be marked');
  assert.ok(lines(addTask.stdout).includes('--status'), 'optional --status must be clean');
  assert.ok(!lines(addTask.stdout).includes('--status*'), 'optional --status must not be marked');

  const setTask = runHub(['__complete', 'set-task-status', '--'], env);
  assert.equal(setTask.status, 0, setTask.stderr);
  assert.ok(lines(setTask.stdout).includes('--status*'), 'set-task-status --status is required');

  // A typed prefix still narrows, marker riding the match.
  const prefix = runHub(['__complete', 'add-task', '--ti'], env);
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.deepEqual(lines(prefix.stdout), ['--title*']);

  // Required-first ordering — bash strips the marker silently, so the
  // ordering is the visible cue bash users get: required flags before
  // optional ones (link-entity --target-type* and --target* lead).
  const linkEntity = runHub(['__complete', 'link-entity', '--'], env);
  assert.equal(linkEntity.status, 0, linkEntity.stderr);
  assert.deepEqual(lines(linkEntity.stdout), ['--target-type*', '--target*', '--note', '--db', '--json', '--help']);
});

// Scenario 4 — --person value completion offers the live slugs, and honors
// a typed prefix. The per-word form also exercises the parseArgs-swallowed
// value recovery: parseArgs consumes "--person ca" before the handler runs.
test('S9: --person completes live slugs from the DB', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = seedDb(join(tmp, 'life.db'));
  const all = runHub(['__complete', 'add-task', '--person', ''], env);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(lines(all.stdout), ['casey-smith', 'dana-jones']);

  const prefix = runHub(['__complete', 'add-task', '--person', 'ca'], env);
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
  const all = runHub(['__complete', 'add-task', '--status', ''], env);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(lines(all.stdout), ['ready', 'in-progress', 'completed']);

  const prefix = runHub(['__complete', 'add-task', '--status', 're'], env);
  assert.equal(prefix.status, 0, prefix.stderr);
  assert.deepEqual(lines(prefix.stdout), ['ready']);
});

// Extra — trackable verbs complete --status from TRACKABLE_STATUSES, not the
// task set: the same flag name serves two lifecycles and the verb picks.
test('S9: trackable verbs offer active/closed for --status', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const r = runHub(['__complete', 'set-trackable-status', '--status', ''], { HUB_DB: join(tmp, 'life.db') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['active', 'closed']);
});

// Extra — interaction --kind mines the live distinct kinds (the dynamic tier
// the ticket names); an empty DB offers nothing rather than crashing.
test('S9: interaction --kind completes distinct kinds from live data', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = seedDb(join(tmp, 'life.db'));
  const r = runHub(['__complete', 'add-interaction', '--kind', ''], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['interview']);

  const empty = runHub(['__complete', 'add-interaction', '--kind', ''], { HUB_DB: join(tmp, 'empty.db') });
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
  const other = runHub(['add-person', '--name', 'Routed Person'], { HUB_DB: join(tmp, 'elsewhere.db') });
  assert.equal(other.status, 0, other.stderr);

  const verbs = runHub(['__complete', ''], env);
  assert.ok(!verbs.stdout.includes('__complete'), 'hidden verb leaked into verb completions');

  const routed = runHub(['__complete', '--db', dbPath, 'add-task', '--person', 'ca'], {
    HUB_DB: join(tmp, 'elsewhere.db'),
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.deepEqual(lines(routed.stdout), ['casey-smith']);
});

// Extra — the generated wiring script must exist and parse as bash (the
// shipped artifact is what shells source; a broken script fails silently).
// The required-flag marker (`*`) is display-only: zsh displays it via
// compadd -d while inserting clean names; bash KEEPS it in COMPREPLY
// (readline prints COMPREPLY verbatim in the ambiguous listing) and strips
// it exactly when a lone candidate would be inserted whole — captured via
// mapfile so the `*` survives without pathname expansion; compctl (legacy
// zsh) inserts what it displays, so it strips outright.
test('S9: generated completion script exists and is valid bash', () => {
  assert.ok(existsSync(COMPLETION_SH), 'completion/hub-completion.sh missing — run scripts/generate-completion.mjs');
  const check = spawnSync('bash', ['-n', COMPLETION_SH], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const body = readFileSync(COMPLETION_SH, 'utf8');
  assert.ok(body.includes('hub __complete'), 'script must call the __complete verb');
  assert.ok(body.includes('compadd -d _hub_cands'), 'zsh must display the marker while inserting clean names');
  assert.ok(!body.includes('compadd -- `hub __complete'), 'zsh must not insert the raw marked candidates');
  assert.ok(body.includes('mapfile -t _hub_cands'), 'bash must capture marked candidates without pathname expansion');
  assert.ok(
    body.includes('${_hub_cands[0]%\\*}'),
    'bash must strip the marker exactly when one candidate would be inserted',
  );
  assert.ok(body.includes('tr -d "*"'), 'compctl must strip the marker (it inserts what it displays)');
  assert.ok(!body.includes('--compzsh --compgen'), 'script must not require omelette at runtime');
});

// Extra — the bash wiring contract in action: drive _hub_completion (the
// function the script registers via `complete -F`) against the real CLI.
// Multiple candidates keep the marker — readline prints COMPREPLY verbatim
// in the ambiguous menu, and required-first ordering must survive — while a
// lone candidate is inserted whole, so its marker must be stripped. Stubs
// for the bash-completion helpers keep the probe portable to machines
// without the bash-completion package; `hub()` shadows whatever `hub` is on
// PATH so the probe uses this checkout's CLI. Flag completion is tier-1
// static data — no DB is opened, so no throwaway DB is needed here.
test('S9: bash wiring keeps markers in the menu, strips on insertion', () => {
  const probe = [
    `command -v _get_comp_words_by_ref >/dev/null || _get_comp_words_by_ref() { cur=\${COMP_WORDS[COMP_CWORD]}; prev=\${COMP_WORDS[COMP_CWORD-1]}; }`,
    `command -v __ltrim_colon_completions >/dev/null || __ltrim_colon_completions() { :; }`,
    `. '${COMPLETION_SH}'`,
    `hub() { node '${HUB}' "$@"; }`,
    `COMP_WORDS=(hub add-task --); COMP_CWORD=2; COMP_LINE='hub add-task --'; COMP_POINT=\${#COMP_LINE}`,
    `_hub_completion`,
    `echo MULTI`,
    `printf '%s\\n' "\${COMPREPLY[@]}"`,
    `COMP_WORDS=(hub add-task --ti); COMP_CWORD=2; COMP_LINE='hub add-task --ti'; COMP_POINT=\${#COMP_LINE}`,
    `_hub_completion`,
    `echo SINGLE`,
    `printf '%s\\n' "\${COMPREPLY[@]}"`,
  ].join('\n');
  const r = spawnSync('bash', ['-c', probe], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const multi = lines(r.stdout.split('SINGLE')[0]);
  const single = lines(r.stdout.split('SINGLE')[1]);
  assert.deepEqual(multi, [
    'MULTI',
    '--title*',
    '--context*',
    '--person',
    '--status',
    '--due-date',
    '--origin',
    '--notes',
    '--trello-visible',
    '--db',
    '--json',
    '--help',
  ]);
  assert.deepEqual(single, ['--title']);
});

// Extra — a partial flag word that parseArgs cannot parse (`--ti` is not a
// known flag) used to swallow the word and offer nothing on Tab; the
// parseFailed recovery in hub.ts re-dispatches the raw argv so the flag
// completes — with the required marker, no less.
test('S9: partially-typed flag word completes from the raw argv', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const env = { HUB_DB: join(tmp, 'life.db') };
  const r = runHub(['__complete', 'add-task', '--ti'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lines(r.stdout), ['--title*']);
});

// Extra — a bare trailing flag word (the case that makes parseArgs throw
// "argument missing") fails soft: the parseFailed recovery reframes it as
// completing that flag's value with an empty prefix. An empty throwaway DB
// offers nothing; a seeded one offers the slugs.
test('S9: bare trailing flag word fails soft with value candidates', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const bare = runHub(['__complete', 'add-task', '--person'], {
    HUB_DB: join(tmp, 'life.db'),
  });
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout, '');

  const env = seedDb(join(tmp, 'seeded.db'));
  const seeded = runHub(['__complete', 'add-task', '--person'], env);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.deepEqual(lines(seeded.stdout), ['casey-smith', 'dana-jones']);
});
