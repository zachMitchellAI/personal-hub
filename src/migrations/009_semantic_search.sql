-- S13 — semantic search. Embedding bookkeeping + the vec0 virtual table that
-- stores one vector per interaction, with the hybrid-search prefilters baked
-- into the vector table itself:
--   - embedding_meta is a singleton (CHECK id = 1) naming the model/dims that
--     produced every vector below — vectors from different models are never
--     comparable, so the model is pinned here and re-embedded as a unit.
--   - interaction_embeddings carries person_id as a PARTITION KEY and date as
--     METADATA so the KNN query itself can enforce the SQL prefilters
--     (sqlite-vec's supported hybrid pattern; cosine for text).
-- vec0 is a loadable extension: this migration only applies on a connection
-- that loaded vec0 first (core/semantic.ts loadVec0), and openDb treats a
-- missing vec0.so as non-fatal — such connections skip this file (REQUIRES-EXT
-- gate in migrations.ts) and stay at the previous user_version, degrading to
-- keyword search (documented portability caveat; vector verbs fail cleanly).
-- REQUIRES-EXT: vec0
CREATE TABLE embedding_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE VIRTUAL TABLE interaction_embeddings USING vec0(
  interaction_id INTEGER PRIMARY KEY,
  person_id INTEGER PARTITION KEY,
  date TEXT METADATA,
  embedding float[768] distance_metric=cosine
);
