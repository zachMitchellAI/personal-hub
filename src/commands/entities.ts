// Entity verbs: add-entity, list-entities, link-entity, list-entity-links,
// unlink-entity. S7 — entities index anything worth tracking that is not
// already a person/task/interaction (concepts, projects, artifacts).
// Deliberate surface note: entities have NO status column (the S7 ticket
// defines no lifecycle), so there is no set-status verb — the S1–S6 pattern
// of "status verbs only where a lifecycle exists" is respected here.
// Slug identity mirrors people exactly: derived in the CLI via deriveSlug,
// UNIQUE in the DB, with --slug as a validated override. entity_links is
// polymorphic (target_id + target_type), so target integrity is a write-path
// rule: link-entity resolves the target row before insert, and a dangling
// link is surfaced as a null target_label rather than hidden.
import { makeDrizzle, openDb } from '../core/db.ts';
import { entities, entityLinks, files, interactions, people, tasks, trackables } from '../schema.ts';
import { deriveSlug, errorChainText, parseId } from '../core/util.ts';
import { ENTITY_LINK_TARGETS } from '../core/constants.ts';
import type {
  AddEntityStatus,
  AddEntityValues,
  EntityJson,
  EntityLinkJson,
  LinkEntityValues,
  ListEntitiesStatus,
  ListEntitiesValues,
  ListEntityLinksStatus,
  UnlinkEntityStatus,
  UnlinkEntityValues,
} from '../core/types.ts';
import { eq, inArray } from 'drizzle-orm';

/**
 * Map a drizzle `entities` row to the snake_case JSON contract. Explicit
 * mapping keeps the CLI contract (snake_case) separate from the database row
 * shape (camelCase).
 * @param row - A row selected from the `entities` table.
 * @returns The JSON-contract entity object for `--json` output.
 */
function entityJson(row: typeof entities.$inferSelect): EntityJson {
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    label: row.label,
    content: row.content,
    created_at: row.createdAt,
  };
}

/**
 * Map a drizzle `entity_links` row to the snake_case JSON contract.
 * @param row - A row selected from the `entity_links` table.
 * @param targetLabel - Resolved human label of the target row (null when dangling).
 * @returns The JSON-contract link object for `--json` output.
 */
function entityLinkJson(row: typeof entityLinks.$inferSelect, targetLabel: string | null): EntityLinkJson {
  return {
    id: row.id,
    entity_id: row.entityId,
    target_type: row.targetType,
    target_id: row.targetId,
    note: row.note,
    target_label: targetLabel,
  };
}

/**
 * `hub add-entity`: insert an entity. `--kind` and `--label` are required
 * (NOT NULL columns); `--content` is optional. The slug is derived from the
 * label with the same deterministic rules as people, unless --slug overrides
 * it (the override must already be lowercase-dashed — we derive-and-compare
 * to detect invalid input, exactly like add-person). A duplicate slug is a
 * friendly UNIQUE error, not a crash.
 * @param values - Parsed CLI flags (see `AddEntityValues`).
 * @returns Process exit code (0 = added, 1 = usage/constraint error).
 */
export async function cmdAddEntity(values: AddEntityValues): Promise<number> {
  // Required fields first, so usage errors never depend on optional-flag order.
  const kind = values.kind;
  const label = values.label;
  if (!kind || !label) {
    console.error('hub add-entity: usage: hub add-entity --kind <k> --label <l> [--content <c>] [--slug <s>]');
    return 1;
  }

  // Same slug contract as add-person: derive from the label, or validate the
  // --slug override by re-deriving it (mismatch = not lowercase-dashed).
  const slug = values.slug ? deriveSlug(values.slug) : deriveSlug(label);
  if (!slug) {
    console.error('hub add-entity: could not derive a valid slug from label');
    return 1;
  }
  if (values.slug && slug !== values.slug) {
    console.error(`hub add-entity: --slug "${values.slug}" must be lowercase-dashed (e.g. "${slug}")`);
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    try {
      const inserted = await hub
        .insert(entities)
        .values({ slug, kind, label, content: values.content ?? null, createdAt: new Date().toISOString() })
        .returning({ id: entities.id });
      const row = await hub.select().from(entities).where(eq(entities.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: AddEntityStatus = { verb: 'add-entity', ...entityJson(row) };
      if (values.json) {
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(`added entity ${row.slug} (id ${row.id}, kind ${row.kind})`);
      }
      return 0;
    } catch (err: unknown) {
      // Drizzle wraps driver errors — match against the whole cause chain.
      // Duplicate slugs are the only realistic failure (no FKs on entities).
      const chain = errorChainText(err);
      if (/entities\.slug/.test(chain)) {
        console.error(`hub add-entity: slug "${slug}" already exists`);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub list-entities`: list entities ordered by slug (same ordering as
 * list-people). Filter: --kind <k> (exact match, free text). An empty result
 * is valid output, not an error.
 * @param values - Parsed CLI flags (see `ListEntitiesValues`).
 * @returns Process exit code (always 0).
 */
export async function cmdListEntities(values: ListEntitiesValues): Promise<number> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const rows = await hub
      .select()
      .from(entities)
      .where(values.kind ? eq(entities.kind, values.kind) : undefined)
      .orderBy(entities.slug)
      .all();

    const outRows: EntityJson[] = rows.map(entityJson);
    const out: ListEntitiesStatus = {
      verb: 'list-entities',
      count: outRows.length,
      kind: values.kind ?? null,
      entities: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const e of outRows) {
        console.log(`${e.slug}\t${e.kind}\t${e.label}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Resolve a link target to its row id and human label, per target type.
 * This is the write-path integrity rule for entity_links (the polymorphic
 * target cannot carry a DB FK): an unresolvable target is a friendly CLI
 * error, never a raw driver crash.
 * @param hub - Open drizzle handle.
 * @param targetType - One of ENTITY_LINK_TARGETS.
 * @param target - Raw --target value: a slug for person, numeric id otherwise.
 * @returns The resolved target id and label, or null when unresolvable.
 */
async function resolveTarget(
  hub: ReturnType<typeof makeDrizzle>,
  targetType: string,
  target: string,
): Promise<{ id: number; label: string } | null> {
  if (targetType === 'person') {
    const row = await hub.select().from(people).where(eq(people.slug, target)).get();
    return row ? { id: row.id, label: row.displayName } : null;
  }
  // All non-person targets are numeric row ids.
  const id = parseId(target);
  if (id === null) return null;
  if (targetType === 'task') {
    const row = await hub.select().from(tasks).where(eq(tasks.id, id)).get();
    return row ? { id: row.id, label: row.title } : null;
  }
  if (targetType === 'trackable') {
    const row = await hub.select().from(trackables).where(eq(trackables.id, id)).get();
    return row ? { id: row.id, label: row.label } : null;
  }
  if (targetType === 'interaction') {
    const row = await hub.select().from(interactions).where(eq(interactions.id, id)).get();
    return row ? { id: row.id, label: row.summary } : null;
  }
  const row = await hub.select().from(files).where(eq(files.id, id)).get();
  return row ? { id: row.id, label: row.path } : null;
}

/**
 * `hub link-entity`: link an entity (by slug) to another hub row.
 * `--target-type` is one of ENTITY_LINK_TARGETS; `--target` is a person slug
 * for target-type person, a numeric row id otherwise. The target is resolved
 * BEFORE insert (write-path integrity for the polymorphic target_id), so an
 * invalid target is a clean usage error rather than a foreign-key crash.
 * @param values - Parsed CLI flags (see `LinkEntityValues`).
 * @param slugArg - First positional argument: the entity's slug.
 * @returns Process exit code (0 = linked, 1 = usage/lookup error).
 */
export async function cmdLinkEntity(values: LinkEntityValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub link-entity: entity slug argument required');
    return 1;
  }
  const targetType = values['target-type'];
  const target = values.target;
  if (!targetType || !target) {
    console.error('hub link-entity: usage: hub link-entity <slug> --target-type <t> --target <ref> [--note <n>]');
    return 1;
  }
  if (!(ENTITY_LINK_TARGETS as readonly string[]).includes(targetType)) {
    console.error(`hub link-entity: --target-type must be one of: ${ENTITY_LINK_TARGETS.join(', ')}`);
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const entity = await hub.select().from(entities).where(eq(entities.slug, slugArg)).get();
    if (!entity) {
      console.error(`hub link-entity: no entity with slug "${slugArg}"`);
      return 1;
    }

    // Resolve the target before insert — polymorphic target_id has no DB FK.
    const resolved = await resolveTarget(hub, targetType, target);
    if (!resolved) {
      console.error(`hub link-entity: no ${targetType} matching "${target}"`);
      return 1;
    }

    try {
      const inserted = await hub
        .insert(entityLinks)
        .values({ entityId: entity.id, targetType, targetId: resolved.id, note: values.note ?? null })
        .returning({ id: entityLinks.id });
      const row = await hub.select().from(entityLinks).where(eq(entityLinks.id, inserted[0].id)).get();
      if (!row) throw new Error('insert vanished — returned id not found');

      const out: EntityLinkJson = entityLinkJson(row, resolved.label);
      if (values.json) {
        console.log(JSON.stringify({ verb: 'link-entity' as const, ...out }, null, 2));
      } else {
        console.log(`linked entity ${entity.slug} → ${targetType} ${resolved.label} (link ${row.id})`);
      }
      return 0;
    } catch (err: unknown) {
      // The entity could have been deleted between lookup and insert —
      // drizzle wraps driver errors, so match the whole cause chain.
      const chain = errorChainText(err);
      if (/FOREIGN KEY constraint failed/.test(chain)) {
        console.error(`hub link-entity: entity ${entity.id} no longer exists`);
        return 1;
      }
      throw err;
    }
  } finally {
    db.close();
  }
}

/**
 * `hub list-entity-links`: one entity's links, ordered by id, each resolved
 * to its target's human label (person display name, task title, trackable
 * label, interaction summary, file path). A null target_label means the
 * target row no longer exists — dangling links are surfaced, not hidden.
 * Target labels are resolved with one IN-query per target type instead of
 * one query per link (same grouped-in-memory join pattern as list-tasks).
 * @param values - Parsed CLI flags.
 * @param slugArg - First positional argument: the entity's slug.
 * @returns Process exit code (0 = listed, 1 = unknown entity).
 */
export async function cmdListEntityLinks(values: LinkEntityValues, slugArg?: string): Promise<number> {
  if (!slugArg) {
    console.error('hub list-entity-links: entity slug argument required');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const entity = await hub.select().from(entities).where(eq(entities.slug, slugArg)).get();
    if (!entity) {
      console.error(`hub list-entity-links: no entity with slug "${slugArg}"`);
      return 1;
    }

    const rows = await hub
      .select()
      .from(entityLinks)
      .where(eq(entityLinks.entityId, entity.id))
      .orderBy(entityLinks.id)
      .all();

    // Group link ids by target type, then resolve each group with one query.
    const idsByType = new Map<string, number[]>();
    for (const row of rows) {
      const list = idsByType.get(row.targetType) ?? [];
      list.push(row.targetId);
      idsByType.set(row.targetType, list);
    }
    const labels = new Map<string, string>();
    for (const [targetType, ids] of idsByType) {
      let rowsForType: { id: number; label: string }[] = [];
      if (targetType === 'person') {
        rowsForType = (await hub.select().from(people).where(inArray(people.id, ids)).all()).map((r) => ({
          id: r.id,
          label: r.displayName,
        }));
      } else if (targetType === 'task') {
        rowsForType = (await hub.select().from(tasks).where(inArray(tasks.id, ids)).all()).map((r) => ({
          id: r.id,
          label: r.title,
        }));
      } else if (targetType === 'trackable') {
        rowsForType = (await hub.select().from(trackables).where(inArray(trackables.id, ids)).all()).map((r) => ({
          id: r.id,
          label: r.label,
        }));
      } else if (targetType === 'interaction') {
        rowsForType = (await hub.select().from(interactions).where(inArray(interactions.id, ids)).all()).map((r) => ({
          id: r.id,
          label: r.summary,
        }));
      } else {
        rowsForType = (await hub.select().from(files).where(inArray(files.id, ids)).all()).map((r) => ({
          id: r.id,
          label: r.path,
        }));
      }
      for (const r of rowsForType) {
        labels.set(`${targetType}:${r.id}`, r.label);
      }
    }

    const outRows: EntityLinkJson[] = rows.map((row) =>
      entityLinkJson(row, labels.get(`${row.targetType}:${row.targetId}`) ?? null),
    );
    const out: ListEntityLinksStatus = {
      verb: 'list-entity-links',
      entity_id: entity.id,
      slug: entity.slug,
      count: outRows.length,
      links: outRows,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`entity ${entity.slug} (${entity.kind}):`);
      for (const l of outRows) {
        console.log(`  ${l.id}\t${l.target_type}\t${l.target_label ?? l.target_id}${l.note ? `\t${l.note}` : ''}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * `hub unlink-entity`: remove one entity link by id. The link must exist;
 * unlike the underlying target tables, nothing cascades here — the removal
 * is a single-row delete.
 * @param values - Parsed CLI flags.
 * @param idArg - First positional argument: the link id (positive integer).
 * @returns Process exit code (0 = removed, 1 = unknown link).
 */
export async function cmdUnlinkEntity(values: UnlinkEntityValues, idArg?: string): Promise<number> {
  const id = parseId(idArg);
  if (id === null) {
    console.error('hub unlink-entity: link id argument required');
    return 1;
  }

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    // Select first so an unknown id is a friendly error; drizzle's sqlite-proxy
    // run() result does not expose a changes count, and the delete below proves
    // the id actually materialized (same pattern as remove-channel).
    const row = await hub.select().from(entityLinks).where(eq(entityLinks.id, id)).get();
    if (!row) {
      console.error(`hub unlink-entity: no entity link with id ${id}`);
      return 1;
    }
    await hub.delete(entityLinks).where(eq(entityLinks.id, id)).run();
    const out: UnlinkEntityStatus = { verb: 'unlink-entity', id, removed: true };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(`removed entity link ${id}`);
    }
    return 0;
  } finally {
    db.close();
  }
}
