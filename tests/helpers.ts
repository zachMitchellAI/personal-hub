// Shared test-fixture factory (PII hygiene, owner directive 2026-10-30).
// Every person/task/entity name in tests must come from here — never copied
// from live hub data. Names are clearly fictional; emails use example.test.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Throwaway scratch dir for one test (DB, files, config all live inside). */
function makeTmp(prefix = 'hub-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Spawn the real CLI (the tests-are-CLI-level contract) with extra env. */
function runHub(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [HUB, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

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

export interface ChannelFixture {
  kind: string;
  value: string;
}

/** Fictional channel fixture — emails stay on example.test (PII rule). */
export function fixtureChannel(i = 0): ChannelFixture {
  return { kind: 'email', value: `channel${i}@example.test` };
}

export interface InteractionFixture {
  kind: string;
  date: string;
  channel: string;
  summary: string;
}

/** Deterministic ISO date for interaction i (fixed month, day varies). */
function interactionDate(i: number): string {
  return `2026-11-${String((i % 28) + 1).padStart(2, '0')}`;
}

/** Fictional interaction fixture; date is deterministic, never "today". */
export function fixtureInteraction(i = 0): InteractionFixture {
  return {
    kind: 'call',
    date: interactionDate(i),
    channel: fixtureChannel(i).value,
    summary: `Fixture interaction ${i + 1}`,
  };
}

export interface FileFixture {
  path: string;
  kind: string;
}

/** Fictional file fixture — paths follow the ~/hub/files/<slug>/ convention. */
export function fixtureFile(i = 0): FileFixture {
  return { path: `~/hub/files/fixture-${i + 1}/note.pdf`, kind: 'pdf' };
}

export interface TrackableFixture {
  label: string;
  kind: string;
}

/** Fictional trackable fixture (a process with a lifecycle). */
export function fixtureTrackable(i = 0): TrackableFixture {
  return { label: `Fixture trackable ${i + 1}`, kind: 'application' };
}

/** CLI argv for `hub add-person` from a person fixture. */
export function personArgs(person: FixturePerson): string[] {
  return ['add-person', '--name', person.name, '--employer', person.employer];
}

/** CLI argv for `hub add-task` from a task fixture (context required). */
export function taskArgs(task: TaskFixture): string[] {
  return ['add-task', '--title', task.title, '--context', task.context];
}

/** CLI argv for `hub add-entity` from an entity fixture. */
export function entityArgs(entity: { kind: string; label: string }): string[] {
  return ['add-entity', '--kind', entity.kind, '--label', entity.label];
}

/** CLI argv for `hub add-channel <person-slug>` from a channel fixture. */
export function channelArgs(personSlug: string, channel: ChannelFixture): string[] {
  return ['add-channel', personSlug, '--kind', channel.kind, '--value', channel.value];
}

/** CLI argv for `hub add-interaction` from an interaction fixture. */
export function interactionArgs(interaction: InteractionFixture): string[] {
  return [
    'add-interaction',
    '--kind',
    interaction.kind,
    '--date',
    interaction.date,
    '--channel',
    interaction.channel,
    '--summary',
    interaction.summary,
  ];
}

/** CLI argv for `hub add-file` from a file fixture. */
export function fileArgs(file: FileFixture): string[] {
  return ['add-file', '--path', file.path, '--kind', file.kind];
}

/** CLI argv for `hub add-trackable` from a trackable fixture. */
export function trackableArgs(trackable: TrackableFixture): string[] {
  return ['add-trackable', '--label', trackable.label, '--kind', trackable.kind];
}

export { HUB, makeTmp, runHub };
export type { RunResult };
