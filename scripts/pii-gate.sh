#!/usr/bin/env bash
# pii-gate.sh — PII leak gate for the personal-hub repo (task #45).
#
# Scans content for personally identifiable information before it can land.
# Two layers:
#   1. Pattern layer (always runs, zero deps): regexes for SSN/phone/email
#      shapes, with an allowlist for documented fictional fixtures.
#   2. Denylist layer (only where the hub DB resolves): exact whole-word
#      matches built LIVE from ~/hub/life.db. Entries are kept distinctive:
#      multi-word values (person/company names) or values of length >= 4.
#      Generic short slugs ("hub") are skipped to avoid self-noise. The
#      denylist is real PII — held in a 0600 temp file, deleted on exit,
#      never committed.
#
# Fail-closed rule: commits that add or modify files under tests/ pass on the
# pattern layer alone only if the hub DB is reachable; without it they are
# refused — fixtures are the highest-risk file type (the 2026-10-30 incident
# shipped real people into tests).
#
# Output discipline: file:line plus a rule id. Never echo the matched text —
# terminal scrollback is itself a data surface.
#
# Usage:
#   scripts/pii-gate.sh            # scan staged changes (default)
#   scripts/pii-gate.sh --full     # scan all tracked files (merge-time check)
#   scripts/pii-gate.sh --help
#
# Exit codes: 0 = clean, 1 = findings, 2 = usage/environment error.

set -u

readonly HUB_DB="${HOME}/hub/life.db"
readonly RULE_EMAIL="PII-EMAIL"
readonly RULE_SSN="PII-SSN"
readonly RULE_PHONE="PII-PHONE"
readonly RULE_Denylist="PII-HUB-NAME"
readonly RULE_NO_DB="PII-NO-DB"
readonly ALLOW_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pii-gate-allowlist.txt"

denylist_file=""

usage() {
	sed -n '2,26p' "$0"
}

# Extract scan targets. mode is "staged" (default) or "full".
collect_targets() {
	if [ "$mode" = "full" ]; then
		git ls-files
	else
		git diff --cached --name-only --diff-filter=ACMR
	fi
}

# Build the live denylist into denylist_file. Returns nonzero when the hub
# DB is not usable (missing sqlite3, missing DB, empty extraction).
build_denylist() {
	command -v sqlite3 >/dev/null 2>&1 || return 1
	[ -f "$HUB_DB" ] || return 1
	denylist_file="$(mktemp "${TMPDIR:-/tmp}/pii-denylist.XXXXXX")"
	chmod 600 "$denylist_file"
	{
		sqlite3 "$HUB_DB" "SELECT name FROM people;"
		sqlite3 "$HUB_DB" "SELECT label FROM entities;"
		sqlite3 "$HUB_DB" "SELECT value FROM contact_channels;"
	} 2>/dev/null \
		| tr -d '\r' \
		| awk 'length($0) >= 4 || $0 ~ / /' \
		| sort -u > "$denylist_file"
	[ -s "$denylist_file" ] || { clear_denylist; return 1; }
	return 0
}

clear_denylist() {
	[ -n "$denylist_file" ] && [ -f "$denylist_file" ] && rm -f "$denylist_file"
	return 0
}

# Drop allowlisted lines from the given refs (stdin -> stdout).
filter_allowlist() {
	grep -Fvxf <(grep -Ev '^\s*(#|$)' "$ALLOW_FILE" 2>/dev/null) - 2>/dev/null || true
}

# Emit "<line-number><TAB>line content" for matches of one ERE in a file.
match_lines() {
	grep -Ein -- "$2" "$1" 2>/dev/null | sed 's/^\([0-9]*\):/\1\t/'
}

# Remove lines whose CONTENT matches any allowlist ERE (stdin -> stdout).
# Operates on "<number>\t<content>" lines so regexes can match content while
# the terminal output later prints only the number. awk reads the allowlist
# file first, then the piped scan stream.
filter_allowlist() {
	[ -f "$ALLOW_FILE" ] || { cat; return 0; }
	awk '
		FNR == NR {
			if ($0 !~ /^[[:space:]]*(#|$)/) allow[n++] = $0
			next
		}
		{
			keep = 1
			for (idx in allow) if ($0 ~ allow[idx]) { keep = 0; break }
			if (keep) print
		}' "$ALLOW_FILE" -
	return 0
}

# Scan one file with every rule. Allowlist runs against content before
# reporting so matched text never reaches the terminal.
scan_file() {
	local checked_file="$1" number
	# Email shape; example.test-style fictional domains are allowlisted.
	match_lines "$checked_file" \
		'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|net|org|gov|io|edu|dev|test)' \
		| grep -Ev '@[A-Za-z0-9.-]+\.test' \
		| filter_allowlist \
		| cut -f1 \
		| while IFS= read -r number; do
			printf '  %s %s:%s\n' "$RULE_EMAIL" "$checked_file" "$number"
		done >> "$findings_file"
	# SSN shape (separated form only; bare 9-digit is too noisy).
	match_lines "$checked_file" '\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b' \
		| filter_allowlist \
		| cut -f1 \
		| while IFS= read -r number; do
			printf '  %s %s:%s\n' "$RULE_SSN" "$checked_file" "$number"
		done >> "$findings_file"
	# US phone shape.
	match_lines "$checked_file" \
		'(\+?1[ .-]?)?\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}\b' \
		| filter_allowlist \
		| cut -f1 \
		| while IFS= read -r number; do
			printf '  %s %s:%s\n' "$RULE_PHONE" "$checked_file" "$number"
		done >> "$findings_file"
	# Denylist layer: only where the hub DB resolved.
	if [ "$deny_available" -eq 1 ]; then
		local escaped_values
		escaped_values=$(sed 's/[][\.*^$]/\\&/g' "$denylist_file" | paste -sd'|')
		match_lines "$checked_file" "\b($escaped_values)\b" 2>/dev/null \
			| filter_allowlist \
			| cut -f1 \
			| while IFS= read -r number; do
				printf '  %s %s:%s\n' "$RULE_Denylist" "$checked_file" "$number"
			done >> "$findings_file"
	fi
	return 0
}

# Denylist is real PII: cleared on every exit path, including ^C / kill
# during a scan (a realistic operator event) — not just the normal EXIT path.
trap clear_denylist EXIT
trap 'clear_denylist; exit 130' INT
trap 'clear_denylist; exit 143' TERM

case "${1:-}" in
	--help|-h) usage; exit 0 ;;
	--full) mode="full" ;;
	"") mode="staged" ;;
	*) echo "pii-gate: unknown option '$1'" >&2; usage; exit 2 ;;
esac

echo "pii-gate: scanning ($mode)"

deny_available=1
build_denylist || deny_available=0

targets="$(collect_targets)"
if [ -z "$targets" ]; then
	echo "pii-gate: nothing to scan"
	clear_denylist
	exit 0
fi

# Fail-closed BEFORE scanning: fixture changes without a reachable hub DB
# are refused outright.
if [ "$deny_available" -eq 0 ]; then
	fixture_changes="$(printf '%s\n' "$targets" | grep -E '^tests/' || true)"
	if [ -n "$fixture_changes" ]; then
		echo "pii-gate: REFUSED — files under tests/ changed but the hub DB is not reachable" >&2
		echo "pii-gate: $RULE_NO_DB — commit on the hub machine so the denylist layer can verify" >&2
		clear_denylist
		exit 1
	fi
	echo "pii-gate: note — hub DB unavailable; pattern layer only" >&2
fi

findings_file="$(mktemp "${TMPDIR:-/tmp}/pii-gate-findings.XXXXXX")"
chmod 600 "$findings_file"

printf '%s\n' "$targets" | while IFS= read -r checked_target; do
	[ -f "$checked_target" ] && scan_file "$checked_target"
done

if [ -s "$findings_file" ]; then
	echo "pii-gate: FINDINGS — commit blocked"
	echo "pii-gate: rule id and file:line below"
	cat "$findings_file"
	rm -f "$findings_file"
	clear_denylist
	echo "pii-gate: matched text is intentionally NOT displayed. Inspect the file locally."
	exit 1
fi

rm -f "$findings_file"
clear_denylist
echo "pii-gate: clean"
exit 0
