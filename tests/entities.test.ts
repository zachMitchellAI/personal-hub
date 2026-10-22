// S7 acceptance tests (stories/epic-schema.md S7) — CLI-level against
// throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map:
//   1. entity "vibe-coded dreams" kind "concept" linked to a task AND a
//      person → both links resolve via target_type+target_id
//   2. file "~/hub/files/interview-prep/acme-corp.pdf" indexed against
//      person casey-smith → files row resolves to that person
//   3. sync run moving 3 tasks to Trello → 3 sync_log rows direction
//      "out", adapter "trello-cli", with timestamps — re-run adds no rows
//      (idempotency contract)
// Extra contracts: FK behavior on entity_links/files (invalid target →
// friendly CLI error, never a raw driver crash), slug uniqueness on
// entities, empty-list results valid, user_version lands at 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s7-'));
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

interface EntityJson {
  id: number;
  slug: string;
  kind: string;
  label: string;
  content: string | null;
  created_at: string;
}

interface EntityLinkJson {
  id: number;
  entity_id: number;
  target_type: string;
  target_id: number;
  target_label: string | null;
  note: string | null;
}

interface FileJson {
  id: number;
  path: string;
  kind: string;
  person_id: number | null;
  task_id: number | null;
  added_at: string;
  note: string | null;
}

interface SyncLogJson {
  id: number;
  direction: string;
  adapter: string;
  entity: string;
  entity_id: number;
  action: string;
  ts: string;
  detail: string | null;
}

function rawEntityLinks(dbPath: string): EntityLinkJson[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM entity_links ORDER BY id').all() as unknown as EntityLinkJson[];
  } finally {
    db.close();
  }
}

function rawSyncLog(dbPath: string): SyncLogJson[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM sync_log ORDER BY id').all() as unknown as SyncLogJson[];
  } finally {
    db.close();
  }
}

// Seed helper: init + one person + one task, returning their ids/slugs.
// Every scenario starts from this baseline so link/file targets exist.
function seedBaseline(env: Record<string, string>): { personSlug: string; taskId: number } {
  const init = runCli(['init'], env);
  assert.equal(init.status, 0, init.stderr);
  const person = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(person.status, 0, person.stderr);
  const personJson = JSON.parse(person.stdout) as { slug: string };
  const task = runCli(['add-task', '--title', 'prepanel research', '--context', 'job-hunt', '--json'], env);
  assert.equal(task.status, 0, task.stderr);
  const taskJson = JSON.parse(task.stdout) as { id: number };
  return { personSlug: personJson.slug, taskId: taskJson.id };
}

// Scenario 1 — entity linked to a task AND a person; both links resolve
// via target_type+target_id (polymorphic entity_links.write-path integrity:
// the CLI resolves slugs to row ids before insert, and list-entity-links
// surfaces a readable target_label for each).
test('S7: entity links to a task and a person both resolve', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };
  const base = seedBaseline(env);

  const add = runCli(
    [
      'add-entity',
      '--label',
      'vibe-coded dreams',
      '--kind',
      'concept',
      '--content',
      'an afternoon of letting the agent drive',
      '--json',
    ],
    env,
  );
  assert.equal(add.status, 0, add.stderr);
  const entity = JSON.parse(add.stdout) as EntityJson;
  assert.equal(entity.label, 'vibe-coded dreams');
  assert.equal(entity.kind, 'concept');
  assert.equal(entity.slug, 'vibe-coded-dreams');
  assert.match(entity.created_at, /^\d{4}-\d{2}-\d{2}T/);

  // Link #1 → task (target by numeric id).
  const linkTask = runCli(
    [
      'link-entity',
      entity.slug,
      '--target-type',
      'task',
      '--target',
      String(base.taskId),
      '--note',
      'research for the panel',
      '--json',
    ],
    env,
  );
  assert.equal(linkTask.status, 0, linkTask.stderr);
  const taskLink = JSON.parse(linkTask.stdout) as EntityLinkJson;
  assert.equal(taskLink.entity_id, entity.id);
  assert.equal(taskLink.target_type, 'task');
  assert.equal(taskLink.target_id, base.taskId);
  assert.equal(taskLink.target_label, 'prepanel research');
  assert.equal(taskLink.note, 'research for the panel');

  // Link #2 → person (target by slug; CLI resolves to the row id).
  const linkPerson = runCli(
    ['link-entity', entity.slug, '--target-type', 'person', '--target', base.personSlug, '--json'],
    env,
  );
  assert.equal(linkPerson.status, 0, linkPerson.stderr);
  const personLink = JSON.parse(linkPerson.stdout) as EntityLinkJson;
  assert.equal(personLink.target_type, 'person');
  assert.equal(personLink.target_id, 1, 'person slug must resolve to the person row id');
  assert.equal(personLink.target_label, 'Casey Smith');

  // Both links resolve via target_type+target_id in the list output.
  const list = runCli(['list-entity-links', entity.slug, '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as { count: number; links: EntityLinkJson[] };
  assert.equal(listed.count, 2);
  const byType = Object.fromEntries(listed.links.map((l) => [l.target_type, l]));
  assert.equal(byType.task.target_id, base.taskId);
  assert.equal(byType.task.target_label, 'prepanel research');
  assert.equal(byType.person.target_id, 1);
  assert.equal(byType.person.target_label, 'Casey Smith');

  // Raw DB: the two rows persist with the polymorphic columns intact.
  const raw = rawEntityLinks(dbPath);
  assert.equal(raw.length, 2);
  assert.deepEqual(raw.map((l) => [l.target_type, l.target_id]).sort(), [
    ['person', 1],
    ['task', base.taskId],
  ]);
});

// Scenario 2 — file indexing against a person; the files row resolves to
// that person. Paths are stored as given (no disk I/O), and the hierarchy
// convention (~/hub/files/<slug>/...) is how callers organize the artifact.
test('S7: file indexed against a person resolves to that person', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };
  const base = seedBaseline(env);

  const add = runCli(
    [
      'add-file',
      '--path',
      '~/hub/files/interview-prep/acme-corp.pdf',
      '--kind',
      'pdf',
      '--person',
      base.personSlug,
      '--note',
      'resume tailored for the panel',
      '--json',
    ],
    env,
  );
  assert.equal(add.status, 0, add.stderr);
  const file = JSON.parse(add.stdout) as FileJson;
  assert.equal(file.path, '~/hub/files/interview-prep/acme-corp.pdf');
  assert.equal(file.kind, 'pdf');
  assert.equal(file.person_id, 1, 'the person slug must resolve to the person row id');
  assert.equal(file.task_id, null);
  assert.match(file.added_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(file.note, 'resume tailored for the panel');

  // list-files --person resolves through the stored row (id → slug filter).
  const list = runCli(['list-files', '--person', base.personSlug, '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const listed = JSON.parse(list.stdout) as { count: number; files: FileJson[] };
  assert.equal(listed.count, 1);
  assert.equal(listed.files[0].id, file.id);
  assert.equal(listed.files[0].person_id, 1);
  assert.equal(listed.files[0].path, '~/hub/files/interview-prep/acme-corp.pdf');
});

// Scenario 3 — sync ledger: 3 task moves → 3 "out"/"trello-cli" rows with
// timestamps; a re-run of the same actions adds NO rows (idempotency
// contract is a UNIQUE index over (adapter, direction, entity, entity_id,
// action), caught by the CLI as a successful no-op).
test('S7: sync run logs 3 trello moves; re-run adds no rows (idempotency)', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };
  seedBaseline(env);

  // Two more tasks → three total to "move" in the simulated sync run.
  const t2 = runCli(['add-task', '--title', 'second task', '--context', 'job-hunt', '--json'], env);
  assert.equal(t2.status, 0, t2.stderr);
  const t3 = runCli(['add-task', '--title', 'third task', '--context', 'job-hunt', '--json'], env);
  assert.equal(t3.status, 0, t3.stderr);
  const taskIds = [1, JSON.parse(t2.stdout).id, JSON.parse(t3.stdout).id].sort((a, b) => a - b);
  assert.deepEqual(taskIds, [1, 2, 3]);

  // The sync run: one log-sync per task move ("out" is the default direction).
  for (const id of taskIds) {
    const log = runCli(
      [
        'log-sync',
        '--entity',
        'task',
        '--entity-id',
        String(id),
        '--action',
        'move',
        '--detail',
        'trello list: mirror',
      ],
      env,
    );
    assert.equal(log.status, 0);
    assert.match(log.stdout, /logged sync/);
  }

  // Ledger query: 3 rows, direction "out", adapter "trello-cli", timestamps.
  const list1 = runCli(['list-sync-log', '--json'], env);
  assert.equal(list1.status, 0, list1.stderr);
  const first = JSON.parse(list1.stdout) as { count: number; entries: SyncLogJson[] };
  assert.equal(first.count, 3);
  for (const e of first.entries) {
    assert.equal(e.direction, 'out');
    assert.equal(e.adapter, 'trello-cli');
    assert.equal(e.entity, 'task');
    assert.equal(e.action, 'move');
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.deepEqual(
    first.entries.map((e) => e.entity_id),
    [1, 2, 3],
    'ledger reads chronologically: oldest entry first',
  );

  // Raw row count before the re-run.
  assert.equal(rawSyncLog(dbPath).length, 3);

  // Re-run the exact same sync actions → no new rows, exit 0, "already logged".
  for (const id of taskIds) {
    const rerun = runCli(
      [
        'log-sync',
        '--entity',
        'task',
        '--entity-id',
        String(id),
        '--action',
        'move',
        '--detail',
        'trello list: mirror',
      ],
      env,
    );
    assert.equal(rerun.status, 0, rerun.stderr);
    assert.match(rerun.stdout, /already logged/, 'the re-run must be recognized as a no-op');
  }
  const list2 = runCli(['list-sync-log', '--json'], env);
  assert.equal(list2.status, 0, list2.stderr);
  const second = JSON.parse(list2.stdout) as { count: number };
  assert.equal(second.count, 3, 're-running the sync must not duplicate ledger rows');
  assert.equal(rawSyncLog(dbPath).length, 3, 'the DB itself must still hold exactly 3 rows');
});

// Extra contract — slug identity on entities mirrors people: the CLI derives
// the slug from the label, and a duplicate slug is a UNIQUE violation
// surfaced as a friendly CLI error (never a raw driver crash).
test('S7: slug derivation and uniqueness on entities', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db') };
  seedBaseline(env);

  const add = runCli(['add-entity', '--label', 'Vibe Coded Dreams!', '--kind', 'concept', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const entity = JSON.parse(add.stdout) as EntityJson;
  assert.equal(entity.slug, 'vibe-coded-dreams', 'slug is derived: lowercase, spaces/punct → dashes');

  // Same label again → same slug → UNIQUE constraint → friendly error.
  const dup = runCli(['add-entity', '--label', 'Vibe Coded Dreams', '--kind', 'concept', '--json'], env);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /entities_slug_unique|already exists/);
  assert.doesNotMatch(dup.stderr, /DrizzleQueryError|SqliteError/, 'driver internals must never leak to the user');

  // An explicit --slug override that collides fails the same way.
  const dupOverride = runCli(
    ['add-entity', '--label', 'Different Label', '--kind', 'concept', '--slug', 'vibe-coded-dreams', '--json'],
    env,
  );
  assert.equal(dupOverride.status, 1);
  assert.match(dupOverride.stderr, /entities_slug_unique|already exists/);
});

// Extra contract — entity_links FK behavior: linking to a nonexistent
// entity is a friendly usage error, never a raw driver crash. (Target
// integrity is a write-path rule: link-entity resolves the target row
// before insert, so the same protection applies to unknown targets.)
test('S7: entity_links FK behavior — unknown entity or target errors cleanly', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db') };
  const base = seedBaseline(env);

  // Unknown entity slug → usage error, not a driver crash.
  const noEntity = runCli(
    ['link-entity', 'no-such-entity', '--target-type', 'task', '--target', String(base.taskId), '--json'],
    env,
  );
  assert.equal(noEntity.status, 1);
  assert.match(noEntity.stderr, /no entity with slug "no-such-entity"/);
  assert.doesNotMatch(noEntity.stderr, /DrizzleQueryError|SqliteError/);

  // Valid entity, unknown target (nonexistent task id) → usage error.
  const add = runCli(['add-entity', '--label', 'Orphan Watch', '--kind', 'concept', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const orphan = JSON.parse(add.stdout) as EntityJson;
  const noTask = runCli(['link-entity', orphan.slug, '--target-type', 'task', '--target', '9999', '--json'], env);
  assert.equal(noTask.status, 1);
  assert.match(noTask.stderr, /no task matching "9999"/);
  assert.doesNotMatch(noTask.stderr, /DrizzleQueryError|SqliteError/);

  // Valid entity, unknown person slug → usage error.
  const noPerson = runCli(
    ['link-entity', orphan.slug, '--target-type', 'person', '--target', 'nobody-here', '--json'],
    env,
  );
  assert.equal(noPerson.status, 1);
  assert.match(noPerson.stderr, /no person matching "nobody-here"/);

  // Unknown target_type → usage error (types are data but the CLI narrows).
  const badType = runCli(['link-entity', orphan.slug, '--target-type', 'car', '--target', '1', '--json'], env);
  assert.equal(badType.status, 1);
  assert.match(badType.stderr, /target-type must be one of/);
});

// Extra contract — files FK behavior: add-file with an unknown person slug
// or task id is a friendly usage error, never a raw driver crash (same
// resolve-before-insert pattern as add-task --person).
test('S7: files FK behavior — unknown person or task errors cleanly', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db') };
  seedBaseline(env);

  const noPerson = runCli(
    ['add-file', '--path', '~/hub/files/x.pdf', '--kind', 'pdf', '--person', 'no-such-person', '--json'],
    env,
  );
  assert.equal(noPerson.status, 1);
  assert.match(noPerson.stderr, /no person with slug "no-such-person"/);
  assert.doesNotMatch(noPerson.stderr, /DrizzleQueryError|SqliteError/);

  const noTask = runCli(['add-file', '--path', '~/hub/files/x.pdf', '--kind', 'pdf', '--task', '9999', '--json'], env);
  assert.equal(noTask.status, 1);
  assert.match(noTask.stderr, /no task with id 9999/);
});

// Extra contract — empty list results are valid, not errors (list-entities
// and list-sync-log on a fresh DB both exit 0 with count 0).
test('S7: empty list results are valid', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db') };
  const init = runCli(['init'], env);
  assert.equal(init.status, 0, init.stderr);

  const entities = runCli(['list-entities', '--json'], env);
  assert.equal(entities.status, 0, entities.stderr);
  const eOut = JSON.parse(entities.stdout) as { verb: string; count: number; entities: unknown[] };
  assert.equal(eOut.verb, 'list-entities');
  assert.equal(eOut.count, 0);
  assert.deepEqual(eOut.entities, []);

  const sync = runCli(['list-sync-log', '--json'], env);
  assert.equal(sync.status, 0, sync.stderr);
  const sOut = JSON.parse(sync.stdout) as { verb: string; count: number; entries: unknown[] };
  assert.equal(sOut.verb, 'list-sync-log');
  assert.equal(sOut.count, 0);
  assert.deepEqual(sOut.entries, []);
});

// Fresh-DB init lands at user_version 7 (001_people + 002_channels +
// 003_tasks + 004_interactions + 005_trackables + 006_entities_files_sync + 007_indexes_views).
test('S7: fresh init lands at user_version 7', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = { HUB_DB: join(tmp, 'life.db') };
  const init = runCli(['init'], env);
  assert.equal(init.status, 0, init.stderr);

  const db = new DatabaseSync(join(tmp, 'life.db'));
  try {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(uv.user_version, 7);
    // All four S7 tables exist.
    for (const table of ['entities', 'entity_links', 'files', 'sync_log']) {
      const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(table) as {
        n: number;
      };
      assert.equal(row.n, 1, `${table} table must exist after init`);
    }
  } finally {
    db.close();
  }
});
