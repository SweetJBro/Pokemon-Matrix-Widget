/* Gen 4 text (Diamond, Pearl, Platinum, HeartGold, SoulSilver). docs/research/format-gen4.md §13, §22.

   One table of little-endian u16 codes for every language:
     0x0001-0x0120  full-width set used by Japanese text (kana, ０-９ Ａ-Ｚ, symbols)
     0x0121-0x01EC  half-width set used by Western and Korean text (Latin, accents, symbols)
     0x0401-0x0D65  Korean: the 2,350 KS X 1001 syllables in order, 33 jamo, 5 extra syllables
   Terminator 0xFFFF; reading also stops at 0x0000, as PKHeX does.

   Sources: pret's tools/msgenc/charmap.txt (pokeplatinum) for the code order, Bulbapedia's
   "Character encoding (Generation IV)" for the glyphs, both checked by scripts/build-text.mjs.
   Where pret writes stand-ins (㊚ ⊗ ♤ ☼ ¹ ₧ ...), we follow Bulbapedia (PRET_DIFFS lists them),
   which agrees with PKHeX's table, built against the retail games, wherever PKHeX uses an
   ordinary character; for the half-width symbols PKHeX stores the Gen 5 glyph codes instead
   (U+246D for ♂, ...), and gen5.js maps those to the same strings we decode here. Korean follows
   PKHeX and Bulbapedia (0x0400 unassigned, 0x0401 = 가, i.e. the KS X 1001 order); pret is one
   code lower for 0x0400-0x040F (UNVERIFIED without a Korean save, but two sources against one).

   27 symbols exist in both sets (♂ ♀ … × ÷ ♠ ♣ ♥ ♦ ★ ◎ ○ □ △ ◇ ♪ ☀ ☁ ☂ ☃ and seven faces) and
   decode to the same string; encode picks the full-width code for Japanese names and the
   half-width one otherwise (see wantFullWidth in core.js; opts.fullWidth overrides). So Western
   "NIDORAN♂" ends in 0x01BB and Japanese "ニドラン♂" in 0x00EE. Korean Diamond/Pearl/Platinum
   give un-nicknamed Nidoran full-width signs (PKHeX CheckKoreanNidoranDPPt); opts.original keeps
   those. Poké Transfer turns most characters that cannot be typed into "?" (Bulbapedia), which
   is the converter's business, not this codec's.

   The fonts differ by game, not by the Pokémon's language (Bulbapedia): only the Korean games
   draw Hangul (the others print "?"), and the codes from 0x01E0 on were added after Japanese
   Diamond/Pearl (PK MN and the narrow spaces in Western DP, ° in European DP, the underscores in
   Platinum, the dot leaders in Western and Korean HGSS); games without them print nothing.
   encode does not know the target game, so it accepts all of them for every language; a caller
   writing a name into a particular save checks that game itself.

   Fresh fields are [text][0xFFFF][0x0000 ...]: what a freshly created Pokémon holds (its
   structure starts zeroed) and what PKHeX writes. Renaming in game copies text + terminator and
   leaves the rest (String_ToChars in pret), which is what opts.original reproduces. */
import { Table, GLYPH, FACES, UNKNOWN, checkLang, toBytes, scan, tokenize, encodeField, tryEncode, wantFullWidth } from "./core.js";
import { GEN4_KOREAN } from "./tables/hangul.js";

export { LANGS } from "./core.js";
export const GEN = 4;
export const TERMINATOR = 0xffff;
export const NICKNAME_LENGTH = 22;   // bytes: u16[11] = 10 characters + terminator
export const OT_LENGTH = 16;         // bytes: u16[8] = 7 characters + terminator
export const BOX_NAME_LENGTH = 40;   // bytes: u16[20], 8 characters allowed

const range = (from, to, skip = []) => {
  let s = "";
  for (let c = from; c <= to; c++) if (!skip.includes(c)) s += String.fromCharCode(c);
  return s;
};
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", LOWER = "abcdefghijklmnopqrstuvwxyz";

function build() {
  const t = new Table();
  t.set(0x0001, "　");
  t.run(0x0002, range(0x3041, 0x3093, [0x308e, 0x3090, 0x3091]));   // ぁ..ん without ゎ ゐ ゑ
  t.run(0x0052, range(0x30a1, 0x30f3, [0x30ee, 0x30f0, 0x30f1]));   // ァ..ン without ヮ ヰ ヱ
  t.run(0x00a2, range(0xff10, 0xff19) + range(0xff21, 0xff3a) + range(0xff41, 0xff5a));   // ０-９ Ａ-Ｚ ａ-ｚ
  t.run(0x00e1, "！？、。…・／「」『』（）♂♀＋ー×÷＝～：；．，♠♣♥♦★◎○□△◇＠♪％☀☁☂☃");
  FACES.forEach((f, i) => t.set(0x010b + i, f));
  t.set(0x0112, "円");
  t.run(0x0113, "♈♉♊♋♌♍♎♏");                     // Bag pocket icons (stand-ins, as pret and PKHeX)
  t.run(0x011b, "←↑↓→►");
  t.set(0x0120, "＆");
  t.run(0x0121, "0123456789" + UPPER + LOWER);
  t.run(0x015f, range(0x00c0, 0x00ff));            // À..ÿ, with × at 0x0176 and ÷ at 0x0196
  t.run(0x019f, "ŒœŞşªº");
  t.words(0x01a5, `${GLYPH.SUP_ER} ${GLYPH.SUP_RE} ${GLYPH.SUP_R}`);
  t.run(0x01a8, "$¡¿!?,.…･/‘'“”„«»()♂♀+-*#=&~:;♠♣♥♦★◎○□△◇@♪%☀☁☂☃");
  FACES.forEach((f, i) => t.set(0x01d7 + i, f));
  t.set(0x01de, " ").set(0x01df, GLYPH.SUP_E).set(0x01e0, GLYPH.PK).set(0x01e1, GLYPH.MN);
  for (let c = 0x01e2; c <= 0x01e7; c++) t.set(c, "\u2009", "d");   // narrow spaces of several widths
  t.run(0x01e8, "°_＿․‥");
  let k = 0x0400;
  for (const ch of GEN4_KOREAN) { if (ch !== "\0") t.set(k, ch); k++; }
  // Spellings other sources use for the same codes.
  t.alias("’", 0x01b3).alias("·", 0x01b0).alias("《", 0x01b7).alias("》", 0x01b8).alias("▶", 0x011f)
    .alias("¥", 0x0112).alias("－", 0x00f1).alias("⋯", 0x00e5).alias("㊚", 0x00ee).alias("㊛", 0x00ef);

  // Symbols with a full-width and a half-width code: encode defaults to half width.
  const wide = new Map(), seen = new Map();
  for (const [code, text] of t.dec) {
    if (!t.enc.has(text)) continue;   // decode-only
    if (seen.has(text)) { wide.set(text, seen.get(text)); t.prefer(text, code); } else seen.set(text, code);
  }
  if (wide.size !== 27) throw new Error("gen4: expected 27 two-width symbols, found " + wide.size);
  return { t, wide };
}

const { t: TABLE_, wide: WIDE } = build();
export const TABLE = TABLE_;
/** Symbols with two codes: text -> full-width code (TABLE.enc holds the half-width one). */
export const FULL_WIDTH = WIDE;
/** Codes where we deliberately differ from pret's charmap (we follow Bulbapedia and PKHeX). */
export const PRET_DIFFS = [0x00e5, 0x00ee, 0x00ef, 0x00f1, 0x00f2, 0x00f3, 0x00f5, 0x00fa, 0x00fb, 0x00fc, 0x00fd, 0x00fe,
  0x0105, 0x0107, 0x0108, 0x0109, 0x010a, 0x010b, 0x010c, 0x010d, 0x010e, 0x010f, 0x0110, 0x0111, 0x0112, 0x011f,
  0x01a5, 0x01a6, 0x01a7, 0x01b0, 0x01b3, 0x01b7, 0x01b8, 0x01cb, 0x01cc, 0x01cd, 0x01ce, 0x01cf,
  0x01d7, 0x01d8, 0x01d9, 0x01da, 0x01db, 0x01dc, 0x01dd, 0x01df, 0x01e0, 0x01e1];

const FMT = {
  gen: 4, unit: 2, term: TERMINATOR, stops: new Set([TERMINATOR, 0x0000]), fullNoTerm: false,
  size: () => 2,
  put: (o, at, c) => { o[at] = c & 0xff; o[at + 1] = c >> 8; },
  step: (b, i) => [i + 1 < b.length ? b[i] | (b[i + 1] << 8) : 0x10000 | b[i], i + 1 < b.length ? 2 : 1],
  pad: (o, from, n) => o.fill(0, from, n),
};

function texts(sc, opts) {
  const unknown = opts.unknown ?? UNKNOWN;
  return sc.toks.map(({ code }) => TABLE.dec.get(code) ?? unknown);
}

/** bytes (u16 LE codes) -> string, up to 0xFFFF or 0x0000. */
export function decode(bytes, lang, opts = {}) {
  checkLang(lang, 4);
  return texts(scan(FMT, toBytes(bytes)), opts).join("");
}

/** string -> Uint8Array(maxBytes). opts: original, trailing, maxChars, fullWidth (see core.js). */
export function encode(str, lang, maxBytes, opts = {}) {
  checkLang(lang, 4);
  const full = wantFullWidth(String(str).normalize("NFC"), lang, opts);
  const lookup = full ? (k) => WIDE.get(k) ?? TABLE.enc.get(k) : (k) => TABLE.enc.get(k);
  return encodeField(FMT, str, maxBytes, opts, (sc) => texts(sc, {}),
    (s, from) => tokenize(s, from, TABLE.maxKey, lookup, 4));
}

export function canEncode(str, lang, maxBytes, opts = {}) {
  return tryEncode(() => encode(str, lang, maxBytes ?? 0x200, opts));
}

/** In-game sizes (bytes, terminator included) and character limits. */
export function limits(lang) {
  checkLang(lang, 4);
  const asian = lang === "ja" || lang === "ko";   // Korean limits UNVERIFIED
  const f = (bytes, chars) => ({ bytes, chars });
  return { nickname: f(NICKNAME_LENGTH, asian ? 5 : 10), ot: f(OT_LENGTH, asian ? 5 : 7), player: f(OT_LENGTH, asian ? 5 : 7), box: f(BOX_NAME_LENGTH, 8) };
}
