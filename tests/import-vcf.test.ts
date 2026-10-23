// S8b acceptance tests — hub import-vcf. CLI-level against throwaway DBs and
// a throwaway HUB_FILES root (never life.db, never the real contact file).
// PRIVACY RULE (2026-10-20 audit): every fixture below is SYNTHETIC — example
// names, 555 phone numbers, example.com addresses, a hand-rolled fake JPEG.
// Real contact data must never appear in tests, fixtures, or reports.
// Scenario map:
//   1. first import maps every supported field (name/slug, TEL+EMAIL kinds and
//      sources, ORG, TITLE/ADR/BDAY/URL/NOTE notes fold, BASE64 photo → disk
//      + files row, X-* ignored)
//   2. re-run over the same file adds zero rows (DECISIONS #7 idempotence)
//   3. --dry-run reports the same counts but writes nothing
//   4. in-file duplicate slug → skipped, never auto-suffixed
//   5. phone normalization: formatted variants count as the same number
//   6. usage/IO errors exit 1
//   7. parser units: folding, QP with multi-byte UTF-8 across a soft break,
//      escapes, structured splitting, bare 2.1 type params
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ImportVcfStatus } from '../src/core/types.ts';
import { parseVcfCards, splitVcfStructured, unescapeVcfText } from '../src/core/vcf.ts';

const HUB = resolve(import.meta.dirname, '..', 'src', 'hub.ts');

/** A fake JPEG: real SOI/JFIF magic (so ext sniffing sees .jpg) + EOI marker. */
const FAKE_JPEG = Buffer.concat([
  Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x00,
  ]),
  Buffer.from([0xff, 0xd9]),
]);
const FAKE_JPEG_B64 = FAKE_JPEG.toString('base64');
// Fold the base64 across continuation lines exactly like Android does.
function foldB64(b64: string, width: number): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) lines.push(' ' + b64.slice(i, i + width));
  return lines.join('\n');
}

/**
 * Synthetic five-card fixture (privacy: no real people). Card map:
 *   0 full card — every mapped field, folded ADR, folded QP-capable escape
 *     note, folded BASE64 photo, X-ANDROID-CUSTOM
 *   1 QP multi-byte UTF-8 note across a soft break, year-unknown BDAY, phone
 *     that duplicates card 0's first phone digit-for-digit
 *   2 duplicate FN of card 0 → duplicate-slug skip
 *   3 N-only card (no FN) → display name composed from N
 *   4 nameless card ("???") → no-usable-name error
 */
function fixtureVcf(): string {
  return [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:Person;Test;Q;;;',
    'FN:Test Q Person',
    'ORG:Example Corp;Engineering',
    'TITLE:Principal Tester',
    'TEL;CELL:555-010-0001',
    'TEL;WORK:555-010-0002',
    'TEL;HOME;FAX:555-010-0003',
    'EMAIL;HOME:test.person.one@example.com',
    'EMAIL;PREF;WORK:work.one@example.com',
    'ADR;WORK:;;100 Test Lane Ext',
    ' ended Suite 200;Testville;TS;00001;United States',
    'BDAY:1980-01-02',
    'URL:https://example.com/testone',
    'NOTE:Plain note with \\,comma and \\;semicolon',
    'X-ANDROID-CUSTOM:vnd.android.cursor.item/note;ignored-value',
    `PHOTO;ENCODING=BASE64;JPEG:${foldB64(FAKE_JPEG_B64, 24)}`,
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:Two;Test;Q;;;',
    'FN:Test Q Two',
    'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=54=65=73=74=20=6E=6F=74=65=3A=20=75=',
    ' =6E=69=63=6F=64=65=20=C3=A9=6C=C3=A8=76=65',
    'BDAY:--03-04',
    'TEL;CELL:555-010-0001',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN:Test Q Person',
    'TEL;CELL:999-010-0009',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'N:Three;Test;Q;;;',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN:...', // nothing alphanumeric → deriveSlug yields "" → no-usable-name
    'TEL;CELL:555-010-0011',
    'END:VCARD',
    '',
  ].join('\n');
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): RunResult {
  const r = spawnSync(process.execPath, [HUB, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Throwaway harness: temp dir holding the fixture, the DB, and HUB_FILES. */
function makeHarness(): {
  dir: string;
  dbPath: string;
  filesDir: string;
  vcfPath: string;
  env: Record<string, string>;
} {
  const dir = mkdtempSync(join(tmpdir(), 'hub-s8b-'));
  const vcfPath = join(dir, 'fixture.vcf');
  const filesDir = join(dir, 'files');
  const env = { HUB_DB: join(dir, 'life.db'), HUB_FILES: filesDir };
  return { dir, dbPath: env.HUB_DB, filesDir, vcfPath, env };
}

function writeFixture(harness: ReturnType<typeof makeHarness>, vcf: string): void {
  writeFileSync(harness.vcfPath, vcf, 'utf8');
}

function dbCounts(dbPath: string): { people: number; channels: number; files: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      people: (db.prepare('select count(*) c from people').get() as { c: number }).c,
      channels: (db.prepare('select count(*) c from contact_channels').get() as { c: number }).c,
      files: (db.prepare('select count(*) c from files').get() as { c: number }).c,
    };
  } finally {
    db.close();
  }
}

/**
 * Fetch exactly one row or fail loudly — raw node:sqlite rows are untyped
 * records, and every read in these tests has a known expected row.
 */
function one(db: DatabaseSync, sql: string, ...params: (string | number)[]): Record<string, unknown> {
  const row = db.prepare(sql).get(...params);
  assert.ok(row, `expected a row: ${sql}`);
  return row as Record<string, unknown>;
}

// Scenario 1 — every mapped field lands where the task spec says it belongs.
test('S8b: import-vcf maps names, channels, notes fold, and photos on first run', (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.dir, { recursive: true, force: true }));
  writeFixture(harness, fixtureVcf());

  const run = runCli(['import-vcf', harness.vcfPath, '--json'], harness.env);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout) as ImportVcfStatus;
  assert.equal(out.verb, 'import-vcf');
  assert.equal(out.cards_total, 5);
  assert.equal(out.people_imported, 3);
  assert.equal(out.people_skipped, 1); // card 2: duplicate slug
  assert.equal(out.errors, 1); // card 4: no usable name
  assert.equal(out.channels_added, 5); // card0: 3 phone + 2 email
  assert.equal(out.channels_skipped, 1); // card1 reuses card0's cell number
  assert.equal(out.photos_written, 1);
  assert.equal(out.files_indexed, 1);

  const db = new DatabaseSync(harness.dbPath, { readOnly: true });
  try {
    // Person row: mapping and identity.
    const person = one(db, "select * from people where slug = 'test-q-person'");
    assert.equal(person.display_name, 'Test Q Person');
    assert.equal(person.first_name, 'Test');
    assert.equal(person.last_name, 'Person');
    assert.equal(person.employer, 'Example Corp'); // ORG first segment only
    const notes = person.notes as string;
    const lines = notes.split('\n');
    assert.ok(lines.includes('title: Principal Tester'), notes);
    assert.ok(lines.includes('address: 100 Test Lane Extended Suite 200, Testville, TS, 00001, United States'), notes);
    assert.ok(lines.includes('birthday: 1980-01-02'), notes);
    assert.ok(lines.includes('url: https://example.com/testone'), notes);
    assert.ok(lines.includes('note: Plain note with ,comma and ;semicolon'), notes); // escapes resolved
    assert.ok(lines.includes('photo: ~/hub/files/test-q-person/photo-1.jpg'), notes);
    assert.ok(!notes.includes('ignored-value'), 'X- props must not leak into notes');

    // Channels: kind per spec, 2.1 types folded into source (PREF dropped).
    const chans = db
      .prepare('select kind, value, source from contact_channels where person_id = ? order by kind, id')
      .all(person.id as number) as { kind: string; value: string; source: string }[];
    assert.deepEqual(
      chans.map((c) => `${c.kind}:${c.value}:${c.source}`),
      [
        'email:test.person.one@example.com:vcf-import (home)',
        'email:work.one@example.com:vcf-import (work)',
        'phone:555-010-0001:vcf-import (cell)',
        'phone:555-010-0002:vcf-import (work)',
        'phone:555-010-0003:vcf-import (home,fax)',
      ],
    );
    // All imported channels are non-primary (no PREF → primary magic).
    const primaries = one(
      db,
      'select count(*) c from contact_channels where person_id = ? and primary_flag = 1',
      person.id as number,
    );
    assert.equal(primaries.c, 0);

    // Year-unknown birthday keeps the DECISIONS #4 month-day form.
    const two = one(db, "select notes from people where slug = 'test-q-two'");
    assert.ok((two.notes as string).includes('birthday: 03-04 (year unknown)'), two.notes as string);
    assert.ok((two.notes as string).includes('note: Test note: unicode élève'), two.notes as string);

    // N-only card composes its display name from the structured N.
    const three = one(db, "select display_name, first_name, last_name from people where slug = 'test-q-three'");
    assert.equal(three.display_name, 'Test Q Three');
    assert.equal(three.first_name, 'Test');
    assert.equal(three.last_name, 'Three');
  } finally {
    db.close();
  }

  // Photo: real image file on disk with the exact decoded bytes, indexed in files.
  const photoPath = join(harness.filesDir, 'test-q-person', 'photo-1.jpg');
  assert.ok(existsSync(photoPath), 'photo written under <filesRoot>/<slug>/');
  assert.deepEqual(readFileSync(photoPath), FAKE_JPEG);
  const db2 = new DatabaseSync(harness.dbPath, { readOnly: true });
  try {
    const fileRow = one(
      db2,
      "select path, kind, person_id, note from files where path = '~/hub/files/test-q-person/photo-1.jpg'",
    );
    assert.equal(fileRow.kind, 'image');
    assert.ok(fileRow.person_id, 'photo linked to its person');
  } finally {
    db2.close();
  }
});

// Scenario 2 — DECISIONS #7: the same file re-run imports nothing new.
test('S8b: re-running the same file skips everything and adds zero rows', (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.dir, { recursive: true, force: true }));
  writeFixture(harness, fixtureVcf());

  const first = runCli(['import-vcf', harness.vcfPath, '--json'], harness.env);
  assert.equal(first.status, 0, first.stderr);
  const before = dbCounts(harness.dbPath);

  const second = runCli(['import-vcf', harness.vcfPath, '--json'], harness.env);
  assert.equal(second.status, 0, second.stderr);
  const out = JSON.parse(second.stdout) as ImportVcfStatus;
  assert.equal(out.people_imported, 0);
  assert.equal(out.people_skipped, 4); // cards 0,1,2,3 all hit existing identities
  assert.equal(out.errors, 1); // card 4 again (data problem, not a duplicate)
  assert.equal(out.channels_added, 0);
  // Duplicate-slug people are skipped whole, so their channels are never even
  // evaluated — a clean re-run reports zero channel activity, not phantom skips.
  assert.equal(out.channels_skipped, 0);
  assert.equal(out.photos_written, 0);
  assert.deepEqual(dbCounts(harness.dbPath), before, 'no rows added on re-run');
});

// Scenario 3 — --dry-run reports the real run's counts but writes nothing.
test('S8b: --dry-run counts accurately and leaves db and disk untouched', (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.dir, { recursive: true, force: true }));
  writeFixture(harness, fixtureVcf());

  const run = runCli(['import-vcf', harness.vcfPath, '--dry-run', '--json'], harness.env);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout) as ImportVcfStatus;
  assert.equal(out.dry_run, true);
  assert.equal(out.people_imported, 3);
  assert.equal(out.people_skipped, 1);
  assert.equal(out.channels_added, 5);
  assert.equal(out.channels_skipped, 1);
  assert.equal(out.photos_written, 1);

  const counts = dbCounts(harness.dbPath);
  assert.deepEqual(counts, { people: 0, channels: 0, files: 0 });
  assert.ok(!existsSync(harness.filesDir), 'no files directory created on dry run');
});

// Scenario 4 — in-file slug collision: second card skipped, no auto-suffix.
test('S8b: duplicate slug inside one file is skipped with a reason, never suffixed', (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.dir, { recursive: true, force: true }));
  writeFixture(harness, fixtureVcf());

  const run = runCli(['import-vcf', harness.vcfPath, '--json'], harness.env);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout) as ImportVcfStatus;
  const dup = out.skipped.find((s) => s.reason === 'duplicate-slug');
  assert.ok(dup, 'duplicate-slug skip reported');
  assert.equal(dup.slug, 'test-q-person');
  assert.equal(dup.card_index, 2);
  assert.equal(dup.detail, 'same slug earlier in this file');

  const db = new DatabaseSync(harness.dbPath, { readOnly: true });
  try {
    const rows = one(db, "select count(*) c from people where slug = 'test-q-person'");
    assert.equal(rows.c, 1, 'no auto-suffixed twin row');
  } finally {
    db.close();
  }
});

// Scenario 5 — formatted phone variants count as the same number against
// channels already in the DB (here seeded through the normal add-* verbs).
test('S8b: phone matching is format-insensitive against existing DB channels', (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.dir, { recursive: true, force: true }));
  const seeded = 'BEGIN:VCARD\nVERSION:2.1\nN:Four;Test;Q;;;\nFN:Test Q Four\nTEL;CELL:555-010-1234\nEND:VCARD\n';
  writeFixture(harness, seeded);

  assert.equal(runCli(['add-person', '--name', 'Seed Person', '--json'], harness.env).status, 0);
  assert.equal(
    runCli(['add-channel', 'seed-person', '--kind', 'phone', '--value', '(555) 010-1234'], harness.env).status,
    0,
  );

  const run = runCli(['import-vcf', harness.vcfPath, '--json'], harness.env);
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout) as ImportVcfStatus;
  assert.equal(out.people_imported, 1, 'person still imported');
  assert.equal(out.channels_skipped, 1, 'phone skipped as existing');
  assert.equal(out.channels_added, 0);

  const db = new DatabaseSync(harness.dbPath, { readOnly: true });
  try {
    const four = one(db, "select id from people where slug = 'test-q-four'");
    const chans = one(db, 'select count(*) c from contact_channels where person_id = ?', four.id as number);
    assert.equal(chans.c, 0, 'no channel row added for the matched number');
  } finally {
    db.close();
  }
});

// Scenario 6 — usage and IO errors exit 1.
test('S8b: missing file and missing argument exit 1 with usage on stderr', (t) => {
  const harness = makeHarness();
  t.after(() => rmSync(harness.dir, { recursive: true, force: true }));

  const noFile = runCli(['import-vcf', join(harness.dir, 'absent.vcf')], harness.env);
  assert.equal(noFile.status, 1);
  assert.match(noFile.stderr, /hub import-vcf: cannot read/);

  const noArg = runCli(['import-vcf'], harness.env);
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /usage/);
});

// Scenario 7 — parser units: folding, QP multi-byte across a soft break,
// escapes, structured splitting, and bare 2.1 type params.
test('S8b parser: unfolds lines, decodes QP (multibyte across folds), unescapes', () => {
  const cards = parseVcfCards(
    [
      'BEGIN:VCARD',
      'FN:Unit U',
      ' RL', // folded FN: the continuation space is the fold marker → "Unit URL"
      'NOTE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=C3=A9=3D=20=74=65=73=74=5C=3B=6F=6B',
      'TEL;CELL;WORK:555-0000',
      'ADR:;;Main St;Town;;00000;',
      'END:VCARD',
      '',
    ].join('\n'),
  );
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(card.props.find((p) => p.name === 'FN')?.value, 'Unit URL');
  // é (=C3=A9) then =3D (literal "="), soft-break-free, escapes intact.
  const note = card.props.find((p) => p.name === 'NOTE')?.value ?? '';
  assert.equal(note, 'é= test\\;ok');
  assert.equal(unescapeVcfText(note), 'é= test;ok');
  const tel = card.props.find((p) => p.name === 'TEL');
  assert.deepEqual(tel?.params.types, ['CELL', 'WORK']); // bare 2.1 params
  // ADR: 7 positional components, empties preserved.
  assert.deepEqual(splitVcfStructured(card.props.find((p) => p.name === 'ADR')?.value ?? ''), [
    '',
    '',
    'Main St',
    'Town',
    '',
    '00000',
    '',
  ]);
});

test('S8b parser: tolerates missing END and skips lines without colons', () => {
  const cards = parseVcfCards('BEGIN:VCARD\nFN:Stray\nNOTE no colon here\nN:End;No\n');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].props.length, 2);
  assert.equal(cards[0].props[1].name, 'N');
});
