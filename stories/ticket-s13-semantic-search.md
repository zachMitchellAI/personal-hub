# S13 — Semantic search (hybrid: SQL prefilter → vector rank)

**Status:** PROPOSED → build in lane `hub-lane-semantic` (branch `stage/s13-semantic-search`)
**Owner context (2026-10-27 call):** doubles as Zachary's hands-on vector-database
education ahead of the Acme Corp AI Developer process (trackable 5). Proven in
`demo/semantic/` on 2026-10-21; this ticket productionizes it into core.
**Companion docs:** `docs/semantic-search-notes.md` (concepts), `demo/semantic/README.md`
(quirks + demo results).

## Goal

Find hub rows by **meaning**, not just keywords, while staying a single-file
SQLite DB. `hub search "tired"` should surface the interaction that says
"slept terribly … drained by noon" even though the word "tired" appears nowhere.

## Design decisions (owner can veto at review)

1. **Storage: sqlite-vec `vec0` virtual table inside `life.db`.** Same pattern
   as the demo. The `vec0.so` binary loads from the OpenClaw install
   (`~/.nvm/versions/node/v26.12.1/lib/node_modules/openclaw/node_modules/sqlite-vec-linux-x64/vec0.so`,
   override with `$HUB_VEC0_SO`). Not an npm dependency — a preinstalled native
   artifact, consistent with the zero-runtime-dep rule's spirit. **Portability
   caveat:** a machine without the .so cannot init the embeddings schema
   (documented; hub runs on owner machines where it exists).
2. **Scope: interactions first.** `interactions.summary` is the hub's free-text
   history — the recall target. People.notes / entities.content / tasks are
   follow-ups (documented below), not S13.
3. **Embeddings are write-time, local, private.** Ollama `nomic-embed-text`
   (768 dims, cosine) at `http://localhost:11434` (`$HUB_OLLAMA` override).
   Model name pinned per-row (`embedding_meta` + column) — vectors from
   different models are never mixed.
4. **Embedding failure never fails the write.** The interaction row is the
   source of truth; the vector is derived. If Ollama is down, `add-interaction`
   warns on stderr, the row lands, and the backfill verb repairs the index.
5. **Read path: hybrid.** Question embedded at read time, then ONE vec0 KNN
   query enforcing SQL prefilters inside it (person partition key, date
   metadata, cosine), joined back to `interactions` for text. Keyword-only mode
   kept for contrast + fallback when vec0/Ollama unavailable.

## Migration `008_semantic_search.sql`

```sql
-- Embedding bookkeeping: which model/version produced the vectors below.
CREATE TABLE embedding_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
-- One vector per interaction (1:1), person/date carried as vec0
-- PARTITION/METADATA so the KNN query itself enforces prefilters
-- (sqlite-vec's supported hybrid pattern; cosine for text).
CREATE VIRTUAL TABLE interaction_embeddings USING vec0(
  interaction_id INTEGER PRIMARY KEY,
  person_id INTEGER PARTITION KEY,
  date TEXT METADATA,
  embedding float[768] distance_metric=cosine
);
```

**Merge-order note:** lane `stage/s11-trello-adapter` also carries an uncommitted
`008_task_trello.sql`. Whoever merges second renumbers (runner is filename-sorted;
two 008 files would collide). Flag at merge gate.

## New verbs

- `search <query> [--person <slug>] [--since <YYYY-MM-DD>] [--k <n>] [--mode keyword|hybrid|auto]`
  — default `auto`: hybrid when vec0+Ollama available, keyword otherwise.
  Output: one line per row `cos=<d> [date] person-slug: summary` (human) / ranked
  JSON array with `interaction_id`, `person_slug`, `date`, `summary`, `distance`
  (snake_case contract) for `--json`. `--k` default 5.
- `reindex-embeddings [--force]` — backfill: embed every interaction lacking a
  vector row (or all rows with `--force`, e.g. after a model swap). Reports
  embedded/skipped counts. Never deletes interaction rows.

## Write-path hooks

- `add-interaction`: after successful insert, best-effort embed summary → insert
  vector row (SQL literals for ids per demo quirk #1; hex-blob literal for the
  vector). Failure → stderr warning `hub: embedding unavailable, run reindex-embeddings`,
  exit code unchanged.
- CRUd lane's future `edit-interaction` (out of scope there) must delete+reinsert
  the vector row — noted in its ticket as a follow-up dependency on S13.

## Core plumbing

- `core/db.ts`: `openHubDb` constructs with `allowExtension: true` and loads
  vec0 via new `core/semantic.ts` helper (`loadVec0(db): boolean`, path from
  `$HUB_VEC0_SO` → default). Non-fatal when missing (open succeeds; vector
  verbs fail cleanly). Exported `hasVec0(db)` re-checks the loaded module.
- `core/semantic.ts`: vec0 path resolution, `embed(text)` (Ollama `/api/embed`,
  dim check), `serializeVec` (LE f32 Buffer), literal-INSERT helper for vec0
  rows (bound-PK quirk).

## Testing (all throwaway DBs, CLI-level, `node --test` glob form)

- Gherkin: keyword miss → empty; hybrid meaning-hit with zero shared keywords
  (seed a tired/exhausted pair); `--person` prefilter excludes other partitions;
  `--since` metadata filter; `--k` respected; `--json` shape; Ollama-down →
  row still inserts + warning; reindex backfills exactly the missing rows;
  `--force` re-embeds all; vec0-absent → search degrades to keyword, exit 0.
- Tests requiring Ollama skip cleanly when `http://localhost:11434` is
  unreachable (tag: `test.skip(unreachable)`) so `npm test` stays green
  offline — the zero-dep portability check must not gain a hard network dep.

## Out of scope (follow-ups)

- Embedding people.notes / entities.content / task text (same pattern, more
  partitions).
- Chunking long text (interactions summaries are short; demo chunkTokens 400
  irrelevant here).
- FTS5 keyword index (LIKE-based keyword mode is enough for contrast/fallback).
- edit-interaction / delete-interaction hooks (arrive with CRUD lane follow-ups;
  delete-interaction must also delete its vector row).

## Acceptance

1. Fresh `init` on this machine lands user_version 8 with `embedding_meta` +
   `interaction_embeddings` present.
2. `add-interaction` produces a vector row automatically (Ollama running).
3. `hub search "exhausted"` on seeded data returns the fatigue notes ranked by
   cosine with zero shared keywords.
4. `reindex-embeddings` repairs a gap left by an Ollama outage.
5. Gates green: `npm run typecheck && npm run fmt && npm run fmt:check && npm test`.