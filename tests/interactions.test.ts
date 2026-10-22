// S5 acceptance tests (stories/epic-schema.md S5) — CLI-level against
// throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map:
//   1. interaction kind "interview" dated 2026-10-20 logged against person
//      "casey-smith" via the CLI → the row persists and appears in that
//      person's history query
//   2. interaction with no person_id → it persists (people-less are valid)
//   3. query for all interactions in the last 7 days → results ordered by
//      date descending (ties broken by id descending)
// Extra contracts: ISO-date validation, unknown-slug error, --days/--since
// windows, SET NULL on person delete, user_version lands at 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s5-'));
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

interface InteractionRow {
  id: number;
  person_id: number | null;
  kind: string;
  date: string;
  channel: string;
  summary: string;
  created_at: string;
}

function rawInteractions(dbPath: string): InteractionRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM interactions ORDER BY id').all() as unknown as InteractionRow[];
  } finally {
    db.close();
  }
}

function rawPeople(dbPath: string): { id: number }[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT id FROM people').all() as unknown as { id: number }[];
  } finally {
    db.close();
  }
}

// Shared seed: one person "casey-smith" in a throwaway DB.
function seedPerson(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  const add = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  return env;
}

// Scenario 1 — log an interaction against a person; it persists and appears
// in that person's history query.
test('S5: interaction logged against person persists and shows in their history', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const add = runCli(
    [
      'add-interaction',
      '--kind',
      'interview',
      '--date',
      '2026-10-20',
      '--channel',
      'phone',
      '--summary',
      'Panel interview with Acme',
      '--person',
      'casey-smith',
      '--json',
    ],
    env,
  );
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout);
  assert.equal(added.verb, 'add-interaction');
  assert.equal(added.kind, 'interview');
  assert.equal(added.date, '2026-10-20');
  assert.equal(added.channel, 'phone');
  assert.equal(added.summary, 'Panel interview with Acme');
  assert.match(added.created_at, /^\d{4}-\d{2}-\d{2}T/);
  const personId = rawPeople(dbPath)[0]?.id ?? null;
  assert.equal(added.person_id, personId, 'person slug resolves to the person id');

  // The row is physically in the DB.
  const rows = rawInteractions(dbPath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'interview');

  // The person's history query returns it.
  const history = runCli(['list-interactions', '--person', 'casey-smith', '--json'], env);
  assert.equal(history.status, 0, history.stderr);
  const listed = JSON.parse(history.stdout);
  assert.equal(listed.verb, 'list-interactions');
  assert.equal(listed.count, 1);
  assert.equal(listed.interactions[0].id, added.id);
  assert.equal(listed.interactions[0].summary, 'Panel interview with Acme');
});

// Scenario 2 — people-less interactions are valid.
test('S5: interaction with no person_id persists', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const add = runCli(
    [
      'add-interaction',
      '--kind',
      'meeting',
      '--date',
      '2026-10-19',
      '--channel',
      'in-person',
      '--summary',
      'Coffee chat re: side project',
      '--json',
    ],
    env,
  );
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout);
  assert.equal(added.person_id, null, 'omitting --person leaves person_id null');

  // It shows in the unfiltered list with person_id null.
  const all = runCli(['list-interactions', '--json'], env);
  assert.equal(all.status, 0, all.stderr);
  const listed = JSON.parse(all.stdout);
  assert.equal(listed.count, 1);
  assert.equal(listed.interactions[0].person_id, null);
});

// Scenario 3 — last-7-days query ordered by date descending.
test('S5: --days window filters old rows; results ordered by date descending', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  // Anchor dates relative to today so the test never rots: 0, 3, 10 days ago.
  const dayOffset = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const d0 = dayOffset(0);
  const d3 = dayOffset(3);
  const d10 = dayOffset(10);

  // Insert out of date order on purpose — ordering must come from the query.
  const a = runCli(
    ['add-interaction', '--kind', 'call', '--date', d3, '--channel', 'discord', '--summary', 'Discord call', '--json'],
    env,
  );
  assert.equal(a.status, 0, a.stderr);
  const b = runCli(
    [
      'add-interaction',
      '--kind',
      'meeting',
      '--date',
      d0,
      '--channel',
      'in-person',
      '--summary',
      'Latest catchup',
      '--json',
    ],
    env,
  );
  assert.equal(b.status, 0, b.stderr);
  const c = runCli(
    ['add-interaction', '--kind', 'email', '--date', d10, '--channel', 'email', '--summary', 'Old thread', '--json'],
    env,
  );
  assert.equal(c.status, 0, c.stderr);

  const week = runCli(['list-interactions', '--days', '7', '--json'], env);
  assert.equal(week.status, 0, week.stderr);
  const weekList = JSON.parse(week.stdout);
  assert.equal(weekList.verb, 'list-interactions');
  assert.equal(weekList.days, 7);
  // d0 (today) and d3 are within 7 days; d10 is not.
  assert.deepEqual(
    weekList.interactions.map((r: InteractionRow) => [r.date, r.id]),
    [
      [d0, JSON.parse(b.stdout).id],
      [d3, JSON.parse(a.stdout).id],
    ],
    'last-7-days window keeps only recent rows, ordered newest first',
  );

  // The full list is also date descending, ties by id descending.
  const all = runCli(['list-interactions', '--json'], env);
  const allList = JSON.parse(all.stdout);
  assert.deepEqual(
    allList.interactions.map((r: InteractionRow) => r.date),
    [d0, d3, d10],
  );

  // --since window: everything on/after d3.
  const sinceList = JSON.parse(runCli(['list-interactions', '--since', d3, '--json'], env).stdout);
  assert.equal(sinceList.since, d3);
  assert.deepEqual(
    sinceList.interactions.map((r: InteractionRow) => r.date),
    [d0, d3],
  );
});

// Extra contract — kind filter and error paths (unknown slug, missing flags,
// bad dates, bad --days).
test('S5: --kind filter and error paths exit 1 with usage messages', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  runCli(
    ['add-interaction', '--kind', 'interview', '--date', '2026-10-20', '--channel', 'phone', '--summary', 'A'],
    env,
  );
  runCli(['add-interaction', '--kind', 'email', '--date', '2026-10-21', '--channel', 'email', '--summary', 'B'], env);

  const interviews = JSON.parse(runCli(['list-interactions', '--kind', 'interview', '--json'], env).stdout);
  assert.equal(interviews.count, 1);
  assert.equal(interviews.interactions[0].kind, 'interview');

  // Unknown person slug → clean usage error.
  const unknown = runCli(['list-interactions', '--person', 'nobody-here'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no person with slug "nobody-here"/);
  const unknownAdd = runCli(
    [
      'add-interaction',
      '--kind',
      'call',
      '--date',
      '2026-10-20',
      '--channel',
      'phone',
      '--summary',
      'x',
      '--person',
      'nobody-here',
    ],
    env,
  );
  assert.equal(unknownAdd.status, 1);
  assert.match(unknownAdd.stderr, /no person with slug "nobody-here"/);

  // Missing required flags → usage error.
  const missing = runCli(['add-interaction', '--kind', 'call'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /usage: hub add-interaction/);

  // Fuzzy date → rejected (deterministic dates only).
  const fuzzy = runCli(
    ['add-interaction', '--kind', 'call', '--date', 'next friday', '--channel', 'phone', '--summary', 'x'],
    env,
  );
  assert.equal(fuzzy.status, 1);
  assert.match(fuzzy.stderr, /must be an ISO date/);

  // Impossible calendar date → rejected.
  const impossible = runCli(
    ['add-interaction', '--kind', 'call', '--date', '2026-02-30', '--channel', 'phone', '--summary', 'x'],
    env,
  );
  assert.equal(impossible.status, 1);

  // Bad --days → rejected.
  const badDays = runCli(['list-interactions', '--days', 'abc'], env);
  assert.equal(badDays.status, 1);
  assert.match(badDays.stderr, /must be a positive integer/);
  const zeroDays = runCli(['list-interactions', '--days', '0'], env);
  assert.equal(zeroDays.status, 1);
  // Bad --since → rejected.
  const badSince = runCli(['list-interactions', '--since', 'tomorrow'], env);
  assert.equal(badSince.status, 1);
});

// Extra contract — deleting a person SET NULLs the interaction's person link
// (history outlives the person; same reasoning as tasks).
test('S5: person delete SET NULLs interaction.person_id', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const add = runCli(
    [
      'add-interaction',
      '--kind',
      'interview',
      '--date',
      '2026-10-20',
      '--channel',
      'phone',
      '--summary',
      'Panel',
      '--person',
      'casey-smith',
      '--json',
    ],
    env,
  );
  assert.equal(add.status, 0, add.stderr);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM people WHERE slug = ?').run('casey-smith');
  } finally {
    db.close();
  }
  const rows = rawInteractions(dbPath);
  assert.equal(rows.length, 1, 'interaction must survive its person');
  assert.equal(rows[0].person_id, null, 'person delete must SET NULL, not delete history');
});

// Extra contract — fresh-DB init lands at user_version 6 (001 people +
// 002 channels + 003 tasks + 004 interactions).
test('S5: fresh init lands at user_version 6', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);
  assert.equal(env.HUB_DB, dbPath);

  const db = new DatabaseSync(dbPath);
  try {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(uv.user_version, 6);
  } finally {
    db.close();
  }
});
