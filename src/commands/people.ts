// People verbs: add-person, get-person, list-people, edit-person, merge-person.
// These commands share the open→drizzle→close pattern (see core/db.ts) and map
// drizzle's camelCase rows onto the snake_case --json contract via personJson.
// S12 amendment: edit-person + merge-person (with helpers personSetFromFlags,
// countChildRows, countPersonLinks) moved here verbatim from commands/crud.ts —
// edit-person uses this module's exported personJson (no duplicated mapper).
import { makeDrizzle, openDb } from '../core/db.ts';
import { contactChannels, entityLinks, files, interactions, people, tasks } from '../schema.ts';
import { deriveSlug, errorChainText } from '../core/util.ts';
import type {
  AddPersonValues,
  AddPersonStatus,
  CliValues,
  EditPersonStatus,
  MergePersonStatus,
  PersonJson,
} from '../core/types.ts';
import { and, count, eq } from 'drizzle-orm';

/**
 * Map a drizzle `people` row to the snake_case JSON contract (`PersonJson`).
 * This explicit mapping is what keeps the CLI contract (snake_case) separate
 * from the database row shape (camelCase); do not serialize drizzle rows raw.
 * @param row - A row selected from the `people` table.
 * @returns The JSON-contract person object for `--json` output.
 */
export function personJson(row: typeof people.$inferSelect): PersonJson {
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
 * `hub add-person`: insert a new person, deriving its immutable slug.
 * Slug rules: derived from --name unless --slug overrides it; the override must
 * already be lowercase-dashed (we derive-and-compare to detect invalid input).
 * A duplicate slug (UNIQUE constraint) is a friendly error, not a crash.
 * @param values - Parsed CLI flags; `name` is required, `slug` optional.
 * @returns Process exit code (0 = added, 1 = usage or constraint error).
 */
export async function cmdAddPerson(values: AddPersonValues): Promise<number> {
  const name = values.name;
  if (!name) {
    console.error('hub add-person: --name is required');
    return 1;
  }

  // Slug comes from --slug if given (after validation), else from --name.
  // deriveSlug is deterministic, so re-deriving the override detects typos.
  const slug = values.slug ? deriveSlug(values.slug) : deriveSlug(name);
  if (!slug) {
    console.error('hub add-person: could not derive a valid slug from name');
    return 1;
  }
  if (values.slug && slug !== values.slug) {
    console.error(`hub add-person: --slug "${values.slug}" must be lowercase-dashed (e.g. "${slug}")`);
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const [row] = await hub
      .insert(people)
      .values({
        slug,
        displayName: name,
        firstName: (values['first-name'] as string) ?? null,
        lastName: (values['last-name'] as string) ?? null,
        relationshipType: (values['relationship-type'] as string) ?? null,
        employer: (values.employer as string) ?? null,
        notes: (values.notes as string) ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning({ id: people.id, slug: people.slug, createdAt: people.createdAt });

    const status: AddPersonStatus = {
      verb: 'add-person',
      id: row.id,
      slug: row.slug,
      created_at: row.createdAt,
    };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`added person ${row.slug} (id ${row.id})`);
    }
    return 0;
  } catch (err: unknown) {
    // Drizzle wraps driver errors, so match against the whole cause chain.
    const chain = errorChainText(err);
    if (/UNIQUE constraint failed: people\.slug/.test(chain)) {
      console.error(`hub add-person: slug "${slug}" already exists`);
      return 1;
    }
    throw err;
  } finally {
    db.close();
  }
}

/**
 * `hub get-person`: look up one person by slug and print it (or emit JSON).
 * Missing slug or unknown person are usage errors, not exceptions.
 * @param values - Parsed CLI flags.
 * @param slugArg - First positional argument: the person's slug.
 * @returns Process exit code (0 = found, 1 = missing/unknown slug).
 */
export async function cmdGetPerson(values: CliValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub get-person: slug argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(people).where(eq(people.slug, slugArg)).get();
    if (!row) {
      console.error(`hub get-person: no person with slug "${slugArg}"`);
      return 1;
    }
    const out = personJson(row);
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`${out.slug}\t${out.display_name}\t${out.relationship_type ?? ''}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub list-people`: print every person ordered by slug (or emit JSON).
 * @param values - Parsed CLI flags.
 * @returns Process exit code (always 0; an empty list is valid output).
 */
export async function cmdListPeople(values: CliValues): Promise<number> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const rows = await hub.select().from(people).orderBy(people.slug).all();
    if (values.json) {
      console.log(JSON.stringify({ verb: 'list-people', count: rows.length, people: rows.map(personJson) }, null, 2));
    } else {
      for (const row of rows) {
        console.log(`${row.slug}\t${row.displayName}\t${row.relationshipType ?? ''}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

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

    const out: EditPersonStatus = { verb: 'edit-person', ...personJson(fresh) };
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

    // Resolve both rows up front in parallel (read-only, no ordering deps);
    // unknown slugs are usage errors before any write begins.
    const [from, into] = await Promise.all([
      hub.select().from(people).where(eq(people.slug, fromSlug)).get(),
      hub.select().from(people).where(eq(people.slug, intoSlug)).get(),
    ]);
    if (!from) {
      console.error(`hub merge-person: no person with slug "${fromSlug}"`);
      return 1;
    }
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
    const [channels, interactions_c, files_c, tasks_c, links] = await Promise.all([
      countChildRows(hub, contactChannels, from.id),
      countChildRows(hub, interactions, from.id),
      countChildRows(hub, files, from.id),
      countChildRows(hub, tasks, from.id),
      countPersonLinks(hub, from.id),
    ]);
    const moved: MergePersonStatus['moved'] = {
      channels,
      interactions: interactions_c,
      files: files_c,
      tasks: tasks_c,
      links,
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
