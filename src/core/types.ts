/**
 * Shared CLI types: JSON/status shapes and verb-handler contracts.
 *
 * Status interfaces: snake_case keys are the machine-readable `--json`
 * contract; drizzle rows use camelCase and are mapped in `commands/*`.
 * Changing any of these shapes is a breaking CLI contract change.
 */

/** `hub init --json` result: S1 guarantees and what the init actually did. */
export interface InitStatus {
  verb: 'init';
  db: string;
  journal_mode: string;
  foreign_keys: boolean;
  user_version: number;
  migrations_applied: number[];
  ok: boolean;
}

/** `hub add-person --json` result for a newly created person row. */
export interface AddPersonStatus {
  verb: 'add-person';
  /** Database row id (autoincrement primary key). */
  id: number;
  /** Immutable lowercase-dashed slug (may differ from the input via --slug). */
  slug: string;
  created_at: string;
}

/** A person row as emitted by `--json` (snake_case CLI contract). */
export interface PersonJson {
  id: number;
  slug: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  relationship_type: string | null;
  employer: string | null;
  notes: string | null;
  created_at: string;
}

/** One contact channel row as emitted by `--json` (snake_case CLI contract). */
export interface ChannelJson {
  id: number;
  person_id: number;
  kind: string;
  value: string;
  primary_flag: number;
  source: string | null;
}

/** `hub add-channel --json` result: the created channel, echoed with its person's slug. */
export interface AddChannelStatus {
  verb: 'add-channel';
  id: number;
  person_id: number;
  slug: string;
  kind: string;
  value: string;
  primary_flag: number;
  source: string | null;
}

/** `hub list-channels --json` result for one person. */
export interface ListChannelsStatus {
  verb: 'list-channels';
  slug: string;
  person_id: number;
  count: number;
  channels: ChannelJson[];
}

/** `hub set-primary --json` result. */
export interface SetPrimaryStatus {
  verb: 'set-primary';
  id: number;
  person_id: number;
  slug: string;
  kind: string;
  primary_flag: number;
}

/** `hub remove-channel --json` result. */
export interface RemoveChannelStatus {
  verb: 'remove-channel';
  /** Echoed channel id. */
  id: number;
  /** Always true on success — the verb exits non-zero on any failure. */
  removed: boolean;
}

/**
 * Parsed `--flags` from `node:util` parseArgs, shared by every verb.
 * Values arrive unvalidated: handlers must narrow/cast per-verb, which is
 * why verb-specific value interfaces (below) declare what each verb consumes.
 */
export type CliValues = Record<string, string | boolean | undefined>;

/**
 * Flags consumed by `hub add-person`, on top of the shared `--db`/`--json`.
 * Declared here so the handler's input contract is visible in types.ts:
 * `name` is required at runtime (the handler re-checks) and `slug` is the
 * optional lowercase-dashed override.
 */
export interface AddPersonValues extends CliValues {
  /** Display name — required; the CLI derives the slug from it if --slug is absent. */
  name?: string;
  /** Optional slug override; must already be lowercase-dashed or the verb errors. */
  slug?: string;
}

/**
 * A verb handler takes parsed flags, an optional positional argument (the
 * second positional: slug or channel id), and returns the process exit code.
 */
// Note: plain object maps, not TS enums — enums are not erasable syntax and
// crash under Node 24's type stripping.
export type VerbHandler = (values: CliValues, positional?: string) => number | Promise<number>;
