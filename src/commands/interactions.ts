// Interaction verbs: add-interaction, list-interactions.
// S5 — the person history log (stories/epic-schema.md S5). Mirrors the S4
// task-verb patterns: required-ness is validated CLI-side before the DB ever
// sees it, `--person` resolves a slug to a clean usage error (never an FK
// crash), and dates pass through the same parseIsoDate rule as tasks
// (deterministic YYYY-MM-DD only). The last-N-days window is computed
// UTC-anchored so "today" is stable regardless of host timezone.
import { makeDrizzle, openDb } from '../core/db.ts';
import { interactions, people } from '../schema.ts';
import { errorChainText, minusDays, parseIsoDate, todayIso } from '../core/util.ts';
import type {
  AddInteractionStatus,
  AddInteractionValues,
  InteractionJson,
  ListInteractionsStatus,
  ListInteractionsValues,
} from '../core/types.ts';
import { and, desc, eq, gte } from 'drizzle-orm';

/**
 * Map a drizzle `interactions` row to the snake_case JSON contract. Explicit
 * mapping keeps the CLI contract (snake_case) separate from the database row
 * shape (camelCase).
 * @param row - A row selected from the `interactions` table.
 * @returns The JSON-contract interaction object for `--json` output.
 */
function interactionJson(row: typeof interactions.$inferSelect): InteractionJson {
  return {
    id: row.id,
    person_id: row.personId,
    kind: row.kind,
    date: row.date,
    channel: row.channel,
    summary: row.summary,
    created_at: row.createdAt,
  };
}

/**
 * `hub add-interaction`: log an interaction. `--kind`, `--date`, `--channel`,
 * and `--summary` are required (NOT NULL columns per S5); `--date` must be a
 * deterministic ISO date (YYYY-MM-DD); `--person` optionally links a person
 * by slug (people-less interactions are valid per the ticket). No defaults:
 * an interaction's metadata is exactly what the caller states.
 * @param values - Parsed CLI flags (see `AddInteractionValues`).
 * @returns Process exit code (0 = added, 1 = usage/lookup/date error).
 */
export async function cmdAddInteraction(values: AddInteractionValues): Promise<number> {
  // Required fields first, so usage errors never depend on optional-flag order.
  const kind = values.kind;
  const date = values.date;
  const channel = values.channel;
  const summary = values.summary;
  if (!kind || !date || !channel || !summary) {
    console.error(
      'hub add-interaction: usage: hub add-interaction --kind <k> --date <YYYY-MM-DD> --channel <c> --summary <s> [--person <slug>]',
    );
    return 1;
  }

  // Deterministic dates only — "next friday" never parses (same rule as
  // tasks --due-date).
  const isoDate = parseIsoDate(date);
  if (!isoDate) {
    console.error(`hub add-interaction: --date must be an ISO date (YYYY-MM-DD), got "${date}"`);
    return 1;
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
        console.error(`hub add-interaction: no person with slug "${values.person}"`);
        return 1;
      }
      personId = person.id;
    }

    try {
      const inserted = await hub
        .insert(interactions)
        .values({ personId, kind, date: isoDate, channel, summary, createdAt: new Date().toISOString() })
        .returning({ id: interactions.id });
      const row = await hub.select().from(interactions).where(eq(interactions.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: AddInteractionStatus = { verb: 'add-interaction', ...interactionJson(row) };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`added interaction ${row.id} (${row.kind}, ${row.date}, ${row.channel})`);
      }
      return 0;
    } catch (err: unknown) {
      // Drizzle wraps driver errors — match against the whole cause chain.
      // The person could have been deleted between lookup and insert.
      const chain = errorChainText(err);
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error(`hub add-interaction: person_id ${personId} no longer exists`);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub list-interactions`: list interactions ordered by date descending
 * (newest first; ties broken by id descending so same-day rows stay
 * deterministic in insertion order). Filters combine: --person <slug>,
 * --kind <k> (exact match), --days <n> (last N calendar days, UTC-anchored),
 * --since <date> (date >= this day). An empty result is valid output, not an
 * error.
 * @param values - Parsed CLI flags (see `ListInteractionsValues`).
 * @returns Process exit code (always 0 unless a filter is invalid).
 */
export async function cmdListInteractions(values: ListInteractionsValues): Promise<number> {
  // Parse the window filters before opening the DB so usage errors never
  // depend on database state.
  let days: number | null = null;
  if (values.days !== undefined) {
    const n = Number(values.days);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`hub list-interactions: --days must be a positive integer, got "${values.days}"`);
      return 1;
    }
    days = n;
  }
  let since: string | null = null;
  if (values.since) {
    since = parseIsoDate(values.since);
    if (!since) {
      console.error(`hub list-interactions: --since must be an ISO date (YYYY-MM-DD), got "${values.since}"`);
      return 1;
    }
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Accumulate filters, then AND them; an empty list means no WHERE clause.
    const conditions = [];
    if (values.kind) {
      conditions.push(eq(interactions.kind, values.kind));
    }
    if (days !== null) {
      // "Last 7 days" = date >= today − 7 days, UTC-anchored.
      conditions.push(gte(interactions.date, minusDays(todayIso(), days)));
    }
    if (since) {
      conditions.push(gte(interactions.date, since));
    }
    if (values.person) {
      const person = await hub.select().from(people).where(eq(people.slug, values.person)).get();
      if (!person) {
        console.error(`hub list-interactions: no person with slug "${values.person}"`);
        return 1;
      }
      conditions.push(eq(interactions.personId, person.id));
    }

    const rows = await hub
      .select()
      .from(interactions)
      .where(conditions.length ? and(...conditions) : undefined)
      // Newest first (S5 acceptance: ordered by date descending); id
      // descending breaks same-date ties deterministically.
      .orderBy(desc(interactions.date), desc(interactions.id))
      .all();

    const outRows: InteractionJson[] = rows.map(interactionJson);
    const out: ListInteractionsStatus = {
      verb: 'list-interactions',
      count: outRows.length,
      days,
      since,
      interactions: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const r of outRows) {
        console.log(`${r.id}\t${r.date}\t${r.kind}\t${r.person_id ?? '-'}\t${r.channel}\t${r.summary}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
