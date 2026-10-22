// S9 — shell tab-completion (stories/epic-schema.md S9). A hidden verb that
// emits completion candidates one per line (the standard convention shells
// expect), so the same endpoint serves both thin shell scripts and agents
// asking "what values are valid here?".
//
// Three tiers, in the order the ticket defines them:
//   1. static — verbs, then per-verb flags, from the same VERBS/flags
//      registry the dispatcher uses (src/registry.ts);
//   2. dynamic values — person slugs (the list-people query), task/trackable
//      statuses (TASK_STATUSES / TRACKABLE_STATUSES), distinct interaction
//      kinds;
//   3. agents get the same endpoint free — "what statuses are valid?" is
//      literally the same call a shell makes on Tab.
// Pure additive CLI surface: no schema or migration impact (user_version
// stays at 7).
import { makeDrizzle, openDb } from '../core/db.ts';
import { interactions, people } from '../schema.ts';
import { ENTITY_LINK_TARGETS, SYNC_DIRECTIONS, TASK_STATUSES, TRACKABLE_STATUSES } from '../core/constants.ts';
import { optionType, VERB_FLAGS, VERBS } from '../registry.ts';
import type { CliValues } from '../core/types.ts';
import process from 'node:process';

/** Global flags offered for every verb (plus the verb's own VERB_FLAGS list). */
const GLOBAL_FLAGS = ['db', 'json', 'help'] as const;

/** Flags whose values complete from static registry/constant data (no DB). */
const STATIC_VALUES: Partial<Record<string, readonly string[]>> = {
  'target-type': ENTITY_LINK_TARGETS,
  direction: SYNC_DIRECTIONS,
  done: ['0', '1'],
};

// Verbs whose --status means a trackable lifecycle (active/closed) rather
// than a task's (ready/in-progress/completed).
const TRACKABLE_VERBS = new Set(['add-trackable', 'set-trackable-status', 'list-trackables']);

// Verbs whose --kind means an interaction kind — the one kind family the
// ticket asks us to mine from live data (distinct kinds in the DB).
const INTERACTION_KIND_VERBS = new Set(['add-interaction', 'list-interactions']);

// Verbs whose positional argument is a person slug (the S2 slug-identity
// verbs). add-* verbs take row ids, which are not human-completable.
const SLUG_POSITIONAL_VERBS = new Set(['get-person', 'list-channels', 'list-entity-links']);

/**
 * Print candidates one per line — the convention every shell's completion
 * machinery expects. One candidate per line, nothing else on stdout.
 */
function printCandidates(candidates: string[]): void {
  for (const c of candidates) console.log(c);
}

/**
 * Live person slugs, ordered by slug — exactly the list-people query, run
 * through the same openDb path so a fresh DB is migrated (and therefore
 * queryable) rather than crashing the completion.
 * @param values - Parsed CLI flags (`--db` rides along for live queries).
 * @returns The ordered slug list.
 */
async function personSlugs(values: CliValues): Promise<string[]> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const rows = await hub.select({ slug: people.slug }).from(people).orderBy(people.slug).all();
    return rows.map((r) => r.slug);
  } finally {
    db.close();
  }
}

/**
 * Distinct interaction kinds in the DB, sorted. Kinds are data (DESIGN.md
 * D3), so the live set is the truth — a kind that was never used offers
 * nothing, one that was used once offers itself.
 * @param values - Parsed CLI flags.
 * @returns The sorted distinct kind list.
 */
async function interactionKinds(values: CliValues): Promise<string[]> {
  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const rows = await hub.selectDistinct({ kind: interactions.kind }).from(interactions).all();
    return rows
      .map((r) => r.kind)
      .filter((k) => k.length > 0)
      .sort();
  } finally {
    db.close();
  }
}

/**
 * Candidates for the value of one flag, given the verb it appeared under.
 * Dynamic tiers first (person slugs, statuses, interaction kinds), then the
 * static registry values; anything else offers nothing.
 * @param values - Parsed CLI flags.
 * @param verb - The verb on the command line (disambiguates --status/--kind).
 * @param flag - The flag name, without the leading dashes.
 * @param prefix - The partial value the user has typed so far.
 * @returns The matching candidate values.
 */
async function flagValueCandidates(values: CliValues, verb: string, flag: string, prefix: string): Promise<string[]> {
  let pool: readonly string[] = [];
  if (flag === 'person') {
    pool = await personSlugs(values);
  } else if (flag === 'status') {
    pool = TRACKABLE_VERBS.has(verb) ? TRACKABLE_STATUSES : TASK_STATUSES;
  } else if (flag === 'kind' && INTERACTION_KIND_VERBS.has(verb)) {
    pool = await interactionKinds(values);
  } else if (STATIC_VALUES[flag]) {
    pool = STATIC_VALUES[flag] as readonly string[];
  }
  return pool.filter((v) => v.startsWith(prefix));
}

/**
 * `hub __complete <partial-words...>`: emit completion candidates, one per
 * line. Accepts either the shell-wired form (one argument per word, the last
 * being the partial word being completed) or the quoted single-argument form
 * (e.g. `hub __complete "add-interaction --"`), which is split on spaces so
 * both behave identically.
 *
 * Because `node:util` parseArgs consumes `--flag value` pairs and the `--`
 * terminator, a partially-typed flag value or trailing `--` vanishes from
 * the positionals before this handler runs: hub.ts re-appends a trailing
 * `--`, and this handler recovers a partial flag value from the raw argv
 * (second-to-last raw word being a known string flag means that flag's value
 * is what the user is typing).
 *
 * @param values - Parsed CLI flags (`--db` rides along for live queries).
 * @param rawWords - Everything after the `__complete` verb itself.
 * @returns Process exit code (always 0 — completion never fails the shell).
 */
export async function cmdComplete(values: CliValues, rawWords: string[]): Promise<number> {
  // The Gherkin-style invocation passes the whole tail as ONE argument
  // ("add-interaction --"); the shell script passes one argument per word.
  // Splitting a lone spaced argument makes both behave identically.
  let words = rawWords.length === 1 && rawWords[0].includes(' ') ? rawWords[0].split(' ') : [...rawWords];

  // Recover a partial flag value that parseArgs consumed (see doc comment):
  // raw argv's second-to-last word being a known string flag means that
  // flag's value is the word being completed.
  const raw = process.argv.slice(2);
  if (words.length > 0 && raw.length >= 2) {
    const prevRaw = raw[raw.length - 2];
    const flag = prevRaw.startsWith('--') ? prevRaw.slice(2) : null;
    if (flag && optionType(flag) === 'string') {
      words = [words[0], prevRaw, raw[raw.length - 1]];
    }
  }

  const toComplete = words.length > 0 ? words[words.length - 1] : '';
  const context = words.length > 1 ? words.slice(0, -1) : [];

  // Tier 1a — verb names (nothing before the word being completed).
  if (context.length === 0) {
    printCandidates(Object.keys(VERBS).filter((v) => v.startsWith(toComplete)));
    return 0;
  }

  const verb = context[0];

  // Tier 1b — flag names (the word being completed starts with a dash).
  // __complete itself is deliberately never offered: it is a hidden verb.
  if (toComplete.startsWith('-')) {
    const names = [...(VERB_FLAGS[verb] ?? []), ...GLOBAL_FLAGS].map((f) => `--${f}`);
    printCandidates(names.filter((f) => f.startsWith(toComplete)));
    return 0;
  }

  // Tier 2/3 — value of the previous word when that word takes a value.
  const prev = context[context.length - 1];
  if (prev.startsWith('--')) {
    const flag = prev.slice(2);
    if (optionType(flag) === 'string') {
      printCandidates(await flagValueCandidates(values, verb, flag, toComplete));
      return 0;
    }
  }

  // Positional completion: slugs for the slug-taking verbs.
  if (SLUG_POSITIONAL_VERBS.has(verb)) {
    printCandidates((await personSlugs(values)).filter((s) => s.startsWith(toComplete)));
  }
  return 0;
}
