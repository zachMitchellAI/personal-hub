// Semantic-search verbs: search, reindex-embeddings. S13 — hybrid recall over
// the interaction history: SQL prefilter → vector rank (stories/
// ticket-s13-semantic-search.md). Business rules live in the write path
// (AGENTS.md): a failed embedding never fails the interaction write — the
// row is the source of truth, the vector is derived, and the backfill verb
// repairs the index. Keyword mode is the contrast/fallback path (LIKE-style
// token scoring; no FTS5 by ticket).
//
// vec0 insert quirks (re-probed 2026-11-05 against sqlite-vec 0.1.9 +
// node:sqlite, PR #1 review r4483148225): vec0 type-checks each incoming
// value per column — the PK and PARTITION KEY must arrive as SQLITE_INTEGER.
// Plain JS-number `?` binds reach them as FLOAT through node:sqlite, so
// parameterized inserts fail, and vector rows go through core/semantic.ts
// insertVecRow (SQL literals). drizzle's typed inserts emit plain JS
// numbers and fail the same way; its sql.raw() fragment values DO work
// (inline literals — verified end to end) but the virtual table cannot
// join schema.ts (see the S13 note there: virtual DDL, config-token width,
// snapshot hazard), so the sql.raw form would be this same SQL behind
// extra ceremony. Performance is a non-issue; value typing is the gate.
// KNN queries select the named key column, never rowid.
import { makeDrizzle, openDb, type HubDb } from '../core/db.ts';
import { interactions, people } from '../schema.ts';
import { parseIsoDate } from '../core/util.ts';
import { EMBED_DIM, EMBED_MODEL, embed, hasVec0, insertVecRow, serializeVec } from '../core/semantic.ts';
import type {
  ReindexEmbeddingsStatus,
  SearchStatus,
  SearchResultJson,
  SearchValues,
  ReindexEmbeddingsValues,
} from '../core/types.ts';
import { eq, inArray } from 'drizzle-orm';
import type { DatabaseSync } from 'node:sqlite';
import process from 'node:process';

/** One interaction row prepared for ranking (shared by both search modes). */
interface CandidateRow {
  id: number;
  personId: number | null;
  personSlug: string | null;
  date: string;
  summary: string;
}

/**
 * A `--mode` value for `hub search`: `auto` (hybrid when the environment
 * allows it, keyword otherwise), or a forced `hybrid` / `keyword`.
 */
type SearchMode = 'auto' | 'hybrid' | 'keyword';

/**
 * Parse a CLI string into the closed `--mode` union — the boundary gets the
 * typed value instead of later code re-reading bare strings (PR #1 review
 * r4483262). Deliberately no `zod` here: the set is three literals, and a
 * validation dependency would cost more than it validates (repo zero-dep
 * rule). Revisit if validation grows beyond literal sets.
 * @param raw - The raw `--mode` flag value.
 * @returns The parsed mode, or null when the value is not one of the three.
 */
function parseSearchMode(raw: string): SearchMode | null {
  if (raw === 'auto' || raw === 'hybrid' || raw === 'keyword') return raw;
  return null;
}

/**
 * Token-overlap scoring for keyword mode: count query tokens present in the
 * summary as whole words (word-boundary match, lowercase). This is what a
 * plain LIKE-style search gets you — no notion of meaning.
 * @param query - Raw query text.
 * @param summary - The interaction summary text.
 * @returns The number of distinct query tokens found in the summary.
 */
function keywordScore(query: string, summary: string): number {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter(Boolean);
  const hay = summary.toLowerCase();
  return tokens.filter((t) => new RegExp(`\\b${t}\\b`).test(hay)).length;
}

/**
 * Load every interaction (joined to its person slug when linked) ordered by
 * id, as the candidate pool for keyword scoring. Hybrid mode does not use
 * this — its prefilters run inside the vec0 KNN query.
 * @param hub - The typed drizzle handle.
 * @returns All interactions with their optional person slug attached.
 */
async function loadCandidates(hub: HubDb): Promise<CandidateRow[]> {
  const rows = await hub
    .select({
      id: interactions.id,
      personId: interactions.personId,
      date: interactions.date,
      summary: interactions.summary,
      personSlug: people.slug,
    })
    .from(interactions)
    .leftJoin(people, eq(interactions.personId, people.id))
    .orderBy(interactions.id)
    .all();
  return rows;
}

/**
 * Keyword-only search: token-overlap scoring over all interactions, no
 * vectors involved. Person/since filters are plain SQL semantics applied to
 * the candidate pool. A query that shares no keywords with any summary
 * returns an empty list — the limitation the hybrid path exists to fix.
 * @param hub - The typed drizzle handle.
 * @param query - Raw query text.
 * @param person - Optional person slug prefilter.
 * @param since - Optional ISO date floor.
 * @param maxResults - Max results (the `--k` flag).
 * @returns Ranked rows (best token overlap first), at most maxResults.
 */
async function keywordSearch(
  hub: HubDb,
  query: string,
  person: string | null,
  since: string | null,
  maxResults: number,
): Promise<SearchResultJson[]> {
  const rows = await loadCandidates(hub);
  return rows
    .filter((r) => (person === null || r.personSlug === person) && (since === null || r.date >= since))
    .map((r) => ({ ...r, distance: keywordScore(query, r.summary) }))
    .filter((r) => r.distance > 0)
    .sort((a, b) => b.distance - a.distance || a.id - b.id)
    .slice(0, maxResults)
    .map((r) => ({
      interaction_id: r.id,
      person_slug: r.personSlug,
      date: r.date,
      summary: r.summary,
      distance: r.distance,
    }));
}

/**
 * Hybrid search: embed the question locally, then ONE vec0 KNN query whose
 * prefilters (person partition key, date metadata) are enforced in the KNN
 * subquery and re-asserted outside it (vec0 0.1.9 NULL-folds guarded
 * partition/metadata predicates — see the comment at the query), then join
 * back to `interactions` for the text. Cosine distance, lower is better.
 * @param db - The raw `DatabaseSync` connection (vec0 queries are raw SQL;
 * the drizzle schema does not model virtual tables).
 * @param hub - The typed drizzle handle (for the join-back select).
 * @param query - Raw question text (will be embedded).
 * @param person - Optional person slug prefilter (resolved to its id).
 * @param since - Optional ISO date floor.
 * @param maxResults - Max results (the `--k` flag).
 * @returns Ranked rows, nearest (smallest cosine distance) first.
 */
async function hybridSearch(
  db: DatabaseSync,
  hub: HubDb,
  query: string,
  person: string | null,
  since: string | null,
  maxResults: number,
): Promise<SearchResultJson[]> {
  // Resolve the person prefilter to its id first: the vec0 partition key is
  // the numeric person_id, and an unknown slug is the caller's usage error.
  let personId: number | null = null;
  if (person !== null) {
    const p = await hub.select({ id: people.id }).from(people).where(eq(people.slug, person)).get();
    if (!p) return [];
    personId = p.id;
  }

  const queryVector = serializeVec(await embed(query));

  // vec0 KNN: `embedding MATCH ? AND k = ?` is the KNN form; the partition
  // key and metadata columns act as prefilter predicates evaluated inside
  // the query (the demo-verified hybrid pattern). Two quirks shape this
  // statement (both probe-verified against sqlite-vec 0.1.9):
  //   1. A partition/metadata predicate that becomes NULL via `? IS NULL OR`
  //    is CONSTANT-folded before vec0's partition pruning sees it, so
  //   `--person x --since y` could return rows from other partitions/dates.
  //    Hence the two-step form: the KNN subquery runs UNFILTERED with
  //    knnLimit = max(maxResults, row count) — never fewer than maxResults
  //    post-filter survivors — and the prefilters apply again in the OUTER
  //    WHERE with a LIMIT maxResults. Filters still run inside the subquery
  //    (cheap, indexed); the outer pass only guarantees their correctness.
  //   2. Person params must arrive as real numbers and dates as real
  //    strings — string-typed values mismatch the column affinity and
  //    silently match nothing.
  // Bind params use SQLite's ?N positional numbering, filled by .all(...)
  // below in order:
  //   ?1 = query vector (BLOB from serializeVec)  ?2 = person id (null = no filter)
  //   ?3 = since date (null = no filter)          ?4 = KNN width (knnLimit)
  //   ?5 = final maxResults cap on the outer pass
  // (The bare `k` in `AND k = ?4` is vec0's reserved KNN-width column —
  // SQL-side syntax, not a local variable name.)
  const vectorCount = (
    db.prepare('SELECT count(*) AS total FROM interaction_embeddings').get() as {
      total: number;
    }
  ).total;
  const knnLimit = Math.max(maxResults, vectorCount);
  const vecRows = db
    .prepare(
      `SELECT interaction_id, distance FROM (
         SELECT interaction_id, distance, person_id, date FROM interaction_embeddings
         WHERE embedding MATCH ?1
           AND (?2 IS NULL OR person_id = ?2)
           AND (?3 IS NULL OR date >= ?3)
           AND k = ?4
       )
       WHERE (?2 IS NULL OR person_id IS ?2) AND (?3 IS NULL OR date >= ?3)
       ORDER BY distance
       LIMIT ?5`,
    )
    .all(queryVector, personId, since, knnLimit, maxResults) as { interaction_id: number; distance: number }[];

  if (vecRows.length === 0) return [];
  const byId = new Map(vecRows.map((v) => [v.interaction_id, v.distance]));
  const rows = await hub
    .select({
      id: interactions.id,
      personSlug: people.slug,
      date: interactions.date,
      summary: interactions.summary,
    })
    .from(interactions)
    .leftJoin(people, eq(interactions.personId, people.id))
    .where(inArray(interactions.id, [...byId.keys()]))
    .all();
  return rows
    .map((r) => ({
      interaction_id: r.id,
      person_slug: r.personSlug,
      date: r.date,
      summary: r.summary,
      distance: byId.get(r.id)!,
    }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * `hub search`: find interactions by meaning (hybrid) or keyword (fallback).
 * Default mode `auto`: hybrid when vec0 + Ollama are both available, keyword
 * otherwise — so the verb always works, and degrades gracefully (exit 0).
 * Output: one line per row `cos=<d> [date] person-slug: summary` (human), or
 * the snake_case ranked array for `--json`.
 * @param values - Parsed CLI flags (see `SearchValues`).
 * @param queryArg - The positional query text (may be multiple words joined
 * by the shell; quoted phrases survive as one positional).
 * @returns Process exit code (0 = searched, 1 = usage error).
 */
export async function cmdSearch(values: SearchValues, queryArg?: string): Promise<number> {
  const query = queryArg ?? '';
  const mode = parseSearchMode(values.mode ?? 'auto');
  if (mode === null) {
    console.error(`hub search: --mode must be auto|hybrid|keyword, got "${values.mode ?? ''}"`);
    return 1;
  }
  let maxResults = 5;
  if (values.k !== undefined) {
    const flagValue = Number(values.k);
    if (!Number.isInteger(flagValue) || flagValue <= 0) {
      console.error(`hub search: --k must be a positive integer, got "${values.k}"`);
      return 1;
    }
    maxResults = flagValue;
  }
  let since: string | null = null;
  if (values.since) {
    since = parseIsoDate(values.since);
    if (!since) {
      console.error(`hub search: --since must be an ISO date (YYYY-MM-DD), got "${values.since}"`);
      return 1;
    }
  }
  if (!query) {
    console.error('hub search: query argument required');
    return 1;
  }

  const { db, vec0 } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);
    const person = values.person ?? null;

    // Mode resolution: auto = hybrid when vec0 is loaded AND Ollama answers;
    // anything else falls back to keyword. Ollama reachability is probed by
    // attempting the embed — there is no cheaper honest check. One keyword
    // pathway (useKeywordSearch); hybrid is attempted once and degrades to
    // that same pathway when the embed or the KNN query fails.
    const useKeywordSearch = (): Promise<SearchResultJson[]> => keywordSearch(hub, query, person, since, maxResults);
    let usedMode: 'hybrid' | 'keyword';
    let results: SearchResultJson[];
    if (mode === 'keyword' || !vec0 || !hasVec0(db)) {
      usedMode = 'keyword';
      results = await useKeywordSearch();
    } else {
      try {
        results = await hybridSearch(db, hub, query, person, since, maxResults);
        usedMode = 'hybrid';
      } catch {
        // Ollama down (or the KNN query failed) — degrade to keyword, exit 0.
        usedMode = 'keyword';
        results = await useKeywordSearch();
      }
    }

    const out: SearchStatus = { verb: 'search', mode: usedMode, count: results.length, results };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      for (const r of results) {
        const metric = usedMode === 'hybrid' ? 'cos' : 'kw';
        console.log(`${metric}=${r.distance.toFixed(6)} [${r.date}] ${r.person_slug ?? '-'}: ${r.summary}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

/**
 * Ensure the `embedding_meta` singleton names the current model, inserting it
 * on first use. Called from the write path before the first vector insert;
 * a row whose model differs from EMBED_MODEL would mean the vectors below
 * came from another model — not possible via the CLI, since every embed call
 * pins EMBED_MODEL.
 * @param db - An open connection with vec0 loaded (migration 009 applied).
 */
function ensureEmbeddingMeta(db: DatabaseSync): void {
  db.exec(
    `INSERT INTO embedding_meta (id, model, dims, created_at) VALUES (1, '${EMBED_MODEL}', ${EMBED_DIM}, '${new Date().toISOString()}')
     ON CONFLICT(id) DO NOTHING`,
  );
}

/**
 * Embed one interaction summary and insert its vector row. Vector rows are
 * deleted before insert (reindex --force re-embeds; this keeps the function
 * idempotent per interaction — vec0 turns out to replace a duplicate PK
 * insert, but explicit delete-then-insert keeps the intent obvious and
 * survives vec0 version drift). The PK is a literal per the vec0
 * bound-param quirk (insertVecRow); partition NULL mirrors a people-less
 * interaction (its interactions.person_id is NULL) so it stays outside every
 * --person partition filter.
 * @param db - An open connection with vec0 loaded.
 * @param id - The interaction's id.
 * @param summary - The text to embed.
 * @param date - The interaction's ISO date (vec0 METADATA — required on
 * every insert, never NULL).
 * @param personId - The interaction's person id (vec0 partition key), or
 * null for a people-less interaction (partition key NULL).
 */
async function embedInteraction(
  db: DatabaseSync,
  id: number,
  summary: string,
  date: string,
  personId: number | null,
): Promise<void> {
  const vec = await embed(summary);
  db.exec(`DELETE FROM interaction_embeddings WHERE interaction_id = ${Number(id)}`);
  if (personId === null) {
    // Raw form: partition key NULL has no parameter-typed literal path.
    const hex = serializeVec(vec).toString('hex');
    db.exec(
      `INSERT INTO interaction_embeddings (interaction_id, person_id, date, embedding) VALUES (${Number(id)}, NULL, '${date}', x'${hex}')`,
    );
  } else {
    insertVecRow(db, 'interaction_embeddings', 'interaction_id', id, vec, { person_id: personId, date });
  }
}

/**
 * `hub add-interaction`'s embedding hook (S13 write path): after a successful
 * interaction insert, best-effort embed the summary and insert its vector
 * row. NEVER throws — the interaction row is the source of truth and the
 * vector is derived; an Ollama outage only costs a stderr warning (the caller
 * prints `hub: embedding unavailable, run reindex-embeddings`) and the
 * backfill verb repairs the index later.
 * @param db - The open `DatabaseSync` connection the interaction was written
 * on (vec0 already loaded when available).
 * @param id - The new interaction's id.
 * @param summary - The interaction summary text.
 * @param date - The interaction's ISO date.
 * @param personId - The interaction's person id, or null.
 */
export async function embedAfterAdd(
  db: DatabaseSync,
  id: number,
  summary: string,
  date: string,
  personId: number | null,
): Promise<void> {
  try {
    if (!hasVec0(db)) return; // vec0 absent: no vector index to maintain.
    ensureEmbeddingMeta(db);
    await embedInteraction(db, id, summary, date, personId);
  } catch (err: unknown) {
    console.error('hub: embedding unavailable, run reindex-embeddings');
    if (process.env.HUB_DEBUG) console.error(`hub: embed detail: ${(err as Error).message}`);
  }
}

/**
 * `hub reindex-embeddings`: backfill the vector index — embed every
 * interaction lacking a vector row (all rows with `--force`, e.g. after a
 * model swap). Never deletes interaction rows; reports embedded/skipped
 * counts. Requires vec0 (usage error without it — there is no index to
 * backfill) but NOT a live Ollama at command start; unreachable Ollama
 * counts each interaction as failed and the command still exits 0 so a
 * partial repair lands and a later run finishes the job.
 * @param values - Parsed CLI flags (see `ReindexEmbeddingsValues`).
 * @returns Process exit code (0 = ran, 1 = usage/vec0-missing error).
 */
export async function cmdReindexEmbeddings(values: ReindexEmbeddingsValues): Promise<number> {
  const { db, vec0 } = openDb(values.db as string | undefined);
  try {
    if (!vec0 || !hasVec0(db)) {
      console.error('hub reindex-embeddings: vec0 extension unavailable — nothing to backfill');
      return 1;
    }
    const hub = makeDrizzle(db);
    const rows = await hub
      .select({
        id: interactions.id,
        personId: interactions.personId,
        date: interactions.date,
        summary: interactions.summary,
      })
      .from(interactions)
      .orderBy(interactions.id)
      .all();

    // Which interactions already have a vector row (select the named key
    // column — rowid is not selectable on vec0 tables with an explicit PK).
    const existing = db.prepare('SELECT interaction_id FROM interaction_embeddings').all() as {
      interaction_id: number;
    }[];
    const have = new Set(existing.map((e) => e.interaction_id));

    const force = values.force === true;
    const targets = force ? rows : rows.filter((r) => !have.has(r.id));

    ensureEmbeddingMeta(db);
    let embedded = 0;
    let failed = 0;
    for (const r of targets) {
      try {
        await embedInteraction(db, r.id, r.summary, r.date, r.personId);
        embedded++;
      } catch {
        // One failed embed must not abort the backfill — the rest still land,
        // and this run reports the gap for a later repair.
        failed++;
      }
    }

    const out: ReindexEmbeddingsStatus = {
      verb: 'reindex-embeddings',
      embedded,
      skipped: rows.length - targets.length,
      failed,
      total: rows.length,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `reindex-embeddings: embedded=${out.embedded} skipped=${out.skipped} failed=${out.failed} (of ${out.total})`,
      );
    }
    return 0;
  } finally {
    db.close();
  }
}
