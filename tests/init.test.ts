// S1 acceptance tests (stories/epic-schema.md S1) — CLI-level, against throwaway DBs.
// Contract under test: fresh init (wal/fk/user_version), idempotent re-init,
// full rollback on a bad migration, unknown-verb rejection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s1-'));
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

test('S1: fresh init creates wal db with foreign keys on and user_version 0', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'nested', 'life.db'); // parent does not exist yet
  const emptyMig = join(tmp, 'empty-migrations');
  mkdirSync(emptyMig);

  const r = runCli(['init', '--db', dbPath, '--json'], { HUB_MIGRATIONS: emptyMig });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);

  const out = JSON.parse(r.stdout);
  assert.equal(out.verb, 'init');
  assert.equal(out.journal_mode, 'wal');
  assert.equal(out.foreign_keys, true);
  assert.equal(out.user_version, 0);
  assert.deepEqual(out.migrations_applied, []);
});

test('S1: re-init is idempotent — exit 0, version unchanged, nothing applied', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  // src/migrations holds real migrations since S2; pin an empty dir so this
  // test keeps its original "no migrations exist" semantics.
  const emptyMig = join(tmp, 'empty-migrations');
  mkdirSync(emptyMig);
  const env = { HUB_MIGRATIONS: emptyMig };

  const first = runCli(['init', '--db', dbPath, '--json'], env);
  assert.equal(first.status, 0, first.stderr);

  const second = runCli(['init', '--db', dbPath, '--json'], env);
  assert.equal(second.status, 0, second.stderr);
  const out = JSON.parse(second.stdout);
  assert.equal(out.user_version, 0);
  assert.deepEqual(out.migrations_applied, []);
});

test('S1: bad migration rolls back fully — version unchanged, partial DDL gone, nonzero exit', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const mig = join(tmp, 'migrations');
  mkdirSync(mig);
  // One valid statement followed by an invalid one: the valid part must NOT survive.
  writeFileSync(join(mig, '001_bad.sql'), 'CREATE TABLE keep_me (id INTEGER);\nTHIS IS NOT SQL;\n');

  const r = runCli(['init', '--db', dbPath, '--json'], { HUB_MIGRATIONS: mig });
  assert.notEqual(r.status, 0, 'init must fail on a bad migration');
  assert.match(r.stderr, /001_bad\.sql failed/);

  // Inspect the db directly: version must be unchanged, partial DDL must be gone.
  const db = new DatabaseSync(dbPath);
  try {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(uv.user_version, 0);
    const leftover = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='keep_me'")
      .all();
    assert.equal(leftover.length, 0, 'partial DDL must be rolled back');
  } finally {
    db.close();
  }
});

test('S1: unknown verb exits nonzero and names the verb', (t) => {
  const r = runCli(['frobnicate']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown verb "frobnicate"/);
});

test('S1: good migration applies, bumps user_version, survives re-open', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const mig = join(tmp, 'migrations');
  mkdirSync(mig);
  writeFileSync(
    join(mig, '001_people.sql'),
    'CREATE TABLE people (id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL);\n',
  );

  const r = runCli(['init', '--db', dbPath, '--json'], { HUB_MIGRATIONS: mig });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.migrations_applied, [1]);
  assert.equal(out.user_version, 1);

  // Re-init with the same migrations: idempotent, no re-application.
  const again = runCli(['init', '--db', dbPath, '--json'], { HUB_MIGRATIONS: mig });
  assert.equal(again.status, 0, again.stderr);
  const out2 = JSON.parse(again.stdout);
  assert.equal(out2.user_version, 1);
  assert.deepEqual(out2.migrations_applied, []);

  // The table survives a fresh connection (prove persistence, not just in-memory state).
  const db = new DatabaseSync(dbPath);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='people'")
      .all();
    assert.equal(tables.length, 1);
  } finally {
    db.close();
  }
});