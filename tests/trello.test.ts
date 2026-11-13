// S11 acceptance tests (stories/ticket-s11-trello-adapter.md) — CLI-level
// against throwaway DBs + a STUB trello engine over the real subprocess
// boundary (engine.ts spawns `$TRELLO_STUB`-style scripts the same way it
// spawns the real trello-cli; no network, no credentials; state lives in a
// JSON file the stub reads/writes). Names are fictional fixtures from
// tests/helpers.ts (PII directive: never real hub data). Never touches
// ~/hub/life.db, ~/.hub/config.json, or ~/.trello-cli.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { dueMatchesCalendar } from '../src/commands/trello/sync-trello.ts';
import { makeTmp, runHub, type RunResult } from './helpers.ts';

const STUB_SRC = join(import.meta.dirname, 'stub-trello.mjs');

interface CardRow {
  id: string;
  name: string;
  description: string;
  due: string | null;
  closed: boolean;
  list: string;
  labels: string[];
}

interface MapRow {
  task_id: number;
  card_id: string;
}

interface LogRow {
  entity_id: number;
  action: string;
  detail: string | null;
}

function dbQuery(dbPath: string, sql: string): unknown[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare(sql).all() as unknown[];
  } finally {
    db.close();
  }
}

function stubState(statePath: string): { cards: CardRow[]; nextId: number } {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/**
 * The per-test harness: tmp dir, stub engine on PATH, isolated config file.
 * @param t - The test context (cleanup hooks).
 * @returns Everything a scenario needs, already wired together.
 */
function harness(t: import('node:test').TestContext) {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // Stub engine copied into the tmp dir: a plain #! node script (no shell,
  // no npm) — the same spawn surface the real adapter uses.
  const enginePath = join(tmp, 'trello.mjs');
  writeFileSync(enginePath, readFileSync(STUB_SRC, 'utf8'));
  chmodSync(enginePath, 0o755);
  const statePath = join(tmp, 'stub-state.json');
  const dbPath = join(tmp, 'life.db');
  const configPath = join(tmp, 'config.json');
  const env = {
    HUB_DB: dbPath,
    HUB_JSON_CONFIG: configPath,
    TRELLO_STUB_STATE: statePath,
    PATH: process.env.PATH ?? '',
  };
  const sync = (extra: string[] = []): RunResult => runHub(['sync-trello', '--skip-cache-sync', ...extra], env);
  const trelloConfig = (extra: string[]): RunResult => runHub(['trello-config', ...extra], env);
  const seedBoard = boardListsReadyReadyInprogressDone();
  trelloConfig([
    '--board',
    seedBoard.board,
    '--list-ready',
    seedBoard.ready,
    '--list-in-progress',
    seedBoard['in-progress'],
    '--list-done',
    seedBoard.done,
    '--engine-path',
    enginePath,
  ]);
  const mirroredTask = (title: string): number => {
    const r = runHub(['add-task', '--title', title, '--context', 'test', '--trello-visible', '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    return (JSON.parse(r.stdout) as { id: number }).id;
  };
  return { tmp, env, enginePath, statePath, dbPath, configPath, sync, trelloConfig, mirroredTask, seedBoard };
}

/** Deterministic stub board refs: board B, lists R/I/D (IDs, not names). */
function boardListsReadyReadyInprogressDone(): { board: string; ready: string; 'in-progress': string; done: string } {
  return { board: 'boardB', ready: 'listR', 'in-progress': 'listI', done: 'listD' };
}

// ─── Config: save/merge/load round-trip + trello-config merge semantics ────

test('S11 cfg: save/load round-trip preserves other top-level keys and pretty-prints', () => {
  const tmp = makeTmp();
  try {
    const cfgPath = join(tmp, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ owner: 'keepme', nested: { x: 1 } }, null, 2));
    const mod = 'unused marker'; // placeholder removed below
    void mod;
    // The trello-config verb is the save path under test.
    const env = { HUB_JSON_CONFIG: cfgPath };
    const r = runHub(
      ['trello-config', '--board', 'b1', '--list-ready', 'r1', '--list-in-progress', 'i1', '--list-done', 'd1'],
      env,
    );
    assert.equal(r.status, 0, r.stderr);
    const loaded = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(loaded.owner, 'keepme', 'the pre-existing top-level key must survive the merge');
    assert.equal(loaded.trello.board, 'b1');
    assert.equal(loaded.trello.enginePath, 'trello', 'fresh block defaults enginePath');
    // Pretty (2-space) + trailing newline: humans diff this file.
    const text = readFileSync(cfgPath, 'utf8');
    assert.match(text, /\n  "owner"/);
    assert.ok(text.endsWith('}\n'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('S11 cfg: trello-config merge semantics — partial invocation keeps existing values', () => {
  const tmp = makeTmp();
  try {
    const cfgPath = join(tmp, 'config.json');
    const env = { HUB_JSON_CONFIG: cfgPath };
    // Full write first.
    let r = runHub(
      [
        'trello-config',
        '--board',
        'bFull',
        '--list-ready',
        'rFull',
        '--list-in-progress',
        'iFull',
        '--list-done',
        'dFull',
        '--engine-path',
        '/engine/a',
      ],
      env,
    );
    assert.equal(r.status, 0, r.stderr);
    // Then a PARTIAL invocation that only touches --board: everything else must survive.
    r = runHub(['trello-config', '--board', 'bNew', '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.verb, 'trello-config');
    assert.equal(out.trello.board, 'bNew');
    assert.equal(out.trello.lists.ready, 'rFull', 'partial invocation must NOT delete the ready list');
    assert.equal(out.trello.lists['in-progress'], 'iFull');
    assert.equal(out.trello.lists.done, 'dFull');
    assert.equal(out.trello.enginePath, '/engine/a');
    // Round-trip through disk to prove it persisted.
    const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
    assert.equal(onDisk.trello.lists.done, 'dFull');
    // No flags at all is a usage error (never a destructive rewrite).
    r = runHub(['trello-config'], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Sync: fresh create / idempotence / drift / adopt / conflict / errors ───

function seedBoardAndTasks(t: import('node:test').TestContext): ReturnType<typeof harness> {
  const h = harness(t);
  const init = runHub(['init'], h.env);
  assert.equal(init.status, 0, init.stderr);
  return h;
}

test('S11 sync: config missing → exit 1 with the trello-config hint', () => {
  const tmp = makeTmp();
  try {
    const env = { HUB_DB: join(tmp, 'life.db'), HUB_JSON_CONFIG: join(tmp, 'absent.json') };
    runHub(['init'], env);
    const r = runHub(['sync-trello', '--skip-cache-sync'], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /trello-config/);
    assert.match(r.stderr, /--board/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('S11 sync: config incomplete → exit 1 naming the missing flags', () => {
  const tmp = makeTmp();
  try {
    const env = { HUB_DB: join(tmp, 'life.db'), HUB_JSON_CONFIG: join(tmp, 'c.json') };
    runHub(['init'], env);
    const partial = runHub(['trello-config', '--board', 'bOnly'], env);
    assert.equal(partial.status, 0, partial.stderr);
    const r = runHub(['sync-trello', '--skip-cache-sync'], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing: --list-ready --list-in-progress --list-done/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('S11 sync: engine ENOENT → friendly install-trello-cli error', () => {
  const tmp = makeTmp();
  try {
    const env = { HUB_DB: join(tmp, 'life.db'), HUB_JSON_CONFIG: join(tmp, 'c.json') };
    runHub(['init'], env);
    // Config points at a binary name that does not exist on PATH.
    runHub(
      [
        'trello-config',
        '--board',
        'b',
        '--list-ready',
        'r',
        '--list-in-progress',
        'i',
        '--list-done',
        'd',
        '--engine-path',
        'trello-missing-for-tests',
      ],
      env,
    );
    const r = runHub(['sync-trello', '--skip-cache-sync'], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /install trello-cli/);
    assert.match(r.stderr, /trello-config/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('S11 sync: dry-run plans creates, touches nothing (cards, mapping, ledger)', (t) => {
  const h = seedBoardAndTasks(t);
  const idA = h.mirroredTask('Dry probe alpha');
  const idB = h.mirroredTask('Dry probe beta').valueOf();
  const r = h.sync();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`task ${idA}: create \\[hub-${idA}\\] Dry probe alpha → ready`));
  assert.match(r.stdout, new RegExp(`task ${idB}: create`));
  assert.match(r.stdout, /dry-run/);
  // Nothing applied: no file, no mapping rows, no ledger rows.
  assert.throws(() => stubState(h.statePath), 'dry-run must not even create the stub state file');
  assert.deepEqual(JSON.parse(JSON.stringify(dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM task_trello'))), [{ c: 0 }]);
  assert.deepEqual(JSON.parse(JSON.stringify(dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM sync_log'))), [{ c: 0 }]);
});

test('S11 sync: fresh --apply creates cards + mapping rows + ledger rows', (t) => {
  const h = seedBoardAndTasks(t);
  h.mirroredTask('Apply probe one');
  h.mirroredTask('Apply probe two');
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  const cards = stubState(h.statePath).cards;
  assert.equal(cards.length, 2);
  for (const c of cards) {
    assert.match(c.name, /^\[hub-\d+\] /);
    assert.equal(c.list, 'listR', 'fresh ready tasks land on the ready list');
  }
  const maps = dbQuery(h.dbPath, 'SELECT task_id, card_id FROM task_trello ORDER BY task_id') as unknown as MapRow[];
  assert.equal(maps.length, 2);
  const logs = dbQuery(h.dbPath, 'SELECT entity_id, action, detail FROM sync_log ORDER BY id') as unknown as LogRow[];
  assert.equal(logs.length, 2);
  for (const log of logs) {
    assert.equal(log.action, 'create');
    const detail = JSON.parse(log.detail ?? '{}');
    assert.equal(detail.list, 'ready');
  }
});

test('S11 sync: idempotent re-run — zero actions, zero ledger rows, exit 0', (t) => {
  const h = seedBoardAndTasks(t);
  h.mirroredTask('Idem probe');
  assert.equal(h.sync(['--apply']).status, 0);
  const logsBefore = (dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM sync_log') as { c: number }[])[0].c;
  const mapsBefore = (dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM task_trello') as { c: number }[])[0].c;
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /in sync/);
  assert.equal((dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM sync_log') as { c: number }[])[0].c, logsBefore);
  assert.equal((dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM task_trello') as { c: number }[])[0].c, mapsBefore);
  // The stub board is byte-identical too (an update loop would rewrite cards).
  const state = readFileSync(h.statePath, 'utf8');
  h.sync(['--apply']);
  assert.equal(readFileSync(h.statePath, 'utf8'), state);
});

test('S11 sync: title edit → update action + update ledger row', (t) => {
  const h = seedBoardAndTasks(t);
  const id = h.mirroredTask('Before Edit');
  assert.equal(h.sync(['--apply']).status, 0);
  runHub(['edit-task', String(id), '--title', 'AFTER Edit'], h.env);
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  const card = stubState(h.statePath).cards[0];
  assert.equal(card.name, `[hub-${id}] AFTER Edit`);
  const logs = dbQuery(h.dbPath, "SELECT action FROM sync_log WHERE action='update'") as { action: string }[];
  assert.equal(logs.length, 1);
});

test('S11 sync: status change → card moves list (move action, no dup)', (t) => {
  const h = seedBoardAndTasks(t);
  const id = h.mirroredTask('Move probe');
  assert.equal(h.sync(['--apply']).status, 0);
  runHub(['set-task-status', String(id), '--status', 'in-progress'], h.env);
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  const card = stubState(h.statePath).cards[0];
  assert.equal(card.id, 'card001');
  assert.equal(card.list, 'listI');
  // Mapping/ledger: one move row, zero creates beyond the first run's.
  const moves = dbQuery(h.dbPath, "SELECT COUNT(*) c FROM sync_log WHERE action='move'") as { c: number }[];
  assert.equal(moves[0].c, 1);
});

test('S11 sync: completion → move to Done then archive in one run ({list: done} row)', (t) => {
  const h = seedBoardAndTasks(t);
  const id = h.mirroredTask('Finish probe');
  assert.equal(h.sync(['--apply']).status, 0);
  runHub(['set-task-status', String(id), '--status', 'completed'], h.env);
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  const [card] = stubState(h.statePath).cards;
  assert.equal(card.closed, true, 'the card is archived in the SAME run');
  assert.equal(card.list, 'listD', 'moved to the Done list before archiving');
  // ONE ledger row for the archive; its detail carries the done placement.
  const logs = dbQuery(h.dbPath, 'SELECT action, detail FROM sync_log WHERE entity_id=' + id) as unknown as LogRow[];
  const archiveRows = logs.filter((l) => l.action === 'archive');
  assert.equal(archiveRows.length, 1);
  assert.equal(JSON.parse(archiveRows[0].detail ?? '{}').list, 'done');
  // Mapping row is gone (the card is out of the mirror lifecycle).
  assert.deepEqual(JSON.parse(JSON.stringify(dbQuery(h.dbPath, 'SELECT COUNT(*) c FROM task_trello'))), [{ c: 0 }]);
  // Re-run: the archived card never comes back (not listed, not re-created).
  const again = h.sync(['--apply']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /in sync/);
  assert.equal(stubState(h.statePath).cards.length, 1);
});

test('S11 sync: adopt an orphan hub-prefixed card (mapping rebuilt, no dup)', (t) => {
  const h = seedBoardAndTasks(t);
  const id = h.mirroredTask('Adopt probe');
  // Pre-seed a card in the stub state that looks like the hub already made it.
  const state = {
    nextId: 2,
    cards: [
      {
        id: 'card999',
        name: `[hub-${id}] Adopt probe`,
        description: '',
        due: null,
        closed: false,
        url: 'u',
        labels: [],
        list: 'listR',
      },
    ],
  };
  writeFileSync(h.statePath, JSON.stringify(state, null, 2));
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  // ADOPTED, not duplicated: still exactly one card, original id preserved.
  const cards = stubState(h.statePath).cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].id, 'card999');
  const maps = dbQuery(h.dbPath, 'SELECT task_id, card_id FROM task_trello') as unknown as MapRow[];
  assert.deepEqual(JSON.parse(JSON.stringify(maps)), [{ task_id: id, card_id: 'card999' }]);
  const adopts = dbQuery(h.dbPath, "SELECT COUNT(*) c FROM sync_log WHERE action='adopt'") as { c: number }[];
  assert.equal(adopts[0].c, 1);
});

test('S11 sync: untagged card is NEVER touched', (t) => {
  const h = seedBoardAndTasks(t);
  h.mirroredTask('Untouched probe');
  const strangers = [
    {
      id: 'card700',
      name: 'Marla Sample manual card',
      description: '',
      due: null,
      closed: false,
      url: 'u',
      labels: [],
      list: 'listI',
    },
  ];
  writeFileSync(h.statePath, JSON.stringify({ nextId: 900, cards: strangers }, null, 2));
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  const cards = stubState(h.statePath).cards;
  // The stranger's position and content are untouched; the new card was ADDED, not interleaved destructively.
  assert.equal(cards[0].id, 'card700');
  assert.equal(cards[0].name, 'Marla Sample manual card');
  assert.equal(cards.length, 2);
  const maps = dbQuery(h.dbPath, 'SELECT task_id, card_id FROM task_trello') as unknown as MapRow[];
  assert.deepEqual(
    JSON.parse(JSON.stringify(maps)),
    [{ task_id: 1, card_id: 'card900' }],
    'the mapping binds only the hub-owned card',
  );
});

test('S11 sync: UNIQUE(card_id) double-claim → conflict row, nothing applied for the card', (t) => {
  const h = seedBoardAndTasks(t);
  const idA = h.mirroredTask('Conflict probe a');
  h.mirroredTask('Conflict probe b');
  // Two stub cards BOTH tagged for task idA: a double claim on that tag.
  const state = {
    nextId: 900,
    cards: [
      {
        id: 'card600',
        name: `[hub-${idA}] Conflict probe a`,
        description: '',
        due: null,
        closed: false,
        url: 'u',
        labels: [],
        list: 'listR',
      },
      {
        id: 'card601',
        name: `[hub-${idA}] Conflict probe a (copy)`,
        description: '',
        due: null,
        closed: false,
        url: 'u',
        labels: [],
        list: 'listR',
      },
      {
        id: 'card602',
        name: `[hub-999999999] Stray tag (no such task)`,
        description: '',
        due: null,
        closed: false,
        url: 'u',
        labels: [],
        list: 'listI',
      },
    ],
  };
  writeFileSync(h.statePath, JSON.stringify(state, null, 2));
  const r = h.sync(['--apply']);
  assert.equal(r.status, 0, r.stderr);
  // The conflict is REPORTED in the ledger (never silently resolved).
  // No ledger row for the double-claim beyond the reported conflict.
  const conflicts = dbQuery(h.dbPath, "SELECT COUNT(*) c FROM sync_log WHERE action='conflict'") as { c: number }[];
  assert.equal(conflicts[0].c, 1);
  // The stray-tag card (tag → task id that does not exist) is untouched;
  // adopting it would only insert a mapping row the FK rejects anyway.
  assert.equal(stubState(h.statePath).cards[2].list, 'listI');
  assert.equal(stubState(h.statePath).cards[2].closed, false);
});

test('S11 sync: --json plan and apply shapes carry actions + logged rows', (t) => {
  const h = seedBoardAndTasks(t);
  h.mirroredTask('Json probe');
  const dry = h.sync(['--json']);
  assert.equal(dry.status, 0, dry.stderr);
  const dryPlan = JSON.parse(dry.stdout) as { verb: string; applied: boolean; actions: { action: string }[] };
  assert.equal(dryPlan.verb, 'sync-trello');
  assert.equal(dryPlan.applied, false);
  assert.deepEqual(
    dryPlan.actions.map((a) => a.action),
    ['create'],
  );
  const apply = h.sync(['--apply', '--json']);
  assert.equal(apply.status, 0, apply.stderr);
  const applyOut = JSON.parse(apply.stdout) as { applied: boolean; executed: number; logged: { action: string }[] };
  assert.equal(applyOut.applied, true);
  assert.equal(applyOut.executed, 1);
  assert.deepEqual(
    applyOut.logged.map((l) => l.action),
    ['create'],
  );
});

test('S11 drift: engine timestamp due never reads as calendar-day drift', () => {
  // The engine stores Trello-side dues as ISO timestamps; the hub's due_date
  // is a calendar date. Raw equality reported phantom "update due" forever
  // (found in the first real sync, owner watching 2026-11-11).
  assert.equal(dueMatchesCalendar('2026-11-17T12:00:00.000Z', '2026-11-17'), true);
  assert.equal(dueMatchesCalendar(null, '2026-11-17'), false);
  assert.equal(dueMatchesCalendar('2026-11-17T12:00:00.000Z', null), false);
  assert.equal(dueMatchesCalendar(null, null), true);
  assert.equal(dueMatchesCalendar('2026-11-18T12:00:00.000Z', '2026-11-17'), false);
});
