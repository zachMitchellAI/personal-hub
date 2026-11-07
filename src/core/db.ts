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
import { hasVec0, loadVec0 } from './semantic.ts';
import { migrationsPath, resolveDbPath } from './paths.ts';
import * as schema from '../schema.ts';

/** The typed drizzle handle every command uses for SQL (see makeDrizzle). */
export type HubDb = ReturnType<typeof makeDrizzle>;

/**
 * Open a SQLite file with the S1 pragmas asserted. Every connection goes
 * through here: `foreign_keys = ON` is per-connection and MUST be re-asserted
 * on every open; `journal_mode = WAL` is persistent but cheap to re-assert.
 * Never call `new DatabaseSync` directly (AGENTS.md database contract).
 *
 * Constructed with `allowExtension: true` so S13's vec0 extension can load
 * (extension loading is only possible at/near construction); loading itself
 * happens in openDb via loadVec0 and is non-fatal when the .so is absent.
 * @param path - Resolved path to the SQLite database file.
 * @returns An open `DatabaseSync` connection with pragmas set.
 */
export function openHubDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { allowExtension: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * The shared open path for every verb: resolve the path (flag → $HUB_DB →
 * ~/hub/life.db), create parent directories, assert pragmas via openHubDb,
 * and apply pending migrations idempotently so writes always see the full
 * schema. The sqlite-vec extension is loaded before migrations when the .so
 * is present (S13's vec0 virtual tables need it at CREATE time) and its
 * presence is reported back — a machine without a usable vec0 binary opens
 * fine but skips the vector migration and degrades to keyword search. The
 * configured embedding dim (core/config.ts) rides into migration 009 as a
 * token substitution, so the vec0 column width matches the configured model.
 * @param dbFlag - The `--db` flag value, if provided.
 * @returns The open connection, its resolved path, the versions applied, and
 * whether vec0 is usable on this connection.
 */
export function openDb(dbFlag?: string): { db: DatabaseSync; dbPath: string; applied: number[]; vec0: boolean } {
  const dbPath = resolve(resolveDbPath(dbFlag));
  // Mkdir before open — SQLite refuses to create parent directories itself.
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = openHubDb(dbPath);

  // Load vec0 BEFORE migrations: migration 009's CREATE VIRTUAL TABLE ... vec0
  // requires the module. Non-fatal when absent (documented portability
  // caveat) — that connection skips 009 entirely and vector verbs fail
  // cleanly, so keyword search stays the working fallback.
  let vec0 = false;
  try {
    vec0 = loadVec0(db) ? hasVec0(db) : false;
  } catch {
    vec0 = false;
  }

  const dir = migrationsPath();
  const applied = existsSync(dir) ? runMigrations(db, dir, vec0).applied : [];
  return { db, dbPath, applied, vec0 };
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
