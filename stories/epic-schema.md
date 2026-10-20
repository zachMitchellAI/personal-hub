# Epic: Schema v0 — Story Tickets

**Status:** ready for build (all decisions confirmed) · **Process:** each ticket implemented, then its Gherkin scenarios run as acceptance before the next ticket starts. Schema DDL lives in one migration file per ticket version bump. **Freshness rule (owner, 2026-10-20):** every ticket checks context7 (`resolve-library-id` → `query-docs`, ≤3 calls/question) for current API/version docs before implementation — static model knowledge is not trusted for versions.
**Locked decisions feeding this epic:** #4 (schema direction: slug, trello_visible, notes, nullable fields, NULL-year birthdays), #7 (importers re-runnable), #13 (one-way sync), #14 (manual import via CLI verbs).

---

## S1 — Database bootstrap & migration machinery

**Task:** `hub init` creates `life.db` (WAL mode, `foreign_keys=ON`), schema applied via numbered migrations tracked in `PRAGMA user_version`. No tables yet — just the machinery.
**Acceptance:**
```gherkin
Given no life.db exists in the working directory
When I run `hub init`
Then life.db exists with journal_mode=wal, foreign_keys=on, user_version=0

Given life.db exists at user_version=0
When I run `hub init` again
Then it exits 0, changes nothing, and prints the current version

Given a migration file with a SQL error
When migrations run
Then the transaction rolls back fully, user_version is unchanged, and exit code is non-zero
```

## S2 — `people` table with slug identity

**Task:** people table per D3 + locked decisions: `id`, `slug` (UNIQUE, NOT NULL, human-readable, lowercase-dashed), `display_name`, `first_name`, `last_name`, `relationship_type` (nullable; no enum constraint), `employer`, `notes`, `created_at`.
**Acceptance:**
```gherkin
Given an empty people table
When I insert a person with slug "casey-smith"
Then the row persists and its id is stable

Given a person with slug "casey-smith" exists
When I insert another person with the same slug
Then the insert fails with a UNIQUE constraint error

Given a person with no relationship_type
When I query that row
Then relationship_type is NULL (not an error, not a default string)

Given a person display_name "Casey Smith"
When I derive a slug from the name
Then the slug is "casey-smith" (lowercase, spaces→dashes, no stray punctuation)
```
**Note:** slug derivation lives in the CLI (deterministic), not in the DB.

## S3 — `contact_channels` (open-ended kinds)

**Task:** `person_id` FK → people (ON DELETE CASCADE), `kind` (free text — email/phone/discord/mastodon/signal/matrix/linkedin/custom; **no enum**), `value`, `primary_flag`, `source`.
**Acceptance:**
```gherkin
Given person "casey-smith"
When I add channels kind="discord" and kind="email"
Then both rows persist with their literal kind values

Given a channel row with kind "mastodon"
When I add another channel with kind "mastodon-different-thing"
Then both persist — kind accepts any new string without schema change

Given a person is deleted
When I query contact_channels
Then no orphaned channel rows remain (CASCADE verified)

Given two email channels exist for one person
When I set primary_flag=1 on the second
Then at most one primary per (person, kind) is enforced by the CLI write path
```

## S4 — `tasks` + `subtasks` (the relational core of the mirror)

**Task:** tasks: `id`, `title`, `person_id` (nullable FK), `context` (free text tag — "job-hunt", "discord", "family"…), `status` (CHECK: ready/in-progress/completed), `due_date` (nullable), `completed_at` (nullable), `origin` (trello/self/agent), `notes` (from decision #4), `trello_visible` (from decision #4, default 0), `created_at`. subtasks: `task_id` FK CASCADE, `label`, `done` (0/1), `position` for ordering.
**Acceptance:**
```gherkin
Given a task with status "ready"
When I update status to "completed"
Then completed_at is set by the CLI, not passed in as a free value

Given a task with status "ready" and trello_visible=0
When the mirror query runs (SELECT … WHERE trello_visible=1 AND status IN ('ready','in-progress'))
Then the task is excluded

Given a task with trello_visible=1 and status "in-progress"
When the mirror query runs
Then the task is included

Given a task with subtasks in positions 1,2,3
When I mark subtask 2 done
Then subtasks 1 and 3 are unaffected and order is preserved

Given a due_date string "2026-11-05"
When inserted
Then it validates as ISO date; "next friday" is rejected at the CLI layer (deterministic dates only)
```

## S5 — `interactions`

**Task:** `id`, `person_id` (nullable FK — some interactions are people-less), `kind` (free text: call/email/meeting/interview/message…), `date`, `channel`, `summary`, `created_at`.
**Acceptance:**
```gherkin
Given an interaction with kind "interview" dated 2026-10-20
When I log it against person "casey-smith" via the CLI
Then the row persists and appears in that person's history query

Given an interaction with no person_id
When inserted
Then it persists (people-less interactions are valid)

Given a query for all interactions in the last 7 days
When run
Then results are ordered by date descending
```

## S6 — `applications` + `application_events` (job pipeline as *data*, not a special case)

**Task:** applications: `id`, `company`, `role`, `stage` (free text, NOT an enum — stages vary by company), `status` (active/closed), `created_at`. application_events: `application_id` FK CASCADE, `event_date`, `event_type` (free text), `notes`.
**Acceptance:**
```gherkin
Given an application "Acme Corp" stage "panel-interview"
When I add an application_event "thank-you note sent"
Then the event trail is queryable in order for that application

Given a company with a custom stage "team-fit-round-2"
When inserted
Then it persists — stages are data, not schema

Given an application is closed
When I query it
Then status reflects closure but events remain intact (no cascade delete of history)
```
**Note:** job hunting is a *concept* in this system (decision from owner) — this table is the concept's concrete representation, nothing more privileged than contacts or tasks.

## S7 — `entities` + `entity_links` + `files` + `sync_log`

**Freshness check (context7, owner rule):** before writing DDL, verify current SQLite column-constraint syntax against the version shipped with node:sqlite via context7 (`/websites/nodejs_latest-v24_x_api`).

**Task:** entities: `id`, `slug` (UNIQUE, NOT NULL — same derivation rules as people; slug generalization CONFIRMED by owner 2026-10-20, so entities ship with slugs from day one), `kind`, `label`, `content`, `created_at`. entity_links: `entity_id`, `target_type` (person/task/application/interaction/file), `target_id`, `note`. files: `path`, `kind` (pdf/apk/html/image/project), `person_id` (nullable), `task_id` (nullable), `added_at`, `note`. sync_log: `id`, `direction`, `adapter` (trello-cli), `entity`, `entity_id`, `action`, `ts`, `detail`. File hierarchy convention: durable artifacts organized on disk under entity/person slugs (e.g. `~/hub/files/<slug>/...`), indexed in the files table.
**Acceptance:**
```gherkin
Given an entity "vibe-coded dreams" kind "concept"
When I link it to a task and to a person
Then both links resolve via target_type+target_id

Given a file "~/hub/files/interview-prep/acme-corp.pdf"
When I index it against person "casey-smith"
Then the files row resolves to that person

Given a sync run that moved 3 tasks to Trello
When I query sync_log
Then 3 rows show direction "out", adapter "trello-cli", with timestamps — and a re-run adds no rows (idempotency contract)
```

## S8 — Indexes, views, and the mirror query

**Task:** indexes on FKs and hot queries (tasks by status+trello_visible, interactions by date, channels by person, slug lookups). Views: `active_tasks` (the mirror set), `person_full` (person + channels + recent interactions).
**Acceptance:**
```gherkin
Given the seeded test dataset
When I query view active_tasks
Then it returns exactly tasks WHERE trello_visible=1 AND status IN ('ready','in-progress') ORDER BY due_date NULLS LAST

Given EXPLAIN QUERY PLAN on a person-lookup by slug
Then it uses the unique index (no full scan)
```

---

**Definition of done (whole epic):** `hub init` from nothing produces the full schema at user_version=N; every ticket's scenarios pass via `node --test`; a fresh-machine smoke test (the portability contract) runs green; schema-only SQL snapshot committed locally (git, no remote — per #12).
**Explicitly out of scope:** any write-path UI beyond the CLI, Trello sync execution (needs the mirror board created — external write, will ask), importer code (per #14).