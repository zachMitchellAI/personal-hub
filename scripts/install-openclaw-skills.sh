#!/usr/bin/env bash
# Install every skill under .agents/skills/ into the OpenClaw workspace.
#
# OpenCode discovers .agents/skills/ natively, so it needs no install step.
# OpenClaw does not scan nested project directories, so this script copies the
# skills into the agent workspace via `openclaw skills install` (the sanctioned
# path — it also triggers a live-instance skill rescan). Local installs are
# not tracked by `openclaw skills update`; re-run this script to refresh them.
#
# Usage: scripts/install-openclaw-skills.sh
# Set OPENCLAW_AGENT=<id> to target a specific agent workspace instead of the
# cwd-inferred default.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skills_dir="$repo_root/.agents/skills"

shopt -s nullglob
skills=("$skills_dir"/*/)
if ((${#skills[@]} == 0)); then
  echo "no skills found under $skills_dir" >&2
  exit 1
fi

agent_args=()
if [[ -n "${OPENCLAW_AGENT:-}" ]]; then
  agent_args=(--agent "$OPENCLAW_AGENT")
fi

for dir in "${skills[@]}"; do
  name="$(basename "$dir")"
  echo "installing skill: $name"
  openclaw skills install "$dir" --as "$name" --force \
    --acknowledge-install-policy-warning "${agent_args[@]+"${agent_args[@]}"}"
done

echo "done — installed ${#skills[@]} skill(s) into the OpenClaw workspace"
