// S2 acceptance tests (stories/epic-schema.md S2) — CLI-level against
// throwaway DBs, plus a direct adapter test (drizzle over node:sqlite).
// Scenario map:
//   1. empty table + insert slug "casey-smith" → row persists, id stable
//   2. duplicate slug insert → UNIQUE constraint failure
//   3. person with no relationship_type → NULL
//   4. slug derivation "Casey Smith" → "casey-smith"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s2-'));
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

// Scenario 1 — row persists and its id is stable.
test('S2: person with slug casey-smith persists with a stable id', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const out = JSON.parse(add.stdout);
  assert.equal(out.verb, 'add-person');
  assert.equal(out.slug, 'casey-smith');
  assert.equal(out.id, 1);

  // id is stable across a second CLI process and a raw reopen.
  const get = runCli(['get-person', 'casey-smith', '--json'], env);
  assert.equal(get.status, 0, get.stderr);
  const got = JSON.parse(get.stdout);
  assert.equal(got.id, out.id);
  assert.equal(got.display_name, 'Casey Smith');

  // A second person gets a different id; the first id does not shift.
  const add2 = runCli(['add-person', '--name', 'Ada Lovelace', '--json'], env);
  assert.equal(add2.status, 0, add2.stderr);
  assert.equal(JSON.parse(add2.stdout).id, 2);
  const gotAgain = JSON.parse(runCli(['get-person', 'casey-smith', '--json'], env).stdout);
  assert.equal(gotAgain.id, out.id);

  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT id, slug FROM people WHERE slug = ?').get('casey-smith') as
      | { id: number; slug: string }
      | undefined;
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

  const first = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(first.status, 0, first.stderr);

  const second = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists/);

  // The constraint is the DB's UNIQUE index, not just a CLI guard: a direct
  // insert of the duplicate slug must raise the UNIQUE constraint error too.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => db.prepare('INSERT INTO people (slug, display_name, created_at) VALUES (?, ?, ?)').run('casey-smith', 'Casey Smith', '2026-01-01'),
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

  const add = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(add.status, 0, add.stderr);

  const got = JSON.parse(runCli(['get-person', 'casey-smith', '--json'], env).stdout);
  assert.equal(got.relationship_type, null);
  assert.notEqual(got.relationship_type, '');
  assert.notEqual(got.relationship_type, 'unknown');

  // Raw check: the column is genuinely NULL in storage.
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT relationship_type FROM people WHERE slug = ?').get('casey-smith') as
      | { relationship_type: string | null };
    assert.equal(row.relationship_type, null);
  } finally {
    db.close();
  }

  // And when provided, it stores the literal free-text value (no enum).
  const add2 = runCli(
    ['add-person', '--name', 'Ada Lovelace', '--relationship-type', 'professional', '--json'],
    env,
  );
  assert.equal(add2.status, 0, add2.stderr);
  const got2 = JSON.parse(runCli(['get-person', 'ada-lovelace', '--json'], env).stdout);
  assert.equal(got2.relationship_type, 'professional');
});

// Scenario 4 — slug derivation: lowercase, spaces→dashes, no stray punctuation.
test('S2: slug derived from display_name is lowercase-dashed with no stray punctuation', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const cases: Array<[string, string]> = [
    ['Casey Smith', 'casey-smith'],
    ["Mary-Jane O'Neil", 'mary-jane-oneil'],
    ['Renée Dubois', 'renee-dubois'],
    ['  Spaced   Out  Name ', 'spaced-out-name'],
  ];
  for (const [name, expected] of cases) {
    const add = runCli(['add-person', '--name', name, '--json'], env);
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

  runCli(['add-person', '--name', 'Casey Smith'], env);
  runCli(['add-person', '--name', 'Ada Lovelace'], env);
  const list = runCli(['list-people', '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const out = JSON.parse(list.stdout);
  assert.equal(out.verb, 'list-people');
  assert.equal(out.count, 2);
  assert.deepEqual(out.people.map((p: { slug: string }) => p.slug), ['ada-lovelace', 'casey-smith']);
});
