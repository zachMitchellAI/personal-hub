# AGENTS.md — personal-hub

Standards for any agent (or human) working in this repo. Read `DESIGN.md` for
architecture and `BUILD-STATE.md` for what exists and why — this file is about
*how to change it*, not what it is.

## Hard constraints (non-negotiable)

1. **Zero npm runtime dependencies.** `drizzle-orm` is the sole exception
   (pure JS, no native code). Do not add packages to fix problems — solve them
   with `node:` built-ins or plain TypeScript. `drizzle-kit` is dev-only.
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