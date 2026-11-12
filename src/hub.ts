#!/usr/bin/env node
// hub — deterministic CLI for the personal hub (the CLI core).
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
import { PARSE_ARGS_OPTIONS } from './core/registry-data.ts';

/**
 * Dispatch to the registered verb handler, loading the handler registry on
 * demand. The heavy `registry.ts` import pulls every command module → db →
 * schema → drizzle (~700ms of the ~850ms cold start), which `hub __complete`
 * never needs — it is dispatched below BEFORE this is called, so a tab press
 * costs ~100ms instead of the full graph (perf pass 2026-10-24).
 * @param values - Parsed CLI flags.
 * @param verb - The verb name from positionals[0] (not `__complete`).
 * @param positionals - Full parsed positionals (handlers may read positionals[1]).
 * @returns The handler's process exit code.
 */
async function dispatchVerb(values: CliValues, verb: string, positionals: string[]): Promise<number> {
  const { VERBS } = await import('./registry.ts');
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
    // parseArgs throws on a partially-typed flag word (`hub __complete
    // add-task --ti` — the flag doesn't exist yet, so "argument missing"-
    // style errors fire) and the stock catch would offer nothing on Tab.
    // Re-dispatch with the RAW argv instead: the completion handler knows
    // how to recover a swallowed flag value, and needs a --db scanned by
    // hand because parseArgs never produced a values object.
    if (process.argv.slice(2).includes('__complete')) {
      const raw = process.argv.slice(2).filter((w) => w !== '__complete');
      const dbIdx = raw.indexOf('--db');
      const dbEq = raw.find((w) => w.startsWith('--db='));
      const db = dbEq !== undefined ? dbEq.slice(5) : dbIdx >= 0 && dbIdx + 1 < raw.length ? raw[dbIdx + 1] : undefined;
      const drop = new Set<number>();
      if (dbEq !== undefined) drop.add(raw.indexOf(dbEq));
      if (db !== undefined && dbIdx >= 0) {
        drop.add(dbIdx);
        drop.add(dbIdx + 1);
      }
      const { cmdComplete } = await import('./commands/completion.ts');
      return await cmdComplete(
        { db } as CliValues,
        raw.filter((_, i) => !drop.has(i)),
        true,
      );
    }
    throw err;
  }

  const verb = positionals[0];

  if (values.help || !verb) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  // Hidden verb — dispatched before the VERBS lookup so it stays out of
  // help text and verb-name completions. It needs the FULL positional tail
  // (one word per shell word), not just positionals[1]. Its handler is
  // imported on demand too: completion never touches the drizzle graph.
  if (verb === '__complete') {
    // parseArgs consumes a trailing `--` as the option terminator, but the
    // shell passes it as the partial word when the user typed `hub add-task
    // --<TAB>`. Re-append it when the raw argv literally ended with `--`.
    if (process.argv[process.argv.length - 1] === '--') positionals.push('--');
    const { cmdComplete } = await import('./commands/completion.ts');
    return await cmdComplete(values, positionals.slice(1));
  }

  return await dispatchVerb(values, verb, positionals);
}

try {
  process.exit(await main());
} catch (err: unknown) {
  console.error('hub:', err instanceof Error ? err.message : String(err));
  process.exit(1);
}
