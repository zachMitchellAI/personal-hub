// Schema-as-TS: the source of truth for the hub database (DECISIONS item 4).
// drizzle-kit generate turns this into plain SQL migrations in src/migrations/,
// which our own runner (migrations.ts) applies transactionally.
// Stable drizzle-orm 0.45.4, sqlite-core only — no native drivers.
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
