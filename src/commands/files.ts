// File verbs: add-file, list-files. S7 — the index of durable artifacts on
// disk (~/hub/files/<slug>/... by convention). The CLI stores paths as given
// and performs NO disk I/O: the hierarchy convention is how humans/agents
// organize files, not a write-path rule, and indexing a not-yet-existing
// artifact is legitimate (the record can precede the artifact). person_id and
// task_id are nullable FKs — an unknown person slug or task id is resolved
// before insert, so an invalid target is a friendly usage error, never a raw
// driver crash (same resolve-before-insert pattern as add-task --person).
import { makeDrizzle, openDb } from '../core/db.ts';
import { files, people, tasks } from '../schema.ts';
import { errorChainText, parseId } from '../core/util.ts';
import type { AddFileStatus, AddFileValues, FileJson, ListFilesStatus, ListFilesValues } from '../core/types.ts';
import { and, eq } from 'drizzle-orm';

/**
 * Map a drizzle `files` row to the snake_case JSON contract. Explicit mapping
 * keeps the CLI contract (snake_case) separate from the database row shape
 * (camelCase).
 * @param row - A row selected from the `files` table.
 * @returns The JSON-contract file object for `--json` output.
 */
function fileJson(row: typeof files.$inferSelect): FileJson {
  return {
    id: row.id,
    path: row.path,
    kind: row.kind,
    person_id: row.personId,
    task_id: row.taskId,
    added_at: row.addedAt,
    note: row.note,
  };
}

/**
 * `hub add-file`: index a durable artifact. `--path` and `--kind` are
 * required (NOT NULL columns); `--person` (by slug) and `--task` (by id) are
 * optional nullable links, both resolved before insert. The path is stored
 * exactly as given — the CLI never touches the filesystem.
 * @param values - Parsed CLI flags (see `AddFileValues`).
 * @returns Process exit code (0 = indexed, 1 = usage/lookup error).
 */
export async function cmdAddFile(values: AddFileValues): Promise<number> {
  // Required fields first, so usage errors never depend on optional-flag order.
  const path = values.path;
  const kind = values.kind;
  if (!path || !kind) {
    console.error(
      'hub add-file: usage: hub add-file --path <p> --kind <k> [--person <slug>] [--task <id>] [--note <n>]',
    );
    return 1;
  }

  // Task link, when given, must be a valid id (resolved below).
  let taskId: number | null = null;
  if (values.task) {
    taskId = parseId(values.task);
    if (taskId === null) {
      console.error(`hub add-file: --task must be a numeric task id, got "${values.task}"`);
      return 1;
    }
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Resolve optional links before insert so unknown targets are clean
    // usage errors rather than foreign-key failures.
    let personId: number | null = null;
    if (values.person) {
      const person = await hub.select().from(people).where(eq(people.slug, values.person)).get();
      if (!person) {
        console.error(`hub add-file: no person with slug "${values.person}"`);
        return 1;
      }
      personId = person.id;
    }
    if (taskId !== null) {
      const task = await hub.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) {
        console.error(`hub add-file: no task with id ${taskId}`);
        return 1;
      }
    }

    try {
      const inserted = await hub
        .insert(files)
        .values({ path, kind, personId, taskId, addedAt: new Date().toISOString(), note: values.note ?? null })
        .returning({ id: files.id });
      const row = await hub.select().from(files).where(eq(files.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: AddFileStatus = { verb: 'add-file', ...fileJson(row) };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`indexed file ${row.id} "${row.path}" (kind ${row.kind})`);
      }
      return 0;
    } catch (err: unknown) {
      // The person/task could have been deleted between lookup and insert.
      const chain = errorChainText(err);
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error('hub add-file: linked person or task no longer exists');
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub list-files`: list indexed files ordered by id. Filters combine:
 * --person <slug> (resolved to an id first — an unknown slug is a usage
 * error), --task <id>, --kind <k> (exact match). An empty result is valid
 * output, not an error.
 * @param values - Parsed CLI flags (see `ListFilesValues`).
 * @returns Process exit code (0 = listed, 1 = usage/lookup error).
 */
export async function cmdListFiles(values: ListFilesValues): Promise<number> {
  // Task filter, when given, must be a valid id (resolved below).
  let taskId: number | null = null;
  if (values.task) {
    taskId = parseId(values.task);
    if (taskId === null) {
      console.error(`hub list-files: --task must be a numeric task id, got "${values.task}"`);
      return 1;
    }
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Accumulate filters, then AND them; an empty list means no WHERE clause.
    const conditions = [];
    if (values.person) {
      const person = await hub.select().from(people).where(eq(people.slug, values.person)).get();
      if (!person) {
        console.error(`hub list-files: no person with slug "${values.person}"`);
        return 1;
      }
      conditions.push(eq(files.personId, person.id));
    }
    if (taskId !== null) conditions.push(eq(files.taskId, taskId));
    if (values.kind) conditions.push(eq(files.kind, values.kind));

    const rows = await hub
      .select()
      .from(files)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(files.id)
      .all();

    const outRows: FileJson[] = rows.map(fileJson);
    const out: ListFilesStatus = {
      verb: 'list-files',
      count: outRows.length,
      kind: values.kind ?? null,
      files: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const f of outRows) {
        console.log(`${f.id}\t${f.kind}\t${f.person_id ?? '-'}\t${f.task_id ?? '-'}\t${f.path}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
