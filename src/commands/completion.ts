// S9 — shell tab-completion (stories/epic-schema.md S9). A hidden verb that
// emits completion candidates one per line (the standard convention shells
// expect), so the same endpoint serves both thin shell scripts and agents
// asking "what values are valid here?".
//
// Three tiers, in the order the ticket defines them:
//   1. static — verbs, then per-verb flags, from the DATA-ONLY registry
//      (core/registry-data.ts) — importing command modules here was paying
//      ~700ms of drizzle/schema per tab press (perf pass 2026-10-24);
//   2. dynamic values — person slugs, task/trackable statuses, distinct
//      interaction kinds;
//   3. agents get the same endpoint free — "what statuses are valid?" is
//      literally the same call a shell makes on Tab.
//
// The dynamic tier reads the DB with raw read-only SQL over `node:sqlite`
// (repo contract: freeform SQL is allowed for reads) so the completion path
// never imports the drizzle adapter — and never runs migrations: a tab press
// is a read and must not mutate schema state, even idempotently. A missing
// table therefore offers nothing instead of crashing the shell (covers
// throwaway/foreign `--db` files).
//
// Pure additive CLI surface: no schema or migration impact (user_version
// stays at 7).
import { DatabaseSync } from 'node:sqlite';
import { resolveDbPath } from '../core/paths.ts';
import { ENTITY_LINK_TARGETS, SYNC_DIRECTIONS, TASK_STATUSES, TRACKABLE_STATUSES } from '../core/constants.ts';
import { REQUIRED_FLAGS, optionType, VERB_FLAGS, VERB_NAMES } from '../core/registry-data.ts';
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
 * Open the completion DB connection with the S1 pragmas asserted — the same
 * guarantee openHubDb gives, minus the migrations (completion is read-only;
 * see the module comment). Direct `new DatabaseSync` here is deliberate and
 * documented: routing through openDb would import the drizzle adapter.
 * @param dbPath - Optional `--db` override.
 * @returns An open pragma-asserted connection (caller closes it).
 */
function openCompletionDb(dbPath?: string): DatabaseSync {
  const path = resolveDbPath(dbPath);
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Live person slugs, ordered by slug — the list-people query, as raw
 * read-only SQL so the completion path stays drizzle-free.
 * @param db - An open completion connection.
 * @returns The ordered slug list (empty if the people table doesn't exist).
 */
function personSlugs(db: DatabaseSync): string[] {
  const hasPeople = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='people'").get() !== undefined;
  if (!hasPeople) return [];
  const rows = db.prepare('SELECT slug FROM people ORDER BY slug').all() as { slug: string }[];
  return rows.map((r) => r.slug);
}

/**
 * Distinct interaction kinds in the DB, sorted. Kinds are data (by design decision: kinds are data, not schema), so the live set is the truth — a kind that was never used offers
 * nothing, one that was used once offers itself.
 * @param db - An open completion connection.
 * @returns The sorted distinct kind list.
 */
function interactionKinds(db: DatabaseSync): string[] {
  const hasInteractions =
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='interactions'").get() !== undefined;
  if (!hasInteractions) return [];
  const rows = db.prepare('SELECT DISTINCT kind FROM interactions').all() as { kind: string }[];
  return rows
    .map((r) => r.kind)
    .filter((k) => k.length > 0)
    .sort();
}

/**
 * Candidates for the value of one flag, given the verb it appeared under.
 * Dynamic tiers first (person slugs, statuses, interaction kinds), then the
 * static registry values; anything else offers nothing.
 * @param db - An open completion connection.
 * @param verb - The verb on the command line (disambiguates --status/--kind).
 * @param flag - The flag name, without the leading dashes.
 * @param prefix - The partial value the user has typed so far.
 * @returns The matching candidate values.
 */
function flagValueCandidates(db: DatabaseSync, verb: string, flag: string, prefix: string): string[] {
  let pool: readonly string[] = [];
  if (flag === 'person') {
    pool = personSlugs(db);
  } else if (flag === 'status') {
    pool = TRACKABLE_VERBS.has(verb) ? TRACKABLE_STATUSES : TASK_STATUSES;
  } else if (flag === 'kind' && INTERACTION_KIND_VERBS.has(verb)) {
    pool = interactionKinds(db);
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
 * is what the user is typing). A partially-typed flag NAME (`--ti<TAB>`) makes
 * parseArgs throw outright — hub.ts re-dispatches the raw argv here with
 * `parseFailed` (see the @param note) so the flag name still completes.
 *
 * Flag names are completed with a requiredness marker: a verb's required
 * flags (REQUIRED_FLAGS) carry a trailing `*` (e.g. `--title*`) and sort
 * before the optional ones. The marker is display-only: zsh shows it via
 * `compadd -d` while inserting the clean name; bash's readline prints
 * COMPREPLY verbatim in its ambiguous listing, so its wiring keeps the
 * marker visible there (nosort preserves the required-first ordering) and
 * strips it exactly when a lone candidate would be inserted whole — bash's
 * multi-candidate insertion is the longest common prefix, which a trailing
 * marker can never be part of.
 *
 * @param values - Parsed CLI flags (`--db` rides along for live queries).
 * @param rawWords - Everything after the `__complete` verb itself.
 * @param parseFailed - Set by hub.ts when parseArgs threw and the raw argv
 *   was re-dispatched here. The last raw word is then a dash-flag with no
 *   value after it: a known string flag means the user is completing its
 *   (empty) value — e.g. `hub add-task --person <TAB>` — while anything else
 *   dash-prefixed is a partially-typed flag name (`--ti<TAB>` → `--title*`).
 * @returns Process exit code (always 0 — completion never fails the shell).
 */
export async function cmdComplete(values: CliValues, rawWords: string[], parseFailed = false): Promise<number> {
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

  let toComplete = words.length > 0 ? words[words.length - 1] : '';
  const context = words.length > 1 ? words.slice(0, -1) : [];

  // parseFailed recovery — see the @param note. A known string flag as the
  // last word is reframed as completing that flag's value with an empty
  // prefix, so the generic tier-2 flow below offers the right candidates
  // (`hub add-task --person <TAB>` → live slugs). A partial/unknown flag
  // (`--ti<TAB>`) is already correctly framed as tier-1b flag-name
  // completion; nothing to do.
  if (parseFailed && words.length >= 2) {
    const last = words[words.length - 1];
    if (last.startsWith('--') && last !== '--' && optionType(last.slice(2)) === 'string') {
      context.push(last);
      toComplete = '';
    }
  }

  // Tier 1a — verb names (nothing before the word being completed). Pure
  // registry data — no DB open at all.
  if (context.length === 0) {
    printCandidates(VERB_NAMES.filter((v) => v.startsWith(toComplete)));
    return 0;
  }

  const verb = context[0];

  // Tier 1b — flag names (the word being completed starts with a dash).
  // Required flags get a trailing `*` marker (REQUIRED_FLAGS) and sort
  // FIRST, before the optional ones. The marker is display-only: zsh pairs
  // a marked display list with clean insertion (`compadd -d`); bash prints
  // COMPREPLY verbatim in its ambiguous listing, so its wiring keeps the
  // marker visible there (nosort preserves required-first) and strips it
  // only when a single candidate would be inserted whole; compctl (legacy
  // zsh) inserts what it displays, so it strips outright. Prefix matching is
  // done on the marked string — `--ti` matches `--title*`.
  // __complete itself is deliberately never offered: it is a hidden verb.
  if (toComplete.startsWith('-')) {
    const required = new Set(REQUIRED_FLAGS[verb] ?? []);
    const marked = [...(VERB_FLAGS[verb] ?? []), ...GLOBAL_FLAGS].map((f) => `--${f}${required.has(f) ? '*' : ''}`);
    const matching = marked.filter((f) => f.startsWith(toComplete));
    printCandidates([...matching.filter((f) => f.endsWith('*')), ...matching.filter((f) => !f.endsWith('*'))]);
    return 0;
  }

  // Tier 2/3 — value of the previous word when that word takes a value, or
  // positional slugs for the slug-taking verbs. Both need the DB; open it
  // only now (a bare `hub <TAB>` never touches the filesystem).
  const prev = context[context.length - 1];
  const wantsFlagValue = prev.startsWith('--') && optionType(prev.slice(2)) === 'string';
  const wantsSlugs = !wantsFlagValue && SLUG_POSITIONAL_VERBS.has(verb);
  if (wantsFlagValue || wantsSlugs) {
    const db = openCompletionDb(values.db as string | undefined);
    try {
      if (wantsFlagValue) {
        const flag = prev.slice(2);
        printCandidates(flagValueCandidates(db, verb, flag, toComplete));
      } else {
        printCandidates(personSlugs(db).filter((s) => s.startsWith(toComplete)));
      }
    } finally {
      db.close();
    }
    return 0;
  }

  return 0;
}
