// S13 acceptance tests (stories/ticket-s13-semantic-search.md) — CLI-level
// against throwaway DBs, per DECISIONS #15. Never touches ~/hub/life.db.
//
// Scenario map:
//   1. fresh init lands embedding_meta + interaction_embeddings (vec0 present)
//   2. hybrid meaning-hit with ZERO shared keywords ("exhausted" → the
//      tired/sleep notes) — the S13 headline behavior
//   3. keyword mode: same query misses (empty), known keyword hits
//   4. --person prefilter excludes other partitions
//   5. --since metadata filter
//   6. --k respected
//   7. --json shape (snake_case contract)
//   8. Ollama-down → interaction row still inserts (exit 0), stderr warning
//   9. reindex-embeddings backfills exactly the missing rows
//  10. reindex --force re-embeds all
//  11. vec0-absent machine: init skips 009, search degrades to keyword, exit 0
//  12. usage errors: bad --mode, bad --k, bad --since, missing query
//
// Tests requiring Ollama skip cleanly when http://localhost:11434 is
// unreachable (tag: skip-if-unreachable) so `npm test` stays green offline —
// the zero-dep portability check must not gain a hard network dep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-s13-'));
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [HUB, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Ollama reachability probed once per test file; embed-requiring tests skip
// when it is down (npm test must stay green offline).
const ollamaUp = (() => {
  try {
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        "fetch('http://localhost:11434/').then(() => console.log('up')).catch(() => { console.log('down'); process.exit(1); })",
      ],
      {
        timeout: 5000,
        encoding: 'utf8',
      },
    );
    return r.status === 0 && r.stdout.includes('up');
  } catch {
    return false;
  }
})();

/** Seed two people and four interactions; returns the env for follow-up calls. */
function seedHub(dbPath: string): Record<string, string> {
  const env = { HUB_DB: dbPath };
  assert.equal(runCli(['add-person', '--name', 'Dana Reyes'], env).status, 0);
  assert.equal(runCli(['add-person', '--name', 'Maya Chen'], env).status, 0);
  const adds: string[][] = [
    [
      'add-interaction',
      '--kind',
      'chat',
      '--date',
      '2026-10-20',
      '--channel',
      'discord',
      '--summary',
      'Slept terribly last night, drained by noon',
      '--person',
      'dana-reyes',
    ],
    [
      'add-interaction',
      '--kind',
      'chat',
      '--date',
      '2026-10-21',
      '--channel',
      'discord',
      '--summary',
      'Been so tired lately, running on empty',
      '--person',
      'dana-reyes',
    ],
    [
      'add-interaction',
      '--kind',
      'call',
      '--date',
      '2026-10-22',
      '--channel',
      'phone',
      '--summary',
      'Weekly sync about the migration plan',
      '--person',
      'maya-chen',
    ],
    [
      'add-interaction',
      '--kind',
      'note',
      '--date',
      '2026-10-23',
      '--channel',
      'app',
      '--summary',
      'Redis protocol notes from the reading group',
    ],
  ];
  for (const a of adds) {
    const r = runCli(a, env);
    assert.equal(r.status, 0, r.stderr);
  }
  return env;
}

interface SearchJson {
  verb: string;
  mode: string;
  count: number;
  results: { interaction_id: number; person_slug: string | null; date: string; summary: string; distance: number }[];
}

// Scenario 1 — fresh init creates the S13 schema (vec0-capable machines only;
// the vec0-absent case is scenario 11).
test(
  'S13: fresh init lands embedding_meta + interaction_embeddings',
  { skip: ollamaUp ? false : 'Ollama unreachable' },
  (t) => {
    const tmp = makeTmp();
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const dbPath = join(tmp, 'life.db');
    const init = runCli(['init', '--json'], { HUB_DB: dbPath });
    assert.equal(init.status, 0, init.stderr);
    const status = JSON.parse(init.stdout);
    assert.ok(status.migrations_applied.includes(9), '009_semantic_search must apply');
    assert.equal(status.user_version, 9);

    // The singleton is only seeded on first vector write, not at migration
    // time — so this scenario writes one interaction, then inspects. Open the
    // db the way the CLI does (vec0 loaded) to query the vec0 table.
    assert.equal(runCli(['add-person', '--name', 'Dana Reyes'], { HUB_DB: dbPath }).status, 0);
    assert.equal(
      runCli(
        [
          'add-interaction',
          '--kind',
          'chat',
          '--date',
          '2026-10-20',
          '--channel',
          'discord',
          '--summary',
          'Slept terribly last night',
          '--person',
          'dana-reyes',
        ],
        { HUB_DB: dbPath },
      ).status,
      0,
    );

    const db = new DatabaseSync(dbPath, { allowExtension: true });
    try {
      db.loadExtension(sqliteVec.getLoadablePath());
      const meta = db.prepare('SELECT model, dims FROM embedding_meta WHERE id = 1').get() as
        | {
            model: string;
            dims: number;
          }
        | undefined;
      assert.ok(meta, 'embedding_meta singleton must exist after first vector write');
      assert.equal(meta.model, 'nomic-embed-text');
      assert.equal(meta.dims, 768);
      // The write path indexed the interaction.
      const n = db.prepare('SELECT count(*) AS n FROM interaction_embeddings').get() as { n: number };
      assert.equal(n.n, 1, 'add-interaction must produce a vector row (Ollama up)');
      // vec0 shadow tables exist (virtual table + at least one shadow).
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'interaction_embeddings%'")
        .all() as {
        name: string;
      }[];
      assert.ok(
        tables.some((x) => x.name === 'interaction_embeddings'),
        'vec0 virtual table must exist',
      );
    } finally {
      db.close();
    }
  },
);

// Scenario 2 — the S13 headline: meaning hit with zero shared keywords.
test(
  'S13: hybrid meaning-hit with zero shared keywords ranks fatigue notes first',
  { skip: ollamaUp ? false : 'Ollama unreachable' },
  (t) => {
    const tmp = makeTmp();
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const dbPath = join(tmp, 'life.db');
    const env = seedHub(dbPath);

    // "exhausted" appears in NO summary — keyword mode finds nothing, hybrid
    // must surface both fatigue notes at the top, ranked by cosine.
    const r = runCli(['search', 'exhausted', '--json'], env);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as SearchJson;
    assert.equal(out.verb, 'search');
    assert.equal(out.mode, 'hybrid');
    assert.ok(out.count >= 2, `expected at least 2 results, got ${out.count}`);
    const topTwo = out.results.slice(0, 2).map((x) => x.summary);
    assert.ok(
      topTwo.some((s) => s.includes('Slept terribly')) && topTwo.some((s) => s.includes('tired lately')),
      `fatigue notes must rank first, got: ${topTwo.join(' | ')}`,
    );
    // All four interactions are in the candidate set (k default 5 ≥ 4 rows);
    // ranking is by ascending cosine distance.
    const distances = out.results.map((x) => x.distance);
    assert.deepEqual(
      distances,
      [...distances].sort((a, b) => a - b),
    );
  },
);

// Scenario 3 — keyword mode: the same zero-keyword query misses; a shared
// keyword hits. Keyword is the contrast case and the offline fallback.
test('S13: keyword mode misses on zero shared keywords, hits on shared', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedHub(dbPath);

  const miss = runCli(['search', 'exhausted', '--mode', 'keyword', '--json'], env);
  assert.equal(miss.status, 0, miss.stderr);
  const missOut = JSON.parse(miss.stdout) as SearchJson;
  assert.equal(missOut.mode, 'keyword');
  assert.equal(missOut.count, 0);
  assert.deepEqual(missOut.results, []);

  const hit = runCli(['search', 'terribly', '--mode', 'keyword', '--json'], env);
  assert.equal(hit.status, 0, hit.stderr);
  const hitOut = JSON.parse(hit.stdout) as SearchJson;
  assert.equal(hitOut.mode, 'keyword');
  assert.ok(hitOut.count >= 1);
  assert.ok(hitOut.results[0].summary.includes('Slept terribly'));
});

// Scenario 4 — --person prefilter excludes other partitions (hybrid: the vec0
// partition key; keyword: the SQL WHERE equivalent).
test('S13: --person prefilter excludes other partitions', { skip: ollamaUp ? false : 'Ollama unreachable' }, (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedHub(dbPath);

  const r = runCli(['search', 'exhausted', '--person', 'maya-chen', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as SearchJson;
  assert.ok(out.count >= 1, 'maya-chen has the sync note');
  for (const row of out.results) {
    assert.equal(row.person_slug, 'maya-chen', 'only maya-chen rows may appear');
  }

  // Unknown slug: empty result, not a crash (the filter matches nothing).
  const none = runCli(['search', 'exhausted', '--person', 'nobody-here', '--json'], env);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).count, 0);
});

// Scenario 5 — --since metadata filter (date >= the given day).
test('S13: --since metadata filter narrows results', { skip: ollamaUp ? false : 'Ollama unreachable' }, (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedHub(dbPath);

  const r = runCli(['search', 'exhausted', '--since', '2026-10-22', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as SearchJson;
  for (const row of out.results) {
    assert.ok(row.date >= '2026-10-22', `date ${row.date} fails --since 2026-10-22`);
  }
  assert.ok(out.count >= 1, 'the 10-22/10-23 rows should survive the window');
});

// Scenario 6 — --k respected (exactly k results when more candidates exist).
test('S13: --k limits result count', { skip: ollamaUp ? false : 'Ollama unreachable' }, (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedHub(dbPath);

  const r = runCli(['search', 'exhausted', '--k', '1', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as SearchJson;
  assert.equal(out.count, 1);
  assert.equal(out.results.length, 1);
});

// Scenario 7 — --json shape: snake_case contract fields per the ticket.
test('S13: --json emits the snake_case search contract', { skip: ollamaUp ? false : 'Ollama unreachable' }, (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedHub(dbPath);

  const r = runCli(['search', 'exhausted', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as SearchJson;
  assert.equal(out.verb, 'search');
  assert.equal(typeof out.count, 'number');
  for (const row of out.results) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['date', 'distance', 'interaction_id', 'person_slug', 'summary'],
      'result keys must match the snake_case contract exactly',
    );
    assert.equal(typeof row.interaction_id, 'number');
    assert.equal(typeof row.distance, 'number');
  }
  // People-less interaction carries null person_slug.
  const peopleless = out.results.find((x) => x.person_slug === null);
  if (peopleless) assert.equal(typeof peopleless.summary, 'string');
});

// Scenario 8 — embedding failure never fails the write: Ollama down →
// interaction still inserts (exit 0) with the stderr warning.
test('S13: Ollama-down leaves the interaction row intact with a warning', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath, HUB_OLLAMA: 'http://127.0.0.1:9' }; // dead port

  // Person first — this scenario is about the embedding outage, not slugs.
  assert.equal(runCli(['add-person', '--name', 'Dana Reyes'], env).status, 0);

  const r = runCli(
    [
      'add-interaction',
      '--kind',
      'chat',
      '--date',
      '2026-10-20',
      '--channel',
      'discord',
      '--summary',
      'Slept terribly last night',
      '--person',
      'dana-reyes',
    ],
    env,
  );
  assert.equal(r.status, 0, `exit code must survive embedding failure; stderr: ${r.stderr}`);
  assert.match(r.stderr, /embedding unavailable, run reindex-embeddings/);
  assert.match(r.stdout, /added interaction 1/);

  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT id, summary FROM interactions').all() as { id: number; summary: string }[];
    assert.equal(rows.length, 1, 'the interaction row must exist');
    assert.equal(rows[0].summary, 'Slept terribly last night');
  } finally {
    db.close();
  }
});

// Scenario 9 — reindex-embeddings backfills exactly the vector rows an
// Ollama outage left missing.
test('S13: reindex-embeddings repairs an Ollama-outage gap', { skip: ollamaUp ? false : 'Ollama unreachable' }, (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const deadEnv = { HUB_DB: dbPath, HUB_OLLAMA: 'http://127.0.0.1:9' };
  const liveEnv = { HUB_DB: dbPath };

  assert.equal(runCli(['add-person', '--name', 'Dana Reyes'], deadEnv).status, 0);
  // Two adds under the outage: rows land, vectors don't.
  assert.equal(
    runCli(
      [
        'add-interaction',
        '--kind',
        'chat',
        '--date',
        '2026-10-20',
        '--channel',
        'discord',
        '--summary',
        'Slept terribly last night',
        '--person',
        'dana-reyes',
      ],
      deadEnv,
    ).status,
    0,
  );
  assert.equal(
    runCli(
      [
        'add-interaction',
        '--kind',
        'chat',
        '--date',
        '2026-10-21',
        '--channel',
        'discord',
        '--summary',
        'Been so tired lately',
      ],
      deadEnv,
    ).status,
    0,
  );

  // Backfill: both rows embedded.
  const backfill = runCli(['reindex-embeddings', '--json'], liveEnv);
  assert.equal(backfill.status, 0, backfill.stderr);
  const bf = JSON.parse(backfill.stdout);
  assert.equal(bf.verb, 'reindex-embeddings');
  assert.equal(bf.embedded, 2);
  assert.equal(bf.skipped, 0);
  assert.equal(bf.failed, 0);
  assert.equal(bf.total, 2);

  // Second run is a no-op (idempotent).
  const again = runCli(['reindex-embeddings', '--json'], liveEnv);
  assert.equal(JSON.parse(again.stdout).embedded, 0);
  assert.equal(JSON.parse(again.stdout).skipped, 2);

  // And the index now answers meaning queries.
  const search = runCli(['search', 'exhausted', '--json'], liveEnv);
  assert.equal(JSON.parse(search.stdout).mode, 'hybrid');
  assert.ok(JSON.parse(search.stdout).count >= 1);
});

// Scenario 10 — reindex --force re-embeds ALL rows (model-swap path).
test('S13: reindex --force re-embeds every interaction', { skip: ollamaUp ? false : 'Ollama unreachable' }, (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = seedHub(dbPath);

  const r = runCli(['reindex-embeddings', '--force', '--json'], env);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.embedded, 4, 'all four interactions re-embedded');
  assert.equal(out.skipped, 0);
  assert.equal(out.total, 4);

  // Vector table still holds exactly 4 rows (one per interaction). Opened
  // WITHOUT vec0 here — a plain reader counts the shadow rowids table instead.
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  try {
    db.loadExtension(sqliteVec.getLoadablePath());
    const n = db.prepare('SELECT count(*) AS n FROM interaction_embeddings').get() as { n: number };
    assert.equal(n.n, 4);
    // Interactions untouched.
    const i = db.prepare('SELECT count(*) AS n FROM interactions').get() as { n: number };
    assert.equal(i.n, 4, 'reindex never deletes interaction rows');
  } finally {
    db.close();
  }
});

// Scenario 11 — vec0-absent machine: init skips 009 (stays at 7), add
// succeeds silently, search degrades to keyword, exit 0.
test('S13: vec0-absent degrades to keyword search, exit 0', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const noVec = { HUB_DB: dbPath, HUB_VEC0_SO: '/nonexistent/vec0.so' };

  const init = runCli(['init', '--json'], noVec);
  assert.equal(init.status, 0, init.stderr);
  const initOut = JSON.parse(init.stdout);
  assert.ok(!initOut.migrations_applied.includes(9), '009 must be skipped without vec0');
  assert.equal(initOut.user_version, 7);

  assert.equal(runCli(['add-person', '--name', 'Dana Reyes'], noVec).status, 0);
  // vec0 absent AND Ollama dead: the add must still succeed, silently
  // (no embedding warning — there is no index to maintain).
  const add = runCli(
    [
      'add-interaction',
      '--kind',
      'chat',
      '--date',
      '2026-10-20',
      '--channel',
      'discord',
      '--summary',
      'Slept terribly last night',
      '--person',
      'dana-reyes',
    ],
    { ...noVec, HUB_OLLAMA: 'http://127.0.0.1:9' },
  );
  assert.equal(add.status, 0, add.stderr);
  assert.doesNotMatch(add.stderr, /embedding unavailable/);

  const search = runCli(['search', 'terribly', '--json'], noVec);
  assert.equal(search.status, 0, search.stderr);
  const out = JSON.parse(search.stdout) as SearchJson;
  assert.equal(out.mode, 'keyword');
  assert.ok(out.count >= 1);
});

// Scenario 12 — usage errors are clean (exit 1), never crashes.
test('S13: usage errors reject cleanly', (t) => {
  const tmp = makeTmp();
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const dbPath = join(tmp, 'life.db');
  const env = { HUB_DB: dbPath };

  const badMode = runCli(['search', 'q', '--mode', 'nope', '--json'], env);
  assert.equal(badMode.status, 1);
  assert.match(badMode.stderr, /--mode/);

  const badK = runCli(['search', 'q', '--k', '0'], env);
  assert.equal(badK.status, 1);
  assert.match(badK.stderr, /--k/);

  const badSince = runCli(['search', 'q', '--since', 'next friday'], env);
  assert.equal(badSince.status, 1);
  assert.match(badSince.stderr, /--since/);

  const noQuery = runCli(['search'], env);
  assert.equal(noQuery.status, 1);
  assert.match(noQuery.stderr, /query argument required/);
});
