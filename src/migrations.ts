// Migration runner for the hub database.
// Contract (S1): numbered SQL files (NNN_name.sql), applied in order, each in a
// single transaction that also bumps PRAGMA user_version. Any failure rolls the
// migration back fully — partial DDL never survives.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Migrations are NNN_name.sql: 3+ digit zero-padded version, lowercase-dashed name.
const MIGRATION_RE = /^(\d{3,})_[a-z0-9_-]+\.sql$/;

/** What runMigrations did: versions applied this run and the final user_version. */
interface MigrationResult {
  applied: number[];
  version: number;
}

/**
 * Read the database's current `PRAGMA user_version` (the applied-migrations
 * watermark).
 * @param db - An open `DatabaseSync` connection.
 * @returns The current user_version, 0 for a fresh database.
 */
function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Apply all pending migrations, in version order, each in its own transaction.
 * Skips any migration whose version is ≤ the current user_version, so runs are
 * idempotent. The user_version bump happens inside the same transaction as the
 * migration SQL — a failed migration leaves the version (and schema) untouched.
 * @param db - An open `DatabaseSync` connection (pragmas already asserted).
 * @param dir - Directory containing `NNN_name.sql` migration files.
 * @throws When a migration file's SQL fails; the transaction is rolled back first.
 * @returns The versions applied this run and the resulting user_version.
 */
export function runMigrations(db: DatabaseSync, dir: string): MigrationResult {
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_RE.test(f))
    .sort();

  const current = getUserVersion(db);
  const applied: number[] = [];

  for (const file of files) {
    // Re-match against the regex to extract the numeric version for this file.
    const version = Number(file.match(MIGRATION_RE)![1]);
    if (version <= current) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      // user_version is transactional here — it only lands if the COMMIT lands.
      db.exec(`PRAGMA user_version = ${version}`);
      if (db.isTransaction) db.exec('COMMIT');
      applied.push(version);
    } catch (err) {
      // Roll back so partial DDL never survives a failed migration.
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }

  return { applied, version: getUserVersion(db) };
}
