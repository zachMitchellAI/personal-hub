/**
 * Shared CLI types: JSON/status shapes and verb-handler contracts.
 *
 * Shape conventions:
 * - Each domain has a "fields" interface holding its raw row contract
 *   (snake_case, the machine-readable `--json` contract). Drizzle rows are
 *   camelCase and mapped in `commands/*`; do not serialize drizzle rows raw.
 * - Verb statuses extend the fields interface and add only what is genuinely
 *   different (the `verb` literal, an owner slug, nested children). This keeps
 *   the row contract defined once per domain — adding a column means editing
 *   one base interface, and every status stays in sync automatically.
 * - A status that deliberately echoes only a subset extends the narrowest
 *   base that covers it (e.g. SetPrimaryStatus omits value/source because
 *   set-primary does not return them).
 * Changing any shape is a breaking CLI contract change.
 */

/** `hub init --json` result: S1 guarantees and what the init actually did. */
export interface InitStatus {
  verb: 'init';
  db: string;
  journal_mode: string;
  foreign_keys: boolean;
  user_version: number;
  migrations_applied: number[];
  ok: boolean;
}

/** `hub add-person --json` result for a newly created person row. */
export interface AddPersonStatus {
  verb: 'add-person';
  /** Database row id (autoincrement primary key). */
  id: number;
  /** Immutable lowercase-dashed slug (may differ from the input via --slug). */
  slug: string;
  created_at: string;
}

/** A person row as emitted by `--json` (snake_case CLI contract). */
export interface PersonJson {
  id: number;
  slug: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  relationship_type: string | null;
  employer: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * Channel fields shared by every channel-flavored shape. `ChannelJson` is
 * the full row contract; statuses extend or narrow it as their verb warrants.
 */
interface ChannelFields {
  id: number;
  person_id: number;
  kind: string;
  primary_flag: number;
}

/** One contact channel row as emitted by `--json` (snake_case CLI contract). */
export interface ChannelJson extends ChannelFields {
  value: string;
  source: string | null;
}

/** `hub add-channel --json` result: the created channel, echoed with its person's slug. */
export interface AddChannelStatus extends ChannelJson {
  verb: 'add-channel';
  /** The person's slug, resolved at creation time. */
  slug: string;
}

/** `hub list-channels --json` result for one person. */
export interface ListChannelsStatus {
  verb: 'list-channels';
  slug: string;
  person_id: number;
  count: number;
  channels: ChannelJson[];
}

/** `hub set-primary --json` result: narrows to the fields set-primary reports. */
export interface SetPrimaryStatus extends ChannelFields {
  verb: 'set-primary';
  slug: string;
}

/** `hub remove-channel --json` result. */
export interface RemoveChannelStatus {
  verb: 'remove-channel';
  /** Echoed channel id. */
  id: number;
  /** Always true on success — the verb exits non-zero on any failure. */
  removed: boolean;
}

/**
 * Task fields shared by every task-flavored shape. `TaskJson` is the full row
 * contract (plus nested subtasks); `AddTaskStatus` extends it for the echo.
 */
interface TaskFields {
  id: number;
  title: string;
  /** Nullable — tasks can be people-less. */
  person_id: number | null;
  context: string;
  /** ready/in-progress/completed — DB CHECK `tasks_status_check` backstops. */
  status: string;
  /** ISO calendar date (YYYY-MM-DD) or null; validated at the CLI layer. */
  due_date: string | null;
  /** CLI-managed: stamped on transition to "completed", cleared otherwise. */
  completed_at: string | null;
  origin: string;
  notes: string | null;
  /** 0/1 Trello-mirror visibility flag. */
  trello_visible: number;
  created_at: string;
}

/** A task row as emitted by `--json`; subtasks are nested, ordered by position. */
export interface TaskJson extends TaskFields {
  subtasks: SubtaskJson[];
}

/** `hub add-task --json` result for a newly created task row (no subtasks yet). */
export interface AddTaskStatus extends TaskFields {
  verb: 'add-task';
}

/**
 * Subtask fields shared by every subtask-flavored shape — the base for
 * `SubtaskJson`, `AddSubtaskStatus`, and `MarkSubtaskStatus`, which differ
 * only in their `verb` literal.
 */
interface SubtaskFields {
  id: number;
  task_id: number;
  label: string;
  /** 0/1 done flag — set by `mark-subtask` only. */
  done: number;
  /** Per-task display order, CLI-assigned (append: max + 1). */
  position: number;
}

/** One subtask row as emitted by `--json` (snake_case CLI contract). */
export interface SubtaskJson extends SubtaskFields {}

/** `hub add-subtask --json` result: the created subtask with its assigned position. */
export interface AddSubtaskStatus extends SubtaskFields {
  verb: 'add-subtask';
}

/** `hub mark-subtask --json` result: the subtask's new done state. */
export interface MarkSubtaskStatus extends SubtaskFields {
  verb: 'mark-subtask';
}

/**
 * `hub set-task-status --json` result. Narrows to what set-task-status
 * actually reports — the row's new status plus the CLI-managed completed_at.
 */
export interface SetTaskStatusStatus {
  verb: 'set-task-status';
  id: number;
  status: string;
  /** CLI-stamped on transition to "completed", cleared otherwise. */
  completed_at: string | null;
}

/**
 * Interaction fields shared by every interaction-flavored shape. `InteractionJson`
 * is the full row contract; verb statuses extend it, adding only the `verb` literal.
 */
interface InteractionFields {
  id: number;
  /** Nullable — people-less interactions are valid per the S5 ticket. */
  person_id: number | null;
  /** Free text: call/email/meeting/interview/message… — no enum (DESIGN.md D3). */
  kind: string;
  /** Interaction's calendar date (YYYY-MM-DD); validated at the CLI layer. */
  date: string;
  /** Medium the interaction happened on (e.g. discord, phone, in-person). */
  channel: string;
  /** What happened — free text. */
  summary: string;
  created_at: string;
}

/** An interaction row as emitted by `--json` (snake_case CLI contract). */
export interface InteractionJson extends InteractionFields {}

/** `hub add-interaction --json` result: the created interaction, echoed. */
export interface AddInteractionStatus extends InteractionFields {
  verb: 'add-interaction';
}

/** `hub list-interactions --json` result. */
export interface ListInteractionsStatus {
  verb: 'list-interactions';
  count: number;
  /** Echo of --days (calendar-day window), or null when not used. */
  days: number | null;
  /** Echo of --since (window start date), or null when not used. */
  since: string | null;
  interactions: InteractionJson[];
}

/** `hub list-tasks --json` result. */
export interface ListTasksStatus {
  verb: 'list-tasks';
  count: number;
  /** True when the Trello-mirror filter (--mirror) was applied. */
  mirror: boolean;
  tasks: TaskJson[];
}

/**
 * Entity fields shared by every entity-flavored shape. `EntityJson` is the
 * full row contract; verb statuses extend it, adding only the `verb` literal.
 */
interface EntityFields {
  id: number;
  /** Immutable lowercase-dashed slug, derived from the label (or --slug override). */
  slug: string;
  /** Free text: concept/project/artifact/… — kinds are data (DESIGN.md D3). */
  kind: string;
  /** What the entity is called; the slug is derived from this. */
  label: string;
  /** Free-form payload; nullable. */
  content: string | null;
  created_at: string;
}

/** An entity row as emitted by `--json` (snake_case CLI contract). */
export interface EntityJson extends EntityFields {}

/** `hub add-entity --json` result: the created entity, echoed. */
export interface AddEntityStatus extends EntityFields {
  verb: 'add-entity';
}

/** `hub list-entities --json` result. */
export interface ListEntitiesStatus {
  verb: 'list-entities';
  count: number;
  /** Echo of --kind, or null when unfiltered. */
  kind: string | null;
  entities: EntityJson[];
}

/**
 * Entity-link fields shared by every link-flavored shape. `target_label` is
 * resolved at list/write time from the target table (person display name,
 * task title, trackable label, interaction summary, file path); null means
 * the target row no longer exists — entity_links has no DB FK on the
 * polymorphic target, so dangling links are surfaced, not hidden.
 */
interface EntityLinkFields {
  id: number;
  entity_id: number;
  /** person/task/trackable/interaction/file — see ENTITY_LINK_TARGETS. */
  target_type: string;
  /** Row id in the target table. */
  target_id: number;
  note: string | null;
  /** Resolved human label of the target; null when the target row is gone. */
  target_label: string | null;
}

/** One entity link row as emitted by `--json` (snake_case CLI contract). */
export interface EntityLinkJson extends EntityLinkFields {}

/** `hub link-entity --json` result: the created link, with its target resolved. */
export interface LinkEntityStatus extends EntityLinkFields {
  verb: 'link-entity';
}

/** `hub list-entity-links --json` result. */
export interface ListEntityLinksStatus {
  verb: 'list-entity-links';
  entity_id: number;
  /** The entity's slug, echoed for readability. */
  slug: string;
  count: number;
  links: EntityLinkJson[];
}

/** `hub unlink-entity --json` result. */
export interface UnlinkEntityStatus {
  verb: 'unlink-entity';
  /** Echoed link id. */
  id: number;
  /** Always true on success — the verb exits non-zero on any failure. */
  removed: boolean;
}

/**
 * File fields shared by every file-flavored shape. `FileJson` is the full
 * row contract; verb statuses extend it, adding only the `verb` literal.
 */
interface FileFields {
  id: number;
  /** Path as given (e.g. ~/hub/files/<slug>/x.pdf) — the CLI never touches disk. */
  path: string;
  /** Free text; canonical families: pdf/apk/html/image/project. */
  kind: string;
  /** Nullable person link; SET NULL when the person row is deleted. */
  person_id: number | null;
  /** Nullable task link; SET NULL when the task row is deleted. */
  task_id: number | null;
  added_at: string;
  note: string | null;
}

/** A file row as emitted by `--json` (snake_case CLI contract). */
export interface FileJson extends FileFields {}

/** `hub add-file --json` result: the indexed file, echoed. */
export interface AddFileStatus extends FileFields {
  verb: 'add-file';
}

/** `hub list-files --json` result. */
export interface ListFilesStatus {
  verb: 'list-files';
  count: number;
  /** Echo of --kind, or null when unfiltered. */
  kind: string | null;
  files: FileJson[];
}

/**
 * Sync-log entry fields shared by every sync-log-flavored shape. The
 * idempotency identity is (adapter, direction, entity, entity_id, action) —
 * enforced by the `sync_log_idempotency` UNIQUE index.
 */
interface SyncLogFields {
  id: number;
  /** in (external→hub) or out (hub→external). */
  direction: string;
  /** Sync engine, e.g. trello-cli. */
  adapter: string;
  /** Synced domain — the table name, e.g. "task". */
  entity: string;
  /** Row id in that domain. */
  entity_id: number;
  /** What the sync did, e.g. move/create/archive. */
  action: string;
  /** ISO timestamp of when the action was logged. */
  ts: string;
  detail: string | null;
}

/** A sync_log row as emitted by `--json` (snake_case CLI contract). */
export interface SyncLogJson extends SyncLogFields {}

/**
 * `hub log-sync --json` result. Echoes `logged: false` when the entry was an
 * idempotent no-op — the identity already exists, so the existing row is
 * returned unchanged instead of adding a new one (exit 0 either way).
 */
export interface LogSyncStatus extends SyncLogFields {
  verb: 'log-sync';
  /** True when a new row was written; false for an idempotent re-log. */
  logged: boolean;
}

/** `hub list-sync-log --json` result. */
export interface ListSyncLogStatus {
  verb: 'list-sync-log';
  count: number;
  /** Echo of --adapter, or null when unfiltered. */
  adapter: string | null;
  /** Echo of --direction, or null when unfiltered. */
  direction: string | null;
  /** Echo of --entity, or null when unfiltered. */
  entity: string | null;
  entries: SyncLogJson[];
}

/**
 * Parsed `--flags` from `node:util` parseArgs, shared by every verb.
 * Values arrive unvalidated: handlers must narrow/cast per-verb, which is
 * why verb-specific value interfaces (below) declare what each verb consumes.
 */
export type CliValues = Record<string, string | boolean | undefined>;

/**
 * Flags consumed by `hub add-person`, on top of the shared `--db`/`--json`.
 * Declared here so the handler's input contract is visible in types.ts:
 * `name` is required at runtime (the handler re-checks) and `slug` is the
 * optional lowercase-dashed override.
 */
export interface AddPersonValues extends CliValues {
  /** Display name — required; the CLI derives the slug from it if --slug is absent. */
  name?: string;
  /** Optional slug override; must already be lowercase-dashed or the verb errors. */
  slug?: string;
}

/** Flags consumed by `hub add-task`. `title` and `context` are required at runtime (the handler re-checks). */
export interface AddTaskValues extends CliValues {
  /** Task title — required. */
  title?: string;
  /** Free-text context tag (job-hunt/discord/…) — required per S4 (column is NOT NULL). */
  context?: string;
  /** Optional person link, by slug; resolved before insert. */
  person?: string;
  /** Optional initial status; defaults to "ready". Validated against TASK_STATUSES. */
  status?: string;
  /** Optional due date; must be a deterministic ISO date (YYYY-MM-DD). */
  'due-date'?: string;
  /** Optional origin; defaults to "self". Free text per S4 (no CHECK). */
  origin?: string;
  /** Free-form notes. */
  notes?: string;
  /** Flag: mark the task visible to the Trello mirror (trello_visible=1). */
  'trello-visible'?: boolean;
}

/** Flags consumed by `hub set-task-status`. `status` is required at runtime (the handler re-checks). */
export interface SetTaskStatusValues extends CliValues {
  /** New status; must be one of TASK_STATUSES. */
  status?: string;
}

/** Flags consumed by `hub list-tasks`. All filters optional; combinable. */
export interface ListTasksValues extends CliValues {
  /** Flag: apply the Trello-mirror filter (trello_visible=1 AND status in ready/in-progress). */
  mirror?: boolean;
  /** Optional person filter, by slug. */
  person?: string;
  /** Optional status filter; validated against TASK_STATUSES when present. */
  status?: string;
}

/** Flags consumed by `hub add-subtask`. `label` is required at runtime (the handler re-checks). */
export interface AddSubtaskValues extends CliValues {
  /** Subtask label — required. */
  label?: string;
}

/** Flags consumed by `hub mark-subtask`. */
export interface MarkSubtaskValues extends CliValues {
  /** "0" or "1"; defaults to "1" (mark done). */
  done?: string;
}

/** Flags consumed by `hub add-interaction`. `kind`, `date`, `channel`, and `summary` are required at runtime (the handler re-checks). */
export interface AddInteractionValues extends CliValues {
  /** Interaction kind — free text, required (NOT NULL column). */
  kind?: string;
  /** Interaction date — required; must be a deterministic ISO date (YYYY-MM-DD). */
  date?: string;
  /** Medium/channel — required (NOT NULL column). */
  channel?: string;
  /** What happened — required (NOT NULL column). */
  summary?: string;
  /** Optional person link, by slug; resolved before insert. */
  person?: string;
}

/** Flags consumed by `hub list-interactions`. All filters optional; combinable. */
export interface ListInteractionsValues extends CliValues {
  /** Optional person filter, by slug. */
  person?: string;
  /** Optional kind filter (exact match, free text). */
  kind?: string;
  /** Last-N-days window: date >= today − N days (UTC). Positive integer. */
  days?: string;
  /** Window start: date >= this ISO date (YYYY-MM-DD). */
  since?: string;
}

/**
 * Trackable fields shared by every trackable-flavored shape. `TrackableJson`
 * is the full row contract; verb statuses extend it, adding only the `verb` literal.
 */
interface TrackableFields {
  id: number;
  /** What it is — free text ("Acme panel", "new laptop", "refill"). */
  label: string;
  /** Free text: job-application/order/prescription/signup… — no enum. */
  kind: string;
  /** The entity on the other side, e.g. "Acme Corp"; null for personal signups. */
  party: string | null;
  /** Where in the process it sits — free text, NOT an enum (stages vary per kind). */
  stage: string;
  /** "active" or "closed" — the one DB-CHECKed column (same pattern as tasks.status). */
  status: string;
  created_at: string;
}

/** A trackable row as emitted by `--json` (snake_case CLI contract). */
export interface TrackableJson extends TrackableFields {}

/** `hub add-trackable --json` result: the created trackable, echoed. */
export interface AddTrackableStatus extends TrackableFields {
  verb: 'add-trackable';
}

/** `hub set-trackable-status --json` result. */
export interface SetTrackableStatusStatus {
  verb: 'set-trackable-status';
  id: number;
  status: string;
}

/** `hub list-trackables --json` result. */
export interface ListTrackablesStatus {
  verb: 'list-trackables';
  count: number;
  /** Echo of --status, or null when unfiltered. */
  status: string | null;
  trackables: TrackableJson[];
}

/**
 * Trackable-event fields shared by every event-flavored shape.
 */
interface TrackableEventFields {
  id: number;
  trackable_id: number;
  /** ISO calendar date (YYYY-MM-DD); CLI-validated. */
  event_date: string;
  /** Free text — what happened ("thank-you note sent", "shipped", "refilled"). */
  event_type: string;
  notes: string | null;
}

/** A trackable event row as emitted by `--json`. */
export interface TrackableEventJson extends TrackableEventFields {}

/** `hub add-trackable-event --json` result. */
export interface AddTrackableEventStatus extends TrackableEventFields {
  verb: 'add-trackable-event';
}

/** `hub list-trackable-events --json` result: one trackable's trail, in order. */
export interface ListTrackableEventsStatus {
  verb: 'list-trackable-events';
  trackable_id: number;
  count: number;
  events: TrackableEventJson[];
}

/** Flags consumed by `hub add-trackable`. `label` and `kind` are required at runtime (the handler re-checks). */
export interface AddTrackableValues extends CliValues {
  /** What it is — required (NOT NULL column). */
  label?: string;
  /** Process kind — free text, required (NOT NULL column). */
  kind?: string;
  /** The entity on the other side; optional (nullable column). */
  party?: string;
  /** Where in the process it sits; defaults to "started" at the CLI. */
  stage?: string;
  /** "active" (default) or "closed"; validated against TRACKABLE_STATUSES. */
  status?: string;
}

/** Flags consumed by `hub list-trackables`. All filters optional; combinable. */
export interface ListTrackablesValues extends CliValues {
  /** Optional kind filter (exact match, free text). */
  kind?: string;
  /** Optional status filter — "active" or "closed". */
  status?: string;
  /** Optional party filter (exact match, free text). */
  party?: string;
}

/** Flags consumed by `hub set-trackable-status`. */
export interface SetTrackableStatusValues extends CliValues {
  /** "active" or "closed" — required, validated against TRACKABLE_STATUSES. */
  status?: string;
}

/** Flags consumed by `hub add-trackable-event`. `--type` is required; `--date` defaults to today. */
export interface AddTrackableEventValues extends CliValues {
  /** Event type — free text, required (NOT NULL column). */
  type?: string;
  /** ISO date (YYYY-MM-DD); optional — defaults to today (UTC-anchored). */
  date?: string;
  /** Free text notes; optional (nullable column). */
  notes?: string;
}

/** Flags consumed by `hub add-entity`. `kind` and `label` are required at runtime (the handler re-checks). */
export interface AddEntityValues extends CliValues {
  /** Entity kind — free text, required (NOT NULL column). */
  kind?: string;
  /** Entity label — required; the slug is derived from it unless --slug overrides. */
  label?: string;
  /** Free-form content/payload; optional (nullable column). */
  content?: string;
  /** Optional slug override; must already be lowercase-dashed or the verb errors. */
  slug?: string;
}

/** Flags consumed by `hub list-entities`. */
export interface ListEntitiesValues extends CliValues {
  /** Optional kind filter (exact match, free text). */
  kind?: string;
}

/** Flags consumed by `hub link-entity`. `target-type` and `target` are required at runtime (the handler re-checks). */
export interface LinkEntityValues extends CliValues {
  /** Target table: person/task/trackable/interaction/file — required. */
  'target-type'?: string;
  /** Target reference — a person slug or a numeric row id; required. */
  target?: string;
  /** Free-form note about the link; optional (nullable column). */
  note?: string;
}

/** Flags consumed by `hub unlink-entity` (id comes in as the positional). */
export interface UnlinkEntityValues extends CliValues {}

/** Flags consumed by `hub add-file`. `path` and `kind` are required at runtime (the handler re-checks). */
export interface AddFileValues extends CliValues {
  /** File path — required, stored as given (no disk I/O). */
  path?: string;
  /** File kind — required (NOT NULL column); free text. */
  kind?: string;
  /** Optional person link, by slug; resolved before insert. */
  person?: string;
  /** Optional task link, by numeric id; resolved before insert. */
  task?: string;
  /** Free-form note; optional (nullable column). */
  note?: string;
}

/** Flags consumed by `hub list-files`. All filters optional; combinable. */
export interface ListFilesValues extends CliValues {
  /** Optional person filter, by slug. */
  person?: string;
  /** Optional task filter, by numeric id. */
  task?: string;
  /** Optional kind filter (exact match, free text). */
  kind?: string;
}

/** Flags consumed by `hub log-sync`. `entity`, `entity-id`, and `action` are required at runtime (the handler re-checks). */
export interface LogSyncValues extends CliValues {
  /** Synced domain (table name) — required. */
  entity?: string;
  /** Synced row id — required, numeric. */
  'entity-id'?: string;
  /** What the sync did — required, free text. */
  action?: string;
  /** in/out; defaults to "out". Validated against SYNC_DIRECTIONS. */
  direction?: string;
  /** Sync adapter; defaults to "trello-cli". Free text (adapters are data). */
  adapter?: string;
  /** Free-form detail; optional (nullable column). */
  detail?: string;
}

/** Flags consumed by `hub list-sync-log`. All filters optional; combinable. */
export interface ListSyncLogValues extends CliValues {
  /** Optional adapter filter (exact match). */
  adapter?: string;
  /** Optional direction filter — in or out. */
  direction?: string;
  /** Optional entity filter (exact match). */
  entity?: string;
}

/**
 * A verb handler takes parsed flags, an optional positional argument (the
 * second positional: slug or channel id), and returns the process exit code.
 */
// Note: plain object maps, not TS enums — enums are not erasable syntax and
// crash under Node 24's type stripping.
export type VerbHandler = (values: CliValues, positional?: string) => number | Promise<number>;
