#!/usr/bin/env node
// Generates completion/hub-completion.sh — the thin bash/zsh completion
// wiring for the hub CLI.
//
// Omelette (devDependency, owner-ruled completion provider) supplies the
// battle-tested shell boilerplate: shell detection (compdef/complete/compctl)
// and the zsh/bash invocation plumbing. The one thing we swap is WHAT the
// shell calls: omelette's stock script invokes the CLI with its own internal
// flags (`hub --compzsh --compgen ...`), which would make omelette a runtime
// dependency. Instead the script calls the public zero-dependency verb
// `hub __complete <words...>`, so the runtime CLI never imports omelette —
// the dependency tension resolves to "devDependency for wiring only".
//
// Run with:  node scripts/generate-completion.mjs
// (needs omelette resolvable — `npm install` after cloning).
import omelette from 'omelette';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, '..', 'completion', 'hub-completion.sh');

// 1. Omelette's stock completion code (bash + zsh + compctl detection).
const stock = omelette('hub').generateCompletionCode();

// 2. Swap omelette's internal CLI invocation for the public __complete verb.
//    Bash passes every word on the line (COMP_WORDS, minus the program name
//    via :1 slice); zsh likewise (words). The endpoint filters by prefix
//    itself, so the scripts stay thin.
const adapted = stock
  .replace(
    'hub --compzsh --compgen "${CURRENT}" "${words[CURRENT-1]}" "${BUFFER}"',
    'hub __complete "${words[@]:1}"',
  )
  .replace(
    'hub --compbash --compgen "$((COMP_CWORD - (nb_colon * 2)))" "$prev" "${COMP_LINE}"',
    'hub __complete "${COMP_WORDS[@]:1}"',
  )
  .replace('hub --compzsh --compgen "${cword}" "${words[cword-1]}" "${line}"', 'hub __complete "${words[@]:1}"');

// 2b. Required-flag markers: `hub __complete` appends `*` to a verb's required
//     flags (e.g. `--title*`) and emits required flags FIRST. The marker is
//     display-only — inserted text is always the clean flag name:
//     - zsh: `compadd -d` displays the marked array while inserting the
//       stripped words — display strings and stored words pair element-wise.
//     - bash: readline prints COMPREPLY verbatim in its ambiguous listing,
//       so the marked candidates go in untouched and the marker is VISIBLE
//       in the menu (nosort keeps required-first order). The one path where
//       the marker would corrupt the command line is a lone candidate —
//       bash inserts it whole — so the marker is stripped exactly then;
//       multi-candidate insertion is the longest common prefix, which a
//       trailing marker can never be part of. The candidates are captured
//       with `mapfile`, not an unquoted `$(...)` capture: pathname expansion
//       would expand the `*` against cwd files (verified: `--title*` + a
//       `--titlefoo` file → `--titlefoo`).
//     - compctl (zsh legacy path): inserts what it displays, no
//       display-vs-insertion separation — strips the marker outright.
const marked = adapted
  .replace(
    'compadd -- `hub __complete "${words[@]:1}"`',
    'local -a _hub_cands; _hub_cands=(`hub __complete "${words[@]:1}"`); compadd -d _hub_cands -- ${_hub_cands//\\*}',
  )
  .replace(
    'local cur prev nb_colon',
    'compopt -o nosort 2>/dev/null; local cur prev nb_colon',
  )
  .replace(
    'COMPREPLY=( $(compgen -W \'$(hub __complete "${COMP_WORDS[@]:1}")\' -- "$cur") )',
    `local -a _hub_cands; mapfile -t _hub_cands < <(compgen -W '$(hub __complete "\${COMP_WORDS[@]:1}")' -- "$cur")
    # Required flags arrive marked (trailing \`*\`, e.g. \`--title*\`). readline prints COMPREPLY
    # verbatim in its ambiguous listing, so the marker stays VISIBLE there (nosort above keeps
    # required-first order); a lone candidate, though, is inserted whole, so the marker is
    # stripped exactly then. mapfile (not an unquoted \$(...) capture — that pathname-expands
    # the \`*\`) keeps the marker intact.
    if (( \${#_hub_cands[@]} == 1 )); then
      COMPREPLY=( "\${_hub_cands[0]%\\*}" )
    else
      COMPREPLY=( "\${_hub_cands[@]}" )
    fi`,
  )
  .replace(
    'reply=($(hub __complete "${words[@]:1}")); then',
    'reply=($(hub __complete "${words[@]:1}" | tr -d "*")); then',
  );

// 3. Assert every swap landed — an omelette upgrade that changes its emitted
//    template must fail loudly here, never silently ship broken wiring.
if (marked.includes('--compzsh --compgen') || marked.includes('--compbash --compgen')) {
  console.error('generate-completion: omelette output changed — invocation swaps failed');
  process.exit(1);
}
if (marked.includes('compadd -- `hub __complete')) {
  console.error('generate-completion: zsh compadd marker swap failed');
  process.exit(1);
}
if (!marked.includes('compopt -o nosort')) {
  console.error('generate-completion: bash nosort swap failed');
  process.exit(1);
}
if ((marked.match(/tr -d "\*"/g) || []).length !== 1) {
  console.error('generate-completion: compctl marker strip swap failed (expected exactly 1 tr -d)');
  process.exit(1);
}
if (!marked.includes('mapfile -t _hub_cands < <(compgen')) {
  console.error('generate-completion: bash marker-preserving capture swap failed');
  process.exit(1);
}
if (!marked.includes('${_hub_cands[0]%\\*}')) {
  console.error('generate-completion: bash single-candidate marker strip missing');
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, marked);
console.log(`wrote ${outFile}`);
