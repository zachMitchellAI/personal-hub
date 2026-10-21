// Shared constants for the hub CLI (DESIGN.md layer 2).
export const VERSION = '0.4.0';

// Task status values (S4). The DB CHECK `tasks_status_check` backstops this
// list; the CLI validates first so driver errors never surface to users.
export const TASK_STATUSES = ['ready', 'in-progress', 'completed'] as const;

// Help text. A plain constant (not a tagged template function): it is read
// exactly once per process, and VERSION lives in this same file, so direct
// interpolation is the zero-indirection shape.
export const USAGE = `hub v${VERSION} — personal hub CLI (zero dependencies)

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

Environment:
  HUB_DB           Default database path
  HUB_MIGRATIONS   Migrations directory (default: ./migrations beside this file)`;
