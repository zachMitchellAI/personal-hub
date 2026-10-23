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

/**
 * Resolve the durable-files root: `$HUB_FILES` if set, otherwise `~/hub/files`
 * (DESIGN.md: durable artifacts live on disk under the slug hierarchy, never
 * base64 in the DB). The path is unresolved — callers resolve it, matching
 * resolveDbPath's contract. Used by the import-vcf verb to write contact
 * photos as real image files.
 * @returns The (unresolved) files root path.
 */
export function resolveFilesPath(): string {
  return process.env.HUB_FILES ?? join(homedir(), 'hub', 'files');
}
