# hub verb reference

Curated guide with examples. The authoritative list is always
`node src/hub.ts --help` — if this file and `--help` disagree, trust `--help`.

Global flags on every verb:

- `--db <path>` — database path (default `$HUB_DB` or `~/hub/life.db`)
- `--json` — machine-readable output on stdout (snake_case keys)
- `-h, --help` — usage

## Database

```sh
node src/hub.ts init   # create/upgrade life.db (WAL, FKs ON, apply migrations)
```

Only needed once per database (or after pulling new migrations). Never run
against a path other than the default unless the user asked for a throwaway.

## People & channels

| Verb | Purpose |
| --- | --- |
| `add-person` | Add a person; slug derived from `--name` |
| `get-person <slug>` | Look up one person |
| `list-people` | All people, ordered by slug |
| `add-channel <slug>` | Add a contact channel to a person |
| `list-channels <slug>` | A person's channels |
| `remove-channel <id>` | Remove one channel by id |
| `set-primary <id>` | Make a channel primary for its (person, kind) |

```sh
node src/hub.ts add-person --name "Ada Lovelace" --relationship-type professional --employer "Analytical Engines Ltd"
node src/hub.ts get-person ada-lovelace --json
node src/hub.ts add-channel ada-lovelace --kind email --value ada@example.com --source manual
node src/hub.ts list-channels ada-lovelace --json
```

`add-person` extras: `--first-name`, `--last-name`, `--notes`, `--slug`
(override; must be lowercase-dashed). `add-channel` extras: `--source`,
`--primary` (demotes the existing primary for the same person+kind — at most
one primary per (person, kind), enforced in the write path).

## Tasks & subtasks

| Verb | Purpose |
| --- | --- |
| `add-task` | Add a task (`--title`, `--context` required) |
| `set-task-status <id>` | `--status ready/in-progress/completed` |
| `list-tasks` | List; filters `--mirror`, `--person`, `--status` |
| `add-subtask <task-id>` | Append a subtask (`--label`) |
| `mark-subtask <id>` | Set done flag: `--done <0\|1>` (default 1) |

```sh
node src/hub.ts add-task --title "Send thank-you note" --context job-hunt --person ada-lovelace --due-date 2026-10-30
node src/hub.ts list-tasks --json           # subtasks nested in JSON output
node src/hub.ts set-task-status 12 --status completed
```

`--due-date` must be `YYYY-MM-DD` — fuzzy dates are rejected, resolve them
first. `--origin` defaults to `self`; `--trello-visible` marks it for the
Trello mirror; `--mirror` filters to trello-visible tasks still open. Marking
a task `completed` stamps `completed_at` automatically (CLI-set, never a free
value); moving away from `completed` clears it.

## Interactions

```sh
node src/hub.ts add-interaction --kind call --date 2026-10-23 --channel phone --summary "Caught up re: referral" --person ada-lovelace
node src/hub.ts list-interactions --days 14 --json        # last 14 calendar days
node src/hub.ts list-interactions --person ada-lovelace --kind meeting
```

`--kind` is free text (call/email/meeting/interview/message/...). `--channel`
is the medium (discord/phone/in-person/...). `--person` is optional —
people-less interactions (e.g. a solo decision) are valid. Filters:
`--person`, `--kind`, `--days <n>`, `--since <YYYY-MM-DD>`. Listed newest
first.

## Trackables (processes with a lifecycle)

```sh
node src/hub.ts add-trackable --label "Platform engineer @ Acme" --kind application --party Acme
node src/hub.ts add-trackable-event 3 --type "applied via portal"
node src/hub.ts add-trackable-event 3 --type "phone screen" --notes "went well"
node src/hub.ts list-trackable-events 3 --json
node src/hub.ts list-trackables --kind application --status active
node src/hub.ts set-trackable-status 3 --status closed
```

`--stage` is free text (default `started`) — a custom stage like
`team-fit-round-2` persists without schema change. Events are an append-only
trail (`--type` free text, `--date` defaults to today UTC-anchored, `--notes`
free text); the trail lists oldest first. Closing a trackable never touches
its events.

## Entities & links

Anything worth indexing that isn't a person/task/interaction.

```sh
node src/hub.ts add-entity --kind concept --label "Zero-dependency CLI" --content "Why: portability..."
node src/hub.ts link-entity zero-dependency-cli --target-type person --target ada-lovelace --note "discussed 2026-10-20"
node src/hub.ts list-entity-links zero-dependency-cli --json
node src/hub.ts unlink-entity 7
```

`--target-type`: person/task/trackable/interaction/file. `--target` is a slug
for person, a numeric id for the rest; invalid targets are usage errors
(resolved at write time). `list-entities --kind <k>` filters. Entities have no
status column — no lifecycle, no set-status verb. A null `target_label` in
link output means the target row no longer exists.

## Files (indexed artifacts)

```sh
node src/hub.ts add-file --path "~/hub/files/ada-lovelace/portrait.jpg" --kind image --person ada-lovelace
node src/hub.ts list-files --person ada-lovelace --kind pdf
```

The CLI stores the path as given and never touches disk. Keep durable
artifacts under `~/hub/files/<slug>/...` (convention; `$HUB_FILES` overrides
the root). Canonical kinds: pdf/apk/html/image/project — free text beyond
that. Filters (combinable): `--person`, `--task <id>`, `--kind`.

## Sync ledger

```sh
node src/hub.ts log-sync --entity task --entity-id 12 --action move --detail "To Doing"
node src/hub.ts list-sync-log --adapter trello-cli --direction out
```

Re-logging the same (adapter, direction, entity, entity_id, action) is
idempotent — no duplicate row, exit 0. Ledger lists oldest first. Filters
(combinable): `--adapter`, `--direction`, `--entity`.

## vCard import

```sh
node src/hub.ts import-vcf ~/contacts.vcf --dry-run   # preview first
node src/hub.ts import-vcf ~/contacts.vcf
```

Imports FN/N (display name + slug), TEL/EMAIL (channels), ORG (employer),
TITLE/ADR/BDAY/URL/NOTE (notes); BASE64 photos land in `~/hub/files/<slug>/`.
X-* properties are ignored. Re-runnable: existing slug/phone/email matches are
skipped and reported, never duplicated. Always `--dry-run` first.

## Environment

| Variable | Meaning |
| --- | --- |
| `HUB_DB` | Default database path |
| `HUB_FILES` | Durable files root (default `~/hub/files`) |
| `HUB_MIGRATIONS` | Migrations directory (default beside the source) |
