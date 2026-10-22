// hub — deterministic CLI for the personal hub (DESIGN.md layer 2).
// Zero npm dependencies (drizzle-orm is pure JS; adapter in db.ts bridges it
// onto the node:sqlite connection used for pragmas/transactions).
// Contract: writes go through here; freeform SQL elsewhere is read-only.
//
// This file is the entry point only: arg parsing, verb dispatch, and top-level
// error handling. The verb/flag registry lives in registry.ts (extracted in
// S9 so the completion engine can share it), shared plumbing in core/
// (constants, types, paths, util, db), verbs in commands/, domain model at
// root (schema.ts, migrations).
import { parseArgs } from 'node:util';
import process from 'node:process';
import { USAGE } from './core/constants.ts';
import type { CliValues } from './core/types.ts';
import { PARSE_ARGS_OPTIONS, VERBS } from './registry.ts';
import { cmdComplete } from './commands/completion.ts';

/**
 * Parse argv, dispatch to the registered verb, and return its exit code.
 * No verb (or --help) prints usage; unknown verbs print usage to stderr.
 * All other errors propagate to the top-level handler below.
 * @returns The process exit code for the CLI run.
 */
async function main(): Promise<number> {
  let values: CliValues;
  let positionals: string[];
  try {
    // Inline destructure keeps parseArgs' `as const`-narrowed values type
    // (annotating the result as ReturnType<typeof parseArgs> widens it and
    // breaks CliValues assignability).
    const parsed = parseArgs({ allowPositionals: true, options: PARSE_ARGS_OPTIONS });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err: unknown) {
    if (process.argv.slice(2).includes('__complete')) return 0;
    throw err;
  }

  const verb = positionals[0];

  if (values.help || !verb) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  // Hidden verb — dispatched before the VERBS lookup so it stays out of
  // help text and verb-name completions. It needs the FULL positional tail
  // (one word per shell word), not just positionals[1].
  if (verb === '__complete') {
    // parseArgs consumes a trailing `--` as the option terminator, but the
    // shell passes it as the partial word when the user typed `hub add-task
    // --<TAB>`. Re-append it when the raw argv literally ended with `--`.
    if (process.argv[process.argv.length - 1] === '--') positionals.push('--');
    return await cmdComplete(values, positionals.slice(1));
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
