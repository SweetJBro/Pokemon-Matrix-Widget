/* Shared machinery for the text codecs in shared/text/genN.js. No dependencies beyond ../bytes.js.

   Every generation stores names in fixed-size fields of game-specific character codes: one byte
   (Gen 1-3), one or two bytes (Korean Gold/Silver), or a little-endian u16 (the Gen 4 table and
   Gen 5's UTF-16). The codecs are table driven:

   * decode turns the codes before the terminator into a display string. A code the table does
     not know becomes U+FFFD (or opts.unknown), so one stray byte never hides the rest of a name.
   * encode normalises the string to NFC, splits it greedily against the table (longest match
     first, so a multi-letter glyph such as the PK glyph wins over its letters), then writes the
     codes, the terminator and the generation's padding into a buffer of exactly maxBytes.
   * Lossless rewrites: pass the field as it is in the save as opts.original. encode then reuses
     the original codes for the unchanged start of the name (so a duplicate glyph, such as Gen 1's
     two different full stops, keeps the code it had) and keeps the original bytes after the new
     terminator, which is what the games' own rename paths do (they copy text + terminator and
     leave the rest of the buffer alone). So encode(decode(f), lang, f.length, { original: f })
     returns f byte for byte, garbage after the terminator included. opts.trailing = "pad" pads
     freshly instead.

   Glyphs that Unicode lacks (the PK/MN glyph, superscripts, the faces of the Gen 4/5 fonts) are
   rendered as the same strings in every generation (GLYPH below), so names decoded from one
   generation encode into another, and so they compare equal across generations. */
import { FormatError } from "../bytes.js";

export const LANGS = ["ja", "en", "fr", "it", "de", "es", "ko"];
export const UNKNOWN = "\uFFFD";

export const GLYPH = {
  PK: "ᴾₖ", MN: "ᴹₙ",                       // the two halves of the "PKMN" glyph pair
  SUP_ER: "ᵉʳ", SUP_RE: "ʳᵉ", SUP_R: "ʳ", SUP_E: "ᵉ",   // French ordinals (1er, 1re, ...)
  FACE_NEUTRAL: "😑", FACE_HAPPY: "☺", FACE_SAD: "☹", FACE_ANGRY: "😠",
  ARROW_UP: "⤴", ARROW_DOWN: "⤵", ZZZ: "💤",   // Gen 4/5 emoticon glyphs
};
/** The seven Gen 4/5 emoticon glyphs in code order. */
export const FACES = [GLYPH.FACE_NEUTRAL, GLYPH.FACE_HAPPY, GLYPH.FACE_SAD, GLYPH.FACE_ANGRY,
  GLYPH.ARROW_UP, GLYPH.ARROW_DOWN, GLYPH.ZZZ];

/** Language check shared by every codec ("en" | "ja" | "fr" | "de" | "it" | "es" | "ko"). */
export function checkLang(lang, gen, allowed = LANGS) {
  if (allowed.includes(lang)) return lang;
  throw new FormatError(`Unknown language "${lang}" for Generation ${gen} text.`, { code: "text-lang", lang });
}

/** A code table: dec maps code -> text, enc maps text -> code (the first encodable entry wins). */
export class Table {
  constructor() { this.dec = new Map(); this.enc = new Map(); this.maxKey = 1; }

  /** Map code -> text. flags "d" = decode only (never produced by encode). */
  set(code, text, flags = "") {
    this.dec.set(code, text);
    if (!flags.includes("d")) this.alias(text, code);
    return this;
  }
  /** Extra spelling accepted by encode (never produced by decode). Existing keys win. */
  alias(text, code) {
    if (!this.enc.has(text)) this.enc.set(text, code);
    if (text.length > this.maxKey) this.maxKey = text.length;
    return this;
  }
  /** Force text -> code for encode, replacing any earlier choice. */
  prefer(text, code) { this.enc.delete(text); return this.alias(text, code); }
  /** Consecutive codes from start, one per code point of s; "\0" leaves a code unassigned. */
  run(start, s, flags = "") {
    let c = start;
    for (const ch of s) { if (ch !== "\0") this.set(c, ch, flags); c++; }
    return this;
  }
  /** Like run(), but s is a space-separated list of tokens (for multi-letter glyphs); "_" skips. */
  words(start, s, flags = "") {
    let c = start;
    for (const w of s.split(" ")) { if (w !== "_") this.set(c, w, flags); c++; }
    return this;
  }
  clone() {
    const t = new Table();
    t.dec = new Map(this.dec); t.enc = new Map(this.enc); t.maxKey = this.maxKey;
    return t;
  }
}

/** Uint8Array view of a field: any typed array or DataView, an ArrayBuffer, or an array of byte
    values (Fields keep raw bytes as plain arrays). Anything else, a string included, is a TypeError
    rather than a silently empty or garbled name. */
export function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Object.prototype.toString.call(bytes) === "[object ArrayBuffer]") return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  throw new TypeError(`expected the field's bytes (Uint8Array, ArrayBuffer or array), got ${typeof bytes}`);
}

/** Split a field into codes until a stop code. fmt.step(bytes, i) -> [code, length]. */
export function scan(fmt, bytes) {
  const toks = [];
  let i = 0;
  while (i < bytes.length) {
    const [code, len] = fmt.step(bytes, i);
    if (fmt.stops.has(code)) return { toks, end: i, stop: code };
    toks.push({ at: i, len, code });
    i += len;
  }
  return { toks, end: bytes.length, stop: null };
}

function codePointAt(s, i) { return String.fromCodePoint(s.codePointAt(i)); }

export function unencodable(gen, str, i) {
  const ch = codePointAt(str, i);
  return new FormatError(`"${ch}" cannot be written in a Generation ${gen} name.`,
    { code: "text-unencodable", char: ch, index: i });
}

/** Greedy longest-match split of str (from index `from`) into codes; lookup(key, i) -> code. */
export function tokenize(str, from, maxKey, lookup, gen) {
  const codes = [];
  for (let i = from; i < str.length;) {
    let n = Math.min(maxKey, str.length - i), code;
    for (; n > 0; n--) { code = lookup(str.slice(i, i + n), i); if (code !== undefined) break; }
    if (n === 0) throw unencodable(gen, str, i);
    codes.push(code);
    i += n;
  }
  return codes;
}

/** Copy of `original` resized to maxBytes; bytes past its end get the fresh padding. */
function fitOriginal(fmt, original, maxBytes) {
  const src = toBytes(original), out = new Uint8Array(maxBytes);
  out.set(src.subarray(0, maxBytes));
  if (src.length < maxBytes) fmt.pad(out, src.length - (src.length % fmt.unit), maxBytes);
  return out;
}

/* The shared encoder. fmt describes the generation's field format:
     gen, unit (1 or 2), term (terminator code), stops (codes that end a name when reading),
     fullNoTerm (true when a name that exactly fills this field has no terminator: Gen 3's PK3
     nickname and OT fields only), size(code) -> bytes, put(out, at, code),
     step(bytes, i) -> [code, len], pad(out, from, maxBytes) (fresh padding after the terminator).
   texts(scanResult) -> array of token texts (what decode prints for each code, default opts).
   toCodes(str, from) -> codes for str[from..] (throws on an unencodable character). */
export function encodeField(fmt, str, maxBytes, opts, texts, toCodes) {
  if (typeof str !== "string") throw new TypeError(`the name must be a string, got ${typeof str}`);
  if (!Number.isInteger(maxBytes) || maxBytes < fmt.unit || maxBytes % fmt.unit)
    throw new TypeError(`maxBytes must be a positive multiple of ${fmt.unit}, got ${maxBytes}`);
  const codes = [];
  let from = 0, orig = null, origScan = null, reusedAll = false, t = null;
  if (opts.original != null) {
    orig = fitOriginal(fmt, opts.original, maxBytes);
    origScan = scan(fmt, orig);
    t = texts(origScan, orig);
  }
  // NFC, so that an é typed as e + U+0301 finds its code. The original's own text is taken as it
  // is: NFC would turn a stored U+212B Å (in the Gen 5 font) into U+00C5 and break the round trip.
  if (!t || t.join("") !== str) str = str.normalize("NFC");
  if (t) {
    let k = 0;
    for (; k < origScan.toks.length; k++) {
      if (!t[k] || !str.startsWith(t[k], from)) break;
      codes.push(origScan.toks[k].code);
      from += t[k].length;
    }
    reusedAll = k === origScan.toks.length && from === str.length;
  }
  for (const c of toCodes(str, from)) codes.push(c);

  if (opts.maxChars != null && codes.length > opts.maxChars) throw tooLong(fmt.gen, str, opts.maxChars);
  let used = 0;
  for (const c of codes) used += fmt.size(c);
  const unterminatedOriginal = reusedAll && origScan.stop === null && used === maxBytes;
  const needTerm = !(fmt.fullNoTerm && used === maxBytes) && !unterminatedOriginal;
  if (used + (needTerm ? fmt.unit : 0) > maxBytes) {
    // Say how many characters fit, when they all take the same room (they do except in Korean).
    const per = fmt.size(codes[0]);
    const room = codes.every((c) => fmt.size(c) === per) ? Math.floor((maxBytes - (fmt.fullNoTerm ? 0 : fmt.unit)) / per) : null;
    throw tooLong(fmt.gen, str, room, maxBytes);
  }

  const keep = orig !== null && opts.trailing !== "pad";
  const out = keep ? orig : new Uint8Array(maxBytes);
  let at = 0;
  for (const c of codes) { fmt.put(out, at, c); at += fmt.size(c); }
  if (needTerm) {
    // Keep the original's own stop code when the name ends where it ended before.
    if (!(keep && origScan.stop !== null && at === origScan.end)) fmt.put(out, at, fmt.term);
    at += fmt.unit;
  }
  if (!keep) fmt.pad(out, at, maxBytes);
  return out;
}

function tooLong(gen, str, chars, bytes) {
  const limit = chars != null ? `at most ${chars} characters` : `${bytes} bytes`;
  return new FormatError(`"${str}" is too long for this Generation ${gen} name (${limit}).`,
    { code: "text-too-long", maxChars: chars, maxBytes: bytes });
}

/** true when encode() would succeed; other errors (bad arguments) still throw. */
export function tryEncode(fn) {
  try { fn(); return true; } catch (e) { if (e instanceof FormatError) return false; throw e; }
}

/* Gen 4/5 have a half-width and a full-width form of 27 symbols (♂ ♀ … × ÷ ♠ ♣ ♥ ♦ ★ ◎ ○ □ △ ◇
   ♪ ☀ ☁ ☂ ☃ and the seven faces) that Unicode cannot tell apart; both decode to the same string.
   Japanese text uses the full-width forms, everything else the half-width ones (PKHeX writes
   Korean half width too). When writing we use full width when the language is Japanese and the
   name has no half-width letters, digits or punctuation (Latin, ASCII, half-width kana). The
   space, × and ÷ count for neither width: decode gives U+00D7/U+00F7 for both widths of × and ÷,
   so "ピカ×" stays full width. opts.fullWidth overrides the choice. */
export function wantFullWidth(str, lang, opts) {
  if (opts.fullWidth != null) return !!opts.fullWidth;
  if (lang !== "ja") return false;
  return !/[\u0021-\u00d6\u00d8-\u00f6\u00f8-\u024f\uff61-\uff9f]/.test(str);
}
