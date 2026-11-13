# AGENTS.md — personal-hub

Standards for any agent (or human) working in this repo. Read the repo docs for
architecture and `BUILD-STATE.md` for what exists and why — this file is about
*how to change it*, not what it is.

## Naming (added 2026-11-11, owner review rule)

- **No single-letter variable or parameter names.** Every identifier states
  what it holds: `card`, `row`, `match` — never `c`, `r`, `m`. Applies to src
  and tests alike. Single letters make diffs (and agents) re-derive meaning
  that the name could have carried for free.
- **Exports live at the bottom.** Helpers above, public surface below — so a
  reader (or agent) scanning a file sees the helpers first and the module's
  entry points last, and can tell them apart at a glance. Exports in the
  middle of a file blur helpers with main content (owner rule, 2026-11-11).

## Code structure (added 2026-11-11, owner review rule)

- **Size functions to their meaning, not a line count.** A long multi-step
  function gets decomposed into flat, meaning-named step functions
  (`planSync` calling `planTaskCards`/`planAdoptions`/`planArchives`), with a
  readable entry point on top. But don't over-split — each function should be
  big enough to mean something alone (owner: "not overly tiny — this function
  scoping is just right", post-decompose of cmdSyncTrello). Nesting
  step-functions inside each other is explicitly avoided.

## Hard constraints (non-negotiable)

1. **Dependencies on purpose, not by default.** Before adding any npm
   dependency:
   - *Prefer* solving small problems (roughly <50 lines total) with `node:`
     built-ins — a dependency for that is negative value.
   - Pure-JS dependencies that earn their place (real maintenance, real fit):
     evaluate and add; note the why in the repo docs.
   - Native/platform-binary dependencies: run the evaluation and surface it
     to the owner before adding — supply-chain and platform compat are
     owner-visible tradeoffs.
   - Never add to fix a symptom; fix the actual problem, or don't add.
   Approved exceptions so far: `drizzle-orm` (typed SQL over node:sqlite,
   pure JS) and `sqlite-vec` (vec0 extension loader + platform binaries,
   native — owner-approved 2026-10-31, replacing the OpenClaw-install .so
   path hack that was not portable). `drizzle-kit`, dev tooling, and test
   helpers are dev-only and never imported by `src/`.
2. **No build step.** Node ≥24 executes `.ts` directly by stripping types.
   Consequences:
   - **Erasable syntax only**: no TypeScript `enum`, `namespace`, or parameter
     properties. Use plain object maps and type unions. (This bit us: a
     `Record<string, VerbHandler>` registry, not an enum, in `src/hub.ts`.)
   - **Local imports need explicit `.ts` extensions**: `import { x } from './y.ts'`.
   - **Type-only exports must be imported as types**: `import { makeDrizzle, type HubDb }`
     — importing `HubDb` as a value crashes at runtime.
3. **Check current docs before version-sensitive work** (context7 MCP, ≤3
   query-docs calls per question). Node/SQLite/drizzle behavior drifts.

## Documentation standard

- **Every exported function gets JSDoc.** A reader should understand the
  contract — parameters, return value, failure behavior — without reading the
  function body. Use `/** ... */` syntax, not bare `//` blocks.
- **JSDoc is for contracts; body comments are for the story.** JSDoc explains
  *what* a function does and *why it exists*; light inline comments explain
  non-obvious steps inside the body (e.g. why a transaction wraps two writes).
  Every non-trivial function body gets at least a comment where intent isn't
  obvious from the code alone.
- Interfaces and types in `core/types.ts` are part of this: each exported
  interface gets a doc comment, and non-obvious fields get field-level notes.

## Tooling

- Dev dependencies are tooling-only — they must never be imported by `src/`
  runtime code (that's the zero-runtime-dep rule; `drizzle-orm` stays the sole
  runtime import). Current tooling: `typescript` (typecheck), `prettier`
  (format), `@types/node`, `drizzle-kit` (migrations generation).
- `npm run typecheck` — strict `tsc --noEmit` (see `tsconfig.json`;
  `erasableSyntaxOnly` + `allowImportingTsExtensions` + `verbatimModuleSyntax`
  match the type-stripping runtime exactly).
- `npm run fmt` / `npm run fmt:check` — prettier over `src/` and `tests/`.
- Run `npm run typecheck && npm run fmt:check && npm test` before declaring a
  change done.

## Layout — where new code goes

```
src/
  hub.ts            entry point ONLY: parseArgs, VERBS registry, dispatch, top-level errors
  core/             shared plumbing: constants, types, paths, util, db
  commands/         one module per verb domain (init.ts, people.ts, channels.ts)
  schema.ts         drizzle table defs (drizzle-kit points here; don't move)
  migrations.ts     the runner; migrations/ holds the SQL — treat as a matched pair
```

- New verb → new (or existing) `commands/*` module, export a `cmd*` function,
  register it in the `VERBS` map in `hub.ts`. Don't grow `hub.ts` past dispatch.
- New shared helper → `core/util.ts`. New status/JSON shape → `core/types.ts`.
  New env-driven path → `core/paths.ts`. Constants (incl. long help text as a
  template-literal constant) → `core/constants.ts`.
- Separation of concerns is a stated owner preference: interfaces, functions,
  and constants live in dedicated homes. Don't let one file balloon — split
  along these seams early, not after review.
- If you change the layout, update `BUILD-STATE.md`'s file-layout section in
  the same change.

## Database contract (S1 guarantees)

- **All writes go through the CLI verbs.** Freeform SQL elsewhere is read-only.
- **Every connection re-asserts pragmas** — `foreign_keys = ON` is
  per-connection, only `journal_mode = WAL` persists. Always open via
  `openDb`/`openHubDb` in `core/db.ts`, never `new DatabaseSync` directly.
- **Migrations**: `NNN_name.sql`, one transaction per file, `user_version`
  bumped *inside* the tx, runner skips applied versions. Never hand-edit a
  shipped migration; add a new one.
- **Business rules live in the write path, not the DB** (owner decision):
  e.g. at-most-one-primary-per-(person, kind) is demote-then-set inside an
  explicit `BEGIN`/`COMMIT` in `commands/channels.ts`. Keep it that way.
- Guard `COMMIT`/`ROLLBACK` with `db.isTransaction`.
- Error matching must walk the drizzle cause chain (`errorChainText`) —
  driver errors arrive wrapped as `DrizzleQueryError`.

## CLI output contract

- `--json` emits machine-readable objects whose keys are **snake_case**; the
  drizzle rows are camelCase — map explicitly via the `*Json` functions.
  Shapes live in `core/types.ts` as interfaces; changing a shape is a
  breaking contract change.
- Human output is one line per thing, tab-separated for list verbs.
- Long multiline strings (help text) are template-literal constants, never
  arrays of joined strings.

## Testing

- Runner: `node --test "tests/**/*.test.ts"` — the glob form is required;
  a bare directory arg fails with "Cannot find module" on Node 24.
- Tests are **CLI-level**: `spawnSync(process.execPath, [HUB, ...args])`,
  assert real exit codes, parse `--json` stdout.
- Tests run against throwaway DBs (`mkdtempSync`), **never** `~/hub/life.db`
  or anything under `HUB_DB`.
- Green `npm test` with zero packages installed is the portability check —
  it doubles as proof the zero-dep constraint holds. Run `npm run typecheck`,
  `npm run fmt:check`, and `npm test` before declaring any change done.

## Ticket completion

- When finishing a ticket, avoid performing a commit right away. Commits are preferred to have human review, in case things need further adjustments. After the human reviews and gives the greenlight: commit!

## PII commit gate (task #45, 2026-11-13)

The repo carries a PII leak gate: `scripts/pii-gate.sh`. It is standing
defense-in-depth against real personal data appearing in fixtures, docs, or
other committed content.

- **Pattern layer** (always runs): SSN/phone/email regexes, allowlist in
  `scripts/pii-gate-allowlist.txt` — fictional fixture vocabulary only.
- **Denylist layer** (only where `~/hub/life.db` resolves): live-built at scan
  time from the hub DB; held in a 0600 temp file, never committed. Distinctive
  entries only (multi-word or length >= 4) so generic words like "hub" don't
  self-trigger.
- **Fail-closed**: commits under `tests/` with the hub DB unreachable are
  REFUSED, because fixtures are the highest-risk file type.
- Output shows rule id + file:line; **matched text is never echoed** (terminal
  scrollback is a data surface).
- Wire it as a hook with `git config core.hooksPath scripts/githooks` — the
  `scripts/githooks/pre-commit` wrapper invokes the gate (see scripts/githooks/).
- CI note: gate + tests need git, bash, sqlite3 CLI — present on local dev
  machines and GitHub ubuntu runners.

## Repo tiers (see GOVERNANCE.md)

- The repo follows a tiered trust model (full policy in GOVERNANCE.md):
  canonical repo as the sole work seed, private agent repo as the sandbox
  (force-pushes fine), public repo human-gated (agents author PRs, owner
  merges).
- Promotion to public requires the audit gate in GOVERNANCE.md (two
  independent fresh-clone full-history greps, 0 hits, owner rubber-stamp).
