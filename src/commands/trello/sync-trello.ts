// sync-trello: the S11 one-way adapter flow (stories/ticket-s11-trello-adapter.md).
// Hub is the source of truth; Trello is an interface (DECISIONS #13). The verb
// PLANs by diffing the mirror set (tasks.trello_visible=1 AND status in
// ready/in-progress — the same AND-composed query list-tasks --mirror runs)
// against the live cards on the configured board's three lists, then applies
// or (default) just prints that plan. Every executed action writes its
// task_trello mapping row and one sync_log row through the cmdLogSync
// idempotent path, so a re-run that redoes nothing adds no ledger rows.
//
// Plan rules (ticket step 5, owner vetoes approved as-is):
// - mirrored task without a card            → create  [hub-id] title
// - mirrored task with a drifted card       → update (title/desc/due) and/or
//                                             move (status→list mismatch)
// - mapping row whose card vanished         → re-create (card archived out-of-band)
// - live card tagged [hub-N] with no row    → adopt the mapping from the tag
// - card exists, task left the mirror set   → archive; a "completed" task is
//                                             moved to the Done list first in
//                                             the same run (one ledger row,
//                                             detail carries {list: done})
// - untagged cards                          → NEVER TOUCHED (owner's manual
//                                             cards keep their own lifecycle)
// - two tasks claiming the same card id     → reported conflict, nothing
//                                             applied for that card
import { makeDrizzle, openDb, type HubDb } from '../../core/db.ts';
import { syncLog, taskTrello, tasks } from '../../schema.ts';
import { errorChainText, parseId } from '../../core/util.ts';
import { loadHubConfig, type HubJsonConfig, type TrelloConfig } from '../../core/config.ts';
import type { CliValues, SyncLogJson } from '../../core/types.ts';
import { TrelloCliEngine, type TrelloCard, type TrelloEngine } from './engine.ts';
import { and, eq, inArray } from 'drizzle-orm';

/** The regex parsing the hub's identity tag back out of a live card title (ticket step 4). */
const HUB_PREFIX_RE = /^\[hub-(\d+)\]\s*/;

/** The status→list-role mapping (ticket's Status mapping section). */
const STATUS_TO_LIST: Record<string, 'ready' | 'in-progress' | 'done'> = {
  ready: 'ready',
  'in-progress': 'in-progress',
  completed: 'done',
};

/** One planned action: what would change, for which task/card, and why. */
export interface PlanAction {
  /** create | update | move | re-create | adopt | archive | conflict */
  action: string;
  /** The hub task the action belongs to (null for a conflict against a
   * live card no valid task owns). */
  taskId: number | null;
  /** The card id involved, when one exists live/mapped. */
  cardId: string | null;
  /** Target list role (create/move/archive-with-move). */
  list?: 'ready' | 'in-progress' | 'done';
  /** Human-readable one-liner for plan output. */
  summary: string;
}

/** The full plan one sync run produces (also the --json contract). */
export interface SyncPlan {
  /** False on config problems (the verb exits 1 with a hint instead). */
  ok: boolean;
  /** true when --apply ran; false for the default dry-run. */
  applied: boolean;
  /** Which engine cache sync was skipped (--skip-cache-sync). */
  skippedCacheSync: boolean;
  /** How many rows the --mirror query served. */
  mirrorCount: number;
  /** Cards seen live across the three configured lists (incl. unowned). */
  liveCount: number;
  /** The planned/executed actions, in plan order. */
  actions: PlanAction[];
}

/** Live card enriched with the hub tag parsed out of its title (null when untagged). */
interface OwnedCard {
  card: TrelloCard;
  /** The [hub-N] tag value, or null for an untagged card. */
  taskId: number | null;
  /** Which configured list the card was seen in. */
  list: 'ready' | 'in-progress' | 'done';
}

/**
 * Load + complete-check the trello config block. Missing/incomplete → exit 1
 * with a trello-config hint (ticket step 1): sync never guesses a board or
 * list, because applying to the wrong board would orphan real cards.
 * @param cfg - The loaded hub config file object.
 * @returns The complete trello block, or null with the field list missing.
 */
function completeTrelloConfig(cfg: HubJsonConfig): { trello: TrelloConfig } | { missing: string[] } {
  const trello = cfg.trello;
  const missing: string[] = [];
  if (!trello) return { missing: ['--board', '--list-ready', '--list-in-progress', '--list-done'] };
  if (!trello.board) missing.push('--board');
  if (!trello.lists?.ready) missing.push('--list-ready');
  if (!trello.lists?.['in-progress']) missing.push('--list-in-progress');
  if (!trello.lists?.done) missing.push('--list-done');
  if (missing.length) return { missing };
  return {
    trello: { enginePath: trello.enginePath || 'trello', board: trello.board, lists: trello.lists },
  };
}

/**
 * Describe the drift between a mirrored task and its live card, as the
 * (update | move) parts of a reconcile action — or null when in sync.
 * Due dates compare as CALENDAR dates (ticket: "due compared as calendar
 * date"), so an engine timestamp suffix never reads as drift.
 * @param task - The hub task row (camelCase drizzle projection).
 * @param card - The live Trello card.
 * @returns The reconcile sub-actions, or null for no drift.
 */
function describeDrift(
  task: typeof tasks.$inferSelect,
  card: TrelloCard,
  list: string,
): { updates: PlanAction; moves: PlanAction } | null {
  const expectedTitle = `[hub-${task.id}] ${task.title}`;
  const updates: string[] = [];

  if (card.name !== expectedTitle) updates.push('title');
  if (card.description !== (task.notes ?? '')) updates.push('description');
  if ((card.due ?? '') !== (task.dueDate ?? '')) updates.push('due');
  const targetList = STATUS_TO_LIST[task.status];
  const moves: string[] = [];

  if (targetList && list !== targetList) moves.push(`list → ${targetList}`);
  if (updates.length === 0 && moves.length === 0) return null;
  const parts: string[] = [];
  if (updates.length) parts.push(`update ${updates.join(', ')}`);
  if (moves.length) parts.push(`move ${moves.join(', ')}`);
  return {
    updates: {
      action: 'update',
      taskId: task.id,
      cardId: card.id,
      list: targetList,
      summary: `task ${task.id}: ${parts.join('; ')} (card ${card.id})`,
    },
    moves: {
      action: 'move',
      taskId: task.id,
      cardId: card.id,
      list: targetList,
      summary: `task ${task.id}: move → ${targetList} (card ${card.id})`,
    },
  };
}

/**
 * The sync entry point. `--apply` executes; the DEFAULT is dry-run (prints
 * the plan, touches nothing — same convention import-vcf --dry-run uses but
 * inverted, because a write-into-a-remote-system verb must prove what it
 * would do before it does it). Flow: config → mirror set → cache sync →
 * card:list×3 → plan → upsert mapping rows + log-sync per applied action.
 * @param values - Parsed CLI flags: `apply', 'skip-cache-sync', `json`, `db`.
 * @returns Process exit code (0 in-sync-or-applied, 1 config/usage/plan errors).
 */
export async function cmdSyncTrello(values: CliValues): Promise<number> {
  // 1. Load config (JSON path from core/paths.ts, HUB_CONFIG-overridable —
  // tests point it at a throwaway file). Missing or incomplete → hint, exit 1.
  let loaded: HubJsonConfig;
  try {
    loaded = loadHubConfig();
  } catch (err: unknown) {
    console.error(`hub sync-trello: config unreadable (${(err as Error).message})`);
    console.error(
      'hub sync-trello: run hub trello-config --board <id> --list-ready <id> --list-in-progress <id> --list-done <id>',
    );
    return 1;
  }
  const configResult = completeTrelloConfig(loaded);
  if ('missing' in configResult) {
    console.error(`hub sync-trello: trello config incomplete — missing: ${configResult.missing.join(' ')}`);
    console.error(
      'hub sync-trello: run hub trello-config --board <id> --list-ready <id> --list-in-progress <id> --list-done <id>',
    );
    return 1;
  }
  const trello = configResult.trello;

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // 2. The mirror set — the EXACT query list-tasks --mirror composes.
    const mirrorRows = await hub
      .select()
      .from(tasks)
      .where(and(eq(tasks.trelloVisible, 1), inArray(tasks.status, ['ready', 'in-progress'])))
      .orderBy(tasks.id)
      .all();

    const engine: TrelloEngine = new TrelloCliEngine(trello);

    // 3. Warm the engine cache (card:create/card:list resolve name-or-id
    // through it). Skipped with --skip-cache-sync (tests; stale-cache runs).
    const skipCacheSync = values['skip-cache-sync'] === true;
    if (!skipCacheSync) await engine.syncCache();

    // 4. Read every configured list, tag-parse the cards.
    const liveCards: OwnedCard[] = [];
    for (const [role, listRef] of Object.entries(trello.lists) as [keyof typeof trello.lists, string][]) {
      const cards = await engine.listCards(listRef);
      for (const card of cards) {
        const m = card.name.match(HUB_PREFIX_RE);
        const hubId = m ? parseId(m[1]) : null;
        liveCards.push({ card, taskId: hubId, list: role });
      }
    }

    // Index live cards by parsed tag and by id (conflict detection needs both).
    const byTag = new Map<number, OwnedCard[]>();
    for (const live of liveCards) {
      if (live.taskId === null) continue;
      const list = byTag.get(live.taskId) ?? [];
      list.push(live);
      byTag.set(live.taskId, list);
    }
    const liveById = new Map<string, OwnedCard>(liveCards.map((l) => [l.card.id, l]));

    // Existing mapping rows: task_id PK (one task→one card) with the
    // UNIQUE(card_id) double-mapping guard (schema.ts S11 block).
    const mappingRows: (typeof taskTrello.$inferSelect)[] = await hub.select().from(taskTrello).all();
    const mappingByTask = new Map<number, typeof taskTrello.$inferSelect>(mappingRows.map((r) => [r.taskId, r]));
    // Every task row (any status), keyed by id — the adopt leg validates a
    // card's tag against REAL tasks (mapping FK contract: task must exist).
    const taskIdsInDb = new Map<number, typeof tasks.$inferSelect>(
      (await hub.select().from(tasks).all()).map((r) => [r.id, r]),
    );
    const taskIdsWithCard = new Set(mappingByTask.keys());
    const mappingTaskIds = new Set(mappingRows.map((r) => r.taskId));

    // Which task id does each tag'd card BELONG to, after conflict checks?
    // Two tasks claiming the same card (stale retag, mapping both ways) is a
    // REPORTED conflict, nothing applied for it (ticket step 5, last bullet).
    const actions: PlanAction[] = [];
    const conflicts = new Set<number>(); // hub-prefixed cards with ≥2 claims
    for (const [hubId, cards] of byTag) {
      if (cards.length > 1) {
        conflicts.add(hubId);
        actions.push({
          action: 'conflict',
          taskId: hubId,
          cardId: cards.map((card) => card.card.id).join('+'),
          summary: `conflict: card(s) tagged [hub-${hubId}] also claimed by another task — nothing applied for them (${cards.map((card) => card.card.id).join(', ')})`,
        });
      }
    }

    // 5. Plan per mirrored task: create / reconcile / re-create.
    for (const task of mirrorRows) {
      if (conflicts.has(task.id)) continue; // conflicted cards: nothing applied
      const tagged = byTag.get(task.id) ?? [];
      const mapping = mappingByTask.get(task.id);

      if (tagged.length === 1) {
        const live = tagged[0];
        const drift = describeDrift(task, live.card, live.list);
        if (drift) {
          actions.push(drift.updates);
          if (live.list !== STATUS_TO_LIST[task.status]) actions.push(drift.moves);
        }
        continue;
      }

      if (tagged.length === 0) {
        if (mapping && !liveById.has(mapping.cardId)) {
          // The mapped card vanished live (archived out-of-band) — re-create.
          const listRole = STATUS_TO_LIST[task.status] ?? 'ready';
          actions.push({
            action: 're-create',
            taskId: task.id,
            cardId: mapping.cardId,
            list: listRole,
            summary: `task ${task.id}: re-create (mapped card ${mapping.cardId} not on board) — [hub-${task.id}] ${task.title}`,
          });
        } else {
          // No card anywhere — plain create.
          const listRole = STATUS_TO_LIST[task.status] ?? 'ready';
          actions.push({
            action: 'create',
            taskId: task.id,
            cardId: null,
            list: listRole,
            summary: `task ${task.id}: create [hub-${task.id}] ${task.title} → ${listRole}`,
          });
        }
        continue;
      }

      // tagged.length > 1 with matching task id: a second card carries the
      // same tag as one this task already maps to. Report, don't guess.
      conflicts.add(task.id);
      actions.push({
        action: 'conflict',
        taskId: task.id,
        cardId: tagged.map((card) => card.card.id).join('+'),
        summary: `conflict: [hub-${task.id}] matches ${tagged.length} live cards — nothing applied (dedupe manually)`,
      });
    }

    // Adopt: cards tagged with a hub id that EXISTS in the tasks table but
    // has no mapping row — rebuild the mapping from the title tag (recovers
    // a lost DB). A tag pointing at a deleted/nonexistent task is NOT
    // adopted: the mapping FK would reject it, and adopting it would let a
    // typo'd manual retag grow phantom rows.
    for (const live of liveCards) {
      if (live.taskId === null) continue;
      if (conflicts.has(live.taskId)) continue;
      if (byTag.get(live.taskId)?.length !== 1) continue; // already handled/conflicted
      if (taskIdsWithCard.has(live.taskId) && mappingByTask.get(live.taskId)?.cardId === live.card.id) continue;
      if (mappingTaskIds.has(live.taskId)) continue;
      // A tag pointing at a nonexistent task is a stray/typo'd retag — the
      // mapping FK would reject it, so leave the card untouched.
      if (!taskIdsInDb.has(live.taskId)) continue;
      actions.push({
        action: 'adopt',
        taskId: live.taskId,
        cardId: live.card.id,
        summary: `task ${live.taskId}: adopt card ${live.card.id} from title tag ("${live.card.name}")`,
      });
    }

    // Archive: mapping rows whose task is GONE from the mirror set
    // (completed, de-flagged, or hard-deleted). Completed tasks move to the
    // Done list first (status↔list 1:1 preserved) then archive in the same
    // run — ONE ledger row, detail carries {list: done}.
    const mirrorIds = new Set(mirrorRows.map((r) => r.id));
    for (const row of mappingRows) {
      if (mirrorIds.has(row.taskId) || conflicts.has(row.taskId)) continue;
      const live = liveById.get(row.cardId);
      const taskRow = taskIdsInDb.get(row.taskId);
      if (!live && !taskRow) continue; // BOTH gone (task hard-deleted while its card was archived out-of-band): task_trello cascaded with the delete, so no mapping row survives to archive — leave the dead card untouched
      const completed = taskRow?.status === 'completed';
      actions.push({
        action: 'archive',
        taskId: row.taskId,
        cardId: row.cardId,
        list: completed ? 'done' : undefined,
        summary: live
          ? `task ${row.taskId}: archive card ${row.cardId}${completed ? ' (move → done first)' : ' (task no longer mirrored)'}`
          : `task ${row.taskId}: mapping row only — card ${row.cardId} already gone; drop the stale mapping`,
      });
    }
    // ─── Report / apply ───────────────────────────────────────────────────
    const applied = values.apply === true;
    const plan: SyncPlan = {
      ok: true,
      applied,
      skippedCacheSync: skipCacheSync,
      mirrorCount: mirrorRows.length,
      liveCount: liveCards.length,
      actions,
    };

    if (!applied) {
      // DRY-RUN: print, touch nothing (no mapping rows, no ledger rows — the
      // config-load above ran against the DB but performed zero writes).
      if (values.json) {
        console.log(JSON.stringify({ verb: 'sync-trello', ...plan }, null, 2));
      } else if (actions.length === 0) {
        console.log(`hub sync-trello: in sync (${plan.mirrorCount} mirrored tasks, ${plan.liveCount} live cards)`);
      } else {
        console.log(
          `hub sync-trello plan (dry-run — nothing applied; ${plan.mirrorCount} mirrored, ${plan.liveCount} live):`,
        );
        for (const a of actions) console.log(`  ${a.summary}`);
      }
      return 0;
    }

    // --apply: execute each action through the engine. Every executed
    // action upserts its mapping row and logs exactly one sync_log row via
    // the cmdLogSync idempotent path (re-runs of a replayed action stay
    // ledger-clean — first log wins, S7 contract).
    const now = new Date().toISOString();
    const logged: SyncLogJson[] = [];
    for (const a of actions) {
      try {
        switch (a.action) {
          case 'create': {
            const task = mirrorRows.find((r) => r.id === a.taskId)!;
            const card = await engine.createCard({
              listRef: trello.lists[a.list as keyof typeof trello.lists],
              name: `[hub-${task.id}] ${task.title}`,
              description: task.notes,
              due: task.dueDate,
            });
            await upsertMapping(hub, task.id, card.id, now);
            break;
          }
          case 'update': {
            const task = mirrorRows.find((r) => r.id === a.taskId)!;
            const card = liveById.get(a.cardId!)!.card;
            const expectedTitle = `[hub-${task.id}] ${task.title}`;
            const patch: { name?: string; description?: string; due?: string | null } = {};
            if (card.name !== expectedTitle) patch.name = expectedTitle;
            if (card.description !== (task.notes ?? '')) patch.description = task.notes ?? '';
            if ((card.due ?? '') !== (task.dueDate ?? '')) patch.due = task.dueDate;
            if (Object.keys(patch).length) await engine.updateCard(card.id, patch);
            break;
          }
          case 'move': {
            await engine.moveCard(a.cardId!, trello.lists[a.list as keyof typeof trello.lists]);
            break;
          }
          case 're-create': {
            const task = mirrorRows.find((r) => r.id === a.taskId)!;
            const card = await engine.createCard({
              listRef: trello.lists[a.list as keyof typeof trello.lists],
              name: `[hub-${task.id}] ${task.title}`,
              description: task.notes,
              due: task.dueDate,
            });
            await upsertMapping(hub, task.id, card.id, now);
            break;
          }
          case 'adopt': {
            await upsertMapping(hub, a.taskId!, a.cardId!, now);
            break;
          }
          case 'archive': {
            if (a.list === 'done') {
              const listed = liveById.get(a.cardId!);
              if (listed && listed.list !== 'done') await engine.moveCard(a.cardId!, trello.lists.done);
            }
            await engine.archiveCard(a.cardId!);
            await hub.delete(taskTrello).where(eq(taskTrello.taskId, a.taskId!)).run();
            break;
          }
          case 'conflict':
            break; // reported, never applied (and never logged — no action occurred)
          default:
            break;
        }
      } catch (err: unknown) {
        // UNIQUE(card_id) violation during an upsert = double-mapping attempt
        // surfaced at apply time: report as conflict, keep other actions going.
        const chain = errorChainText(err);
        if (/task_trello_card_unique|UNIQUE constraint failed/.test(chain) && /card_id|task_trello/.test(chain)) {
          actions.push({
            action: 'conflict',
            taskId: a.taskId,
            cardId: a.cardId,
            summary: `conflict apply-time: task ${a.taskId} mapping for card ${a.cardId} rejected — card already claimed (UNIQUE card_id)`,
          });
          continue;
        }
        throw err;
      }

      // One ledger row per executed action via the existing idempotent path.
      const logged0 = await logSyncAction(hub, a, now);
      if (logged0) logged.push(logged0);
    }

    const executed = actions.filter((a) => a.action !== 'conflict');
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            verb: 'sync-trello',
            ...plan,
            actions,
            executed: executed.length,
            logged,
          },
          null,
          2,
        ),
      );
    } else if (executed.length === 0) {
      console.log(
        `hub sync-trello: in sync (no actions; ${plan.mirrorCount} mirrored tasks, ${plan.liveCount} live cards)`,
      );
    } else {
      for (const a of executed) console.log(`${a.action}: ${a.summary}`);
      console.log(`hub sync-trello: applied ${executed.length} action(s), logged ${logged.length} sync row(s)`);
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Create-or-refresh one task_trello row (the mapping upsert shared by
 * create/re-create/adopt). task_id is the PK, so ON CONFLICT updates
 * card_id/synced_at in place instead of double-inserting; a collision on
 * card_id (UNIQUE, already claimed by another task) propagates to the
 * caller's conflict reporting — never a silent overwrite.
 * @param hub - Typed drizzle handle.
 * @param taskId - The hub task owning the card.
 * @param cardId - The Trello card it maps to.
 * @param now - ISO timestamp for created_at (new row) + synced_at (always).
 */
async function upsertMapping(hub: HubDb, taskId: number, cardId: string, now: string): Promise<void> {
  const existing = await hub.select().from(taskTrello).where(eq(taskTrello.taskId, taskId)).get();
  await hub
    .insert(taskTrello)
    .values({ taskId, cardId, createdAt: existing?.createdAt ?? now, syncedAt: now })
    .onConflictDoUpdate({ target: taskTrello.taskId, set: { cardId, syncedAt: now } })
    .run();
}

/**
 * Log one executed action through the EXISTING idempotent log-sync pipeline
 * (cmdLogSync catches UNIQUE(sync_log_idempotency) as a no-op; going through
 * the raw insert here instead would duplicate that catch). Kept as a helper
 * so the ledger contract stays in exactly one place.
 * @param hub - Typed drizzle handle.
 * @param a - The executed plan action.
 * @param now - ISO timestamp for the ledger row's ts.
 * @returns The logged row (null when the log-sync write itself failed —
 *   reported as a conflict row instead of aborting the remaining actions).
 */
async function logSyncAction(hub: HubDb, a: PlanAction, now: string): Promise<SyncLogJson | null> {
  if (a.taskId === null) return null;
  const action = normalizeAction(a.action);
  const detail = compactDetail(a);
  const inserted = await hub
    .insert(syncLog)
    .values({ direction: 'out', adapter: 'trello-cli', entity: 'task', entityId: a.taskId, action, ts: now, detail })
    .onConflictDoNothing()
    .returning({ id: syncLog.id });
  if (!inserted.length) return null; // idempotent re-log: the row already exists
  return {
    id: inserted[0].id,
    direction: 'out',
    adapter: 'trello-cli',
    entity: 'task',
    entity_id: a.taskId,
    action,
    ts: now,
    detail,
  };
}

/**
 * Map a plan action name onto the ledger's action vocabulary
 * (SYNC_ACTIONS: create|update|move|archive|adopt|conflict). re-create is
 * the plan's spelling; the ledger logs it as create (detail carries the old
 * card id), matching the ticket's action list exactly.
 * @param action - The plan action name.
 * @returns The ledger action string.
 */
function normalizeAction(action: string): string {
  return action === 're-create' ? 'create' : action;
}

/**
 * Compact JSON detail for one ledger row: {card_id, ...extras}. Kept
 * small deliberately — the detail column is free text and the row keys are
 * the contract (ticket step 6).
 */
function compactDetail(a: PlanAction): string {
  const body: Record<string, unknown> = {};
  if (a.cardId) body.card_id = a.cardId;
  if (a.list) body.list = a.list;
  return JSON.stringify(body);
}
