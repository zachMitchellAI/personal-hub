// Shared constants for the hub CLI (DESIGN.md layer 2).
export const VERSION = '0.3.0';

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

Environment:
  HUB_DB           Default database path
  HUB_MIGRATIONS   Migrations directory (default: ./migrations beside this file)`;
