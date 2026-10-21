// Task verbs: add-task, set-task-status, list-tasks, add-subtask, mark-subtask.
// S4 — tasks + subtasks. Business rules live in the write path (AGENTS.md):
// completed_at is CLI-managed (stamped on →completed, cleared on leaving it),
// due_date is validated as a deterministic ISO date before it ever reaches
// the DB, and the Trello-mirror filter is a list-tasks mode (--mirror). The
// DB CHECK on status is a backstop only — the CLI validates first so driver
// errors never surface to users.
import { makeDrizzle, openDb } from '../core/db.ts';
import { people, subtasks, tasks } from '../schema.ts';
import { errorChainText, parseId, parseIsoDate } from '../core/util.ts';
import { TASK_STATUSES } from '../core/constants.ts';
import type {
  AddSubtaskStatus,
  AddTaskStatus,
  AddTaskValues,
  AddSubtaskValues,
  ListTasksStatus,
  ListTasksValues,
  MarkSubtaskStatus,
  MarkSubtaskValues,
  SetTaskStatusStatus,
  SetTaskStatusValues,
  TaskJson,
} from '../core/types.ts';
import { and, eq, inArray } from 'drizzle-orm';

/**
 * Validate a task status against TASK_STATUSES (the DB CHECK's CLI-side
 * mirror). Keeping validation here means a bad --status is a friendly usage
 * error, never a raw CHECK-constraint crash.
 * @param raw - The raw --status value, possibly undefined.
 * @returns The validated status string, or null when missing/unknown.
 */
function parseTaskStatus(raw: string | undefined): string | null {
  if (!raw) return null;
  return (TASK_STATUSES as readonly string[]).includes(raw) ? raw : null;
}

/**
 * Map a drizzle `tasks` row to the snake_case JSON contract, attaching its
 * subtasks (already ordered by position). Explicit mapping keeps the CLI
 * contract (snake_case) separate from the database row shape (camelCase).
 * @param row - A row selected from the `tasks` table.
 * @param subtaskRows - That task's subtask rows, ordered by position.
 * @returns The JSON-contract task object for `--json` output.
 */
function taskJson(row: typeof tasks.$inferSelect, subtaskRows: (typeof subtasks.$inferSelect)[]): TaskJson {
  return {
    id: row.id,
    title: row.title,
    person_id: row.personId,
    context: row.context,
    status: row.status,
    due_date: row.dueDate,
    completed_at: row.completedAt,
    origin: row.origin,
    notes: row.notes,
    trello_visible: row.trelloVisible,
    created_at: row.createdAt,
    subtasks: subtaskRows.map((s) => ({
      id: s.id,
      task_id: s.taskId,
      label: s.label,
      done: s.done,
      position: s.position,
    })),
  };
}

/**
 * `hub add-task`: insert a task. `title` and `context` are required (context
 * is a NOT NULL column per S4); `--person` resolves a slug to a person link;
 * `--due-date` must be a deterministic ISO date (YYYY-MM-DD). status defaults
 * to "ready", origin to "self" (free text — the S4 ticket names
 * trello/self/agent but deliberately gives origin no CHECK, unlike status).
 * @param values - Parsed CLI flags (see `AddTaskValues`).
 * @returns Process exit code (0 = added, 1 = usage/lookup/date error).
 */
export async function cmdAddTask(values: AddTaskValues): Promise<number> {
  // Required fields first, so usage errors never depend on optional-flag order.
  const title = values.title;
  const context = values.context;
  if (!title || !context) {
    console.error('hub add-task: usage: hub add-task --title <t> --context <c> [--person <slug>]');
    return 1;
  }

  // Status: default "ready"; anything outside TASK_STATUSES is a usage error
  // (the DB CHECK is a backstop, not the UX).
  const status = values.status ? parseTaskStatus(values.status) : 'ready';
  if (status === null) {
    console.error(`hub add-task: --status must be one of: ${TASK_STATUSES.join(', ')}`);
    return 1;
  }

  // Due date: deterministic dates only — "next friday" never parses.
  let dueDate: string | null = null;
  if (values['due-date']) {
    dueDate = parseIsoDate(values['due-date']);
    if (!dueDate) {
      console.error(`hub add-task: --due-date must be an ISO date (YYYY-MM-DD), got "${values['due-date']}"`);
      return 1;
    }
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Resolve the optional person link before insert so an unknown slug is a
    // clean usage error rather than a foreign-key failure.
    let personId: number | null = null;
    if (values.person) {
      const person = await hub.select().from(people).where(eq(people.slug, values.person)).get();
      if (!person) {
        console.error(`hub add-task: no person with slug "${values.person}"`);
        return 1;
      }
      personId = person.id;
    }

    try {
      const inserted = await hub
        .insert(tasks)
        .values({
          title,
          personId,
          context,
          status,
          dueDate,
          origin: values.origin ?? 'self',
          notes: values.notes ?? null,
          trelloVisible: values['trello-visible'] === true ? 1 : 0,
          createdAt: new Date().toISOString(),
        })
        .returning({ id: tasks.id });
      const row = await hub.select().from(tasks).where(eq(tasks.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: AddTaskStatus = {
        verb: 'add-task',
        id: row.id,
        title: row.title,
        person_id: row.personId,
        context: row.context,
        status: row.status,
        due_date: row.dueDate,
        completed_at: row.completedAt,
        origin: row.origin,
        notes: row.notes,
        trello_visible: row.trelloVisible,
        created_at: row.createdAt,
      };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`added task ${row.id} "${row.title}" (context ${row.context}, status ${row.status})`);
      }
      return 0;
    } catch (err: unknown) {
      // Drizzle wraps driver errors — match against the whole cause chain.
      // The person could have been deleted between lookup and insert.
      const chain = errorChainText(err);
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error(`hub add-task: person_id ${personId} no longer exists`);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub set-task-status`: change a task's status. completed_at is CLI-managed,
 * never a free value (S4): moving to "completed" stamps it with the current
 * time; moving away from "completed" clears it. One UPDATE covers both, so
 * the stamp and the status can never disagree.
 * @param values - Parsed CLI flags; `status` is required.
 * @param idArg - First positional argument: the task id (positive integer).
 * @returns Process exit code (0 = updated, 1 = usage/unknown task).
 */
export async function cmdSetTaskStatus(values: SetTaskStatusValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub set-task-status: task id argument required');
    return 1;
  }
  const status = parseTaskStatus(values.status);
  if (!status) {
    console.error(`hub set-task-status: --status is required and must be one of: ${TASK_STATUSES.join(', ')}`);
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) {
      console.error(`hub set-task-status: no task with id ${id}`);
      return 1;
    }

    // CLI-set timestamp: "completed" → now; anything else → NULL (reopened
    // tasks are not still completed). Single statement, so no tx is needed.
    const completedAt = status === 'completed' ? new Date().toISOString() : null;
    await hub.update(tasks).set({ status, completedAt }).where(eq(tasks.id, id)).run();

    const out: SetTaskStatusStatus = { verb: 'set-task-status', id, status, completed_at: completedAt };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`task ${id} status → ${status}${completedAt ? ` (completed_at ${completedAt})` : ''}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub list-tasks`: list tasks (ordered by id) with subtasks nested in
 * position order. Filters combine: --mirror (the Trello-mirror query:
 * trello_visible=1 AND status in ready/in-progress), --person <slug>,
 * --status <s>. An empty result is valid output, not an error.
 * @param values - Parsed CLI flags (see `ListTasksValues`).
 * @returns Process exit code (always 0 unless a filter is invalid).
 */
export async function cmdListTasks(values: ListTasksValues): Promise<number> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Accumulate filters, then AND them; an empty list means no WHERE clause.
    const conditions = [];
    let mirror = false;
    if (values.mirror === true) {
      mirror = true;
      // The mirror contract from the S4 ticket: visible to Trello and still
      // live (ready or in-progress) — completed work never syncs.
      conditions.push(eq(tasks.trelloVisible, 1));
      conditions.push(inArray(tasks.status, ['ready', 'in-progress']));
    }
    if (values.status) {
      const status = parseTaskStatus(values.status);
      if (!status) {
        console.error(`hub list-tasks: --status must be one of: ${TASK_STATUSES.join(', ')}`);
        return 1;
      }
      conditions.push(eq(tasks.status, status));
    }
    if (values.person) {
      const person = await hub.select().from(people).where(eq(people.slug, values.person)).get();
      if (!person) {
        console.error(`hub list-tasks: no person with slug "${values.person}"`);
        return 1;
      }
      conditions.push(eq(tasks.personId, person.id));
    }

    const rows = await hub
      .select()
      .from(tasks)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(tasks.id)
      .all();

    // Subtasks come back grouped by (taskId, position) and are joined in
    // memory — one query instead of one per task.
    const subtaskRows = await hub.select().from(subtasks).orderBy(subtasks.taskId, subtasks.position).all();
    const byTask = new Map<number, (typeof subtasks.$inferSelect)[]>();
    for (const s of subtaskRows) {
      const list = byTask.get(s.taskId) ?? [];
      list.push(s);
      byTask.set(s.taskId, list);
    }

    const outRows: TaskJson[] = rows.map((row) => taskJson(row, byTask.get(row.id) ?? []));
    const status: ListTasksStatus = { verb: 'list-tasks', count: outRows.length, mirror, tasks: outRows };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      for (const t of outRows) {
        console.log(`${t.id}\t${t.status}\t${t.context}\t${t.person_id ?? '-'}\t${t.due_date ?? '-'}\t${t.title}`);
        for (const s of t.subtasks) {
          console.log(`  ${s.id}\t${s.done ? 'x' : '-'}\t${s.label}`);
        }
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub add-subtask`: append a subtask to a task. The position is assigned
 * here (max existing position + 1 per task) — write-once in S4 scope; there
 * is no reorder verb yet. The task must exist.
 * @param values - Parsed CLI flags; `label` is required.
 * @param idArg - First positional argument: the task id (positive integer).
 * @returns Process exit code (0 = added, 1 = usage/unknown task).
 */
export async function cmdAddSubtask(values: AddSubtaskValues, idArg?: string): Promise<number> {
  const taskId = parseId(idArg);
  if (taskId === null) {
    console.error('hub add-subtask: task id argument required');
    return 1;
  }
  if (!values.label) {
    console.error('hub add-subtask: --label is required');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const task = await hub.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) {
      console.error(`hub add-subtask: no task with id ${taskId}`);
      return 1;
    }

    // Append-only position: one past the current max for this task. A single
    // user runs the CLI serially, so no transaction is needed for max+insert.
    const existing = await hub
      .select({ position: subtasks.position })
      .from(subtasks)
      .where(eq(subtasks.taskId, taskId))
      .all();
    const position = existing.reduce((max, r) => Math.max(max, r.position), 0) + 1;

    const inserted = await hub
      .insert(subtasks)
      .values({ taskId, label: values.label, done: 0, position })
      .returning({ id: subtasks.id });
    const row = await hub.select().from(subtasks).where(eq(subtasks.id, inserted[0].id)).get();
    if (!row) throw new Error('insert vanished — returned id not found');

    const out: AddSubtaskStatus = {
      verb: 'add-subtask',
      id: row.id,
      task_id: row.taskId,
      label: row.label,
      done: row.done,
      position: row.position,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`added subtask ${row.id} to task ${taskId} (position ${row.position}) "${row.label}"`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub mark-subtask`: set one subtask's done flag (default done). Only the
 * target row changes — siblings and positions are untouched, which is the
 * behaviour the S4 ordering scenario pins down.
 * @param values - Parsed CLI flags; `--done` accepts "0" or "1".
 * @param idArg - First positional argument: the subtask id (positive integer).
 * @returns Process exit code (0 = updated, 1 = usage/unknown subtask).
 */
export async function cmdMarkSubtask(values: MarkSubtaskValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub mark-subtask: subtask id argument required');
    return 1;
  }
  const doneRaw = values.done ?? '1';
  if (doneRaw !== '0' && doneRaw !== '1') {
    console.error('hub mark-subtask: --done must be 0 or 1');
    return 1;
  }
  const done = Number(doneRaw);

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(subtasks).where(eq(subtasks.id, id)).get();
    if (!row) {
      console.error(`hub mark-subtask: no subtask with id ${id}`);
      return 1;
    }
    await hub.update(subtasks).set({ done }).where(eq(subtasks.id, id)).run();

    const out: MarkSubtaskStatus = {
      verb: 'mark-subtask',
      id: row.id,
      task_id: row.taskId,
      label: row.label,
      done,
      position: row.position,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`subtask ${id} (${row.label}) marked ${done ? 'done' : 'not done'}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
