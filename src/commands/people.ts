// People verbs: add-person, get-person, list-people.
import { makeDrizzle, openDb } from '../core/db.ts';
import { people } from '../schema.ts';
import { deriveSlug, errorChainText } from '../core/util.ts';
import type { AddPersonStatus, CliValues, PersonJson } from '../core/types.ts';
import { eq } from 'drizzle-orm';

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

export async function cmdAddPerson(values: CliValues): Promise<number> {
  const name = values.name as string | undefined;
  if (!name) {
    console.error('hub add-person: --name is required');
    return 1;
  }
  const slug = values.slug ? deriveSlug(values.slug as string) : deriveSlug(name);
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
    const d1 = makeDrizzle(db);
    const [row] = await d1
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

export async function cmdGetPerson(values: CliValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub get-person: slug argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const d1 = makeDrizzle(db);
    const row = await d1.select().from(people).where(eq(people.slug, slugArg)).get();
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

export async function cmdListPeople(values: CliValues): Promise<number> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const d1 = makeDrizzle(db);
    const rows = await d1.select().from(people).orderBy(people.slug).all();
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