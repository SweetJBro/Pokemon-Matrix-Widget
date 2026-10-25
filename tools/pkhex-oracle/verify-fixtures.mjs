// Verifies the PKHeX-derived fixtures in test/fixtures against their specs and against PKHeX
// itself. Development only: needs the oracle built in Release (make-fixtures.sh does that).
//
//   node tools/pkhex-oracle/verify-fixtures.mjs
//
// For every save spec it checks that PKHeX reports valid checksums, that every Pokémon, the
// trainer and the Pokédex match the spec, that re-dumping the committed .sav reproduces the
// committed .expected.json byte for byte, and that loading + re-saving the file in PKHeX changes
// nothing. Records, conversions and modified saves are re-generated and compared.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(ROOT);
const TOOL = "tools/pkhex-oracle";
const DLL = join(TOOL, "bin/Release/net8.0/pkhex-oracle.dll");
const SAVES = "test/fixtures/saves";
const RECORDS = "test/fixtures/records";
const CONVERT = "test/fixtures/convert";
process.env.PKHEX_ORACLE_NOW ??= "2010-01-01";

// Saves where PKHeX itself reports a checksum failure, with the reason.
const KNOWN_CHECKSUM_FAILURES = {
  "gold-ko": "PKHeX 24.7.27 writes the Korean 'oddball' backup checksum at 0x7E6B but validates checksum 2 against the main-region sum",
};

// PKHeX's version name for a save of each spec game (it cannot tell Red from Blue or Gold from Silver).
const VERSION = { RD: "RB", GN: "RB", BU: "RB", YW: "YW", GD: "GS", SI: "GS", C: "C", R: "RS", S: "RS", E: "E", FR: "FR", LG: "LG", D: "DP", P: "DP", Pt: "Pt", HG: "HGSS", SS: "HGSS", B: "B", W: "W", B2: "B2", W2: "W2" };
const LANG = { ja: 1, en: 2, fr: 3, it: 4, de: 5, es: 7, ko: 8 };
const NATURES = ["Hardy", "Lonely", "Brave", "Adamant", "Naughty", "Bold", "Docile", "Relaxed", "Impish", "Lax", "Timid", "Hasty", "Serious", "Jolly", "Naive", "Modest", "Mild", "Quiet", "Bashful", "Rash", "Calm", "Gentle", "Sassy", "Careful", "Quirky"];

let failures = 0;
let checks = 0;
const fail = (msg) => { failures++; console.error("FAIL " + msg); };
const check = (cond, msg) => { checks++; if (!cond) fail(msg); };
const eq = (actual, expected, msg) => {
  checks++;
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    fail(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const oracle = (...args) => execFileSync("dotnet", [DLL, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ------------------------------------------------------------------ spec expansion (mirrors Builder.cs)

function merge(a, b) { return { ...structuredClone(a ?? {}), ...structuredClone(b ?? {}) }; }

function placements(spec) {
  const defaults = spec.defaults ?? {};
  const out = [];
  for (const b of spec.boxes ?? []) out.push(merge(defaults, b));
  for (const f of spec.fill ?? []) {
    const template = merge(defaults, f.template);
    for (let i = 0; i < f.count; i++) {
      const m = structuredClone(template);
      m.box = f.box;
      m.slot = (f.start ?? 0) + i;
      if (f.species) m.species = f.species[i % f.species.length];
      else if (f.speciesStart !== undefined) m.species = f.speciesStart + i;
      if (f.shuffleOrders) m.shuffleOrder = i % 24;
      if (f.levelStep) m.level = (m.level ?? 5) + i * f.levelStep;
      out.push(m);
    }
  }
  return out;
}

const genOf = (game) => ({ RD: 1, GN: 1, BU: 1, YW: 1, GD: 2, SI: 2, C: 2, R: 3, S: 3, E: 3, FR: 3, LG: 3, D: 4, P: 4, Pt: 4, HG: 4, SS: 4, B: 5, W: 5, B2: 5, W2: 5 })[game];
const genderValue = (g) => typeof g === "number" ? g : ({ M: 0, F: 1 })[String(g).toUpperCase()];

function checkMon(where, s, m, ctx) {
  const { gen, trainer, lang } = ctx;
  eq(m.species, s.species, `${where} species`);
  eq(m.checksumValid, true, `${where} entity checksum`);
  if (s.form !== undefined) eq(m.form, s.form, `${where} form`);
  const isEgg = s.isEgg ?? false;
  eq(m.isEgg, isEgg, `${where} isEgg`);
  if (s.level !== undefined) eq(m.level, s.level, `${where} level`);
  if (s.exp !== undefined) eq(m.exp, s.exp, `${where} exp`);
  if (s.nickname !== undefined) {
    eq(m.nickname, s.nickname, `${where} nickname`);
    if (!isEgg) eq(m.isNicknamed, true, `${where} isNicknamed`);
  } else if (!isEgg) {
    eq(m.isNicknamed, false, `${where} isNicknamed (default species name)`);
  }
  const moves = [...(s.moves ?? [33])];
  while (moves.length < 4) moves.push(0);
  eq(m.moves.map((x) => x.id), moves, `${where} moves`);
  if (s.ppUps) eq(m.moves.map((x) => x.ppUps), [...s.ppUps, 0, 0, 0, 0].slice(0, 4).map((u, i) => (moves[i] ? u : 0)), `${where} ppUps`);
  if (s.pp) eq(m.moves.map((x) => x.pp).slice(0, s.pp.length), s.pp, `${where} pp`);

  if (gen <= 2) {
    const dv = s.dvs ?? s.ivs;
    if (dv) for (const k of ["atk", "def", "spe"]) eq(m.dvs[k], dv[k], `${where} dv.${k}`);
    if (dv && (dv.spc ?? dv.spa) !== undefined) eq(m.dvs.spc, dv.spc ?? dv.spa, `${where} dv.spc`);
    const se = s.statExp ?? s.evs;
    if (se) for (const k of ["hp", "atk", "def", "spe"]) eq(m.statExp[k], se[k] ?? 0, `${where} statExp.${k}`);
    if (se) eq(m.statExp.spc, se.spc ?? se.spa ?? 0, `${where} statExp.spc`);
    if (gen === 1) {
      if (s.catchRate !== undefined) eq(m.extra.catchRate, s.catchRate, `${where} catchRate`);
    } else {
      eq(m.heldItem, s.heldItem ?? 0, `${where} heldItem`);
      if (s.metLevel !== undefined) eq(m.met.level, s.metLevel, `${where} caught level`);
      if (s.metLocation !== undefined) eq(m.met.location, s.metLocation, `${where} caught location`);
      if (s.metTimeOfDay !== undefined) eq(m.met.timeOfDay, s.metTimeOfDay, `${where} caught time of day`);
      if (s.friendship !== undefined) eq(m.friendship, s.friendship, `${where} friendship`);
      if (s.pokerus) eq(m.pokerus, s.pokerus, `${where} pokerus`);
      if (isEgg) eq(m.listSpecies, 0xFD, `${where} list header egg marker`);
    }
    eq(m.isShiny, s.shiny ?? false, `${where} shiny (DV-derived)`);
    if (s.gender !== undefined && gen === 2) eq(m.gender, genderValue(s.gender), `${where} gender (DV-derived)`);
  } else {
    const iv = s.ivs ?? { hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 };
    for (const k of ["hp", "atk", "def", "spa", "spd", "spe"]) eq(m.ivs[k], iv[k] ?? ({ hp: 1, atk: 2, def: 3, spa: 4, spd: 5, spe: 6 })[k], `${where} iv.${k}`);
    const ev = s.evs ?? {};
    for (const k of ["hp", "atk", "def", "spa", "spd", "spe"]) eq(m.evs[k], ev[k] ?? 0, `${where} ev.${k}`);
    if (s.nature !== undefined) eq(m.natureName, typeof s.nature === "number" ? NATURES[s.nature] : s.nature, `${where} nature`);
    if (s.abilityNumber !== undefined) eq(m.abilityNumber, s.abilityNumber, `${where} abilityNumber`);
    eq(m.heldItem, s.heldItem ?? 0, `${where} heldItem`);
    eq(m.isShiny, s.shiny ?? false, `${where} shiny`);
    if (s.gender !== undefined) eq(m.gender, genderValue(s.gender), `${where} gender`);
    if (s.pid !== undefined) eq(m.pid, Number(s.pid), `${where} pid`);
    if (s.shuffleOrder !== undefined) eq(m.shuffleOrder, s.shuffleOrder, `${where} substructure order`);
    eq(m.met.ball, s.ball ?? 4, `${where} ball`);
    eq(m.met.location, s.metLocation ?? 0, `${where} met location`);
    if (s.metLevel !== undefined) eq(m.met.level, s.metLevel, `${where} met level`);
    if (s.metVersion !== undefined) eq(m.met.versionName, s.metVersion, `${where} origin game`);
    else eq(m.met.versionName, ctx.origin, `${where} origin game`);
    if (gen >= 4) {
      eq(m.met.date, s.metDate ?? (isEgg ? s.eggDate : undefined) ?? "2010-01-01", `${where} met date`);
      if (s.eggLocation !== undefined) {
        eq(m.egg.location, s.eggLocation, `${where} egg location`);
        eq(m.egg.date, s.eggDate ?? s.metDate ?? "2010-01-01", `${where} egg date`);
      }
    }
    if (s.friendship !== undefined) eq(m.friendship, s.friendship, `${where} friendship`);
    if (s.pokerus) eq(m.pokerus, s.pokerus, `${where} pokerus`);
    if (s.markings !== undefined) eq(m.markingsRaw, s.markings, `${where} markings (raw byte)`);
    eq(m.fatefulEncounter, s.fatefulEncounter ?? false, `${where} fateful encounter`);
    if (s.contest) for (const [k, v] of Object.entries(s.contest)) eq(m.contest[k], v, `${where} contest.${k}`);
    if (s.ribbons) {
      const want = Array.isArray(s.ribbons)
        ? s.ribbons
        : Object.entries(s.ribbons).filter(([, v]) => v).map(([k, v]) => (v === true ? k : `${k}=${v}`));
      eq([...m.ribbons].sort(), [...want].sort(), `${where} ribbons`);
    }
    if (s.nSparkle !== undefined) eq(m.extra.nSparkle, s.nSparkle, `${where} N's sparkle`);
    if (s.pokeStarFame !== undefined) eq(m.extra.pokeStarFame, s.pokeStarFame, `${where} PokéStar fame`);
    if (gen === 3 && isEgg) eq([m.language, m.nickname], [1, "タマゴ"], `${where} Gen 3 egg language/name`);
    const wantLang = isEgg && gen === 3 ? 1 : s.language !== undefined ? (typeof s.language === "number" ? s.language : LANG[s.language]) : LANG[lang];
    eq(m.language, wantLang, `${where} language`);
  }

  // OT (eggs keep the trainer's data too)
  if (!(gen === 3 && isEgg)) eq(m.ot.name, s.otName ?? trainer.name, `${where} OT name`);
  eq(m.ot.tid, s.tid ?? trainer.tid, `${where} TID`);
  if (gen >= 3) eq(m.ot.sid, s.sid ?? trainer.sid, `${where} SID`);
  if (gen >= 3) eq(m.ot.gender, s.otGender ?? trainer.gender ?? 0, `${where} OT gender`);
}

function verifySave(specPath) {
  const spec = readJson(specPath);
  const id = basename(specPath, ".json");
  const sav = join(SAVES, `${id}.sav`);
  const exp = join(SAVES, `${id}.expected.json`);
  if (!existsSync(sav) || !existsSync(exp)) return fail(`${id}: fixture missing (run make-fixtures.sh)`);
  const d = readJson(exp);
  const gen = genOf(spec.game);

  eq(d.file.sha256, sha256(sav), `${id} expected.json describes this .sav`);
  check(oracle("dump", sav) === readFileSync(exp, "utf8"), `${id}: re-dumping the .sav does not reproduce expected.json`);
  const rt = JSON.parse(oracle("roundtrip", sav));
  check(rt.bytesIdentical && rt.dumpIdentical, `${id}: PKHeX load + re-save changed the file (${rt.differingBytes} bytes)`);

  if (KNOWN_CHECKSUM_FAILURES[id]) eq(d.checksumsValid, false, `${id} known PKHeX checksum verdict (${KNOWN_CHECKSUM_FAILURES[id]})`);
  else eq(d.checksumsValid, true, `${id} checksumsValid (${d.checksumInfo})`);
  eq(d.generation, gen, `${id} generation`);
  eq(d.version, VERSION[spec.game], `${id} version`);
  eq(d.japanese, gen <= 3 && spec.lang === "ja", `${id} Japanese layout flag`);
  eq(d.korean, gen === 2 && spec.lang === "ko", `${id} Korean layout flag`);
  if (gen >= 4) eq(d.language, LANG[spec.lang], `${id} save language`);

  const t = spec.trainer ?? {};
  eq(d.trainer.name, t.name, `${id} trainer name`);
  eq(d.trainer.tid, t.tid, `${id} trainer TID`);
  if (gen >= 3) eq(d.trainer.sid, t.sid, `${id} trainer SID`);
  if (t.gender !== undefined && (gen >= 3 || spec.game === "C")) eq(d.trainer.gender, t.gender, `${id} trainer gender`);
  if (t.money !== undefined) eq(d.trainer.money, t.money, `${id} money`);
  if (t.playTime) eq(d.trainer.playTime, t.playTime, `${id} play time`);
  eq(d.currentBox, spec.currentBox ?? 0, `${id} current box`);

  const ctx = { gen, lang: spec.lang, origin: { RD: "RD", YW: "YW", GD: "GD", C: "C" }[spec.game] ?? spec.game, trainer: { name: t.name, tid: t.tid, sid: t.sid, gender: t.gender ?? 0 } };
  const party = spec.party ?? [];
  eq(d.partyCount, party.length, `${id} party count`);
  party.forEach((s, i) => d.party[i] && checkMon(`${id} party[${i}]`, merge(spec.defaults, s), d.party[i], ctx));

  const places = placements(spec);
  if (gen <= 2) {
    // Packed lists: within a box, entries keep their slot order and are numbered from 0.
    const byBox = new Map();
    for (const p of places) byBox.set(p.box, [...(byBox.get(p.box) ?? []), p]);
    for (const list of byBox.values()) list.sort((a, b) => a.slot - b.slot).forEach((p, i) => (p.slot = i));
    for (const [box, list] of byBox) eq(d.gb.boxListCounts[box], list.length, `${id} box ${box} list count`);
  }
  eq(d.boxes.length, places.length, `${id} number of boxed Pokémon`);
  for (const p of places) {
    const m = d.boxes.find((x) => x.box === p.box && x.slot === p.slot);
    if (!m) { fail(`${id}: nothing at box ${p.box} slot ${p.slot}`); continue; }
    checkMon(`${id} box ${p.box} slot ${p.slot}`, p, m, ctx);
  }

  if (spec.registerDex ?? true) {
    const all = [...party.map((s) => merge(spec.defaults, s)), ...places];
    for (const s of all.filter((x) => !x.isEgg)) {
      check(d.pokedex.caught.includes(s.species), `${id}: species ${s.species} not registered as caught`);
      check(d.pokedex.seen.includes(s.species), `${id}: species ${s.species} not registered as seen`);
    }
    const expectedDex = new Set(all.filter((x) => !x.isEgg).map((x) => x.species));
    eq([...d.pokedex.caught].sort((a, b) => a - b), [...expectedDex].sort((a, b) => a - b), `${id} caught list has exactly the non-egg species`);
  }
  console.log(`ok   ${id}`);
}

function verifyModified(opsPath) {
  const id = basename(opsPath, ".json");
  const ops = readJson(opsPath).ops;
  const sav = join(SAVES, `${id}.modified.sav`);
  const exp = join(SAVES, `${id}.modified.expected.json`);
  if (!existsSync(sav) || !existsSync(exp)) return fail(`${id}.modified: fixture missing`);
  const before = readJson(join(SAVES, `${id}.expected.json`));
  const d = readJson(exp);
  eq(d.file.sha256, sha256(sav), `${id}.modified expected.json describes this .sav`);
  check(oracle("dump", sav) === readFileSync(exp, "utf8"), `${id}.modified: re-dump differs from expected.json`);
  const rt = JSON.parse(oracle("roundtrip", sav));
  if (d.generation <= 2) {
    // PKHeX writes its blank entity (with party stats and 0x50-filled names) into a vacated
    // Gen 1/2 list entry, but reads unused entries back as zeros, so the bytes after the last
    // used list entry are not stable across a PKHeX load/save. The decoded save must be.
    check(rt.dumpIdentical, `${id}.modified: PKHeX re-save changed the decoded save`);
    if (!rt.bytesIdentical) console.log(`note ${id}.modified: ${rt.differingBytes} bytes in unused list entries (and the checksum) change on a PKHeX re-save`);
  } else {
    check(rt.bytesIdentical && rt.dumpIdentical, `${id}.modified: PKHeX re-save changed the file`);
  }
  eq(d.checksumsValid, true, `${id}.modified checksumsValid`);
  let party = before.partyCount;
  for (const op of ops) {
    if (op.op === "deleteParty") party--;
    if (op.op === "setParty") party++;
    if (op.op === "setCurrentBox") eq(d.currentBox, op.box, `${id}.modified current box`);
    if (op.op === "deleteBox" && d.generation >= 3) check(!d.boxes.some((x) => x.box === op.box && x.slot === op.slot), `${id}.modified: box ${op.box} slot ${op.slot} not empty`);
    if (op.op === "setBox") {
      const hex = readFileSync(op.hexFile, "utf8").trim();
      const hit = d.generation >= 3
        ? d.boxes.find((x) => x.box === op.box && x.slot === op.slot)
        : d.boxes.find((x) => x.box === op.box && x.recordHex === hex);
      check(hit && hit.recordHex === hex, `${id}.modified: record from ${op.hexFile} not stored verbatim in box ${op.box}`);
    }
    if (op.op === "setParty") {
      const hex = readFileSync(op.hexFile, "utf8").trim();
      check(d.party.some((x) => x.recordHex === hex), `${id}.modified: party does not contain ${op.hexFile}`);
    }
  }
  eq(d.partyCount, party, `${id}.modified party count`);
  console.log(`ok   ${id}.modified`);
}

function verifyRecords() {
  for (const f of readdirSync(RECORDS).filter((x) => x.endsWith(".hex")).sort()) {
    const name = basename(f, ".hex");
    const fmt = name.split("-")[0];
    const hex = readFileSync(join(RECORDS, f), "utf8").trim();
    const flags = name === "pk2-togepi-egg" ? ["--egg"] : [];
    const out = oracle("pkm", fmt, hex, ...flags);
    check(out === readFileSync(join(RECORDS, `${name}.json`), "utf8"), `record ${name}: pkm output differs from committed JSON`);
    const j = JSON.parse(out);
    eq(j.pkm.recordHex, hex, `record ${name}: recordHex round-trips`);
    check(j.pkm.checksumValid, `record ${name}: entity checksum invalid`);
  }
  console.log("ok   records");
}

function verifyConversions() {
  for (const f of readdirSync(CONVERT).filter((x) => x.endsWith(".json")).sort()) {
    const j = readJson(join(CONVERT, f));
    const out = oracle("convert", j.from, j.to, j.input.recordHex);
    check(out === readFileSync(join(CONVERT, f), "utf8"), `convert ${f}: output not reproducible`);
    if (f.includes("-fails")) eq(j.ok, false, `convert ${f}: expected failure`);
    else eq(j.ok, true, `convert ${f}: expected success (${j.result})`);
  }
  console.log("ok   conversions");
}

for (const f of readdirSync(join(TOOL, "specs")).filter((x) => x.endsWith(".json")).sort()) verifySave(join(TOOL, "specs", f));
for (const f of readdirSync(join(TOOL, "specs", "ops")).filter((x) => x.endsWith(".json")).sort()) verifyModified(join(TOOL, "specs", "ops", f));
verifyRecords();
verifyConversions();

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
