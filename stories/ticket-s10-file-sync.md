# S10 — `sync-files`: disk↔ledger reconciliation (+ optional systemd auto-trigger)

**Proposed:** 2026-10-22 (owner idea, mid-S7-review). Slot after S9. Status: PROPOSED — needs owner sign-off on the judgement calls below before build.

## Context

S7 shipped the two primitives this needs: the `files` table (the index) and `sync_log` with an
**idempotency contract** (re-run adds no rows). A sync command is therefore reconciliation
bookkeeping, not new infrastructure. The owner's framing: one sync verb, two triggers — manual
(CLI) and automatic (OS). Never two sync systems.

## Task

`hub sync-files` — compare on-disk files under `~/hub/files/` (the S7 hierarchy convention,
overridable via `--root`) against the `files` table, and reconcile:

- **New on disk, unindexed** → insert a `files` row: `kind` inferred from extension
  (pdf/apk/html/image/project; unknown → flagged in output, row still created with kind `other`
  or skipped — judgement call below), `person_id`/`task_id` derived from the directory slug
  *only when unambiguous*.
- **Indexed but missing on disk** → reported stale in output. **Never deleted.** Removal is a
  human decision (a future `remove-file` verb or manual SQL; not sync's job).
- **Unchanged** → no action, no `sync_log` rows (idempotency contract, same as S7's).

Every action taken is logged to `sync_log` (direction `in`, adapter `hub-sync`, entity `file`,
action, ts, detail) per the existing S7 ledger contract.

## Flags

- `--dry-run` — **default behavior**: print the plan (would-index / would-flag), touch nothing.
- `--apply` — execute the plan.
- `--root <dir>` — override the scan root (throwaway DBs and tests use this).
- `--person <slug>` — override/force the person link for this run.

## Acceptance

```gherkin
Given the seeded disk under --root with two unindexed files and one indexed file
When I run `hub sync-files --apply`
Then both new files are indexed with inferred kinds, sync_log gains 2 rows,
and a re-run with no disk change adds zero rows (exit 0, zero actions)

Given an indexed file whose path no longer exists on disk
When I run `hub sync-files --apply`
Then the row is reported stale in output and remains in the files table

Given an unambiguous directory slug matching a person
When I run `hub sync-files --dry-run`
Then the plan shows the derived person link; with --apply the row links to that person
```

## Judgement calls to settle with the owner before build

1. **Unknown extensions:** skip + report, or index as kind `other`? (Lean: skip — the kind set
   is a deliberate S7 decision; silently inventing a new kind weakens it.)
2. **Ambiguous/missing directory slug:** index with NULL links + report, or skip? (Lean: index
   with NULL links — the file exists on disk regardless of linking; linking is correctable later
   via existing verbs or a future `link-file`.)
3. **Delete-on-disk:** report-only confirmed above — owner veto window here.

## Packaging: the auto trigger (separate deliverable, same verb)

`packaging/systemd/` ships two user-unit templates + install doc:

- `hub-files-watch.path` — `PathModified=%h/hub/files`, triggers →
- `hub-files-sync.service` — oneshot `Type=oneshot` running `hub sync-files --apply --json`.

Notes:

- systemd.path is **native OS file watching**: no daemon, no dependencies, survives crashes,
  debouncing handled by systemd. Preferred over an in-process `fs.watch`/chokidar daemon.
  chokidar is rejected outright (zero-dep constraint). An in-process `hub watch` verb is the
  fallback only if the owner wants non-systemd portability — flag it, don't build it speculatively.
- Auto-mode is deployment sugar for this machine. The **verb is the product** — it must behave
  identically when run by a human, by an agent, or by systemd.
- `--apply` in the service unit is safe **only because** of the dry-run-default design: the auto
  trigger never invents links silently; anything ambiguous lands in the plan output and gets
  NULL links + a report the next time anyone looks.

## Out of scope

- File *content* upload/mirroring (Trello attachments, cloud sync) — the files table indexes
  paths; moving bytes is a different adapter with a different failure model.
- Directory rename/move detection (treated as delete + add on first pass; ledger detail makes
  it auditable).
- Watching paths outside the scan root.
