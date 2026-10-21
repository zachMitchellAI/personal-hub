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

/** `hub list-tasks --json` result. */
export interface ListTasksStatus {
  verb: 'list-tasks';
  count: number;
  /** True when the Trello-mirror filter (--mirror) was applied. */
  mirror: boolean;
  tasks: TaskJson[];
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

/**
 * A verb handler takes parsed flags, an optional positional argument (the
 * second positional: slug or channel id), and returns the process exit code.
 */
// Note: plain object maps, not TS enums — enums are not erasable syntax and
// crash under Node 24's type stripping.
export type VerbHandler = (values: CliValues, positional?: string) => number | Promise<number>;
