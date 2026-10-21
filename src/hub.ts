// hub — deterministic CLI for the personal hub (DESIGN.md layer 2).
// Zero npm dependencies (drizzle-orm is pure JS; adapter in db.ts bridges it
// onto the node:sqlite connection used for pragmas/transactions).
// Contract: writes go through here; freeform SQL elsewhere is read-only.
//
// This file is the entry point only: arg parsing, verb dispatch, and top-level
// error handling. Shared plumbing lives in core/ (constants, types, paths,
// util, db), verbs in commands/, domain model at root (schema.ts, migrations).
import { parseArgs } from 'node:util';
import process from 'node:process';
import { USAGE } from './core/constants.ts';
import type { VerbHandler } from './core/types.ts';
import { cmdInit } from './commands/init.ts';
import { cmdAddPerson, cmdGetPerson, cmdListPeople } from './commands/people.ts';
import { cmdAddChannel, cmdListChannels, cmdRemoveChannel, cmdSetPrimary } from './commands/channels.ts';

/**
 * Verb registry — the single source of truth for the verb → handler mapping.
 * Adding a verb means adding a `cmd*` export in `commands/` and one line here.
 * Plain object map, not a TS enum: enums are not erasable syntax and crash
 * under Node 24's type stripping.
 */
const VERBS: Record<string, VerbHandler> = {
  // init takes scalar flags rather than a positional, so it gets a tiny adapter.
  init: (values) => cmdInit(values.db as string | undefined, values.json === true),
  'add-person': cmdAddPerson,
  'get-person': cmdGetPerson,
  'list-people': cmdListPeople,
  'add-channel': cmdAddChannel,
  'list-channels': cmdListChannels,
  'remove-channel': cmdRemoveChannel,
  'set-primary': cmdSetPrimary,
};

const PARSE_ARGS_OPTIONS = {
  db: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  name: { type: 'string' },
  'first-name': { type: 'string' },
  'last-name': { type: 'string' },
  'relationship-type': { type: 'string' },
  employer: { type: 'string' },
  notes: { type: 'string' },
  slug: { type: 'string' },
  kind: { type: 'string' },
  value: { type: 'string' },
  source: { type: 'string' },
  primary: { type: 'boolean', default: false },
} as const;

/**
 * Parse argv, dispatch to the registered verb, and return its exit code.
 * No verb (or --help) prints usage; unknown verbs print usage to stderr.
 * All other errors propagate to the top-level handler below.
 * @returns The process exit code for the CLI run.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: PARSE_ARGS_OPTIONS,
  });

  const verb = positionals[0];

  if (values.help || !verb) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  const handler = VERBS[verb];
  if (!handler) {
    console.error(`hub: unknown verb "${verb}"`);
    console.error(USAGE);
    return 1;
  }

  // Second positional (slug or channel id) rides along; handlers that don't
  // need it simply ignore it.
  return await handler(values, positionals[1]);
}

try {
  process.exit(await main());
} catch (err: unknown) {
  console.error('hub:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
