// Channel verbs: add-channel, list-channels, remove-channel, set-primary.
// S3 — contact_channels. kind/value are data (no enum, no validation beyond
// required-ness). At most one primary per (person, kind) is enforced HERE, in
// the CLI write path: demote-then-set inside a single transaction. The proxy
// callbacks are synchronous, so awaited drizzle ops run inside the open tx.
import { makeDrizzle, openDb } from '../core/db.ts';
import { contactChannels, people } from '../schema.ts';
import { errorChainText, parseId } from '../core/util.ts';
import type { HubDb } from '../core/db.ts';
import type {
  AddChannelStatus,
  ChannelJson,
  CliValues,
  ListChannelsStatus,
  RemoveChannelStatus,
  SetPrimaryStatus,
} from '../core/types.ts';
import { and, eq } from 'drizzle-orm';

/**
 * Map a drizzle `contact_channels` row to the snake_case JSON contract.
 * Explicit mapping keeps the CLI contract (snake_case) separate from the
 * database row shape (camelCase); do not serialize drizzle rows raw.
 * @param row - A row selected from the `contact_channels` table.
 * @returns The JSON-contract channel object for `--json` output.
 */
export function channelJson(row: typeof contactChannels.$inferSelect): ChannelJson {
  return {
    id: row.id,
    person_id: row.personId,
    kind: row.kind,
    value: row.value,
    primary_flag: row.primaryFlag,
    source: row.source,
  };
}

/**
 * Demote every currently-primary channel of one (person, kind) pair — the
 * first half of the demote-then-set transaction that enforces the S3
 * at-most-one-primary rule in the write path.
 * @param hub - Typed drizzle handle (must run inside the caller's transaction).
 * @param personId - Owner's database id.
 * @param kind - Channel kind whose primary is being demoted.
 * @returns The raw drizzle update result (rows changed, not inspected).
 */
function demotePrimaries(hub: HubDb, personId: number, kind: string): Promise<unknown> {
  return hub
    .update(contactChannels)
    .set({ primaryFlag: 0 })
    .where(
      and(eq(contactChannels.personId, personId), eq(contactChannels.kind, kind), eq(contactChannels.primaryFlag, 1)),
    )
    .run();
}

/**
 * `hub add-channel`: attach a channel to a person (and optionally make it
 * primary). The slug must resolve to an existing person; kind/value are
 * free text — the schema imposes no enum.
 * @param values - Parsed CLI flags (`--kind`, `--value`, `--source`, `--primary`).
 * @param slugArg - First positional argument: the person's slug.
 * @returns Process exit code (0 = added, 1 = usage/lookup/foreign-key error).
 */
export async function cmdAddChannel(values: CliValues, slugArg?: string): Promise<number> {
  // All three are required: the person (positional) and both channel fields.
  const kind = values.kind as string | undefined;
  const value = values.value as string | undefined;
  if (!slugArg || !kind || !value) {
    console.error('hub add-channel: usage: hub add-channel <slug> --kind <k> --value <v>');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    // Resolve the person first — we need its id for the FK and its slug for output.
    const person = await hub.select().from(people).where(eq(people.slug, slugArg)).get();
    if (!person) {
      console.error(`hub add-channel: no person with slug "${slugArg}"`);
      return 1;
    }

    const source = (values.source as string | undefined) ?? null;
    const wantsPrimary = values.primary === true;

    // Insert + demote-then-set run in one transaction so a failure can never
    // leave two primaries (or a demoted primary with nothing promoted).
    db.exec('BEGIN');
    let row: typeof contactChannels.$inferSelect;
    try {
      if (wantsPrimary) {
        await demotePrimaries(hub, person.id, kind);
      }
      const inserted = await hub
        .insert(contactChannels)
        .values({
          personId: person.id,
          kind,
          value,
          primaryFlag: wantsPrimary ? 1 : 0,
          source,
        })
        .returning({ id: contactChannels.id });
      // Re-select to get the full row (drizzle .returning() here is partial);
      // the delete below proves the id actually materialized.
      const fresh = await hub.select().from(contactChannels).where(eq(contactChannels.id, inserted[0].id)).get();
      if (!fresh) throw new Error('insert vanished — returned id not found');
      row = fresh;
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      const chain = errorChainText(err);
      // The person could have been deleted concurrently between lookup and insert.
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error(`hub add-channel: person_id ${person.id} no longer exists`);
        return 1;
      }
      throw err;
    }

    const status: AddChannelStatus = {
      verb: 'add-channel',
      id: row.id,
      person_id: row.personId,
      slug: person.slug,
      kind: row.kind,
      value: row.value,
      primary_flag: row.primaryFlag,
      source: row.source,
    };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(
        `added channel ${row.kind} "${row.value}" for ${person.slug} (id ${row.id})${row.primaryFlag ? ' [primary]' : ''}`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub list-channels`: print one person's channels ordered by (kind, id).
 * @param values - Parsed CLI flags.
 * @param slugArg - First positional argument: the person's slug.
 * @returns Process exit code (0 = found — empty list is valid, 1 = missing/unknown slug).
 */
export async function cmdListChannels(values: CliValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub list-channels: slug argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const person = await hub.select().from(people).where(eq(people.slug, slugArg)).get();
    if (!person) {
      console.error(`hub list-channels: no person with slug "${slugArg}"`);
      return 1;
    }
    const rows = await hub
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.personId, person.id))
      .orderBy(contactChannels.kind, contactChannels.id)
      .all();
    const status: ListChannelsStatus = {
      verb: 'list-channels',
      slug: person.slug,
      person_id: person.id,
      count: rows.length,
      channels: rows.map(channelJson),
    };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      for (const row of rows) {
        console.log(`${row.id}\t${row.kind}\t${row.value}\t${row.primaryFlag ? 'primary' : ''}\t${row.source ?? ''}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub remove-channel`: delete one channel by id (people cascade is the only
 * other removal path — freeform SQL is read-only).
 * @param values - Parsed CLI flags.
 * @param idArg - First positional argument: the channel id (positive integer).
 * @returns Process exit code (0 = removed, 1 = usage/unknown id).
 */
export async function cmdRemoveChannel(values: CliValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub remove-channel: channel id argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(contactChannels).where(eq(contactChannels.id, id)).get();
    if (!row) {
      console.error(`hub remove-channel: no channel with id ${id}`);
      return 1;
    }
    await hub.delete(contactChannels).where(eq(contactChannels.id, id)).run();
    const status: RemoveChannelStatus = { verb: 'remove-channel', id, removed: true };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`removed channel ${id} (${row.kind} "${row.value}")`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub set-primary`: make one channel the primary for its (person, kind).
 * Enforces the S3 rule transactionally: demote any existing primary of the
 * same (person, kind), then promote this row — atomically.
 * @param values - Parsed CLI flags.
 * @param idArg - First positional argument: the channel id (positive integer).
 * @returns Process exit code (0 = promoted, 1 = usage/unknown id).
 */
export async function cmdSetPrimary(values: CliValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub set-primary: channel id argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(contactChannels).where(eq(contactChannels.id, id)).get();
    if (!row) {
      console.error(`hub set-primary: no channel with id ${id}`);
      return 1;
    }
    const person = await hub.select().from(people).where(eq(people.id, row.personId)).get();

    // The one-primary-per-(person, kind) rule lives here, not in the DB:
    // demote every other primary of the same (person, kind), then promote
    // this row — atomically.
    db.exec('BEGIN');
    try {
      await demotePrimaries(hub, row.personId, row.kind);
      await hub.update(contactChannels).set({ primaryFlag: 1 }).where(eq(contactChannels.id, id)).run();
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }

    const status: SetPrimaryStatus = {
      verb: 'set-primary',
      id: row.id,
      person_id: row.personId,
      slug: person?.slug ?? '',
      kind: row.kind,
      primary_flag: 1,
    };
    if (values.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(`channel ${row.id} (${row.kind} "${row.value}") is now primary for ${status.slug}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
