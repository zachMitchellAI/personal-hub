# Lane notes — stage/perf-completion (2026-10-24, Sam)

Scope: owner approved items 1+2 of the perf findings (DB innocent; 99% of the
850ms was module loading, ~620ms drizzle/sqlite-core alone).

Changes (5 files):
- src/core/registry-data.ts (NEW) — data-only registry: PARSE_ARGS_OPTIONS,
  VERB_NAMES, VERB_FLAGS, optionType. No command/db/schema imports.
- src/registry.ts — keeps VERBS (handlers) + re-exports the data-only module
  as the single source of truth. Adding a verb = cmd* export + VERBS line +
  VERB_NAMES line (doc comment says so).
- src/hub.ts — completion + handler registry now load on demand (dynamic
  import) after verb dispatch; a tab press never imports the drizzle graph.
- src/commands/completion.ts — drizzle-free: raw read-only node:sqlite for
  the dynamic tier; migrations deliberately NOT run on completion (read-only
  path; missing table offers nothing). Pragmas re-asserted per contract.
- src/core/constants.ts — VERSION 0.9.0 → 0.9.1.

Wrapper (already live on the host, NOT a repo change):
~/.local/bin/hub now sets NODE_COMPILE_CACHE=~/.cache/hub/node-compile-cache.

Measurements (cold/warm on aibox):
- completion: 0.83s → ~0.11-0.15s (7x)
- normal verbs: 0.85s → ~0.70s warm (wrapper compile cache)

Gates: typecheck ✓, fmt:check ✓, npm test 71/71 ✓ (node --test glob form).

ON MERGE (owner approval): update BUILD-STATE.md in the main checkout
(file-layout section + header status line) as part of the merge commit —
BUILD-STATE.md is untracked, so it can't ride the branch diff. Then
`git worktree remove ../hub-lane-perf`.
