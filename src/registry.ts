// The CLI's verb + flag registry, extracted from hub.ts (S9) so the
// completion engine (commands/completion.ts) can read the same source of
// truth the dispatcher uses — without a circular import back into the entry
// point. hub.ts stays the entry point (parse, dispatch, top-level errors);
// this file is the data it dispatches with.
import type { VerbHandler } from './core/types.ts';
import { cmdInit } from './commands/init.ts';
import { cmdAddPerson, cmdGetPerson, cmdListPeople } from './commands/people.ts';
import { cmdAddChannel, cmdListChannels, cmdRemoveChannel, cmdSetPrimary } from './commands/channels.ts';
import { cmdAddInteraction, cmdListInteractions } from './commands/interactions.ts';
import {
  cmdAddEntity,
  cmdLinkEntity,
  cmdListEntities,
  cmdListEntityLinks,
  cmdUnlinkEntity,
} from './commands/entities.ts';
import { cmdAddFile, cmdListFiles } from './commands/files.ts';
import { cmdListSyncLog, cmdLogSync } from './commands/sync.ts';
import {
  cmdAddTrackable,
  cmdAddTrackableEvent,
  cmdListTrackableEvents,
  cmdListTrackables,
  cmdSetTrackableStatus,
} from './commands/trackables.ts';
import { cmdAddSubtask, cmdAddTask, cmdListTasks, cmdMarkSubtask, cmdSetTaskStatus } from './commands/tasks.ts';

/**
 * Verb registry — the single source of truth for the verb → handler mapping.
 * Adding a verb means adding a `cmd*` export in `commands/` and one line here.
 * Plain object map, not a TS enum: enums are not erasable syntax and crash
 * under Node 24's type stripping. `__complete` is deliberately NOT here: it
 * is a hidden verb dispatched specially in hub.ts, and keeping it out of this
 * map keeps it out of verb-name completions and help text.
 */
export const VERBS: Record<string, VerbHandler> = {
  // init takes scalar flags rather than a positional, so it gets a tiny adapter.
  init: (values) => cmdInit(values.db as string | undefined, values.json === true),
  'add-person': cmdAddPerson,
  'get-person': cmdGetPerson,
  'list-people': cmdListPeople,
  'add-channel': cmdAddChannel,
  'list-channels': cmdListChannels,
  'remove-channel': cmdRemoveChannel,
  'set-primary': cmdSetPrimary,
  'add-task': cmdAddTask,
  'set-task-status': cmdSetTaskStatus,
  'list-tasks': cmdListTasks,
  'add-subtask': cmdAddSubtask,
  'mark-subtask': cmdMarkSubtask,
  'add-interaction': cmdAddInteraction,
  'list-interactions': cmdListInteractions,
  'add-trackable': cmdAddTrackable,
  'set-trackable-status': cmdSetTrackableStatus,
  'list-trackables': cmdListTrackables,
  'add-trackable-event': cmdAddTrackableEvent,
  'list-trackable-events': cmdListTrackableEvents,
  // S7 — entities/links/files/sync_log. Entities have no status column, so
  // no set-status verb exists for them (lifecycle-free by design).
  'add-entity': cmdAddEntity,
  'list-entities': cmdListEntities,
  'link-entity': cmdLinkEntity,
  'list-entity-links': cmdListEntityLinks,
  'unlink-entity': cmdUnlinkEntity,
  'add-file': cmdAddFile,
  'list-files': cmdListFiles,
  'log-sync': cmdLogSync,
  'list-sync-log': cmdListSyncLog,
};

/**
 * Shared flag schema for `node:util` parseArgs — ALL verbs' flags in one map,
 * so a flag name can only be declared once across the whole CLI (TS1117
 * catches collisions). Same flag means same meaning (free text), which is why
 * sharing is safe.
 */
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
} as const;

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
  'log-sync': ['entity', 'entity-id', 'action', 'direction', 'adapter', 'detail'],
  'list-sync-log': ['adapter', 'direction', 'entity'],
};
