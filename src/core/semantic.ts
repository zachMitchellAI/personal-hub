// Semantic-search plumbing (S13): sqlite-vec extension loading, local Ollama
// embeddings, and the vec0 row-insert helpers. Zero runtime deps — node:
// built-ins plus the preinstalled vec0.so (not an npm dependency, consistent
// with the zero-dep rule's spirit; the .so ships with the OpenClaw install).
//
// Failure model (ticket S13): embedding failure never fails the write. The
// interaction row is the source of truth; the vector is derived. Callers
// (add-interaction, reindex-embeddings) catch embed errors and warn, and the
// backfill verb repairs the index later.
import { existsSync } from 'node:fs';
import process from 'node:process';
import type { DatabaseSync } from 'node:sqlite';

/**
 * The embedding model name as Ollama reports it — pinned per row in
 * `embedding_meta` (vectors from different models are not comparable, so a
 * model swap means re-embed everything: `reindex-embeddings --force`).
 */
export const EMBED_MODEL = 'nomic-embed-text';

/** nomic-embed-text output dimension; also the vec0 column width. */
export const EMBED_DIM = 768;

/**
 * Absolute path to the sqlite-vec vec0.so shipped with the OpenClaw install
 * (`$HUB_VEC0_SO` overrides). Loaded directly instead of adding an npm
 * dependency; a machine without the .so cannot init migration 009's vector
 * table (documented portability caveat — the hub runs on owner machines
 * where it exists).
 */
const VEC0_SO =
  '/home/zachary/.nvm/versions/node/v26.12.1/lib/node_modules/openclaw/node_modules/sqlite-vec-linux-x64/vec0.so';

/**
 * Resolve the vec0 extension path: `$HUB_VEC0_SO` when set, otherwise the
 * OpenClaw-install default.
 * @returns The extension path to attempt.
 */
function vec0SoPath(): string {
  return process.env.HUB_VEC0_SO ?? VEC0_SO;
}

/**
 * Load the sqlite-vec vec0 extension onto an open connection. The connection
 * MUST have been constructed with `allowExtension: true` (openHubDb does
 * this) — loading later throws otherwise. Non-fatal by design: a machine
 * without the .so opens fine and merely loses vector capabilities.
 * @param db - An open `DatabaseSync` connection.
 * @returns True when the extension loaded; false when the .so is missing.
 */
export function loadVec0(db: DatabaseSync): boolean {
  const so = vec0SoPath();
  if (!existsSync(so)) return false;
  db.loadExtension(so);
  return true;
}

/**
 * Re-check that vec0 is actually usable on this connection by exercising the
 * extension's own marker function — the honest probe, since loadVec0 only
 * proves the file existed at open time.
 * @param db - An open `DatabaseSync` connection.
 * @returns True when the vec0 module responds.
 */
export function hasVec0(db: DatabaseSync): boolean {
  try {
    const row = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
    return typeof row?.v === 'string' && row.v.length > 0;
  } catch {
    return false;
  }
}

/** Ollama's local endpoint (`$HUB_OLLAMA` overrides); private, nothing leaves the machine. */
export const OLLAMA = 'http://localhost:11434';

/**
 * Embed one text with the local Ollama model (`/api/embed`). One HTTP call
 * per text; the read path embeds only the question — write-time vectors are
 * already in the db. Network/model errors propagate to the caller, which
 * treats them as "embedding unavailable" (never a failed write).
 * @param text - The text to embed (question or interaction summary).
 * @returns A Float32Array of EMBED_DIM values from Ollama.
 */
export async function embed(text: string): Promise<Float32Array> {
  const base = process.env.HUB_OLLAMA ?? OLLAMA;
  const res = await fetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    throw new Error(`Ollama embed failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embeddings: number[][] };
  const v = new Float32Array(data.embeddings[0]);
  if (v.length !== EMBED_DIM) {
    throw new Error(`Unexpected embedding dim ${v.length}, expected ${EMBED_DIM}`);
  }
  return v;
}

/**
 * Serialize a Float32Array into the little-endian f32 BLOB format sqlite-vec
 * expects. On x64 a Float32Array's backing buffer is already little-endian,
 * so a view copy is safe; the fresh ArrayBuffer keeps it correct on any host.
 * @param vec - The embedding vector.
 * @returns A Buffer of EMBED_DIM little-endian f32 values.
 */
export function serializeVec(vec: Float32Array): Buffer {
  const le = new ArrayBuffer(vec.length * 4);
  new Float32Array(le).set(vec);
  return Buffer.from(le);
}

/**
 * Insert one row into a vec0 virtual table using SQL *literals* for the id,
 * metadata, and the vector (hex-blob literal). sqlite-vec 0.1.9 quirks (demo
 * finding #1, plus probe findings): a bound `?` parameter for the primary key
 * fails with "Only integers are allowed for primary key values" even with a
 * JS number — literals work; and every METADATA/PARTITION column must be
 * supplied explicitly (an omitted date column arrives as NULL and fails with
 * "Expected text for TEXT metadata column date, received NULL"). All
 * non-vector values are integers or fixed ISO dates generated by this code —
 * no injection surface.
 * @param db - An open connection with vec0 loaded.
 * @param table - The vec0 virtual table name (callers pass fixed names).
 * @param pkColumn - The table's INTEGER PRIMARY KEY column name.
 * @param id - The row id (an integer this code derived, never user text).
 * @param vec - The embedding vector.
 * @param meta - Metadata/partition column values (column name → number or
 * string; vec0 requires TEXT metadata to be real text, INTEGER partitions
 * real integers).
 */
export function insertVecRow(
  db: DatabaseSync,
  table: string,
  pkColumn: string,
  id: number,
  vec: Float32Array,
  meta: Record<string, number | string> = {},
): void {
  const hex = serializeVec(vec).toString('hex');
  // Column/value pairs built from fixed names + number/ISO-string values.
  const metaCols = Object.keys(meta);
  const cols = [pkColumn, ...metaCols, 'embedding'].join(', ');
  const values = [
    String(Number(id)),
    ...metaCols.map((c) => {
      const v = meta[c];
      return typeof v === 'number' ? String(Number(v)) : `'${v}'`;
    }),
    `x'${hex}'`,
  ].join(', ');
  db.exec(`INSERT INTO ${table} (${cols}) VALUES (${values})`);
}
