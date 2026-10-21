// Environment-driven path resolution for the hub CLI.
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

/**
 * Resolve the database file path, in strict precedence order:
 * 1. The `--db` CLI flag, if provided.
 * 2. The `$HUB_DB` environment variable.
 * 3. The default: `~/hub/life.db`.
 * @param dbFlag - The `--db` flag value, if provided.
 * @returns The (unresolved — caller resolves) database path.
 */
export function resolveDbPath(dbFlag?: string): string {
  return dbFlag ?? process.env.HUB_DB ?? join(homedir(), 'hub', 'life.db');
}

/**
 * Resolve the migrations directory: `$HUB_MIGRATIONS` if set, otherwise the
 * `migrations/` folder beside the entry point in `src/`. This file lives in
 * `src/core/`, hence the `'..'`.
 * @returns The migrations directory path.
 */
export function migrationsPath(): string {
  return process.env.HUB_MIGRATIONS ?? join(import.meta.dirname, '..', 'migrations');
}
