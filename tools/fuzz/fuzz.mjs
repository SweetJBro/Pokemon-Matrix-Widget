#!/usr/bin/env node
/* Differential fuzzing of the save editors against PKHeX (development only; needs the .NET 8
   SDK and a built tools/pkhex-oracle).

   Read direction: random but well-formed Pokémon (species, forms, levels, moves, IVs/DVs,
   EVs/Stat Exp, natures, abilities, items, eggs, nicknames in the save's languages, shininess,
   other OTs, balls, Pokérus...) are written into saves by PKHeX (`oracle build`); our openSave
   must read every party and box slot exactly as PKHeX's `dump` does, and build(parse(r)) must give
   the stored bytes back.

   Write direction: our SaveFile takes, puts (records from other random saves of the same format),
   moves Pokémon and registers Pokédex entries at random, serializes, and PKHeX must then report
   valid checksums and exactly the contents our model expects, with nothing else changed.

     node tools/fuzz/fuzz.mjs [--seed N] [--saves N] [--mons N] [--ops N] [--only red-en,emerald-en] [--out DIR]

   Every failing case is written to --out (default: a temp dir) as spec + save for reproduction. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DLL = path.join(ROOT, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
const { openSave } = await import(path.join(ROOT, "shared/saves/index.js"));
const D = await import(path.join(ROOT, "shared/data/index.js"));
const { CODECS } = await import(path.join(ROOT, "shared/pkm/index.js"));
const { hex } = await import(path.join(ROOT, "shared/bytes.js"));

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? process.argv[i + 1] : d; };
const SEED = Number(arg("seed", 1)), SAVES = Number(arg("saves", 3)), MONS = Number(arg("mons", 50)), OPS = Number(arg("ops", 40));
const ONLY = arg("only", "") ? new Set(arg("only").split(",")) : null;
const OUT = arg("out", fs.mkdtempSync(path.join(os.tmpdir(), "pmw-fuzz-")));
fs.mkdirSync(OUT, { recursive: true });
/** Runs the oracle; a failure throws PKHeX's own error message (the oracle prints JSON with ok:false). */
function run(args) {
  try { return execFileSync("dotnet", [DLL, ...args], { cwd: ROOT, maxBuffer: 1 << 28, env: { ...process.env, PKHEX_ORACLE_NOW: "2010-01-01" } }).toString(); }
  catch (e) {
    let msg = String(e.stdout || "");
    try { msg = JSON.parse(msg).error ?? msg; } catch { /* not JSON */ }
    throw new Error(`oracle ${args[0]}: ${msg.slice(0, 400) || e.message}`);
  }
}
const oracle = (...a) => JSON.parse(run(a));

/* ---------- seeded randomness ---------- */
let state = SEED >>> 0 || 1;
const rnd = () => { state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0; return state / 2 ** 32; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;

/* ---------- what each layout allows ---------- */
const BASES = fs.readdirSync(path.join(ROOT, "tools/pkhex-oracle/specs")).filter((n) => n.endsWith(".json"))
  .map((n) => JSON.parse(fs.readFileSync(path.join(ROOT, "tools/pkhex-oracle/specs", n), "utf8")))
  .filter((s) => !ONLY || ONLY.has(s.id));
// Spec "game" values are PKHeX GameVersion names ("R" is Ruby, "B" is Black).
const GEN_OF = { RD: 1, GN: 1, BU: 1, YW: 1, GD: 2, SI: 2, C: 2, R: 3, S: 3, E: 3, FR: 3, LG: 3, D: 4, P: 4, Pt: 4, HG: 4, SS: 4, B: 5, W: 5, B2: 5, W2: 5 };
const genOf = (spec) => { const g = GEN_OF[spec.game]; if (!g) throw new Error(`unknown game "${spec.game}" in spec ${spec.id}`); return g; };
const NICKS = {
  en: ["SPARKY", "Bob", "MAX", "Zed-9", "A.B.C"], fr: ["ÉCLAIR", "Zoé", "Noël"], de: ["BLITZ", "Jäger", "Größe"],
  it: ["FULMINE", "Città"], es: ["RAYO", "Peña", "Ñu"], ja: ["ピカ", "ゴン", "たろう"], ko: ["번개", "꼬마"],
};
const OTS = { en: ["ASH", "GARY", "Leaf"], fr: ["SACHA"], de: ["MAX"], it: ["ASH"], es: ["ROJO"], ja: ["サトシ", "シゲル"], ko: ["지우"] };
const MAIL = { 2: (i) => i >= 0x9e && i <= 0xbd, 3: (i) => i >= 121 && i <= 132, 4: (i) => i >= 137 && i <= 148, 5: (i) => i >= 137 && i <= 148 };

function itemsFor(gen, game) {
  // Emerald's 375/376 exist in the game, but PKHeX's builder stops at 374.
  const max = gen === 3 ? (/^(R|S)$/.test(game) ? 348 : 374) : gen === 4 ? (/^(D|P)$/.test(game) ? 464 : game === "Pt" ? 467 : 536) : gen === 5 ? (/^(B2|W2)$/.test(game) ? 638 : 632) : 255;
  const out = [];
  for (let i = 1; i <= max; i++) if (D.itemToNational(gen, i) && !MAIL[gen]?.(i)) out.push(i);
  return out;
}

function randomMon(gen, spec, { egg = true } = {}) {
  const maxSp = D.MAX_SPECIES[gen];
  const species = int(1, maxSp);
  const m = { species, level: int(2, 100) };
  const forms = (D.formsOf(species, gen) || []).filter((f) => !f.battleOnly);
  if (forms.length > 1 && gen >= 3) m.form = pick(forms).form;
  const nMoves = int(1, 4), moves = new Set();
  while (moves.size < nMoves) moves.add(int(1, D.MAX_MOVE[gen]));
  m.moves = [...moves];
  m.ppUps = m.moves.map(() => int(0, 3));
  if (gen <= 2) {
    m.dvs = { atk: int(0, 15), def: int(0, 15), spe: int(0, 15), spc: int(0, 15) };
    m.statExp = { hp: int(0, 65535), atk: int(0, 65535), def: int(0, 65535), spe: int(0, 65535), spc: int(0, 65535) };
  } else {
    m.ivs = Object.fromEntries(["hp", "atk", "def", "spa", "spd", "spe"].map((k) => [k, int(0, 31)]));
    let left = 510;
    m.evs = Object.fromEntries(["hp", "atk", "def", "spa", "spd", "spe"].map((k) => { const v = Math.min(left, int(0, 255)); left -= v; return [k, v]; }));
    m.nature = int(0, 24);
    m.abilityNumber = gen === 5 && chance(0.15) ? 2 : int(0, 1);
    m.ball = int(1, gen === 3 ? 12 : gen === 4 ? (spec.game.startsWith("H") ? 24 : 16) : 25);
    if (chance(0.5)) m.language = pick(gen === 3 ? ["en", "fr", "de", "it", "es", "ja"] : ["en", "fr", "de", "it", "es", "ja", "ko"]);
    if (chance(0.3)) m.markings = int(0, gen === 3 ? 15 : 63);
    if (chance(0.1)) m.pokerus = { strain: int(1, 15), days: int(0, 4) };
    if (chance(0.2)) m.fatefulEncounter = true;
  }
  if (gen >= 2 && chance(0.4)) m.heldItem = pick(itemsFor(gen, spec.game));
  if (gen >= 2) m.friendship = int(0, 255);
  if (gen === 1 && chance(0.3)) m.catchRate = int(0, 255);
  if (chance(0.12)) m.shiny = true;
  const ratio = D.genderThreshold(species);
  if (ratio > 0 && ratio < 254 && chance(0.7)) m.gender = pick(["M", "F"]);
  const lang = m.language ?? spec.lang;
  if (chance(0.35)) m.nickname = pick(NICKS[lang] ?? NICKS.en).slice(0, lang === "ja" || lang === "ko" ? 5 : 10);
  // A Pokémon of another language came from a game of that language, so its OT is from there too
  // (games write their own catches with their own language; PKHeX would otherwise build an
  // Italian Pokémon with a Japanese-charset OT, which no game produces).
  if (chance(0.25) || lang !== spec.lang) { m.otName = pick(OTS[lang] ?? OTS.en); m.tid = int(0, 65535); if (gen >= 3) m.sid = int(0, 65535); }
  // Gen 1/2 shininess and gender are DV-derived: ask for one or the other, not contradicting both.
  if (gen <= 2 && (m.shiny || m.gender)) delete m.dvs;
  if (gen === 2 && m.shiny) delete m.gender;   // shininess pins the Attack DV, which decides gender
  if (gen === 2 && species === 201) delete m.dvs;   // the Unown letter comes from the DVs too
  // Constraints PKHeX's PID/DV search can't satisfy together (not limits of our code):
  if (gen === 3 && species === 201) { delete m.nature; delete m.abilityNumber; }
  if (gen === 2 && species === 201) delete m.shiny;
  if (egg && gen >= 2 && chance(0.06)) { m.isEgg = true; delete m.nickname; delete m.heldItem; }
  return m;
}

/** A spec for one random save of a layout: a party of up to 6 and `n` Pokémon spread over the boxes. */
function randomSpec(base, n, k) {
  const gen = genOf(base);
  const spec = { ...base, id: `${base.id}-fuzz-${SEED}-${k}`, registerDex: chance(0.5), party: [], boxes: [], fill: [] };
  delete spec.dexSeen; delete spec.dexCaught;
  const partyN = int(1, 6);
  for (let i = 0; i < partyN; i++) spec.party.push(randomMon(gen, base, { egg: i > 0 }));
  const boxCount = { 1: base.lang === "ja" ? 8 : 12, 2: base.lang === "ja" ? 9 : 14, 3: 14, 4: 18, 5: 24 }[gen];
  const cap = { 1: base.lang === "ja" ? 30 : 20, 2: base.lang === "ja" ? 30 : 20, 3: 30, 4: 30, 5: 30 }[gen];
  const used = new Set();
  for (let i = 0; i < n; i++) {
    const box = int(0, boxCount - 1), slot = gen <= 2 ? i % cap : int(0, cap - 1);
    const key = `${box}:${slot}`;
    if (used.has(key)) continue;
    used.add(key);
    spec.boxes.push({ box, slot, ...randomMon(gen, base) });
  }
  spec.currentBox = int(0, boxCount - 1);
  return spec;
}

/* ---------- comparing our reading with PKHeX's ---------- */
const GENDER = { M: 0, F: 1 };
function compareMon(where, ours, theirs, problems) {
  const v = ours.view, t = theirs;
  const gen = v.gen;
  const want = {
    recordHex: t.recordHex, species: t.species, isEgg: t.isEgg, level: t.isEgg ? undefined : t.level, exp: t.exp,
    moves: t.moves.filter((m) => m.id).map((m) => [m.id, m.ppUps]),
    friendship: gen >= 2 ? t.friendship : undefined,
    tid: t.ot.tid, otName: t.ot.name.replace(/\u2024/g, "."),
  };
  const got = {
    recordHex: hex(ours.record), species: v.species, isEgg: v.isEgg, level: v.isEgg ? undefined : v.level, exp: v.exp,
    moves: v.moves.map((m) => [m.id, m.ppUps]),
    friendship: gen >= 2 ? v.friendship : undefined,
    tid: v.ot.tid, otName: v.ot.name,
  };
  // PKHeX shows the Gen 1/2 dot tile as U+2024; the bytes are compared exactly in recordHex.
  // and the apostrophe as U+2019 where we use '. Neither changes a byte.
  const dot = (x) => (typeof x === "string" ? x.replace(/\u2024/g, ".").replace(/\u2019/g, "'") : x);
  if (!t.isEgg) { want.nickname = dot(t.nickname); got.nickname = dot(v.nickname); want.shiny = t.isShiny; got.shiny = v.shiny; }
  if (gen <= 2) {
    want.dvs = [t.dvs?.atk ?? t.ivs.atk, t.dvs?.def ?? t.ivs.def, t.dvs?.spe ?? t.ivs.spe, t.dvs?.spc ?? t.ivs.spa];
    got.dvs = [v.dvs.atk, v.dvs.def, v.dvs.spe, v.dvs.spc];
  } else {
    want.pid = t.pid >>> 0; got.pid = v.pid >>> 0;
    want.ivs = t.ivs; got.ivs = v.ivs;
    want.evs = t.evs; got.evs = v.evs;
    want.nature = t.nature; got.nature = v.natureId;
    want.sid = t.ot.sid; got.sid = v.ot.sid;
    want.ball = t.met?.ball; got.ball = v.ballId;
    // Gen 3 stores no Deoxys form: the game draws its own forme (Speed in Emerald). PKHeX says 0.
    const deoxys3 = gen === 3 && t.species === 386;
    if (!t.isEgg && !deoxys3) { want.form = t.form; got.form = v.form; }
    if (!t.isEgg) { want.gender = t.gender; got.gender = v.gender == null ? 2 : GENDER[v.gender]; }
    want.heldItem = t.heldItem || 0; got.heldItem = v.heldItemId || 0;
    want.language = t.languageCode; got.language = v.lang;
  }
  if (gen === 2) { want.heldItem = t.heldItem || 0; got.heldItem = v.heldItemId || 0; if (!t.isEgg) { want.form = t.form; got.form = v.form; } }
  for (const k of Object.keys(want)) {
    if (JSON.stringify(want[k]) !== JSON.stringify(got[k])) problems.push(`${where} ${t.speciesName}: ${k} ours ${JSON.stringify(got[k])} PKHeX ${JSON.stringify(want[k])}`);
  }
  // Lossless: build(parse(record)) gives the record back.
  const c = CODECS[ours.meta.format];
  const again = hex(c.build(c.parse(ours.record, ours.meta), ours.meta));
  if (again !== hex(ours.record)) problems.push(`${where} ${t.speciesName}: build(parse(r)) changed the record`);
}

function compareSave(save, dump, label, problems) {
  if (!dump.checksumsValid && !/Checksum 2 Invalid/.test(dump.checksumInfo || "")) problems.push(`${label}: PKHeX says checksums invalid: ${dump.checksumInfo}`);
  const party = save.party();
  if (party.length !== dump.party.length) problems.push(`${label}: party ${party.length} vs PKHeX ${dump.party.length}`);
  dump.party.forEach((t, i) => party[i] && compareMon(`${label} party ${i}`, party[i], t, problems));
  let count = 0;
  for (let b = 0; b < save.boxCount; b++) count += save.box(b).filter(Boolean).length;
  if (count !== dump.boxes.length) problems.push(`${label}: ${count} boxed vs PKHeX ${dump.boxes.length}`);
  for (const t of dump.boxes) {
    const ours = save.box(t.box)[t.slot];
    if (!ours) { problems.push(`${label} box ${t.box}:${t.slot}: empty for us, PKHeX has ${t.speciesName}`); continue; }
    compareMon(`${label} box ${t.box}:${t.slot}`, ours, t, problems);
  }
}

/* ---------- run ---------- */
const report = [];
const pool = new Map();   // format:lang -> [{ record, meta }] for the write direction
for (const base of BASES) {
  const gen = genOf(base);
  const problems = [], built = [];
  for (let k = 0; k < SAVES; k++) {
    const spec = randomSpec(base, MONS, k);
    const specFile = path.join(OUT, spec.id + ".json"), savFile = path.join(OUT, spec.id + ".sav");
    fs.writeFileSync(specFile, JSON.stringify(spec, null, 1));
    let dump;
    try { oracle("build", specFile, savFile); dump = oracle("dump", savFile); }
    catch (e) { problems.push(`${spec.id}: ${e.message}`); continue; }
    let save;
    try { save = await openSave(new Uint8Array(fs.readFileSync(savFile)), path.basename(savFile)); }
    catch (e) { problems.push(`${spec.id}: openSave failed: ${e.message}`); continue; }
    const before = problems.length;
    compareSave(save, dump, spec.id, problems);
    if (problems.length > before) fs.writeFileSync(path.join(OUT, spec.id + ".read-problems.txt"), problems.slice(before).join("\n"));
    built.push({ spec, savFile });
    for (let b = 0; b < save.boxCount; b++) for (const e of save.box(b)) if (e) {
      const key = `${e.meta.format}:${e.meta.lang}`;
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push({ record: e.record, meta: e.meta });
    }
  }
  // Write direction: random edits with our code, then PKHeX reads the result.
  let opsDone = 0;
  for (const { spec, savFile } of built) {
    const save = await openSave(new Uint8Array(fs.readFileSync(savFile)), path.basename(savFile));
    if (save.readOnly) continue;
    const donors = (pool.get(`pk${gen}:${spec.lang}`) || []).concat(pool.get(`pk${gen}:${save.lang}`) || []);
    const log = [];
    for (let i = 0; i < OPS; i++) {
      const op = rnd();
      try {
        if (op < 0.35) {
          const boxes = [...Array(save.boxCount).keys()].filter((b) => save.box(b).some(Boolean));
          if (!boxes.length) continue;
          const b = pick(boxes), idx = pick(save.box(b).map((e, j) => (e ? j : -1)).filter((j) => j >= 0));
          save.takeFromBox(b, idx); log.push(`take ${b}:${idx}`);
        } else if (op < 0.7 && donors.length) {
          const d = pick(donors), b = int(0, save.boxCount - 1);
          const r = save.putInBox(d.record, d.meta, b); log.push(`put ${r.box}:${r.index}`);
        } else if (op < 0.8) {
          const p = save.party();
          if (p.length > 1) { save.takeFromParty(int(0, p.length - 1)); log.push("take party"); }
        } else if (op < 0.9 && save.setCurrentBox) {
          const b = int(0, save.boxCount - 1); save.setCurrentBox(b); log.push(`current ${b}`);
        } else {
          const sp = int(1, D.MAX_SPECIES[gen]); save.registerDex(sp, {}); log.push(`dex ${sp}`);
        }
        opsDone++;
      } catch (e) {
        if (!(e && e.name === "FormatError")) problems.push(`${spec.id} write op ${i} threw ${e.stack || e}`);
        log.push(`refused: ${e.message.slice(0, 60)}`);
      }
    }
    const outFile = savFile.replace(/\.sav$/, ".edited.sav");
    fs.writeFileSync(outFile, save.serialize());
    const dump = oracle("dump", outFile);
    const reopened = await openSave(new Uint8Array(fs.readFileSync(outFile)), path.basename(outFile));
    const before = problems.length;
    compareSave(reopened, dump, spec.id + " (after our edits)", problems);
    // Our own model of the edited save must survive serialize -> reopen unchanged.
    for (let b = 0; b < save.boxCount; b++) {
      const a = save.box(b).map((e) => (e ? hex(e.record) : "")), r = reopened.box(b).map((e) => (e ? hex(e.record) : ""));
      if (JSON.stringify(a) !== JSON.stringify(r)) problems.push(`${spec.id}: box ${b} differs after serialize/reopen`);
    }
    if (problems.length > before) fs.writeFileSync(path.join(OUT, spec.id + ".write-log.txt"), log.join("\n") + "\n\n" + problems.slice(before).join("\n"));
  }
  report.push({ id: base.id, saves: built.length, ops: opsDone, problems });
  console.log(`${base.id.padEnd(14)} saves ${built.length}  ops ${opsDone}  problems ${problems.length}`);
  for (const p of problems.slice(0, 6)) console.log("   " + p.slice(0, 300));
}
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));
console.log(`\noutput in ${OUT}; ${report.reduce((n, r) => n + r.problems.length, 0)} problems`);
process.exitCode = report.some((r) => r.problems.length) ? 1 : 0;
