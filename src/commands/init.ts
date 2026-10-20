// init verb: create/upgrade the database and report S1 guarantees.
import { openDb } from '../core/db.ts';
import type { InitStatus } from '../core/types.ts';

export function cmdInit(dbFlag?: string, json?: boolean): number {
  const { db, dbPath, applied } = openDb(dbFlag);
  try {
    const journal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };

    const status: InitStatus = {
      verb: 'init',
      db: dbPath,
      journal_mode: journal.journal_mode,
      foreign_keys: fk.foreign_keys === 1,
      user_version: uv.user_version,
      migrations_applied: applied,
      ok: true,
    };

    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(
        `hub init: ${dbPath} (wal=${status.journal_mode}, fk=${status.foreign_keys}, user_version=${status.user_version})`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}