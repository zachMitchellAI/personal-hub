# Personal Hub — Design Doc

**Status:** v0 draft, brainstorm phase. Owner: Zachary. Agent: Sam.
**Last updated:** 2026-10-16

## Problem (STAR)

- **Situation:** Contacts, calendar, tasks, and interaction history are decentralized across Google Calendar (2 accounts, CalDAV/MCP), Trello boards (MCP), phone-local contacts (iCloud → vcf → Android → Android trail), and Thunderbird (MCP). Decentralization served privacy well.
- **Task:** Build an agentic-first, semi-centralized hub — a "personal CRM" — without losing the privacy posture. Scaling up during job hunting (plus Discord community management for 2–3 servers, 50–200 members; family time) is what forced the change.
- **Action:** SQLite core as single source of truth, a deterministic CLI as the capability layer, OpenClaw (agent) as the driver, existing MCPs as ingestion/sync edges, git+NAS for resiliency.
- **Result (target):** One queryable place for people, tasks, interactions, and related data; portable across machines; backup-tolerant; interface-agnostic (chat, CLI, MCP, phone, voice).

## Non-goals (for now)

- Self-hosted web UI — front-ends are OpenClaw channels: webchat, Matrix, Signal, Twilio (voice)
- Calendar mirroring — Google stays master; hub provides **on-demand export** of events (ics), no continuous sync
- Odoo/Monica migration — kept as a hypothetical export path, not a dependency

## Core decisions

### D1: SQLite is the core
One file, WAL mode. Portable = copy one file. Standard-ish fields (vCard-compatible contact fields) so export to anything stays trivial. Don't wait for Odoo v3/Monica MCP — an export path costs almost nothing if the schema stays clean.

### D2: The capability layer is a CLI, not "the model figures it out"
`hub` — a small deterministic command-line tool. Writes go through it; freeform SQL is allowed read-only (exploration) but never the write path. Reasons: schema drift guardrails, reviewable/repeatable, and it's the true portability contract — OpenClaw calls it via exec, opencode calls it via shell, cron calls it, the netbook calls it over SSH, and a future MCP wrapper just exposes the same verbs.

Layer stack:
1. `life.db` (SQLite) + schema + views
2. `hub` CLI (deterministic verbs: add-contact, log-interaction, add-task, due, export-vcf, ...)
3. Skills (OpenClaw playbooks that chain hub verbs for workflows: "interview prep", "weekly review", "log today's interactions")
4. Optional MCP wrapper later (for opencode/other clients)

### D3: Source-of-truth matrix (start conservative)

| Domain | Master | Adapter |
|---|---|---|
| Contacts | hub DB | one-time vcf import from phone; vcf export / CardDAV later |
| Calendar | Google | **no mirror**; on-demand export via `hub export-events` → ics |
| Tasks | hub DB | Trello stays an **interface**: active tasks (filtered) mirror out to a Trello board; Trello MCP retained — other boards remain accessible as-is |
| Interactions | hub DB | fed by Thunderbird/LinkedIn/manual logging |
| Relational data | hub DB | links/blurbs tagged to any entity |

Contact points are **open-ended**: `contact_channels.kind` is a free/extensible type (email, phone, discord, mastodon, signal, matrix, linkedin, custom) — no fixed enum, new channel types are just new rows. Discord is a contact field, not an integration.

### D4: Resiliency = git + NAS, but split the payloads
- **Git:** schema, `hub` CLI, skills, docs, importers — all the rebuildable backbone. If the machine burns, rebuild from git + restore DB. **Amended 2026-10-20 (owner):** the git remote arrives only once code development begins, and tracks **core project code only** — no personal data, no personal-context docs. The core is intended to be shareable/reusable outside OpenClaw, so it stays clean of personal context by design.
- **NAS:** nightly `sqlite3 .backup` of `life.db` to the 8TB share; weekly plain-SQL dump committed to git for diffability (DB content in a reviewable format). **Reality check 2026-10-20:** NAS is currently unreachable from derfLinux (subnet moved); it exposes SAMBA only — SSH is disabled by family policy (dad holds root). Path forward: SAMBA credential handling and/or NAS on Tailscale (conversation with dad pending; he likely prefers Tailscale). restic+SFTP (epic3) may need an SMB-compatible variant or wait on that conversation.
- Do NOT commit the live DB binary to git (churn, conflicts).

### D5: Thin client reality check
The 2008 netbook (2GB RAM) is a terminal, not a server: SSH client to the hub machine, sqlite3/hub access, maybe Tailscale. Server-ish roles (Radicale/CardDAV later) belong on the NAS or main machine. OpenClaw gateway stays on the main box initially.

## Schema v0 (sketch)

- `people` — id, **slug** (human-readable unique handle, e.g. `casey-smith`; generated at import, immutable; the key for filesystem image/icon mapping — images live on disk under the slug, not base64 in the DB — and for relation-tying), display_name, first/last, relationship_type (family/friend/professional/community), employer, notes
- `contact_channels` — person_id, kind (email/phone/discord/mastodon/linkedin/...), value, primary_flag, source
- `interactions` — id, person_id, kind (call/email/meeting/interview/message), date, channel, summary
- `tasks` — id, title, person_id?, context (job-hunt/discord/family/...), status (ready/in-progress/completed), due_date, completed_at, origin (trello/self/agent)
- `subtasks` — task_id, label, done (checklist support; maps to Trello checklist items for progress visibility)
- `events` — optional staging for exported calendar events (ics payloads, snapshots); no continuous Google mirror
- `applications` + `application_events` — job pipeline: company, role, stage, event trail
- `entities` + `entity_links` — arbitrary tagged blobs/links ("userA & userB are related to hamburgers", song links) attachable to anything
- `files` — path, kind (pdf/apk/html/image/project), person_id?, task_id?, added_at, note (index of user-facing artifacts the workflows produce; scratch work stays in the agent workspace, durable files go here)
- `sync_log` — what adapter moved what, when (debuggability)

## Trello mirror filter (decided)

The "active tasks" set = tasks in `ready` or `in-progress` status (the sprint-like structure already used on the boards). `completed` stays out. Status maps 1:1 to Trello lists; `subtasks` checklist maps to Trello checklist items so progress is visible on either side.

**Amended 2026-10-20 (owner):** Trello is a **generic front-end** for the hub, not a job-hunt feature. The hub is a generalized system for persons/things/concepts/tasks; "job hunting" is one concept among many. Tasks and/or context categories carry a **`trello_visible` flag** — only flagged rows mirror out, so the front-end shows what the owner wants visible, not everything. The sync script is the enforcement point.

## Channels (decided priority)

- **Webchat** = OpenClaw's built-in Control UI feature — nothing built from scratch.
- Power-user paths (ssh/Tailscale) already work — nothing to build.
- **Priority 1: Twilio voice** (mission-critical). OpenClaw has a dedicated voice-call plugin (`@openclaw/voice-call`): outbound + inbound calls, multi-turn conversation, full-duplex realtime voice, streaming transcription, Twilio Media Streams. Requires: plugin install, Twilio credentials + from-number, and a **publicly reachable webhook URL** (Tailscale/tunnel URL qualifies if it resolves publicly). Verified via `openclaw voicecall setup` + `openclaw voicecall smoke`.
- **Priority 2: Matrix** — native channel support (`docs/channels/matrix.md`), can attach to the self-hosted Matrix server.
- KDE Connect file transfer: deferred nice-to-have. Interim: workflows deliver files to a hub-managed directory (see D7), synced to phone by whatever mechanism comes later.

### D7: Files — two kinds, two homes

- **Agent scratch** (drafts, intermediate junk, throwaway code) lives in the OpenClaw workspace — the built-in scratchpad. Not user-facing; churns freely.
- **Durable artifacts** (PDFs found in research, downloaded APKs, HTML snapshots, exported vcf/ics, interview-prep folders) go to a hub-managed files area (`~/hub/files/` on the main box, NAS-syncable), indexed in the `files` table and linkable to people/tasks/interactions. Portable by design: one directory + one DB table.

## Skills vs automations vs subagents (design guidance)

- **Skills** = reusable playbooks the agent reads and follows (procedures chaining `hub` verbs + other tools). The sync-points are **automations** (the Gateway scheduler): scheduled jobs that can run scripts directly or start agent turns — heartbeat-adjacent, but purpose-built per job.
- **Scripts** for deterministic sync (Trello mirror, backups) — no model needed, no token burn.
- **Subagents** for genuinely unbounded-shaped work: research tasks (each one is a different shape), multi-source gathering (LinkedIn + web + docs), long-running browser work. They run in isolated context so the main session stays lean — but each costs a full agent loop, so reserve them for tasks whose shape is truly unknown or parallelizable. Unique-shape research = subagent; predictable sync = script.

## Roadmap

1. **Inventory & export** — contacts vcf off phone (confirmed: single-vcf select-all export works), Trello boards JSON, calendar account list. No building yet.
2. **Schema v0** — finalize the sketch above into real DDL.
3. **`hub` CLI skeleton** — add-contact, log-interaction, add-task, due, export-vcf.
4. **Importers & sync** — trello → tasks (one-time import), trello sync-out for the active-tasks interface board, `hub export-events` → ics, phone vcf → people/channels.
5. **OpenClaw skills** — first three: weekly review, interview prep, interaction logging.
6. **Backups** — NAS nightly backup + weekly SQL dump to git.
7. **Later** — Twilio voice plugin (Priority 1 channel), Matrix channel to self-hosted server, CardDAV server (Radicale), voice-call-driven workflows (subagent research while driving), netbook thin-client polish, MCP wrapper for opencode.

### D6: MCP + Code Mode (verified in OpenClaw docs)

- **Third-party MCP servers connect natively**: stdio / SSE / Streamable HTTP via `openclaw mcp add` or Control UI Settings → MCP. The community Trello MCP can run as a stdio server; verify with `openclaw mcp doctor <name> --probe`.
- **Code Mode** (`tools.codeMode`, default `"auto"`): the agent writes JS/TS snippets executed in a sandbox — `node:vm` by default, **QuickJS** optional for hardened isolation. Snippets can call exposed tools **including MCP tools**, batching many calls in one execution. This is the direct analog of opencode v2's QuickJS/native MCP execution.
- Cost note: Code Mode batches tool round-trips into one snippet — fewer tool-call round trips per workflow, which suits the token-transparency preference.
- **Transport decision 2026-10-20 (owner):** [mheap/trello-cli](https://github.com/mheap/trello-cli) replaces hand-rolled REST as the sync engine — owner-tested (incl. on the 2008 netbook), actively maintained, node 22+, works with the existing `TRELLO_*` env creds, JSON output on every command, and full verb coverage (card create/update/move/archive, checklists + check-item states, list ops). Sync script = orchestration around trello-cli verbs. Trello MCP retained for interactive agent use; Code Mode for glue.

## Open questions

- What filter defines the "active tasks" set that mirrors out to the Trello interface board? *(Partially answered 2026-10-20: `trello_visible` flag controls visibility; see Trello mirror filter section.)*
- Which OpenClaw channel first (Signal, Matrix, Twilio voice) after webchat?
- ~~Phone contacts: does the Android device offer a straightforward vcf export, or do we target CardDAV earlier than planned?~~ *(Answered: single-vcf select-all export works; 149 cards on disk.)*
- KDE Connect / scli(Signal-cli integration): nice-to-have, deferred until core is stable.
- Second Google account ("blackhatcat" — Discord/community personal calendar): not yet authenticated on this machine; proven working via opencode from the laptop. Authenticate when calendar export work begins.