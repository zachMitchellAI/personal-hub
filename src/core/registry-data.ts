// Registry data for the hub CLI — the flag/verb/flag-list constants extracted
// from registry.ts (S9, perf pass 2026-10-24). This module is deliberately
// DATA-ONLY: importing it must not pull in any command module, the drizzle
// adapter, or the schema, so `hub __complete` can answer a tab press in
// ~100ms instead of paying the full ~700ms module graph. registry.ts
// re-exports everything here as the single source of truth for the
// dispatcher; completion reads this file directly.
export const PARSE_ARGS_OPTIONS = {
  db: { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  name: { type: 'string' },
  'first-name': { type: 'string' },
  'last-name': { type: 'string' },
  'relationship-type': { type: 'string' },
  employer: { type: 'string' },
  notes: { type: 'string' },
  slug: { type: 'string' },
  kind: { type: 'string' },
  value: { type: 'string' },
  source: { type: 'string' },
  primary: { type: 'boolean', default: false },
  // S4 task/subtask flags. `done` is a string flag ("0"/"1") so `--done 0`
  // works the same way as `--done 1` under parseArgs.
  title: { type: 'string' },
  context: { type: 'string' },
  person: { type: 'string' },
  status: { type: 'string' },
  'due-date': { type: 'string' },
  origin: { type: 'string' },
  label: { type: 'string' },
  done: { type: 'string' },
  mirror: { type: 'boolean', default: false },
  'trello-visible': { type: 'boolean', default: false },
  // S5 interaction flags (kind already declared for add-channel above).
  date: { type: 'string' },
  channel: { type: 'string' },
  summary: { type: 'string' },
  days: { type: 'string' },
  since: { type: 'string' },
  // S6 trackable flags (label/kind/status/date/notes already declared above).
  party: { type: 'string' },
  stage: { type: 'string' },
  type: { type: 'string' },
  // S7 entity/link flags (kind/label/slug/notes already declared above).
  content: { type: 'string' },
  'target-type': { type: 'string' },
  target: { type: 'string' },
  note: { type: 'string' },
  // S7 file flags (kind/person/notes already declared above).
  path: { type: 'string' },
  task: { type: 'string' },
  // S7 sync-log flags.
  'entity-id': { type: 'string' },
  entity: { type: 'string' },
  action: { type: 'string' },
  detail: { type: 'string' },
  direction: { type: 'string' },
  adapter: { type: 'string' },
  // S8b import flags.
  'dry-run': { type: 'boolean', default: false },
  // S12 merge-person: target slug (the surviving row).
  into: { type: 'string' },
} as const;

/** Verb names only — the data-only mirror of the VERBS map's key order. */
export const VERB_NAMES = [
  'init',
  'add-person',
  'get-person',
  'list-people',
  'add-channel',
  'list-channels',
  'remove-channel',
  'set-primary',
  'add-task',
  'set-task-status',
  'list-tasks',
  'add-subtask',
  'mark-subtask',
  'add-interaction',
  'list-interactions',
  'add-trackable',
  'set-trackable-status',
  'list-trackables',
  'add-trackable-event',
  'list-trackable-events',
  // S7 — entities/links/files/sync_log. Entities have no status column, so
  // no set-status verb exists for them (lifecycle-free by design).
  'add-entity',
  'list-entities',
  'link-entity',
  'list-entity-links',
  'unlink-entity',
  'add-file',
  'list-files',
  // S8b — permanent re-runnable contact importer (DECISIONS #7).
  'import-vcf',
  'log-sync',
  'list-sync-log',
  // S12 — CRUD verbs (partial edits, hard deletes, person merge).
  'edit-person',
  'edit-channel',
  'edit-task',
  'delete-task',
  'delete-entity',
  'merge-person',
] as const;

/**
 * Per-verb flag registry (S9). PARSE_ARGS_OPTIONS is one shared flat map —
 * the parse side has no per-verb view — so this map IS that missing view:
 * which flags each verb accepts, used by `hub __complete` to offer only the
 * flags that make sense for the verb on the command line. Values are typed as
 * keys of PARSE_ARGS_OPTIONS, so a typo'd or unregistered flag name fails
 * typecheck instead of silently offering a flag the parser would reject.
 * Global flags (--db, --json, -h/--help) are offered for every verb in
 * addition to this list and are deliberately NOT repeated here.
 */
export const VERB_FLAGS: Record<string, readonly (keyof typeof PARSE_ARGS_OPTIONS)[]> = {
  init: [],
  'add-person': ['name', 'first-name', 'last-name', 'relationship-type', 'employer', 'notes', 'slug'],
  'get-person': [],
  'list-people': [],
  'add-channel': ['kind', 'value', 'source', 'primary'],
  'list-channels': [],
  'remove-channel': [],
  'set-primary': [],
  'add-task': ['title', 'context', 'person', 'status', 'due-date', 'origin', 'notes', 'trello-visible'],
  'set-task-status': ['status'],
  'list-tasks': ['mirror', 'person', 'status'],
  'add-subtask': ['label'],
  'mark-subtask': ['done'],
  'add-interaction': ['kind', 'date', 'channel', 'summary', 'person'],
  'list-interactions': ['person', 'kind', 'days', 'since'],
  'add-trackable': ['label', 'kind', 'party', 'stage', 'status'],
  'set-trackable-status': ['status'],
  'list-trackables': ['kind', 'status', 'party'],
  'add-trackable-event': ['type', 'date', 'notes'],
  'list-trackable-events': [],
  'add-entity': ['kind', 'label', 'content', 'slug'],
  'list-entities': ['kind'],
  'link-entity': ['target-type', 'target', 'note'],
  'list-entity-links': [],
  'unlink-entity': [],
  'add-file': ['path', 'kind', 'person', 'task', 'note'],
  'list-files': ['person', 'task', 'kind'],
  'import-vcf': ['dry-run'],
  // S12 — CRUD verbs. merge-person takes the from-slug as its positional.
  'edit-person': ['name', 'first-name', 'last-name', 'relationship-type', 'employer', 'notes'],
  'edit-channel': ['kind', 'value'],
  'edit-task': ['title', 'context', 'due-date', 'person', 'notes'],
  'delete-task': [],
  'delete-entity': [],
  'merge-person': ['into'],
  'log-sync': ['entity', 'entity-id', 'action', 'direction', 'adapter', 'detail'],
  'list-sync-log': ['adapter', 'direction', 'entity'],
};

/**
 * Per-verb REQUIRED flags — the completion-side mirror of the handler
 * validations (NOT NULL columns enforced CLI-side). `hub __complete` appends
 * `*` to these flags so a required field is visible on Tab (`--title*`); the
 * shell scripts strip the marker before insertion (zsh displays it via
 * `compadd -d`, bash strips it silently). Verbs whose only required argument
 * is a positional (get-person, list-channels, …) have no entry here —
 * positional requiredness is not a flag concern. Keep this in sync with the
 * command handlers: this map is the discoverable face of those checks. A
 * flag named here but not in VERB_FLAGS is a typecheck error via the same
 * key-of-Options typing.
 */
export const REQUIRED_FLAGS: Record<string, readonly (keyof typeof PARSE_ARGS_OPTIONS)[]> = {
  'add-person': ['name'],
  'add-channel': ['kind', 'value'],
  'add-task': ['title', 'context'],
  'set-task-status': ['status'],
  'add-subtask': ['label'],
  'add-interaction': ['kind', 'date', 'channel', 'summary'],
  'add-trackable': ['label', 'kind'],
  'set-trackable-status': ['status'],
  'add-trackable-event': ['type'],
  'add-entity': ['kind', 'label'],
  'link-entity': ['target-type', 'target'],
  'add-file': ['path', 'kind'],
  'log-sync': ['entity', 'entity-id', 'action'],
};

/**
 * The parse type of one flag — "string" (takes a value) or "boolean" (flag
 * only) — or undefined for an unregistered name. PARSE_ARGS_OPTIONS is an
 * `as const` literal without an index signature, so runtime string lookups
 * must go through this one typed cast; keeping it here means callers ask a
 * readable question instead of casting at every use site.
 */
export function optionType(flag: string): 'string' | 'boolean' | undefined {
  const opt = (PARSE_ARGS_OPTIONS as Record<string, { type: string }>)[flag];
  return opt?.type as 'string' | 'boolean' | undefined;
}
