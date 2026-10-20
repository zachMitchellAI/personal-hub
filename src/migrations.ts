// Migration runner for the hub database.
// Contract (S1): numbered SQL files (NNN_name.sql), applied in order, each in a
// single transaction that also bumps PRAGMA user_version. Any failure rolls the
// migration back fully — partial DDL never survives.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const MIGRATION_RE = /^(\d{3,})_[a-z0-9_-]+\.sql$/;

interface MigrationResult {
  applied: number[];
  version: number;
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function runMigrations(db: DatabaseSync, dir: string): MigrationResult {
  const files = readdirSync(dir)
    .filter((f) => MIGRATION_RE.test(f))
    .sort();

  const current = getUserVersion(db);
  const applied: number[] = [];

  for (const file of files) {
    const version = Number(file.match(MIGRATION_RE)![1]);
    if (version <= current) continue;

    const sql = readFileSync(join(dir, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      if (db.isTransaction) db.exec('COMMIT');
      applied.push(version);
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }

  return { applied, version: getUserVersion(db) };
}