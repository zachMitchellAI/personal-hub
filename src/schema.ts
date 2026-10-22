// Schema-as-TS: the source of truth for the hub database (DECISIONS item 4).
// drizzle-kit generate turns this into plain SQL migrations in src/migrations/,
// which our own runner (migrations.ts) applies transactionally.
// Stable drizzle-orm 0.45.4, sqlite-core only — no native drivers.
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

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
export const contactChannels = sqliteTable('contact_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  personId: integer('person_id')
    .notNull()
    .references(() => people.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  primaryFlag: integer('primary_flag').notNull().default(0),
  source: text('source'),
});

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
  (table) => [check('tasks_status_check', sql`${table.status} in ('ready', 'in-progress', 'completed')`)],
);

// S4 — subtasks: checklist items hanging off a task.
// task_id FK → tasks, ON DELETE CASCADE (subtasks are parts of their task).
// position is CLI-assigned (append: max+1 per task) and ordering is by it;
// no reorder verb in S4 scope — positions are write-once in this ticket.
export const subtasks = sqliteTable('subtasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  done: integer('done').notNull().default(0),
  position: integer('position').notNull(),
});

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
export const interactions = sqliteTable('interactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
  kind: text('kind').notNull(),
  date: text('date').notNull(),
  channel: text('channel').notNull(),
  summary: text('summary').notNull(),
  createdAt: text('created_at').notNull(),
});

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
export const trackableEvents = sqliteTable('trackable_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  trackableId: integer('trackable_id')
    .notNull()
    .references(() => trackables.id, { onDelete: 'cascade' }),
  eventDate: text('event_date').notNull(),
  eventType: text('event_type').notNull(),
  notes: text('notes'),
});

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
export const entityLinks = sqliteTable('entity_links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  entityId: integer('entity_id')
    .notNull()
    .references(() => entities.id, { onDelete: 'cascade' }),
  targetType: text('target_type').notNull(),
  targetId: integer('target_id').notNull(),
  note: text('note'),
});

// S7 — files: the index of durable artifacts on disk. The hierarchy convention
// (owner epic note) keeps artifacts under ~/hub/files/<slug>/...; the CLI
// stores the path as given and performs NO disk I/O — the convention is how
// humans/agents organize files, not a write-path rule. kind names the file
// family (pdf/apk/html/image/project); it stays free text with no CHECK — the
// S7 ticket does not request one (unlike tasks.status), and D3 says kinds are
// data. person_id/task_id are nullable FKs with ON DELETE SET NULL (same
// reasoning as tasks/interactions): deleting a person or task must not erase
// the record of a durable artifact that exists independently of them.
export const files = sqliteTable('files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  path: text('path').notNull(),
  kind: text('kind').notNull(),
  personId: integer('person_id').references(() => people.id, { onDelete: 'set null' }),
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  addedAt: text('added_at').notNull(),
  note: text('note'),
});

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
