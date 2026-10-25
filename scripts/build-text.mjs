#!/usr/bin/env node
/* Builds the large text tables in shared/text/tables/ and cross-checks the hand-written ones.

   Generated (committed output, plain `export const` modules):
     tables/ko2.js      Korean Gold/Silver two-byte pages 0x01-0x0B
     tables/hangul.js   the KS X 1001 Hangul syllables plus the five extras the games add, and the
                        Gen 4 Korean range 0x0400-0x0D65

   Inputs, downloaded once into TEXT_CACHE (default: <tmpdir>/pokemon-widget-text-cache) and
   recorded with their SHA-256 in the generated headers:
     * Bulbapedia's "Korean character encoding (Generation II)" and "Character encoding
       (Generation IV)" pages, through fixed web.archive.org snapshots (the live site blocks
       scripts). Bulbapedia text is CC BY-NC-SA; we take only the code -> character facts.
     * pret's charmaps at pinned commits (pokered, pokecrystal, pokeemerald, pokeplatinum). pret
       has no licence, so they are only read here to cross-check our own tables, never copied.
   Checks (the build fails on any mismatch):
     * Gen 4 0x0401-0x0D2E must be exactly the 2,350 KS X 1001 syllables in order, which we
       derive from the platform's EUC-KR decoder (rows 0xB0-0xC8), not from either wiki page.
     * Gen 2 pages must be KS X 1001 order with exactly the edits Bulbapedia documents.
     * pret's Gen 4 charmap must agree with the Gen 4 Hangul range apart from its known
       off-by-one at 0x0400-0x040F (docs/research/format-gen4.md §13).
     * Every entry of the hand-written tables in shared/text/gb.js, gen3.js and gen4.js is
       compared with pret's charmaps (Gen 4's also with Bulbapedia's table); each difference must
       be listed with its reason in EXPECTED_DIFFS here or PRET_DIFFS in gen4.js, and a listed
       difference that disappears fails too. These run after the generated modules are written,
       because the hand-written modules import them.
   Run: node scripts/build-text.mjs [--check] [--tables-only]
     --check        verify that the committed tables are current, write nothing
     --tables-only  skip the Gen 3/4 cross-checks (for bootstrapping a broken gen3/gen4.js) */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "shared/text/tables");
const CACHE = process.env.TEXT_CACHE || path.join(os.tmpdir(), "pokemon-widget-text-cache");
const CHECK_ONLY = process.argv.includes("--check");
const TABLES_ONLY = process.argv.includes("--tables-only"); // skip the gen3/gen4 cross-checks

const WB = "https://web.archive.org/web/";
const BP = "https://bulbapedia.bulbagarden.net/wiki/";
const GH = "https://raw.githubusercontent.com/pret/";
const SOURCES = {
  ko2: WB + "20260502164644id_/" + BP + "Korean_character_encoding_(Generation_II)",
  ce4: WB + "20251205041441id_/" + BP + "Character_encoding_(Generation_IV)",
  red: GH + "pokered/171e2c204f9c1ff8e577ca387a4bbb009e130843/constants/charmap.asm",
  crystal: GH + "pokecrystal/5c877ef55197039c9676e8e3eec6d254b1c40fe8/constants/charmap.asm",
  emerald: GH + "pokeemerald/731ad5bfd6e6f265508d0efcca0ba42f9dcf5881/charmap.txt",
  platinum: GH + "pokeplatinum/be36a9db3d2390a5009adc087c7aef550ce335e7/tools/msgenc/charmap.txt",
};

async function fetchCached(key) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, key + ".src");
  if (!existsSync(file)) {
    const res = await fetch(SOURCES[key], { headers: { "user-agent": "pokemon-matrix-widget build-text" } });
    if (!res.ok) throw new Error(`${SOURCES[key]}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const buf = readFileSync(file);
  return { text: buf.toString("utf8"), sha256: createHash("sha256").update(buf).digest("hex") };
}

const fail = (msg) => { throw new Error("build-text: " + msg); };
const hex = (n, w = 4) => "0x" + n.toString(16).toUpperCase().padStart(w, "0");

/* ---------- Bulbapedia HTML tables ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}
const cellText = (html) => unescapeHtml(html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, "[img:$1]").replace(/<[^>]+>/g, "")).trim();

/** Every 16-column grid in the page: { headingBefore, rows: Map(rowValue -> 16 cell texts) }. */
function grids(html) {
  const out = [];
  const re = /<table[^>]*wikitable[^>]*>([\s\S]*?)<\/table>/g;
  let m;
  while ((m = re.exec(html))) {
    const before = html.slice(Math.max(0, m.index - 600), m.index);
    const heads = [...before.matchAll(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/g)];
    const heading = heads.length ? cellText(heads[heads.length - 1][1]) : "";
    const rows = new Map();
    for (const r of m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const th = r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/);
      if (!th) continue;
      const label = cellText(th[1]).match(/^([0-9A-F]{1,3})-$/);
      if (!label) continue;
      const cells = [];
      for (const td of r[1].matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)) {
        const span = Number((td[1].match(/colspan="?(\d+)/) || [0, 1])[1]);
        const t = cellText(td[2]);
        for (let k = 0; k < span; k++) cells.push(span === 1 ? t : "");
      }
      rows.set(parseInt(label[1], 16), cells);
    }
    if (rows.size) out.push({ heading, rows });
  }
  return out;
}

/* ---------- KS X 1001 (independent reference) ---------- */

function ksx1001Syllables() {
  const dec = new TextDecoder("euc-kr", { fatal: true });
  const out = [];
  for (let hi = 0xb0; hi <= 0xc8; hi++) for (let lo = 0xa1; lo <= 0xfe; lo++) out.push(dec.decode(new Uint8Array([hi, lo])));
  if (out.length !== 2350) fail("expected 2350 KS X 1001 syllables, got " + out.length);
  return out;
}
const EXTRA_SYLLABLES = ["뢔", "쌰", "쎼", "쓔", "쬬"]; // added by the games so every jamo pair can be typed

/* ---------- Gen 2 Korean ---------- */

function buildKo2(html, ks) {
  const pages = [];
  for (const g of grids(html)) {
    const p = g.heading.match(/^0x([0-9A-F]{2})$/);
    if (!p) continue;
    const lead = parseInt(p[1], 16);
    const page = new Array(256).fill("");
    for (const [row, cells] of g.rows) {
      if (cells.length !== 16) fail(`Korean page ${hex(lead, 2)} row ${row}: ${cells.length} cells`);
      cells.forEach((c, i) => { page[row * 16 + i] = c; });
    }
    pages[lead] = page;
  }
  for (let lead = 0; lead <= 0x0b; lead++) if (!pages[lead]) fail("Korean page missing: " + hex(lead, 2));
  // Pages 0x00 and 0x0B print the same characters; the games only write 0x0B.
  if (pages[0].join("\n") !== pages[0x0b].join("\n")) fail("Korean pages 0x00 and 0x0B differ");
  // Page 0x0B: 0x3E/0x3F are the naming screen's two placeholder lines (we give the second one a
  // character of its own, U+2012, so it cannot be confused with the hyphen at 0x68), and 0xFF is
  // the space the naming screen writes ("0B FF is inserted when the player uses a space").
  const b = pages[0x0b];
  if (!/^(_|\[img:.*)$/.test(b[0x3e]) || !/^(-|\[img:.*)$/.test(b[0x3f])) fail(`unexpected Korean 0x0B3E/3F: ${b[0x3e]} ${b[0x3f]}`);
  if (!/0B FF is inserted when the player uses a space/.test(html.replace(/<[^>]+>/g, "")) || !["", "␠"].includes(b[0xff])) fail("Korean 0x0BFF is not the space");
  b[0x3e] = "_"; b[0x3f] = "\u2012"; b[0xff] = " ";
  for (let lead = 1; lead <= 0x0b; lead++) for (const c of pages[lead]) if (c && [...c].length !== 1) fail(`Korean page ${hex(lead, 2)}: cell "${c}"`);

  // Check against KS X 1001: same order, with exactly the documented edits.
  const syl = [];
  for (let lead = 1; lead <= 0x0a; lead++) for (const c of pages[lead]) if (c) syl.push(c);
  // Each extra goes into the empty slot just before the 94-syllable KS X 1001 row it sorts into.
  const extrasAt = new Map();
  for (const e of EXTRA_SYLLABLES) {
    const end = Math.floor(ks.findIndex((x) => x > e) / 94) * 94;
    extrasAt.set(end, [...(extrasAt.get(end) || []), e]);
  }
  const edit = { "겸": "겹", "겹": "겸", "굄": "괻", "읊": "읆", "댜": null, "돐": null };
  const expect = [];
  ks.forEach((c, i) => {
    if (i && i % 94 === 0) expect.push(...(extrasAt.get(i) || []));
    const e = c in edit ? edit[c] : c;
    if (e) expect.push(e);
  });
  if (syl.length !== expect.length) fail(`Gen 2 Korean: ${syl.length} syllables, expected ${expect.length}`);
  syl.forEach((c, i) => { if (c !== expect[i]) fail(`Gen 2 Korean syllable #${i}: ${c}, expected ${expect[i]}`); });
  return pages;
}

/* ---------- Gen 4 ---------- */

function bulbapediaGen4(html) {
  const g = grids(html);
  const main = new Map(), kor = new Map();
  for (const t of g) for (const [row, cells] of t.rows) cells.forEach((c, i) => {
    const code = row * 16 + i;
    if (code < 0x200) { if (!main.has(code)) main.set(code, c); }
    else if (code >= 0x400 && code < 0xd80) kor.set(code, c);
  });
  return { main, kor };
}

function buildHangul4(kor, ks) {
  const span = 0x0d65 - 0x0400 + 1, out = new Array(span).fill("");
  for (const [code, c] of kor) if (code <= 0x0d65 && c) out[code - 0x400] = c;
  ks.forEach((c, i) => { if (out[0x401 + i - 0x400] !== c) fail(`Gen 4 ${hex(0x401 + i)}: ${out[0x401 + i - 0x400]}, KS X 1001 says ${c}`); });
  if (out[0]) fail("Gen 4 0x0400 should be unassigned");
  const extras = out.slice(0x0d61 - 0x400, 0x0d66 - 0x400);
  if (extras.join("") !== EXTRA_SYLLABLES.join("")) fail("Gen 4 extra syllables: " + extras.join(""));
  const jamo = out.slice(0x0d31 - 0x400, 0x0d52 - 0x400).join("");
  if (jamo.length !== 33 || !/^[\u3131-\u3163]+$/.test(jamo)) fail("Gen 4 jamo: " + jamo);
  for (let c = 0x0d2f; c <= 0x0d65; c++) {
    const inUse = (c >= 0x0d31 && c <= 0x0d51) || c >= 0x0d61;
    if (!!out[c - 0x400] !== inUse) fail(`Gen 4 ${hex(c)} should be ${inUse ? "assigned" : "empty"}`);
  }
  return { range: out, jamo };
}

/* ---------- pret charmaps ---------- */

function pretGb(text) {
  // charmap "X", $NN. Only the main font and the Japanese section count: the other sections list
  // tiles that particular screens load over those codes (the Fly map's ▲ at 0xED, ...).
  const intl = new Map(), ja = new Map();
  let section = "";
  for (const line of text.split("\n")) {
    const head = line.match(/^;\s*(.*)$/);
    if (head) { if (/^(Actual characters|Japanese|Control characters|Unown|ASCII)/.test(head[1])) section = head[1]; continue; }
    if (/newcharmap/.test(line)) section = "other";
    const m = line.match(/^\s*charmap\s+"((?:[^"\\]|\\.)*)",\s*\$([0-9a-f]{2})/i);
    if (!m) continue;
    const japanese = /^Japanese kana/.test(section);
    if (!japanese && !/font\/font\.png/.test(section)) continue;
    const map = japanese ? ja : intl, code = parseInt(m[2], 16);
    if (!map.has(code)) map.set(code, m[1]);
  }
  return { intl, ja };
}
function pretGba(text) {
  const w = new Map(), j = new Map();
  let jp = false;
  for (const line of text.split("\n")) {
    if (/^@ (Hiragana|Katakana|Japanese)/.test(line)) jp = true;
    if (/^@ string placeholders/.test(line)) break;
    const m = line.match(/^'((?:\\'|[^'])+)'\s*=\s*([0-9A-F]{2})\s*$/);
    if (!m) continue;
    const map = jp ? j : w, code = parseInt(m[2], 16), ch = m[1] === "\\'" ? "'" : m[1];
    if (!map.has(code)) map.set(code, ch);
  }
  return { w, j };
}
function pretNds(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^([0-9A-F]{4})=(.*)$/);
    if (m && !map.has(parseInt(m[1], 16))) map.set(parseInt(m[1], 16), m[2]);
  }
  return map;
}

/* Differences between our tables and the sources that are intentional: code -> reason. The keys
   are "<table>:<hex code>". Anything else that differs fails the build. */
const EXPECTED_DIFFS = {
  // Our cross-generation conventions for glyphs without a Unicode character.
  "gb:E1": "PK glyph = GLYPH.PK", "gb:E2": "MN glyph = GLYPH.MN",
  "gb:F0": "Pokédollar: pret ¥, we decode $ (Gen 4/5 store it as $) and accept ¥",
  "gb:F2": "decimal point <DOT> decodes as '.'",
  "gbja:E4": "handakuten: pret half-width ﾟ, we use ゜ U+309C (accepted both ways)",
  "gbja:E5": "dakuten: pret half-width ﾞ, we use ゛ U+309B (accepted both ways)",
  "gbja:75": "pret ⋯, we decode … (decode only)",
  "gba:AF": "pret ·, Bulbapedia ･ (what Pal Park/HOME expect); · accepted",
  "gba:B4": "pret ’, we decode the apostrophe as ' (Gen 4/5 do) and accept ’",
  "gba:B7": "Pokédollar: pret ¥, we decode $",
  "gba:EF": "pret ▶, Bulbapedia ►; both accepted",
  "gbaja:B0": "pret ⋯, we decode … (accepts ⋯ ‥)",
};

const STATS = { compared: 0, same: 0, expected: new Set() };
function compare(name, ours, theirs, only = () => true) {
  const problems = [];
  for (const [code, t] of theirs) {
    if (!only(code, t)) continue;
    const o = ours.get(code);
    if (o === undefined) continue;
    STATS.compared++;
    if (o === t) { STATS.same++; continue; }
    const key = `${name}:${code.toString(16).toUpperCase().padStart(2, "0")}`;
    if (EXPECTED_DIFFS[key]) STATS.expected.add(key);
    else problems.push(`${key} ours ${JSON.stringify(o)}, pret ${JSON.stringify(t)}`);
  }
  return problems;
}

/* ---------- output ---------- */

function jsString(s) {
  let o = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    o += ch === "\\" ? "\\\\" : ch === '"' ? '\\"' : cp < 0x20 ? "\\x" + cp.toString(16).padStart(2, "0") : ch;
  }
  return '"' + o + '"';
}
function writeModule(file, header, body) {
  const text = `/* GENERATED by scripts/build-text.mjs; do not edit. ${header} */\n${body}`;
  const dest = path.join(OUT, file);
  if (CHECK_ONLY) {
    if (!existsSync(dest) || readFileSync(dest, "utf8") !== text) fail(`${file} is out of date; run node scripts/build-text.mjs`);
    return;
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(dest, text);
}

async function main() {
  const src = {};
  for (const k of Object.keys(SOURCES)) src[k] = await fetchCached(k);
  const ks = ksx1001Syllables();

  // 1. Generated tables.
  const ko2 = buildKo2(src.ko2.text, ks);
  const { main: ce4, kor } = bulbapediaGen4(src.ce4.text);
  const h4 = buildHangul4(kor, ks);
  // pret's Gen 4 Hangul is the same list one code lower at 0x0400-0x040E (it has no 0x040F).
  const pt = pretNds(src.platinum.text);
  for (let c = 0x0401; c <= 0x0d65; c++) {
    if (c >= 0x0d31 && c <= 0x0d51) continue; // pret writes conjoining jamo (U+11xx): same letters
    const ours = h4.range[c - 0x400] || undefined;
    let theirs = pt.get(c <= 0x040f ? c - 1 : c);
    if (theirs && theirs.startsWith("{")) theirs = undefined;
    if (ours !== theirs) fail(`pret Gen 4 ${hex(c)}: ${theirs}, ours ${ours}`);
  }
  const shaNote = (keys) => keys.map((k) => `${SOURCES[k]} sha256 ${src[k].sha256}`).join("; ");
  const pageLines = [];
  for (let lead = 1; lead <= 0x0b; lead++) pageLines.push(`  ${jsString(ko2[lead].map((c) => c || "\0").join(""))}, // ${hex(lead, 2)}`);
  writeModule("ko2.js",
    `Korean Gold/Silver two-byte characters: KO2_PAGES[lead][trail], lead 0x01-0x0B, "\\0" = unused. ` +
    `From Bulbapedia (CC BY-NC-SA, facts only), checked against KS X 1001 order. ${shaNote(["ko2"])}`,
    `export const KO2_PAGES = [\n  null,\n${pageLines.join("\n")}\n];\n`);
  writeModule("hangul.js",
    `Hangul in the games' fonts: the 2,350 KS X 1001 syllables (in that order), the 5 extras, and the ` +
    `Gen 4 Korean code range. From Bulbapedia (CC BY-NC-SA, facts only), checked against the EUC-KR ` +
    `decoder and pret. ${shaNote(["ce4"])}`,
    `/** The 2,350 KS X 1001 Hangul syllables, in code order. */\n` +
    `export const KSX1001 = ${jsString(ks.join(""))};\n` +
    `/** Syllables the games add so every jamo pair can be typed. */\n` +
    `export const EXTRA_SYLLABLES = ${jsString(EXTRA_SYLLABLES.join(""))};\n` +
    `/** Gen 4 codes 0x0400-0x0D65 ("\\0" = unassigned). */\n` +
    `export const GEN4_KOREAN = ${jsString(h4.range.map((c) => c || "\0").join(""))};\n`);

  // 2. Hand-written tables against pret (and Gen 4 against Bulbapedia too).
  const problems = [];
  const gb = await import(path.join(ROOT, "shared/text/gb.js"));
  for (const [gen, p] of [[1, pretGb(src.red.text)], [2, pretGb(src.crystal.text)]]) {
    problems.push(...compare("gb", gb.TABLES[gen].en.dec, p.intl, (c) => c >= 0x7f));
    // pret's Japanese section only lists what differs from the English one.
    const ja = new Map([...p.intl].filter(([c]) => c >= 0xe9 && c !== 0xf2 && c !== 0xf4));
    for (const [c, t] of p.ja) ja.set(c, t);
    problems.push(...compare("gbja", gb.TABLES[gen].ja.dec, ja, (c, t) => !t.startsWith("<")));
  }
  if (!TABLES_ONLY) {
    const g3 = await import(path.join(ROOT, "shared/text/gen3.js"));
    const em = pretGba(src.emerald.text);
    problems.push(...compare("gba", g3.TABLES.en.dec, em.w));
    problems.push(...compare("gbaja", g3.TABLES.ja.dec, em.j));
    const g4 = await import(path.join(ROOT, "shared/text/gen4.js"));
    const t4 = g4.TABLE.dec;
    // Bulbapedia draws these as styled text; we use the shared GLYPH strings.
    const styled = { 0x01a5: "er", 0x01a6: "re", 0x01a7: "r", 0x01df: "e", 0x01e0: "PK", 0x01e1: "MN" };
    let faces = 0;
    for (const [code, t] of ce4) {
      if (code >= 0x1ed || !t || t === "␀") continue;
      const o = t4.get(code);
      if (t.startsWith("[img:")) {   // faces: the image's alt text is the emoji we use; pockets: stand-ins
        if (/^\[img:(.*?)\uFE0E?\]$/.test(t) && t.slice(5, -1).replace("\uFE0E", "") === o) faces++;
        continue;
      }
      if (styled[code] ? !(styled[code] === t && o) : o !== t) problems.push(`gen4 ${hex(code)}: ours ${JSON.stringify(o)}, Bulbapedia ${JSON.stringify(t)}`);
    }
    if (faces !== 14) problems.push(`gen4: ${faces} face glyphs match Bulbapedia's alt text, expected 14`);
    for (const [code, t] of pt) {
      if (code === 0 || code >= 0x1ed || t.startsWith("{")) continue;
      const o = t4.get(code);
      if (o === undefined) continue;
      STATS.compared++;
      const listed = g4.PRET_DIFFS.includes(code);
      if (o === t) { STATS.same++; if (listed) problems.push(`gen4 ${hex(code)}: in PRET_DIFFS but equals pret`); }
      else if (!listed) problems.push(`gen4 ${hex(code)}: ours ${JSON.stringify(o)}, pret ${JSON.stringify(t)}`);
    }
  }
  if (!TABLES_ONLY) for (const k of Object.keys(EXPECTED_DIFFS)) if (!STATS.expected.has(k)) problems.push(`${k}: listed in EXPECTED_DIFFS but no longer differs`);
  if (problems.length) fail("table differences not listed as intentional:\n  " + problems.join("\n  "));
  console.log(`build-text: ${STATS.compared} codes compared with pret, ${STATS.same} identical, ${STATS.expected.size} intentional differences`);
  console.log(CHECK_ONLY ? "build-text: tables are up to date and consistent" : "build-text: wrote shared/text/tables/ko2.js, hangul.js; cross-checks passed");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
