// CRUD verbs: edit-person, edit-channel, edit-task, delete-task,
// delete-entity, merge-person. S12 (stories/ticket-s12-crud-verbs.md).
// The hub CLI was add-only until now — this module closes the CRUD gap with
// the same discipline as the S3–S7 verbs: business rules live in the write
// path, unknown slugs/ids are clean usage errors (never FK crashes), and
// merge-person moves rows inside ONE transaction so a failure can never leave
// a half-merged person.
//
// Partial-update rule (the heart of edit-*): the drizzle `set` object is
// built ONLY from provided flags, so unprovided fields are provably
// untouched — tested by full-row before/after diffs in tests/crud.test.ts.
import { makeDrizzle, openDb } from '../core/db.ts';
import { contactChannels, entities, entityLinks, files, interactions, people, subtasks, tasks } from '../schema.ts';
import { errorChainText, parseId, parseIsoDate } from '../core/util.ts';
import type {
  CliValues,
  DeleteStatus,
  EditChannelStatus,
  EditPersonStatus,
  EditTaskStatus,
  MergePersonStatus,
} from '../core/types.ts';
import { and, count, eq } from 'drizzle-orm';

/**
 * Collect the person fields provided for a partial update into a drizzle
 * `set` object. Only provided flags appear — an absent flag never reaches the
 * UPDATE, so the column keeps its current value by construction.
 * @param values - Parsed CLI flags (see `EditPersonValues`).
 * @returns The set object (possibly empty → "nothing to update" usage error upstream).
 */
function personSetFromFlags(values: CliValues): Partial<typeof people.$inferInsert> {
  const set: Partial<typeof people.$inferInsert> = {};
  if (values.name !== undefined) set.displayName = values.name as string;
  if (values['first-name'] !== undefined) set.firstName = values['first-name'] as string;
  if (values['last-name'] !== undefined) set.lastName = values['last-name'] as string;
  if (values['relationship-type'] !== undefined) set.relationshipType = values['relationship-type'] as string;
  if (values.employer !== undefined) set.employer = values.employer as string;
  if (values.notes !== undefined) set.notes = values.notes as string;
  return set;
}

/**
 * `hub edit-person`: partial update on a person row. The slug is the identity
 * (it keys filesystem artifacts and every relation handle) and is therefore
 * immutable — `--slug` is rejected outright. Unprovided fields stay untouched.
 * @param values - Parsed CLI flags; at least one person field required.
 * @param slugArg - First positional argument: the person's slug.
 * @returns Process exit code (0 = updated, 1 = usage/unknown slug).
 */
export async function cmdEditPerson(values: CliValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub edit-person: slug argument required');
    return 1;
  }
  if (values.slug !== undefined) {
    console.error('hub edit-person: --slug is not allowed — person slugs are immutable identity');
    return 1;
  }
  const set = personSetFromFlags(values);
  const provided = Object.keys(set);
  if (provided.length === 0) {
    console.error(
      'hub edit-person: nothing to update — provide at least one of --name --first-name --last-name --relationship-type --employer --notes',
    );
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(people).where(eq(people.slug, slugArg)).get();
    if (!row) {
      console.error(`hub edit-person: no person with slug "${slugArg}"`);
      return 1;
    }
    await hub.update(people).set(set).where(eq(people.id, row.id)).run();
    const fresh = await hub.select().from(people).where(eq(people.id, row.id)).get();
    if (!fresh) throw new Error('update vanished — row not found after edit');

    const out: EditPersonStatus = { verb: 'edit-person', ...personJsonFor(fresh) };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`edited person ${row.slug}: updated ${provided.join(', ')}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Map a drizzle `people` row to the snake_case JSON contract (same shape as
 * commands/people.ts's exported personJson — duplicated here as a private
 * mapper to keep command modules decoupled; the shapes must stay identical).
 * @param row - A row selected from the `people` table.
 * @returns The JSON-contract person object.
 */
function personJsonFor(row: typeof people.$inferSelect): Omit<EditPersonStatus, 'verb'> {
  return {
    id: row.id,
    slug: row.slug,
    display_name: row.displayName,
    first_name: row.firstName,
    last_name: row.lastName,
    relationship_type: row.relationshipType,
    employer: row.employer,
    notes: row.notes,
    created_at: row.createdAt,
  };
}

/**
 * `hub edit-channel`: partial update on a contact channel. `primary_flag` and
 * `source` are deliberately NOT editable here — primary is set-primary's job
 * (it owns the demote-then-set transaction), source is import provenance.
 * @param values - Parsed CLI flags; --kind and/or --value required.
 * @param idArg - First positional argument: the channel id.
 * @returns Process exit code (0 = updated, 1 = usage/unknown id).
 */
export async function cmdEditChannel(values: CliValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub edit-channel: channel id argument required');
    return 1;
  }
  const set: Partial<typeof contactChannels.$inferInsert> = {};
  if (values.kind !== undefined) set.kind = values.kind as string;
  if (values.value !== undefined) set.value = values.value as string;
  if (Object.keys(set).length === 0) {
    console.error('hub edit-channel: nothing to update — provide --kind and/or --value');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(contactChannels).where(eq(contactChannels.id, id)).get();
    if (!row) {
      console.error(`hub edit-channel: no channel with id ${id}`);
      return 1;
    }
    await hub.update(contactChannels).set(set).where(eq(contactChannels.id, id)).run();
    const fresh = await hub.select().from(contactChannels).where(eq(contactChannels.id, id)).get();
    if (!fresh) throw new Error('update vanished — row not found after edit');

    const out: EditChannelStatus = {
      verb: 'edit-channel',
      id: fresh.id,
      person_id: fresh.personId,
      kind: fresh.kind,
      value: fresh.value,
      primary_flag: fresh.primaryFlag,
      source: fresh.source,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`edited channel ${id}: updated ${Object.keys(set).join(', ')}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub edit-task`: partial update on a task row. `--due-date` passes the same
 * deterministic-ISO rule as add-task (fuzzy dates never parse); `--person`
 * re-points the person FK by slug (unknown slug = usage error, resolved
 * BEFORE the update). status/completed_at are set-task-status's job and are
 * not editable here.
 * @param values - Parsed CLI flags; at least one task field required.
 * @param idArg - First positional argument: the task id.
 * @returns Process exit code (0 = updated, 1 = usage/unknown id/slug).
 */
export async function cmdEditTask(values: CliValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub edit-task: task id argument required');
    return 1;
  }

  const set: Partial<typeof tasks.$inferInsert> = {};
  if (values.title !== undefined) set.title = values.title as string;
  if (values.context !== undefined) set.context = values.context as string;
  if (values.notes !== undefined) set.notes = values.notes as string;

  // Deterministic dates only — same rule as add-task ("next friday" rejects).
  if (values['due-date'] !== undefined) {
    const iso = parseIsoDate(values['due-date'] as string);
    if (!iso) {
      console.error(`hub edit-task: --due-date must be an ISO date (YYYY-MM-DD), got "${values['due-date']}"`);
      return 1;
    }
    set.dueDate = iso;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Resolve the person re-point BEFORE the update so an unknown slug is a
    // clean usage error rather than a mid-write FK failure.
    if (values.person !== undefined) {
      const person = await hub
        .select()
        .from(people)
        .where(eq(people.slug, values.person as string))
        .get();
      if (!person) {
        console.error(`hub edit-task: no person with slug "${values.person}"`);
        return 1;
      }
      set.personId = person.id;
    }

    if (Object.keys(set).length === 0) {
      console.error('hub edit-task: nothing to update — provide --title --context --due-date --notes --person');
      return 1;
    }

    const row = await hub.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) {
      console.error(`hub edit-task: no task with id ${id}`);
      return 1;
    }
    await hub.update(tasks).set(set).where(eq(tasks.id, id)).run();
    const fresh = await hub.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!fresh) throw new Error('update vanished — row not found after edit');
    const subtaskRows = await hub.select().from(subtasks).where(eq(subtasks.taskId, id)).all();

    const out: EditTaskStatus = {
      verb: 'edit-task',
      id: fresh.id,
      title: fresh.title,
      person_id: fresh.personId,
      context: fresh.context,
      status: fresh.status,
      due_date: fresh.dueDate,
      completed_at: fresh.completedAt,
      origin: fresh.origin,
      notes: fresh.notes,
      trello_visible: fresh.trelloVisible,
      created_at: fresh.createdAt,
      subtasks: subtaskRows.map((s) => ({
        id: s.id,
        task_id: s.taskId,
        label: s.label,
        done: s.done,
        position: s.position,
      })),
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`edited task ${id}: updated ${Object.keys(set).join(', ')}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub delete-task`: hard delete a task. Subtasks cascade via the schema FK
 * (ON DELETE CASCADE) — the test proves it, not just the schema comment.
 * @param values - Parsed CLI flags.
 * @param idArg - First positional argument: the task id.
 * @returns Process exit code (0 = deleted, 1 = usage/unknown id).
 */
export async function cmdDeleteTask(values: CliValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub delete-task: task id argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) {
      console.error(`hub delete-task: no task with id ${id}`);
      return 1;
    }
    await hub.delete(tasks).where(eq(tasks.id, id)).run();
    const out: DeleteStatus = { verb: 'delete-task', deleted: id, kind: 'task' };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`deleted task ${id} ("${row.title}") — subtasks cascaded`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub delete-entity`: hard delete an entity. entity_links rows referencing
 * it cascade via the schema FK on entity_id.
 * @param values - Parsed CLI flags.
 * @param slugArg - First positional argument: the entity's slug.
 * @returns Process exit code (0 = deleted, 1 = usage/unknown slug).
 */
export async function cmdDeleteEntity(values: CliValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub delete-entity: slug argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(entities).where(eq(entities.slug, slugArg)).get();
    if (!row) {
      console.error(`hub delete-entity: no entity with slug "${slugArg}"`);
      return 1;
    }
    await hub.delete(entities).where(eq(entities.id, row.id)).run();
    const out: DeleteStatus = { verb: 'delete-entity', deleted: row.slug, kind: 'entity' };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`deleted entity ${row.slug} ("${row.label}") — links cascaded`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub merge-person`: consolidate two people rows into one. All child rows
 * MOVE (UPDATE person_id, never delete+recreate) so primary-channel flags and
 * every other column survive by construction; polymorphic entity_links
 * (target_type='person') get an explicit re-point pass; then the from-person
 * row is deleted. Everything happens in ONE transaction — a failure anywhere
 * rolls the whole merge back (proved by the atomicity test).
 *
 * Refusals are checked before the transaction opens: from == into, unknown
 * from-slug, unknown into-slug — all clean usage errors, nothing written.
 * @param values - Parsed CLI flags; `into` (target slug) required.
 * @param slugArg - First positional argument: the from-person's slug (the row that disappears).
 * @returns Process exit code (0 = merged, 1 = usage/refusal).
 */
export async function cmdMergePerson(values: CliValues, slugArg?: string): Promise<number> {
  const fromSlug = slugArg;
  const intoSlug = values.into as string | undefined;
  if (!fromSlug || !intoSlug) {
    console.error('hub merge-person: usage: hub merge-person <from-slug> --into <into-slug>');
    return 1;
  }
  if (fromSlug === intoSlug) {
    console.error(`hub merge-person: refusing to merge "${fromSlug}" into itself`);
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Resolve both rows up front; unknown slugs are usage errors before any
    // write begins.
    const from = await hub.select().from(people).where(eq(people.slug, fromSlug)).get();
    if (!from) {
      console.error(`hub merge-person: no person with slug "${fromSlug}"`);
      return 1;
    }
    const into = await hub.select().from(people).where(eq(people.slug, intoSlug)).get();
    if (!into) {
      console.error(`hub merge-person: no person with slug "${intoSlug}"`);
      return 1;
    }
    // Same-row guard by id too: two slugs can never share an id (PK), so this
    // only fires if the caller somehow passed identical rows via aliases.
    if (from.id === into.id) {
      console.error(`hub merge-person: refusing to merge person ${from.id} into itself`);
      return 1;
    }

    // Count the rows this merge is responsible for BEFORE any write — the
    // moved-counts summary must reflect pre-merge state (counting after the
    // re-points would be ambiguous: into-person may already have children).
    const moved: MergePersonStatus['moved'] = {
      channels: await countChildRows(hub, contactChannels, from.id),
      interactions: await countChildRows(hub, interactions, from.id),
      files: await countChildRows(hub, files, from.id),
      tasks: await countChildRows(hub, tasks, from.id),
      links: await countPersonLinks(hub, from.id),
    };

    // The whole merge is one transaction: a failure in any re-point or the
    // final delete rolls back every move, leaving both people intact.
    db.exec('BEGIN');
    try {
      // Child rows MOVE: person_id re-point preserves every other column —
      // primary flags, values, notes, dates — by construction.
      await hub.update(contactChannels).set({ personId: into.id }).where(eq(contactChannels.personId, from.id)).run();
      await hub.update(interactions).set({ personId: into.id }).where(eq(interactions.personId, from.id)).run();
      await hub.update(files).set({ personId: into.id }).where(eq(files.personId, from.id)).run();
      await hub.update(tasks).set({ personId: into.id }).where(eq(tasks.personId, from.id)).run();
      // Polymorphic links need the explicit (target_type AND target_id) pass —
      // a bare target_type filter would re-point OTHER people's links.
      await hub
        .update(entityLinks)
        .set({ targetId: into.id })
        .where(and(eq(entityLinks.targetType, 'person'), eq(entityLinks.targetId, from.id)))
        .run();
      await hub.delete(people).where(eq(people.id, from.id)).run();

      db.exec('COMMIT');

      const out: MergePersonStatus = {
        verb: 'merge-person',
        from_slug: fromSlug,
        into_slug: intoSlug,
        into_id: into.id,
        moved: moved,
      };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(
          `merged ${fromSlug} into ${intoSlug}: channels ${moved.channels}, interactions ${moved.interactions}, files ${moved.files}, tasks ${moved.tasks}, links ${moved.links}`,
        );
      }
      return 0;
    } catch (err: unknown) {
      if (db.isTransaction) db.exec('ROLLBACK');
      const chain = errorChainText(err);
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error('hub merge-person: foreign-key failure — merge rolled back, nothing moved');
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * Count the rows in a person-child table pointing at the given person id.
 * Used for the merge moved-counts summary (pre-merge snapshot).
 * @param hub - The drizzle handle.
 * @param table - One of contactChannels/interactions/files/tasks.
 * @param personId - The from-person id.
 * @returns The row count.
 */
async function countChildRows(
  hub: ReturnType<typeof makeDrizzle>,
  table: typeof contactChannels | typeof interactions | typeof files | typeof tasks,
  personId: number,
): Promise<number> {
  const rows = await hub.select({ n: count() }).from(table).where(eq(table.personId, personId));
  return rows[0]?.n ?? 0;
}

/**
 * Count polymorphic entity_links rows whose person target is the given id.
 * @param hub - The drizzle handle.
 * @param personId - The from-person id.
 * @returns The link count.
 */
async function countPersonLinks(hub: ReturnType<typeof makeDrizzle>, personId: number): Promise<number> {
  const rows = await hub
    .select({ n: count() })
    .from(entityLinks)
    .where(and(eq(entityLinks.targetType, 'person'), eq(entityLinks.targetId, personId)));
  return rows[0]?.n ?? 0;
}
