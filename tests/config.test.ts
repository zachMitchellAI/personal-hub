// S13 portability pass (2026-10-31): config resolution tests — env-file
// parsing, precedence (real env > config file), and the EMBED_DIM migration
// substitution. CLI-level against throwaway DBs; never touches ~/hub/life.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { latestNonGatedMigrationVersion } from './helpers.ts';

const HUB = join(import.meta.dirname, '..', 'src', 'hub.ts');
const CONFIG = join(import.meta.dirname, '..', 'src', 'core', 'config.ts');

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'hub-cfg-'));
}

// --- parseEnvFile: unit-level (config.ts is import-safe, no side effects) ---
test('S13 cfg: parseEnvFile handles comments, blanks, and raw values', async () => {
  const { parseEnvFile } = await import(CONFIG);
  const parsed = parseEnvFile(
    ['# comment line', '', 'HUB_EMBED_MODEL=bge-small', 'HUB_OLLAMA=http://host:1234', 'HUB_EMPTY='].join('\n'),
    'test-env',
  );
  assert.equal(parsed.HUB_EMBED_MODEL, 'bge-small');
  assert.equal(parsed.HUB_OLLAMA, 'http://host:1234');
  assert.equal(parsed.HUB_EMPTY, '');
});

for (const bad of ['NOEQUALS', '=novalue']) {
  test(`S13 cfg: parseEnvFile rejects malformed line (${bad})`, async () => {
    const { parseEnvFile } = await import(CONFIG);
    assert.throws(() => parseEnvFile(`HUB_OK=1\n${bad}\n`), /expected KEY=VALUE/);
  });
}

// --- semanticConfig precedence: real env beats the config file ---
test('S13 cfg: real env overrides the config file for model/dim/ollama', async () => {
  const tmp = makeTmp();
  try {
    const cfgPath = join(tmp, 'env');
    writeFileSync(cfgPath, 'HUB_EMBED_MODEL=fromfile\nHUB_EMBED_DIM=384\nHUB_OLLAMA=file-ignored\n');
    process.env.HUB_CONFIG = cfgPath;
    process.env.HUB_EMBED_MODEL = 'fromenv';
    const { semanticConfig, resetHubFileCache } = await import(CONFIG);
    resetHubFileCache();
    const cfg = semanticConfig();
    assert.equal(cfg.model, 'fromenv');
    assert.equal(cfg.dim, 384, 'file value used where env is silent');
    assert.equal(cfg.ollama, 'file-ignored', 'file value used where env is silent');
  } finally {
    delete process.env.HUB_CONFIG;
    delete process.env.HUB_EMBED_MODEL;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('S13 cfg: bad HUB_EMBED_DIM fails loudly, never silently corrupts', async () => {
  for (const bad of ['0', 'banana', '-5']) {
    process.env.HUB_EMBED_DIM = bad;
    try {
      const { semanticConfig } = await import(CONFIG);
      assert.throws(() => semanticConfig(), /positive integer/);
    } finally {
      delete process.env.HUB_EMBED_DIM;
    }
  }
});

// --- End-to-end: a custom dim flows from config into the vec0 DDL ---
test('S13 cfg: HUB_EMBED_DIM=384 creates the vec0 table at width 384', () => {
  const tmp = makeTmp();
  try {
    const dbPath = join(tmp, 'life.db');
    const r = spawnSync(process.execPath, [HUB, 'init', '--json'], {
      env: { ...process.env, HUB_DB: dbPath, HUB_EMBED_DIM: '384', HUB_EMBED_MODEL: 'bge-small-en' },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(out.migrations_applied.includes(9), '009 must apply with a custom dim');
    // The migration applying proves {{EMBED_DIM}} substitution parsed.
    // Verify the width via the DDL sqlite stores.
    const db = new DatabaseSync(dbPath);
    try {
      const sql = (
        db.prepare("SELECT sql FROM sqlite_master WHERE name = 'interaction_embeddings'").get() as { sql: string }
      ).sql;
      assert.match(sql, /float\[384\]/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// --- vec0-absent degradation still applies with a custom dim configured ---
test('S13 cfg: vec0-absent machine still skips 009 cleanly with custom dim set', () => {
  const tmp = makeTmp();
  try {
    const dbPath = join(tmp, 'life.db');
    const r = spawnSync(process.execPath, [HUB, 'init', '--json'], {
      env: {
        ...process.env,
        HUB_DB: dbPath,
        HUB_EMBED_DIM: '384',
        HUB_VEC0_SO: '/nonexistent/vec0.so', // the manual override misses → degrade
      },
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.ok(!out.migrations_applied.includes(9), '009 must skip with a dead vec0 override');
    assert.equal(out.user_version, latestNonGatedMigrationVersion());
    // note: derived from src/migrations filenames (tests/helpers.ts) — no per-branch bump
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
