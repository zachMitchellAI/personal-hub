---
name: hub
description: Read and record the user's personal data through the hub CLI (life.db) — people, channels, tasks, interactions, trackables, entities, files, and the sync ledger. Use whenever the user asks to store, update, or look up personal information, log a conversation, manage tasks, or track an ongoing process.
---

# hub — the personal data store

The hub is a deterministic CLI over a single SQLite database (`life.db`), built
in this repository (`~/.openclaw/workspace/personal-hub`). It is the canonical
record of the user's people, commitments, and history. When the user tells you
something worth keeping, the hub is where it goes — not your memory files.

## Invoking

Run it from the repo root (Node ≥ 24 executes the TypeScript directly — there
is no build step):

```sh
node src/hub.ts <verb> [args...] [--json]
```

- Add `--json` for machine-readable output. JSON keys are **snake_case**;
  human output is one record per line, tab-separated.
- Exit code 0 means success; 1 means usage error or failure (stderr explains).
- `node src/hub.ts --help` is the authoritative, always-current verb and flag
  reference. For the curated guide with examples, read `references/verbs.md`
  next to this file.

## Non-negotiable rules

1. **All writes go through CLI verbs.** Never `INSERT`/`UPDATE` the database
   with freeform SQL or a sqlite shell. Reading with SQL is allowed.
2. **Deterministic dates only.** Every date is an ISO calendar date
   (`YYYY-MM-DD`). Resolve "next friday" to a real date before passing it.
3. **Kinds are free text, not enums.** Before inventing a new kind
   (`--kind`, `--context`), check what vocabulary already exists via the
   relevant `list-*` verb and reuse it.
4. **Slugs are immutable.** People and entities are identified by slugs
   (lowercase-dashed, derived from name/label). Don't try to rename them.
5. **One database.** The default is `$HUB_DB` or `~/hub/life.db`. Never point
   `--db` elsewhere except for throwaway testing the user asked for.

## Working habits

These are the recurring moves — prefer doing them over asking the user:

- **After a meaningful conversation** (with a person, about a topic): log it
  with `add-interaction` (`--kind`, `--date`, `--channel`, `--summary`,
  `--person <slug>` when it involved someone). Interactions may be
  people-less.
- **When a commitment arises**: `add-task` with a `--context` tag
  (e.g. `job-hunt`, `family`). Update it with `set-task-status` as it
  progresses; `completed` stamps `completed_at` automatically.
- **When you learn contact info**: `add-channel <slug> --kind <k> --value <v>`.
  Use `--primary` only when the user says this is the one that matters.
- **For multi-step processes** (job applications, referrals): create a
  `trackable` and append to its event trail with `add-trackable-event` as
  things happen. Stages are free text — a new stage needs no schema change.
- **Look up before asking.** `list-people`, `get-person`, `list-tasks`,
  `list-interactions` are cheap. Check the hub first; only ask the user for
  what the hub doesn't know.
- **Don't log trivia.** The hub is durable record, not scratch space — write
  what the user would want to find again in a year.
