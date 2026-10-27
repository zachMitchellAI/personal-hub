# S12 — CRUD verbs: edit + delete + merge-person

**Status:** BUILT in lane `hub-lane-crud` (branch `stage/crud-verbs`), awaiting owner
branch-diff review. No merge, no push.
**Origin:** owner request 2026-10-27 (hub tasks #25, #26). Hub tasks set to
in-progress same day.

## Problem

The hub CLI is add-only today: two people rows for the same human cannot be
consolidated, typos in a person/channel/task row are permanent, and stale rows
(entities, tasks) can only be ignored, never removed. Pattern hit live 2026-10-27
with a real duplicated-contact case (details kept out of this repo per PII hygiene, owner directive 2026-10-30): the old row
interaction still pointing at it.

## Scope — six verbs, one new command module (`src/commands/crud.ts`)

### Edit verbs (partial updates)

Only flags actually provided change the row — the drizzle `set` object is built
only from provided flags, so unprovided fields are provably untouched (tested by
full-row before/after diff).

- `edit-person <slug> [--name --first-name --last-name --relationship-type --employer --notes]`
  — slug is immutable (identity, keys filesystem mapping): `--slug` is rejected.
- `edit-channel <id> [--kind --value]` — primary_flag and source untouched
  (primary is set-primary's job; source is import provenance).
- `edit-task <id> [--title --context --due-date --notes --person <slug>]`
  — `--due-date` passes the same parseIsoDate rule as add-task (deterministic
  YYYY-MM-DD only); `--person` re-points the person FK by slug resolution.
  completed_at/status are NOT editable here — set-task-status owns the stamp.

### Delete verbs (hard deletes, cascade proofs in tests)

- `delete-task <id>` — subtasks CASCADE (schema FK ON DELETE CASCADE).
- `delete-entity <slug>` — entity_links CASCADE (FK on entity_id).
- Deliberately NO `delete-person`: person deletion is destructive across
  channels (CASCADE) while tasks/interactions/files survive orphaned (SET NULL)
  — consolidation is merge-person's job. Documented open question for a future
  story if ever needed.

### merge-person <from-slug> <into-slug>

One `BEGIN`/`COMMIT` (guarded by `db.isTransaction`):
1. Re-point `contact_channels.person_id`, `interactions.person_id`,
   `files.person_id`, `tasks.person_id` from from-person.id → into-person.id
   (UPDATE ... WHERE person_id = fromId). Rows MOVE — primary flags and all
   other columns are preserved by construction (no delete+recreate).
2. Re-point `entity_links` rows with `target_type='person' AND target_id=fromId`
   (polymorphic target needs the explicit pass).
3. DELETE the from-person row. Any interactions that referenced it keep their
   (now re-pointed) person_id; a person-less interaction remains valid.

Refusals (usage error, exit 1, nothing written): `from == into` (same slug),
unknown from-slug, unknown into-slug.

Output: moved-counts summary — human `merged <from> into <into>: channels N,
interactions N, files N, tasks N, links N`; `--json` `MergePersonStatus` with
`from_slug`, `into_slug`, `moved: {channels, interactions, files, tasks, links}`.

Atomicity test: force the final person DELETE to fail and assert zero rows moved
and the from-person still exists — the transaction is the guarantee.

## Registration surface (all four places, per AGENTS.md)

- `VERBS` map + `VERB_NAMES` (registry.ts / registry-data.ts)
- `VERB_FLAGS`: edit-person [name, first-name, last-name, relationship-type,
  employer, notes], edit-channel [kind, value], edit-task [title, context,
  due-date, person, notes], delete-task [], delete-entity [], merge-person []
- `PARSE_ARGS_OPTIONS`: no new entries — every flag name already exists.
- `REQUIRED_FLAGS`: none (positional-only requirements).
- USAGE help text extended.
- `--json` shapes in types.ts: EditPersonStatus (full PersonJson echo via the
  existing personJson mapper), EditChannelStatus (full channel row),
  EditTaskStatus (full task row incl. subtasks), DeleteStatus
  `{verb, deleted: <id|slug>, kind}`, MergePersonStatus.

## Gherkin → test map (tests/crud.test.ts, CLI-level, throwaway DBs)

1. edit-person happy path: change employer only; every other field identical.
2. edit-person unknown slug → exit 1, message.
3. edit-person --slug rejected (identity is immutable).
4. edit-channel happy path + primary_flag untouched (set primary first).
5. edit-channel unknown id → exit 1.
6. edit-task happy path: due-date + person re-point (verify person_id changed).
7. edit-task bad --due-date ("next friday") → exit 1 (parseIsoDate rule).
8. edit-task unknown id → exit 1.
9. delete-task cascades subtasks (2 subtasks before, 0 rows after).
10. delete-task unknown id → exit 1.
11. delete-entity cascades entity_links (links before/after).
12. delete-entity unknown slug → exit 1.
13. merge-person happy: counts exact in human + --json; channels/interactions/
    files/tasks/links all re-pointed; from-person gone.
14. merge preserves primary flags (from has primary email → still primary after move).
15. merge refuses from==into (exit 1, nothing moved).
16. merge refuses unknown slugs (exit 1).
17. merge atomicity: the final DELETE is forced to fail; assert all counts
    unchanged and from-person still present (transaction rollback proof).
18. merge the husk case: empty from-person + one dangling interaction →
    interaction re-pointed, husk deleted, moved counts {0,1,0,0,0}.

## Out of scope (open questions for owner)

- delete-person (destructive; see above).
- edit-interaction / delete-interaction (interactions are history; a future
  story must also handle the S13 vector-row lifecycle when it lands).
- VERSION bump + merge to main (owner-gated).
- Subtask editing (mark-subtask covers done flag; label edits low-value).
- Trello mirror awareness (mirror reads tasks table on next sync; deletes just
  disappear from the next mirror run — accepted).

## Acceptance

`npm run typecheck && npm run fmt && npm run fmt:check && npm test` green in the
lane (baseline 71/71 + new scenarios), checkpoint commit on stage/crud-verbs,
owner reviews `git diff main..stage/crud-verbs`.