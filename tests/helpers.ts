// Shared test-fixture factory (PII hygiene, owner directive 2026-10-30).
// Every person/task/entity name in tests must come from here — never copied
// from live hub data. Names are clearly fictional; emails use example.test.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

/** Latest ext-gated-free migration version, derived from src/migrations
 * filenames — never hand-pinned. Replaces the per-branch ritual of bumping
 * literals like `user_version === 10` (owner PR-review, 2026-11-11). The
 * vec0 gate (009) is why fresh-init user_version assertions compare against
 * the non-gated max, not the raw file max. */
export function latestNonGatedMigrationVersion(): number {
  const dir = resolve(import.meta.dirname, '..', 'src', 'migrations');
  let max = 0;
  for (const f of readdirSync(dir).filter((f) => /^\d{3}_/.test(f))) {
    if (/^-- REQUIRES-EXT:/m.test(readFileSync(join(dir, f), 'utf8'))) continue;
    max = Math.max(max, Number(f.slice(0, 3)));
  }
  return max;
}

/** Deterministic slug from a fictional name ("Marla Sample" -> "marla-sample"). */
export function slugFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export interface FixturePerson {
  name: string;
  slug: string;
  employer: string;
  email: string;
}

const COMPANY_POOL = ['Acme Corp', 'Sample Holdings', 'Widget LLC', 'Testing Co'];

const NAME_POOL = ['Marla Sample', 'Casey Smith', 'Ada Lovelace', 'Dev Tester', 'Riley Example', 'Morgan Placeholder'];

/** Pick the i-th fictional person; wraps around the pool. */
export function fixturePerson(i = 0): FixturePerson {
  const name = NAME_POOL[i % NAME_POOL.length];
  const employer = COMPANY_POOL[i % COMPANY_POOL.length];
  return {
    name,
    slug: slugFor(name),
    employer,
    email: `person${i}@example.test`,
  };
}

export interface TaskFixture {
  title: string;
  context: string;
}

/** Fictional task fixture. */
export function fixtureTask(i = 0): TaskFixture {
  return { title: `Fixture task ${i + 1}`, context: 'test' };
}

/** Fictional entity fixture. */
export function fixtureEntity(i = 0): { kind: string; label: string } {
  return { kind: 'company', label: COMPANY_POOL[i % COMPANY_POOL.length] };
}

export { HUB };
