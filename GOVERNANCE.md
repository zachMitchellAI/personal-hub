# GOVERNANCE.md — Repo trust tiers

> Content policy for contributions to this repository. When in doubt, ask
> before pushing — the tiers below resolve most "can I?" questions on their own.

## The pillars

1. **Canonical repo — the template.** The only source of truth for the
   project's history. All public history lives here, and every lane of work
   branches from it — nowhere else.

2. **Private agent repo — the sandbox.** Owned by the agent GitHub account
   (separate identity and keys from the owner). Agents make mistakes here on
   purpose: force-pushes, WIP branches, lane experiments. Mistakes are cheap
   and contained by definition. The PII commit gate (`scripts/pii-gate.sh`,
   wire with `git config core.hooksPath scripts/githooks`) runs on every
   commit.

3. **Public repo — human-gated.** Agents may *author* PRs against it; the
   merge button is the owner's, always. Promotion (repo creation, visibility
   changes, or making state public) requires the audit gate below.

## The promotion/audit gate

Before a repo is created from another tier's state, or before content becomes
public-facing:

1. Fresh clone from server-side refs.
2. `git log -p --all | grep` against the current denylist — **0 hits**.
3. Repeat from a second independent clone — **0 hits**.
4. Owner rubber-stamp.

## If a gate failure occurs

Not "merge more carefully." Rewind the offending branch, rewrite it
(`git-filter-repo --replace-text`, two verification passes) **before** it
re-enters a repo's main. The pre-commit gate is the first line; the audit gate
is the second.

## Standing rules

- Any push, force-push, or history rewrite on the public repo requires the
  owner's explicit go first. PR-first satisfies "what lands", not "who writes".
- History rewrites must preserve author and committer dates; force-pushed
  rewrites change SHAs, which is expected and fine.
- Agents use the noreply GitHub identity. Hostnames, LAN addresses, network
  topology, family/private context, and personal-data documents never enter a
  GitHub-hosted tier. If content would be uncomfortable public, it does not
  enter any GitHub tier at all — private ≠ invisible.
- Only full repo delete/recreate reliably removes exposed refs (`refs/pull/*`
  persist server-side after rewrites); treat GitHub-hosted history as
  append-with-care.
