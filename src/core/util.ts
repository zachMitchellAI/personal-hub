// Deterministic helpers shared by hub verbs.
// Slug derivation lives in the CLI (deterministic), not in the DB (S2 note):
// lowercase, spaces→dashes, apostrophes dropped, diacritics folded, no stray punctuation.
export function deriveSlug(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Flatten an Error (and its cause chain, depth-capped) into one searchable
// string — drizzle wraps driver errors, so regexes match the whole chain.
export function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 5; depth++) {
    parts.push(e.message);
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

// Channel ids are positive integers; anything else is a usage error.
export function parseChannelId(raw?: string): number | null {
  if (!raw) return null;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}