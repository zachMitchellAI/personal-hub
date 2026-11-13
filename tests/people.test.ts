// S2 acceptance tests (stories/epic-schema.md S2) — CLI-level against
// throwaway DBs, plus a direct adapter test (drizzle over node:sqlite).
// Scenario map:
//   1. empty table + insert slug "casey-smith" → row persists, id stable
//   2. duplicate slug insert → UNIQUE constraint failure
//   3. person with no relationship_type → NULL
//   4. slug derivation "Casey Smith" → "casey-smith"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixturePerson, makeTmp, personArgs, runHub } from './helpers.ts';

// Factory people: pool[1] = Casey Smith, pool[2] = Ada Lovelace.
const P1 = fixturePerson(1);
const P2 = fixturePerson(2);

// Scenario 1 — row persists and its id is stable.
test('S2: person with slug casey-smith persists with a stable id', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runHub([...personArgs(P1), '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const out = JSON.parse(add.stdout);
  assert.equal(out.verb, 'add-person');
  assert.equal(out.slug, P1.slug);
  assert.equal(out.id, 1);

  // id is stable across a second CLI process and a raw reopen.
  const get = runHub(['get-person', P1.slug, '--json'], env);
  assert.equal(get.status, 0, get.stderr);
  const got = JSON.parse(get.stdout);
  assert.equal(got.id, out.id);
  assert.equal(got.display_name, P1.name);

  // A second person gets a different id; the first id does not shift.
  const add2 = runHub([...personArgs(P2), '--json'], env);
  assert.equal(add2.status, 0, add2.stderr);
  assert.equal(JSON.parse(add2.stdout).id, 2);
  const gotAgain = JSON.parse(runHub(['get-person', P1.slug, '--json'], env).stdout);
  assert.equal(gotAgain.id, out.id);

  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT id, slug FROM people WHERE slug = ?').get(P1.slug) as
      { id: number; slug: string } | undefined;
    assert.ok(row, 'row must persist');
    assert.equal(row.id, out.id);
  } finally {
    db.close();
  }
});

// Scenario 2 — duplicate slug fails with a UNIQUE constraint error.
test('S2: duplicate slug insert fails with a UNIQUE constraint error', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const first = runHub([...personArgs(P1), '--json'], env);
  assert.equal(first.status, 0, first.stderr);

  const second = runHub([...personArgs(P1), '--json'], env);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);

  // The constraint is the DB's UNIQUE index, not just a CLI guard: a direct
  // insert of the duplicate slug must raise the UNIQUE constraint error too.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO people (slug, display_name, created_at) VALUES (?, ?, ?)')
          .run(P1.slug, P1.name, '2026-01-01'),
      (err: Error) => /UNIQUE constraint failed/.test(err.message),
    );
  } finally {
    db.close();
  }
});

// Scenario 3 — missing relationship_type is NULL, not a default string.
test('S2: person without relationship_type stores NULL', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runHub([...personArgs(P1), '--json'], env);
  assert.equal(add.status, 0, add.stderr);

  const got = JSON.parse(runHub(['get-person', P1.slug, '--json'], env).stdout);
  assert.equal(got.relationship_type, null);
  assert.notEqual(got.relationship_type, '');
  assert.notEqual(got.relationship_type, 'unknown');

  // Raw check: the column is genuinely NULL in storage.
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT relationship_type FROM people WHERE slug = ?').get(P1.slug) as {
      relationship_type: string | null;
    };
    assert.equal(row.relationship_type, null);
  } finally {
    db.close();
  }

  // And when provided, it stores the literal free-text value (no enum).
  // Hand-rolled, not personArgs: --relationship-type is the flag under test.
  const add2 = runHub(['add-person', '--name', P2.name, '--relationship-type', 'professional', '--json'], env);
  assert.equal(add2.status, 0, add2.stderr);
  const got2 = JSON.parse(runHub(['get-person', P2.slug, '--json'], env).stdout);
  assert.equal(got2.relationship_type, 'professional');
});

// Scenario 4 — slug derivation: lowercase, spaces→dashes, no stray punctuation.
test('S2: slug derived from display_name is lowercase-dashed with no stray punctuation', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const cases: Array<[string, string]> = [
    [P1.name, P1.slug],
    // The rest are slug edge cases the factory pool doesn't cover — literals on purpose.
    ["Mary-Jane O'Neil", 'mary-jane-oneil'],
    ['Renée Dubois', 'renee-dubois'],
    ['  Spaced   Out  Name ', 'spaced-out-name'],
  ];
  for (const [name, expected] of cases) {
    const add = runHub(['add-person', '--name', name, '--json'], env);
    assert.equal(add.status, 0, `name: ${name} → stderr: ${add.stderr}`);
    assert.equal(JSON.parse(add.stdout).slug, expected, `name: ${name}`);
  }
});

// Extra S2-scope contract: listing works and is ordered by slug.
test('S2: list-people returns rows ordered by slug', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  runHub(personArgs(P1), env);
  runHub(personArgs(P2), env);
  const list = runHub(['list-people', '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const out = JSON.parse(list.stdout);
  assert.equal(out.verb, 'list-people');
  assert.equal(out.count, 2);
  assert.deepEqual(
    out.people.map((p: { slug: string }) => p.slug),
    [P2.slug, P1.slug],
  );
});
