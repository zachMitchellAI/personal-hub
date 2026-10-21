// Deterministic helpers shared by hub verbs.

/**
 * Derive a person slug from arbitrary input, deterministically (S2): lowercase,
 * diacritics folded (NFD + combining-mark strip), apostrophes dropped, runs of
 * anything non-`[a-z0-9]` collapsed to one dash, leading/trailing dashes trimmed.
 * Derivation lives in the CLI, not in the DB.
 * @param input - Raw text, typically a person's display name.
 * @returns The lowercase-dashed slug, possibly empty if the input had no usable characters.
 */
export function deriveSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Flatten an Error (and its `cause` chain, depth-capped at 5) into one
 * searchable string. Drizzle wraps driver errors as `DrizzleQueryError`, so
 * regexes must match against the whole chain, not just the top-level message.
 * @param err - Anything thrown; non-Errors yield an empty string.
 * @returns Messages joined with " | ", e.g. `"wrap msg | driver msg"`.
 */
export function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  // Depth cap keeps malformed cause cycles from hanging the CLI.
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/**
 * Parse a positive-integer id argument (channel, task, subtask — any table's
 * surrogate key). Anything else (empty, non-numeric, negative, zero,
 * fractional) is a usage error.
 * @param raw - The raw positional argument, possibly undefined.
 * @returns The parsed id, or null when the input is not a valid id.
 */
export function parseId(raw?: string): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Validate a deterministic ISO calendar date (YYYY-MM-DD). The S4 ticket
 * requires rejecting fuzzy dates like "next friday" at the CLI layer —
 * only exact calendar dates are accepted. Out-of-range input (2026-02-30)
 * fails the Date round-trip below.
 * @param raw - The raw date string.
 * @returns The validated date string, or null when it is not a real YYYY-MM-DD date.
 */
export function parseIsoDate(raw: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  // UTC anchor keeps the calendar date stable across the host timezone.
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  // Round-trip rejects overflow dates some parsers normalize silently.
  return new Date(ms).toISOString().slice(0, 10) === raw ? raw : null;
}
