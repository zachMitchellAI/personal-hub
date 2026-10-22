// Trackable verbs: add-trackable, set-trackable-status, list-trackables,
// add-trackable-event, list-trackable-events.
// S6 — processes-with-a-lifecycle as data (owner-generalized 2026-10-21).
// Mirrors the S4/S5 verb patterns: the DB CHECK on status is a backstop only
// (the CLI validates first against TRACKABLE_STATUSES), stage is free text
// (stages are data — no enum), and --date values pass through parseIsoDate
// (deterministic YYYY-MM-DD only). Events default their date to today,
// UTC-anchored, so "log what just happened" is one short command.
import { makeDrizzle, openDb } from '../core/db.ts';
import { trackableEvents, trackables } from '../schema.ts';
import { errorChainText, parseId, parseIsoDate, todayIso } from '../core/util.ts';
import { TRACKABLE_STATUSES } from '../core/constants.ts';
import type {
  AddTrackableEventStatus,
  AddTrackableEventValues,
  AddTrackableStatus,
  AddTrackableValues,
  ListTrackableEventsStatus,
  ListTrackablesStatus,
  ListTrackablesValues,
  SetTrackableStatusStatus,
  SetTrackableStatusValues,
  TrackableEventJson,
  TrackableJson,
} from '../core/types.ts';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Validate a trackable status against TRACKABLE_STATUSES (the DB CHECK's
 * CLI-side mirror). A bad --status is a friendly usage error, never a raw
 * CHECK-constraint crash.
 * @param raw - The raw --status value, possibly undefined.
 * @returns The validated status string, or null when missing/unknown.
 */
function parseTrackableStatus(raw: string | undefined): string | null {
  if (!raw) return null;
  return (TRACKABLE_STATUSES as readonly string[]).includes(raw) ? raw : null;
}

/**
 * Map a drizzle `trackables` row to the snake_case JSON contract. Explicit
 * mapping keeps the CLI contract (snake_case) separate from the database row
 * shape (camelCase).
 * @param row - A row selected from the `trackables` table.
 * @returns The JSON-contract trackable object for `--json` output.
 */
function trackableJson(row: typeof trackables.$inferSelect): TrackableJson {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    party: row.party,
    stage: row.stage,
    status: row.status,
    created_at: row.createdAt,
  };
}

/**
 * Map a drizzle `trackable_events` row to the snake_case JSON contract.
 * @param row - A row selected from the `trackable_events` table.
 * @returns The JSON-contract event object for `--json` output.
 */
function trackableEventJson(row: typeof trackableEvents.$inferSelect): TrackableEventJson {
  return {
    id: row.id,
    trackable_id: row.trackableId,
    event_date: row.eventDate,
    event_type: row.eventType,
    notes: row.notes,
  };
}

/**
 * `hub add-trackable`: insert a trackable. `--label` and `--kind` are
 * required (NOT NULL columns); `--party` is optional (a personal signup has
 * no company on the other side); `--stage` is free text defaulting to
 * "started" (stages are data — a custom stage persists without schema
 * change); `--status` defaults to "active".
 * @param values - Parsed CLI flags (see `AddTrackableValues`).
 * @returns Process exit code (0 = added, 1 = usage error).
 */
export async function cmdAddTrackable(values: AddTrackableValues): Promise<number> {
  // Required fields first, so usage errors never depend on optional-flag order.
  const label = values.label;
  const kind = values.kind;
  if (!label || !kind) {
    console.error(
      'hub add-trackable: usage: hub add-trackable --label <l> --kind <k> [--party <p>] [--stage <s>] [--status <active|closed>]',
    );
    return 1;
  }

  // Status: default "active"; anything outside TRACKABLE_STATUSES is a usage
  // error (the DB CHECK is a backstop, not the UX).
  const status = values.status ? parseTrackableStatus(values.status) : 'active';
  if (status === null) {
    console.error(`hub add-trackable: --status must be one of: ${TRACKABLE_STATUSES.join(', ')}`);
    return 1;
  }

  // Stage is free text — a custom stage like "team-fit-round-2" persists as
  // data (S6 acceptance scenario). Default "started" when omitted.
  const stage = values.stage ?? 'started';

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    try {
      const inserted = await hub
        .insert(trackables)
        .values({ label, kind, party: values.party ?? null, stage, status, createdAt: new Date().toISOString() })
        .returning({ id: trackables.id });
      const row = await hub.select().from(trackables).where(eq(trackables.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: AddTrackableStatus = { verb: 'add-trackable', ...trackableJson(row) };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(
          `added trackable ${row.id} "${row.label}" (kind ${row.kind}, stage ${row.stage}, status ${row.status})`,
        );
      }
      return 0;
    } catch (err: unknown) {
      // Drizzle wraps driver errors — match against the whole cause chain.
      // The only possible constraint failure here is the status CHECK
      // (no FKs on this table), which the CLI-side validation above should
      // have caught; treat it defensively anyway.
      const chain = errorChainText(err);
      if (/trackables_status_check/.test(chain)) {
        console.error(`hub add-trackable: --status must be one of: ${TRACKABLE_STATUSES.join(', ')}`);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub set-trackable-status`: change a trackable's status ("active" or
 * "closed"). Closure never touches events — history remains intact (S6
 * acceptance: no cascade delete of history on closure).
 * @param values - Parsed CLI flags; `status` is required.
 * @param idArg - First positional argument: the trackable id (positive integer).
 * @returns Process exit code (0 = updated, 1 = usage/unknown trackable).
 */
export async function cmdSetTrackableStatus(values: SetTrackableStatusValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub set-trackable-status: trackable id argument required');
    return 1;
  }
  const status = parseTrackableStatus(values.status);
  if (!status) {
    console.error(
      `hub set-trackable-status: --status is required and must be one of: ${TRACKABLE_STATUSES.join(', ')}`,
    );
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const row = await hub.select().from(trackables).where(eq(trackables.id, id)).get();
    if (!row) {
      console.error(`hub set-trackable-status: no trackable with id ${id}`);
      return 1;
    }
    await hub.update(trackables).set({ status }).where(eq(trackables.id, id)).run();

    const out: SetTrackableStatusStatus = { verb: 'set-trackable-status', id, status };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`trackable ${id} (${row.label}) status → ${status}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub list-trackables`: list trackables ordered by id. Filters combine:
 * --kind <k> (exact match), --status <active|closed>, --party <p> (exact
 * match). An empty result is valid output, not an error.
 * @param values - Parsed CLI flags (see `ListTrackablesValues`).
 * @returns Process exit code (always 0 unless a filter is invalid).
 */
export async function cmdListTrackables(values: ListTrackablesValues): Promise<number> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Accumulate filters, then AND them; an empty list means no WHERE clause.
    const conditions = [];
    let statusFilter: string | null = null;
    if (values.kind) {
      conditions.push(eq(trackables.kind, values.kind));
    }
    if (values.status) {
      statusFilter = parseTrackableStatus(values.status);
      if (!statusFilter) {
        console.error(`hub list-trackables: --status must be one of: ${TRACKABLE_STATUSES.join(', ')}`);
        return 1;
      }
      conditions.push(eq(trackables.status, statusFilter));
    }
    if (values.party) {
      conditions.push(eq(trackables.party, values.party));
    }

    const rows = await hub
      .select()
      .from(trackables)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(trackables.id)
      .all();

    const outRows: TrackableJson[] = rows.map(trackableJson);
    const out: ListTrackablesStatus = {
      verb: 'list-trackables',
      count: outRows.length,
      status: statusFilter,
      trackables: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const t of outRows) {
        console.log(`${t.id}\t${t.status}\t${t.kind}\t${t.stage}\t${t.party ?? '-'}\t${t.label}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub add-trackable-event`: append an event to a trackable's trail.
 * `--type` is required (free text); `--date` is optional and defaults to
 * today (UTC-anchored); `--notes` is optional free text. The trackable must
 * exist. Closing a trackable does not block logging late events — history
 * stays honest.
 * @param values - Parsed CLI flags (see `AddTrackableEventValues`).
 * @param idArg - First positional argument: the trackable id (positive integer).
 * @returns Process exit code (0 = added, 1 = usage/unknown trackable).
 */
export async function cmdAddTrackableEvent(values: AddTrackableEventValues, idArg?: string): Promise<number> {
  const trackableId = parseId(idArg);
  if (trackableId === null) {
    console.error('hub add-trackable-event: trackable id argument required');
    return 1;
  }
  const eventType = values.type;
  if (!eventType) {
    console.error('hub add-trackable-event: --type is required (free text, e.g. "thank-you note sent")');
    return 1;
  }

  // Deterministic dates only; default to today when omitted.
  let eventDate = todayIso();
  if (values.date) {
    const isoDate = parseIsoDate(values.date);
    if (!isoDate) {
      console.error(`hub add-trackable-event: --date must be an ISO date (YYYY-MM-DD), got "${values.date}"`);
      return 1;
    }
    eventDate = isoDate;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const trackable = await hub.select().from(trackables).where(eq(trackables.id, trackableId)).get();
    if (!trackable) {
      console.error(`hub add-trackable-event: no trackable with id ${trackableId}`);
      return 1;
    }

    try {
      const inserted = await hub
        .insert(trackableEvents)
        .values({ trackableId, eventDate, eventType, notes: values.notes ?? null })
        .returning({ id: trackableEvents.id });
      const row = await hub.select().from(trackableEvents).where(eq(trackableEvents.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: AddTrackableEventStatus = { verb: 'add-trackable-event', ...trackableEventJson(row) };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`added event ${row.id} to trackable ${trackableId} (${row.eventDate}, ${row.eventType})`);
      }
      return 0;
    } catch (err: unknown) {
      // Drizzle wraps driver errors — match against the whole cause chain.
      // The trackable could have been deleted between lookup and insert.
      const chain = errorChainText(err);
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error(`hub add-trackable-event: trackable_id ${trackableId} no longer exists`);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub list-trackable-events`: one trackable's event trail, ordered by
 * event_date ascending then id ascending (oldest first — a trail reads
 * chronologically, unlike interactions which list newest-first). The
 * trackable must exist; an empty trail is valid output, not an error.
 * @param values - Parsed CLI flags.
 * @param idArg - First positional argument: the trackable id (positive integer).
 * @returns Process exit code (0 = listed, 1 = usage/unknown trackable).
 */
export async function cmdListTrackableEvents(values: ListTrackablesValues, idArg?: string): Promise<number> {
  const trackableId = parseId(idArg);
  if (trackableId === null) {
    console.error('hub list-trackable-events: trackable id argument required');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const trackable = await hub.select().from(trackables).where(eq(trackables.id, trackableId)).get();
    if (!trackable) {
      console.error(`hub list-trackable-events: no trackable with id ${trackableId}`);
      return 1;
    }

    const rows = await hub
      .select()
      .from(trackableEvents)
      // Chronological order: oldest event first; id ascending breaks
      // same-day ties deterministically in insertion order.
      .where(eq(trackableEvents.trackableId, trackableId))
      .orderBy(asc(trackableEvents.eventDate), asc(trackableEvents.id))
      .all();

    const outRows: TrackableEventJson[] = rows.map(trackableEventJson);
    const out: ListTrackableEventsStatus = {
      verb: 'list-trackable-events',
      trackable_id: trackableId,
      count: outRows.length,
      events: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `trackable ${trackableId} (${trackable.label}, stage ${trackable.stage}, status ${trackable.status}):`,
      );
      for (const e of outRows) {
        console.log(`  ${e.id}\t${e.event_date}\t${e.event_type}${e.notes ? `\t${e.notes}` : ''}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
