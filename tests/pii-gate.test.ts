// task #45 — pii-gate.sh acceptance tests (stories: research/pii-commit-gate-contract.md).
// The gate is defense-in-depth for the 2026-10-30 incident class (real PII in
// fixtures); these scenarios pin its behavior. Fixtures are fictional-only per
// the AGENTS.md rule, and each sandbox is a throwaway git repo + throwaway DB.
//
//   1.  staged synthetic PII (email/SSN/phone) blocks, refs are bare file:line
//   2.  allowlisted fictional domains (.test / allow file) pass
//   3.  denylist layer catches a fictional hub person's full name
//   4.  generic short words in the repo do NOT trip the denylist layer
//   5.  fixture change with an unreachable hub DB is refused (fail-closed)
//   6.  non-fixture change with an unreachable hub DB runs pattern-only
//   7.  matched text never appears in the gate's own terminal output
//
// CI note for owner review: scenarios invoke the sqlite3 CLI + bash + git,
// all present on local dev machines and on GitHub's ubuntu runners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const gateScript = join(repoRoot, 'scripts', 'pii-gate.sh');

/** Rows the sandbox hub DB contains. All fictional; the denylist layer is
 * expected to treat these exactly like real hub values would be treated. */
const sandboxHubRows = {
  personNames: ['Delia Frost', 'Rowan Beck'],
  entityLabels: ['Frostlight Studio'],
  channels: ['delia@frostlight.example', '555-0100-99'],
};

interface Sandbox {
  root: string;
  cleanup: () => void;
  writeAndStage: (relativePath: string, content: string) => void;
  runGate: (options?: { homeOverride?: string }) => GateResult;
}

interface GateResult {
  status: number;
  output: string;
}

/** Throwaway git repo + throwaway hub DB in a temp HOME. */
function makeSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'pii-gate-home-'));
  const root = mkdtempSync(join(tmpdir(), 'pii-gate-repo-'));
  mkdirSync(join(home, 'hub'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('sqlite3', [
    join(home, 'hub', 'life.db'),
    'CREATE TABLE people(id INTEGER, name TEXT);',
    'CREATE TABLE entities(id INTEGER, label TEXT);',
    'CREATE TABLE contact_channels(id INTEGER, value TEXT);',
    ...sandboxHubRows.personNames.map((rowName) => `INSERT INTO people VALUES(1, '${rowName.replace(/'/g, "''")}');`),
    ...sandboxHubRows.entityLabels.map(
      (rowLabel) => `INSERT INTO entities VALUES(1, '${rowLabel.replace(/'/g, "''")}');`,
    ),
    ...sandboxHubRows.channels.map(
      (rowValue) => `INSERT INTO contact_channels VALUES(1, '${rowValue.replace(/'/g, "''")}');`,
    ),
  ]);
  const cleanup = (): void => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  };
  const writeAndStage = (relativePath: string, content: string): void => {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    execFileSync('git', ['add', relativePath], { cwd: root });
  };
  const runGate = (options: { homeOverride?: string } = {}): GateResult => {
    const effectiveHome = options.homeOverride ?? home;
    const run = spawnSync('bash', [gateScript], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOME: effectiveHome },
    });
    return { status: run.status ?? -1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
  };
  return { root, cleanup, writeAndStage, runGate };
}

const seededContactBlock = [
  'reach delia.personal@gmail.com anytime',
  'ssn 411-22-1337 on file',
  'or call 865-555-0134 after five',
  '',
].join('\n');

test('scenario 1: synthetic email/SSN/phone in a staged test file blocks with bare file:line refs', () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeAndStage('tests/leak-probe.tmp', seededContactBlock);
    const result = sandbox.runGate();
    assert.equal(result.status, 1);
    assert.match(result.output, /FINDINGS/);
    assert.match(result.output, /PII-EMAIL tests\/leak-probe\.tmp:1\b/);
    assert.match(result.output, /PII-SSN tests\/leak-probe\.tmp:2\b/);
    assert.match(result.output, /PII-PHONE tests\/leak-probe\.tmp:3\b/);
  } finally {
    sandbox.cleanup();
  }
});

test('scenario 7: gate output carries rule ids and line numbers but never the matched text', () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeAndStage('tests/leak-probe.tmp', seededContactBlock);
    const result = sandbox.runGate();
    assert.equal(result.status, 1);
    assert.equal(result.output.includes('gmail.com'), false);
    assert.equal(result.output.includes('411-22-1337'), false);
    assert.equal(result.output.includes('865-555-0134'), false);
  } finally {
    sandbox.cleanup();
  }
});

test('scenario 2: allowlisted fictional fixture vocabulary passes', () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeAndStage(
      'tests/allow-probe.tmp',
      'factory contact marla.sample@example.test\nalso entity Acme Corp mentioned\n',
    );
    const result = sandbox.runGate();
    assert.equal(result.status, 0);
    assert.match(result.output, /pii-gate: clean/);
  } finally {
    sandbox.cleanup();
  }
});

test('scenario 3: denylist layer catches a fictional hub person name', () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeAndStage('tests/denylist-probe.tmp', 'the summary mentions Delia Frost and Frostlight Studio only\n');
    const result = sandbox.runGate();
    assert.equal(result.status, 1);
    assert.match(result.output, /PII-HUB-NAME tests\/denylist-probe\.tmp:1\b/);
  } finally {
    sandbox.cleanup();
  }
});

test('scenario 4: generic short words in repo text do not trip the denylist layer', () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeAndStage(
      'tests/generic-probe.tmp',
      'the hub DB is reachable and the people table plus entities are indexed\n',
    );
    const result = sandbox.runGate();
    assert.equal(result.status, 0);
  } finally {
    sandbox.cleanup();
  }
});

test('scenario 5: fixture change with no reachable hub DB is refused (fail-closed)', () => {
  const sandbox = makeSandbox();
  try {
    sandbox.writeAndStage('tests/no-db-probe.tmp', 'fully benign fictional line\n');
    const result = sandbox.runGate({ homeOverride: mkdtempSync(join(tmpdir(), 'pii-gate-nohub-')) });
    assert.equal(result.status, 1);
    assert.match(result.output, /REFUSED/);
  } finally {
    sandbox.cleanup();
  }
});

test('scenario 6: non-fixture change with no reachable hub DB runs pattern layer only', () => {
  const sandbox = makeSandbox();
  try {
    // Denylist layer is unavailable without the hub DB, so the proof here is
    // that (a) the run is NOT refused (fail-closed is fixture-scoped) and
    // (b) the pattern layer still catches a phone number.
    sandbox.writeAndStage('README-leak-probe.tmp', 'support line: 865-555-0199 weekdays\n');
    const result = sandbox.runGate({ homeOverride: mkdtempSync(join(tmpdir(), 'pii-gate-nohub-')) });
    assert.equal(result.status, 1);
    assert.match(result.output, /PII-PHONE README-leak-probe\.tmp:1\b/);
    assert.equal(result.output.includes('REFUSED'), false);
  } finally {
    sandbox.cleanup();
  }
});
