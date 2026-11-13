// S6 acceptance tests (stories/epic-schema.md S6) — CLI-level against
// throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map:
//   1. trackable "Acme panel" kind "job-application" party "Acme Corp"
//      stage "panel-interview" + trackable_event "thank-you note sent"
//      → event trail queryable in order for that trackable
//   2. custom stage "team-fit-round-2" persists — stages are data
//   3. closed → status reflects closure but events remain intact
//   4. kind "order" with no party → persists (party is nullable)
// Extra contracts: CLI status validation (DB CHECK backstop), --date
// validation on events, unknown trackable/event errors, user_version 7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixtureTrackable, makeTmp, runHub, trackableArgs } from './helpers.ts';

interface TrackableJson {
  id: number;
  label: string;
  kind: string;
  party: string | null;
  stage: string;
  status: string;
  created_at: string;
}

interface TrackableEventJson {
  id: number;
  trackable_id: number;
  event_date: string;
  event_type: string;
  notes: string | null;
}

function rawTrackables(dbPath: string): TrackableJson[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM trackables ORDER BY id').all() as unknown as TrackableJson[];
  } finally {
    db.close();
  }
}

// Fixture constant for adds that don't pin scenario values. Scenarios 1, 2,
// and 4 keep their literals: the lifecycle test asserts kind/label/party/
// stage the factory does not emit, and the filter test needs three DISTINCT
// kinds so --kind can tell the rows apart (the factory emits a single kind).
const TRACK_DEFAULTS = fixtureTrackable(0); // 'Fixture trackable 1', kind 'application'

// Scenario 1 — full trail lifecycle: add a trackable with a custom stage,
// append an event, close it, then verify the trail persists and reads in order.
test('S6: trail lifecycle — add, event, close, trail intact', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runHub(
    [
      'add-trackable',
      '--label',
      'Acme panel',
      '--kind',
      'job-application',
      '--party',
      'Acme Corp',
      '--stage',
      'panel-interview',
      '--json',
    ],
    env,
  );
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout) as TrackableJson;
  assert.equal(added.label, 'Acme panel');
  assert.equal(added.kind, 'job-application');
  assert.equal(added.party, 'Acme Corp');
  assert.equal(added.stage, 'panel-interview');
  assert.equal(added.status, 'active');
  assert.match(added.created_at, /^\d{4}-\d{2}-\d{2}T/);

  const event = runHub(['add-trackable-event', String(added.id), '--type', 'thank-you note sent', '--json'], env);
  assert.equal(event.status, 0, event.stderr);
  const evt = JSON.parse(event.stdout) as TrackableEventJson;
  assert.equal(evt.trackable_id, added.id);
  assert.equal(evt.event_type, 'thank-you note sent');
  assert.match(evt.event_date, /^\d{4}-\d{2}-\d{2}$/, 'event_date defaults to today as ISO');

  // Closing must not touch the event trail.
  const close = runHub(['set-trackable-status', String(added.id), '--status', 'closed'], env);
  assert.equal(close.status, 0, close.stderr);

  const trail = runHub(['list-trackable-events', String(added.id), '--json'], env);
  assert.equal(trail.status, 0, trail.stderr);
  const trailList = JSON.parse(trail.stdout);
  assert.equal(trailList.verb, 'list-trackable-events');
  assert.equal(trailList.trackable_id, added.id);
  assert.equal(trailList.count, 1);
  assert.equal(trailList.events[0].event_type, 'thank-you note sent');

  // Status reflects closure.
  const list = JSON.parse(runHub(['list-trackables', '--json'], env).stdout) as { trackables: TrackableJson[] };
  const closed = list.trackables.find((x) => x.id === added.id);
  assert.ok(closed);
  assert.equal(closed.status, 'closed');
});

// Scenario 2 — custom stage persists (stages are data, not schema).
test('S6: custom stage persists — stages are data, not schema', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runHub(
    ['add-trackable', '--label', 'Weird process', '--kind', 'job-application', '--stage', 'team-fit-round-2', '--json'],
    env,
  );
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout) as TrackableJson;
  assert.equal(added.stage, 'team-fit-round-2');

  const row = rawTrackables(dbPath).find((x) => x.id === added.id);
  assert.equal(row?.stage, 'team-fit-round-2');
});

// Scenario 3 — default stage and status, and nullable party (no --party flag).
test('S6: defaults — stage "started", status "active", party null', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runHub([...trackableArgs(TRACK_DEFAULTS), '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const added = JSON.parse(add.stdout) as TrackableJson;
  assert.equal(added.stage, 'started');
  assert.equal(added.status, 'active');
  assert.equal(added.party, null);
});

// Scenario 4 — list-trackables filters (kind, status, party) combine.
test('S6: list-trackables filters — kind, status, party', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  // Three DISTINCT kinds — --kind must separate the rows and the factory
  // emits only one kind, so these stay literal (labels are asserted too).
  runHub(
    ['add-trackable', '--label', 'Acme panel', '--kind', 'job-application', '--party', 'Acme Corp', '--json'],
    env,
  );
  runHub(['add-trackable', '--label', 'Gym signup', '--kind', 'signup', '--json'], env);
  runHub(['add-trackable', '--label', 'New laptop', '--kind', 'order', '--party', 'TechMart', '--json'], env);

  // --kind job-application
  const jobs = JSON.parse(runHub(['list-trackables', '--kind', 'job-application', '--json'], env).stdout);
  assert.equal(jobs.count, 1);
  assert.equal(jobs.trackables[0].label, 'Acme panel');

  // --status active (all three still active)
  const active = JSON.parse(runHub(['list-trackables', '--status', 'active', '--json'], env).stdout);
  assert.equal(active.count, 3);

  // close one, then filter by closed
  runHub(['set-trackable-status', '1', '--status', 'closed'], env);
  const closed = JSON.parse(runHub(['list-trackables', '--status', 'closed', '--json'], env).stdout);
  assert.equal(closed.count, 1);
  assert.equal(closed.trackables[0].label, 'Acme panel');

  // --party TechMart
  const party = JSON.parse(runHub(['list-trackables', '--party', 'TechMart', '--json'], env).stdout);
  assert.equal(party.count, 1);
  assert.equal(party.trackables[0].label, 'New laptop');

  // combined filters: kind + status
  const combo = JSON.parse(
    runHub(['list-trackables', '--kind', 'job-application', '--status', 'closed', '--json'], env).stdout,
  );
  assert.equal(combo.count, 1);
  assert.equal(combo.trackables[0].label, 'Acme panel');
});

// Scenario 5 — error paths: bad status, missing flags, unknown ids, bad dates.
test('S6: error paths exit 1 with usage messages', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  // Missing required flags.
  const missing = runHub(['add-trackable', '--label', 'x'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /usage: hub add-trackable/);

  // Bad status on add.
  const badAddStatus = runHub(['add-trackable', '--label', 'x', '--kind', 'y', '--status', 'done'], env);
  assert.equal(badAddStatus.status, 1);
  assert.match(badAddStatus.stderr, /--status must be one of: active, closed/);

  // Bad status on set.
  const badSetStatus = runHub(['set-trackable-status', '1', '--status', 'done'], env);
  assert.equal(badSetStatus.status, 1);
  assert.match(badSetStatus.stderr, /must be one of: active, closed/);

  // Unknown trackable id.
  const unknown = runHub(['set-trackable-status', '999', '--status', 'closed'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no trackable with id 999/);

  // Missing id on set/add-event/list-events.
  for (const [verb, expected] of [
    ['set-trackable-status', /trackable id argument required/],
    ['add-trackable-event', /trackable id argument required/],
    ['list-trackable-events', /trackable id argument required/],
  ] as const) {
    const r = runHub([verb, '--json'], env);
    assert.equal(r.status, 1, `${verb} without id must fail`);
    assert.match(r.stderr, expected);
  }

  // add-trackable-event without --type.
  const addT = runHub(['add-trackable', '--label', 'T', '--kind', 'k', '--json'], env);
  assert.equal(addT.status, 0, addT.stderr);
  const noType = runHub(['add-trackable-event', '1'], env);
  assert.equal(noType.status, 1);
  assert.match(noType.stderr, /--type is required/);

  // Bad --date on add-trackable-event.
  const badDate = runHub(['add-trackable-event', '1', '--type', 'x', '--date', 'next friday'], env);
  assert.equal(badDate.status, 1);
  assert.match(badDate.stderr, /must be an ISO date/);

  // Bad list-trackables filter status.
  const badFilter = runHub(['list-trackables', '--status', 'done'], env);
  assert.equal(badFilter.status, 1);
  assert.match(badFilter.stderr, /must be one of: active, closed/);
});

// Extra contract — deleting a trackable cascades its events (events are parts
// of the trackable, unlike interactions/tasks which survive their person).
test('S6: trackable delete cascades its events', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const add = runHub([...trackableArgs(TRACK_DEFAULTS), '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  runHub(['add-trackable-event', '1', '--type', 'e1'], env);
  runHub(['add-trackable-event', '1', '--type', 'e2'], env);

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM trackables WHERE id = ?').run(1);
    const events = db.prepare('SELECT COUNT(*) AS n FROM trackable_events').get() as { n: number };
    assert.equal(events.n, 0, 'events must cascade with their trackable');
  } finally {
    db.close();
  }
});

// Extra contract — the DB CHECK backstops the CLI-side status validation, and
// fresh-DB init lands at user_version 7 (…+ 007_indexes_views).
test('S6: DB CHECK rejects bad status; user_version lands at 7', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  // Init the DB via any verb so migrations run.
  const add = runHub([...trackableArgs(TRACK_DEFAULTS), '--json'], env);
  assert.equal(add.status, 0, add.stderr);

  const db = new DatabaseSync(dbPath);
  try {
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.ok(uv.user_version >= 7, 'fresh init with real migrations must land at user_version >= 7');
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO trackables (label, kind, stage, status, created_at) VALUES ('x', 'k', 'started', 'done', '2026-01-01')",
          )
          .run(),
      /trackables_status_check|CHECK constraint failed/,
      'DB CHECK must reject a status outside active/closed',
    );
  } finally {
    db.close();
  }
});
