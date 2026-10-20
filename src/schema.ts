// Schema-as-TS: the source of truth for the hub database (DECISIONS item 4).
// drizzle-kit generate turns this into plain SQL migrations in src/migrations/,
// which our own runner (migrations.ts) applies transactionally.
// Stable drizzle-orm 0.45.4, sqlite-core only — no native drivers.
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
