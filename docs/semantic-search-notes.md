# Semantic Search for the Hub — Embeddings + sqlite-vec

*Written 2026-10-21 (Sam). Companion to this evening's call. Aimed at a future demo/episode in personal-hub.*

## The idea in one sentence
Add a **vector column** to the hub's SQLite tables so notes can be found by **meaning**, not just keywords — while keeping everything in the one `life.db` file.

## Concepts

### What an embedding is
- A small, fast model (not an LLM) converts text → a list of numbers (a **vector**), e.g. 768 floats.
- Texts with similar *meaning* end up geometrically close, even with zero shared keywords ("struggling with sleep" ≈ "been so tired lately").
- The LLM never does this search; the app plumbing does. The LLM just receives the retrieved text as context (RAG loop).

### The pieces
| Piece | Role | Options |
|---|---|---|
| Embedding model | text → vector | Local: Ollama `nomic-embed-text` (free, private). API: OpenAI `text-embedding-3-small`, Voyage, etc. |
| Vector storage | where vectors live | **sqlite-vec** extension — adds a vector column type + KNN queries to plain SQLite |
| Query flow | how search happens | 1) embed the question 2) filter with normal SQL 3) rank remaining rows by vector distance |

### Why sqlite-vec (vs a separate vector DB)
- Stays a single-file SQLite DB — no server, no new infra. Fits the hub's zero-dependency spirit.
- Loads with one extension call; queries are plain SQL: `SELECT ... FROM notes ORDER BY v MATCH :query_vec LIMIT 5` style KNN.
- Caveat: scale ceiling is ~100k–1M vectors; fine for a personal CRM.

## Sketch for the hub

### Schema addition (hypothetical, `notes`-style table)
```sql
-- after a real embedding exists per row:
CREATE TABLE note_embeddings (
  note_id    TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  vec        BLOB,          -- 768 floats, little-endian f32
  model      TEXT NOT NULL, -- e.g. 'nomic-embed-text-v1.5' (version pinning!)
  created_at TEXT
);
```
- Store the **model name + version** alongside every vector. If you ever swap models, you must re-embed everything (vectors from different models are not comparable).

### Write path
1. On `add-note` (or any new text: interaction summary, person notes): chunk the text if long (embeddings like ~500-token chunks).
2. Call the embedding model once per chunk.
3. Insert the vector row alongside the normal note row. If a note is edited → re-embed (or delete+reinsert).

### Read path (hybrid search — the killer feature)
```sql
-- SQL filters narrow first (cheap, exact):
SELECT n.id, n.summary
FROM notes n
JOIN note_embeddings e ON e.note_id = n.id
WHERE n.person_slug = :person AND n.date >= :since
ORDER BY distance(e.vec, :question_vec)   -- sqlite-vec KNN
LIMIT 5;
```
- Filter semantics (who, when, relationship type) stay relational.
- Ranking by meaning comes from vectors.
- This is the pattern used in production RAG systems: **SQL prefilter → vector rank**.

## Demo plan (when Zachary is home)
1. Scratch dir in `personal-hub/` (e.g. `demo/semantic/`) — not part of core.
2. Install `sqlite-vec` extension + Ollama with `nomic-embed-text` (~50 MB).
3. Seed ~10 fake interaction notes across 3 people.
4. CLI verb like `search-notes "who's job hunting"` → prints ranked rows with distance scores.
5. Show contrast: keyword-only query missing vs hybrid query hitting (e.g. "tired" → the sleep note).
6. If it clicks, write it up as a real story (S-next) for the epic — would make interactions genuinely recallable.

## Cost/ops notes
- Local Ollama: free, ~20-100ms per embed on CPU. Fully private — nothing leaves the machine.
- API: better quality top models, but each embed costs fractions of a cent and text leaves the box.
- Mixing both: embed once at write-time (batching is cheap), so read-time cost is zero.
- Privacy: vectors are still data — they can leak hints about content. They live in `life.db`, which is already in `.gitignore` and never committed.

## Open questions for the demo
- Distance metric: cosine vs L2 (sqlite-vec supports both; cosine is standard for text).
- Should embeddings go on `notes` only, or also `people.notes` (short text, probably fine)?
- Normalization strategy when re-embedding after model change (full rebuild script).
