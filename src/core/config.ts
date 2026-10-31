// Hub configuration resolution (S13 portability pass, 2026-10-31): every
// machine-specific setting resolves through ONE precedence chain —
//   1. the process environment (highest),
//   2. the hub config file (a flat KEY=VALUE env-style file),
//   3. built-in defaults.
// Nothing here is machine-specific by construction: the defaults are either
// universal (Ollama's well-known port) or validated at use time, so the hub
// runs unchanged on any Linux/macOS box. Secrets belong in the config file
// only if the file's permissions are; this module carries no credentials.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

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
 * Parse an env-style config file: `KEY=VALUE` lines, `#` comments, blank
 * lines ignored. Values are taken raw after the first `=` (trimmed) — no
 * interpolation, no quoting rules to guess at. Malformed lines (no `=`,
 * empty key) throw: a typo in the config file should fail loudly, not
 * silently fall back to defaults.
 * @param text - Full file text.
 * @param source - File path for error messages.
 * @returns Parsed key → value map.
 */
export function parseEnvFile(text: string, source = 'config'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [i, rawLine] of text.split('\n').entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) {
      throw new Error(`${source}:${i + 1}: expected KEY=VALUE`);
    }
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** Per-process cache of the parsed config file ({} when absent). */
let fileCache: Record<string, string> | undefined;

/**
 * Load and cache the hub config file. Missing file → empty map (no error);
 * malformed file → throw (fail loudly, see parseEnvFile).
 * @returns The parsed key → value map.
 */
export function loadHubFile(): Record<string, string> {
  if (fileCache) return fileCache;
  const path = hubConfigPath();
  fileCache = existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8'), path) : {};
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
