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

// 3. Assert every swap landed — an omelette upgrade that changes its emitted
//    template must fail loudly here, never silently ship broken wiring.
if (adapted.includes('--compzsh --compgen') || adapted.includes('--compbash --compgen')) {
  console.error('generate-completion: omelette output changed — invocation swaps failed');
  process.exit(1);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, adapted);
console.log(`wrote ${outFile}`);
