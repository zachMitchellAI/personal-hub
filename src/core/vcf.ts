// Minimal vCard 2.1 parser (pure — no DB, no disk I/O). Built for the
// import-vcf verb (DECISIONS #7: importers are permanent re-runnable scripts).
// Android is the real-world producer here, so the parser targets its quirks:
// folded continuation lines (leading space), bare TYPE params (TEL;CELL,
// PHOTO;JPEG), QUOTED-PRINTABLE bodies with soft line breaks, CHARSET params,
// and BASE64 photo blobs. X- properties are parsed and simply ignored by the
// caller (they stay in the property list; filtering is the caller's job).
// References: RFC 2426 §2.1 (line folding/escaping), RFC 2045 §6.7 (QP).

/** Parameter block of one vCard property, normalized for easy matching. */
export interface VcfParams {
  /** TYPE values in order of appearance (bare 2.1 params and TYPE= pairs), uppercased. */
  types: string[];
  /** ENCODING param, uppercased (e.g. "BASE64", "QUOTED-PRINTABLE"), or null. */
  encoding: string | null;
  /** CHARSET param as written (case preserved for charset lookup), or null. */
  charset: string | null;
}

/** One property line of a vCard, with its value decoded per ENCODING. */
export interface VcfProperty {
  /** Property name, uppercased (e.g. "FN", "TEL", "X-ANDROID-CUSTOM"). */
  name: string;
  /** Normalized parameter block. */
  params: VcfParams;
  /**
   * Decoded value. For QUOTED-PRINTABLE this is the charset-decoded text
   * (escapes still intact — callers unescape via unescapeVcfText after any
   * structured split). For BASE64 this is the whitespace-stripped base64 text
   * (callers Buffer.from(value, "base64")). Otherwise the raw value text.
   */
  value: string;
}

/** One BEGIN:VCARD…END:VCARD block as an ordered property list. */
export interface VcfCard {
  props: VcfProperty[];
}

/**
 * Unfold RFC 2426 §2.1 continuation lines (each starts with a single space or
 * tab, which is removed). Fold points are marked with a NUL sentinel so the
 * QP decoder can distinguish a soft line break ("=" at end of a folded line)
 * from an encoded byte whose two hex digits happen to follow the "=" after
 * joining — a distinction the folded representation alone cannot make.
 * @param text - Raw file contents (any common line ending).
 * @returns Logical (unfolded) lines in order.
 */
function unfoldLines(text: string): string[] {
  const FOLD = '\u0000';
  const out: string[] = [];
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    if ((rawLine.startsWith(' ') || rawLine.startsWith('\t')) && out.length > 0) {
      // Continuation: drop exactly one leading whitespace char, mark the fold.
      out[out.length - 1] += FOLD + rawLine.slice(1);
    } else {
      out.push(rawLine);
    }
  }
  return out;
}

/**
 * Decode a quoted-printable value (RFC 2045 §6.7): =XX hex escapes, soft line
 * breaks ("=" at end of line — after unfolding these appear as "=" + fold
 * marker), and literal content. Bytes are collected raw and decoded through
 * the property's charset at the end, so multi-byte UTF-8 sequences split
 * across folds still decode correctly.
 * @param value - The raw (unfolded) QP value, fold markers intact.
 * @param charset - CHARSET param value, or null for the default (UTF-8).
 * @returns Decoded text. Unrecognized charset names fall back to UTF-8.
 */
function decodeQuotedPrintable(value: string, charset: string | null): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== '=') {
      if (ch === '\u0000') continue; // fold marker outside a soft break
      if (ch.charCodeAt(0) < 0x80) bytes.push(ch.charCodeAt(0));
      else bytes.push(...Buffer.from(ch, 'utf8')); // raw non-ASCII in a QP body
      continue;
    }
    const a = value[i + 1];
    const b = value[i + 2];
    if (a !== undefined && b !== undefined && /^[0-9a-fA-F]{2}$/.test(a + b)) {
      bytes.push(parseInt(a + b, 16));
      i += 2;
      continue;
    }
    // Not a hex escape: a soft line break (the fold marker follows, or a raw
    // line ending survived) — drop the "=" and keep scanning.
    if (a === '\u0000') i += 1;
  }
  return Buffer.from(bytes).toString(charsetToEncoding(charset));
}

/**
 * Map a vCard CHARSET param onto a Node Buffer encoding. Only the two
 * charsets with real Node support are mapped; anything else (SHIFT_JIS etc.)
 * falls back to UTF-8 rather than crashing — flagged per-property by the
 * caller if fidelity matters.
 * @param charset - CHARSET param as written, or null.
 * @returns A Buffer.toString() encoding name.
 */
function charsetToEncoding(charset: string | null): BufferEncoding {
  const c = (charset ?? '').toLowerCase();
  if (c === 'iso-8859-1' || c === 'latin1') return 'latin1';
  return 'utf8';
}

/**
 * Parse one unfolded property line into name, params, and decoded value.
 * The name/params/value split happens at the FIRST colon — param values never
 * contain raw colons (they'd be QP-encoded or URL-escaped), so this is safe.
 * @param line - One unfolded property line ("NAME;PARAM:VALUE").
 * @returns The parsed property, or null for lines without a colon (skipped
 * rather than fatal — a stray line never loses a whole card).
 */
function parseProperty(line: string): VcfProperty | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const rawValue = line.slice(colon + 1);

  const segments = head.split(';');
  const name = segments[0].trim().toUpperCase();
  if (!name) return null;

  const params: VcfParams = { types: [], encoding: null, charset: null };
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq < 0) {
      // Bare 2.1-style param (e.g. TEL;CELL, PHOTO;JPEG) — a TYPE value.
      const t = seg.trim().toUpperCase();
      if (t) params.types.push(t);
      continue;
    }
    const key = seg.slice(0, eq).trim().toUpperCase();
    const val = seg.slice(eq + 1).trim();
    if (key === 'TYPE') {
      // TYPE may carry a comma-separated list (TYPE=WORK,VOICE).
      params.types.push(
        ...val
          .split(',')
          .map((t) => t.trim().toUpperCase())
          .filter(Boolean),
      );
    } else if (key === 'ENCODING') {
      params.encoding = val.toUpperCase();
    } else if (key === 'CHARSET') {
      params.charset = val || null;
    }
    // Other named params (VERSION etc.) are irrelevant to import — ignored.
  }

  let value = rawValue;
  if (params.encoding === 'QUOTED-PRINTABLE') {
    value = decodeQuotedPrintable(value, params.charset);
  } else if (params.encoding === 'BASE64' || params.encoding === 'B') {
    value = value.replace(/\s+/g, ''); // strip any residual whitespace
  }
  // Fold markers have no meaning outside QP soft-break detection — strip any
  // the QP decoder did not consume (raw text and base64 values).
  value = value.replace(/\u0000/g, '');
  return { name, params, value };
}

/**
 * Parse a whole .vcf file body into cards. Lines outside BEGIN/VCARD…
 * END/VCARD blocks are ignored; an unterminated final card is still returned
 * (tolerant read beats losing data to a truncated export).
 * @param text - Raw file contents (UTF-8).
 * @returns Cards in file order; an empty array for a file with no cards.
 */
export function parseVcfCards(text: string): VcfCard[] {
  const cards: VcfCard[] = [];
  let current: VcfCard | null = null;
  for (const line of unfoldLines(text)) {
    const t = line.trim();
    if (!t) continue;
    if (/^BEGIN:VCARD$/i.test(t)) {
      current = { props: [] };
      continue;
    }
    if (/^END:VCARD$/i.test(t)) {
      if (current) cards.push(current);
      current = null;
      continue;
    }
    if (current) {
      const prop = parseProperty(t);
      if (prop) current.props.push(prop);
    }
  }
  if (current) cards.push(current); // tolerate a missing final END:VCARD
  return cards;
}

/**
 * Unescape vCard text per RFC 2426 §2.4.2: \\n → newline, \\N → newline,
 * \\, → comma, \\; → semicolon, \\\\ → backslash. Single pass, left to right,
 * so an escaped backslash can never be re-interpreted as an escape marker.
 * @param raw - Raw property value (or one structured component).
 * @returns Unescaped display text.
 */
export function unescapeVcfText(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') {
      out += raw[i];
      continue;
    }
    const next = raw[i + 1];
    if (next === 'n' || next === 'N') {
      out += '\n';
      i += 1;
    } else if (next === ',' || next === ';' || next === '\\') {
      out += next;
      i += 1;
    } else {
      out += raw[i]; // lone backslash: keep it literally
    }
  }
  return out;
}

/**
 * Split a structured vCard value (N, ADR, ORG) on its component separators,
 * honoring backslash-escaped semicolons (RFC 2426 §2.4.2), then unescape each
 * component. Empty components are preserved as "" so positional access
 * (N: last,first,middle,prefix,suffix) stays meaningful.
 * @param raw - Raw structured value, escapes intact.
 * @returns Unescaped components in order.
 */
export function splitVcfStructured(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\' && (raw[i + 1] === ';' || raw[i + 1] === '\\' || raw[i + 1] === ',')) {
      current += raw[i] + raw[i + 1]; // keep the escape; unescapeVcfText resolves it
      i += 1;
      continue;
    }
    if (raw[i] === ';') {
      parts.push(current);
      current = '';
      continue;
    }
    current += raw[i];
  }
  parts.push(current);
  return parts.map(unescapeVcfText);
}
