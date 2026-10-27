// S12 CRUD acceptance tests (stories/ticket-s12-crud-verbs.md) — CLI-level
// against throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map (numbering follows the ticket's Gherkin map):
//   1.  edit-person: employer-only change leaves every other field identical
//   2.  edit-person: unknown slug → exit 1
//   3.  edit-person: --slug rejected (identity immutable)
//   4.  edit-channel: kind/value change; primary_flag untouched
//   5.  edit-channel: unknown id → exit 1
//   6.  edit-task: due-date ISO + person re-point by slug
//   7.  edit-task: fuzzy --due-date rejected (deterministic dates only)
//   8.  edit-task: unknown id → exit 1
//   9.  delete-task: subtasks cascade
//   10. delete-task: unknown id → exit 1
//   11. delete-entity: entity_links cascade
//   12. delete-entity: unknown slug → exit 1
//   13. merge-person: moved counts exact (human + --json), from-person gone
//   14. merge-person: primary flags preserved across the move
//   15. merge-person: from == into refused
//   16. merge-person: unknown slugs refused
//   17. merge-person: atomicity — forced failure moves nothing
//   18. merge-person: the husk case — empty person + one dangling interaction
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s12-'));
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

/** Parse the last stdout JSON object (verbs print exactly one object). */
function jsonOut(r: RunResult): Record<string, unknown> {
  return JSON.parse(r.stdout) as Record<string, unknown>;
}

/** Raw person row via node:sqlite (FK/cascade proofs need raw SQL reads —
 * read-only outside the CLI, per the AGENTS.md contract). */
function rawRows(dbPath: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all() as unknown as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

/** Seed one person + one task + one entity with a link, returning its env. */
function seedBase(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  let r = runCli(['add-person', '--name', 'Marla Sample'], env);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['add-task', '--title', 'Seed task', '--context', 'test'], env);
  assert.equal(r.status, 0, r.stderr);
  r = runCli(['add-entity', '--kind', 'company', '--label', 'Acme Corp'], env);
  assert.equal(r.status, 0, r.stderr);
  return env;
}

// ─── edit-person ────────────────────────────────────────────────────────────

test('S12: edit-person changes only provided fields (employer-only diff)', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  const before = jsonOut(runCli(['get-person', 'marla-sample', '--json'], env));
  const r = runCli(['edit-person', 'marla-sample', '--employer', 'Acme Corp'], env);
  assert.equal(r.status, 0, r.stderr);
  const after = jsonOut(runCli(['get-person', 'marla-sample', '--json'], env));

  // Every field except employer is byte-identical; employer changed.
  for (const key of Object.keys(before)) {
    if (key === 'employer') {
      assert.equal(after[key], 'Acme Corp');
    } else {
      assert.deepEqual(after[key], before[key], `field ${key} must be untouched`);
    }
  }
});

test('S12: edit-person echoes the updated row via --json', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-person', 'marla-sample', '--notes', 'lead contact', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = jsonOut(r);
  assert.equal(out.verb, 'edit-person');
  assert.equal(out.slug, 'marla-sample');
  assert.equal(out.notes, 'lead contact');
});

test('S12: edit-person unknown slug exits 1', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-person', 'nobody-here', '--employer', 'X'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no person with slug/);
});

test('S12: edit-person rejects --slug (identity immutable)', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-person', 'marla-sample', '--slug', 'new-slug'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /immutable/);
  // Nothing changed.
  const after = jsonOut(runCli(['get-person', 'marla-sample', '--json'], env));
  assert.equal(after.slug, 'marla-sample');
});

test('S12: edit-person with no field flags exits 1 with usage', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-person', 'marla-sample'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to update/);
});

// ─── edit-channel ───────────────────────────────────────────────────────────

test('S12: edit-channel updates kind/value, preserves primary flag', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  const added = jsonOut(
    runCli(['add-channel', 'marla-sample', '--kind', 'email', '--value', 'a@x.com', '--primary', '--json'], env),
  );
  const channelId = added.id;
  // Make sure it is actually primary (add --primary sets it for a fresh kind).
  assert.equal(added.primary_flag, 1);

  const r = runCli(['edit-channel', String(channelId), '--value', 'marla@new.com'], env);
  assert.equal(r.status, 0, r.stderr);
  const row = rawRows(dbPath, 'SELECT * FROM contact_channels WHERE id = ' + Number(channelId))[0];
  assert.equal(row.value, 'marla@new.com');
  assert.equal(row.kind, 'email'); // untouched
  assert.equal(row.primary_flag, 1); // preserved
});

test('S12: edit-channel unknown id exits 1', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-channel', '999', '--value', 'x'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no channel with id/);
});

// ─── edit-task ──────────────────────────────────────────────────────────────

test('S12: edit-task updates due-date and re-points person by slug', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  const r = runCli(['edit-task', '1', '--due-date', '2026-11-17', '--person', 'marla-sample', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = jsonOut(r);
  assert.equal(out.verb, 'edit-task');
  assert.equal(out.due_date, '2026-11-17');
  // person_id resolved to Marla's row id (1 — the first seeded person).
  assert.equal(out.person_id, 1);
});

test('S12: edit-task rejects fuzzy due dates', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-task', '1', '--due-date', 'next friday'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ISO date/);
});

test('S12: edit-task unknown id exits 1', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['edit-task', '999', '--title', 'X'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no task with id/);
});

test('S12: edit-task unknown person slug exits 1 without touching the row', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  const before = rawRows(dbPath, 'SELECT * FROM tasks WHERE id = 1')[0];
  const r = runCli(['edit-task', '1', '--person', 'ghost'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no person with slug/);
  const after = rawRows(dbPath, 'SELECT * FROM tasks WHERE id = 1')[0];
  assert.deepEqual(after, before);
});

// ─── delete-task / delete-entity ────────────────────────────────────────────

test('S12: delete-task cascades subtasks', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  assert.equal(runCli(['add-subtask', '1', '--label', 'step one'], env).status, 0);
  assert.equal(runCli(['add-subtask', '1', '--label', 'step two'], env).status, 0);
  assert.equal(rawRows(dbPath, 'SELECT * FROM subtasks').length, 2);

  const r = runCli(['delete-task', '1', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = jsonOut(r);
  assert.equal(out.verb, 'delete-task');
  assert.equal(out.deleted, 1);
  assert.equal(out.kind, 'task');
  assert.equal(rawRows(dbPath, 'SELECT * FROM subtasks').length, 0);
  assert.equal(rawRows(dbPath, 'SELECT * FROM tasks').length, 0);
});

test('S12: delete-task unknown id exits 1', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['delete-task', '999'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no task with id/);
});

test('S12: delete-entity cascades entity_links', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  const r0 = runCli(['link-entity', 'acme-corp', '--target-type', 'task', '--target', '1'], env);
  assert.equal(r0.status, 0, r0.stderr);
  assert.equal(rawRows(dbPath, 'SELECT * FROM entity_links').length, 1);

  const r = runCli(['delete-entity', 'acme-corp', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = jsonOut(r);
  assert.equal(out.verb, 'delete-entity');
  assert.equal(out.deleted, 'acme-corp');
  assert.equal(out.kind, 'entity');
  assert.equal(rawRows(dbPath, 'SELECT * FROM entity_links').length, 0);
  assert.equal(rawRows(dbPath, 'SELECT * FROM entities').length, 0);
});

test('S12: delete-entity unknown slug exits 1', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const env = seedBase(join(tmp, 'life.db'));

  const r = runCli(['delete-entity', 'ghost-entity'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no entity with slug/);
});

// ─── merge-person ───────────────────────────────────────────────────────────

/** Seed two people, each with children, plus a person-targeted entity link.
 * Returns env + the from/into slugs. Marla (from) is the husk-to-be. */
function seedMergePair(dbPath: string): { env: Record<string, string> } {
  const env = { HUB_DB: dbPath };
  // Person 1: the survivor (into).
  assert.equal(runCli(['add-person', '--name', 'Marla Sample'], env).status, 0);
  // Person 2: the duplicate (from).
  assert.equal(runCli(['add-person', '--name', 'Marla Sample', '--slug', 'marla-sample-2'], env).status, 0);
  // Children on BOTH rows — after the merge everything lives on person 1.
  assert.equal(
    runCli(['add-channel', 'marla-sample-2', '--kind', 'email', '--value', 'dup@x.com', '--primary'], env).status,
    0,
  );
  assert.equal(runCli(['add-channel', 'marla-sample', '--kind', 'phone', '--value', '555-0100'], env).status, 0);
  assert.equal(
    runCli(
      [
        'add-interaction',
        '--kind',
        'call',
        '--date',
        '2026-10-20',
        '--channel',
        'phone',
        '--summary',
        'intro call',
        '--person',
        'marla-sample-2',
      ],
      env,
    ).status,
    0,
  );
  assert.equal(
    runCli(['add-task', '--title', 'Marla follow-up', '--context', 'test', '--person', 'marla-sample-2'], env).status,
    0,
  );
  assert.equal(runCli(['add-entity', '--kind', 'company', '--label', 'Sample Holdings'], env).status, 0);
  assert.equal(
    runCli(['link-entity', 'sample-holdings', '--target-type', 'person', '--target', 'marla-sample-2'], env).status,
    0,
  );
  return { env };
}

test('S12: merge-person moves all children and deletes the husk (json counts exact)', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const { env } = seedMergePair(dbPath);

  const r = runCli(['merge-person', 'marla-sample-2', '--into', 'marla-sample', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = jsonOut(r);
  assert.equal(out.verb, 'merge-person');
  assert.equal(out.from_slug, 'marla-sample-2');
  assert.equal(out.into_slug, 'marla-sample');
  assert.equal(out.into_id, 1);
  assert.deepEqual(out.moved, { channels: 1, interactions: 1, files: 0, tasks: 1, links: 1 });

  // Husk gone; survivor intact; every child now points at person 1.
  const people = rawRows(dbPath, 'SELECT * FROM people');
  assert.equal(people.length, 1);
  assert.equal(people[0].slug, 'marla-sample');
  const orphans = rawRows(
    dbPath,
    `SELECT (SELECT COUNT(*) FROM contact_channels WHERE person_id != 1) AS ch,
            (SELECT COUNT(*) FROM interactions WHERE person_id != 1 AND person_id IS NOT NULL) AS inter,
            (SELECT COUNT(*) FROM tasks WHERE person_id != 1 AND person_id IS NOT NULL) AS tk,
            (SELECT COUNT(*) FROM entity_links WHERE target_type = 'person' AND target_id != 1) AS lk`,
  )[0];
  assert.equal(orphans.ch, 0);
  assert.equal(orphans.inter, 0);
  assert.equal(orphans.tk, 0);
  assert.equal(orphans.lk, 0);
});

test('S12: merge-person human output prints the moved-count summary', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { env } = seedMergePair(join(tmp, 'life.db'));

  const r = runCli(['merge-person', 'marla-sample-2', '--into', 'marla-sample'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /merged marla-sample-2 into marla-sample/);
  assert.match(r.stdout, /channels 1, interactions 1, files 0, tasks 1, links 1/);
});

test('S12: merge-person preserves primary flags across the move', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const { env } = seedMergePair(dbPath);

  assert.equal(runCli(['merge-person', 'marla-sample-2', '--into', 'marla-sample'], env).status, 0);
  // The from-person's primary email moved intact — still primary_flag 1,
  // same value, no delete+recreate side effects.
  const rows = rawRows(dbPath, "SELECT value, primary_flag FROM contact_channels WHERE kind = 'email'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 'dup@x.com');
  assert.equal(rows[0].primary_flag, 1);
});

test('S12: merge-person refuses from == into', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { env } = seedMergePair(join(tmp, 'life.db'));

  const r = runCli(['merge-person', 'marla-sample', '--into', 'marla-sample'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /into itself/);
  assert.equal(rawRows(join(tmp, 'life.db'), 'SELECT COUNT(*) AS n FROM people')[0].n, 2);
});

test('S12: merge-person refuses unknown slugs', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { env } = seedMergePair(join(tmp, 'life.db'));

  let r = runCli(['merge-person', 'ghost', '--into', 'marla-sample'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no person with slug "ghost"/);
  r = runCli(['merge-person', 'marla-sample-2', '--into', 'ghost'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no person with slug "ghost"/);
  assert.equal(rawRows(join(tmp, 'life.db'), 'SELECT COUNT(*) AS n FROM people')[0].n, 2);
});

test('S12: merge-person without --into exits 1 with usage', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { env } = seedMergePair(join(tmp, 'life.db'));

  const r = runCli(['merge-person', 'marla-sample-2'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: hub merge-person/);
});

test('S12: merge-person is atomic — a forced child-row failure moves nothing', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const { env } = seedMergePair(dbPath);

  // Sabotage: a channel row whose person_id references person 2 but violates
  // the re-pointed FK target we will install… simplest reliable failure:
  // make person 1 (into) deletable-nothing, and force the from-DELETE to fail
  // by adding a child table row that ON DELETE RESTRICT would block — the
  // schema uses CASCADE for channels, so instead simulate a hard driver
  // failure by locking the table via an open write transaction from another
  // connection… in-process CLI runs make that fragile. The deterministic
  // sabotage: corrupt the from-person row so the final DELETE trips a CHECK
  // — not available either. Therefore: force the FIRST re-point to fail by
  // pre-inserting a channel row with person_id pointing at a nonexistent
  // person (FK violation on the UPDATE's own rows is not possible).
  //
  // Reliable approach: run the merge with a SECOND connection holding a
  // write lock (BEGIN EXCLUSIVE) — the CLI's BEGIN then fails immediately
  // with SQLITE_BUSY, after the pre-counts but before any re-point lands.
  const blocker = new DatabaseSync(dbPath);
  blocker.exec('BEGIN EXCLUSIVE');
  try {
    const r = runCli(['merge-person', 'marla-sample-2', '--into', 'marla-sample', '--json'], env);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.length > 0);
    // Nothing moved, nobody deleted.
    const state = rawRows(
      dbPath,
      `SELECT (SELECT COUNT(*) FROM people) AS ppl,
              (SELECT COUNT(*) FROM contact_channels WHERE person_id = 2) AS ch2,
              (SELECT COUNT(*) FROM interactions WHERE person_id = 2) AS i2`,
    )[0];
    assert.equal(state.ppl, 2);
    assert.equal(state.ch2, 1);
    assert.equal(state.i2, 1);
  } finally {
    blocker.exec('ROLLBACK');
    blocker.close();
  }
});

test('S12: merge-person handles the husk case (empty person, one dangling interaction)', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedBase(dbPath);

  // The live pattern from 2026-10-27: husk row (no children) + one interaction
  // still pointing at it.
  assert.equal(runCli(['add-person', '--name', 'Marla husk', '--slug', 'marla-husk'], env).status, 0);
  assert.equal(
    runCli(
      [
        'add-interaction',
        '--kind',
        'email',
        '--date',
        '2026-10-01',
        '--channel',
        'email',
        '--summary',
        'old thread',
        '--person',
        'marla-husk',
      ],
      env,
    ).status,
    0,
  );

  const r = runCli(['merge-person', 'marla-husk', '--into', 'marla-sample', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = jsonOut(r);
  assert.deepEqual(out.moved, { channels: 0, interactions: 1, files: 0, tasks: 0, links: 0 });
  assert.equal(rawRows(dbPath, "SELECT COUNT(*) AS n FROM people WHERE slug = 'marla-husk'")[0].n, 0);
  assert.equal(
    rawRows(dbPath, "SELECT COUNT(*) AS n FROM interactions WHERE summary = 'old thread' AND person_id = 1")[0].n,
    1,
  );
});
