// Semantic-search plumbing (S13): sqlite-vec extension loading, local Ollama
// embeddings, and the vec0 row-insert helpers. Runtime deps: the `sqlite-vec`
// npm package (owner-approved exception 2026-10-31) — its load() resolves the
// platform-appropriate vec0 binary from our own node_modules, so this works
// across machines and node versions (the previous OpenClaw-install .so path
// hack did not survive an nvm upgrade). Model/dim/endpoint are configurable
// via core/config.ts (env > ~/.config/hub/env > defaults).
//
// Failure model (ticket S13): embedding failure never fails the write. The
// interaction row is the source of truth; the vector is derived. Callers
// (add-interaction, reindex-embeddings) catch embed errors and warn, and the
// backfill verb repairs the index later.
import type { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { semanticConfig, type SemanticConfig } from './config.ts';

/**
 * Resolve the semantic-search settings once per process (env > config file >
 * defaults). Consumers destructure model/dim/ollama from this instead of
 * reading constants — a machine swap or model change is config, not code.
 */
const CFG: SemanticConfig = semanticConfig();

/** The embedding model (as Ollama reports it) this process embeds with. */
export const EMBED_MODEL = CFG.model;

/** The embedding dimension this process expects; the vec0 column width. */
export const EMBED_DIM = CFG.dim;

/**
 * Load the sqlite-vec vec0 extension onto an open connection. Uses the
 * sqlite-vec npm package's platform-resolved binary by default;
 * `$HUB_VEC0_SO` forces a specific .so (vendored builds, debugging).
 * Connection MUST have been constructed with `allowExtension: true`
 * (openHubDb does this). Non-fatal by design: npm-install gaps (an
 * unsupported platform, install scripts skipped) degrade to keyword search —
 * the caller treats a failure here as "no vectors".
 * @param db - An open `DatabaseSync` connection.
 * @returns True when the extension loaded; false when it could not.
 */
export function loadVec0(db: DatabaseSync): boolean {
  try {
    if (CFG.vec0So !== undefined) {
      db.loadExtension(CFG.vec0So);
    } else {
      sqliteVec.load(db);
    }
    return true;
  } catch {
    // Not throwable: an absent/broken platform binary is the documented
    // degrade-to-keyword path, not an error condition.
    return false;
  }
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

/** Ollama's local endpoint; overridable via the semantic config. */
export const OLLAMA = CFG.ollama;

/**
 * Embed one text with the local Ollama model (`/api/embed`). One HTTP call
 * per text; the read path embeds only the question — write-time vectors are
 * already in the db. Network/model errors propagate to the caller, which
 * treats them as "embedding unavailable" (never a failed write).
 * @param text - The text to embed (question or interaction summary).
 * @returns A Float32Array of EMBED_DIM values from Ollama.
 */
export async function embed(text: string): Promise<Float32Array> {
  const base = CFG.ollama;
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
 * "Expected text for TEXT metadata column date, received NULL"). Re-probed
 * 2026-11-05 (PR #1 review r4483148225): vec0 type-checks each incoming
 * value per column, and the PK / PARTITION KEY must arrive as
 * SQLITE_INTEGER — plain JS-number binds present them as FLOAT through
 * node:sqlite's parameters; BigInt-coerced binds pass. drizzle's typed
 * inserts emit plain numbers and fail likewise; a sql.raw() fragment form
 * in .values() does work (verified end to end), but with the virtual table
 * untypeable in schema.ts it reduces to this SQL behind extra ceremony —
 * so SQL literals stay the production form (performance is a non-issue;
 * value typing is the gate). All
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
