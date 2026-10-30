#!/usr/bin/env node
/* Writes test/fixtures/stage2-gen5/pk5-vectors.json: PKHeX's reading of ~150 random Gen 5
   Pokémon (Black, Black 2 and Japanese Black saves; every language; ribbons, contest stats,
   hidden abilities, N's sparkle, PokéStar fame, Pokérus, eggs), which test/gen5-regressions.test.js
   compares field by field with ours. Development only: needs the PKHeX oracle.

     node tools/fuzz/gen5-vectors.mjs [--seed N] */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DLL = path.join(ROOT, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
const D = await import(path.join(ROOT, "shared/data/index.js"));
const { openSave } = await import(path.join(ROOT, "shared/saves/index.js"));
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

const seedArg = process.argv.indexOf("--seed");
let s = (seedArg > 0 ? Number(process.argv[seedArg + 1]) : 5) >>> 0 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 2 ** 32; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const chance = (p) => rnd() < p;

// PKHeX ribbon property names in PK5 bit order (0x24: 28 bits, 0x3C: 32, 0x60: 20), as our pk4/pk5 tables list them.
const C4 = (c) => [c, c + "Great", c + "Ultra", c + "Master"], C3 = (c) => [c, c + "Super", c + "Hyper", c + "Master"];
const RIBBON_ORDER = [
  "ChampionSinnoh", "Ability", "AbilityGreat", "AbilityDouble", "AbilityMulti", "AbilityPair", "AbilityWorld", "Alert",
  "Shock", "Downcast", "Careless", "Relax", "Snooze", "Smile", "Gorgeous", "Royal",
  "GorgeousRoyal", "Footprint", "Record", "Event", "Legend", "ChampionWorld", "Birthday", "Special",
  "Souvenir", "Wishing", "Classic", "Premier",
  ...["Cool", "Beauty", "Cute", "Smart", "Tough"].flatMap((c) => C3("G3" + c)),
  "ChampionG3", "Winning", "Victory", "Artist", "Effort", "ChampionBattle", "ChampionRegional", "ChampionNational",
  "Country", "National", "Earth", "World",
  ...["Cool", "Beauty", "Cute", "Smart", "Tough"].flatMap((c) => C4("G4" + c)),
].map((n) => "Ribbon" + n);

const LANGS = ["ja", "en", "fr", "de", "it", "es", "ko"];
const OTS = { en: "ASH", fr: "SACHA", de: "MAX", it: "ASH", es: "ROJO", ja: "サトシ", ko: "지우" };
function mon(game) {
  const species = int(1, 649);
  const m = { species, level: int(1, 100), moves: [], ppUps: [], nature: int(0, 24) };
  const forms = (D.formsOf(species, 5) || []).filter((f) => !f.battleOnly);
  if (forms.length > 1) m.form = pick(forms).form;
  const moves = new Set(); while (moves.size < int(1, 4)) moves.add(int(1, 559));
  m.moves = [...moves]; m.ppUps = m.moves.map(() => int(0, 3));
  m.ivs = Object.fromEntries(["hp", "atk", "def", "spa", "spd", "spe"].map((k) => [k, int(0, 31)]));
  m.evs = Object.fromEntries(["hp", "atk", "def", "spa", "spd", "spe"].map((k) => [k, int(0, 80)]));
  m.abilityNumber = chance(0.2) ? 2 : int(0, 1);
  m.ball = int(1, 25);
  m.friendship = int(0, 255);
  m.language = pick(LANGS);
  if (m.language !== "en" && m.language !== "ja") { m.otName = OTS[m.language]; m.tid = int(0, 65535); m.sid = int(0, 65535); }
  if (chance(0.3)) m.metVersion = pick(["D", "P", "Pt", "HG", "SS", "R", "S", "E", "FR", "LG", "B", "W", "B2", "W2"]);
  if (chance(0.35)) m.ribbons = RIBBON_ORDER.filter(() => chance(0.08));
  if (chance(0.3)) m.contest = { cool: int(0, 255), beauty: int(0, 255), cute: int(0, 255), smart: int(0, 255), tough: int(0, 255), sheen: int(0, 255) };
  if (chance(0.15)) m.pokerus = { strain: int(1, 15), days: int(0, 4) };
  if (chance(0.3)) m.markings = int(0, 63);
  if (chance(0.15)) m.fatefulEncounter = true;
  if (chance(0.1)) m.nSparkle = true;
  if (game === "B2" && chance(0.2)) m.pokeStarFame = int(0, 255);
  if (chance(0.3)) m.groundTile = int(0, 20);
  if (chance(0.3)) m.heldItem = pick([1, 17, 50, 155, 221, 234, 236, 537]);
  if (chance(0.1)) m.shiny = true;
  if (chance(0.05)) { m.isEgg = true; delete m.heldItem; }
  return m;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pmw-g5v-"));
const out = { generatedBy: "tools/fuzz/gen5-vectors.mjs", pkhexCore: null, ribbonOrder: RIBBON_ORDER, mons: [] };
for (const id of ["black-en", "black2-en", "black-ja"]) {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/pkhex-oracle/specs", id + ".json"), "utf8"));
  const spec = { ...base, id: id + "-vectors", fill: [], boxes: [], party: Array.from({ length: 6 }, () => mon(base.game)) };
  spec.party.forEach((m) => delete m.isEgg);
  for (let i = 0; i < 45; i++) spec.boxes.push({ box: Math.floor(i / 30), slot: i % 30, ...mon(base.game) });
  const specFile = path.join(tmp, id + ".json"), savFile = path.join(tmp, id + ".sav");
  fs.writeFileSync(specFile, JSON.stringify(spec));
  oracle("build", specFile, savFile);
  const dump = oracle("dump", savFile);
  out.pkhexCore = dump.oracle?.pkhexCore ?? out.pkhexCore;
  const save = await openSave(new Uint8Array(fs.readFileSync(savFile)), id + ".sav");
  const keep = (m, where) => ({
    where, saveLang: save.lang, saveGame: save.game,
    species: m.species, form: m.form, isEgg: m.isEgg, level: m.level, exp: m.exp,
    nickname: m.nickname, isNicknamed: m.isNicknamed, ot: m.ot,
    moves: m.moves.map((x) => [x.id, x.pp, x.ppUps]), ivs: m.ivs, evs: m.evs,
    nature: m.nature, ability: m.ability, abilityNumber: m.abilityNumber, heldItem: m.heldItem, gender: m.gender,
    isShiny: m.isShiny, pid: m.pid, met: m.met, egg: m.egg, friendship: m.friendship, languageCode: m.languageCode,
    pokerus: m.pokerus, markingsRaw: m.markingsRaw, fatefulEncounter: m.fatefulEncounter,
    extra: { hiddenAbility: m.extra.hiddenAbility, nSparkle: m.extra.nSparkle, pokeStarFame: m.extra.pokeStarFame, groundTile: m.extra.groundTile },
    contest: m.contest, ribbons: m.ribbons, partyStats: m.partyStats ?? null, storedHex: m.storedHex,
  });
  dump.party.forEach((m) => out.mons.push(keep(m, `${id} party ${m.slot}`)));
  dump.boxes.forEach((m) => out.mons.push(keep(m, `${id} box ${m.box}:${m.slot}`)));
}
const dest = path.join(ROOT, "test/fixtures/stage2-gen5/pk5-vectors.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`${out.mons.length} Pokémon -> ${path.relative(ROOT, dest)} (${fs.statSync(dest).size} bytes)`);
