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
 * Load the hub config and complete-check its trello block. Prints the
 * trello-config hint and returns null on failure — the caller exits 1.
 * Split from cmdSyncTrello so the entry point reads as a step, not a scroll.
 * @returns The complete trello block, or null when missing/incomplete/unreadable.
 */
function loadTrelloConfig(): { trello: TrelloConfig } | null {
  let loaded: HubJsonConfig;
  try {
    loaded = loadHubConfig();
  } catch (err: unknown) {
    console.error(`hub sync-trello: config unreadable (${(err as Error).message})`);
    console.error(
      'hub sync-trello: run hub trello-config --board <id> --list-ready <id> --list-in-progress <id> --list-done <id>',
    );
    return null;
  }
  const configResult = completeTrelloConfig(loaded);
  if ('missing' in configResult) {
    console.error(`hub sync-trello: trello config incomplete — missing: ${configResult.missing.join(' ')}`);
    console.error(
      'hub sync-trello: run hub trello-config --board <id> --list-ready <id> --list-in-progress <id> --list-done <id>',
    );
    return null;
  }
  return { trello: configResult.trello };
}

/**
 * Everything the planner reads from the DB, fetched in one place: the mirror
 * set, the task→card mapping rows, and the lookup maps derived from both.
 * @param hub - Typed drizzle handle.
 */
interface SyncContext {
  /** Mirrored tasks (trelloVisible, ready|in-progress), ordered by id. */
  mirrorRows: (typeof tasks.$inferSelect)[];
  /** All task_trello rows (task_id PK + UNIQUE card_id). */
  mappingRows: (typeof taskTrello.$inferSelect)[];
  /** mappingRows keyed by taskId. */
  mappingByTask: Map<number, typeof taskTrello.$inferSelect>;
  /** Every task row (any status) keyed by id — adopt-leg FK validation. */
  tasksById: Map<number, typeof tasks.$inferSelect>;
  /** Task ids that already own a mapping row. */
  tasksWithCard: Set<number>;
  /** Mapping-row task ids (same set as mappingByTask keys, kept explicit). */
  mappingTaskIds: Set<number>;
}

/**
 * Fetch the DB-side planning inputs (the reads cmdSyncTrello used to do
 * inline). Kept separate so the planner is a pure function over fetched
 * state — readable, and trivially testable without an engine.
 * @param hub - Typed drizzle handle.
 * @returns The fetched context.
 */
async function loadSyncContext(hub: HubDb): Promise<SyncContext> {
  const mirrorRows: (typeof tasks.$inferSelect)[] = await hub
    .select()
    .from(tasks)
    .where(and(eq(tasks.trelloVisible, 1), inArray(tasks.status, ['ready', 'in-progress'])))
    .orderBy(tasks.id)
    .all();
  const mappingRows: (typeof taskTrello.$inferSelect)[] = await hub.select().from(taskTrello).all();
  const mappingByTask = new Map<number, typeof taskTrello.$inferSelect>(mappingRows.map((row) => [row.taskId, row]));
  const tasksById = new Map<number, typeof tasks.$inferSelect>(
    (await hub.select().from(tasks).all()).map((row) => [row.id, row]),
  );
  return {
    mirrorRows,
    mappingRows,
    mappingByTask,
    tasksById,
    tasksWithCard: new Set(mappingByTask.keys()),
    mappingTaskIds: new Set(mappingRows.map((row) => row.taskId)),
  };
}

/** Live cards + the two indexes the planner needs (by parsed tag, by card id). */
interface LiveIndex {
  /** Every card on the three configured lists, tag-parsed. */
  liveCards: OwnedCard[];
  /** Tag'd cards grouped by hub id — a group >1 is a conflict candidate. */
  byTag: Map<number, OwnedCard[]>;
  /** Card id → live entry (re-create/archive/apply need id lookups). */
  liveById: Map<string, OwnedCard>;
}

/**
 * Read every configured list through the engine and index the cards.
 * @param engine - The spawn-based engine.
 * @param trello - The complete trello config (board + list roles).
 * @returns The live index.
 */
async function fetchLiveIndex(engine: TrelloEngine, trello: TrelloConfig): Promise<LiveIndex> {
  const liveCards: OwnedCard[] = [];
  for (const [role, listRef] of Object.entries(trello.lists) as [keyof typeof trello.lists, string][]) {
    const cards = await engine.listCards(listRef);
    for (const card of cards) {
      const match = card.name.match(HUB_PREFIX_RE);
      const hubId = match ? parseId(match[1]) : null;
      liveCards.push({ card, taskId: hubId, list: role });
    }
  }
  const byTag = new Map<number, OwnedCard[]>();
  for (const live of liveCards) {
    if (live.taskId === null) continue;
    const group = byTag.get(live.taskId) ?? [];
    group.push(live);
    byTag.set(live.taskId, group);
  }
  const liveById = new Map<string, OwnedCard>(liveCards.map((live) => [live.card.id, live]));
  return { liveCards, byTag, liveById };
}

/** The planner output: actions in execution order + the conflicting hub ids. */
interface Plan {
  actions: PlanAction[];
  /** Hub ids with ≥2 tag claims — the planner and apply leg both skip these. */
  conflicts: Set<number>;
}

/**
 * Build the reconcile plan for one task's tag situation (a step of planSync):
 * one tagged card → drift; none → create/re-create; multiple with this
 * task's tag → conflict, nothing applied.
 */
function planTaskCards(
  task: typeof tasks.$inferSelect,
  tagged: OwnedCard[],
  mapping: typeof taskTrello.$inferSelect | undefined,
  liveIndex: LiveIndex,
  plan: Plan,
): void {
  if (tagged.length === 1) {
    const live = tagged[0];
    const drift = describeDrift(task, live.card, live.list);
    if (drift) {
      plan.actions.push(drift.updates);
      if (live.list !== STATUS_TO_LIST[task.status]) plan.actions.push(drift.moves);
    }
    return;
  }

  if (tagged.length === 0) {
    if (mapping && !liveIndex.liveById.has(mapping.cardId)) {
      // The mapped card vanished live (archived out-of-band) — re-create.
      const listRole = STATUS_TO_LIST[task.status] ?? 'ready';
      plan.actions.push({
        action: 're-create',
        taskId: task.id,
        cardId: mapping.cardId,
        list: listRole,
        summary: `task ${task.id}: re-create (mapped card ${mapping.cardId} not on board) — [hub-${task.id}] ${task.title}`,
      });
    } else {
      // No card anywhere — plain create.
      const listRole = STATUS_TO_LIST[task.status] ?? 'ready';
      plan.actions.push({
        action: 'create',
        taskId: task.id,
        cardId: null,
        list: listRole,
        summary: `task ${task.id}: create [hub-${task.id}] ${task.title} → ${listRole}`,
      });
    }
    return;
  }

  // tagged.length > 1 with matching task id: a second card carries the
  // same tag as one this task already maps to. Report, don't guess.
  plan.conflicts.add(task.id);
  plan.actions.push({
    action: 'conflict',
    taskId: task.id,
    cardId: tagged.map((card) => card.card.id).join('+'),
    summary: `conflict: [hub-${task.id}] matches ${tagged.length} live cards — nothing applied (dedupe manually)`,
  });
}

/**
 * Adopt step of planSync: cards tagged with a hub id that EXISTS in the
 * tasks table but has no mapping row — rebuild the mapping from the title
 * tag (recovers a lost DB). A tag pointing at a deleted/nonexistent task
 * is NOT adopted: the mapping FK would reject it, and adopting it would
 * let a typo'd manual retag grow phantom rows.
 */
function planAdoptions(context: SyncContext, liveIndex: LiveIndex, plan: Plan): void {
  for (const live of liveIndex.liveCards) {
    if (live.taskId === null) continue;
    if (plan.conflicts.has(live.taskId)) continue;
    if (liveIndex.byTag.get(live.taskId)?.length !== 1) continue; // already handled/conflicted
    if (context.tasksWithCard.has(live.taskId) && context.mappingByTask.get(live.taskId)?.cardId === live.card.id) {
      continue;
    }
    if (context.mappingTaskIds.has(live.taskId)) continue;
    // A tag pointing at a nonexistent task is a stray/typo'd retag — the
    // mapping FK would reject it, so leave the card untouched.
    if (!context.tasksById.has(live.taskId)) continue;
    plan.actions.push({
      action: 'adopt',
      taskId: live.taskId,
      cardId: live.card.id,
      summary: `task ${live.taskId}: adopt card ${live.card.id} from title tag ("${live.card.name}")`,
    });
  }
}

/**
 * Archive step of planSync: mapping rows whose task is GONE from the mirror
 * set (completed, de-flagged, or hard-deleted). Completed tasks move to the
 * Done list first (status↔list 1:1 preserved) then archive in the same
 * run — ONE ledger row, detail carries {list: done}.
 */
function planArchives(context: SyncContext, liveIndex: LiveIndex, plan: Plan): void {
  const mirrorIds = new Set(context.mirrorRows.map((row) => row.id));
  for (const row of context.mappingRows) {
    if (mirrorIds.has(row.taskId) || plan.conflicts.has(row.taskId)) continue;
    const live = liveIndex.liveById.get(row.cardId);
    const taskRow = context.tasksById.get(row.taskId);
    if (!live && !taskRow) {
      // BOTH gone (task hard-deleted while its card was archived
      // out-of-band): task_trello cascaded with the delete, so no mapping
      // row survives to archive — leave the dead card untouched.
      continue;
    }
    const completed = taskRow?.status === 'completed';
    plan.actions.push({
      action: 'archive',
      taskId: row.taskId,
      cardId: row.cardId,
      list: completed ? 'done' : undefined,
      summary: live
        ? `task ${row.taskId}: archive card ${row.cardId}${completed ? ' (move → done first)' : ' (task no longer mirrored)'}`
        : `task ${row.taskId}: mapping row only — card ${row.cardId} already gone; drop the stale mapping`,
    });
  }
}

/**
 * Build the plan: conflict detection, per-mirror-task reconcile, adopt, and
 * archive — the pure core of sync (no engine calls, no writes).
 * @param context - The fetched DB context.
 * @param liveIndex - The fetched live-card index.
 * @returns The plan (actions + conflict set).
 */
function planSync(context: SyncContext, liveIndex: LiveIndex): Plan {
  const plan: Plan = { actions: [], conflicts: new Set() };

  // Which task id does each tag'd card BELONG to, after conflict checks?
  // Two tasks claiming the same card (stale retag, mapping both ways) is a
  // REPORTED conflict, nothing applied for it (ticket step 5, last bullet).
  for (const [hubId, cards] of liveIndex.byTag) {
    if (cards.length > 1) {
      plan.conflicts.add(hubId);
      plan.actions.push({
        action: 'conflict',
        taskId: hubId,
        cardId: cards.map((card) => card.card.id).join('+'),
        summary: `conflict: card(s) tagged [hub-${hubId}] also claimed by another task — nothing applied for them (${cards.map((card) => card.card.id).join(', ')})`,
      });
    }
  }

  // Per mirrored task: create / reconcile / re-create (or conflict).
  for (const task of context.mirrorRows) {
    if (plan.conflicts.has(task.id)) continue; // conflicted cards: nothing applied
    planTaskCards(task, liveIndex.byTag.get(task.id) ?? [], context.mappingByTask.get(task.id), liveIndex, plan);
  }

  planAdoptions(context, liveIndex, plan);
  planArchives(context, liveIndex, plan);
  return plan;
}

/**
 * Dry-run reporting: print, touch nothing (no mapping rows, no ledger rows —
 * reading the DB was the only side effect so far).
 * @param values - CLI flags (json output format).
 * @param plan - The built plan.
 * @param counts - Report counts: mirrored tasks, live cards, cache skipped.
 */
function printDryRun(
  values: CliValues,
  plan: Plan,
  counts: { mirrorCount: number; liveCount: number; skippedCacheSync: boolean },
): void {
  if (values.json) {
    const report: SyncPlan = {
      ok: true,
      applied: false,
      skippedCacheSync: counts.skippedCacheSync,
      mirrorCount: counts.mirrorCount,
      liveCount: counts.liveCount,
      actions: plan.actions,
    };
    console.log(JSON.stringify({ verb: 'sync-trello', ...report }, null, 2));
  } else if (plan.actions.length === 0) {
    console.log(`hub sync-trello: in sync (${counts.mirrorCount} mirrored tasks, ${counts.liveCount} live cards)`);
  } else {
    console.log(
      `hub sync-trello plan (dry-run — nothing applied; ${counts.mirrorCount} mirrored, ${counts.liveCount} live):`,
    );
    for (const action of plan.actions) console.log(`  ${action.summary}`);
  }
}

/**
 * The --apply executor: run each action through the engine, upsert mapping
 * rows, and log exactly one sync_log row via the cmdLogSync idempotent path
 * (re-runs of a replayed action stay ledger-clean — first log wins, S7
 * contract). UNIQUE(card_id) violations surface as apply-time conflicts and
 * keep the rest of the actions going.
 * @param hub - Typed drizzle handle.
 * @param engine - The spawn-based engine.
 * @param trello - The complete trello config.
 * @param plan - The plan to execute (mutated: apply-time conflicts append).
 * @param context - Fetched context (task rows for create/update payloads).
 * @param liveIndex - Fetched live index (card lookups).
 * @returns The applied actions (non-conflict) and their ledger rows.
 */
async function applyPlan(
  hub: HubDb,
  engine: TrelloEngine,
  trello: TrelloConfig,
  plan: Plan,
  context: SyncContext,
  liveIndex: LiveIndex,
): Promise<{ executed: PlanAction[]; logged: SyncLogJson[] }> {
  const now = new Date().toISOString();
  const logged: SyncLogJson[] = [];
  for (const action of plan.actions) {
    try {
      switch (action.action) {
        case 'create':
        case 're-create': {
          const task = context.mirrorRows.find((row) => row.id === action.taskId)!;
          const card = await engine.createCard({
            listRef: trello.lists[action.list as keyof typeof trello.lists],
            name: `[hub-${task.id}] ${task.title}`,
            description: task.notes,
            due: task.dueDate,
          });
          await upsertMapping(hub, task.id, card.id, now);
          break;
        }
        case 'update': {
          const task = context.mirrorRows.find((row) => row.id === action.taskId)!;
          const card = liveIndex.liveById.get(action.cardId!)!.card;
          const expectedTitle = `[hub-${task.id}] ${task.title}`;
          const patch: { name?: string; description?: string; due?: string | null } = {};
          if (card.name !== expectedTitle) patch.name = expectedTitle;
          if (card.description !== (task.notes ?? '')) patch.description = task.notes ?? '';
          if ((card.due ?? '') !== (task.dueDate ?? '')) patch.due = task.dueDate;
          if (Object.keys(patch).length) await engine.updateCard(card.id, patch);
          break;
        }
        case 'move': {
          await engine.moveCard(action.cardId!, trello.lists[action.list as keyof typeof trello.lists]);
          break;
        }
        case 'adopt': {
          await upsertMapping(hub, action.taskId!, action.cardId!, now);
          break;
        }
        case 'archive': {
          if (action.list === 'done') {
            const listed = liveIndex.liveById.get(action.cardId!);
            if (listed && listed.list !== 'done') await engine.moveCard(action.cardId!, trello.lists.done);
          }
          await engine.archiveCard(action.cardId!);
          await hub.delete(taskTrello).where(eq(taskTrello.taskId, action.taskId!)).run();
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
        plan.actions.push({
          action: 'conflict',
          taskId: action.taskId,
          cardId: action.cardId,
          summary: `conflict apply-time: task ${action.taskId} mapping for card ${action.cardId} rejected — card already claimed (UNIQUE card_id)`,
        });
        continue;
      }
      throw err;
    }

    // One ledger row per executed action via the existing idempotent path.
    const loggedRow = await logSyncAction(hub, action, now);
    if (loggedRow) logged.push(loggedRow);
  }
  const executed = plan.actions.filter((candidate) => candidate.action !== 'conflict');
  return { executed, logged };
}

/**
 * Apply-mode reporting: console or JSON, identical shape to the pre-decompose
 * output (actions appear both inside the plan and as the mutated top-level
 * list — contract preserved for consumers).
 * @param values - CLI flags (json output format).
 * @param plan - The apply-time-mutated plan (apply-time conflicts appended).
 * @param result - Executed actions + ledger rows from applyPlan.
 * @param counts - Report counts: mirrored tasks, live cards, cache skipped.
 */
function printApplyResult(
  values: CliValues,
  plan: Plan,
  result: { executed: PlanAction[]; logged: SyncLogJson[] },
  counts: { mirrorCount: number; liveCount: number; skippedCacheSync: boolean },
): void {
  if (values.json) {
    const report: SyncPlan = {
      ok: true,
      applied: true,
      skippedCacheSync: counts.skippedCacheSync,
      mirrorCount: counts.mirrorCount,
      liveCount: counts.liveCount,
      actions: plan.actions,
    };
    console.log(
      JSON.stringify(
        { verb: 'sync-trello', ...report, executed: result.executed.length, logged: result.logged },
        null,
        2,
      ),
    );
  } else if (result.executed.length === 0) {
    console.log(
      `hub sync-trello: in sync (no actions; ${counts.mirrorCount} mirrored tasks, ${counts.liveCount} live cards)`,
    );
  } else {
    for (const action of result.executed) console.log(`${action.action}: ${action.summary}`);
    console.log(
      `hub sync-trello: applied ${result.executed.length} action(s), logged ${result.logged.length} sync row(s)`,
    );
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

// ─── Public surface (exports live at the bottom, per owner rule 2026-11-11) ───

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

/**
 * The sync entry point. `--apply` executes; the DEFAULT is dry-run (prints
 * the plan, touches nothing — same convention import-vcf --dry-run uses but
 * inverted, because a write-into-a-remote-system verb must prove what it
 * would do before it does it). Decomposed (owner review 2026-11-11):
 * config → context → live index → plan → (dry-run print | apply) → report.
 * @param values - Parsed CLI flags: `apply', 'skip-cache-sync', `json`, `db`.
 * @returns Process exit code (0 in-sync-or-applied, 1 config/usage/plan errors).
 */
export async function cmdSyncTrello(values: CliValues): Promise<number> {
  // 1. Config: load + complete-check.
  const loaded = loadTrelloConfig();
  if (!loaded) return 1;
  const trello = loaded.trello;

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // 2-3. DB context + engine (cache sync honors --skip-cache-sync).
    const context = await loadSyncContext(hub);
    const engine: TrelloEngine = new TrelloCliEngine(trello);
    const skipCacheSync = values['skip-cache-sync'] === true;
    if (!skipCacheSync) await engine.syncCache();

    // 4. Live cards, indexed.
    const liveIndex = await fetchLiveIndex(engine, trello);

    // 5. Plan.
    const plan = planSync(context, liveIndex);

    // 6. Dry-run prints and stops; --apply executes.
    if (values.apply !== true) {
      printDryRun(values, plan, {
        mirrorCount: context.mirrorRows.length,
        liveCount: liveIndex.liveCards.length,
        skippedCacheSync: skipCacheSync,
      });
      return 0;
    }
    const result = await applyPlan(hub, engine, trello, plan, context, liveIndex);
    printApplyResult(values, plan, result, {
      mirrorCount: context.mirrorRows.length,
      liveCount: liveIndex.liveCards.length,
      skippedCacheSync: skipCacheSync,
    });
    return 0;
  } finally {
    db.close();
  }
}
