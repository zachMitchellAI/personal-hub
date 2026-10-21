// People verbs: add-person, get-person, list-people.
// These commands share the open→drizzle→close pattern (see core/db.ts) and map
// drizzle's camelCase rows onto the snake_case --json contract via personJson.
import { makeDrizzle, openDb } from '../core/db.ts';
import { people } from '../schema.ts';
import { deriveSlug, errorChainText } from '../core/util.ts';
import type { AddPersonValues, AddPersonStatus, CliValues, PersonJson } from '../core/types.ts';
import { eq } from 'drizzle-orm';

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
