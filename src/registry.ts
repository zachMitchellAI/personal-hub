// The CLI's verb + flag registry — hub.ts's dispatch data. Extracted from
// hub.ts (S9) so the completion engine can read the same source of truth the
// dispatcher uses; the pure-DATA half (flag maps, verb-name list, optionType)
// lives in core/registry-data.ts so `hub __complete` can answer a tab press
// without importing this module's command handlers (perf pass 2026-10-24:
// completion was paying ~700ms of drizzle/schema/command imports it never
// used).
//
// hub.ts stays the entry point (parse, dispatch, top-level errors); this file
// is the data it dispatches with.
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
import { cmdImportVcf } from './commands/import-vcf.ts';
import { cmdListSyncLog, cmdLogSync } from './commands/sync.ts';
import {
  cmdAddTrackable,
  cmdAddTrackableEvent,
  cmdListTrackableEvents,
  cmdListTrackables,
  cmdSetTrackableStatus,
} from './commands/trackables.ts';
import { cmdAddSubtask, cmdAddTask, cmdListTasks, cmdMarkSubtask, cmdSetTaskStatus } from './commands/tasks.ts';
import { PARSE_ARGS_OPTIONS, VERB_FLAGS, VERB_NAMES, optionType } from './core/registry-data.ts';

export { PARSE_ARGS_OPTIONS, VERB_FLAGS, optionType };
export { VERB_NAMES };

/**
 * Verb registry — the single source of truth for the verb → handler mapping.
 * Adding a verb means adding a `cmd*` export in `commands/`, one line here,
 * AND its name in VERB_NAMES (core/registry-data.ts) so completion sees it.
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
  // S8b — permanent re-runnable contact importer (DECISIONS #7).
  'import-vcf': cmdImportVcf,
  'log-sync': cmdLogSync,
  'list-sync-log': cmdListSyncLog,
};
