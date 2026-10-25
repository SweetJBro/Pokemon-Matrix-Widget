/* Gen 5 text (Black, White, Black 2, White 2). docs/research/format-gen5.md §9, §20.

   Names are UTF-16LE code units (the games handle UCS-2 only) ending in 0xFFFF; reading also
   stops at 0x0000. Ordinary characters are stored as themselves. The font draws its own glyphs
   for U+2460-U+2487 (Bulbapedia "Character encoding (Generation V-present)", which also settles
   the order the research notes left open: U+247C is the half-width ☂ and U+247D the snowman):
     U+2460-2466  full-width faces          U+246F-2473  ♠ ♣ ♥ ♦ ★ (half width)
     U+2467-2468  × ÷ (half width)          U+2474-2478  ◎ ○ □ △ ◇ (half width)
     U+2469-246B  superscript er, re, r     U+2479-247D  ♪ ☀ ☁ ☂ ☃ (half width)
     U+246C       … (half width)            U+247E-2484  half-width faces
     U+246D-246E  ♂ ♀ (half width)          U+2485-2487  superscript e, PK, MN
   Japanese text uses the ordinary Unicode code points for the full-width forms of those 20
   symbols (U+2642 ♂, U+00D7 ×, ...). decode shows both forms as the same string (the shared GLYPH
   strings from core.js for glyphs Unicode lacks), and encode picks the half-width code unless the
   name is Japanese (wantFullWidth in core.js; opts.fullWidth overrides). This matches how Gen 4's
   two widths map (gen4.js), so a Gen 4 name decoded and re-encoded here lands on the codes Poké
   Transfer uses for the symbols it keeps (it writes "?" for PK, MN, $ and other characters that
   cannot be typed; that rule belongs to the converter). Other code points the font draws
   specially ($ as the Pokédollar sign, the unused duplicates ∧ ∨ ￢ ⇒ ⇔ ∀ ∃ of the faces) are
   stored as themselves, so typing ∀ gives a face in game.

   encode only accepts characters the Black/White font has (Bulbapedia's list: Latin-1 letters,
   kana, KS X 1001 Hangul, the jōyō kanji, some symbols), so a name never shows "?" in game. The
   kanji check accepts the whole CJK block (the exact 1,946-character list is UNVERIFIED here);
   no naming screen offers kanji anyway.

   Padding, from the decompilation (pokebw2 poke_tool.c / str_tool.c): when the game sets a name
   itself it copies text + 0xFFFF and always writes 0xFFFF into the last unit, so a fresh field
   is [text][0xFFFF][0x0000 ...][0xFFFF]; a 10-character nickname is 10 units + one 0xFFFF. The
   naming screen's copy writes text + terminator and leaves later units alone, which is what
   opts.original reproduces. Never treat a missing final 0xFFFF as damage: gifts, starters and
   Poké Transfer leave other bytes there. */
import { GLYPH, FACES, UNKNOWN, checkLang, toBytes, scan, tokenize, encodeField, tryEncode, wantFullWidth } from "./core.js";
import { KSX1001, EXTRA_SYLLABLES } from "./tables/hangul.js";

export { LANGS } from "./core.js";
export const GEN = 5;
export const TERMINATOR = 0xffff;
export const NICKNAME_LENGTH = 22;   // bytes: 11 units, 10 characters
export const OT_LENGTH = 16;         // bytes: 8 units, 7 characters
export const BOX_NAME_LENGTH = 40;   // bytes: 20 units

// The 20 symbols with a half-width glyph code and a full-width (standard Unicode) form.
const PAIRED = [[0x2467, "×"], [0x2468, "÷"], [0x246c, "…"], [0x246d, "♂"], [0x246e, "♀"],
  [0x246f, "♠"], [0x2470, "♣"], [0x2471, "♥"], [0x2472, "♦"], [0x2473, "★"],
  [0x2474, "◎"], [0x2475, "○"], [0x2476, "□"], [0x2477, "△"], [0x2478, "◇"],
  [0x2479, "♪"], [0x247a, "☀"], [0x247b, "☁"], [0x247c, "☂"], [0x247d, "☃"]];

/** Glyph codes U+2460-U+2487 -> display text. */
export const GLYPHS = new Map([
  ...FACES.map((f, i) => [0x2460 + i, f]),
  ...PAIRED,
  [0x2469, GLYPH.SUP_ER], [0x246a, GLYPH.SUP_RE], [0x246b, GLYPH.SUP_R],
  ...FACES.map((f, i) => [0x247e + i, f]),
  [0x2485, GLYPH.SUP_E], [0x2486, GLYPH.PK], [0x2487, GLYPH.MN],
]);
const HALF = new Map(), FULL = new Map();
for (const [code, text] of GLYPHS) if (code >= 0x2467) HALF.set(text, code);
for (const [, text] of PAIRED) FULL.set(text, text.charCodeAt(0));
FACES.forEach((f, i) => FULL.set(f, 0x2460 + i));

/* Code points in the Black/White main font (Bulbapedia's table, 5,064 characters), as ranges.
   Bulbapedia lists Latin-1 as ... U+00BF..U+00FE but counts 76 characters there, one more than
   the list; ÿ (U+00FF, which Gen 4 has at 0x019E) is the missing one. The same page writes the
   Gen 6 Latin-1 row as U+00A0..U+00FE and counts 96, the whole block, so its ranges stop one
   short at U+00FF. */
const FONT = [
  [0x20, 0x7e], 0xa1, [0xa7, 0xa8], [0xaa, 0xab], [0xb0, 0xb1], 0xb4, 0xb6, [0xba, 0xbb], [0xbf, 0xff],
  [0x152, 0x153], [0x15e, 0x15f], [0x435, 0x44f], 0x451,
  0x2010, 0x2015, [0x2018, 0x2019], [0x201c, 0x201e], [0x2020, 0x2021], [0x2025, 0x2026], 0x2030, [0x2032, 0x2033], 0x203b,
  0x2103, 0x2116, 0x2121, 0x212b, [0x2160, 0x2169], [0x2190, 0x2193], 0x21d2, 0x21d4,
  0x2200, [0x2202, 0x2203], 0x2207, 0x2211, 0x221a, [0x221d, 0x2220], 0x2225, [0x2227, 0x2228], [0x222b, 0x222c], 0x222e,
  [0x2234, 0x2235], 0x223d, 0x2252, [0x2260, 0x2261], [0x2266, 0x2267], [0x226a, 0x226b], 0x22a5, 0x22bf,
  0x2312, [0x2460, 0x2487],
  [0x25a0, 0x25a1], [0x25b2, 0x25b3], [0x25bc, 0x25bd], [0x25c6, 0x25c7], 0x25cb, [0x25ce, 0x25cf], 0x25ef,
  [0x2600, 0x2603], [0x2605, 0x2606], 0x2640, 0x2642, 0x2660, 0x2663, [0x2665, 0x2666], 0x266a, 0x266d, 0x266f,
  [0x3000, 0x3003], [0x3005, 0x3015], 0x301d, 0x301f, [0x3041, 0x3093], [0x309b, 0x309e], [0x30a1, 0x30f6], [0x30fb, 0x30fe],
  [0x3131, 0x3132], 0x3134, [0x3137, 0x3139], [0x3141, 0x3143], [0x3145, 0x3157], [0x315b, 0x315c], [0x3160, 0x3161], 0x3163,
  [0x3231, 0x3232], 0x3239, [0x32a4, 0x32a8],
  0x3303, 0x330d, 0x3314, 0x3318, [0x3322, 0x3323], [0x3326, 0x3327], 0x332b, 0x3336, 0x333b, [0x3349, 0x334a], 0x334d,
  0x3351, 0x3357, [0x337b, 0x337e], [0x338e, 0x338f], [0x339c, 0x339e], 0x33a1, 0x33c4, 0x33cd,
  0xff01, [0xff03, 0xff06], [0xff08, 0xff5e], [0xff61, 0xff9f], [0xffe0, 0xffe3], 0xffe5,
].map((r) => (Array.isArray(r) ? r : [r, r]));
const HANGUL = new Set(KSX1001 + EXTRA_SYLLABLES);
/** True when the Black/White font can draw code point cp. */
export function inFont(cp) {
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;   // kanji: approximated, see above
  if (cp >= 0xac00 && cp <= 0xd7af) return HANGUL.has(String.fromCharCode(cp));
  for (const [a, b] of FONT) if (cp >= a && cp <= b) return true;
  return false;
}

const FMT = {
  gen: 5, unit: 2, term: TERMINATOR, stops: new Set([TERMINATOR, 0x0000]), fullNoTerm: false,
  size: () => 2,
  put: (o, at, c) => { o[at] = c & 0xff; o[at + 1] = c >> 8; },
  step: (b, i) => [i + 1 < b.length ? b[i] | (b[i + 1] << 8) : 0x10000 | b[i], i + 1 < b.length ? 2 : 1],
  // Zeros after the terminator and 0xFFFF in the last unit (the game's raw name copy).
  pad: (o, from, n) => { o.fill(0, from, n); if (from <= n - 2) { o[n - 2] = 0xff; o[n - 1] = 0xff; } },
};

function textOf(code, unknown) {
  const g = GLYPHS.get(code);
  if (g) return g;
  // Control codes, surrogates (the games are UCS-2), private use and non-characters.
  if (code < 0x20 || code > 0xffff || (code >= 0xd800 && code <= 0xf8ff) || code >= 0xfffe) return unknown;
  return String.fromCharCode(code);
}
const texts = (sc, opts) => sc.toks.map(({ code }) => textOf(code, opts.unknown ?? UNKNOWN));

/** bytes (UTF-16LE) -> string, up to 0xFFFF or 0x0000. */
export function decode(bytes, lang, opts = {}) {
  checkLang(lang, 5);
  return texts(scan(FMT, toBytes(bytes)), opts).join("");
}

/** string -> Uint8Array(maxBytes). opts: original, trailing, maxChars, fullWidth (see core.js). */
export function encode(str, lang, maxBytes, opts = {}) {
  checkLang(lang, 5);
  const full = wantFullWidth(String(str).normalize("NFC"), lang, opts);
  const lookup = (k) => {
    const g = (full && FULL.get(k)) || HALF.get(k);
    if (g) return g;
    if (k.length !== 1) return undefined;
    const cp = k.charCodeAt(0);
    return inFont(cp) && !(cp >= 0x2460 && cp <= 0x2487) ? cp : undefined;
  };
  return encodeField(FMT, str, maxBytes, opts, (sc) => texts(sc, {}),
    (s, from) => tokenize(s, from, 2, lookup, 5));
}

export function canEncode(str, lang, maxBytes, opts = {}) {
  return tryEncode(() => encode(str, lang, maxBytes ?? 0x200, opts));
}

/** In-game sizes (bytes, terminator included) and character limits (Japanese/Korean 5: UNVERIFIED). */
export function limits(lang) {
  checkLang(lang, 5);
  const asian = lang === "ja" || lang === "ko";
  const f = (bytes, chars) => ({ bytes, chars });
  return { nickname: f(NICKNAME_LENGTH, asian ? 5 : 10), ot: f(OT_LENGTH, asian ? 5 : 7), player: f(OT_LENGTH, asian ? 5 : 7), box: f(BOX_NAME_LENGTH, 8) };
}
