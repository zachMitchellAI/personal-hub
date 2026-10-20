// Shared CLI types: JSON/status shapes and verb-handler contracts.
// Status interfaces: snake_case keys are the machine-readable --json contract;
// drizzle rows use camelCase and are mapped in commands/*.
export interface InitStatus {
  verb: 'init';
  db: string;
  journal_mode: string;
  foreign_keys: boolean;
  user_version: number;
  migrations_applied: number[];
  ok: boolean;
}

export interface AddPersonStatus {
  verb: 'add-person';
  id: number;
  slug: string;
  created_at: string;
}

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

export interface ChannelJson {
  id: number;
  person_id: number;
  kind: string;
  value: string;
  primary_flag: number;
  source: string | null;
}

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

export interface ListChannelsStatus {
  verb: 'list-channels';
  slug: string;
  person_id: number;
  count: number;
  channels: ChannelJson[];
}

export interface SetPrimaryStatus {
  verb: 'set-primary';
  id: number;
  person_id: number;
  slug: string;
  kind: string;
  primary_flag: number;
}

export interface RemoveChannelStatus {
  verb: 'remove-channel';
  id: number;
  removed: boolean;
}

// parseArgs output shape shared by every verb.
export type CliValues = Record<string, string | boolean | undefined>;

// A verb handler takes parsed flags, an optional positional argument (the
// second positional: slug or channel id), and returns the process exit code.
// Note: plain object maps, not TS enums — enums are not erasable syntax and
// crash under Node 24's type stripping.
export type VerbHandler = (values: CliValues, positional?: string) => number | Promise<number>;