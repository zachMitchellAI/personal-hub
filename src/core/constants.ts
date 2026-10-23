// Shared constants for the hub CLI (DESIGN.md layer 2).
export const VERSION = '0.9.0';

// Task status values (S4). The DB CHECK `tasks_status_check` backstops this
// list; the CLI validates first so driver errors never surface to users.
export const TASK_STATUSES = ['ready', 'in-progress', 'completed'] as const;

// Trackable status values (S6). The DB CHECK `trackables_status_check`
// backstops this list; the CLI validates first so driver errors never
// surface to users.
export const TRACKABLE_STATUSES = ['active', 'closed'] as const;

// Entity-link target types (S7). entity_links.target_id is polymorphic, so
// integrity is a write-path rule: the CLI resolves the target row before
// insert. "application" became "trackable" when S6 generalized applications
// (DECISIONS #17) — the applications table no longer exists.
export const ENTITY_LINK_TARGETS = ['person', 'task', 'trackable', 'interaction', 'file'] as const;

// Sync-log directions (S7). Free text in the DB (the S7 ticket requests no
// CHECK), but the CLI narrows to these two values so a typo'd --direction is
// a usage error rather than a permanently mislabelled ledger row.
export const SYNC_DIRECTIONS = ['in', 'out'] as const;

// Help text. A plain constant (not a tagged template function): it is read
// exactly once per process, and VERSION lives in this same file, so direct
// interpolation is the zero-indirection shape.
export const USAGE = `hub v${VERSION} — personal hub CLI

Verbs:
  init            Create/upgrade life.db: WAL mode, foreign keys ON, apply pending migrations.
  add-person      Add a person. Slug is derived from --name (lowercase-dashed, immutable).
  get-person      Look up one person by slug: hub get-person <slug>
  list-people     List all people, ordered by slug.
  add-channel     Add a contact channel to a person: hub add-channel <slug> --kind <k> --value <v>
                  kind is free text (email/phone/discord/mastodon/... any string, no enum).
  list-channels   List a person's channels: hub list-channels <slug> (ordered by kind, id).
  remove-channel  Remove one channel by id: hub remove-channel <id>
  set-primary     Make one channel the primary for its (person, kind): hub set-primary <id>
                  At most one primary per (person, kind) — enforced here, in the write path.
  add-task        Add a task: hub add-task --title <t> --context <c> [--person <slug>]
                  status defaults to "ready"; due-date must be a deterministic ISO
                  date (YYYY-MM-DD) — fuzzy dates like "next friday" are rejected.
  set-task-status Update a task's status: hub set-task-status <id> --status <s>
                  status: ready/in-progress/completed. Moving to "completed" stamps
                  completed_at (CLI-set, never a free value); moving away clears it.
  list-tasks      List tasks ordered by id. Filters: --mirror (trello_visible=1 AND
                  status in ready/in-progress), --person <slug>, --status <s>.
                  Subtasks are nested in --json output, ordered by position.
  add-subtask     Append a subtask to a task: hub add-subtask <task-id> --label <l>
                  position is assigned automatically (max + 1 per task).
  mark-subtask    Set a subtask's done flag: hub mark-subtask <subtask-id> [--done <0|1>]
                  defaults to done. Sibling subtasks and ordering are untouched.
  add-interaction Log an interaction: hub add-interaction --kind <k> --date <YYYY-MM-DD>
                  --channel <c> --summary <s> [--person <slug>]. People-less
                  interactions are valid — omit --person. kind is free text
                  (call/email/meeting/interview/message…).
  list-interactions List interactions newest first (date descending, ties by id).
                  Filters: --person <slug>, --kind <k>, --days <n> (last N
                  calendar days), --since <YYYY-MM-DD> (date >= this day).
  add-trackable   Add a trackable (a process with a lifecycle, e.g. a job
                  application): hub add-trackable --label <l> --kind <k>
                  [--party <p>] [--stage <s>] [--status <active|closed>].
                  stage is free text (stages are data — a custom stage like
                  "team-fit-round-2" persists without schema change) and
                  defaults to "started"; status defaults to "active".
  set-trackable-status Update a trackable's status: hub set-trackable-status <id>
                  --status <active|closed>. Closure never touches events —
                  the event trail remains intact.
  list-trackables List trackables ordered by id. Filters (combinable):
                  --kind <k>, --status <active|closed>, --party <p>.
  add-trackable-event Append an event to a trackable's trail: hub
                  add-trackable-event <trackable-id> --type <t> [--date <d>]
                  [--notes <n>]. type is free text; date defaults to today
                  (UTC-anchored) and must be a deterministic ISO date.
  list-trackable-events Show one trackable's event trail oldest first
                  (event_date ascending, ties by id): hub
                  list-trackable-events <trackable-id>.
  add-entity      Add an entity (anything worth indexing that is not already
                  a person/task/interaction): hub add-entity --kind <k>
                  --label <l> [--content <c>] [--slug <s>]. Slug is derived
                  from --label with the same rules as people (or overridden
                  by --slug, which must be lowercase-dashed). Entities have
                  no status column — no lifecycle, no set-status verb.
  list-entities   List entities ordered by slug. Filter: --kind <k>.
  link-entity     Link an entity to another hub row: hub link-entity <slug>
                  --target-type <t> --target <ref> [--note <n>]. target-type:
                  person/task/trackable/interaction/file. --target is a slug
                  for person, a numeric id for the others. The target is
                  resolved at write time — invalid targets are usage errors.
  list-entity-links Show one entity's links, each resolved to its target's
                  human label: hub list-entity-links <slug>. A null
                  target_label means the target row no longer exists.
  unlink-entity   Remove one entity link by id: hub unlink-entity <link-id>.
  add-file        Index a durable artifact on disk: hub add-file --path <p>
                  --kind <k> [--person <slug>] [--task <id>] [--note <n>].
                  The CLI stores the path as given and never touches disk —
                  keep artifacts under ~/hub/files/<slug>/... (convention).
                  kind is free text; the canonical families are
                  pdf/apk/html/image/project.
  list-files      List indexed files ordered by id. Filters (combinable):
                  --person <slug>, --task <id>, --kind <k>.
  log-sync        Record one sync action in the ledger: hub log-sync
                  --entity <e> --entity-id <id> --action <a> [--direction
                  <in|out>] [--adapter <a>] [--detail <d>]. direction
                  defaults to "out", adapter to "trello-cli". Logging the
                  same (adapter, direction, entity, entity_id, action) again
                  is idempotent: no new row, exit 0.
  list-sync-log   List the sync ledger oldest first (ts ascending, ties by
                  id). Filters (combinable): --adapter <a>, --direction <d>,
                  --entity <e>.

Flags:
  --db <path>              Database path (default $HUB_DB or ~/hub/life.db)
  --json                   Machine-readable output on stdout
  -h, --help               Show this help

add-person options:
  --name <value>           Display name (required)
  --first-name <value>     Given name
  --last-name <value>      Family name
  --relationship-type <v>  free text, e.g. family/friend/professional (no enum)
  --employer <value>       Employer
  --notes <value>          Free-form notes
  --slug <value>           Override the derived slug (must be lowercase-dashed)

add-channel options:
  --kind <value>           Channel kind — free text, no enum (e.g. email, discord, mastodon)
  --value <value>          The channel value (e.g. handle, address, number)
  --source <value>         Where it came from (e.g. vcf-import, manual)
  --primary                Mark this channel primary for its (person, kind);
                           demotes an existing primary of the same (person, kind).

add-task options:
  --title <value>          Task title (required)
  --context <value>        Free text tag (required) — job-hunt/discord/family/...
  --person <slug>          Optional person link (by slug)
  --status <value>         ready/in-progress/completed (default ready)
  --due-date <value>       ISO calendar date YYYY-MM-DD (deterministic dates only)
  --origin <value>         Origin tag (default self; free text accepted)
  --notes <value>          Free-form notes
  --trello-visible         Mark visible to the Trello mirror (trello_visible=1)

set-task-status options:
  --status <value>         New status: ready/in-progress/completed (required)

list-tasks options:
  --mirror                 Only tasks with trello_visible=1 AND status in
                           ready/in-progress (the Trello-mirror query)
  --person <slug>          Only tasks linked to this person
  --status <value>         Only tasks with this status

add-subtask options:
  --label <value>          Subtask label (required)

mark-subtask options:
  --done <0|1>             1 = done (default), 0 = not done

add-interaction options:
  --kind <value>           Interaction kind (required) — call/email/meeting/interview/message/...
  --date <value>           Interaction date (required) — ISO calendar date YYYY-MM-DD
  --channel <value>        Medium it happened on (required) — e.g. discord, phone, in-person
  --summary <value>        What happened (required) — free text
  --person <slug>          Optional person link (by slug); omit for people-less interactions

list-interactions options:
  --person <slug>          Only interactions linked to this person
  --kind <value>           Only interactions of this kind (exact match)
  --days <n>               Only interactions within the last N calendar days
  --since <value>          Only interactions on/after this ISO date (YYYY-MM-DD)

add-trackable options:
  --label <value>          Trackable label (required) — e.g. the role title
  --kind <value>           Trackable kind (required) — free text, e.g. application, referral, lead
  --party <value>          Other party (e.g. company); omit for a personal signup
  --stage <value>          Free-text stage (default "started")
  --status <value>         active/closed (default active)

set-trackable-status options:
  --status <value>         New status: active/closed (required)

list-trackables options:
  --kind <value>           Only trackables of this kind (exact match)
  --status <value>         Only trackables with this status (active/closed)
  --party <value>          Only trackables with this party (exact match)

add-trackable-event options:
  --type <value>           Event type (required) — free text, e.g. "thank-you note sent"
  --date <value>           Event date — ISO calendar date YYYY-MM-DD (default: today)
  --notes <value>          Free-form notes

add-entity options:
  --kind <value>           Entity kind (required) — free text, e.g. concept, project, artifact
  --label <value>          Entity label (required) — the slug is derived from it
  --content <value>        Free-form content/payload
  --slug <value>           Override the derived slug (must be lowercase-dashed)

list-entities options:
  --kind <value>           Only entities of this kind (exact match)

link-entity options:
  --target-type <value>    person/task/trackable/interaction/file (required)
  --target <value>         Target reference (required) — person slug, or numeric id otherwise
  --note <value>           Free-form note about the link

add-file options:
  --path <value>           File path (required) — stored as given, e.g. ~/hub/files/<slug>/x.pdf
  --kind <value>           File kind (required) — pdf/apk/html/image/project (free text)
  --person <slug>          Optional person link (by slug)
  --task <id>              Optional task link (numeric id)
  --note <value>           Free-form note

list-files options:
  --person <slug>          Only files linked to this person
  --task <id>              Only files linked to this task (numeric id)
  --kind <value>           Only files of this kind (exact match)

log-sync options:
  --entity <value>         Synced domain (required) — e.g. task, trackable
  --entity-id <value>      Synced row id (required, numeric)
  --action <value>         What the sync did (required) — e.g. move, create
  --direction <value>      in/out (default out)
  --adapter <value>        Sync adapter (default trello-cli)
  --detail <value>         Free-form detail (e.g. target Trello list)

list-sync-log options:
  --adapter <value>        Only entries from this adapter
  --direction <value>      Only entries in this direction (in/out)
  --entity <value>         Only entries for this domain

import-vcf <file.vcf> [--dry-run]
  Import contacts from a vCard 2.1 file. FN/N → display_name + derived slug
  (add-person rules); TEL → phone channels, EMAIL → email channels; ORG →
  employer; TITLE/ADR/BDAY/URL/NOTE → notes; BASE64 photos are written to
  ~/hub/files/<slug>/ and indexed in the files table. X-* properties are
  ignored. Re-runnable: existing slug/phone/email matches are skipped and
  reported, never duplicated (DECISIONS #7). --dry-run reports what would
  happen without writing any rows or files.

Environment:
  HUB_DB           Default database path
  HUB_FILES        Durable files root (default: ~/hub/files)
  HUB_MIGRATIONS   Migrations directory (default: ./migrations beside this file)`;
