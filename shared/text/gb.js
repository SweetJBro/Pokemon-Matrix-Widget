/* Gen 1 and Gen 2 text (Red/Blue/Yellow, Gold/Silver/Crystal), shared by gen1.js and gen2.js.
   See docs/research/format-gen1-gen2.md §10 and §16.

   The tables restate pret's constants/charmap.asm (pokered, pokecrystal) and Bulbapedia's
   "Character encoding (Generation I/II)" and "Korean character encoding (Generation II)" pages;
   scripts/build-text.mjs checks them against pret. Only the codes that can appear in names are
   mapped (0x7F-0xFF, plus the dakuten kana below 0x50 in Japanese); anything else decodes to
   U+FFFD.

   * Western: A-Z a-z ( ) : ; [ ] ' - ? ! . , / × ♂ ♀ and the digits sit at the same codes in
     every Western language and in both generations. 0xBA-0xDF hold accented letters and
     apostrophe ligatures and differ between English, French/German and Italian/Spanish, and
     between the generations (Gen 2 English adds Ä Ö Ü ä ö ü; é moved from 0xBA to 0xEA).
     Gen 2 French/German/Italian/Spanish keep their Gen 1 é (0xBC) and Italian/Spanish their &
     (0xD7), and add a second copy at English's 0xEA/0xE9. Encode writes the Gen 1 code: it is
     the one a Gen 1 Pokémon brings, the one PKHeX writes, and the only one that still reads
     correctly after a Time Capsule trade back to Gen 1 (0xE9-0xEB are leftover kana there).
   * Japanese: kana, with the dakuten/handakuten forms below 0x50. The font has one glyph for
     へ/ヘ, り/リ, べ/ベ and ぺ/ペ, so those four codes decode to katakana when the nearest
     unambiguous kana is katakana (or there is none) and to hiragana otherwise; encode takes both.
   * Korean (Gold/Silver only): a lead byte 0x01-0x0B and a trail byte give Hangul syllables,
     jamo, some punctuation and digits. The games write pairs for everything the player types
     (the space is 0B FF), so encode prefers a pair; Latin letters keep their English bytes.

   Terminator 0x50; reading also stops at 0x00 (a control code that ends text; PKHeX does the
   same). Fresh fields are padded with 0x50 after the terminator, as PKHeX writes them. The games'
   naming screen types into a scratch buffer and copies all 11 bytes of it (pokered
   DisplayNamingScreen, then CopyData), so a renamed Pokémon can carry leftover bytes after its
   0x50: pass opts.original to keep the ones it has. Poké Transporter's nickname test looks only
   at the bytes up to the terminator (PKHeX models it as IsNicknamedBank), so leftovers never turn
   a species name into a nickname.

   0x5D is the <TRAINER> control code, the OT of Gen 1 in-game trades. It decodes to the word the
   game prints in that language ("TRAINER", "DRESSEUR", ...; opts.trainer overrides it); typing
   that word encodes letters, so only opts.original keeps the code.
   Apostrophe ligatures ('d, 's, c', ...) decode to their letters but are written only with
   opts.ligatures (Gen 2 box names offer them; names spell FARFETCH'D with ' and D). */
import { Table, GLYPH, UNKNOWN, checkLang, toBytes, scan, tokenize, encodeField, tryEncode } from "./core.js";
import { KO2_PAGES } from "./tables/ko2.js";

export const TERMINATOR = 0x50;
export const TRAINER_CODE = 0x5d;
const STOPS = new Set([0x50, 0x00]);

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", LOWER = "abcdefghijklmnopqrstuvwxyz";

function ligatures(t, start, words) {
  let c = start;
  for (const w of words.split(" ")) { if (w !== "_") { t.set(c, w, "d"); t.lig.set(w, c); } c++; }
}

function western(gen, group) {
  const t = new Table();
  t.lig = new Map();
  t.set(0x7f, " ");
  t.run(0x80, UPPER + "():;[]" + LOWER);
  t.set(0xe0, "'").set(0xe1, GLYPH.PK).set(0xe2, GLYPH.MN).set(0xe3, "-");
  t.run(0xe6, "?!.");
  t.run(0xec, "▷▶▼♂");
  t.set(0xf0, "$");                       // the Pokédollar sign (pret: ¥)
  // 0xF2 is a second full stop ("decimal point"). Species names (MR.MIME) use 0xE8, and so does
  // encode; the Gen 1 naming screen types 0xF2. Both look the same in every game.
  t.set(0xf1, "×").set(0xf2, ".", "d");
  t.run(0xf3, "/,♀0123456789");
  t.alias("’", 0xe0).alias("¥", 0xf0);
  if (group === "en") {
    if (gen === 1) {
      t.set(0xba, "é");
      ligatures(t, 0xbb, "'d 'l 's 't 'v");
      ligatures(t, 0xe4, "'r 'm");
    } else {
      t.run(0xc0, "ÄÖÜäöü");
      ligatures(t, 0xd0, "'d 'l 'm 'r 's 't 'v");
      t.set(0xdf, "←").set(0xe9, "&").set(0xea, "é").set(0xeb, "→");   // arrows: Crystal only
    }
  } else if (group === "frde") {
    t.run(0xba, "àèéùßç");
    t.run(0xc0, "ÄÖÜäöüëïâôûêî");
    ligatures(t, 0xd4, "c' d' j' l' m' n' p' s' 's t' u' y'");
    t.set(0xe4, "+");
    if (gen === 2) t.set(0xcf, "←").set(0xe9, "&").set(0xea, "é").set(0xeb, "→");   // é stays 0xBC
  } else {
    t.run(0xba, "àèéùÀÁ");
    t.run(0xc0, "ÄÖÜäöüÈÉÌÍÑÒÓÙÚá");
    t.run(0xd0, "ìíñòóúº&");
    ligatures(t, 0xd8, "'d 'l 'm 'r 's 't 'v");
    t.run(0xe4, "¿¡");
    if (gen === 2) t.set(0xdf, "←").set(0xe9, "&").set(0xea, "é").set(0xeb, "→");   // & stays 0xD7, é 0xBC
  }
  if (gen === 1) t.run(0xe9, "ァゥェ", "d");  // leftover katakana in the Western Gen 1 font
  return t;
}

// The shared glyphs: code -> katakana reading (the table's own text is the hiragana one).
const AMBIGUOUS = new Map([[0xcd, "ヘ"], [0xd8, "リ"], [0x3d, "ベ"], [0x47, "ペ"]]);

function japanese() {
  const t = new Table();
  t.lig = new Map();
  t.set(0x02, "ヴ", "d");                 // Bulbapedia: ウ with dakuten; no naming screen makes it
  t.run(0x05, "ガギグゲゴザジズゼゾダヂヅデド");
  t.run(0x19, "バビブボ");
  t.run(0x26, "がぎぐげござじずぜぞだぢづでど");
  t.run(0x3a, "ばびぶべぼ");
  t.run(0x40, "パピプポぱぴぷぺぽ");
  t.run(0x6e, "ぃぅ", "d").run(0x76, "ぁぇぉ", "d");   // tiles that other screens overwrite
  t.run(0x70, "「」『』・…", "d");
  t.set(0x7f, "　");
  t.run(0x80, "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフホマミムメモヤユヨラルレロワヲンッャュョィ");
  t.run(0xb1, "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをんっゃゅょ");
  t.run(0xe3, "ー゜゛？！。ァゥェ▷▶▼♂円×．／ォ♀０１２３４５６７８９");
  for (const [code, kata] of AMBIGUOUS) t.alias(kata, code);
  t.alias("ﾟ", 0xe4).alias("ﾞ", 0xe5);
  return t;
}

function korean() {
  const t = new Table();
  t.lig = new Map();
  // Pairs first: for characters that also have a single byte, the pair wins.
  for (let lead = 1; lead <= 0x0b; lead++) {
    let trail = 0;
    for (const ch of KO2_PAGES[lead]) {
      if (ch !== "\0") t.set((lead << 8) | trail, ch, lead === 0x0b && (trail === 0x3e || trail === 0x3f) ? "d" : "");
      trail++;
    }
  }
  t.alias("　", 0x0bff);
  t.set(0x7f, " ");
  t.run(0x80, UPPER + "():;[]" + LOWER);
  t.run(0xc0, "ÄÖÜäöü");
  ligatures(t, 0xd0, "'d 'l 'm 'r 's 't 'v");
  t.set(0xe0, "'").set(0xe1, GLYPH.PK).set(0xe2, GLYPH.MN).set(0xe3, "-");
  t.run(0xe6, "?!.&é");
  t.run(0xec, "▷▶▼♂");
  t.set(0xf0, "원", "d");                  // the won sign, a one-tile 원
  t.set(0xf1, "×").set(0xf2, ".", "d");
  t.run(0xf3, "/,♀0123456789");
  t.set(0x5d, "?", "d");                   // <TRAINER> is not valid in Korean names; the game shows "?"
  t.alias("’", 0xe0);
  return t;
}

export const TABLES = {
  1: { en: western(1, "en"), frde: western(1, "frde"), ites: western(1, "ites"), ja: japanese() },
  2: { en: western(2, "en"), frde: western(2, "frde"), ites: western(2, "ites"), ja: null, ko: korean() },
};
TABLES[2].ja = TABLES[1].ja;   // one Japanese table for both generations

const TRAINER_WORD = {
  1: { en: "TRAINER", fr: "DRES.", de: "TRAINER", it: "ALLEN.", es: "ENTREN.", ja: "トレーナー" },
  2: { en: "TRAINER", fr: "DRESSEUR", de: "TRAINER", it: "ALLEN.", es: "ENTREN.", ja: "トレーナー" },
};
const GROUP = { en: "en", fr: "frde", de: "frde", it: "ites", es: "ites", ja: "ja", ko: "ko" };

const BYTE_FMT = (gen) => ({
  gen, unit: 1, term: TERMINATOR, stops: STOPS, fullNoTerm: false,
  size: () => 1,
  put: (o, at, c) => { o[at] = c; },
  step: (b, i) => [b[i], 1],
  pad: (o, from, n) => o.fill(TERMINATOR, from, n),
});
const KO_FMT = {
  ...BYTE_FMT(2),
  size: (c) => (c > 0xff && c < 0x10000 ? 2 : 1),
  put: (o, at, c) => { if (c > 0xff && c < 0x10000) { o[at] = c >> 8; o[at + 1] = c & 0xff; } else o[at] = c & 0xff; },
  // A lone lead byte at the end of the field is an unknown one-byte code.
  step: (b, i) => (b[i] >= 0x01 && b[i] <= 0x0b ? (i + 1 < b.length ? [(b[i] << 8) | b[i + 1], 2] : [0x10000 | b[i], 1]) : [b[i], 1]),
};

/** Korean Gen 1 Pokémon do not exist, but a Korean Gold/Silver Pokémon can be sent back through
    the Time Capsule, so Gen 1 with "ko" reads and writes the Korean encoding. */
function codec(gen, lang) {
  checkLang(lang, gen);
  const group = GROUP[lang];
  const table = group === "ko" ? TABLES[2].ko : TABLES[gen][group];
  return { gen, lang, table, fmt: group === "ko" ? { ...KO_FMT, gen } : BYTE_FMT(gen), trainer: TRAINER_WORD[gen][lang] };
}

const isHira = (s) => /^[\u3041-\u309f]/.test(s), isKata = (s) => /^[\u30a0-\u30ff]/.test(s);

function texts(k, sc, opts) {
  const unknown = opts.unknown ?? UNKNOWN;
  const out = sc.toks.map(({ code }) => {
    if (code === TRAINER_CODE && k.trainer) return opts.trainer ?? k.trainer;
    return k.table.dec.get(code) ?? unknown;
  });
  if (k.lang === "ja") {
    // Resolve the shared glyphs from the nearest unambiguous kana, looking left first.
    const script = (i, d) => {
      for (let j = i + d; j >= 0 && j < out.length; j += d) {
        if (AMBIGUOUS.has(sc.toks[j].code)) continue;
        if (isKata(out[j])) return "kata";
        if (isHira(out[j])) return "hira";
      }
      return null;
    };
    sc.toks.forEach(({ code }, i) => {
      if (!AMBIGUOUS.has(code)) return;
      const s = script(i, -1) ?? script(i, +1) ?? "kata";
      if (s === "kata") out[i] = AMBIGUOUS.get(code);
    });
  }
  return out;
}

export function decode(gen, bytes, lang, opts = {}) {
  const k = codec(gen, lang);
  return texts(k, scan(k.fmt, toBytes(bytes)), opts).join("");
}

export function encode(gen, str, lang, maxBytes, opts = {}) {
  const k = codec(gen, lang), t = k.table;
  const lookup = opts.ligatures ? (key) => t.lig.get(key) ?? t.enc.get(key) : (key) => t.enc.get(key);
  const maxKey = Math.max(t.maxKey, 2);
  return encodeField(k.fmt, str, maxBytes, opts, (sc) => texts(k, sc, {}),
    (s, from) => tokenize(s, from, maxKey, lookup, gen));
}

export function canEncode(gen, str, lang, maxBytes, opts = {}) {
  return tryEncode(() => encode(gen, str, lang, maxBytes ?? 0x100, opts));
}

/** In-game field sizes (bytes, including the terminator) and character limits. */
export function limits(gen, lang) {
  checkLang(lang, gen);
  const f = (bytes, chars) => ({ bytes, chars });
  if (lang === "ja") return { nickname: f(6, 5), ot: f(6, 5), player: f(6, 5), rival: f(6, 5), ...(gen === 2 ? { box: f(9, 8) } : {}) };
  if (lang === "ko") return { nickname: f(11, 5), ot: f(11, 5), player: f(11, 5), rival: f(11, 5), ...(gen === 2 ? { box: f(17, 8) } : {}) };
  return { nickname: f(11, 10), ot: f(11, 7), player: f(11, 7), rival: f(11, 7), ...(gen === 2 ? { box: f(9, 8) } : {}) };
}
