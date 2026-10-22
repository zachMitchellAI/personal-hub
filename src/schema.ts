// Schema-as-TS: the source of truth for the hub database (DECISIONS item 4).
// drizzle-kit generate turns this into plain SQL migrations in src/migrations/,
// which our own runner (migrations.ts) applies transactionally.
// Stable drizzle-orm 0.45.4, sqlite-core only — no native drivers.
import { check, index, integer, sqliteTable, sqliteView, text, unique } from 'drizzle-orm/sqlite-core';
import { and, eq, inArray, sql } from 'drizzle-orm';

// S2 — people with slug identity.
// slug: UNIQUE, NOT NULL, lowercase-dashed, CLI-derived at creation/import,
// immutable afterwards (no update path; it keys filesystem images and relations).
// relationship_type is intentionally nullable with no enum constraint — kinds are data.
export const people = sqliteTable('people', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  displayName: text('display_name').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  relationshipType: text('relationship_type'),
  employer: text('employer'),
  notes: text('notes'),
  createdAt: text('created_at').notNull(),
});

// S3 — contact_channels with open-ended kinds (DESIGN.md D3).
// kind is free text — email/phone/discord/mastodon/signal/matrix/linkedin/custom
// are data, not an enum; new channel types are just new rows (no schema change).
// person_id FK → people, ON DELETE CASCADE (no orphaned channels).
// At most one primary per (person, kind) is enforced by the CLI write path
// (transactional demote-then-set), not by a DB constraint — per the S3 ticket.
export const contactChannels = sqliteTable(
  'contact_channels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    personId: integer('person_id')
      .notNull()
      .references(() => people.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    value: text('value').notNull(),
    primaryFlag: integer('primary_flag').notNull().default(0),
    source: text('source'),
  },
  // S8 — FK index: list-channels and the person_full channels subquery both
  // resolve channels by person_id on every call.
  (table) => [index('contact_channels_person_idx').on(table.personId)],
);

// S4 — tasks: the relational core of the mirror (stories/epic-schema.md S4).
// person_id is nullable — tasks can be people-less — and ON DELETE SET NULL:
// deleting a person must not erase their tasks (unlike contact_channels,
// which are attributes of the person and CASCADE). This is a judgement call
// surfaced to the owner with the S4 report; revisit only if the mirror needs
// hard links.
// status is the ONE column with a DB CHECK constraint — the S4 ticket asks
// for it explicitly. Everything else open-ended (context, origin) stays
// free text: kinds are data, not schema (DESIGN.md D3).
// completed_at is CLI-managed, never a free value: set on transition to
// "completed", cleared on transition away (see commands/tasks.ts set-status).
export const tasks = sqliteTable(
  'tasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
    context: text('context').notNull(),
    status: text('status').notNull().default('ready'),
    dueDate: text('due_date'),
    completedAt: text('completed_at'),
    origin: text('origin').notNull().default('self'),
    notes: text('notes'),
    trelloVisible: integer('trello_visible').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    check('tasks_status_check', sql`${table.status} in ('ready', 'in-progress', 'completed')`),
    // S8 — hot-query index for the mirror set: trello_visible=1 is an
    // equality predicate, status a list — leading equality column first per
    // SQLite's index-seek order.
    index('tasks_mirror_idx').on(table.trelloVisible, table.status),
    // S8 — FK index: --person task listings and person_full joins.
    index('tasks_person_idx').on(table.personId),
  ],
);

// S4 — subtasks: checklist items hanging off a task.
// task_id FK → tasks, ON DELETE CASCADE (subtasks are parts of their task).
// position is CLI-assigned (append: max+1 per task) and ordering is by it;
// no reorder verb in S4 scope — positions are write-once in this ticket.
export const subtasks = sqliteTable(
  'subtasks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    done: integer('done').notNull().default(0),
    position: integer('position').notNull(),
  },
  // S8 — FK index: subtasks are nested under their task on every list-tasks call.
  (table) => [index('subtasks_task_idx').on(table.taskId)],
);

// S5 — interactions: the person history log (stories/epic-schema.md S5).
// person_id is nullable — people-less interactions are valid per the ticket —
// and ON DELETE SET NULL: erasing a person must not erase the historical log
// (same reasoning as tasks; history outlives the link).
// kind is free text (call/email/meeting/interview/message…) — kinds are data,
// not schema (DESIGN.md D3), so no CHECK.
// date is the interaction's calendar date (YYYY-MM-DD), validated at the CLI
// layer with the same parseIsoDate rule as tasks.due_date.
// channel and summary are unannotated in the ticket → NOT NULL, CLI-required
// (same reading as tasks.context; flagged as a judgement call in the S5 report).
export const interactions = sqliteTable(
  'interactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    date: text('date').notNull(),
    channel: text('channel').notNull(),
    summary: text('summary').notNull(),
    createdAt: text('created_at').notNull(),
  },
  // S8 — hot-query index (list-interactions sorts newest-first by date) plus
  // the person FK index (per-person history and person_full's
  // recent-interactions subquery).
  (table) => [index('interactions_date_idx').on(table.date), index('interactions_person_idx').on(table.personId)],
);

// S6 — trackables: any process-with-a-lifecycle as data (stories/epic-schema.md
// S6, owner-generalized 2026-10-21). Job applications, orders, prescription
// refills, signups — job hunting is just the first `kind`, never privileged.
// party is nullable — a personal signup has no company on the other side.
// stage is free text with NO enum (stages vary per kind — "stages are data");
// CLI defaults it to "started" when omitted.
// status is the ONE column with a DB CHECK (active/closed), same pattern as
// tasks.status: the ticket names the values explicitly.
// Person/recruiter linking arrives via S7 entity_links — no person_id here.
export const trackables = sqliteTable(
  'trackables',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    label: text('label').notNull(),
    kind: text('kind').notNull(),
    party: text('party'),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [check('trackables_status_check', sql`${table.status} in ('active', 'closed')`)],
);

// S6 — trackable_events: the event trail behind each trackable.
// trackable_id FK → trackables, ON DELETE CASCADE (events are parts of their
// trackable — closing a trackable never deletes them, but deleting the
// trackable itself removes its history, matching the S6 contract).
// event_date is validated at the CLI layer with the same parseIsoDate rule as
// tasks.due_date; event_type is free text (kinds are data).
export const trackableEvents = sqliteTable(
  'trackable_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    trackableId: integer('trackable_id')
      .notNull()
      .references(() => trackables.id, { onDelete: 'cascade' }),
    eventDate: text('event_date').notNull(),
    eventType: text('event_type').notNull(),
    notes: text('notes'),
  },
  // S8 — FK index: the event trail resolves by trackable_id.
  (table) => [index('trackable_events_trackable_idx').on(table.trackableId)],
);

// S7 — entities: anything worth indexing that is not already a person/task/
// interaction — concepts, projects, artifacts, organizations. Slug identity
// mirrors people (owner confirmed 2026-10-20): UNIQUE NOT NULL, lowercase-
// dashed, derived in the CLI from the label (same deriveSlug rules, not a
// DB-side default). kind and label are free text — kinds are data, not schema
// (DESIGN.md D3). content is the payload; note the ticket gives entities NO
// status column, so there is deliberately no set-status verb for them.
// Column-constraint facts verified 2026-10-22 via context7 (sqlite.org docs,
// checked against the node:sqlite build in Node v24): `slug text NOT NULL`
// plus a separate UNIQUE index is the emitted form (drizzle's .unique() →
// CREATE UNIQUE INDEX ...); UNIQUE treats NULLs as distinct, which is moot
// here because slug is NOT NULL; inline `REFERENCES parent(col) ON DELETE
// <action>` is valid for the FK columns below.
export const entities = sqliteTable('entities', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  content: text('content'),
  createdAt: text('created_at').notNull(),
});

// S7 — entity_links: polymorphic edges from an entity to any other hub row.
// target_type names the TABLE the link points at: person/task/trackable/
// interaction/file. (The epic's original "application" became "trackable"
// when S6 generalized applications per DECISIONS #17 — the applications table
// no longer exists, so linking to it would dangle by construction.)
// No DB foreign key is possible here: target_id is polymorphic, and SQLite
// FKs must reference one specific table. Integrity is therefore a write-path
// rule (AGENTS.md database contract): link-entity resolves the target row
// before insert, so an invalid target is a friendly CLI error, never a raw
// driver crash. entity_id itself IS a real FK — links are attributes of
// their entity (like contact_channels of a person), so CASCADE on delete.
export const entityLinks = sqliteTable(
  'entity_links',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entityId: integer('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(),
    targetId: integer('target_id').notNull(),
    note: text('note'),
  },
  // S8 — FK index: list-entity-links resolves links by entity_id.
  (table) => [index('entity_links_entity_idx').on(table.entityId)],
);

// S7 — files: the index of durable artifacts on disk. The hierarchy convention
// (owner epic note) keeps artifacts under ~/hub/files/<slug>/...; the CLI
// stores the path as given and performs NO disk I/O — the convention is how
// humans/agents organize files, not a write-path rule. kind names the file
// family (pdf/apk/html/image/project); it stays free text with no CHECK — the
// S7 ticket does not request one (unlike tasks.status), and D3 says kinds are
// data. person_id/task_id are nullable FKs with ON DELETE SET NULL (same
// reasoning as tasks/interactions): deleting a person or task must not erase
// the record of a durable artifact that exists independently of them.
export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    path: text('path').notNull(),
    kind: text('kind').notNull(),
    personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
    taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    addedAt: text('added_at').notNull(),
    note: text('note'),
  },
  // S8 — FK indexes: person/task-filtered file listings.
  (table) => [index('files_person_idx').on(table.personId), index('files_task_idx').on(table.taskId)],
);

// S8 — active_tasks: the Trello-mirror set as a read-only DB object
// (stories/epic-schema.md S8). Exactly the rows `list-tasks --mirror` serves:
// trello_visible=1 AND status in ('ready','in-progress'), due_date ascending
// with NULLs last. SQLite honors a view's internal ORDER BY when the outer
// query supplies none of its own (verified live on node:sqlite 3.53). The
// mirror definition now lives in exactly one place — this view.
export const activeTasks = sqliteView('active_tasks').as((qb) =>
  qb
    .select()
    .from(tasks)
    .where(and(eq(tasks.trelloVisible, 1), inArray(tasks.status, ['ready', 'in-progress'])))
    .orderBy(sql`${tasks.dueDate} asc nulls last`),
);

// S8 — person_full: one row per person with their channels and recent
// interactions as JSON aggregates. Declared with the raw-sql sqliteView form
// (explicit columns + raw definition): correlated scalar subqueries over
// json_group_array are beyond the query builder, and drizzle-kit 0.31.11
// emits raw-sql views correctly (verified in a scratch schema before writing
// this — no runner-contract deviation needed).
// "Recent" = the 5 most recent interactions per person (date descending,
// ties by id desc — the same ordering list-interactions serves). The ticket
// leaves "recent" underspecified; this limit is a judgement call flagged to
// the owner in the S8 report. Both aggregates coalesce to '[]' over an empty
// set: json_group_array returns NULL on zero rows, and coalesce makes the
// column a well-typed JSON array string in every row. Channel arrays keep the
// list-channels order (kind, then id); the view sorts people by slug, the
// same order list-people serves.
export const personFull = sqliteView('person_full', {
  id: integer('id'),
  slug: text('slug'),
  displayName: text('display_name'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  relationshipType: text('relationship_type'),
  employer: text('employer'),
  notes: text('notes'),
  createdAt: text('created_at'),
  channelsJson: text('channels_json'),
  recentInteractionsJson: text('recent_interactions_json'),
}).as(sql`
  select
    p.id, p.slug, p.display_name, p.first_name, p.last_name,
    p.relationship_type, p.employer, p.notes, p.created_at,
    coalesce((
      select json_group_array(json_object('id', c.id, 'kind', c.kind, 'value', c.value,
                                         'primary_flag', c.primary_flag, 'source', c.source))
      from contact_channels c
      where c.person_id = p.id
      order by c.kind, c.id
    ), '[]') as channels_json,
    coalesce((
      select json_group_array(json_object('id', i.id, 'kind', i.kind, 'date', i."date",
                                          'channel', i.channel, 'summary', i.summary))
      from (
        select id, kind, "date", channel, summary
        from interactions
        where person_id = p.id
        order by "date" desc, id desc
        limit 5
      ) i
    ), '[]') as recent_interactions_json
  from people p
  order by p.slug
`);

// S7 — sync_log: the one-way sync ledger (DECISIONS #13). Every row records
// one synced action (direction out = hub→Trello for now, adapter trello-cli).
// The idempotency contract — a re-run of the same sync adds NO rows — is
// enforced by a composite UNIQUE index over the business identity of a sync
// action: (adapter, direction, entity, entity_id, action). ts/detail are
// deliberately OUTSIDE the key: re-runs never add rows and never rewrite
// history (first log wins). A second log of the same action surfaces as a
// UNIQUE violation the CLI catches and reports as "already logged" (exit 0).
export const syncLog = sqliteTable(
  'sync_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    direction: text('direction').notNull(),
    adapter: text('adapter').notNull(),
    /** Domain synced (e.g. "task") — the table name, not a row type. */
    entity: text('entity').notNull(),
    entityId: integer('entity_id').notNull(),
    action: text('action').notNull(),
    ts: text('ts').notNull(),
    detail: text('detail'),
  },
  (table) => [
    unique('sync_log_idempotency').on(table.adapter, table.direction, table.entity, table.entityId, table.action),
  ],
);
