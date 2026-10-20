// Environment-driven path resolution for the hub CLI.
import { join } from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';

export function resolveDbPath(dbFlag?: string): string {
  return dbFlag ?? process.env.HUB_DB ?? join(homedir(), 'hub', 'life.db');
}

// This file lives in src/core/, but the migrations directory sits beside the
// entry point in src/ — hence the '..'.
export function migrationsPath(): string {
  return process.env.HUB_MIGRATIONS ?? join(import.meta.dirname, '..', 'migrations');
}