// sqlite-proxy adapter (owner ruling 2026-10-20, option 1): typed drizzle
// queries ride the same node:sqlite connection the CLI uses for pragmas and
// transactions. Pure JS — drizzle-orm's sqlite-proxy expects the driver
// callback to return { rows }, with rows as value arrays in result-column
// order, which is exactly what StatementSync.setReturnArrays(true) yields.
// Verified against installed drizzle-orm 0.45.4 source (sqlite-proxy/session.js).
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import type { RemoteCallback } from 'drizzle-orm/sqlite-proxy';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMigrations } from '../migrations.ts';
import { migrationsPath, resolveDbPath } from './paths.ts';
import * as schema from '../schema.ts';

/** The typed drizzle handle every command uses for SQL (see makeDrizzle). */
export type HubDb = ReturnType<typeof makeDrizzle>;

/**
 * Open a SQLite file with the S1 pragmas asserted. Every connection goes
 * through here: `foreign_keys = ON` is per-connection and MUST be re-asserted
 * on every open; `journal_mode = WAL` is persistent but cheap to re-assert.
 * Never call `new DatabaseSync` directly (AGENTS.md database contract).
 * @param path - Resolved path to the SQLite database file.
 * @returns An open `DatabaseSync` connection with pragmas set.
 */
export function openHubDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * The shared open path for every verb: resolve the path (flag → $HUB_DB →
 * ~/hub/life.db), create parent directories, assert pragmas via openHubDb,
 * and apply pending migrations idempotently so writes always see the full
 * schema.
 * @param dbFlag - The `--db` flag value, if provided.
 * @returns The open connection, its resolved path, and the versions applied.
 */
export function openDb(dbFlag?: string): { db: DatabaseSync; dbPath: string; applied: number[] } {
  const dbPath = resolve(resolveDbPath(dbFlag));
  // Mkdir before open — SQLite refuses to create parent directories itself.
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openHubDb(dbPath);

  const dir = migrationsPath();
  const applied = existsSync(dir) ? runMigrations(db, dir).applied : [];
  return { db, dbPath, applied };
}

/**
 * Bridge node:sqlite onto drizzle-orm's sqlite-proxy. The proxy callback
 * prepares a statement with array results (value arrays in column order —
 * what sqlite-proxy requires) and shapes the response per access method.
 * Declared async to satisfy drizzle's RemoteCallback (Promise-wrapped result);
 * the body itself runs synchronously, so awaited drizzle operations execute
 * inside any open `BEGIN`/`COMMIT` transaction on the underlying connection.
 * @param db - An open (pragma-asserted) `DatabaseSync` connection.
 * @returns The typed drizzle handle (`HubDb`) used by all commands.
 */
export function makeDrizzle(db: DatabaseSync) {
  const proxy: RemoteCallback = async (sql, params, method) => {
    const stmt = db.prepare(sql) as StatementSync;
    stmt.setReturnArrays(true);
    if (method === 'run') {
      stmt.run(...(params as never[]));
      return { rows: [] };
    }
    if (method === 'get') {
      // undefined when no row — drizzle maps that to undefined (no fake row).
      // setReturnArrays(true) makes this a value-array row, which the
      // StatementSync types can't express — hence the cast.
      return { rows: stmt.get(...(params as never[])) as unknown as unknown[] };
    }
    // 'all' and 'values': rows of value arrays.
    return { rows: stmt.all(...(params as never[])) as unknown as unknown[][] };
  };
  return drizzle(proxy, { schema });
}
