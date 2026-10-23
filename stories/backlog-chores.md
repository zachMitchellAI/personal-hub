# Backlog — parked chores

## DRY vs WET: consolidate the CRUD boilerplate? (parked 2026-10-22)

Owner observation after S6 review: every verb repeats the same shapes — `openDb` →
`makeDrizzle(db)` → work → `db.close()` in `finally`; insert-then-recheck ("insert vanished —
returned id not found"); row→snake_case `*Json` mappers; validate-CLI-first/DB-CHECK-backstop.
Question: is this "wet" boilerplate worth factoring for readability, or does the duplication
earn its keep?

**Position to debate when picked up (from Sam, 2026-10-22):**
- DRY applies to duplicated *knowledge*, not duplicated *shape*. The verbs share plumbing, not
  rules — each has its own required flags, defaults, error mapping (`trackables_status_check` vs
  `FOREIGN KEY constraint failed` vs none), and JSON contract. A generic CRUD engine would need a
  config object the size of the verb, and the per-verb error handling would get smeared into
  options.
- Middle path candidate: small composable helpers that kill genuine plumbing only — e.g.
  `withDb(values, fn)` (open/close/finally lifecycle), maybe a `recheckInserted(hub, table, id)`
  for the vanish-check, a shared `jsonOut(out, values.json)` printer. Keep verbs explicit; retire
  the 4-line lifecycle dance.
- Counterweight in favor of staying wet: zero-dep/Node-24 ethos favors obvious code; deviations
  between verbs are real and visible; and the explicit pattern is what taught the owner drizzle —
  readability for the human has been a stated product goal.
- Rule of three check: we now have 4 domains (people/channels, tasks/subtasks, interactions,
  trackables). Enough repetitions to see the true invariants, few enough to refactor safely.

**Trigger:** revisit after S7+ when functionality settles, ideally with a fresh verb in hand as
the test case (if a new verb can't be written in fewer lines with the helpers, the helpers are
wrong).
