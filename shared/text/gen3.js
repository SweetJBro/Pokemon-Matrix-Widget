/* Gen 3 text (Ruby, Sapphire, Emerald, FireRed, LeafGreen). docs/research/format-gen3.md §10, §17.

   One byte per character, two character sets: the Western set (English, French, German, Italian,
   Spanish games) and the Japanese set. Western games carry both and print a Pokémon's nickname
   and OT with the Japanese set when its language byte is Japanese, so `lang` here is the
   Pokémon's language, not the game's.

   Tables restate pret's charmap.txt (pokeemerald; pokeruby and pokefirered agree on every name
   character) and Bulbapedia's "Character encoding (Generation III)"; scripts/build-text.mjs checks
   them against pret. Rows marked [PKHeX] in the research notes (the Japanese 0xA1-0xF0 symbols and
   full-width Latin) are also on Bulbapedia's Japanese table.
   * Western 0xB1/0xB2 are the double quotes, drawn “ ” in English/Italian/Spanish, „ “ in German
     and « » in French: decode by language, and encode accepts the other languages' quotes too.
   * 0xB4 is both the closing single quote and the apostrophe; it decodes as ' (as Gen 4 and 5
     store it) and encode accepts ’. 0xB7 is the Pokédollar sign; it decodes as $ and accepts ¥.
   * Codes pret leaves undefined (0x0A, 0x18, 0x1F, 0x2F-0x33, 0x37-0x50, ...) print leftover kana
     in Ruby/Sapphire and blanks in FireRed/LeafGreen/Emerald, so they decode to U+FFFD.
   * Japanese 0xF1-0xF6 (Ä Ö Ü ä ö ü) decode but are never written into a Japanese name (Pokémon
     HOME rejects them).

   Terminator 0xFF. A name that fills a 10-byte or 7-byte field has no terminator: PK3 nicknames
   and OT names (and the few other buffers pret declares [POKEMON_NAME_LENGTH] or
   [PLAYER_NAME_LENGTH], with no room for EOS), so "FARFETCH'D" and "BRENDAN" are stored without
   one. Every other size (player name 8, box name 9, mail and record names 8 or 11) keeps its
   terminator, so encode refuses an 8-letter player name rather than write one the game would read
   past. Fresh fields are padded with 0xFF, as the naming screen leaves them (its buffer starts
   filled with 0xFF). Names the game writes itself (a species name as the default nickname) leave
   stack garbage after the 0xFF; opts.original keeps whatever is there. */
import { Table, GLYPH, UNKNOWN, checkLang, toBytes, scan, tokenize, encodeField, tryEncode } from "./core.js";

export const GEN = 3;
export const LANGS = ["ja", "en", "fr", "it", "de", "es"];   // there is no Korean Gen 3 game
export const TERMINATOR = 0xff;
export const NICKNAME_LENGTH = 10;   // bytes in a PK3 (no terminator when full)
export const OT_LENGTH = 7;          // bytes in a PK3 (no terminator when full)
export const PLAYER_NAME_LENGTH = 8; // bytes in the save (7 characters + terminator)
export const BOX_NAME_LENGTH = 9;

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", LOWER = "abcdefghijklmnopqrstuvwxyz";

function western(open, close) {
  const t = new Table();
  t.set(0x00, " ");
  t.run(0x01, "ÀÁÂÇÈÉÊËÌ\0ÎÏÒÓÔŒÙÚÛÑßàá\0çèéêëì\0îïòóôœùúûñºª");
  t.set(0x2c, GLYPH.SUP_ER).set(0x2d, "&").set(0x2e, "+");
  t.set(0x34, "Lv", "d");                 // the level glyph (Lv, Nv, L., N. by language)
  t.set(0x35, "=").set(0x36, ";");
  t.set(0x51, "¿").set(0x52, "¡").set(0x53, GLYPH.PK).set(0x54, GLYPH.MN);
  t.set(0x5a, "Í").set(0x5b, "%").set(0x5c, "(").set(0x5d, ")");
  t.set(0x68, "â").set(0x6f, "í");
  t.run(0x79, "↑↓←→");
  t.set(0x84, GLYPH.SUP_E).set(0x85, "<").set(0x86, ">").set(0xa0, GLYPH.SUP_RE);
  t.run(0xa1, "0123456789!?.-");
  t.set(0xaf, "･").set(0xb0, "…").set(0xb1, open).set(0xb2, close);
  t.run(0xb3, "‘'♂♀");
  t.set(0xb7, "$").set(0xb8, ",").set(0xb9, "×").set(0xba, "/");
  t.run(0xbb, UPPER + LOWER);
  t.set(0xef, "►").set(0xf0, ":");
  t.run(0xf1, "ÄÖÜäöü");
  t.alias("·", 0xaf).alias("‥", 0xb0).alias("⋯", 0xb0).alias("’", 0xb4).alias("¥", 0xb7).alias("▶", 0xef);
  for (const [o, c] of [["“", "”"], ["„", "“"], ["«", "»"]]) { t.alias(o, 0xb1); t.alias(c, 0xb2); }
  return t;
}

function japanese() {
  const t = new Table();
  t.set(0x00, "　");
  t.run(0x01, "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん" +
    "ぁぃぅぇぉゃゅょがぎぐげござじずぜぞだぢづでどばびぶべぼぱぴぷぺぽっ");
  t.run(0x51, "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン" +
    "ァィゥェォャュョガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポッ");
  t.run(0xa1, "０１２３４５６７８９！？。ー・…『』「」♂♀円．×／");
  t.run(0xbb, "ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ");
  t.set(0xef, "►").set(0xf0, "：");
  t.run(0xf1, "ÄÖÜäöü", "d");
  t.alias("‥", 0xb0).alias("⋯", 0xb0).alias("▶", 0xef);
  return t;
}

export const TABLES = { en: western("“", "”"), de: western("„", "“"), fr: western("«", "»"), ja: japanese() };
const tableFor = (lang) => TABLES[lang] ?? TABLES.en;

const FMT = {
  gen: 3, unit: 1, term: TERMINATOR, stops: new Set([TERMINATOR]), fullNoTerm: false,
  size: () => 1,
  put: (o, at, c) => { o[at] = c; },
  step: (b, i) => [b[i], 1],
  pad: (o, from, n) => o.fill(TERMINATOR, from, n),
};
const FULL_FMT = { ...FMT, fullNoTerm: true };   // 10- and 7-byte fields (PK3 nickname and OT)

function texts(t, sc, opts) {
  const unknown = opts.unknown ?? UNKNOWN;
  return sc.toks.map(({ code }) => t.dec.get(code) ?? unknown);
}

/** bytes -> string, up to the 0xFF terminator (or the end of the field). */
export function decode(bytes, lang, opts = {}) {
  checkLang(lang, 3, LANGS);
  const t = tableFor(lang);
  return texts(t, scan(FMT, toBytes(bytes)), opts).join("");
}

/** string -> Uint8Array(maxBytes). See core.js for opts (original, trailing, maxChars). */
export function encode(str, lang, maxBytes, opts = {}) {
  checkLang(lang, 3, LANGS);
  const t = tableFor(lang);
  const fmt = maxBytes === NICKNAME_LENGTH || maxBytes === OT_LENGTH ? FULL_FMT : FMT;
  return encodeField(fmt, str, maxBytes, opts, (sc) => texts(t, sc, {}),
    (s, from) => tokenize(s, from, t.maxKey, (k) => t.enc.get(k), 3));
}

export function canEncode(str, lang, maxBytes, opts = {}) {
  return tryEncode(() => encode(str, lang, maxBytes ?? 0x100, opts));
}

/** In-game sizes (bytes, terminator included where there is room for one) and character limits. */
export function limits(lang) {
  checkLang(lang, 3, LANGS);
  const asian = lang === "ja" || lang === "ko";
  const f = (bytes, chars) => ({ bytes, chars });
  return {
    nickname: f(NICKNAME_LENGTH, asian ? 5 : 10),
    ot: f(OT_LENGTH, asian ? 5 : 7),
    player: f(PLAYER_NAME_LENGTH, asian ? 5 : 7),
    box: f(BOX_NAME_LENGTH, 8),
  };
}
