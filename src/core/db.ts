// sqlite-proxy adapter (owner ruling 2026-10-20, option 1): typed drizzle
// queries ride the same node:sqlite connection the CLI uses for pragmas and
// transactions. Pure JS — drizzle-orm's sqlite-proxy expects the driver
// callback to return { rows }, with rows as value arrays in result-column
// order, which is exactly what StatementSync.setReturnArrays(true) yields.
// Verified against installed drizzle-orm 0.45.4 source (sqlite-proxy/session.js).
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMigrations } from '../migrations.ts';
import { migrationsPath, resolveDbPath } from './paths.ts';
import * as schema from '../schema.ts';

type ProxyMethod = 'run' | 'all' | 'get' | 'values';

export type HubDb = ReturnType<typeof makeDrizzle>;

// Shared open path: pragmas asserted on every connection (foreign_keys is
// per-connection; journal_mode WAL is persistent but cheap to re-assert).
export function openHubDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

// Open the database with the S1 guarantees asserted, migrations applied
// idempotently. Every verb shares this path so writes always see the full schema.
export function openDb(dbFlag?: string): { db: DatabaseSync; dbPath: string; applied: number[] } {
  const dbPath = resolve(resolveDbPath(dbFlag));
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openHubDb(dbPath);

  const dir = migrationsPath();
  const applied = existsSync(dir) ? runMigrations(db, dir).applied : [];
  return { db, dbPath, applied };
}

export function makeDrizzle(db: DatabaseSync) {
  const proxy = (sql: string, params: unknown[], method: ProxyMethod) => {
    const stmt = db.prepare(sql) as StatementSync;
    stmt.setReturnArrays(true);
    if (method === 'run') {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    if (method === 'get') {
      // undefined when no row — drizzle maps that to undefined (no fake row).
      return { rows: stmt.get(...(params as never[])) };
    }
    return { rows: stmt.all(...(params as never[])) }; // 'all' and 'values'
  };
  return drizzle(proxy, { schema });
}