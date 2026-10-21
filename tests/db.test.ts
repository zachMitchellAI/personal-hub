// Adapter-level test: drizzle typed queries must ride the SAME node:sqlite
// connection the CLI uses (sqlite-proxy over node:sqlite, pure JS). Throwaway
// DB only — never ~/hub/life.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eq } from 'drizzle-orm';
import { openHubDb, makeDrizzle } from '../src/core/db.ts';
import { runMigrations } from '../src/migrations.ts';
import { people } from '../src/schema.ts';

const MIGRATIONS = resolve(import.meta.dirname, '..', 'src', 'migrations');

test('S2 adapter: drizzle typed insert/select round-trip over node:sqlite', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-s2-adapter-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');

  const raw = openHubDb(dbPath); // same connection: pragmas asserted here
  runMigrations(raw, MIGRATIONS); // schema on the throwaway db
  const hub = makeDrizzle(raw);
  try {
    const [inserted] = await hub
      .insert(people)
      .values({ slug: 'casey-smith', displayName: 'Casey Smith', createdAt: '2026-10-20T00:00:00.000Z' })
      .returning({ id: people.id, slug: people.slug });
    assert.equal(inserted.slug, 'casey-smith');

    const got = await hub.select().from(people).where(eq(people.slug, 'casey-smith')).get();
    assert.ok(got);
    assert.equal(got.id, inserted.id);
    assert.equal(got.displayName, 'Casey Smith'); // camelCase mapping works
    assert.equal(got.relationshipType, null);

    // Same connection sees the row via raw SQL — one connection, two surfaces.
    const rawRow = raw.prepare('SELECT slug FROM people WHERE id = ?').get(inserted.id) as { slug: string };
    assert.equal(rawRow.slug, 'casey-smith');
  } finally {
    raw.close();
  }
});

test('S2 adapter: duplicate slug raises UNIQUE constraint through drizzle', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'hub-s2-adapter-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const raw = new DatabaseSync(join(tmp, 'life.db'));
  runMigrations(raw, MIGRATIONS);
  const hub = makeDrizzle(raw);
  try {
    await hub.insert(people).values({ slug: 'dup', displayName: 'First', createdAt: '2026-10-20T00:00:00.000Z' }).run();
    await assert.rejects(
      () =>
        hub.insert(people).values({ slug: 'dup', displayName: 'Second', createdAt: '2026-10-20T00:00:00.000Z' }).run(),
      // drizzle wraps driver errors (DrizzleQueryError "Failed query: ...", cause = SqliteError)
      (err: Error) => /UNIQUE constraint failed/.test(String((err as { cause?: Error }).cause?.message ?? err.message)),
    );
  } finally {
    raw.close();
  }
});
