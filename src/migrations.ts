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
  /** Extension-gated migration files skipped this run (extension absent). */
  skipped: string[];
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
 *
 * Migrations may declare `-- REQUIRES-EXT: vec0` in their header comments
 * (S13's vector tables need the sqlite-vec module at CREATE time). On a
 * connection without that extension such files are skipped — the runner
 * returns them under `skipped`, the database stays at the last applicable
 * version, and every later open re-evaluates the skip (so a machine that
 * gains the .so upgrades on its next open).
 * @param db - An open `DatabaseSync` connection (pragmas already asserted).
 * @param dir - Directory containing `NNN_name.sql` migration files.
 * @param vec0 - Whether the sqlite-vec extension is usable on this connection.
 * @throws When a migration file's SQL fails; the transaction is rolled back first.
 * @returns The versions applied this run, the resulting user_version, and any
 * extension-gated files skipped this run.
 */
export function runMigrations(db: DatabaseSync, dir: string, vec0 = true): MigrationResult {
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_RE.test(f))
    .sort();

  const current = getUserVersion(db);
  const applied: number[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    // Re-match against the regex to extract the numeric version for this file.
    const version = Number(file.match(MIGRATION_RE)![1]);
    if (version <= current) continue;

    // Extension gate: an ext-requiring migration on an ext-less connection is
    // skipped (not failed) so the whole CLI stays usable without vec0.
    const sql = readFileSync(join(dir, file), 'utf8');
    if (/^-- REQUIRES-EXT: (\S+)/m.test(sql)) {
      const ext = sql.match(/^-- REQUIRES-EXT: (\S+)/m)![1];
      const available = ext === 'vec0' ? vec0 : false;
      if (!available) {
        skipped.push(file);
        continue;
      }
    }

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

  return { applied, version: getUserVersion(db), skipped };
}
