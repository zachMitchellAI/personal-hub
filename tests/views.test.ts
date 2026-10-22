// S8 acceptance tests (stories/epic-schema.md S8) — CLI-level against
// throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map:
//   1. view active_tasks returns exactly the mirror set (trello_visible=1 AND
//      status IN ('ready','in-progress')) ordered due_date NULLS LAST —
//      compared against `list-tasks --mirror` for set equality
//   2. view person_full returns one row per person with channels_json
//      (ordered kind, id) and recent_interactions_json (date desc, id desc);
//      a person with no channels/interactions still yields '[]' columns; a
//      person-less interaction is excluded
//   3. "recent" is the 5 newest interactions per person (judgement call —
//      the ticket leaves it unspecified; flagged in the S8 report): 7
//      interactions seeded, exactly the 5 newest come back
//   4. EXPLAIN QUERY PLAN on a person-lookup by slug uses the unique index
//      people_slug_unique — no full table scan
// Extra contracts: fresh init lands at user_version 7 with both views, and
// every S8 index exists by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s8-'));
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

/** A person_full view row — channels/interactions arrive as JSON text. */
interface PersonFullRow {
  id: number;
  slug: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  relationship_type: string | null;
  employer: string | null;
  notes: string | null;
  created_at: string;
  channels_json: string;
  recent_interactions_json: string;
}

function rawPersonFull(dbPath: string): PersonFullRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM person_full ORDER BY slug').all() as unknown as PersonFullRow[];
  } finally {
    db.close();
  }
}

function rawViewRows(dbPath: string, view: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath);
  try {
    // View names are fixed by the migrations (not user input) — safe to splice.
    return db.prepare(`SELECT * FROM ${view}`).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

// Shared seed: one person + the six-task mirror dataset (four in the mirror,
// two excluded: one completed-but-visible, one ready-but-hidden).
function seedMirrorDataset(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  const person = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(person.status, 0, person.stderr);

  // In the mirror: dated, newest due first.
  const datedEarly = runCli(
    [
      'add-task',
      '--title',
      'Follow up Acme',
      '--context',
      'job-hunt',
      '--trello-visible',
      '--due-date',
      '2026-10-20',
      '--json',
    ],
    env,
  );
  assert.equal(datedEarly.status, 0, datedEarly.stderr);
  const datedLate = runCli(
    [
      'add-task',
      '--title',
      'Prep interview',
      '--context',
      'job-hunt',
      '--trello-visible',
      '--due-date',
      '2026-10-25',
      '--json',
    ],
    env,
  );
  assert.equal(datedLate.status, 0, datedLate.stderr);
  // In the mirror: undated — sort last, after the dated ones.
  const undated1 = runCli(
    ['add-task', '--title', 'Message rec', '--context', 'discord', '--trello-visible', '--json'],
    env,
  );
  assert.equal(undated1.status, 0, undated1.stderr);
  const undated2 = runCli(
    [
      'add-task',
      '--title',
      'Draft cover letter',
      '--context',
      'job-hunt',
      '--status',
      'in-progress',
      '--trello-visible',
      '--json',
    ],
    env,
  );
  assert.equal(undated2.status, 0, undated2.stderr);
  // Excluded: completed but visible.
  const completed = runCli(
    ['add-task', '--title', 'Old chore', '--context', 'home', '--trello-visible', '--json'],
    env,
  );
  assert.equal(completed.status, 0, completed.stderr);
  const completedId = JSON.parse(completed.stdout).id as number;
  const done = runCli(['set-task-status', String(completedId), '--status', 'completed', '--json'], env);
  assert.equal(done.status, 0, done.stderr);
  // Excluded: ready but not Trello-visible.
  const hidden = runCli(
    ['add-task', '--title', 'Hidden task', '--context', 'discord', '--due-date', '2026-10-23', '--json'],
    env,
  );
  assert.equal(hidden.status, 0, hidden.stderr);

  return env;
}

// Acceptance 1 — active_tasks returns exactly the mirror set, due_date NULLS
// LAST, with the view's own ORDER BY honored by a bare SELECT (verified live:
// SQLite applies a view's internal ORDER BY when the outer query adds none).
test('S8: view active_tasks returns exactly the mirror set ordered due_date NULLS LAST', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  seedMirrorDataset(dbPath);

  const rows = rawViewRows(dbPath, 'active_tasks');
  // Exactly the four in-mirror tasks — completed/hidden excluded.
  assert.equal(rows.length, 4, `mirror view must hold 4 rows, got ${rows.length}: ${JSON.stringify(rows)}`);
  assert.deepEqual(
    rows.map((r) => r.due_date),
    ['2026-10-20', '2026-10-25', null, null],
    'order must be due_date ASC with NULLs LAST',
  );

  // Set equality with the S4 CLI mirror query — the view and list-tasks
  // --mirror must never disagree about what "the mirror set" is.
  const mirror = runCli(['list-tasks', '--mirror', '--json'], { HUB_DB: dbPath });
  assert.equal(mirror.status, 0, mirror.stderr);
  const mirrorIds = (JSON.parse(mirror.stdout).tasks as { id: number }[]).map((r) => r.id).sort((a, b) => a - b);
  const viewIds = rows.map((r) => r.id as number).sort((a, b) => a - b);
  assert.deepEqual(viewIds, mirrorIds, 'active_tasks must equal the list-tasks --mirror set exactly');
});

// person_full content — channels ordered (kind, id), interactions newest-first,
// person-less interactions excluded, an empty person still yields '[]' columns.
test('S8: view person_full aggregates channels + recent interactions; empty person yields []', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const casey = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(casey.status, 0, casey.stderr);
  const solo = runCli(['add-person', '--name', 'Solo Person', '--json'], env);
  assert.equal(solo.status, 0, solo.stderr);

  // Channels: email gets --primary (primary_flag=1), mastodon plain. The view
  // must order by kind, then id — email before mastodon.
  const email = runCli(
    ['add-channel', 'casey-smith', '--kind', 'email', '--value', 'casey@acme.co', '--primary', '--json'],
    env,
  );
  assert.equal(email.status, 0, email.stderr);
  const mastodon = runCli(
    ['add-channel', 'casey-smith', '--kind', 'mastodon', '--value', '@casey', '--source', 'imported', '--json'],
    env,
  );
  assert.equal(mastodon.status, 0, mastodon.stderr);

  // Interactions for casey: deliberately out of chronological insertion order.
  const i1 = runCli(
    [
      'add-interaction',
      '--kind',
      'call',
      '--date',
      '2026-10-01',
      '--channel',
      'phone',
      '--summary',
      'Intro call',
      '--person',
      'casey-smith',
      '--json',
    ],
    env,
  );
  assert.equal(i1.status, 0, i1.stderr);
  const i2 = runCli(
    [
      'add-interaction',
      '--kind',
      'meeting',
      '--date',
      '2026-10-15',
      '--channel',
      'zoom',
      '--summary',
      'Onsite loop',
      '--person',
      'casey-smith',
      '--json',
    ],
    env,
  );
  assert.equal(i2.status, 0, i2.stderr);
  const i3 = runCli(
    [
      'add-interaction',
      '--kind',
      'email',
      '--date',
      '2026-10-10',
      '--channel',
      'email',
      '--summary',
      'Thank-you note',
      '--person',
      'casey-smith',
      '--json',
    ],
    env,
  );
  assert.equal(i3.status, 0, i3.stderr);
  // Person-less interaction — valid data, but never attributed to casey.
  const orphan = runCli(
    [
      'add-interaction',
      '--kind',
      'note',
      '--date',
      '2026-10-20',
      '--channel',
      'journal',
      '--summary',
      'Unattributed note',
      '--json',
    ],
    env,
  );
  assert.equal(orphan.status, 0, orphan.stderr);

  const rows = rawPersonFull(dbPath);
  assert.equal(rows.length, 2, 'one person_full row per person');
  assert.deepEqual(
    rows.map((r) => r.slug),
    ['casey-smith', 'solo-person'],
    'view sorts people by slug',
  );

  const caseyRow = rows[0];
  assert.equal(caseyRow.display_name, 'Casey Smith');

  // Channels: (kind, id) order — email first, mastodon second; primary_flag
  // and source ride along inside the JSON objects.
  const channels = JSON.parse(caseyRow.channels_json) as {
    id: number;
    kind: string;
    value: string;
    primary_flag: number;
    source: string | null;
  }[];
  assert.deepEqual(
    channels.map((c) => [c.kind, c.id, c.primary_flag, c.source]),
    [
      ['email', JSON.parse(email.stdout).id, 1, null],
      ['mastodon', JSON.parse(mastodon.stdout).id, 0, 'imported'],
    ],
  );

  // Recent interactions: date DESC with id DESC ties — the person-less
  // interaction (newest date overall) must not appear.
  const recent = JSON.parse(caseyRow.recent_interactions_json) as { id: number; date: string; summary: string }[];
  assert.deepEqual(
    recent.map((i) => [i.id, i.date]),
    [
      [JSON.parse(i2.stdout).id, '2026-10-15'],
      [JSON.parse(i3.stdout).id, '2026-10-10'],
      [JSON.parse(i1.stdout).id, '2026-10-01'],
    ],
  );

  // A person with no channels/interactions still gets well-typed '[]' —
  // json_group_array alone returns NULL over an empty set; coalesce fixes that.
  const soloRow = rows[1];
  assert.equal(soloRow.channels_json, '[]');
  assert.equal(soloRow.recent_interactions_json, '[]');
});

// "Recent" judgement call: the 5 newest interactions per person (date DESC,
// id DESC). Seeded 7 — exactly the 5 newest must survive.
test('S8: person_full recent interactions cap at the 5 newest per person', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };
  const person = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(person.status, 0, person.stderr);

  const dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'];
  for (const date of dates) {
    const add = runCli(
      [
        'add-interaction',
        '--kind',
        'call',
        '--date',
        date,
        '--channel',
        'phone',
        '--summary',
        `Call ${date}`,
        '--person',
        'casey-smith',
        '--json',
      ],
      env,
    );
    assert.equal(add.status, 0, add.stderr);
  }

  const rows = rawPersonFull(dbPath);
  const recent = JSON.parse(rows[0].recent_interactions_json) as { date: string }[];
  assert.equal(
    recent.length,
    5,
    'recent_interactions_json must cap at 5 (the ticket leaves "recent" open; flagged to owner)',
  );
  assert.deepEqual(
    recent.map((i) => i.date),
    ['2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03'],
    'the 5 newest, date DESC',
  );
});

// Acceptance 2 — the person-lookup-by-slug hot path uses the unique index,
// never a full scan.
test('S8: EXPLAIN QUERY PLAN on slug lookup uses people_slug_unique — no full scan', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };
  const person = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(person.status, 0, person.stderr);

  const db = new DatabaseSync(dbPath);
  try {
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM people WHERE slug = 'casey-smith'").all() as {
      detail: string;
    }[];
    const detail = plan.map((p) => p.detail).join(' | ');
    assert.match(detail, /SEARCH people USING/, 'must SEARCH via an index, not SCAN the table');
    assert.match(detail, /people_slug_unique/, 'must use the named unique slug index');
    assert.doesNotMatch(detail, /SCAN people/, 'no full table scan allowed');
  } finally {
    db.close();
  }
});

// Extra contract — fresh init lands at user_version 7 (…+ 007_indexes_views),
// both views exist, and every S8 index exists by name.
test('S8: fresh init lands at user_version 7 with the S8 indexes and views', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db') };
  const init = runCli(['init', '--json'], env);
  assert.equal(init.status, 0, init.stderr);
  assert.deepEqual(JSON.parse(init.stdout).migrations_applied, [1, 2, 3, 4, 5, 6, 7]);

  const db = new DatabaseSync(join(tmp, 'life.db'));
  try {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(uv.user_version, 7, 'fresh init with real migrations must land at user_version 7');

    const objects = db
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('index','view') ORDER BY name")
      .all() as {
      name: string;
      type: string;
    }[];
    const byName = new Map(objects.map((o) => [o.name, o.type]));
    for (const idx of [
      'contact_channels_person_idx',
      'entity_links_entity_idx',
      'files_person_idx',
      'files_task_idx',
      'interactions_date_idx',
      'interactions_person_idx',
      'subtasks_task_idx',
      'tasks_mirror_idx',
      'tasks_person_idx',
      'trackable_events_trackable_idx',
    ]) {
      assert.equal(byName.get(idx), 'index', `S8 index ${idx} must exist`);
    }
    assert.equal(byName.get('active_tasks'), 'view', 'active_tasks view must exist');
    assert.equal(byName.get('person_full'), 'view', 'person_full view must exist');
  } finally {
    db.close();
  }
});
