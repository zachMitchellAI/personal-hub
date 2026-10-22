// S3 acceptance tests (stories/epic-schema.md S3) — CLI-level against
// throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map:
//   1. person "casey-smith" + channels kind="discord" and kind="email"
//      → both rows persist with their literal kind values
//   2. kinds "mastodon" and "mastodon-different-thing" both persist — any new string
//      accepted without schema change (open-ended kind, no enum)
//   3. person deleted → no orphaned channel rows remain (CASCADE verified)
//   4. two email channels; set primary on the second → at most one primary
//      per (person, kind), enforced by the CLI write path
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s3-'));
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

interface ChannelRow {
  id: number;
  person_id: number;
  kind: string;
  value: string;
  primary_flag: number;
  source: string | null;
}

// Shared seed: one person "casey-smith" in a throwaway DB.
function seedPerson(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  const add = runCli(['add-person', '--name', 'Casey Smith', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  return env;
}

function rawChannels(dbPath: string): ChannelRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    return db
      .prepare('SELECT id, person_id, kind, value, primary_flag, source FROM contact_channels ORDER BY id')
      .all() as unknown as ChannelRow[];
  } finally {
    db.close();
  }
}

// Scenario 1 — discord + email rows persist with their literal kind values.
test('S3: channels kind="discord" and kind="email" persist with literal kind values', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const discord = runCli(
    ['add-channel', 'casey-smith', '--kind', 'discord', '--value', 'zach-test-0001', '--source', 'manual', '--json'],
    env,
  );
  assert.equal(discord.status, 0, discord.stderr);
  const dOut = JSON.parse(discord.stdout);
  assert.equal(dOut.verb, 'add-channel');
  assert.equal(dOut.kind, 'discord');
  assert.equal(dOut.value, 'zach-test-0001');
  assert.equal(dOut.primary_flag, 0);
  assert.equal(dOut.source, 'manual');
  assert.equal(dOut.slug, 'casey-smith');

  const email = runCli(
    ['add-channel', 'casey-smith', '--kind', 'email', '--value', 'test@example.test', '--json'],
    env,
  );
  assert.equal(email.status, 0, email.stderr);
  const eOut = JSON.parse(email.stdout);
  assert.equal(eOut.kind, 'email');
  assert.equal(eOut.source, null); // optional column defaults to NULL

  // Both persist — through the CLI listing and a raw reopen.
  const list = runCli(['list-channels', 'casey-smith', '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const lOut = JSON.parse(list.stdout);
  assert.equal(lOut.verb, 'list-channels');
  assert.equal(lOut.count, 2);
  assert.deepEqual(
    lOut.channels.map((c: ChannelRow) => c.kind),
    ['discord', 'email'],
  ); // ordered by kind

  const rows = rawChannels(dbPath);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.value]),
    [
      ['discord', 'zach-test-0001'],
      ['email', 'test@example.test'],
    ],
  );
});

// Scenario 2 — kind accepts any new string without schema change.
test('S3: open-ended kinds — "mastodon" and "mastodon-different-thing" both persist with no schema change', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const mastodon = runCli(
    ['add-channel', 'casey-smith', '--kind', 'mastodon', '--value', 'mastodon-handle', '--json'],
    env,
  );
  assert.equal(mastodon.status, 0, mastodon.stderr);
  assert.equal(JSON.parse(mastodon.stdout).kind, 'mastodon');

  // A kind string no schema author ever anticipated must just work.
  const weird = runCli(
    ['add-channel', 'casey-smith', '--kind', 'mastodon-different-thing', '--value', 'other-handle', '--json'],
    env,
  );
  assert.equal(weird.status, 0, weird.stderr);
  assert.equal(JSON.parse(weird.stdout).kind, 'mastodon-different-thing');

  const rows = rawChannels(dbPath);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ['mastodon', 'mastodon-different-thing']);

  // user_version stays at the migrations that exist (6) — no schema change happened.
  const db = new DatabaseSync(dbPath);
  try {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(uv.user_version, 6);
  } finally {
    db.close();
  }
});

// Scenario 3 — person deleted → no orphaned channel rows (CASCADE verified).
test('S3: deleting a person cascades — no orphaned contact_channels rows remain', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  runCli(['add-channel', 'casey-smith', '--kind', 'discord', '--value', 'zach-test-0001'], env);
  runCli(['add-channel', 'casey-smith', '--kind', 'email', '--value', 'test@example.test'], env);
  assert.equal(rawChannels(dbPath).length, 2);

  // There is no remove-person verb in scope, so the delete goes through raw
  // SQL on a separate connection (same pattern as S2's raw checks). The
  // CASCADE behaviour under test is the DB's FK action, not the CLI's.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM people WHERE slug = ?').run('casey-smith');
  } finally {
    db.close();
  }

  const orphans = rawChannels(dbPath);
  assert.equal(orphans.length, 0, 'CASCADE must remove every channel of the deleted person');
});

// Scenario 4 — two email channels; set primary on the second → at most one
// primary per (person, kind), enforced by the CLI write path.
test('S3: set-primary on the second email channel demotes the first — one primary per (person, kind)', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const first = runCli(
    ['add-channel', 'casey-smith', '--kind', 'email', '--value', 'first@example.test', '--json'],
    env,
  );
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(
    ['add-channel', 'casey-smith', '--kind', 'email', '--value', 'second@example.test', '--json'],
    env,
  );
  assert.equal(second.status, 0, second.stderr);
  const firstId = JSON.parse(first.stdout).id as number;
  const secondId = JSON.parse(second.stdout).id as number;

  // "I set primary_flag=1 on the second" — via the CLI write path.
  const setPrimary = runCli(['set-primary', String(secondId), '--json'], env);
  assert.equal(setPrimary.status, 0, setPrimary.stderr);
  const sp = JSON.parse(setPrimary.stdout);
  assert.equal(sp.verb, 'set-primary');
  assert.equal(sp.id, secondId);
  assert.equal(sp.kind, 'email');
  assert.equal(sp.primary_flag, 1);

  // Exactly one primary remains, and it is the second row.
  const rows = rawChannels(dbPath);
  const primaries = rows.filter((r) => r.primary_flag === 1);
  assert.equal(primaries.length, 1);
  assert.equal(primaries[0].id, secondId);
  const firstRow = rows.find((r) => r.id === firstId)!;
  assert.equal(firstRow.primary_flag, 0, 'the first email channel must be demoted');
});

// Extra S3-scope contract: --primary on add-channel enforces the same rule,
// and primary-ness is scoped per (person, kind) — a discord primary is
// untouched when an email primary is set.
test('S3: add-channel --primary demotes the existing primary of the same (person, kind) only', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const email1 = runCli(
    ['add-channel', 'casey-smith', '--kind', 'email', '--value', 'first@example.test', '--primary', '--json'],
    env,
  );
  assert.equal(email1.status, 0, email1.stderr);
  const email1Id = JSON.parse(email1.stdout).id as number;
  assert.equal(JSON.parse(email1.stdout).primary_flag, 1);

  // A different kind gets its own primary — must NOT demote the email one.
  const discord = runCli(
    ['add-channel', 'casey-smith', '--kind', 'discord', '--value', 'zach-test-0001', '--primary', '--json'],
    env,
  );
  assert.equal(discord.status, 0, discord.stderr);
  assert.equal(JSON.parse(discord.stdout).primary_flag, 1);

  // Adding a second primary email demotes the first email only.
  const email2 = runCli(
    ['add-channel', 'casey-smith', '--kind', 'email', '--value', 'second@example.test', '--primary', '--json'],
    env,
  );
  assert.equal(email2.status, 0, email2.stderr);
  const email2Id = JSON.parse(email2.stdout).id as number;

  const rows = rawChannels(dbPath);
  const emailPrimaries = rows.filter((r) => r.kind === 'email' && r.primary_flag === 1);
  assert.equal(emailPrimaries.length, 1);
  assert.equal(emailPrimaries[0].id, email2Id);
  assert.equal(rows.find((r) => r.id === email1Id)!.primary_flag, 0, 'first email demoted');
  assert.equal(rows.find((r) => r.kind === 'discord')!.primary_flag, 1, 'discord primary untouched');
});

// Extra S3-scope contract: deterministic error paths (stable exit codes).
test('S3: error paths exit 1 — unknown slug, missing args, missing channel id', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const unknownPerson = runCli(['add-channel', 'nobody-here', '--kind', 'email', '--value', 'x@example.test'], env);
  assert.equal(unknownPerson.status, 1);
  assert.match(unknownPerson.stderr, /no person with slug "nobody-here"/);

  const unknownList = runCli(['list-channels', 'nobody-here'], env);
  assert.equal(unknownList.status, 1);
  assert.match(unknownList.stderr, /no person with slug "nobody-here"/);

  const missingKind = runCli(['add-channel', 'casey-smith', '--value', 'x@example.test'], env);
  assert.equal(missingKind.status, 1);
  const missingValue = runCli(['add-channel', 'casey-smith', '--kind', 'email'], env);
  assert.equal(missingValue.status, 1);

  const badSetPrimary = runCli(['set-primary', '999'], env);
  assert.equal(badSetPrimary.status, 1);
  assert.match(badSetPrimary.stderr, /no channel with id 999/);

  const badRemove = runCli(['remove-channel', '999'], env);
  assert.equal(badRemove.status, 1);
  assert.match(badRemove.stderr, /no channel with id 999/);

  const notAnId = runCli(['set-primary', 'abc'], env);
  assert.equal(notAnId.status, 1);
});

// Extra S3-scope contract: listing order is deterministic (kind, id) and
// remove-channel deletes exactly one row.
test('S3: list-channels orders by kind then id; remove-channel deletes exactly one row', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  // Insert out of alphabetical order on purpose.
  const c1 = runCli(['add-channel', 'casey-smith', '--kind', 'discord', '--value', 'd-one', '--json'], env);
  const c2 = runCli(['add-channel', 'casey-smith', '--kind', 'email', '--value', 'e-one', '--json'], env);
  const c3 = runCli(['add-channel', 'casey-smith', '--kind', 'discord', '--value', 'd-two', '--json'], env);
  const c4 = runCli(['add-channel', 'casey-smith', '--kind', 'email', '--value', 'e-two', '--json'], env);
  const ids = [c1, c2, c3, c4].map((r) => JSON.parse(r.stdout).id as number);

  const list = runCli(['list-channels', 'casey-smith', '--json'], env);
  assert.equal(list.status, 0, list.stderr);
  const channels = JSON.parse(list.stdout).channels as ChannelRow[];
  assert.deepEqual(
    channels.map((c) => [c.kind, c.value]),
    [
      ['discord', 'd-one'],
      ['discord', 'd-two'],
      ['email', 'e-one'],
      ['email', 'e-two'],
    ],
  );

  // Remove the first discord row; the rest are untouched.
  const removed = runCli(['remove-channel', String(ids[0]), '--json'], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed, true);

  const rows = rawChannels(dbPath);
  assert.deepEqual(
    rows.map((r) => r.value),
    ['e-one', 'd-two', 'e-two'],
  );

  // list-channels reflects the removal.
  const after = JSON.parse(runCli(['list-channels', 'casey-smith', '--json'], env).stdout);
  assert.equal(after.count, 3);
});
