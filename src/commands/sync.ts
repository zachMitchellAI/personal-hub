// Sync verbs: log-sync, list-sync-log. S7 — the one-way sync ledger
// (DECISIONS #13: hub → Trello only, so "out" dominates; "in" exists for
// future importers). Trello sync execution itself is out of S7 scope — these
// verbs are the ledger the sync script will call, which is why the
// idempotency contract lives here and is testable without any adapter.
// The idempotency contract is a DB-level UNIQUE index (sync_log_idempotency)
// over the business identity of a sync action — (adapter, direction, entity,
// entity_id, action) — with the CLI catching the violation and treating it
// as a successful no-op: re-running a sync that already logged its actions
// adds no rows and exits 0. ts/detail are outside the key on purpose: a
// re-log never rewrites history (first log wins).
import { makeDrizzle, openDb } from '../core/db.ts';
import { syncLog } from '../schema.ts';
import { errorChainText, parseId } from '../core/util.ts';
import { SYNC_DIRECTIONS } from '../core/constants.ts';
import type { ListSyncLogStatus, LogSyncStatus, LogSyncValues, ListSyncLogValues, SyncLogJson } from '../core/types.ts';
import { and, asc, eq } from 'drizzle-orm';

/**
 * Validate a sync direction against SYNC_DIRECTIONS (in/out). A bad
 * --direction is a friendly usage error, not a permanently mislabelled
 * ledger row (the DB has no CHECK — the ticket did not request one).
 * @param raw - The raw --direction value, possibly undefined.
 * @returns The validated direction string, or null when missing/unknown.
 */
function parseDirection(raw: string | undefined): string | null {
  if (!raw) return null;
  return (SYNC_DIRECTIONS as readonly string[]).includes(raw) ? raw : null;
}

/**
 * Map a drizzle `sync_log` row to the snake_case JSON contract. Explicit
 * mapping keeps the CLI contract (snake_case) separate from the database row
 * shape (camelCase).
 * @param row - A row selected from the `sync_log` table.
 * @returns The JSON-contract sync-log entry object for `--json` output.
 */
function syncLogJson(row: typeof syncLog.$inferSelect): SyncLogJson {
  return {
    id: row.id,
    direction: row.direction,
    adapter: row.adapter,
    entity: row.entity,
    entity_id: row.entityId,
    action: row.action,
    ts: row.ts,
    detail: row.detail,
  };
}

/**
 * `hub log-sync`: record one sync action in the ledger. `--entity`,
 * `--entity-id`, and `--action` are required; `--direction` defaults to
 * "out" (validated against SYNC_DIRECTIONS); `--adapter` defaults to
 * "trello-cli"; `--detail` is optional free text. Logging the same
 * (adapter, direction, entity, entity_id, action) again is IDEMPOTENT per
 * the S7 contract: no new row, the existing entry echoed with
 * `logged: false`, exit 0.
 * @param values - Parsed CLI flags (see `LogSyncValues`).
 * @returns Process exit code (0 = logged or idempotent no-op, 1 = usage error).
 */
export async function cmdLogSync(values: LogSyncValues): Promise<number> {
  // Required fields first, so usage errors never depend on optional-flag order.
  const entity = values.entity;
  const action = values.action;
  const entityId = parseId(values['entity-id']);
  if (!entity || !action || entityId === null) {
    console.error(
      'hub log-sync: usage: hub log-sync --entity <e> --entity-id <id> --action <a> [--direction <in|out>] [--adapter <a>] [--detail <d>]',
    );
    return 1;
  }

  // Direction: default "out"; anything outside SYNC_DIRECTIONS is a usage error.
  const direction = values.direction ? parseDirection(values.direction) : 'out';
  if (direction === null) {
    console.error(`hub log-sync: --direction must be one of: ${SYNC_DIRECTIONS.join(', ')}`);
    return 1;
  }
  // Adapter defaults to the only engine that exists today; free text so
  // future adapters need no schema change (kinds are data, DESIGN.md D3).
  const adapter = values.adapter ?? 'trello-cli';

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    try {
      const inserted = await hub
        .insert(syncLog)
        .values({
          direction,
          adapter,
          entity,
          entityId,
          action,
          ts: new Date().toISOString(),
          detail: values.detail ?? null,
        })
        .returning({ id: syncLog.id });
      const row = await hub.select().from(syncLog).where(eq(syncLog.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: LogSyncStatus = { verb: 'log-sync', logged: true, ...syncLogJson(row) };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`logged sync ${row.id} ${direction} ${entity} ${row.entityId} (${row.action}, ${row.adapter})`);
      }
      return 0;
    } catch (err: unknown) {
      // Idempotency contract: the (adapter, direction, entity, entity_id,
      // action) identity already exists → echo the existing row unchanged
      // (first log wins) and exit 0. Drizzle wraps driver errors, so match
      // the whole cause chain — the violation can surface either as the
      // index name or as the column list.
      const chain = errorChainText(err);
      if (/sync_log_idempotency/.test(chain) || (/UNIQUE constraint failed/.test(chain) && /sync_log\./.test(chain))) {
        const existing = await hub
          .select()
          .from(syncLog)
          .where(
            and(
              eq(syncLog.adapter, adapter),
              eq(syncLog.direction, direction),
              eq(syncLog.entity, entity),
              eq(syncLog.entityId, entityId),
              eq(syncLog.action, action),
            ),
          )
          .get();
        if (!existing) throw err; // Should not happen — the index key identifies the row.
        const out: LogSyncStatus = { verb: 'log-sync', logged: false, ...syncLogJson(existing) };
        if (values.json) {
          console.log(JSON.stringify(out, null, 2));
        } else {
          console.log(`already logged (sync ${existing.id}) — no new row`);
        }
        return 0;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub list-sync-log`: list the ledger oldest first (ts ascending, ties by
 * id — a ledger reads chronologically, like a trackable's event trail).
 * Filters combine: --adapter <a>, --direction <in|out>, --entity <e>.
 * An empty result is valid output, not an error.
 * @param values - Parsed CLI flags (see `ListSyncLogValues`).
 * @returns Process exit code (always 0 unless a filter is invalid).
 */
export async function cmdListSyncLog(values: ListSyncLogValues): Promise<number> {
  // Direction filter, when given, is validated so a typo is a usage error
  // rather than a silently empty list.
  let directionFilter: string | null = null;
  if (values.direction) {
    directionFilter = parseDirection(values.direction);
    if (!directionFilter) {
      console.error(`hub list-sync-log: --direction must be one of: ${SYNC_DIRECTIONS.join(', ')}`);
      return 1;
    }
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Accumulate filters, then AND them; an empty list means no WHERE clause.
    const conditions = [];
    if (values.adapter) conditions.push(eq(syncLog.adapter, values.adapter));
    if (directionFilter) conditions.push(eq(syncLog.direction, directionFilter));
    if (values.entity) conditions.push(eq(syncLog.entity, values.entity));

    const rows = await hub
      .select()
      .from(syncLog)
      .where(conditions.length ? and(...conditions) : undefined)
      // Chronological order: oldest entry first; id ascending breaks
      // same-timestamp ties deterministically in insertion order.
      .orderBy(asc(syncLog.ts), asc(syncLog.id))
      .all();

    const outRows: SyncLogJson[] = rows.map(syncLogJson);
    const out: ListSyncLogStatus = {
      verb: 'list-sync-log',
      count: outRows.length,
      adapter: values.adapter ?? null,
      direction: directionFilter,
      entity: values.entity ?? null,
      entries: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const e of outRows) {
        console.log(
          `${e.id}\t${e.ts}\t${e.direction}\t${e.adapter}\t${e.entity}\t${e.entity_id}\t${e.action}${e.detail ? `\t${e.detail}` : ''}`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
