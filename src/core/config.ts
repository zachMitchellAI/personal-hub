// Hub configuration resolution (S13 portability pass, 2026-10-31): every
// machine-specific setting resolves through ONE precedence chain —
//   1. the process environment (highest),
//   2. the hub config file (a flat KEY=VALUE env-style file),
//   3. built-in defaults.
// Nothing here is machine-specific by construction: the defaults are either
// universal (Ollama's well-known port) or validated at use time, so the hub
// runs unchanged on any Linux/macOS box. Secrets belong in the config file
// only if the file's permissions are; this module carries no credentials.
//
// Parsing is delegated to Node's canonical .env parser (`node:util`
// `parseEnv`, PR #1 review r4461717322) rather than hand-rolled rules — a
// zero-dependency choice per the repo's dependency law (a built-in beats an
// npm package when semantics match; `dotenv` remains a one-line swap if the
// owner prefers the package). `parseEnv` is lenient — it silently drops
// malformed lines — so parseEnvFile() keeps a strict per-line pre-check to
// hold the fail-loudly contract. File syntax stays flat KEY=VALUE: canonical
// details (inline comments, quoted '#', `export` prefixes) are supported;
// multi-line values are not, and errors name the offending line.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';

/**
 * The hub config file path: `$HUB_CONFIG` when set, otherwise
 * `$XDG_CONFIG_HOME/hub/env` (defaulting to `~/.config/hub/env`).
 * @returns The config file path (not required to exist).
 */
export function hubConfigPath(): string {
  if (process.env.HUB_CONFIG) return process.env.HUB_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'hub', 'env');
}

/**
 * Parse an env-style config file: `KEY=VALUE` lines, comments, blank lines
 * ignored. Value semantics come from Node's canonical .env parser
 * (`node:util` `parseEnv`): inline `#` comments, quoted values (double,
 * single, or backtick — a `#` inside quotes is a literal), and `export`
 * prefixes are all handled there, not by local guesses.
 *
 * One thing is local, on purpose: malformed lines — no `=` separator, or an
 * empty key — THROW `expected KEY=VALUE` with the source line number.
 * `parseEnv` alone would silently drop them, and a typo in the config file
 * must fail loudly, not fall back to defaults (also asserted by tests).
 *
 * Multi-line values are intentionally out of contract (flat KEY=VALUE): an
 * opening quote without a closing one surfaces as `expected KEY=VALUE` on
 * the offending line.
 * @param text - Full file text.
 * @param source - File path for error messages.
 * @returns Parsed key → value map.
 */
export function parseEnvFile(text: string, source = 'config'): Record<string, string> {
  // Strict pass: per-line malformed-line check, before parseEnv gets a
  // chance to quietly swallow a typo. Skips blank and comment-only lines;
  // `eq < 1` covers both a missing '=' and an empty key.
  for (const [i, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.indexOf('=') < 1) {
      throw new Error(`${source}:${i + 1}: expected KEY=VALUE`);
    }
  }
  const parsed = parseEnv(text);
  // parseEnv types its result as Dict<string> (string | undefined per key) —
  // a typing convention, not a real output: .env values are strings. Narrow
  // to the contract shape explicitly rather than asserting away the types.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Per-process cache of the parsed config file ({} when absent). */
let fileCache: Record<string, string> | undefined;

/**
 * Load and cache the hub config file. Missing file → empty map (no error);
 * malformed file → throw (fail loudly, see parseEnvFile).
 *
 * The read is a single try/catch rather than a preceding `existsSync`:
 * ENOENT maps to the empty-map contract, every other error (parse failure,
 * unreadable file) propagates. That keeps a permissions error loud —
 * `existsSync` would report it as absence — and closes the check-then-read
 * race window (PR #1 review r4461728188).
 * @returns The parsed key → value map.
 */
export function loadHubFile(): Record<string, string> {
  if (fileCache) return fileCache;
  const path = hubConfigPath();
  try {
    fileCache = parseEnvFile(readFileSync(path, 'utf8'), path);
  } catch (err: unknown) {
    // Only genuine absence is benign; rethrow everything else loudly.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') fileCache = {};
    else throw err;
  }
  return fileCache;
}

/** Test-only: drop the cached config file so env changes re-read cleanly. */
export function resetHubFileCache(): void {
  fileCache = undefined;
}

/**
 * Resolve one config key through the precedence chain: process env first,
 * then the config file. This is the ONLY way hub code reads machine-specific
 * settings — direct `process.env` access for hub config bypasses the config
 * file and is a review flag.
 * @param key - Config key (e.g. `HUB_EMBED_MODEL`).
 * @returns The value, or undefined when unset everywhere.
 */
export function hubEnv(key: string): string | undefined {
  return process.env[key] ?? loadHubFile()[key];
}

/** Semantic-search settings (core/semantic.ts consumers). */
export interface SemanticConfig {
  /** Ollama embedding model name (as Ollama reports it). */
  model: string;
  /** Embedding dimension; also the vec0 column width (migration 009). */
  dim: number;
  /** Ollama base URL. */
  ollama: string;
  /** Manual vec0 extension override path, or undefined for the sqlite-vec npm default. */
  vec0So?: string;
}

/** Built-in defaults; every field overridable via config. */
export const SEMANTIC_DEFAULTS: Omit<SemanticConfig, 'vec0So'> = {
  model: 'nomic-embed-text',
  dim: 768,
  ollama: 'http://localhost:11434',
};

/**
 * Resolve the semantic-search settings through the precedence chain. A
 * non-positive or non-integer `HUB_EMBED_DIM` throws here — a bad dim would
 * otherwise corrupt every migration/vector write downstream.
 * @returns The resolved semantic config.
 */
export function semanticConfig(): SemanticConfig {
  const rawDim = hubEnv('HUB_EMBED_DIM');
  const dim = rawDim === undefined ? SEMANTIC_DEFAULTS.dim : Number(rawDim);
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`HUB_EMBED_DIM must be a positive integer, got "${rawDim ?? ''}"`);
  }
  const vec0So = hubEnv('HUB_VEC0_SO');
  return {
    model: hubEnv('HUB_EMBED_MODEL') ?? SEMANTIC_DEFAULTS.model,
    dim,
    ollama: hubEnv('HUB_OLLAMA') ?? SEMANTIC_DEFAULTS.ollama,
    ...(vec0So !== undefined ? { vec0So } : {}),
  };
}
