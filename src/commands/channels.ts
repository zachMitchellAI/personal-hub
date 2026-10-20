// Channel verbs: add-channel, list-channels, remove-channel, set-primary.
// S3 — contact_channels. kind/value are data (no enum, no validation beyond
// required-ness). At most one primary per (person, kind) is enforced HERE, in
// the CLI write path: demote-then-set inside a single transaction. The proxy
// callbacks are synchronous, so awaited drizzle ops run inside the open tx.
import { makeDrizzle, openDb } from '../core/db.ts';
import { contactChannels, people } from '../schema.ts';
import { errorChainText, parseChannelId } from '../core/util.ts';
import type { HubDb } from '../core/db.ts';
import type { AddChannelStatus, ChannelJson, ListChannelsStatus, RemoveChannelStatus, SetPrimaryStatus } from '../core/types.ts';
import { and, eq } from 'drizzle-orm';

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

function demotePrimaries(d1: HubDb, personId: number, kind: string): Promise<unknown> {
  return d1
    .update(contactChannels)
    .set({ primaryFlag: 0 })
    .where(
      and(
        eq(contactChannels.personId, personId),
        eq(contactChannels.kind, kind),
        eq(contactChannels.primaryFlag, 1),
      ),
    )
    .run();
}

export async function cmdAddChannel(
  values: CliValues,
  slugArg?: string,
): Promise<number> {
  const kind = values.kind as string | undefined;
  const value = values.value as string | undefined;
  if (!slugArg || !kind || !value) {
    console.error('hub add-channel: usage: hub add-channel <slug> --kind <k> --value <v>');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const d1 = makeDrizzle(db);
    const person = await d1.select().from(people).where(eq(people.slug, slugArg)).get();
    if (!person) {
      console.error(`hub add-channel: no person with slug "${slugArg}"`);
      return 1;
    }

    const source = (values.source as string | undefined) ?? null;
    const wantsPrimary = values.primary === true;

    db.exec('BEGIN');
    let row: typeof contactChannels.$inferSelect;
    try {
      if (wantsPrimary) {
        await demotePrimaries(d1, person.id, kind);
      }
      const inserted = await d1
        .insert(contactChannels)
        .values({
          personId: person.id,
          kind,
          value,
          primaryFlag: wantsPrimary ? 1 : 0,
          source,
        })
        .returning({ id: contactChannels.id });
      const fresh = await d1.select().from(contactChannels).where(eq(contactChannels.id, inserted[0].id)).get();
      if (!fresh) throw new Error('insert vanished — returned id not found');
      row = fresh;
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      const chain = errorChainText(err);
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

export async function cmdListChannels(
  values: CliValues,
  slugArg?: string,
): Promise<number> {
  if (!slugArg) {
    console.error('hub list-channels: slug argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const d1 = makeDrizzle(db);
    const person = await d1.select().from(people).where(eq(people.slug, slugArg)).get();
    if (!person) {
      console.error(`hub list-channels: no person with slug "${slugArg}"`);
      return 1;
    }
    const rows = await d1
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
        console.log(
          `${row.id}\t${row.kind}\t${row.value}\t${row.primaryFlag ? 'primary' : ''}\t${row.source ?? ''}`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

export async function cmdRemoveChannel(
  values: CliValues,
  idArg?: string,
): Promise<number> {
  const id = parseChannelId(idArg);
  if (id === null) {
    console.error('hub remove-channel: channel id argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const d1 = makeDrizzle(db);
    const row = await d1.select().from(contactChannels).where(eq(contactChannels.id, id)).get();
    if (!row) {
      console.error(`hub remove-channel: no channel with id ${id}`);
      return 1;
    }
    await d1.delete(contactChannels).where(eq(contactChannels.id, id)).run();
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

export async function cmdSetPrimary(
  values: CliValues,
  idArg?: string,
): Promise<number> {
  const id = parseChannelId(idArg);
  if (id === null) {
    console.error('hub set-primary: channel id argument required');
    return 1;
  }
  const { db } = openDb(values.db as string | undefined);
  try {
    const d1 = makeDrizzle(db);
    const row = await d1.select().from(contactChannels).where(eq(contactChannels.id, id)).get();
    if (!row) {
      console.error(`hub set-primary: no channel with id ${id}`);
      return 1;
    }
    const person = await d1.select().from(people).where(eq(people.id, row.personId)).get();

    // The one-primary-per-(person, kind) rule lives here, not in the DB:
    // demote every other primary of the same (person, kind), then promote
    // this row — atomically.
    db.exec('BEGIN');
    try {
      await demotePrimaries(d1, row.personId, row.kind);
      await d1.update(contactChannels).set({ primaryFlag: 1 }).where(eq(contactChannels.id, id)).run();
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