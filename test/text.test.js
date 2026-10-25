/* shared/text/gen1..gen5: the character tables, terminators and padding, length limits, lossless
   rewrites and refusals. Two kinds of evidence:
   * every table entry round-trips (code -> text -> code, or for a duplicate glyph, text -> the
     canonical code -> the same text), and the tables' sizes are pinned so a lost row fails;
   * every name in the PKHeX-generated fixtures (test/fixtures/records and saves: Western,
     Japanese and Korean, all five generations) decodes to the string PKHeX reports and re-encodes
     to the same bytes. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FormatError } from "../shared/bytes.js";
import * as gen1 from "../shared/text/gen1.js";
import * as gen2 from "../shared/text/gen2.js";
import * as gen3 from "../shared/text/gen3.js";
import * as gen4 from "../shared/text/gen4.js";
import * as gen5 from "../shared/text/gen5.js";
import { TABLES as GB } from "../shared/text/gb.js";
import { GLYPH, LANGS } from "../shared/text/core.js";
import { KSX1001, EXTRA_SYLLABLES, GEN4_KOREAN } from "../shared/text/tables/hangul.js";
import { KO2_PAGES } from "../shared/text/tables/ko2.js";

const CODECS = { 1: gen1, 2: gen2, 3: gen3, 4: gen4, 5: gen5 };
const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (h) => Uint8Array.from(Buffer.from(h.replace(/\s+/g, ""), "hex"));
const u16 = (...codes) => { const b = new Uint8Array(codes.length * 2); codes.forEach((c, i) => { b[2 * i] = c & 0xff; b[2 * i + 1] = c >> 8; }); return b; };
const throwsCode = (fn, code) => assert.throws(fn, (e) => e instanceof FormatError && e.detail?.code === code);

/* ---------- vectors from the research notes and the games' own species names ---------- */

test("Gen 1/2 English species names", () => {
  for (const g of [gen1, gen2]) {
    assert.equal(hex(g.encode("PIKACHU", "en", 11)), "8f888a8082879450505050");
    assert.equal(hex(g.encode("BULBASAUR", "en", 11)), "81948b8180928094915050");
    assert.equal(hex(g.encode("NIDORAN♂", "en", 11)), "8d88838e91808def505050");
    assert.equal(hex(g.encode("NIDORAN♀", "en", 11)), "8d88838e91808df5505050");
    assert.equal(hex(g.encode("MR.MIME", "en", 11)), "8c91e88c888c8450505050");        // 0xE8, the full stop names use
    assert.equal(hex(g.encode("FARFETCH'D", "en", 11)), "8580918584938287e08350");   // ' + D, not the 'd ligature
    assert.equal(g.decode(bytes("8580918584938287e08350"), "en"), "FARFETCH'D");
    assert.equal(g.decode(bytes("8c91f28c888c8450505050"), "en"), "MR.MIME");        // 0xF2, the other full stop
  }
  assert.equal(gen1.decode(bytes("7f50"), "en"), " ");
});

test("Gen 1/2 accented Western names", () => {
  // German Gen 2 umlauts at 0xC0-0xC5; French and Italian/Spanish accents differ by table.
  assert.equal(hex(gen2.encode("KÖNIG", "de", 11)), "8ac18d8886505050505050");
  assert.equal(gen2.decode(bytes("8ac18d888650"), "de"), "KÖNIG");
  assert.equal(hex(gen1.encode("Éé", "es", 11).subarray(0, 3)), "c7bc50");
  assert.equal(hex(gen1.encode("ç", "fr", 3)), "bf5050");
  assert.equal(hex(gen1.encode("ñ", "es", 3)), "d25050");
  // Gen 2 French/German/Italian/Spanish have é at Gen 1's 0xBC and again at English's 0xEA
  // (Italian/Spanish & at 0xD7 and 0xE9). Encode writes the Gen 1 code, which still reads as é/&
  // after a Time Capsule trade back to Gen 1, where 0xE9/0xEA are leftover kana.
  for (const lang of ["fr", "de", "it", "es"]) {
    assert.equal(hex(gen2.encode("é", lang, 3)), "bc5050", lang);
    assert.equal(gen2.decode(bytes("ea50"), lang), "é", lang);
    assert.equal(gen1.decode(gen2.encode("é", lang, 3), lang), "é", lang);
  }
  for (const lang of ["it", "es"]) {
    assert.equal(hex(gen2.encode("&", lang, 3)), "d75050", lang);
    assert.equal(gen2.decode(bytes("e950"), lang), "&", lang);
    assert.equal(gen1.decode(gen2.encode("&", lang, 3), lang), "&", lang);
  }
  assert.equal(gen1.decode(bytes("ea50"), "fr"), "ゥ");          // what 0xEA would have become
  assert.equal(hex(gen2.encode("&", "fr", 3)), "e95050");       // French/German have only 0xE9
  assert.equal(hex(gen1.encode("é", "en", 3)), "ba5050");
  assert.equal(hex(gen2.encode("é", "en", 3)), "ea5050");
  assert.equal(gen1.canEncode("Ä", "en"), false);              // English Gen 1 has no umlauts ...
  assert.equal(gen2.canEncode("Ä", "en"), true);               // ... English Gen 2 does
  assert.equal(gen1.canEncode("ß", "it"), false);
  assert.equal(gen1.canEncode("ß", "de"), true);
});

test("Gen 1/2 Japanese, including the shared へ/ヘ り/リ べ/ベ ぺ/ペ glyphs", () => {
  assert.equal(hex(gen1.encode("ピカチュウ", "ja", 6)), "418590ae8250");
  assert.equal(hex(gen1.encode("サトシ", "ja", 6)), "8a938b505050");
  assert.equal(hex(gen2.encode("ゴールド", "ja", 6)), "09e3a6135050");
  assert.equal(gen1.decode(bytes("cda587a88c50"), "ja"), "ヘラクロス");
  assert.equal(gen1.decode(bytes("cdc9de50"), "ja"), "へのん");          // hiragana neighbour
  assert.equal(gen1.decode(bytes("3d933d93ab50"), "ja"), "ベトベトン");     // no left neighbour: look right
  assert.equal(gen1.decode(bytes("cd50"), "ja"), "ヘ");                   // no context: katakana
  assert.equal(gen1.decode(bytes("b1d850"), "ja"), "あり");
  assert.equal(gen1.decode(bytes("80d850"), "ja"), "アリ");
  for (const s of ["ヘ", "へ"]) assert.equal(hex(gen1.encode(s, "ja", 2)), "cd50");
  for (const s of ["リ", "り"]) assert.equal(hex(gen2.encode(s, "ja", 2)), "d850");
  assert.equal(hex(gen1.encode("ペ", "ja", 2)), "4750");
  assert.equal(hex(gen1.encode("ガ゛゜", "ja", 4)), "05e5e450");
  assert.equal(hex(gen1.encode("ｶﾞ".normalize("NFKC"), "ja", 2)), "0550");   // composed ガ
  assert.equal(gen1.decode(bytes("e6e7e8f0f2f6ff50"), "ja"), "？！。円．０９");
  assert.equal(gen1.canEncode("A", "ja"), false);               // the Japanese font has no Latin letters
});

test("Gen 2 Korean: two-byte Hangul, jamo and the 0B FF space", () => {
  assert.equal(hex(gen2.encode("불꽃", "ko", 11)), "053201f950505050505050");
  assert.equal(hex(gen2.encode("골드", "ko", 11)), "0161034550505050505050");
  assert.equal(gen2.decode(bytes("053201f950"), "ko"), "불꽃");
  assert.equal(hex(gen2.encode("ㄱ ㅏ", "ko", 7)), "0b000bff0b2050");
  assert.equal(hex(gen2.encode("가　나", "ko", 7).subarray(2, 4)), "0bff");   // ideographic space too
  assert.equal(hex(gen2.encode("AB!", "ko", 5)), "80810b6650");               // Latin single, ! as a pair
  assert.equal(gen2.decode(bytes("7f50"), "ko"), " ");                       // English space byte
  assert.equal(gen2.decode(bytes("00320550"), "ko"), "");                    // 0x00 ends the name
  assert.equal(gen2.decode(bytes("808101015050"), "ko"), "AB가");
  assert.equal(gen2.decode(bytes("80 05"), "ko"), "A\uFFFD");                // lone lead byte at the end
  // Five syllables fill an 11-byte field; a sixth does not fit.
  assert.equal(gen2.encode("가나다라마", "ko", 11)[10], 0x50);
  throwsCode(() => gen2.encode("가나다라마바", "ko", 11), "text-too-long");
  throwsCode(() => gen2.encode("뷁", "ko", 11), "text-unencodable");          // not in KS X 1001
  assert.equal(gen2.canEncode("괻", "ko"), true);                             // the games' substitute for 굄
  assert.equal(gen2.canEncode("굄", "ko"), false);
  assert.equal(gen2.canEncode("뢔", "ko"), true);                             // one of the five extras
  // Gen 1 with "ko" reads Korean bytes (a Korean Pokémon sent back through the Time Capsule).
  assert.equal(gen1.decode(bytes("053201f950"), "ko"), "불꽃");
});

test("Gen 3 Western and Japanese", () => {
  assert.equal(hex(gen3.encode("PIKACHU", "en", 10)), "cac3c5bbbdc2cfffffff");
  assert.equal(hex(gen3.encode("BULBASAUR", "en", 10)), "bccfc6bcbbcdbbcfccff");
  assert.equal(hex(gen3.encode("FARFETCH'D", "en", 10)), "c0bbccc0bfcebdc2b4be");   // fills the field: no terminator
  assert.equal(hex(gen3.encode("FARFETCH’D", "en", 10)), "c0bbccc0bfcebdc2b4be");
  assert.equal(gen3.decode(bytes("c0bbccc0bfcebdc2b4be"), "en"), "FARFETCH'D");
  assert.equal(hex(gen3.encode("NIDORAN♂", "en", 10)), "c8c3bec9ccbbc8b5ffff");
  assert.equal(hex(gen3.encode("MR. MIME", "en", 10)), "c7ccad00c7c3c7bfffff");
  assert.equal(hex(gen3.encode("BRENDAN", "en", 7)), "bcccbfc8bebbc8");
  assert.equal(hex(gen3.encode("MÉLOFÉE", "fr", 10)), "c706c6c9c006bfffffff");
  assert.equal(hex(gen3.encode("Mélofée", "fr", 10)), "c71be0e3da1bd9ffffff");
  assert.equal(hex(gen3.encode("Übel", "de", 5)), "f3d6d9e0ff");
  assert.equal(hex(gen3.encode("Me\u0301lofe\u0301e", "fr", 10)), "c71be0e3da1bd9ffffff");   // NFC: e + U+0301 = é
  assert.equal(hex(gen3.encode("ピカチュウ", "ja", 10)), "9c56618553ffffffffff");
  assert.equal(hex(gen3.encode("タマゴ", "ja", 10).subarray(0, 4)), "606f8bff");
  assert.equal(gen3.decode(bytes("c7bbd3ff"), "ja"), "ＭＡＹ");
  assert.equal(gen3.decode(bytes("c7bbd3ff"), "en"), "MAY");
  // 0xB1/0xB2 quotes by language; 0xB8 is a comma in Western text and a full stop in Japanese.
  assert.equal(gen3.decode(bytes("b1bbb2ff"), "en"), "“A”");
  assert.equal(gen3.decode(bytes("b1bbb2ff"), "de"), "„A“");
  assert.equal(gen3.decode(bytes("b1bbb2ff"), "fr"), "«A»");
  assert.equal(hex(gen3.encode("„A“", "de", 4)), "b1bbb2ff");
  assert.equal(hex(gen3.encode("“A”", "de", 4)), "b2bbb2ff");   // in German “ closes
  assert.equal(hex(gen3.encode("“A”", "en", 4)), "b1bbb2ff");
  assert.equal(gen3.decode(bytes("b8ff"), "en"), ",");
  assert.equal(gen3.decode(bytes("b8ff"), "ja"), "．");
  assert.equal(gen3.decode(bytes("aeff"), "ja"), "ー");
  assert.equal(gen3.decode(bytes("f1f6ff"), "ja"), "Äü");                   // readable ...
  assert.equal(gen3.canEncode("Ä", "ja"), false);                           // ... never written
  assert.equal(gen3.decode(bytes("0a18ff"), "en"), "\uFFFD\uFFFD");          // undefined codes
  assert.equal(gen3.decode(bytes("0a18ff"), "en", { unknown: "?" }), "??");
  assert.throws(() => gen3.decode(bytes("ff"), "ko"), FormatError);         // no Korean Gen 3 game
});

test("Gen 4: Latin, Japanese and Korean, both widths of ♂/♀", () => {
  assert.equal(hex(gen4.encode("PIKACHU", "en", 22)), "3a01330135012b012d0132013f01ffff000000000000");
  assert.equal(gen4.decode(u16(0x012c, 0x013f, 0x0136, 0x012c, 0x012b, 0x013d, 0x012b, 0x013f, 0x013c, 0xffff), "en"), "BULBASAUR");
  assert.equal(hex(gen4.encode("NIDORAN♂", "en", 22).subarray(14, 18)), "bb01ffff");   // half-width ♂ 0x01BB
  assert.equal(hex(gen4.encode("NIDORAN♀", "fr", 22).subarray(14, 16)), "bc01");
  assert.equal(hex(gen4.encode("ニドラン♂", "ja", 22).subarray(0, 12)), "7c007a009a00a100ee00ffff");   // full-width 0x00EE
  assert.equal(hex(gen4.encode("ニドラン♂", "ja", 22, { fullWidth: false }).subarray(8, 10)), "bb01");
  // × ÷ and the space do not make a Japanese name half width; Latin letters do.
  assert.equal(hex(gen4.encode("ピカ×♂", "ja", 22).subarray(0, 8)), hex(u16(0x0085, 0x005c, 0x00f2, 0x00ee)));
  assert.equal(hex(gen4.encode("ピカ ♂", "ja", 22).subarray(4, 8)), hex(u16(0x01de, 0x00ee)));
  assert.equal(hex(gen4.encode("ピカA♂", "ja", 22).subarray(4, 8)), hex(u16(0x012b, 0x01bb)));
  assert.equal(hex(gen4.encode("니드런♂", "ko", 22).subarray(6, 8)), "bb01");          // Korean: half width
  assert.equal(gen4.decode(u16(0x00ee, 0x01bb, 0xffff), "ja"), "♂♂");
  assert.equal(hex(gen4.encode("MR. MIME", "en", 22).subarray(0, 8)), "37013c01ae01de01");
  assert.equal(hex(gen4.encode("FARFETCH'D", "en", 22).subarray(16, 22)), "b3012e01ffff");
  assert.equal(gen4.decode(u16(0x0168, 0xffff), "fr"), "É");
  assert.equal(hex(gen4.encode("Mélofée", "fr", 22).subarray(0, 4)), "37018801");
  assert.equal(gen4.decode(u16(0x0083, 0x0064, 0xffff), "ja"), "ヒコ");
  assert.equal(gen4.decode(u16(0x0401, 0x0d2e, 0x0d31, 0x0d51, 0x0d61, 0xffff), "ko"), "가힝ㄱㅣ뢔");
  assert.equal(gen4.canEncode("굄", "ko"), true);       // Gen 4 has the full KS X 1001 set
  assert.equal(gen4.decode(u16(0x0400, 0xffff), "ko"), "\uFFFD");   // unassigned (pret disagrees, see gen4.js)
  assert.equal(gen4.decode(u16(0x012b, 0x0000, 0x012c), "en"), "A");   // stops at 0x0000 too
  assert.equal(gen4.decode(u16(0x01a5, 0x01e0, 0x01e1, 0x01df), "fr"), GLYPH.SUP_ER + GLYPH.PK + GLYPH.MN + GLYPH.SUP_E);
});

test("Gen 5: UTF-16 with the game's own glyph codes", () => {
  const nid = gen5.encode("Nidoran♂", "en", 22);
  assert.equal(hex(nid), "4e00690064006f00720061006e006d24ffff0000ffff");   // ♂ = U+246D, final unit 0xFFFF
  assert.equal(gen5.decode(nid, "en"), "Nidoran♂");
  assert.equal(hex(gen5.encode("ニドラン♂", "ja", 22).subarray(8, 12)), "4226ffff");   // full-width = U+2642
  assert.equal(hex(gen5.encode("ピカ×÷♂", "ja", 22).subarray(0, 10)), hex(u16(0x30d4, 0x30ab, 0x00d7, 0x00f7, 0x2642)));
  assert.equal(hex(gen5.encode("Pika×÷♂", "en", 22).subarray(8, 14)), hex(u16(0x2467, 0x2468, 0x246d)));
  assert.equal(hex(gen5.encode("Mr. Mime", "fr", 22).subarray(0, 8)), "4d0072002e002000");
  assert.equal(hex(gen5.encode("Farfetch'd", "en", 22)), "4600610072006600650074006300680027006400ffff");
  assert.equal(gen5.decode(u16(0x246d, 0x2642, 0x2467, 0x00d7, 0x247c, 0x247d, 0xffff), "en"), "♂♂××☂☃");
  assert.equal(gen5.decode(u16(0x2460, 0x247e, 0x2486, 0x2487, 0x2469, 0x0024, 0x2227, 0xffff), "en"), "😑😑ᴾₖᴹₙᵉʳ$∧");
  assert.equal(hex(gen5.encode("😑", "en", 4)), "7e24ffff");
  assert.equal(hex(gen5.encode("😑", "ja", 4)), "6024ffff");
  assert.equal(gen5.decode(u16(0x30dd, 0x30ab, 0xffff), "ja"), "ポカ");
  assert.equal(gen5.canEncode("Ω", "en"), false);       // Greek arrived in Gen 6
  assert.equal(gen5.canEncode("☺", "en"), true);        // drawn by the face glyph
  assert.equal(gen5.canEncode("⑭", "en"), false);       // type ♂, not the code point behind it
  assert.equal(gen5.canEncode("😀", "en"), false);       // outside the BMP
  assert.equal(gen5.canEncode("뷁", "ko"), false);
  assert.equal(gen5.canEncode("쬬", "ko"), true);
  assert.equal(gen5.decode(u16(0xd83d, 0xde00, 0xffff), "en"), "\uFFFD\uFFFD");
  assert.equal(gen5.decode(u16(0x41, 0x0000, 0x42), "en"), "A");
});

/* ---------- every table entry ---------- */

const PINNED_GB = {
  "1en": { exact: 86, alias: 8, decodeOnly: 3 }, "1frde": { exact: 105, alias: 13, decodeOnly: 3 },
  "1ites": { exact: 117, alias: 8, decodeOnly: 3 }, "1ja": { exact: 177, alias: 0, decodeOnly: 12 },
  "2en": { exact: 95, alias: 8, decodeOnly: 0 }, "2frde": { exact: 108, alias: 14, decodeOnly: 0 },
  "2ites": { exact: 119, alias: 10, decodeOnly: 0 }, "2ja": { exact: 177, alias: 0, decodeOnly: 12 },
  "2ko": { exact: 2491, alias: 28, decodeOnly: 2 },
};
const PINNED_GBA = {
  en: { exact: 150, alias: 1, decodeOnly: 0 }, de: { exact: 150, alias: 1, decodeOnly: 0 },
  fr: { exact: 150, alias: 1, decodeOnly: 0 }, ja: { exact: 241, alias: 0, decodeOnly: 6 },
};

/* For each (code, text) in a table: the code decodes to its text; the text encodes back to the
   code ("exact"), or for a second code of the same glyph to the canonical one, which decodes to
   the same text ("alias"); or it is a decode-only entry nothing writes ("decodeOnly"). */
function roundTripTable(codec, lang, table, field, raw, termLen, { shownAs } = {}) {
  const counts = { exact: 0, alias: 0, decodeOnly: 0 };
  for (const [code, text] of table.dec) {
    const b = raw(code), len = b.length - termLen;
    const shown = codec.decode(b, lang);
    assert.equal(shown, shownAs?.get(code) ?? text, `decode 0x${code.toString(16)} (${lang})`);
    if (!codec.canEncode(shown, lang, field)) { assert.ok(!table.enc.has(shown), `${shown} should encode`); counts.decodeOnly++; continue; }
    const back = codec.encode(shown, lang, field);
    assert.equal(codec.decode(back, lang), shown, `text round trip 0x${code.toString(16)} (${lang})`);
    if (hex(back.subarray(0, len)) === hex(b.subarray(0, len))) counts.exact++;
    else counts.alias++;
  }
  return counts;
}

/* The language-specific rows 0xBA-0xEF of the Western Gen 1/2 fonts, transcribed from
   Bulbapedia's "Character encoding (Generation I)" and "(Generation II)" tables (pret has no
   French, German, Italian or Spanish disassembly, so nothing else checks these rows). "_" = a
   code with no character (decodes to U+FFFD). PK MN are written P M here. */
const WESTERN_ROWS = {
  "1en": "é 'd 'l 's 't 'v | _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ | _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ | ' P M - 'r 'm ? ! . ァ ゥ ェ ▷ ▶ ▼ ♂",
  "1frde": "à è é ù ß ç | Ä Ö Ü ä ö ü ë ï â ô û ê î _ _ _ | _ _ _ _ c' d' j' l' m' n' p' s' 's t' u' y' | ' P M - + _ ? ! . ァ ゥ ェ ▷ ▶ ▼ ♂",
  "1ites": "à è é ù À Á | Ä Ö Ü ä ö ü È É Ì Í Ñ Ò Ó Ù Ú á | ì í ñ ò ó ú º & 'd 'l 'm 'r 's 't 'v _ | ' P M - ¿ ¡ ? ! . ァ ゥ ェ ▷ ▶ ▼ ♂",
  "2en": "_ _ _ _ _ _ | Ä Ö Ü ä ö ü _ _ _ _ _ _ _ _ _ _ | 'd 'l 'm 'r 's 't 'v _ _ _ _ _ _ _ _ ← | ' P M - _ _ ? ! . & é → ▷ ▶ ▼ ♂",
  "2frde": "à è é ù ß ç | Ä Ö Ü ä ö ü ë ï â ô û ê î _ _ ← | _ _ _ _ c' d' j' l' m' n' p' s' 's t' u' y' | ' P M - + _ ? ! . & é → ▷ ▶ ▼ ♂",
  "2ites": "à è é ù À Á | Ä Ö Ü ä ö ü È É Ì Í Ñ Ò Ó Ù Ú á | ì í ñ ò ó ú º & 'd 'l 'm 'r 's 't 'v ← | ' P M - ¿ ¡ ? ! . & é → ▷ ▶ ▼ ♂",
};

test("Gen 1/2 Western rows 0xBA-0xEF match Bulbapedia's per-language tables", () => {
  const show = { P: GLYPH.PK, M: GLYPH.MN, _: "\uFFFD" };
  for (const [key, row] of Object.entries(WESTERN_ROWS)) {
    const cells = row.replace(/\| /g, "").split(" ");
    assert.equal(cells.length, 0xf0 - 0xba, key);
    const codec = CODECS[key[0]], lang = { en: "en", frde: "fr", ites: "it" }[key.slice(1)];
    cells.forEach((cell, i) => assert.equal(codec.decode(Uint8Array.of(0xba + i, 0x50), lang), show[cell] ?? cell, `${key} 0x${(0xba + i).toString(16)}`));
  }
});

test("Gen 1/2 tables: every entry round-trips", () => {
  const kata = new Map([[0xcd, "ヘ"], [0xd8, "リ"], [0x3d, "ベ"], [0x47, "ペ"]]);   // alone, they read as katakana
  const counts = {};
  for (const [gen, codec] of [[1, gen1], [2, gen2]]) {
    for (const [group, lang] of [["en", "en"], ["frde", "fr"], ["ites", "it"], ["ja", "ja"], ...(gen === 2 ? [["ko", "ko"]] : [])]) {
      const raw = (c) => (c > 0xff ? Uint8Array.of(c >> 8, c & 0xff, 0x50) : Uint8Array.of(c, 0x50));
      counts[`${gen}${group}`] = roundTripTable(codec, lang, GB[gen][group], 11, raw, 1, { shownAs: group === "ja" ? kata : null });
    }
  }
  // Pinned so that a lost or changed row is noticed. Aliases are second codes for a glyph
  // (0xF2's full stop, Gen 2's old é and &, Korean single bytes that also exist as pairs);
  // decode-only entries are the ligatures, leftover kana and the like.
  assert.deepEqual(counts, PINNED_GB);
});

test("Gen 3 tables: every entry round-trips", () => {
  const counts = {};
  for (const lang of ["en", "de", "fr", "ja"]) counts[lang] = roundTripTable(gen3, lang, gen3.TABLES[lang], 10, (c) => Uint8Array.of(c, 0xff), 1);
  assert.deepEqual(counts, PINNED_GBA);
});

test("Gen 4 table: every entry round-trips, full-width codes in Japanese", () => {
  const counts = { exact: 0, fullWidth: 0, decodeOnly: 0 };
  for (const [code, text] of gen4.TABLE.dec) {
    const raw = u16(code, 0xffff);
    assert.equal(gen4.decode(raw, "en"), text);
    if (!gen4.TABLE.enc.has(text)) { counts.decodeOnly++; continue; }
    const wide = gen4.FULL_WIDTH.get(text) === code;
    const lang = code >= 0x400 ? "ko" : code < 0x121 ? "ja" : "en";
    assert.equal(hex(gen4.encode(text, lang, 4, wide ? { fullWidth: true } : {})), hex(raw), `0x${code.toString(16)} ${text}`);
    counts[wide ? "fullWidth" : "exact"]++;
  }
  // 0x0001-0x01EC except 0x00E0 (491 codes, six of them decode-only narrow spaces, 27 of them the
  // full-width twins), then 2,350 + 33 + 5 Korean codes.
  assert.deepEqual(counts, { exact: 491 - 6 - 27 + 2350 + 33 + 5, fullWidth: 27, decodeOnly: 6 });
});

test("Gen 5 glyph range: every glyph round-trips; the font list has Bulbapedia's 5,064 characters", () => {
  for (const [code, text] of gen5.GLYPHS) {
    const raw = u16(code, 0xffff);
    assert.equal(gen5.decode(raw, "en"), text);
    const full = code < 0x2467;   // the full-width faces
    assert.equal(hex(gen5.encode(text, full ? "ja" : "en", 4)), hex(raw), code.toString(16));
  }
  let n = 0;
  for (let cp = 0; cp <= 0xffff; cp++) if (gen5.inFont(cp) && !(cp >= 0x4e00 && cp <= 0x9fff)) n++;
  assert.equal(n, 5064 - 1946);   // everything but the kanji, which are approximated
});

test("Korean tables: KS X 1001 order with the games' edits", () => {
  // Independent of the generator: KS X 1001 rows 0xB0-0xC8 through the platform's EUC-KR decoder.
  const euckr = new TextDecoder("euc-kr", { fatal: true });
  let ks = "";
  for (let hi = 0xb0; hi <= 0xc8; hi++) for (let lo = 0xa1; lo <= 0xfe; lo++) ks += euckr.decode(Uint8Array.of(hi, lo));
  assert.equal(KSX1001, ks);
  assert.equal([...KSX1001].length, 2350);
  assert.equal(EXTRA_SYLLABLES, "뢔쌰쎼쓔쬬");
  const g4 = [...GEN4_KOREAN];
  assert.equal(g4.length, 0x0d65 - 0x0400 + 1);
  assert.equal(g4.slice(1, 2351).join(""), KSX1001);
  const pages = KO2_PAGES.slice(1, 11).map((p) => [...p].filter((c) => c !== "\0").join("")).join("");
  assert.equal([...pages].length, 2350 + 5 - 2);
  for (const c of ["겸", "겹", "괻", "읆", "뢔"]) assert.ok(pages.includes(c), c);
  for (const c of ["굄", "댜", "돐", "읊"]) assert.ok(!pages.includes(c), c);
  assert.ok(pages.indexOf("겹") < pages.indexOf("겸"));     // swapped relative to KS X 1001
});

/* ---------- terminators, padding, limits ---------- */

test("terminators and fresh padding per generation", () => {
  assert.equal(hex(gen1.encode("AB", "en", 6)), "808150505050");
  assert.equal(hex(gen2.encode("", "en", 3)), "505050");
  assert.equal(hex(gen3.encode("AB", "en", 6)), "bbbcffffffff");
  assert.equal(hex(gen3.encode("", "en", 2)), "ffff");
  assert.equal(hex(gen4.encode("A", "en", 8)), "2b01ffff00000000");
  assert.equal(hex(gen5.encode("A", "en", 8)), "4100ffff0000ffff");
  assert.equal(hex(gen5.encode("ABC", "en", 8)), "410042004300ffff");   // terminator is the last unit
  assert.equal(hex(gen5.encode("", "en", 4)), "ffffffff");
  for (const g of [gen4, gen5]) assert.throws(() => g.encode("A", "en", 7), TypeError);   // u16 fields
  assert.throws(() => gen1.encode("A", "en", 0), TypeError);
});

test("maximum lengths", () => {
  assert.equal(gen1.encode("ABCDEFGHIJ", "en", 11)[10], 0x50);
  throwsCode(() => gen1.encode("ABCDEFGHIJK", "en", 11), "text-too-long");
  throwsCode(() => gen1.encode("ピカチュウX", "ja", 6), "text-unencodable");
  throwsCode(() => gen1.encode("ピカチュウピ", "ja", 6), "text-too-long");
  throwsCode(() => gen3.encode("ABCDEFGHIJK", "en", 10), "text-too-long");
  throwsCode(() => gen3.encode("ABCDEFGH", "en", 8, { maxChars: 7 }), "text-too-long");
  assert.equal(hex(gen3.encode("ABCDEFG", "en", 8)), "bbbcbdbebfc0c1ff");
  // Only the 10- and 7-byte PK3 fields may be full without a terminator. The 8-byte player name
  // and the 9-byte box name always keep one, even without maxChars (the game reads up to 0xFF).
  assert.equal(hex(gen3.encode("ABCDEFGHIJ", "en", 10)), "bbbcbdbebfc0c1c2c3c4");
  assert.equal(hex(gen3.encode("ABCDEFG", "en", 7)), "bbbcbdbebfc0c1");
  assert.throws(() => gen3.encode("ABCDEFGH", "en", 8), (e) => e.detail?.code === "text-too-long" && e.detail.maxChars === 7);
  assert.throws(() => gen3.encode("ABCDEFGHI", "en", 9), (e) => e.detail?.code === "text-too-long" && e.detail.maxChars === 8);
  assert.equal(hex(gen3.encode("ABCDEFGH", "en", 9)), "bbbcbdbebfc0c1c2ff");
  // ... but an unterminated field from a save still rewrites unchanged.
  const unterminated = bytes("bbbcbdbebfc0c1c2");
  assert.equal(hex(gen3.encode("ABCDEFGH", "en", 8, { original: unterminated })), hex(unterminated));
  throwsCode(() => gen4.encode("ABCDEFGHIJK", "en", 22), "text-too-long");
  throwsCode(() => gen5.encode("ABCDEFGHIJK", "en", 22), "text-too-long");
  throwsCode(() => gen5.encode("ピカチュウピ", "ja", 22, { maxChars: gen5.limits("ja").nickname.chars }), "text-too-long");
  assert.equal(gen2.canEncode("ABCDEFGHIJ", "en", 11), true);
  assert.equal(gen2.canEncode("ABCDEFGHIJK", "en", 11), false);
  // Glyphs count once however many letters they display.
  assert.equal(gen1.encode("ᴾₖᴹₙ", "en", 3)[2], 0x50);
});

test("limits() describe the in-game fields", () => {
  assert.deepEqual(gen1.limits("en").nickname, { bytes: 11, chars: 10 });
  assert.deepEqual(gen1.limits("ja").ot, { bytes: 6, chars: 5 });
  assert.deepEqual(gen2.limits("ko").box, { bytes: 17, chars: 8 });
  assert.deepEqual(gen3.limits("en").ot, { bytes: 7, chars: 7 });
  assert.deepEqual(gen3.limits("ja").nickname, { bytes: 10, chars: 5 });
  assert.deepEqual(gen4.limits("en").nickname, { bytes: 22, chars: 10 });
  assert.deepEqual(gen5.limits("de").ot, { bytes: 16, chars: 7 });
  assert.equal(gen1.limits("ko").box, undefined);
  for (const g of [gen1, gen2, gen4, gen5]) assert.deepEqual(g.LANGS, LANGS);
  assert.deepEqual(gen3.LANGS, LANGS.filter((l) => l !== "ko"));
  for (const g of [gen1, gen2, gen3, gen4, gen5]) assert.throws(() => g.limits("xx"), FormatError);
});

/* ---------- lossless rewrites ---------- */

test("rewriting a name keeps the bytes after its terminator", () => {
  // Gen 1: a renamed Pokémon carries leftovers of the old name after 0x50.
  const g1 = bytes("8f888a805087945001ff7f");
  assert.equal(hex(gen1.encode(gen1.decode(g1, "en"), "en", 11, { original: g1 })), hex(g1));
  assert.equal(hex(gen1.encode("PIK", "en", 11, { original: g1 })), "8f888a505087945001ff7f");
  assert.equal(hex(gen1.encode("PIKACHU", "en", 11, { original: g1 })), "8f888a808287945001ff7f");
  assert.equal(hex(gen1.encode("PIK", "en", 11, { original: g1, trailing: "pad" })), "8f888a5050505050505050");
  // Gen 1: the duplicate full stop keeps its code while the start of the name is unchanged.
  const dot = bytes("8cf28c50");
  assert.equal(hex(gen1.encode("M.M", "en", 4, { original: dot })), "8cf28c50");
  assert.equal(hex(gen1.encode("M.MA", "en", 5, { original: dot })), "8cf28c8050");
  assert.equal(hex(gen1.encode("M.M", "en", 4)), "8ce88c50");
  // A field that never had a terminator survives unchanged.
  const full = bytes("8081828384858687888980");
  assert.equal(gen1.decode(full, "en"), "ABCDEFGHIJA");
  assert.equal(hex(gen1.encode("ABCDEFGHIJA", "en", 11, { original: full })), hex(full));
  // Gen 3: stack garbage after the 0xFF of a game-made nickname.
  const g3 = bytes("cac3c5bbbdc2cfff3a07");
  assert.equal(hex(gen3.encode("PIKACHU", "en", 10, { original: g3 })), hex(g3));
  assert.equal(hex(gen3.encode("PIKA", "en", 10, { original: g3 })), "cac3c5bbffc2cfff3a07");
  // Gen 4: old units after the terminator; a 0x0000 terminator is kept where it was.
  const g4 = u16(0x012b, 0x0000, 0x013a, 0x0133, 0xffff, 0x1234);
  assert.equal(hex(gen4.encode("A", "en", 12, { original: g4 })), hex(g4));
  assert.equal(hex(gen4.encode("AB", "en", 12, { original: g4 })), hex(u16(0x012b, 0x012c, 0xffff, 0x0133, 0xffff, 0x1234)));
  // Gen 5: the naming screen's copy (no final 0xFFFF) and a renamed PIKACHU -> BOB.
  const g5 = u16(0x50, 0x49, 0x4b, 0x41, 0x43, 0x48, 0x55, 0xffff, 0, 0, 0xffff);
  const bob = gen5.encode("BOB", "en", 22, { original: g5 });
  assert.equal(hex(bob), hex(u16(0x42, 0x4f, 0x42, 0xffff, 0x43, 0x48, 0x55, 0xffff, 0, 0, 0xffff)));
  assert.equal(gen5.decode(bob, "en"), "BOB");
  // Shorter or longer originals are resized; unknown codes survive a rewrite of the same text.
  assert.equal(hex(gen3.encode("A", "en", 4, { original: bytes("bbff") })), "bbffffff");
  const odd = bytes("0a0bff00");
  assert.equal(gen3.decode(odd, "en"), "\uFFFDÎ");
  assert.equal(hex(gen3.encode("\uFFFDÎ", "en", 4, { original: odd })), hex(odd));
  throwsCode(() => gen3.encode("\uFFFDÎ", "en", 4), "text-unencodable");
  // A stored character that NFC would change (U+212B ANGSTROM SIGN is in the Gen 5 font) survives
  // an unchanged rewrite; typed fresh, it is normalised to U+00C5.
  const angstrom = u16(0x212b, 0xffff, 0x1234);
  assert.equal(hex(gen5.encode(gen5.decode(angstrom, "en"), "en", 6, { original: angstrom })), hex(angstrom));
  assert.equal(hex(gen5.encode("\u212b", "en", 4)), "c500ffff");
});

test("Korean and Japanese rewrites, the two widths and the <TRAINER> code survive", () => {
  const ko = bytes("053201f950ab0bff5050cd");
  assert.equal(hex(gen2.encode("불꽃", "ko", 11, { original: ko })), hex(ko));
  const ja4 = u16(0x007c, 0x007a, 0x009a, 0x00a1, 0x01bb, 0xffff, 0, 0, 0, 0, 0);   // Japanese name with half-width ♂
  assert.equal(hex(gen4.encode("ニドラン♂", "ja", 22, { original: ja4 })), hex(ja4));
  assert.equal(hex(gen4.encode("ニドラン♂", "ja", 22).subarray(8, 10)), "ee00");     // fresh: full width
  const koNido = u16(0x0401, 0x00ee, 0xffff, 0, 0, 0, 0, 0, 0, 0, 0);   // Korean DPPt Nidoran: full-width sign
  assert.equal(hex(gen4.encode(gen4.decode(koNido, "ko"), "ko", 22, { original: koNido })), hex(koNido));
  // In-game trade OT: 0x5D prints TRAINER in the game's language; typing it writes letters.
  const trade = bytes("5d505050505050505050");
  assert.equal(gen1.decode(trade, "en"), "TRAINER");
  assert.equal(gen1.decode(trade, "fr"), "DRES.");
  assert.equal(gen2.decode(trade, "fr"), "DRESSEUR");
  assert.equal(gen1.decode(trade, "ja"), "トレーナー");
  assert.equal(gen1.decode(trade, "en", { trainer: "*" }), "*");
  assert.equal(hex(gen1.encode("TRAINER", "en", 10, { original: trade })), hex(trade));
  assert.equal(hex(gen1.encode("TRAINER", "en", 10)), "939180888d8491505050");
  // A longer name that starts with the word keeps the code: the game prints TRAINER + S.
  assert.equal(hex(gen1.encode("TRAINERS", "en", 10, { original: trade }).subarray(0, 3)), "5d9250");
});

/* ---------- refusals ---------- */

test("unencodable characters are refused with the character and its position", () => {
  const cases = [[gen1, "PIKA Ω", "en"], [gen2, "ピカ", "en"], [gen3, "Łódź", "en"], [gen4, "Ω", "en"], [gen5, "Ω", "en"], [gen2, "€", "ko"]];
  for (const [g, s, lang] of cases) {
    assert.equal(g.canEncode(s, lang), false, s);
    assert.throws(() => g.encode(s, lang, 22), (e) => e instanceof FormatError && e.detail.code === "text-unencodable" && s.includes(e.detail.char));
  }
  // Arguments that are not a name or a field are TypeErrors, never a silently wrong name.
  for (const g of [gen1, gen2, gen3, gen4, gen5]) {
    for (const bad of [undefined, null, 12, ["A"]]) assert.throws(() => g.encode(bad, "en", 22), TypeError);
    assert.throws(() => g.decode("8f88", "en"), TypeError);
    assert.throws(() => g.decode(undefined, "en"), TypeError);
  }
  assert.equal(gen1.decode(Uint8Array.of(0x80, 0x50).buffer, "en"), "A");   // ArrayBuffer
  assert.equal(gen1.decode([0x80, 0x81, 0x50], "en"), "AB");                 // plain array (Fields)
  assert.equal(gen4.decode(new DataView(u16(0x012b, 0xffff).buffer), "en"), "A");
  try { gen1.encode("AB😀", "en", 11); assert.fail(); } catch (e) { assert.equal(e.detail.char, "😀"); assert.equal(e.detail.index, 2); assert.match(e.message, /Generation 1/); }
  assert.throws(() => gen4.decode(u16(1), "xx"), (e) => e instanceof FormatError && e.detail.code === "text-lang");
  assert.equal(gen1.canEncode("Bob's", "en", 11, { ligatures: true }), true);
  assert.equal(hex(gen2.encode("Bob's", "en", 9, { ligatures: true }).subarray(0, 4)), "81aea1d4");
  assert.equal(hex(gen2.encode("Bob's", "en", 9).subarray(0, 5)), "81aea1e0b2");
});

/* ---------- across generations ---------- */

test("names carry across generations through their strings", () => {
  // Gen 3 -> 4 -> 5 through strings lands ♂/♀, the apostrophe, PK MN and the ellipsis on each
  // generation's own codes for them. (The real transfers have quirks of their own, such as Pal
  // Park reading 0xB7 as 円 and Poké Transfer writing "?" for PK, MN and $: convert.js's business.)
  const w3 = gen3.encode("ᴾₖᴹₙ'♂…A", "en", 10);
  const s3 = gen3.decode(w3, "en");
  const w4 = gen4.encode(s3, "en", 22);
  assert.equal(hex(w4.subarray(0, 12)), hex(u16(0x01e0, 0x01e1, 0x01b3, 0x01bb, 0x01af, 0x012b)));
  const w5 = gen5.encode(gen4.decode(w4, "en"), "en", 22);
  assert.equal(hex(w5.subarray(0, 12)), hex(u16(0x2486, 0x2487, 0x27, 0x246d, 0x246c, 0x41)));
  // Japanese: full width all the way.
  const j4 = gen4.encode(gen3.decode(gen3.encode("ピカ♂", "ja", 10), "ja"), "ja", 22);
  assert.equal(hex(j4.subarray(0, 6)), hex(u16(0x0085, 0x005c, 0x00ee)));
  assert.equal(hex(gen5.encode(gen4.decode(j4, "ja"), "ja", 22).subarray(0, 6)), hex(u16(0x30d4, 0x30ab, 0x2642)));
  // The Gen 4 symbol set maps onto Gen 5's glyph codes one to one (half width).
  const half = [...gen4.TABLE.dec].filter(([c, t]) => c >= 0x0121 && c < 0x0400 && gen4.FULL_WIDTH.has(t));
  assert.equal(half.length, 27);
  for (const [, t] of half) assert.ok(gen5.encode(t, "en", 4)[1] === 0x24, t);
});

/* ---------- every name in the PKHeX fixtures ---------- */

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LANG_ID = { 0: "en", 1: "ja", 2: "en", 3: "fr", 4: "it", 5: "de", 7: "es", 8: "ko" };
function* fixtureNames() {
  const mons = [];
  for (const f of readdirSync(path.join(ROOT, "fixtures/records"))) {
    if (!f.endsWith(".json")) continue;
    mons.push({ src: f, mon: JSON.parse(readFileSync(path.join(ROOT, "fixtures/records", f), "utf8")).pkm, saveLang: null });
  }
  for (const f of readdirSync(path.join(ROOT, "fixtures/saves"))) {
    if (!f.endsWith(".expected.json")) continue;
    const save = JSON.parse(readFileSync(path.join(ROOT, "fixtures/saves", f), "utf8"));
    const saveLang = f.match(/-(en|ja|ko)\./)[1];
    for (const m of save.party) mons.push({ src: f, mon: m, saveLang });
    for (const m of save.boxes) if (m) mons.push({ src: f, mon: m, saveLang });   // a flat list with box/slot
  }
  for (const { src, mon, saveLang } of mons) {
    if (!mon.species) continue;   // empty slots
    const gen = Number(mon.format.slice(2));
    if (gen <= 2) {
      const lang = saveLang ?? mon.languageCode ?? "en";
      yield { src, gen, lang, field: "nickname", text: mon.nickname, raw: bytes(mon.nicknameHex) };
      yield { src, gen, lang, field: "ot", text: mon.ot.name, raw: bytes(mon.otNameHex) };
    } else {
      const d = bytes(mon.decryptedHex);
      if (gen === 3) {
        const lang = LANG_ID[d[0x12]];
        yield { src, gen, lang, field: "nickname", text: mon.nickname, raw: d.slice(0x08, 0x12) };
        yield { src, gen, lang, field: "ot", text: mon.ot.name, raw: d.slice(0x14, 0x1b) };
      } else {
        const lang = LANG_ID[d[0x17]];
        yield { src, gen, lang, field: "nickname", text: mon.nickname, raw: d.slice(0x48, 0x5e) };
        yield { src, gen, lang, field: "ot", text: mon.ot.name, raw: d.slice(0x68, 0x78) };
      }
    }
  }
}

test("every fixture name decodes like PKHeX and rewrites to the same bytes", () => {
  const seen = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, langs = new Set();
  for (const n of fixtureNames()) {
    const codec = CODECS[n.gen];
    const where = `${n.src} ${n.field} ${JSON.stringify(n.text)}`;
    const text = codec.decode(n.raw, n.lang);
    assert.equal(text, n.text, where);
    assert.equal(hex(codec.encode(text, n.lang, n.raw.length, { original: n.raw })), hex(n.raw), where);
    // Gen 1/2 and Gen 4 pad the way PKHeX does, so even a fresh encode matches.
    if (n.gen === 1 || n.gen === 2 || n.gen === 4) assert.equal(hex(codec.encode(text, n.lang, n.raw.length)), hex(n.raw), where);
    seen[n.gen]++;
    langs.add(`${n.gen}${n.lang}`);
  }
  for (const g of [1, 2, 3, 4, 5]) assert.ok(seen[g] > 200, `gen ${g}: ${seen[g]} names`);
  for (const l of ["1en", "1ja", "2en", "2ja", "2ko", "3en", "3ja", "4en", "4ja", "4ko", "5en", "5ja"]) assert.ok(langs.has(l), l);
});
