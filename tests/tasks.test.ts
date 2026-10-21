// S4 acceptance tests (stories/epic-schema.md S4) — CLI-level against
// throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
// Scenario map:
//   1. task "ready" → update to "completed" → completed_at set by the CLI,
//      not passed in as a free value (no such flag exists)
//   2. task "ready" with trello_visible=0 → excluded from the mirror query
//   3. task trello_visible=1 status "in-progress" → included in the mirror
//   4. subtasks at positions 1,2,3 → mark subtask 2 done → 1 and 3
//      unaffected, order preserved
//   5. due_date "2026-11-05" validates as ISO; "next friday" rejected at the
//      CLI layer (deterministic dates only)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s4-'));
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

interface SubtaskRow {
  id: number;
  task_id: number;
  label: string;
  done: number;
  position: number;
}

interface TaskRow {
  id: number;
  title: string;
  person_id: number | null;
  context: string;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  origin: string;
  trello_visible: number;
  created_at: string;
}

function rawTasks(dbPath: string): TaskRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM tasks ORDER BY id').all() as unknown as TaskRow[];
  } finally {
    db.close();
  }
}

function rawSubtasks(dbPath: string): SubtaskRow[] {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT * FROM subtasks ORDER BY position').all() as unknown as SubtaskRow[];
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

// Scenario 1 — completed_at is set by the CLI, never passed in as a free value.
test('S4: set-task-status to "completed" stamps completed_at; moving away clears it', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const add = runCli(['add-task', '--title', 'Prep interview', '--context', 'job-hunt', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const taskId = JSON.parse(add.stdout).id as number;
  // Fresh task: no completed_at, no completion stamp anywhere.
  assert.equal(JSON.parse(add.stdout).completed_at, null);
  assert.equal(JSON.parse(add.stdout).status, 'ready');

  // There is no --completed-at flag — the CLI offers no way to set a free
  // completion timestamp; the only path is the status transition itself.
  const complete = runCli(['set-task-status', String(taskId), '--status', 'completed', '--json'], env);
  assert.equal(complete.status, 0, complete.stderr);
  const done = JSON.parse(complete.stdout);
  assert.equal(done.verb, 'set-task-status');
  assert.equal(done.status, 'completed');
  assert.match(done.completed_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'completed_at must be an ISO timestamp');
  assert.equal(rawTasks(dbPath).find((r) => r.id === taskId)!.completed_at, done.completed_at);

  // Reopening the task clears the stamp — a task is not still completed.
  const reopen = runCli(['set-task-status', String(taskId), '--status', 'ready', '--json'], env);
  assert.equal(reopen.status, 0, reopen.stderr);
  assert.equal(JSON.parse(reopen.stdout).completed_at, null);
  assert.equal(rawTasks(dbPath).find((r) => r.id === taskId)!.completed_at, null);
});

// Scenarios 2 + 3 — the mirror query includes exactly trello_visible=1 AND
// status in (ready, in-progress).
test('S4: mirror filter — trello_visible=0 excluded, in-progress+visible included, completed excluded', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  // Hidden-but-ready (scenario 2) — must be excluded.
  const hidden = runCli(['add-task', '--title', 'Hidden task', '--context', 'discord', '--json'], env);
  assert.equal(hidden.status, 0, hidden.stderr);
  assert.equal(JSON.parse(hidden.stdout).trello_visible, 0, 'trello_visible defaults to 0');

  // Visible + in-progress (scenario 3) — must be included.
  const visible = runCli(
    ['add-task', '--title', 'Visible task', '--context', 'job-hunt', '--trello-visible', '--json'],
    env,
  );
  assert.equal(visible.status, 0, visible.stderr);
  const visibleId = JSON.parse(visible.stdout).id as number;
  runCli(['set-task-status', String(visibleId), '--status', 'in-progress'], env);

  // Visible but completed — excluded: completed work never syncs.
  const finished = runCli(
    ['add-task', '--title', 'Finished task', '--context', 'job-hunt', '--trello-visible', '--json'],
    env,
  );
  assert.equal(finished.status, 0, finished.stderr);
  const finishedId = JSON.parse(finished.stdout).id as number;
  runCli(['set-task-status', String(finishedId), '--status', 'completed'], env);

  // Visible and ready — included.
  const ready = runCli(['add-task', '--title', 'Ready task', '--context', 'family', '--trello-visible', '--json'], env);
  assert.equal(ready.status, 0, ready.stderr);
  const readyId = JSON.parse(ready.stdout).id as number;

  const mirror = runCli(['list-tasks', '--mirror', '--json'], env);
  assert.equal(mirror.status, 0, mirror.stderr);
  const out = JSON.parse(mirror.stdout);
  assert.equal(out.verb, 'list-tasks');
  assert.equal(out.mirror, true);
  assert.deepEqual(
    out.tasks.map((r: TaskRow) => r.id).sort(),
    [visibleId, readyId],
    'mirror must include only trello_visible=1 AND status ready/in-progress',
  );

  // The full listing (no filter) still shows everything.
  const all = runCli(['list-tasks', '--json'], env);
  assert.equal(JSON.parse(all.stdout).count, 4);
});

// Scenario 4 — subtasks at positions 1,2,3; marking subtask 2 done leaves 1
// and 3 untouched and preserves order.
test('S4: mark subtask 2 done — siblings unaffected, position order preserved', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const add = runCli(['add-task', '--title', 'Prep interview', '--context', 'job-hunt', '--json'], env);
  assert.equal(add.status, 0, add.stderr);
  const taskId = JSON.parse(add.stdout).id as number;

  const positions: number[] = [];
  for (const label of ['Research panel', 'Draft questions', 'Thank-you note']) {
    const sub = runCli(['add-subtask', String(taskId), '--label', label, '--json'], env);
    assert.equal(sub.status, 0, sub.stderr);
    const out = JSON.parse(sub.stdout);
    assert.equal(out.verb, 'add-subtask');
    positions.push(out.position);
  }
  assert.deepEqual(positions, [1, 2, 3], 'positions must be assigned 1,2,3 in append order');

  // "I mark subtask 2 done" — via the CLI write path, default --done 1.
  const mark = runCli(['mark-subtask', '2', '--json'], env);
  assert.equal(mark.status, 0, mark.stderr);
  const marked = JSON.parse(mark.stdout);
  assert.equal(marked.done, 1);
  assert.equal(marked.position, 2);

  const subs = rawSubtasks(dbPath);
  assert.deepEqual(
    subs.map((s) => [s.id, s.done, s.position]),
    [
      [1, 0, 1],
      [2, 1, 2],
      [3, 0, 3],
    ],
    'siblings 1 and 3 stay not-done; order by position is untouched',
  );

  // Undo path: --done 0 flips it back.
  const undo = runCli(['mark-subtask', '2', '--done', '0', '--json'], env);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal(JSON.parse(undo.stdout).done, 0);

  // Subtasks also arrive nested and ordered through list-tasks --json.
  const list = runCli(['list-tasks', '--json'], env);
  const nested = JSON.parse(list.stdout).tasks.find((r: TaskRow) => r.id === taskId).subtasks as SubtaskRow[];
  assert.deepEqual(
    nested.map((s) => [s.id, s.done]),
    [
      [1, 0],
      [2, 0],
      [3, 0],
    ],
  );
});

// Scenario 5 — deterministic ISO dates only; fuzzy dates rejected at the CLI.
test('S4: due_date "2026-11-05" accepted; "next friday" and impossible dates rejected', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const good = runCli(
    ['add-task', '--title', 'Dated task', '--context', 'job-hunt', '--due-date', '2026-11-05', '--json'],
    env,
  );
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).due_date, '2026-11-05');

  const fuzzy = runCli(['add-task', '--title', 'Fuzzy task', '--context', 'c', '--due-date', 'next friday'], env);
  assert.equal(fuzzy.status, 1, 'fuzzy dates must be rejected at the CLI layer');
  assert.match(fuzzy.stderr, /must be an ISO date/);

  // Real calendar validation, not just shape: 2026-02-30 does not exist.
  const impossible = runCli(['add-task', '--title', 'Bad task', '--context', 'c', '--due-date', '2026-02-30'], env);
  assert.equal(impossible.status, 1);
  assert.match(impossible.stderr, /must be an ISO date/);
});

// Extra S4-scope contract: add-task JSON contract and defaults, person link,
// unknown-slug error, and list-tasks filters.
test('S4: add-task defaults and --person link; list-tasks --person/--status filters', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const linked = runCli(
    [
      'add-task',
      '--title',
      'Linked task',
      '--context',
      'job-hunt',
      '--person',
      'casey-smith',
      '--origin',
      'trello',
      '--notes',
      'from the board',
      '--json',
    ],
    env,
  );
  assert.equal(linked.status, 0, linked.stderr);
  const out = JSON.parse(linked.stdout);
  assert.equal(out.verb, 'add-task');
  assert.equal(out.person_id, 1);
  assert.equal(out.status, 'ready');
  assert.equal(out.origin, 'trello');
  assert.equal(out.notes, 'from the board');
  assert.match(out.created_at, /^\d{4}-\d{2}-\d{2}T/);

  // People-less tasks are first-class (S5 will rely on the same for interactions).
  const lone = runCli(['add-task', '--title', 'Lone task', '--context', 'family', '--json'], env);
  assert.equal(lone.status, 0, lone.stderr);
  assert.equal(JSON.parse(lone.stdout).person_id, null);

  // Unknown person slug is a clean usage error, not an FK crash.
  const unknown = runCli(['add-task', '--title', 'X', '--context', 'c', '--person', 'nobody-here'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /no person with slug "nobody-here"/);

  // --person filter resolves the slug and narrows the list.
  const byPerson = runCli(['list-tasks', '--person', 'casey-smith', '--json'], env);
  assert.equal(byPerson.status, 0, byPerson.stderr);
  const personTasks = JSON.parse(byPerson.stdout).tasks as TaskRow[];
  assert.deepEqual(
    personTasks.map((r) => r.title),
    ['Linked task'],
  );

  // --status filter; a bogus status is rejected before it reaches the DB.
  const byStatus = runCli(['list-tasks', '--status', 'ready', '--json'], env);
  assert.equal(JSON.parse(byStatus.stdout).count, 2);
  const badStatus = runCli(['list-tasks', '--status', 'done'], env);
  assert.equal(badStatus.status, 1);
  assert.match(badStatus.stderr, /must be one of/);
  const badPerson = runCli(['list-tasks', '--person', 'nobody-here'], env);
  assert.equal(badPerson.status, 1);
});

// Extra S4-scope contract: subtask error paths and mark-subtask unknown id.
test('S4: subtask error paths exit 1 — unknown task, missing label, unknown subtask', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const unknownTask = runCli(['add-subtask', '999', '--label', 'x'], env);
  assert.equal(unknownTask.status, 1);
  assert.match(unknownTask.stderr, /no task with id 999/);

  const add = runCli(['add-task', '--title', 'T', '--context', 'c', '--json'], env);
  const taskId = JSON.parse(add.stdout).id as number;
  const missingLabel = runCli(['add-subtask', String(taskId)], env);
  assert.equal(missingLabel.status, 1);

  const unknownSub = runCli(['mark-subtask', '999'], env);
  assert.equal(unknownSub.status, 1);
  assert.match(unknownSub.stderr, /no subtask with id 999/);

  const badDone = runCli(['mark-subtask', '1', '--done', 'yes'], env);
  assert.equal(badDone.status, 1);
  assert.match(badDone.stderr, /--done must be 0 or 1/);

  // set-task-status error paths: unknown task, missing/bad status, bad id.
  const unknownStatus = runCli(['set-task-status', '999', '--status', 'ready'], env);
  assert.equal(unknownStatus.status, 1);
  assert.match(unknownStatus.stderr, /no task with id 999/);
  const missingStatus = runCli(['set-task-status', String(taskId)], env);
  assert.equal(missingStatus.status, 1);
  const badStatusValue = runCli(['set-task-status', String(taskId), '--status', 'done'], env);
  assert.equal(badStatusValue.status, 1);
  assert.match(badStatusValue.stderr, /must be one of/);
  const notAnId = runCli(['set-task-status', 'abc'], env);
  assert.equal(notAnId.status, 1);
});

// Extra S4-scope contract: FK actions — deleting a person nulls the task's
// person link (SET NULL, tasks outlive people), deleting a task cascades its
// subtasks. Both go through raw SQL like the S2/S3 cascade tests, since no
// remove verbs are in scope.
test('S4: person delete SET NULLs task.person_id; task delete cascades subtasks', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedPerson(dbPath);

  const add = runCli(
    ['add-task', '--title', 'Linked task', '--context', 'job-hunt', '--person', 'casey-smith', '--json'],
    env,
  );
  const taskId = JSON.parse(add.stdout).id as number;
  for (const label of ['a', 'b']) {
    assert.equal(runCli(['add-subtask', String(taskId), '--label', label], env).status, 0);
  }

  // Delete the person — the task must survive with a NULL person link.
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.prepare('DELETE FROM people WHERE slug = ?').run('casey-smith');
  } finally {
    db.close();
  }
  const afterPerson = rawTasks(dbPath).find((r) => r.id === taskId)!;
  assert.ok(afterPerson, 'task must survive its person');
  assert.equal(afterPerson.person_id, null, 'person delete must SET NULL, not cascade-delete tasks');

  // Delete the task — its subtasks must cascade away.
  const db2 = new DatabaseSync(dbPath);
  try {
    db2.exec('PRAGMA foreign_keys = ON');
    db2.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  } finally {
    db2.close();
  }
  assert.equal(rawTasks(dbPath).length, 0);
  assert.equal(rawSubtasks(dbPath).length, 0, 'task delete must cascade subtasks');
});

// Extra S4-scope contract: the DB CHECK backstops the CLI, and fresh-DB init
// lands at user_version 3 (001_people + 002_contact_channels + 003_tasks).
test('S4: DB CHECK rejects bad status; user_version lands at 3', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  seedPerson(dbPath);

  // The CLI never allows it, so the CHECK is exercised via raw SQL: any
  // status outside the three values must be rejected by the schema itself.
  const db = new DatabaseSync(dbPath);
  try {
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO tasks (title, context, status, origin, created_at) VALUES ('x', 'c', 'done', 'self', '2026-01-01')",
          )
          .run(),
      /CHECK constraint failed/,
    );
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    assert.equal(uv.user_version, 3, 'fresh init with real migrations must land at user_version 3');
  } finally {
    db.close();
  }
});
