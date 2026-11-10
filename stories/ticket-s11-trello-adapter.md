# S11 — Trello adapter: config surface + `sync-trello` + sync-log integration

**Proposed:** 2026-10-23. Slot after S9. Status: BUILT on `stage/s11-trello-adapter`
(lane `../hub-lane-s11`) — awaiting owner review. Owner decisions pending are flagged
⚠️ below; defaults were chosen so the build is reviewable now.

## Context

S4/S7/S8 shipped the groundwork: `tasks.trello_visible` + the `--mirror` filter
(`trello_visible=1 AND status IN ready/in-progress`) + `tasks_mirror_idx` + the
`active_tasks` view, and the `sync_log` ledger with its idempotency contract
(`log-sync`/`list-sync-log`, adapter default `trello-cli`). the sync-engine decision already ruled
the sync engine: **mheap/trello-cli** (v2.0.0, owner-tested, JSON output, works with the
existing `TRELLO_API_KEY`/`TRELLO_TOKEN` env creds). DECISIONS #13 ruled the direction:
**one-way hub → Trello** — Trello stays an interface, the hub DB is the source of truth.
This ticket builds the actual adapter: config surface, the sync flow, ledger integration.

## Engine probe findings (verified live against trello-cli 2.0.0, not from docs)

- **Auth:** `@trello-cli/config` checks `process.env.TRELLO_API_KEY`/`TRELLO_TOKEN`
  *before* its config file → headless runs work with the creds already present in
  OpenClaw's MCP env block. No interactive `trello auth` needed. The hub CLI only ever
  inherits env; it never reads, stores, or echoes credential values.
- **Cache:** `card:create` and `card:list` resolve board/list via a local cache sqlite
  (`~/.trello-cli/<profile>/trello.db`), populated by `trello sync` (full-account sweep,
  fine at personal scale). Resolution is `WHERE name=? OR id=?` — **IDs still require a
  warmed cache**, so sync runs `trello sync` first (skippable via `--skip-cache-sync`).
- **Cache-free writes:** `card:update`, `card:move` (`--id X --to LIST_ID`),
  `card:archive` take raw `--id` — no cache dependency.
- **Output:** every command accepts `--format json`; write commands default to silent,
  so the adapter passes `--format json` everywhere and parses stdout.
- `card:list --format json` shape: `{id, name, description, due, closed, url, labels}`.
- **Not installed on this box yet** — `npm install -g trello-cli` is a deploy step, done
  by the owner (global install isn't the hub's business). `sync-trello` errors with that
  hint when the engine is missing (spawn ENOENT).

## Design

### Config surface — `~/.hub/config.json` (`HUB_CONFIG` env override)

```json
{
  "trello": {
    "enginePath": "trello",
    "board": "6a85c60788581a876be529c9",
    "lists": {
      "ready": "6a85c6123a5e0670074005a6",
      "in-progress": "6a85c6156eac5b2ebe373c5a",
      "done": "6a85c61aacd0e28283c06114"
    }
  }
}
```

- New module `src/core/config.ts`: `loadHubConfig` / `saveHubConfig` (JSON, pretty,
  merge-preserving other top-level keys). No new dependency; plain `node:fs`.
- **Credentials are NOT in this file** — the engine reads `TRELLO_API_KEY`/`TRELLO_TOKEN`
  from env at spawn time. SecretRef migration of those two values (OpenClaw side, so
  nothing plaintext remains in `openclaw.json`) is a gateway task, not a hub-CLI task;
  the hub contract is "credentials come from the environment" either way.
- New verb **`hub trello-config`** writes/merges this block:
  `--board <id> --list-ready <id> --list-in-progress <id> --list-done <id>
  [--engine-path <cmd>]`. Offline by design (no engine call, no network); completeness
  is validated by `sync-trello` at run time. `--json` echoes the trello block.
- Board/list values may be Trello IDs (recommended — stable under renames) or names
  (the engine cache resolves both; names break on rename).

### Card identity — ⚠️ default chosen without owner input

Mirrored cards are tagged in the title: **`[hub-<task-id>] <title>`**. The prefix is
greppable, human-readable, survives title edits, and needs no Trello API features
(no custom fields). The adapter parses `task_id` back out of live card titles.
**Owner can veto** → switch to a DB-only mapping (cleaner titles, weaker matching).

### Mapping table — migration 008, `user_version` 7 → 8

```
task_trello: task_id INTEGER PK REFERENCES tasks(id) ON DELETE CASCADE
           , card_id TEXT NOT NULL + UNIQUE index task_trello_card_unique
           , created_at TEXT NOT NULL, synced_at TEXT NOT NULL
```

- One-way means one task ↔ at most one card; `task_id` PK encodes that.
- `UNIQUE(card_id)` guards double-mapping (stale config swaps, manual retags): a second
  task claiming the same card is a **reported conflict**, not a silent overwrite.
- Task deletion (currently impossible via CLI; FK CASCADE from person deletion) →
  the mapping row cascades; the orphan card is archived by the sync flow (below).
- No denormalized state columns — card state is derivable from the task row + config;
  `synced_at` is bookkeeping for humans, not logic.

### Sync flow — `hub sync-trello [--apply] [--skip-cache-sync] [--json]`

Default is **dry-run** (prints the plan, touches nothing — same convention the S10
ticket proposes). `--apply` executes.

1. Load config; missing/incomplete → exit 1 with a `hub trello-config` hint.
2. Read the mirror set (same AND-composed query as `list-tasks --mirror`).
3. `trello sync` (unless skipped) to warm the engine cache.
4. `trello card:list --board B --list L` for each configured list; build the owned-card
   map: title matching `/^\[hub-(\d+)\]\s*/` → `card_id → {task_id, list, name, due}`.
5. Plan:
   - task in mirror, no card → **create** (`card:create`, title `[hub-id] title`,
     description = task notes, due = task due_date, list by status)
   - task in mirror, card exists → **reconcile**: status/list mismatch → **move**;
     title, description, or due drift → **update** (due compared as calendar date)
   - mapping row's card not seen live → **re-create** mapping (card was archived out-of-
     band; upsert mapping, detail notes it)
   - card in target lists with hub prefix but no mapping row → **adopt** (rebuild the
     mapping from the title tag — recovers a lost DB) — ⚠️ judgement call, vetoable
   - card exists, task left the mirror set (completed, de-flagged, or deleted) →
     **archive**; completed tasks first **move** to the Done list (honors the decision log's
     status↔list 1:1) then archive in the same run — one ledger row, detail carries
     `{list: done}`
   - card in target lists *without* a hub prefix → **never touched** (owner's existing
     cards keep their manual lifecycle) — ⚠️ default chosen without owner input
6. Dry-run prints the plan; `--apply` executes each action via the engine, upserts the
   mapping row, and writes one `sync_log` row per action via the existing `log-sync`
   idempotent path (direction `out`, adapter `trello-cli`, entity `task`,
   entity_id = task id, action `create|update|move|archive|adopt|conflict`,
   detail = compact JSON `{card_id, ...}`).
7. Re-run with no drift → zero actions, zero ledger rows, exit 0 ("in sync").

### Engine adapter — `src/commands/trello/engine.ts`

`TrelloEngine` interface (syncCache, listCards, createCard, updateCard, moveCard,
archiveCard) with one spawn-based implementation over trello-cli. `enginePath` from
config (default `trello`) is spawned with inherited env; ENOENT → the friendly
"install trello-cli" error. Tests use a **stub engine**: a small node script the test
writes into its tmpdir, emulating card state in a JSON file — the same CLI-level
subprocess boundary the real adapter uses, no network, no credentials.

### Status mapping

`ready` → `lists.ready`, `in-progress` → `lists["in-progress"]`, `completed` →
`lists.done` (move-then-archive on completion). The mirror filter already excludes
completed from the *active* set; Done placement preserves the 1:1 mapping story.

## Judgement calls settled in this build (owner veto window at review)

1. **Board/list defaults in this ticket's examples** reference the owner's "Long-running
   tasks" board (lists map 1:1: Ready/In progress/Done). `trello-config` ships empty —
   pointing it at the real board is one command, run by the owner.
2. **Title prefix `[hub-<id>]`** vs DB-only mapping (see above).
3. **Non-hub cards are never touched** (not even warned about, for now).
4. **Checklists (subtasks → card checklists) are phased out of this ticket** — card +
   list + due + desc first; checklist mapping is a follow-up once the card flow is
   proven on the live board.
5. **Adopt semantics** rebuild a missing mapping row from a live card's title tag.
6. **Completed tasks: move to Done, then archive** (vs archive-in-place).

## Acceptance

```gherkin
Given a config pointing at the stub engine and three mirrored tasks with no cards
When I run `hub sync-trello` (dry-run)
Then the plan lists three create actions, the stub board is untouched, and no sync_log rows exist

When I run `hub sync-trello --apply`
Then three cards exist titled "[hub-N] …" in the status-mapped lists, the mapping table
has three rows, and sync_log has three "out/trello-cli/task/create" rows

When I run `hub sync-trello --apply` again with no drift
Then zero actions are taken, zero sync_log rows are added, and the output says in-sync

Given a mirrored task whose status transitions ready → in-progress
When I run `hub sync-trello --apply`
Then the card moves to the in-progress list and sync_log gains a "move" row

Given a mirrored task that completes
When I run `hub sync-trello --apply`
Then the card moves to the done list and is archived, and sync_log gains an "archive" row

Given a mirrored task whose title, notes, or due date change in the hub
When I run `hub sync-trello --apply`
Then the card is updated to match and sync_log gains an "update" row

Given a mapping row whose card no longer exists on the board
When I run `hub sync-trello --apply`
Then a fresh card is created and the mapping row points at the new card id

Given a card with a hub prefix but no mapping row (lost DB)
When I run `hub sync-trello --apply`
Then the mapping is adopted from the title tag, not duplicated as a new card

Given two tasks whose plan would claim the same card id
When I run `hub sync-trello`
Then the conflict is reported in the plan and nothing is applied for that card
```

## Out of scope (follow-ups)

- Subtasks → Trello checklists (phase 2, owner approves after live card flow).
- Trello → hub import (the one-time importer from the roadmap; direction `in`).
- Automations wiring (scheduled `sync-trello --apply`) — after owner validates output.
- SecretRef migration of `TRELLO_API_KEY`/`TRELLO_TOKEN` in OpenClaw config (gateway-side).
