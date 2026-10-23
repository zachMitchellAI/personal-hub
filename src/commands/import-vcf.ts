// import-vcf: re-runnable vCard 2.1 importer (DECISIONS #7). Maps each card
// onto the house write path — person row + contact_channels rows, photo blobs
// decoded to real image files under ~/hub/files/<slug>/ (DESIGN.md: images
// live on disk, never base64 in the DB) and indexed in the files table.
// Mapping (owner task spec, 2026-10-22):
//   FN (or composed N) → display_name + derived slug (add-person rules,
//     duplicate slug → skip, never auto-suffix)
//   TEL → contact_channels kind "phone"; EMAIL → kind "email" (2.1 type params
//     recorded in the channel's source, e.g. "vcf-import (cell)")
//   ORG → employer (first segment); TITLE/ADR/BDAY/URL/NOTE → people.notes
//     (BDAY keeps the DECISIONS #4 year-aware split: known year vs
//     "(year unknown)")
//   PHOTO;ENCODING=BASE64 → image file + files row + "photo:" notes line
//   X-* properties → ignored
// Re-run safety: a card whose slug already exists (in DB or earlier in the
// file) is skipped whole; a channel whose phone/email value already exists is
// skipped as a channel. Second run over the same file adds zero rows.
// Privacy note: --json skip details contain real slugs/values — this output
// is owner-facing by contract, same as every other verb's echo.
import { makeDrizzle, openDb, type HubDb } from '../core/db.ts';
import { contactChannels, files, people } from '../schema.ts';
import { deriveSlug, errorChainText } from '../core/util.ts';
import { resolveFilesPath } from '../core/paths.ts';
import { parseVcfCards, splitVcfStructured, unescapeVcfText, type VcfCard, type VcfProperty } from '../core/vcf.ts';
import type { CliValues, ImportVcfSkip, ImportVcfStatus } from '../core/types.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** One channel pending insertion for a card. */
interface PendingChannel {
  kind: string;
  value: string;
  source: string;
}

/** One photo pending disk write + files-table insert for a card. */
interface PendingPhoto {
  bytes: Buffer;
  /** Path exactly as stored in the files table (~/hub/files/<slug>/...). */
  storedPath: string;
  /** Absolute disk path to write the bytes to. */
  diskPath: string;
}

/** Accumulated result counters for one import run. */
interface ImportTallies {
  peopleImported: number;
  peopleSkipped: number;
  channelsAdded: number;
  channelsSkipped: number;
  photosWritten: number;
  photosSkipped: number;
  filesIndexed: number;
  filesSkipped: number;
  errors: number;
}

/**
 * First property with the given name from a card, or undefined.
 * @param card - Parsed vCard.
 * @param name - Uppercase property name (e.g. "FN").
 * @returns The property, or undefined when the card lacks it.
 */
function first(card: VcfCard, name: string): VcfProperty | undefined {
  return card.props.find((p) => p.name === name);
}

/**
 * All properties with the given name from a card, in file order.
 * @param card - Parsed vCard.
 * @param name - Uppercase property name (e.g. "TEL").
 * @returns The matching properties (possibly none).
 */
function all(card: VcfCard, name: string): VcfProperty[] {
  return card.props.filter((p) => p.name === name);
}

/**
 * Normalize a phone value for duplicate matching: digits only, so formatting
 * differences ("(234) 555-0101" vs "234-555-0101") count as the same number.
 * Values with no digits at all fall back to a lowercase of the raw text so a
 * degenerate value still gets a deterministic, non-colliding key.
 * @param raw - Phone value exactly as imported/stored.
 * @returns The match key.
 */
function phoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits || raw.toLowerCase();
}

/**
 * Channel provenance string recording the vCard 2.1 type parameters. "pref"
 * (a preference marker, not a type) and email-protocol noise ("internet",
 * "x-internet") are dropped; everything else is kept lowercased in order of
 * appearance, e.g. "vcf-import (cell)" or "vcf-import (work,fax)".
 * @param types - Uppercase TYPE values of the TEL/EMAIL property.
 * @returns The contact_channels.source value.
 */
function channelSource(types: string[]): string {
  const dropped = new Set(['PREF', 'INTERNET', 'X-INTERNET']);
  const kept = types.filter((t) => !dropped.has(t));
  return kept.length ? `vcf-import (${kept.map((t) => t.toLowerCase()).join(',')})` : 'vcf-import';
}

/**
 * Compose a display name from a structured N value when FN is absent:
 * "Last;First;Middle;Prefix;Suffix" → "Prefix First Middle Last Suffix".
 * @param nProp - The N property (may be undefined).
 * @returns The composed name, or "" when nothing usable remains.
 */
function displayNameFromN(nProp: VcfProperty | undefined): string {
  if (!nProp) return '';
  const parts = splitVcfStructured(nProp.value); // last, first, middle, prefix, suffix
  const [last, firstName, middle, prefix, suffix] = parts;
  return [prefix, firstName, middle, last, suffix]
    .filter((p) => p && p.trim())
    .join(' ')
    .trim();
}

/**
 * Format a BDAY value for the notes fold, honoring the DECISIONS #4 split:
 * a full date keeps its year, a bare month-day records "(year unknown)".
 * Recognized vCard 2.1 shapes: YYYY-MM-DD, --MM-DD, MM-DD.
 * @param raw - Raw BDAY value (escapes already unescaped by the caller).
 * @returns A "birthday: …" notes line fragment.
 */
function formatBirthday(raw: string): string {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `birthday: ${v}`;
  if (/^--(\d{2}-\d{2})$/.test(v)) return `birthday: ${v.slice(2)} (year unknown)`;
  if (/^(\d{2})-(\d{2})$/.test(v)) return `birthday: ${v} (year unknown)`;
  return `birthday: ${v}`; // unexpected shape: preserve verbatim for review
}

/**
 * Compose a one-line postal address from the seven ADR components
 * (pobox, ext, street, locality, region, postal, country): non-empty parts
 * joined with ", ". This mirrors the plain 2.1 Android shape without trying
 * to be locale-clever — the owner reads it, the schema stores free text.
 * @param raw - Raw ADR value (escapes intact for structured splitting).
 * @returns The address line, or "" when every component is empty.
 */
function formatAddress(raw: string): string {
  return splitVcfStructured(raw)
    .filter((p) => p && p.trim())
    .join(', ');
}

/**
 * Sniff an image extension from decoded photo bytes (magic numbers), so the
 * file on disk carries an honest extension regardless of what the (often
 * missing or mis-cased) vCard TYPE param claimed.
 * @param bytes - Decoded image bytes.
 * @returns "jpg", "png", "gif", "bmp", or "webp"; "jpg" is the fallback
 * (Android exports JPEGs, and a wrong-but-plausible extension beats none).
 */
function sniffImageExt(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'bmp';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return 'jpg';
}

/**
 * Assemble the notes fold for one card, in a fixed order so the same card
 * always produces the same notes text: title, address, birthday, url(s),
 * note(s), photo path(s). Employer is NOT here — it maps to people.employer.
 * @param card - Parsed vCard.
 * @param photoPaths - Stored file paths (~/hub/files/<slug>/photo-N.ext) for
 * this card's photos, already computed (written or would-be-written).
 * @returns Notes lines; empty array when the card contributes nothing.
 */
function buildNotesLines(card: VcfCard, photoPaths: string[]): string[] {
  const lines: string[] = [];
  for (const p of all(card, 'TITLE')) lines.push(`title: ${unescapeVcfText(p.value).trim()}`);
  for (const p of all(card, 'ADR')) {
    const addr = formatAddress(p.value);
    if (addr) lines.push(`address: ${addr}`);
  }
  for (const p of all(card, 'BDAY')) lines.push(formatBirthday(unescapeVcfText(p.value)));
  for (const p of all(card, 'URL')) {
    const url = unescapeVcfText(p.value).trim();
    if (url) lines.push(`url: ${url}`);
  }
  for (const p of all(card, 'NOTE')) {
    const note = unescapeVcfText(p.value).trim();
    if (note) lines.push(`note: ${note}`);
  }
  for (const photoPath of photoPaths) lines.push(`photo: ${photoPath}`);
  return lines;
}

/**
 * Extract this card's new channels, applying the two-layer value dedupe:
 * a value already seen earlier in the file or already in the DB (matched by
 * normalized key — digits for phones, lowercase for emails) is skipped, not
 * inserted. Skips are counted on the shared tallies, not returned.
 * @param card - Parsed vCard.
 * @param propName - "TEL" or "EMAIL".
 * @param kind - Channel kind to assign ("phone" or "email").
 * @param normalize - The match-key function for this kind.
 * @param existingKeys - Keys already present in the database.
 * @param seenKeys - Keys seen in this file during the current run.
 * @param tallies - Shared counters (channelsSkipped increments here).
 * @returns Channels that survived dedupe, in card order.
 */
function extractChannels(
  card: VcfCard,
  propName: string,
  kind: string,
  normalize: (raw: string) => string,
  existingKeys: Set<string>,
  seenKeys: Set<string>,
  tallies: ImportTallies,
): PendingChannel[] {
  const pending: PendingChannel[] = [];
  for (const prop of all(card, propName)) {
    const value = unescapeVcfText(prop.value).trim();
    if (!value) {
      tallies.channelsSkipped += 1;
      continue;
    }
    const key = normalize(value);
    if (existingKeys.has(key) || seenKeys.has(key)) {
      tallies.channelsSkipped += 1;
      continue;
    }
    seenKeys.add(key);
    pending.push({ kind, value, source: channelSource(prop.params.types) });
  }
  return pending;
}

/**
 * Decode and stage this card's BASE64 photos. Decoding happens even in
 * dry-run (extension sniffing feeds the would-be paths); disk writes are the
 * caller's job. A photo whose stored path already exists in the files table
 * is skipped as a duplicate (re-run of an interrupted import).
 * @param card - Parsed vCard.
 * @param slug - The card's derived slug (names the directory).
 * @param filesRoot - Resolved files root (~/hub/files or $HUB_FILES).
 * @param existingFilePaths - Path strings already indexed in the files table.
 * @param tallies - Shared counters (photosSkipped/filesSkipped increment here).
 * @returns Staged photos plus every photo's stored path (written or not —
 * all of them belong in the notes fold).
 */
function stagePhotos(
  card: VcfCard,
  slug: string,
  filesRoot: string,
  existingFilePaths: Set<string>,
  tallies: ImportTallies,
): { pending: PendingPhoto[]; allPaths: string[] } {
  const pending: PendingPhoto[] = [];
  const allPaths: string[] = [];
  const photos = all(card, 'PHOTO').filter((p) => p.params.encoding === 'BASE64');
  photos.forEach((prop, index) => {
    const bytes = Buffer.from(prop.value, 'base64');
    const ext = sniffImageExt(bytes);
    const storedPath = `~/hub/files/${slug}/photo-${index + 1}.${ext}`;
    allPaths.push(storedPath);
    if (existingFilePaths.has(storedPath)) {
      tallies.photosSkipped += 1;
      tallies.filesSkipped += 1;
      return;
    }
    pending.push({
      bytes,
      storedPath,
      diskPath: join(filesRoot, slug, `photo-${index + 1}.${ext}`),
    });
  });
  return { pending, allPaths };
}

/**
 * Insert one card's rows inside a per-card transaction: person, then channels,
 * then files rows. Per-card (not whole-file) transactions make a mid-file
 * crash cheap to recover from — the re-run simply skips already-imported
 * cards (DECISIONS #7). The proxy callbacks are synchronous, so awaited
 * drizzle ops run inside the open BEGIN/COMMIT.
 * @param db - Raw node:sqlite handle (owns the transaction).
 * @param hub - Typed drizzle handle over the same connection.
 * @param values - The people row values (slug already deduped by the caller).
 * @param channels - Channels to insert for this person.
 * @param photos - Photos to index in the files table for this person.
 */
async function insertCard(
  db: DatabaseSync,
  hub: HubDb,
  values: typeof people.$inferInsert,
  channels: PendingChannel[],
  photos: PendingPhoto[],
): Promise<void> {
  db.exec('BEGIN');
  try {
    const [row] = await hub.insert(people).values(values).returning({ id: people.id });
    if (channels.length) {
      await hub.insert(contactChannels).values(
        channels.map((c) => ({
          personId: row.id,
          kind: c.kind,
          value: c.value,
          primaryFlag: 0,
          source: c.source,
        })),
      );
    }
    if (photos.length) {
      await hub.insert(files).values(
        photos.map((p) => ({
          path: p.storedPath,
          kind: 'image',
          personId: row.id,
          taskId: null,
          addedAt: new Date().toISOString(),
          note: 'photo imported from vCard',
        })),
      );
    }
    db.exec('COMMIT');
  } catch (err: unknown) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * `hub import-vcf <file> [--dry-run]`: import contacts from a vCard 2.1 file.
 * Every card is classified as imported or skipped; skips are reported with
 * reasons (file order). Exit 0 when the file was processed (even if every
 * card was skipped — that is the re-run contract); exit 1 for usage/IO errors.
 * @param values - Parsed CLI flags (`--dry-run`, plus the shared `--db`/`--json`).
 * @param fileArg - First positional argument: path to the .vcf file.
 * @returns Process exit code (0 = processed, 1 = usage/IO error).
 */
export async function cmdImportVcf(values: CliValues, fileArg?: string): Promise<number> {
  const dryRun = values['dry-run'] === true;
  if (!fileArg) {
    console.error('hub import-vcf: usage: hub import-vcf <file.vcf> [--dry-run]');
    return 1;
  }

  let text: string;
  try {
    text = readFileSync(fileArg, 'utf8');
  } catch (err: unknown) {
    console.error(`hub import-vcf: cannot read "${fileArg}": ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const cards = parseVcfCards(text);

  const { db } = openDb(values.db as string | undefined);
  try {
    const hub = makeDrizzle(db);

    // Snapshot existing identities once: slugs, channel value keys, file paths.
    // Sets, not per-card queries — 149 cards stay a fixed number of round trips.
    const existingSlugs = new Set((await hub.select({ slug: people.slug }).from(people).all()).map((r) => r.slug));
    const existingChannels = await hub
      .select({ kind: contactChannels.kind, value: contactChannels.value })
      .from(contactChannels)
      .all();
    const existingPhoneKeys = new Set(existingChannels.filter((c) => c.kind === 'phone').map((c) => phoneKey(c.value)));
    const existingEmailKeys = new Set(
      existingChannels.filter((c) => c.kind === 'email').map((c) => c.value.trim().toLowerCase()),
    );
    const existingFilePaths = new Set((await hub.select({ path: files.path }).from(files).all()).map((r) => r.path));

    const tallies: ImportTallies = {
      peopleImported: 0,
      peopleSkipped: 0,
      channelsAdded: 0,
      channelsSkipped: 0,
      photosWritten: 0,
      photosSkipped: 0,
      filesIndexed: 0,
      filesSkipped: 0,
      errors: 0,
    };
    const skipped: ImportVcfSkip[] = [];
    const seenSlugs = new Set<string>();
    const seenPhoneKeys = new Set<string>();
    const seenEmailKeys = new Set<string>();
    const filesRoot = resolveFilesPath();
    const now = new Date().toISOString();

    for (let index = 0; index < cards.length; index++) {
      const card = cards[index];
      try {
        // --- name + slug (add-person rules: derive, reject duplicates) ---
        const fnProp = first(card, 'FN');
        const displayName = fnProp ? unescapeVcfText(fnProp.value).trim() : displayNameFromN(first(card, 'N'));
        const slug = displayName ? deriveSlug(displayName) : '';
        if (!slug) {
          skipped.push({ card_index: index, slug: null, reason: 'no-usable-name' });
          tallies.errors += 1;
          continue;
        }
        if (seenSlugs.has(slug) || existingSlugs.has(slug)) {
          const inFile = seenSlugs.has(slug);
          skipped.push({
            card_index: index,
            slug,
            reason: 'duplicate-slug',
            detail: inFile ? 'same slug earlier in this file' : 'person already in database',
          });
          seenSlugs.add(slug);
          tallies.peopleSkipped += 1;
          continue;
        }
        seenSlugs.add(slug);

        // --- channels (phone/email), value-deduped ---
        const channels = [
          ...extractChannels(card, 'TEL', 'phone', phoneKey, existingPhoneKeys, seenPhoneKeys, tallies),
          ...extractChannels(
            card,
            'EMAIL',
            'email',
            (raw) => raw.toLowerCase(),
            existingEmailKeys,
            seenEmailKeys,
            tallies,
          ),
        ];

        // --- photos: decode + stage (dry-run stops short of writing) ---
        const { pending: pendingPhotos, allPaths: photoPaths } = stagePhotos(
          card,
          slug,
          filesRoot,
          existingFilePaths,
          tallies,
        );

        // --- notes fold (fixed order) + employer ---
        const notesLines = buildNotesLines(card, photoPaths);
        const orgProp = first(card, 'ORG');
        const employer = orgProp ? (splitVcfStructured(orgProp.value)[0] ?? '').trim() || null : null;

        if (dryRun) {
          tallies.peopleImported += 1;
          tallies.channelsAdded += channels.length;
          tallies.photosWritten += pendingPhotos.length;
          tallies.filesIndexed += pendingPhotos.length;
          continue;
        }

        // Disk writes precede the transaction on purpose: they cannot roll
        // back, and an aborted card leaves only a harmless orphan file whose
        // deterministic path the re-run overwrites.
        for (const photo of pendingPhotos) {
          mkdirSync(dirname(photo.diskPath), { recursive: true });
          writeFileSync(photo.diskPath, photo.bytes);
          tallies.photosWritten += 1;
        }

        const nProp = first(card, 'N');
        const nParts = nProp ? splitVcfStructured(nProp.value) : [];
        await insertCard(
          db,
          hub,
          {
            slug,
            displayName,
            firstName: nParts[1]?.trim() || null,
            lastName: nParts[0]?.trim() || null,
            relationshipType: null,
            employer,
            notes: notesLines.length ? notesLines.join('\n') : null,
            createdAt: now,
          },
          channels,
          pendingPhotos,
        );
        tallies.peopleImported += 1;
        tallies.channelsAdded += channels.length;
        tallies.filesIndexed += pendingPhotos.length;
      } catch (err: unknown) {
        // One bad card must not sink the import: count it, keep going.
        skipped.push({
          card_index: index,
          slug: null,
          reason: 'error',
          detail: errorChainText(err).slice(0, 300),
        });
        tallies.errors += 1;
      }
    }

    const out: ImportVcfStatus = {
      verb: 'import-vcf',
      file: fileArg,
      dry_run: dryRun,
      cards_total: cards.length,
      people_imported: tallies.peopleImported,
      people_skipped: tallies.peopleSkipped,
      channels_added: tallies.channelsAdded,
      channels_skipped: tallies.channelsSkipped,
      photos_written: tallies.photosWritten,
      photos_skipped: tallies.photosSkipped,
      files_indexed: tallies.filesIndexed,
      files_skipped: tallies.filesSkipped,
      errors: tallies.errors,
      skipped,
    };
    if (values.json) {
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.log(
        `import-vcf: ${out.cards_total} cards, ${out.people_imported} imported, ${out.people_skipped} skipped` +
          `${dryRun ? ' (dry run — nothing written)' : ''}`,
      );
      console.log(
        `channels: ${out.channels_added} added, ${out.channels_skipped} skipped · photos: ` +
          `${out.photos_written} written, ${out.photos_skipped} skipped · errors: ${out.errors}`,
      );
      for (const s of skipped) {
        console.log(
          `skip: card ${s.card_index} slug "${s.slug ?? '-'}" — ${s.reason}${s.detail ? ` (${s.detail})` : ''}`,
        );
      }
    }
    return 0;
  } finally {
    db.close();
  }
}
