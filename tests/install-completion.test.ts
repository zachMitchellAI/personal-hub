// install-completion tests — CLI-level. The verb copies the shipped generated
// script to a target path; tests point --dest at throwaway dirs and never
// touch the real bash-completion / ~/.hub locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTmp, runHub } from './helpers.ts';

test('install-completion: bash default copies the script into the lazy-load dir', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // HOME points at the throwaway dir, so the verb cannot touch the real one.
  const dest = join(tmp, '.local', 'share', 'bash-completion', 'completions', 'hub');

  const r = runHub(['install-completion', '--dest', dest, '--json'], { HOME: tmp });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const status = JSON.parse(r.stdout);
  assert.equal(status.verb, 'install-completion');
  assert.equal(status.shell, 'bash');
  assert.equal(status.destination, dest);
  assert.equal(status.ok, true);
  // The file is the generated script: registers itself for `hub` in bash.
  const installed = readFileSync(dest, 'utf8');
  assert.ok(installed.includes('complete -F _hub_completion hub'));
  assert.ok(statSync(dest).isFile());
});

test('install-completion: zsh target prints the source line to add', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dest = join(tmp, 'hub', 'completion', 'hub-completion.sh');

  const r = runHub(['install-completion', '--shell', 'zsh', '--dest', dest]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  // One line per thing, then the follow-up instruction for zsh wiring.
  assert.ok(r.stdout.includes('zsh completion installed'));
  assert.ok(r.stdout.includes('source ~/.hub/completion/hub-completion.sh'));
  assert.ok(readFileSync(dest, 'utf8').includes('compdef _hub_completion hub'));
});

test('install-completion: unknown --shell is rejected', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const r = runHub(['install-completion', '--shell', 'fish', '--dest', join(tmp, 'x')]);
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('unknown shell "fish"'));
});

test('install-completion: the shipped script exists in the package', () => {
  // Guards the npm-packaging path: if completion/hub-completion.sh stops
  // shipping, every install fails at copy time — assert it here instead.
  const shipped = resolve(import.meta.dirname, '..', 'completion', 'hub-completion.sh');
  assert.ok(readFileSync(shipped, 'utf8').includes('complete -F _hub_completion hub'));
});
