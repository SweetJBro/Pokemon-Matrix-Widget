#!/usr/bin/env node
/* Builds shared/data/ from pinned upstream files. See docs/research/data-and-transfers.md §1.

   Inputs: PokeAPI CSVs (BSD-3-Clause) for names, species attributes and per-generation history,
   pret decompilation constants for the index spaces PokeAPI gets wrong or lacks (Gen 1/2 items,
   Gen 2/3/4 met locations, internal species orders), and a few hand-written rule tables. Every
   download is pinned to a commit, cached outside the repo and hashed into SOURCES.json, so a
   rebuild from the cache is offline and byte-identical. pret files are only read for facts;
   nothing from them is copied into the output verbatim.

   Usage: node scripts/build-data.mjs [--offline] [--cache DIR] [--out DIR]
   --cache (or PKDATA_CACHE) is where downloads are kept; --out writes somewhere other than shared/data/,
   e.g. to compare a rebuild with the committed output (test/data.test.js does).
   The build fails (non-zero exit) when a cross-check finds a disagreement it does not expect. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OUT = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : path.join(ROOT, "shared", "data");
const OFFLINE = args.includes("--offline");
const CACHE = args.includes("--cache") ? args[args.indexOf("--cache") + 1]
  : process.env.PKDATA_CACHE || "/tmp/claude-1000/pkres/stage1-data/cache";

/* ---------- pinned sources ---------- */

const REPOS = {
  pokeapi: ["PokeAPI/pokeapi", "2bf639e5572812a67d2b94903fdcb9d095f5aeb2"],
  pokered: ["pret/pokered", "171e2c204f9c1ff8e577ca387a4bbb009e130843"],
  pokecrystal: ["pret/pokecrystal", "5c877ef55197039c9676e8e3eec6d254b1c40fe8"],
  pokeemerald: ["pret/pokeemerald", "731ad5bfd6e6f265508d0efcca0ba42f9dcf5881"],
  pokefirered: ["pret/pokefirered", "ce6406d8c2eaf46d543c8a2606de0c3cb1951982"],
  pokeplatinum: ["pret/pokeplatinum", "be36a9db3d2390a5009adc087c7aef550ce335e7"],
  pokeheartgold: ["pret/pokeheartgold", "6988158691eb6178cff697cda0428045ddcba5fb"],
};
const CSV = [
  "pokemon_species", "pokemon_species_names", "pokemon", "pokemon_forms", "pokemon_form_generations",
  "pokemon_form_names", "pokemon_stats", "pokemon_stats_past", "pokemon_types", "pokemon_types_past", "types",
  "type_names", "type_game_indices", "pokemon_abilities", "pokemon_abilities_past", "abilities", "ability_names",
  "moves", "move_changelog", "move_names", "items", "item_names", "item_game_indices", "natures", "nature_names",
  "experience", "pokemon_evolution", "evolution_triggers", "pokemon_game_indices", "location_names",
  "location_game_indices", "versions", "version_names", "version_groups", "languages", "stats", "pokemon_form_types",
];
const FILES = [
  ["pokeapi", "LICENSE.md"],
  ...CSV.map((f) => ["pokeapi", `data/v2/csv/${f}.csv`]),
  ["pokered", "constants/pokemon_constants.asm"],
  ["pokered", "constants/item_constants.asm"],
  ["pokecrystal", "constants/item_constants.asm"],
  ["pokecrystal", "data/items/catch_rate_items.asm"],
  ["pokecrystal", "constants/landmark_constants.asm"],
  ["pokecrystal", "data/maps/landmarks.asm"],
  ["pokecrystal", "data/pokemon/gen1_order.asm"],
  ["pokecrystal", "data/pokemon/gen1_base_special.asm"],
  ["pokered", "data/moves/moves.asm"],
  ["pokecrystal", "data/moves/moves.asm"],
  ["pokeemerald", "src/data/battle_moves.h"],
  ["pokeemerald", "include/constants/moves.h"],
  ["pokeemerald", "include/constants/species.h"],
  ["pokeemerald", "include/constants/items.h"],
  ["pokeemerald", "src/data/region_map/region_map_sections.json"],
  ["pokefirered", "src/data/region_map/region_map_sections.json"],
  ["pokeplatinum", "res/text/location_names.json"],
  ["pokeplatinum", "res/text/special_met_location_names.json"],
  ["pokeplatinum", "include/constants/gba/items.h"],
  ["pokeplatinum", "src/main_menu/gba_migrator.c"],
  ["pokeheartgold", "include/constants/items.h"],
  ["pokeheartgold", "files/msgdata/msg/msg_0279.json"],
];

const sources = {};   // "repo:path" -> { url, sha256, bytes }

async function load(repo, file) {
  const [slug, sha] = REPOS[repo];
  const url = `https://raw.githubusercontent.com/${slug}/${sha}/${file}`;
  const local = path.join(CACHE, slug.replace("/", "__"), sha, file);
  let buf;
  if (fs.existsSync(local)) buf = fs.readFileSync(local);
  else {
    if (OFFLINE) throw new Error(`offline and not cached: ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local + ".part", buf);
    fs.renameSync(local + ".part", local);
  }
  sources[`${repo}:${file}`] = { url, sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  return buf.toString("utf8");
}

/** RFC 4180 CSV -> array of objects keyed by the header row. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

const raw = {};
async function fetchAll() {
  for (const [repo, file] of FILES) raw[`${repo}:${file}`] = await load(repo, file);
}

await fetchAll();
if (args.includes("--fetch-only")) {
  console.log(`cached ${Object.keys(sources).length} files in ${CACHE}`);
  process.exit(0);
}

/* ---------- helpers ---------- */

const csv = (name) => parseCsv(raw[`pokeapi:data/v2/csv/${name}.csv`]);
const pret = (repo, file) => raw[`${repo}:${file}`];
const int = (s) => (s === "" || s == null ? null : Number(s));
/** Loose name key: "PARLYZ_HEAL", "paralyze-heal" and "Parlyz Heal" all lose case, accents and punctuation. */
const norm = (s) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = typeof key === "function" ? key(r) : r[key]; (m.get(k) ?? m.set(k, []).get(k)).push(r); }
  return m;
};
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** rgbds constants: const_def [start[, step]], const_next, const_skip, const X, add_tm/add_hm X.
    Macro bodies are skipped; a trailing "; $xx" / "; xx" comment must agree with the counter. */
function asmConsts(text, file) {
  const out = [];
  let n = 0, step = 1, inMacro = false;
  const num = (s) => (s.startsWith("$") ? parseInt(s.slice(1), 16) : parseInt(s, 10));
  for (const line0 of text.split("\n")) {
    const comment = line0.match(/;\s*\$?([0-9A-Fa-f]{2,3})\b/);
    const line = line0.replace(/;.*/, "").trim();
    if (/^MACRO\b/.test(line)) { inMacro = true; continue; }
    if (/^ENDM\b/.test(line)) { inMacro = false; continue; }
    if (inMacro || !line) continue;
    let m, name = null, kind = "const";
    if ((m = line.match(/^const_def(?:\s+([$\w]+)(?:\s*,\s*(-?\d+))?)?$/))) { n = m[1] ? num(m[1]) : 0; step = m[2] ? Number(m[2]) : 1; }
    else if ((m = line.match(/^const_next\s+([$\w]+)$/))) n = num(m[1]);
    else if ((m = line.match(/^const_skip(?:\s+(\d+))?$/))) n += step * (m[1] ? Number(m[1]) : 1);
    else if ((m = line.match(/^const\s+(\w+)$/))) name = m[1];
    else if ((m = line.match(/^add_(tm|hm)\s+(\w+)$/))) { name = m[2]; kind = m[1]; }
    if (name) {
      if (comment) check(parseInt(comment[1], 16) === n, `${file}: ${name} counted ${n}, comment says ${comment[1]}`);
      out.push({ value: n, name, kind });
      n += step;
    }
  }
  return out;
}
/** C enum body -> [name, value] (sequential, explicit "= N" honoured). */
function cEnum(text, startRe) {
  const i = text.search(startRe);
  const body = text.slice(text.indexOf("{", i) + 1, text.indexOf("}", i));
  const out = [];
  let n = 0;
  for (const part of body.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").split(",")) {
    const m = part.trim().match(/^(\w+)(?:\s*=\s*(\w+))?$/);
    if (!m) continue;
    if (m[2] != null) n = Number(m[2]);
    out.push([m[1], n++]);
  }
  return out;
}
const cDefines = (text, prefix) =>
  [...text.matchAll(new RegExp(`^#define\\s+(${prefix}\\w+)\\s+(\\d+)\\s*$`, "gm"))].map((m) => [m[1], Number(m[2])]);
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s.\-(])([a-zé])/g, (_, a, b) => a + b.toUpperCase())
  .replace(/(?<=\s)(Of|The|And|In)(?=\s)/g, (w) => w.toLowerCase());

/* ---------- languages, versions, generations ---------- */

const LANG = { ja: 1, ko: 3, fr: 5, de: 6, es: 7, it: 8, en: 9 };   // PokeAPI local_language_id (ja = ja-Hrkt)
const LANGS = ["en", "fr", "de", "it", "es", "ja", "ko"];
const languages = new Map(csv("languages").map((r) => [Number(r.id), r.identifier]));
for (const [code, id] of Object.entries(LANG)) check(languages.get(id) === (code === "ja" ? "ja-hrkt" : code), `language id ${id} is not ${code}`);
const vgRows = csv("version_groups");
const vgGen = new Map(vgRows.map((r) => [Number(r.id), Number(r.generation_id)]));
const vgOrder = new Map(vgRows.map((r) => [Number(r.id), Number(r.order)]));
/** Reference version group per generation: the last one (by release order) of that generation. */
const GEN_VG_ORDER = {};
for (const r of vgRows) { const g = Number(r.generation_id); if (g <= 5) GEN_VG_ORDER[g] = Math.max(GEN_VG_ORDER[g] ?? 0, Number(r.order)); }
const MAX_SPECIES = { 1: 151, 2: 251, 3: 386, 4: 493, 5: 649 };
const NSPECIES = 649;

/* ---------- species ---------- */

const speciesRows = csv("pokemon_species").filter((r) => Number(r.id) <= NSPECIES);
check(speciesRows.length === NSPECIES, "species count");
// PokeAPI growth_rate_id -> game growth index (data-and-transfers.md §1.2)
const GROWTH_FROM_POKEAPI = { 1: 5, 2: 0, 3: 4, 4: 3, 5: 1, 6: 2 };
const GENDER_FROM_RATE = { "-1": 255, 0: 0, 1: 31, 2: 63, 4: 127, 6: 191, 8: 254 };
const species = { gen: [0], gender: [255], growth: [0], friendship: [0], catchRate: [0], evolvesFrom: [0], egg: [0] };
for (const r of speciesRows.sort((a, b) => a.id - b.id)) {
  const id = Number(r.id);
  species.gen[id] = Number(r.generation_id);
  check(id <= MAX_SPECIES[species.gen[id]] && (species.gen[id] === 1 || id > MAX_SPECIES[species.gen[id] - 1]), `species ${id} generation`);
  species.gender[id] = GENDER_FROM_RATE[r.gender_rate];
  check(species.gender[id] != null, `gender rate ${r.gender_rate} for ${id}`);
  species.growth[id] = GROWTH_FROM_POKEAPI[r.growth_rate_id];
  species.friendship[id] = Number(r.base_happiness);
  species.catchRate[id] = Number(r.capture_rate);
  species.evolvesFrom[id] = int(r.evolves_from_species_id) ?? 0;
  species.egg[id] = Number(r.hatch_counter);
}
const speciesIdent = new Map(speciesRows.map((r) => [Number(r.id), r.identifier]));

/* ---------- localized names ---------- */

function namesBy(rows, idKey, nameKey = "name") {
  const out = {};
  for (const code of LANGS) out[code] = new Map();
  for (const r of rows) for (const code of LANGS) if (Number(r.local_language_id) === LANG[code]) out[code].set(Number(r[idKey]), r[nameKey]);
  return out;
}
const speciesNames = namesBy(csv("pokemon_species_names"), "pokemon_species_id");
for (const code of LANGS) for (let i = 1; i <= NSPECIES; i++) check(speciesNames[code].get(i), `species ${i} has no ${code} name`);
const moveNames = namesBy(csv("move_names"), "move_id");
const abilityNames = namesBy(csv("ability_names"), "ability_id");
const itemNamesApi = namesBy(csv("item_names"), "item_id");
const natureNamesApi = namesBy(csv("nature_names"), "nature_id");
const typeNamesApi = namesBy(csv("type_names"), "type_id");

/* ---------- internal species orders (Gen 1, Gen 3) ---------- */

const pokemonRows = csv("pokemon");
const pokemonById = new Map(pokemonRows.map((r) => [Number(r.id), r]));
const gameIdx = csv("pokemon_game_indices");
const versionsRows = csv("versions");
const versionId = new Map(versionsRows.map((r) => [r.identifier, Number(r.id)]));
function internalOrder(version) {
  const m = new Map();
  for (const r of gameIdx) if (Number(r.version_id) === versionId.get(version)) {
    const sp = Number(pokemonById.get(Number(r.pokemon_id)).species_id);
    m.set(Number(r.game_index), sp);
  }
  return m;
}
// Gen 1: 190 slots; PokeAPI (Red) is the source, pokered constants and pokecrystal's gen1_order the checks.
const GEN1_SLOTS = 190;
const gen1 = new Array(GEN1_SLOTS + 1).fill(0);
for (const [idx, sp] of internalOrder("red")) if (sp <= 151) gen1[idx] = sp;
{
  const consts = asmConsts(pret("pokered", "constants/pokemon_constants.asm"), "pokered pokemon_constants");
  const byNorm = new Map([...speciesIdent].map(([id, ident]) => [norm(ident), id]));
  let n = 0;
  for (const c of consts) {
    if (c.value === 0 || c.value > GEN1_SLOTS) continue;
    const sp = byNorm.get(norm(c.name));
    if (/^(FOSSIL_|MON_GHOST)/.test(c.name)) { check(gen1[c.value] === 0, `Gen 1 slot ${c.value} (${c.name}) should be unused`); continue; }
    check(sp && gen1[c.value] === sp, `Gen 1 slot ${c.value}: pokered ${c.name}, PokeAPI ${gen1[c.value]}`);
    n++;
  }
  check(n === 151, `pokered names ${n} species`);
  const order = [...pret("pokecrystal", "data/pokemon/gen1_order.asm").matchAll(/^\s*db (\w+)(.*)$/gm)];
  check(order.length >= GEN1_SLOTS, `gen1_order has ${order.length} rows`);   // rows past 190 cover glitch indices
  order.slice(0, GEN1_SLOTS).forEach((m, i) => {
    const unused = /MISSINGNO/.test(m[2]);
    check(unused ? gen1[i + 1] === 0 : gen1[i + 1] === byNorm.get(norm(m[1])), `pokecrystal gen1_order slot ${i + 1} ${m[1]}`);
  });
  check(gen1.filter(Boolean).length === 151 && new Set(gen1.filter(Boolean)).size === 151, "Gen 1 order is not a bijection");
}
// Gen 3: 0 none, 1-251 National, 252-276 unused (old Unown), 277-411 Hoenn, 412 Egg.
const gen3 = new Array(413).fill(0);
for (const [idx, sp] of internalOrder("ruby")) if (sp <= 386 && idx <= 411) gen3[idx] = sp;
{
  const defs = cDefines(pret("pokeemerald", "include/constants/species.h"), "SPECIES_");
  const byNorm = new Map([...speciesIdent].map(([id, ident]) => [norm(ident), id]));
  let n = 0;
  for (const [name, v] of defs) {
    if (v === 0 || v > 411) continue;
    if (/^SPECIES_OLD_UNOWN_/.test(name)) { check(gen3[v] === 0 && v >= 252 && v <= 276, `Gen 3 ${name}`); continue; }
    const sp = byNorm.get(norm(name.slice(8)));
    check(sp && gen3[v] === sp, `Gen 3 internal ${v}: pokeemerald ${name}, PokeAPI ${gen3[v]}`);
    n++;
  }
  check(n === 386, `pokeemerald names ${n} species`);
  for (let i = 1; i <= 251; i++) check(gen3[i] === i, `Gen 3 internal ${i} is not identity`);
  check(new Set(gen3.filter(Boolean)).size === 386, "Gen 3 order is not a bijection");
  check(defs.find(([n]) => n === "SPECIES_EGG")?.[1] === 412, "Gen 3 egg is 412");
}
// Gen 4/5 store National Dex numbers directly; PokeAPI agrees (checked here so a data change is noticed).
for (const v of ["diamond", "black"]) for (const [idx, sp] of internalOrder(v)) if (idx <= 649) check(idx === sp, `${v} index ${idx} is species ${sp}`);

/* ---------- types ---------- */

// Canonical type index = the Gen 3/4 game index (Normal 0 ... Steel 8, ??? 9, Fire 10 ... Dark 17).
const typeGameIdx = groupBy(csv("type_game_indices"), (r) => Number(r.generation_id));
const TYPE_OF_API = new Map();   // PokeAPI type id -> canonical index
check(csv("types").find((r) => r.id === "10001")?.identifier === "unknown", "PokeAPI type 10001 is ???");
for (const r of typeGameIdx.get(4)) TYPE_OF_API.set(Number(r.type_id), Number(r.game_index));
check(TYPE_OF_API.size === 18, "18 types in Gen 4");
const TYPE_IDS = [];                // canonical index -> PokeAPI type id
for (const [api, i] of TYPE_OF_API) TYPE_IDS[i] = api;
const TYPE_NAMES_EN = TYPE_IDS.map((api) => api === 10001 ? "???" : typeNamesApi.en.get(api));
check(TYPE_NAMES_EN.join() === "Normal,Fighting,Flying,Poison,Ground,Rock,Bug,Ghost,Steel,???,Fire,Water,Grass,Electric,Psychic,Ice,Dragon,Dark",
  `type order ${TYPE_NAMES_EN.join()}`);
// Stored type bytes per generation (Gen 1/2 Pokémon structs, Gen 3+ for completeness): canonical index -> byte, -1 = absent.
const TYPE_BYTES = {};
for (const g of [1, 2, 3, 4, 5]) {
  TYPE_BYTES[g] = new Array(18).fill(-1);
  for (const r of typeGameIdx.get(g)) if (TYPE_OF_API.has(Number(r.type_id))) TYPE_BYTES[g][TYPE_OF_API.get(Number(r.type_id))] = Number(r.game_index);
}
check(TYPE_BYTES[1][10] === 20 && TYPE_BYTES[2][17] === 27 && TYPE_BYTES[2][9] === 19 && TYPE_BYTES[5][9] === -1 && TYPE_BYTES[1][8] === -1,
  "type bytes (Fire 20, Dark 27, ??? 19 in Gen 2, none in Gen 5, no Steel in Gen 1)");

/** History rule for *_past tables: a past row is the value through its generation_id; for gen G take the
    row with the smallest generation_id >= G, else the current table (data-and-transfers.md §1.2). */
function pastLookup(pastRows, keyFn) {
  const m = groupBy(pastRows, keyFn);
  for (const rows of m.values()) rows.sort((a, b) => a.generation_id - b.generation_id);
  return (key, gen) => (m.get(key) ?? []).find((r) => Number(r.generation_id) >= gen) ?? null;
}

const pokemonTypes = groupBy(csv("pokemon_types"), (r) => Number(r.pokemon_id));
const typesPast = groupBy(csv("pokemon_types_past"), (r) => Number(r.pokemon_id));
const formTypes = groupBy(csv("pokemon_form_types"), (r) => Number(r.pokemon_form_id));
/** -> [t1, t2] canonical indices (t2 = t1 for single-typed) for a PokeAPI pokemon id in gen G. */
function typesOf(pokemonId, gen, formId = null) {
  let rows = formId != null && formTypes.has(formId) ? formTypes.get(formId) : pokemonTypes.get(pokemonId);
  const past = typesPast.get(pokemonId);
  if (past) {
    const later = past.filter((r) => Number(r.generation_id) >= gen);
    if (later.length) { const g = Math.min(...later.map((r) => Number(r.generation_id))); rows = later.filter((r) => Number(r.generation_id) === g); }
  }
  const t = rows.slice().sort((a, b) => a.slot - b.slot).map((r) => TYPE_OF_API.get(Number(r.type_id)));
  check(t.every((x) => x != null) && t.length >= 1 && t.length <= 2, `types of pokemon ${pokemonId} gen ${gen}`);
  return [t[0], t[1] ?? t[0]];
}

/* ---------- base stats ---------- */

const STAT_IDS = [1, 2, 3, 4, 5, 6];   // hp atk def spa spd spe; 9 = Gen 1 Special
check(csv("stats").filter((r) => [...STAT_IDS, 9].includes(Number(r.id))).map((r) => r.identifier).join() ===
  "hp,attack,defense,special-attack,special-defense,speed,special", "PokeAPI stat ids");
const statsCur = groupBy(csv("pokemon_stats"), (r) => Number(r.pokemon_id));
const statsPastRows = csv("pokemon_stats_past");
// PokeAPI defect: Cryogonal's pre-Gen 7 Defense 30 is filed under Attack (stat 2); Gen 5 is 70/50/30/95/135/105.
{ const r = statsPastRows.find((x) => x.pokemon_id === "615" && x.generation_id === "6" && x.stat_id === "2");
  check(r && r.base_stat === "30", "Cryogonal stats row changed upstream; review the fix");
  if (r) r.stat_id = "3"; }
const statPast = pastLookup(statsPastRows, (r) => `${r.pokemon_id}:${r.stat_id}`);
function baseStatsOf(pokemonId, gen) {
  return STAT_IDS.map((s) => {
    const p = statPast(`${pokemonId}:${s}`, gen);
    if (p) return Number(p.base_stat);
    return Number(statsCur.get(pokemonId).find((r) => Number(r.stat_id) === s).base_stat);
  });
}
const BASE = [0, 0, 0, 0, 0, 0];
for (let sp = 1; sp <= NSPECIES; sp++) {
  const s5 = baseStatsOf(sp, 5);
  for (let g = Math.max(2, species.gen[sp]); g <= 4; g++) check(baseStatsOf(sp, g).join() === s5.join(), `base stats of ${sp} differ in gen ${g}`);
  if (sp <= 151) check(baseStatsOf(sp, 1).join() === s5.join(), `Gen 1 non-Special stats of ${sp} differ`);
  BASE.push(...s5);
}
const SPECIAL1 = [0];
for (let sp = 1; sp <= 151; sp++) {
  const p = statPast(`${sp}:9`, 1);
  check(p, `no Gen 1 Special for ${sp}`);
  SPECIAL1.push(Number(p.base_stat));
}
{ // cross-check Gen 1 Special against pokecrystal's KantoMonSpecials (used by the Time Capsule)
  const vals = [...pret("pokecrystal", "data/pokemon/gen1_base_special.asm").matchAll(/^\s*db\s+(\d+)/gm)].map((m) => Number(m[1]));
  check(vals.length === 151 && vals.every((v, i) => v === SPECIAL1[i + 1]), "Gen 1 Special disagrees with pokecrystal");
}

/* ---------- types per species per generation ---------- */

const SPECIES_TYPES = [];          // gens 2-5 (asserted equal), flat [t1, t2] per species
const GEN1_TYPES = {};             // species -> [t1, t2] where Gen 1 differs
for (let sp = 1; sp <= NSPECIES; sp++) {
  const t5 = typesOf(sp, 5);
  for (let g = Math.max(2, species.gen[sp]); g <= 4; g++) check(typesOf(sp, g).join() === t5.join(), `types of ${sp} differ in gen ${g}`);
  SPECIES_TYPES.push(t5);
  if (sp <= 151 && typesOf(sp, 1).join() !== t5.join()) GEN1_TYPES[sp] = typesOf(sp, 1);
}
check(Object.keys(GEN1_TYPES).join() === "81,82", `Gen 1 type differences: ${Object.keys(GEN1_TYPES)}`);
for (const t of SPECIES_TYPES) check(t.every((x) => x !== 9), "??? type on a species");

/* ---------- abilities ---------- */

const abilityRows = csv("abilities");
const MAX_ABILITY = {};
for (const g of [3, 4, 5]) MAX_ABILITY[g] = Math.max(...abilityRows.filter((r) => Number(r.generation_id) <= g && r.is_main_series === "1" && Number(r.id) < 10000).map((r) => Number(r.id)));
check(MAX_ABILITY[3] === 76 && MAX_ABILITY[4] === 123 && MAX_ABILITY[5] === 164, `max abilities ${JSON.stringify(MAX_ABILITY)}`);
const abCur = groupBy(csv("pokemon_abilities"), (r) => Number(r.pokemon_id));
const abPastRows = csv("pokemon_abilities_past");
// PokeAPI defect: Koffing and Weezing had no hidden ability before Gen 8 (Stench came with Neutralizing Gas);
// data-and-transfers.md §2.4 lists the Koffing line among the species without one in Gen 7.
for (const id of ["109", "110"]) {
  check(!abPastRows.some((r) => r.pokemon_id === id && r.slot === "3"), `Koffing line hidden-ability history changed upstream`);
  abPastRows.push({ pokemon_id: id, generation_id: "7", ability_id: "", is_hidden: "1", slot: "3" });
}
const abPast = pastLookup(abPastRows, (r) => `${r.pokemon_id}:${r.slot}`);
/** -> [slot1, slot2, hidden] ability ids (0 = none) for gen 3-5. */
function abilitiesOf(pokemonId, gen) {
  return [1, 2, 3].map((slot) => {
    if (slot === 3 && gen < 5) return 0;
    const p = abPast(`${pokemonId}:${slot}`, gen);
    const id = p ? (int(p.ability_id) ?? 0) : Number((abCur.get(pokemonId) ?? []).find((r) => Number(r.slot) === slot)?.ability_id ?? 0);
    check(id <= MAX_ABILITY[gen], `ability ${id} of ${pokemonId} too new for gen ${gen}`);
    return id;
  });
}
const AB = { 3: [], 4: [], 5: [] };
for (const g of [3, 4, 5]) for (let sp = 1; sp <= MAX_SPECIES[g]; sp++) {
  const a = abilitiesOf(sp, g);
  check(a[0] > 0, `species ${sp} has no ability in gen ${g}`);
  AB[g].push(...(g === 5 ? a : a.slice(0, 2)));
}
// Species that gained a second ability in Gen 4 (Pal Park uses ability 1 for them): PokeAPI past rows
// "generation 3, slot 2, empty" for species that do have a slot 2 in Gen 4.
const NEW_ABILITY_G4 = [];
for (let sp = 1; sp <= 386; sp++) if (abilitiesOf(sp, 3)[1] === 0 && abilitiesOf(sp, 4)[1] !== 0) NEW_ABILITY_G4.push(sp);
check(NEW_ABILITY_G4.length === 89, `${NEW_ABILITY_G4.length} species gained an ability in Gen 4 (expected 89)`);

/* ---------- forms ---------- */

// Per species and generation, the forms a record can store, in game-index order. PokeAPI's
// pokemon_form_generations gives the per-generation index (Arceus-Fire is 10 in Gen 4, 9 in Gen 5;
// Deoxys forms are all 0 in Gen 3 where nothing is stored). Rows that collide on an index already
// taken by the default form (Frillish/Jellicent "female", Gen 3 Deoxys) are not separate forms.
const formRows = csv("pokemon_forms");
const formGens = groupBy(csv("pokemon_form_generations"), (r) => Number(r.pokemon_form_id));
const formNamesEn = new Map(csv("pokemon_form_names").filter((r) => Number(r.local_language_id) === LANG.en).map((r) => [Number(r.pokemon_form_id), r.form_name]));
const SHOWDOWN_FORME_OVERRIDES = { "arceus-unknown": null };   // no Showdown forme (the ??? Arceus is unobtainable)
const FORMS = {};   // species -> { list: [form records], gens: { g: [index into list per game form index] } }
const VARIANTS = {}; // PokeAPI pokemon identifier -> per-form stats/types/abilities when they differ from the species
for (const f of formRows) {
  const p = pokemonById.get(Number(f.pokemon_id));
  const sp = Number(p.species_id);
  if (sp > NSPECIES) continue;
  const gens = (formGens.get(Number(f.id)) ?? []).filter((r) => Number(r.generation_id) <= 5);
  if (!gens.length) continue;
  (FORMS[sp] ??= { rows: [] }).rows.push({ f, p, gens });
}
for (const sp of Object.keys(FORMS).map(Number).sort((a, b) => a - b)) {
  const { rows } = FORMS[sp];
  rows.sort((a, b) => a.f.form_order - b.f.form_order || a.f.id - b.f.id);
  const list = [], gens = {};
  for (const { f, p, gens: gr } of rows) {
    const variant = Number(p.id) !== sp ? p.identifier : null;   // own pokemon row: own stats/types/abilities
    const typeForm = formTypes.has(Number(f.id)) ? Number(f.id) : null;  // Arceus: types per form
    const ident = f.form_identifier || "";
    const rec = {
      ident, name: formNamesEn.get(Number(f.id)) || "", battleOnly: f.is_battle_only === "1",
      variant, typeForm, stem: variant ? String(p.id) : (f.is_default === "1" && Number(p.id) === sp && list.length === 0 ? String(sp) : `${sp}-${ident}`),
      showdown: f.is_default === "1" && !variant ? "" : (`${f.identifier}` in SHOWDOWN_FORME_OVERRIDES ? SHOWDOWN_FORME_OVERRIDES[f.identifier] : ident),
      pokeapiForm: f.identifier,
    };
    let used = false;
    for (const r of gr) {
      const g = Number(r.generation_id), gi = Number(r.game_index);
      gens[g] ??= [];
      if (gens[g][gi] != null) continue;            // index already taken by an earlier (default) form
      gens[g][gi] = list.length; used = true;
    }
    if (used) list.push(rec);
  }
  for (const [g, arr] of Object.entries(gens)) check(arr.every((x) => x != null) && arr.length >= 1, `form indices of ${sp} in gen ${g} have holes`);
  // Species with a single stored form in every generation have no form table.
  if (Object.values(gens).every((arr) => arr.length === 1) && list.length === 1) { delete FORMS[sp]; continue; }
  FORMS[sp] = { list, gens };
}
check(Object.keys(FORMS).join() === "172,201,351,386,412,413,421,422,423,479,487,492,493,550,555,585,586,641,642,645,646,647,648,649",
  `species with forms: ${Object.keys(FORMS)}`);
check(FORMS[493].gens[4].length === 18 && FORMS[493].gens[5].length === 17 && FORMS[201].gens[2].length === 26 && FORMS[201].gens[3].length === 28,
  "Arceus 18/17 forms, Unown 26/28");
check(FORMS[646].list[FORMS[646].gens[5][1]].ident === "white" && FORMS[646].list[FORMS[646].gens[5][2]].ident === "black", "Kyurem 1 = White, 2 = Black");
check(FORMS[386].gens[3].length === 1 && FORMS[386].gens[4].length === 4, "Deoxys: 1 stored form in Gen 3, 4 in Gen 4");
// Variant data: stats are generation-independent for these (asserted), types/abilities per gen.
for (const sp of Object.keys(FORMS)) for (const rec of FORMS[sp].list) {
  const gensOf = Object.keys(FORMS[sp].gens).map(Number).filter((g) => FORMS[sp].gens[g].includes(FORMS[sp].list.indexOf(rec)));
  const types = {}, abil = {};
  const pid = rec.variant ? Number(pokemonRows.find((r) => r.identifier === rec.variant).id) : Number(sp);
  if (!rec.variant && rec.typeForm == null) continue;
  for (const g of gensOf) {
    types[g] = typesOf(pid, g, rec.typeForm);
    if (g >= 3) abil[g] = abilitiesOf(pid, g);
  }
  const key = rec.variant ?? rec.pokeapiForm;
  const stats = baseStatsOf(pid, 5);
  for (const g of gensOf) check(baseStatsOf(pid, g).join() === stats.join(), `form ${key} stats differ in gen ${g}`);
  VARIANTS[key] = { stats, types, abilities: abil };
  rec.data = key;
}
check(VARIANTS["arceus-fire"].types[4].join() === "10,10" && VARIANTS["rotom-wash"].types[4].join() === "13,7" && VARIANTS["rotom-wash"].types[5].join() === "13,11",
  "Arceus-Fire is Fire; Rotom-Wash is Electric/Ghost in Gen 4, Electric/Water in Gen 5");

/* ---------- moves ---------- */

const moveRows = csv("moves").filter((r) => Number(r.id) < 10000);
const MAX_MOVE = {};
for (const g of [1, 2, 3, 4, 5]) MAX_MOVE[g] = Math.max(...moveRows.filter((r) => Number(r.generation_id) <= g).map((r) => Number(r.id)));
check(JSON.stringify(MAX_MOVE) === '{"1":165,"2":251,"3":354,"4":467,"5":559}', `max moves ${JSON.stringify(MAX_MOVE)}`);
for (const r of moveRows) if (Number(r.id) <= 559) check(Number(r.id) <= MAX_MOVE[Number(r.generation_id)] && (Number(r.generation_id) === 1 || Number(r.id) > MAX_MOVE[Number(r.generation_id) - 1]), `move ${r.id} generation`);
const changelogRows = csv("move_changelog");
{ // PokeAPI defects in the move history, found against pret (Gen 1-3) and @pkmn/sim (Gen 4-5):
  const row = (move, vg, col, v) => ({ move_id: String(move), changed_in_version_group_id: String(vg), type_id: "", power: "", pp: "", accuracy: "",
    priority: "", target_id: "", effect_id: "", effect_chance: "", [col]: String(v) });
  // Scarlet/Violet (vg 25) cut these to 5 PP without a changelog row, so 5 leaks into every generation.
  for (const id of [105, 135, 156, 208, 303, 355]) {
    check(!changelogRows.some((r) => r.move_id === String(id) && r.changed_in_version_group_id === "25"), `move ${id} SV row exists upstream`);
    changelogRows.push(row(id, 25, "pp", 10));
  }
  // Mind Reader has 5 PP in every generation (pokecrystal, pokeemerald); PokeAPI claims 40 before BW.
  const mr = changelogRows.findIndex((r) => r.move_id === "170" && r.changed_in_version_group_id === "11" && r.pp === "40");
  check(mr >= 0, "Mind Reader row changed upstream"); if (mr >= 0) changelogRows.splice(mr, 1);
  // Struggle has 10 PP in Gen 1 (pokered), 1 from Gold/Silver on.
  changelogRows.push(row(165, 3, "pp", 10));
  // Luster Purge was 70 power until Scarlet/Violet (pokeemerald); PokeAPI has the row for Mist Ball only.
  check(!changelogRows.some((r) => r.move_id === "295"), "Luster Purge history exists upstream");
  changelogRows.push(row(295, 25, "power", 70));
}
const changelog = groupBy(changelogRows, (r) => Number(r.move_id));
const PHYSICAL_TYPES = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);   // Gen 1-3: category follows the type
/** Move as of the last version group of gen G: [type, power, pp, accuracy, category 0 phys / 1 spec / 2 status]. */
function moveAt(r, gen) {
  const id = Number(r.id), ref = GEN_VG_ORDER[gen];
  const later = (changelog.get(id) ?? []).filter((c) => vgOrder.get(Number(c.changed_in_version_group_id)) > ref)
    .sort((a, b) => vgOrder.get(Number(a.changed_in_version_group_id)) - vgOrder.get(Number(b.changed_in_version_group_id)));
  const col = (k) => { const c = later.find((x) => x[k] !== ""); return c ? c[k] : r[k]; };
  const type = TYPE_OF_API.get(Number(col("type_id")));
  check(type != null && (gen > 1 || ![8, 17, 9].includes(type)) && (gen < 5 || type !== 9), `move ${id} type ${col("type_id")} in gen ${gen}`);
  const dc = Number(r.damage_class_id);   // 1 status, 2 physical, 3 special
  const cat = dc === 1 ? 2 : gen >= 4 ? dc - 2 : PHYSICAL_TYPES.has(type) ? 0 : 1;
  // Variable power is 0 here; PokeAPI writes it as empty except Hidden Power's 1 before Gen 6.
  const power = int(col("power")) ?? 0;
  check(power !== 1 || id === 237, `move ${id} has power 1 in gen ${gen}`);
  return [type, power === 1 ? 0 : power, Number(col("pp")), int(col("accuracy")) ?? 0, cat];
}
const MOVES5 = [[0, 0, 0, 0, 2]];
const movesById = new Map(moveRows.map((r) => [Number(r.id), r]));
for (let id = 1; id <= 559; id++) MOVES5.push(moveAt(movesById.get(id), 5));
const MOVES_OLD = {};   // gen -> { id: values } where they differ from Gen 5
for (const g of [1, 2, 3, 4]) {
  MOVES_OLD[g] = {};
  for (let id = 1; id <= MAX_MOVE[g]; id++) {
    const v = moveAt(movesById.get(id), g);
    if (v.join() !== MOVES5[id].join()) MOVES_OLD[g][id] = v;
  }
}
// Spot checks from §1.2: Bite Normal before Gen 2, Gust Normal in Gen 1, Tackle 35 power before Gen 5, Curse ??? before Gen 5.
check(MOVES_OLD[1][44]?.[0] === 0 && MOVES5[44][0] === 17 && MOVES_OLD[1][16]?.[0] === 0 && MOVES_OLD[4][33]?.[1] === 35 && MOVES5[33][1] === 50 &&
  MOVES_OLD[2][174]?.[0] === 9 && MOVES5[174][0] === 7, "move history spot checks");
{ // Gen 1-3 against the games' own move tables (type, power, PP; pret power 0/1 = variable or none).
  const PRET_TYPE = (t) => { t = t.replace(/^TYPE_/, "").replace(/_TYPE$/, ""); return t === "CURSE" || t === "MYSTERY" ? 9 : TYPE_NAMES_EN.findIndex((n) => norm(n) === norm(t)); };
  const tables = {
    1: [...pret("pokered", "data/moves/moves.asm").matchAll(/^\s*move\s+\w+,\s*\w+,\s*(\d+),\s*(\w+),\s*(\d+),\s*(\d+)/gm)].map((m) => [m[2], +m[1], +m[4]]),
    2: [...pret("pokecrystal", "data/moves/moves.asm").matchAll(/^\s*move\s+\w+,\s*\w+,\s*(\d+),\s*(\w+),\s*(\d+),\s*(\d+)/gm)].map((m) => [m[2], +m[1], +m[4]]),
    3: [],
  };
  const ids3 = new Map(cDefines(pret("pokeemerald", "include/constants/moves.h"), "MOVE_"));
  for (const m of pret("pokeemerald", "src/data/battle_moves.h").matchAll(/\[(MOVE_\w+)\]\s*=\s*\{([^}]*)\}/g)) {
    const f = (k) => m[2].match(new RegExp(`\\.${k}\\s*=\\s*(\\w+)`))?.[1];
    const id = ids3.get(m[1]); if (id) tables[3][id - 1] = [f("type"), Number(f("power")), Number(f("pp"))];
  }
  for (const g of [1, 2, 3]) {
    check(tables[g].length === MAX_MOVE[g], `pret gen ${g} move table has ${tables[g].length} moves`);
    tables[g].forEach(([t, power, pp], i) => {
      const ours = moveAt(movesById.get(i + 1), g);
      check(PRET_TYPE(t) === ours[0], `gen ${g} move ${i + 1}: pret type ${t}, ours ${TYPE_NAMES_EN[ours[0]]}`);
      check(pp === ours[2], `gen ${g} move ${i + 1}: pret PP ${pp}, ours ${ours[2]}`);
      // pret stores 1 for variable power and a nominal power for fixed-damage moves (SonicBoom, Dragon Rage, Spit Up).
      const nominal = power === 1 || ([49, 82, 255].includes(i + 1) && ours[1] === 0);
      check(power === ours[1] || nominal || (power === 0 && ours[1] === 0), `gen ${g} move ${i + 1}: pret power ${power}, ours ${ours[1]}`);
    });
  }
}

/* ---------- natures ---------- */

const natureRows = csv("natures").sort((a, b) => a.game_index - b.game_index);
check(natureRows.length === 25 && natureRows.every((r, i) => Number(r.game_index) === i), "25 natures with game indices 0-24");
const NATURE_STAT_IDS = [2, 3, 6, 4, 5];   // atk def spe spa spd: up = floor(n / 5), down = n % 5
natureRows.forEach((r, n) => {
  const up = NATURE_STAT_IDS[Math.floor(n / 5)], down = NATURE_STAT_IDS[n % 5];
  check(Number(r.increased_stat_id) === up && Number(r.decreased_stat_id) === down, `nature ${r.identifier} stat rule`);
});

/* ---------- experience ---------- */

const EXP = [];   // game growth index * 101 + level
const expRows = csv("experience");
for (const r of expRows) EXP[GROWTH_FROM_POKEAPI[r.growth_rate_id] * 101 + Number(r.level)] = Number(r.experience);
for (let g = 0; g < 6; g++) { EXP[g * 101] = 0; for (let l = 1; l <= 100; l++) check(EXP[g * 101 + l] != null, `exp ${g} ${l}`); }
function expFormula(rate, n) {
  if (n <= 1) return 0;
  const c = n ** 3;
  switch (rate) {
    case 0: return c;
    case 1: return n <= 50 ? Math.floor(c * (100 - n) / 50) : n <= 68 ? Math.floor(c * (150 - n) / 100)
      : n <= 98 ? Math.floor(c * Math.floor((1911 - 10 * n) / 3) / 500) : Math.floor(c * (160 - n) / 100);
    case 2: return n <= 15 ? Math.floor(c * (Math.floor((n + 1) / 3) + 24) / 50) : n <= 36 ? Math.floor(c * (n + 14) / 50)
      : Math.floor(c * (Math.floor(n / 2) + 32) / 50);
    case 3: return Math.floor(6 * c / 5) - 15 * n * n + 100 * n - 140;
    case 4: return Math.floor(4 * c / 5);
    case 5: return Math.floor(5 * c / 4);
  }
}
for (let g = 0; g < 6; g++) for (let l = 1; l <= 100; l++) check(EXP[g * 101 + l] === expFormula(g, l), `exp table ${g} L${l}: ${EXP[g * 101 + l]} vs formula ${expFormula(g, l)}`);

/* ---------- items ---------- */

// Every generation's own index space is taken from pret (Gen 1/2/3/4) or rebuilt from Gen 4 (Gen 5),
// then matched to PokeAPI items by name for names and cross-generation identity. The cross-generation
// key ("national item id") is the Gen 5 index for every item that exists in Gen 5 (so Gen 4/5 records
// already store it, except the exceptions below), 10000 + PokeAPI id for other PokeAPI items, and
// 20000 + gen * 1000 + index for generation-only items PokeAPI lacks or merges into a later item.
const itemIdent = new Map(csv("items").map((r) => [Number(r.id), r.identifier]));
const apiByNorm = new Map();
for (const [id, ident] of [...itemIdent].sort((a, b) => a[0] - b[0])) if (!apiByNorm.has(norm(ident))) apiByNorm.set(norm(ident), id);
const itemGI = {};
for (const r of csv("item_game_indices")) {
  const g = Number(r.generation_id); if (g > 5) continue;
  ((itemGI[g] ??= new Map()).get(Number(r.game_index)) ?? itemGI[g].set(Number(r.game_index), []).get(Number(r.game_index))).push(Number(r.item_id));
}
for (const m of Object.values(itemGI)) for (const v of m.values()) v.sort((a, b) => a - b);
// pret spellings that differ from PokeAPI identifiers (same item).
const ITEM_ALIAS = {
  parlyzheal: "paralyze-heal", xspecial: "x-sp-atk", xdefend: "x-defense", dowsingmchn: "dowsing-machine",
  itemfinder: "dowsing-machine", maxelixer: "max-elixir", elixer: "elixir", blackbelti: "black-belt", oaksparcel: "parcel",
  ylwapricorn: "yellow-apricorn", bluapricorn: "blue-apricorn", grnapricorn: "green-apricorn", pnkapricorn: "pink-apricorn",
  whtapricorn: "white-apricorn", blkapricorn: "black-apricorn", room1key: "rm-1-key", room2key: "rm-2-key",
  room4key: "rm-4-key", room6key: "rm-6-key",
};
// Items PokeAPI lacks, or merges into a different later item (shown under their own name here).
// "approx" names the later item PokeAPI merges them into (a conversion hint, not an identity).
const OWN_ITEMS = {
  1: { SURFBOARD: ["Surfboard"], POKEDEX: ["Pokédex"], COIN: ["Coin"], EXP_ALL: ["Exp. All", "exp-share"],
    BOULDERBADGE: ["Boulder Badge"], CASCADEBADGE: ["Cascade Badge"], THUNDERBADGE: ["Thunder Badge"], RAINBOWBADGE: ["Rainbow Badge"],
    SOULBADGE: ["Soul Badge"], MARSHBADGE: ["Marsh Badge"], VOLCANOBADGE: ["Volcano Badge"], EARTHBADGE: ["Earth Badge"] },
  2: { PSNCUREBERRY: ["PSNCureBerry", "pecha-berry"], PRZCUREBERRY: ["PRZCureBerry", "cheri-berry"], BURNT_BERRY: ["Burnt Berry", "aspear-berry"],
    ICE_BERRY: ["Ice Berry", "rawst-berry"], BITTER_BERRY: ["Bitter Berry", "persim-berry"], MINT_BERRY: ["Mint Berry", "chesto-berry"],
    MIRACLEBERRY: ["MiracleBerry", "lum-berry"], MYSTERYBERRY: ["MysteryBerry", "leppa-berry"], BERRY: ["Berry", "oran-berry"],
    GOLD_BERRY: ["Gold Berry", "sitrus-berry"], PINK_BOW: ["Pink Bow", "silk-scarf"], POLKADOT_BOW: ["Polkadot Bow"],
    GS_BALL: ["GS Ball"], EGG_TICKET: ["Egg Ticket"], BERSERK_GENE: ["Berserk Gene"], NORMAL_BOX: ["Normal Box"],
    GORGEOUS_BOX: ["Gorgeous Box"], BRICK_PIECE: ["Brick Piece"], FLOWER_MAIL: ["Flower Mail"], SURF_MAIL: ["Surf Mail"],
    LITEBLUEMAIL: ["LiteBlueMail"], PORTRAITMAIL: ["PortraitMail"], LOVELY_MAIL: ["Lovely Mail"], EON_MAIL: ["Eon Mail"],
    MORPH_MAIL: ["Morph Mail"], BLUESKY_MAIL: ["BlueSky Mail"], MUSIC_MAIL: ["Music Mail"], MIRAGE_MAIL: ["Mirage Mail"] },
};
const isUnusedConst = (tail) => /^([0-9A-F]{2,3}|UNUSED\w*)$/.test(tail);
/** -> { api } | { own: [name, approx] } | null (unused id) */
function matchItem(gen, tail, kind, seq) {
  if (kind === "tm" || kind === "hm") return { api: apiByNorm.get(`${kind}${String(seq).padStart(2, "0")}`) };
  if (isUnusedConst(tail.replace(/^ITEM_/, "")) || /^FLOOR_/.test(tail) || tail === "NONE" || tail === "NO_ITEM") return null;
  if (OWN_ITEMS[gen]?.[tail]) return { own: OWN_ITEMS[gen][tail] };
  const k = ITEM_ALIAS[norm(tail)] ? norm(ITEM_ALIAS[norm(tail)]) : norm(tail);
  const api = apiByNorm.get(k);
  check(api, `gen ${gen} item ${tail} matches no PokeAPI item`);
  return api ? { api } : null;
}
const IDX = {};   // gen -> array index -> { api } | { own } | null
const itemDisagree = [];
function compareToPokeApi(gen, maxIndex) {
  for (let i = 1; i <= maxIndex; i++) {
    const ours = IDX[gen][i], theirs = itemGI[gen].get(i) ?? [];
    if (!ours) { if (theirs.length) itemDisagree.push(`${gen}:${i}:extra`); continue; }
    if (ours.own) { if (theirs.length) itemDisagree.push(`${gen}:${i}:merged`); else itemDisagree.push(`${gen}:${i}:missing`); continue; }
    if (!theirs.length) itemDisagree.push(`${gen}:${i}:missing`);
    else if (!theirs.includes(ours.api)) itemDisagree.push(`${gen}:${i}:wrong`);
  }
}
// Gen 1 and Gen 2 from pret asm.
for (const [gen, repo] of [[1, "pokered"], [2, "pokecrystal"]]) {
  IDX[gen] = [];
  let tm = 0, hm = 0;
  for (const c of asmConsts(pret(repo, "constants/item_constants.asm"), `${repo} item_constants`)) {
    if (c.value > 255) continue;
    const seq = c.kind === "tm" ? ++tm : c.kind === "hm" ? ++hm : 0;
    IDX[gen][c.value] = matchItem(gen, c.name, c.kind, seq);
    if (IDX[gen][c.value] && !IDX[gen][c.value].name) IDX[gen][c.value].const = c.name;
  }
  check(tm === 50 && hm === (gen === 1 ? 5 : 7), `gen ${gen} has ${tm} TMs ${hm} HMs`);
}
// Gen 3 from pokeemerald's enum.
IDX[3] = [];
const g3enum = cEnum(pret("pokeemerald", "include/constants/items.h"), /enum\s*\{/).filter(([n]) => n.startsWith("ITEM_"));
check(g3enum.length === 377 && g3enum[376][0] === "ITEM_OLD_SEA_MAP", `Gen 3 item enum has ${g3enum.length} entries`);
{ let tm = 0, hm = 0;
  for (const [name, v] of g3enum) {
    const tail = name.slice(5), kind = /^TM\d\d$/.test(tail) ? "tm" : /^HM\d\d$/.test(tail) ? "hm" : "const";
    IDX[3][v] = matchItem(3, tail, kind, kind === "tm" ? ++tm : kind === "hm" ? ++hm : 0);
  } }
// Gen 4 from pokeheartgold's defines (0-536 consecutive; later defines are not items).
IDX[4] = [];
{ const defs = cDefines(pret("pokeheartgold", "include/constants/items.h"), "ITEM_");
  let tm = 0, hm = 0;
  for (const [name, v] of defs) {
    if (v !== IDX[4].length) break;
    const tail = name.slice(5), kind = /^TM\d\d\d?$/.test(tail) ? "tm" : /^HM\d\d$/.test(tail) ? "hm" : "const";
    IDX[4][v] = matchItem(4, tail, kind, kind === "tm" ? ++tm : kind === "hm" ? ++hm : 0);
  }
  check(IDX[4].length === 537 && tm === 92 && hm === 8, `Gen 4 items ${IDX[4].length}, ${tm} TMs`); }
// Gen 5: Gen 4 ids for 1-536 except mails 137-148 and HM07/HM08 426/427; PokeAPI for the rest.
IDX[5] = IDX[4].map((x, i) => (i >= 137 && i <= 148) || i === 426 || i === 427 ? null : x);
for (const [i, ids] of itemGI[5]) if (i <= 638 && !IDX[5][i] && ((i >= 113 && i <= 148) || i > 536)) IDX[5][i] = { api: ids[0] };
for (let i = 0; i <= 638; i++) IDX[5][i] ??= null;
check(IDX[5].length === 639, "Gen 5 item table 0-638");
compareToPokeApi(1, 250); compareToPokeApi(2, 249); compareToPokeApi(3, 376); compareToPokeApi(4, 536); compareToPokeApi(5, 638);
{ // Every disagreement must be one of the documented PokeAPI defects (data-and-transfers.md §1.3).
  const hx = (g, list, what) => list.map((i) => `${g}:${i}:${what}`);
  const expected = [
    ...hx(1, [7, 9, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x3b], "missing"), "1:75:merged",
    "2:21:wrong", ...hx(2, [0x06, 0x38, 0x73, 0x79, 0x81, 0x98, 0x9e, 0xa7, 0xa8, 0xaa, 0xb4, ...range(0xb5, 0xbd)], "missing"),
    ...hx(2, [0x4a, 0x4e, 0x4f, 0x50, 0x53, 0x54, 0x68, 0x6d, 0x96, 0xad, 0xae], "merged"),
    "3:271:missing", "5:486:wrong", "5:487:wrong",
  ].sort();
  const got = itemDisagree.slice().sort();
  check(got.join() === expected.join(), `item disagreements with PokeAPI changed:\n  got      ${got.join(" ")}\n  expected ${expected.join(" ")}`);
}
// National ids.
const natOfApi = new Map();
IDX[5].forEach((x, i) => { if (x?.api) { check(!natOfApi.has(x.api), `api item ${x.api} twice in Gen 5`); natOfApi.set(x.api, i); } });
const ITEM_NAMES = {};    // national -> { lang: name }
const ITEM_APPROX = {};   // national (own items) -> national of the later item PokeAPI merges it into
function nationalOf(gen, i, x) {
  if (!x) return 0;
  if (x.api) {
    const nat = natOfApi.get(x.api) ?? 10000 + x.api;
    if (!ITEM_NAMES[nat]) { ITEM_NAMES[nat] = {}; for (const l of LANGS) ITEM_NAMES[nat][l] = itemNamesApi[l].get(x.api) ?? itemNamesApi.en.get(x.api); }
    check(ITEM_NAMES[nat].en, `item ${x.api} has no English name`);
    return nat;
  }
  const nat = 20000 + gen * 1000 + i;
  ITEM_NAMES[nat] = { en: x.own[0] };
  if (x.own[1]) ITEM_APPROX[nat] = natOfApi.get(apiByNorm.get(norm(x.own[1])));
  return nat;
}
const ITEMS = {};         // gen -> array index -> national (0 = none)
for (const g of [1, 2, 3, 4, 5]) ITEMS[g] = IDX[g].map((x, i) => nationalOf(g, i, x));
for (const g of [1, 2, 3, 4, 5]) {   // one index per national id within a generation
  const seen = new Map();
  ITEMS[g].forEach((n, i) => { if (n) { check(!seen.has(n), `gen ${g} items ${seen.get(n)} and ${i} are the same item`); seen.set(n, i); } });
}
const MAX_ITEM = { 1: 250, 2: 249, 3: 376, 4: 536, 5: 638 };
// Spot checks: §1.3 corrections and §3.1 trade items.
const natOfName = (en) => Number(Object.keys(ITEM_NAMES).find((k) => ITEM_NAMES[k].en === en));
check(ITEM_NAMES[ITEMS[2][0x15]].en === "Max Elixir" && ITEM_NAMES[ITEMS[2][0x79]].en === "Energy Powder" && ITEMS[3][271] === natOfName("Basement Key")
  && ITEMS[5][226] === natOfName("Deep Sea Tooth") && ITEMS[5][227] === natOfName("Deep Sea Scale")
  && ITEM_NAMES[ITEMS[5][486]].en === "Yellow Apricorn" && ITEM_NAMES[ITEMS[5][487]].en === "Blue Apricorn", "corrected item spot checks");
check(ITEMS[2][0x52] === 221 && ITEMS[3][187] === 221 && ITEMS[2][0x8f] === 233 && ITEMS[3][199] === 233 && ITEMS[2][0x97] === 235 && ITEMS[3][201] === 235
  && ITEMS[2][0xac] === 252 && ITEMS[3][218] === 252 && ITEMS[3][192] === 226 && ITEMS[3][193] === 227 && ITEMS[2][0x70] === 229 && ITEMS[3][195] === 229,
  "trade-evolution items (King's Rock, Metal Coat, Dragon Scale, Up-Grade, DeepSea items, Everstone)");

/* ---------- item conversion tables ---------- */

// Time Capsule: Gen 1 catch-rate bytes that are unused Gen 2 ids, replaced by real items (pokecrystal).
const G1_CATCH_RATE_FIX = {};
{ const g2 = new Map(asmConsts(pret("pokecrystal", "constants/item_constants.asm"), "").filter((c) => c.kind === "const").map((c) => [c.name, c.value]));
  for (const m of pret("pokecrystal", "data/items/catch_rate_items.asm").matchAll(/^\s*db\s+(-1|\w+),\s*(\w+)/gm))
    G1_CATCH_RATE_FIX[m[1] === "-1" ? 0xff : g2.get(m[1])] = g2.get(m[2]);
  check(JSON.stringify(G1_CATCH_RATE_FIX) === JSON.stringify({ 25: 0x92, 45: 0x53, 50: 0xae, 90: 0xad, 100: 0xad, 120: 0xad, 135: 0xad, 190: 0xad, 195: 0xad, 220: 0xad, 250: 0xad, 255: 0xad }),
    `catch-rate fix table ${JSON.stringify(G1_CATCH_RATE_FIX)}`); }
// Pal Park: Gen 3 items a Pokémon may not hold (pokeplatinum sInvalidGBAItems, resolved via its GBA item enum).
const PAL_PARK_BLOCKED_G3 = [];
{ const gba = new Map(cEnum(pret("pokeplatinum", "include/constants/gba/items.h"), /enum GbaItem\s*\{/));
  const src = pret("pokeplatinum", "src/main_menu/gba_migrator.c");
  const body = src.slice(src.indexOf("{", src.indexOf("sInvalidGBAItems[]")), src.indexOf("}", src.indexOf("sInvalidGBAItems[]")));
  for (const m of body.matchAll(/GBA_ITEM_\w+/g)) { check(gba.has(m[0]), `unknown ${m[0]}`); PAL_PARK_BLOCKED_G3.push(gba.get(m[0])); }
  PAL_PARK_BLOCKED_G3.sort((a, b) => a - b);
  const doc = [5, ...range(52, 62), 72, 82, ...range(87, 92), ...range(99, 102), 105, ...range(112, 120), ...range(121, 132), ...range(176, 178),
    ...range(226, 253), ...range(259, 288), ...range(339, 346), 347, 348, ...range(349, 376)];
  check(PAL_PARK_BLOCKED_G3.join() === doc.join(), `Pal Park blocked list (${PAL_PARK_BLOCKED_G3.length}) differs from the documented 145`);
  // The GBA enum must name the same items as pokeemerald's enum.
  for (const [name, v] of gba) if (v <= 376) check(g3enum[v]?.[0] === name.replace(/^GBA_/, ""), `GBA item ${v} ${name} vs pokeemerald ${g3enum[v]?.[0]}`);
}
const G4_TO_G5_EXCEPTIONS = [...range(137, 148), 426, 427];
for (let i = 1; i <= 536; i++) if (ITEMS[4][i]) check(G4_TO_G5_EXCEPTIONS.includes(i) ? ITEMS[4][i] !== ITEMS[5][i] : ITEMS[4][i] === ITEMS[5][i], `Gen 4/5 item ${i}`);
// Gen 3 -> Gen 4 (Item_FromGBAID): the Gen 4 item that is the same PokeAPI item; 0 if none.
const G3_TO_G4 = ITEMS[3].map((n) => (n ? Math.max(0, ITEMS[4].indexOf(n)) : 0));
check(G3_TO_G4[13] === 17 && G3_TO_G4[200] === 234 && G3_TO_G4[175] === 208 && G3_TO_G4[289] === 328, "G3_TO_G4 spot checks (§2.2)");
{ // Independent check by constant name: pokeplatinum's Gen 4 items carry the GBA constant of the same name.
  const g4names = new Map(cDefines(pret("pokeheartgold", "include/constants/items.h"), "ITEM_").filter(([, v]) => v <= 536).map(([n, v]) => [norm(n.slice(5)), v]));
  let nameMatched = 0;
  for (let i = 1; i <= 376; i++) {
    if (PAL_PARK_BLOCKED_G3.includes(i)) continue;
    const byName = g4names.get(norm(g3enum[i][0].slice(5)));
    check(byName == null || byName === G3_TO_G4[i], `G3_TO_G4[${i}] ${g3enum[i][0]}: ${G3_TO_G4[i]} vs name match ${byName}`);
    check(G3_TO_G4[i] > 0, `Gen 3 item ${i} ${g3enum[i][0]} has no Gen 4 equivalent but is not blocked`);
    if (byName != null) nameMatched++;
  }
  check(nameMatched >= 200, `only ${nameMatched} Gen 3 items matched Gen 4 by constant name`);
}

/* ---------- met locations (English) ---------- */

const locNameEn = new Map(csv("location_names").filter((r) => Number(r.local_language_id) === LANG.en).map((r) => [Number(r.location_id), r.name]));
const locGI = groupBy(csv("location_game_indices").filter((r) => Number(r.generation_id) <= 5), (r) => Number(r.generation_id));
const apiLoc = (g) => { const m = new Map(); for (const r of locGI.get(g)) (m.get(Number(r.game_index)) ?? m.set(Number(r.game_index), []).get(Number(r.game_index))).push(locNameEn.get(Number(r.location_id))); return m; };
const LOCATIONS = { 2: {}, 3: {}, 4: {}, 5: {} };
{ // Gen 2: Crystal landmarks (pokecrystal), names in the games' own spelling; 0x7E/0x7F are caught-data codes.
  const lm = pret("pokecrystal", "data/maps/landmarks.asm");
  const labels = [...lm.matchAll(/^\s*landmark\s+-?\d+,\s*-?\d+,\s*(\w+)/gm)].map((m) => m[1]);
  const text = new Map([...lm.matchAll(/^(\w+):\s*db\s+"([^"]*)"/gm)].map((m) => [m[1], m[2].replace(/<BSP>/g, " ").replace(/@$/, "")]));
  const consts = asmConsts(pret("pokecrystal", "constants/landmark_constants.asm"), "landmark_constants");
  const landmarks = consts.filter((c) => c.name.startsWith("LANDMARK_") && c.value < 0x7e);
  check(labels.length === 0x60 && landmarks.length === 0x60, `Crystal landmarks ${labels.length}`);
  labels.forEach((l, i) => { if (i > 0) LOCATIONS[2][i] = titleCase(text.get(l)); });
  check(consts.find((c) => c.name === "LANDMARK_GIFT")?.value === 0x7e && consts.find((c) => c.name === "LANDMARK_EVENT")?.value === 0x7f, "Gen 2 gift/event codes");
  LOCATIONS[2][0x7e] = "Gift"; LOCATIONS[2][0x7f] = "Event";
  check(LOCATIONS[2][0x46] === "Lav Radio Tower" && LOCATIONS[2][0x58] === "Victory Road" && LOCATIONS[2][0x59] === "Route 23", "Gen 2 landmarks 0x46/0x58/0x59");
}
{ // Gen 3: Emerald sections, FR/LG names for the Kanto/Sevii block 0x58-0xC4, specials 0xFD-0xFF.
  const em = JSON.parse(pret("pokeemerald", "src/data/region_map/region_map_sections.json")).map_sections;
  const fr = JSON.parse(pret("pokefirered", "src/data/region_map/region_map_sections.json")).map_sections;
  check(em.length === 0xd5 && fr.length === 0xc5, `Gen 3 sections E ${em.length} FRLG ${fr.length}`);
  for (let i = 0; i < 0xd5; i++) {
    const src = i >= 0x58 && i <= 0xc4 ? fr[i] : em[i];
    if (i >= 0x58 && i <= 0xc4) check(fr[i].id === em[i].id.replace(/_FRLG$/, ""), `FR/LG section ${i} ${fr[i].id} vs E ${em[i].id}`);
    // 0x42 is the R/S hideout ("{AQUA}" is Emerald's placeholder; Ruby shows Magma, Sapphire/Emerald Aqua).
    if (src.name) LOCATIONS[3][i] = titleCase(src.name.replace("{AQUA}", "AQUA"));
  }
  Object.assign(LOCATIONS[3], { 0xfd: "Special Egg", 0xfe: "In-game trade", 0xff: "Fateful encounter" });
}
{ // Gen 4: HGSS location names 0-234 (superset of DP/Pt 0-125), Platinum special met locations 2000-2012, PokeAPI events.
  const hg = JSON.parse(pret("pokeheartgold", "files/msgdata/msg/msg_0279.json")).messages;
  const pt = JSON.parse(pret("pokeplatinum", "res/text/location_names.json")).messages;
  const sp = JSON.parse(pret("pokeplatinum", "res/text/special_met_location_names.json")).messages;
  check(hg.length === 235 && pt.length === 126 && sp.length === 13, `Gen 4 names ${hg.length}/${pt.length}/${sp.length}`);
  hg.forEach((m, i) => { LOCATIONS[4][i] = m.en_US; });
  const ptDiff = pt.map((m, i) => m.en_US !== hg[i].en_US ? i : -1).filter((i) => i >= 0);
  check(ptDiff.join() === "", `Platinum and HGSS location names differ at ${ptDiff}`);
  sp.forEach((m, i) => { LOCATIONS[4][2000 + i] = m.en_US; });
  for (const [i, names] of apiLoc(4)) if (i >= 2013 && i < 2100 || i >= 3000) { check(names.length === 1, `Gen 4 location ${i} twice`); LOCATIONS[4][i] = names[0]; }
  check(LOCATIONS[4][55] === "Pal Park" && LOCATIONS[4][2002] === "Link trade" && LOCATIONS[4][3002] === "Faraway place", "Gen 4 locations 55/2002/3002");
}
{ // Gen 5: PokeAPI, with 30001 added and the duplicate 30007 split (§1.3): 30004-30007 are Kanto, Johto, Hoenn,
  // Sinnoh and 30008 the distant land, as the pokebw2 decompilation's met-location constants (30007 SINNOH,
  // 30008 FARAWAY; read only) show. PokeAPI's second 30007 row carries that name.
  for (const [i, names] of apiLoc(5)) {
    if (i === 30007) { check(names.sort().join() === "Distant land,Sinnoh", "30007 duplicate"); LOCATIONS[5][i] = "Sinnoh"; continue; }
    check(new Set(names).size === 1, `Gen 5 location ${i} has ${names.length} different names`);
    LOCATIONS[5][i] = names[0];
  }
  check(!(30001 in LOCATIONS[5]) && !(30008 in LOCATIONS[5]), "PokeAPI now lists 30001 or 30008");
  LOCATIONS[5][30001] = "Poké Transfer";
  LOCATIONS[5][30008] = "Distant land";
}

/* ---------- games, languages, balls ---------- */

const versionNames = namesBy(csv("version_names"), "version_id");
const vname = (ident, l) => versionNames[l].get(versionId.get(ident)) ?? versionNames.en.get(versionId.get(ident));
// Origin-game byte of Gen 3-5 records (format-gen4.md §8, format-gen5.md §8.4).
const ORIGIN_IDENTS = { 1: ["S", "sapphire"], 2: ["R", "ruby"], 3: ["E", "emerald"], 4: ["FR", "firered"], 5: ["LG", "leafgreen"],
  7: ["HG", "heartgold"], 8: ["SS", "soulsilver"], 10: ["D", "diamond"], 11: ["P", "pearl"], 12: ["Pt", "platinum"],
  15: ["CXD", "colosseum", "xd"], 20: ["W", "white"], 21: ["B", "black"], 22: ["W2", "white-2"], 23: ["B2", "black-2"] };
const ORIGIN_GAMES = {};
for (const [id, [code, ...idents]] of Object.entries(ORIGIN_IDENTS)) {
  for (const i of idents) check(versionId.has(i), `version ${i}`);
  ORIGIN_GAMES[id] = { code, gen: Math.max(...idents.map((i) => vgGen.get(Number(versionsRows.find((r) => r.identifier === i).version_group_id)))),
    names: Object.fromEntries(LANGS.map((l) => [l, idents.map((i) => vname(i, l)).join("/")])) };
}
check(ORIGIN_GAMES[15].gen === 3 && ORIGIN_GAMES[23].gen === 5 && ORIGIN_GAMES[12].names.en === "Platinum", "origin games");
// Game codes used in record metadata (meta.game), per generation, with the PokeAPI versions they cover.
const GAME_CODE_IDENTS = {
  1: { RG: ["red-japan", "green-japan"], RB: ["red", "blue"], R: ["red"], B: ["blue"], Y: ["yellow"] },
  2: { GS: ["gold", "silver"], G: ["gold"], S: ["silver"], C: ["crystal"] },
  3: { RS: ["ruby", "sapphire"], R: ["ruby"], S: ["sapphire"], E: ["emerald"], FRLG: ["firered", "leafgreen"], FR: ["firered"], LG: ["leafgreen"], CXD: ["colosseum", "xd"] },
  4: { DP: ["diamond", "pearl"], D: ["diamond"], P: ["pearl"], Pt: ["platinum"], HGSS: ["heartgold", "soulsilver"], HG: ["heartgold"], SS: ["soulsilver"] },
  5: { BW: ["black", "white"], B: ["black"], W: ["white"], B2W2: ["black-2", "white-2"], B2: ["black-2"], W2: ["white-2"] },
};
const GAME_CODES = {};
for (const [g, codes] of Object.entries(GAME_CODE_IDENTS)) {
  GAME_CODES[g] = {};
  for (const [code, idents] of Object.entries(codes)) {
    for (const i of idents) check(versionId.has(i) && vgGen.get(Number(versionsRows.find((r) => r.identifier === i).version_group_id)) === Number(g), `game code ${code}: ${i}`);
    GAME_CODES[g][code] = { origins: Object.keys(ORIGIN_GAMES).filter((id) => ORIGIN_IDENTS[id].slice(1).some((i) => idents.includes(i))).map(Number),
      names: Object.fromEntries(LANGS.map((l) => [l, idents.map((i) => vname(i, l)).join("/")])) };
  }
}
// Language byte of Gen 3-5 records (format-gen3.md §8.2, format-gen4.md §8): 6 unused, 8 Korean from Gen 4.
const LANG_IDS = { ja: 1, en: 2, fr: 3, it: 4, de: 5, es: 7, ko: 8 };
// Ball ids (stored in the record) -> national item id. Gen 3: 1-12; Gen 4: 1-16, HGSS 17-24 (= items 492-499), 25 Park
// (defined, never stored); Gen 5: 1-24 as HGSS, 25 Dream Ball (item 576). format-gen4.md §12.9, format-gen5.md §8.
const BALLS = { 3: [0], 4: [0], 5: [0] };
for (let b = 1; b <= 12; b++) BALLS[3].push(ITEMS[3][b]);
for (const g of [4, 5]) for (let b = 1; b <= 25; b++) BALLS[g].push(ITEMS[g][b <= 16 ? b : b <= 24 ? b + 475 : g === 4 ? 500 : 576]);
check(ITEM_NAMES[BALLS[3][12]].en === "Premier Ball" && ITEM_NAMES[BALLS[4][17]].en === "Fast Ball" && ITEM_NAMES[BALLS[4][24]].en === "Sport Ball"
  && ITEM_NAMES[BALLS[4][25]].en === "Park Ball" && ITEM_NAMES[BALLS[5][25]].en === "Dream Ball" && ITEM_NAMES[BALLS[5][16]].en === "Cherish Ball", "ball table");

/* ---------- evolutions ---------- */

const triggers = new Map(csv("evolution_triggers").map((r) => [Number(r.id), r.identifier]));
const natItem = (api) => (api == null ? null : natOfApi.get(api) ?? 10000 + api);
/** PokeAPI form id -> its Gen 5 (else Gen 4) form index; null for a default form (index 0). */
function formIndex(formId) {
  if (formId == null) return null;
  const gi = (formGens.get(formId) ?? []).filter((r) => Number(r.generation_id) <= 5).sort((a, b) => b.generation_id - a.generation_id)[0];
  check(gi, `form ${formId} has no Gen 4/5 index`);
  return gi && Number(gi.game_index) ? Number(gi.game_index) : null;
}
// Friendship evolutions need 220 in Gen 2-7 (pokecrystal HAPPINESS_TO_EVOLVE, pokeemerald FRIENDSHIP_EVO_THRESHOLD,
// pokeplatinum EVOLVE_FRIENDSHIP_THRESHOLD); PokeAPI mostly lists Gen 8's 160.
const FRIENDSHIP_TO_EVOLVE = 220;
const EVOLUTIONS = [];
for (const r of csv("pokemon_evolution").sort((a, b) => a.id - b.id)) {
  const to = Number(r.evolved_species_id), gen = vgGen.get(Number(r.version_group_id));
  if (to > NSPECIES || gen > 5) continue;
  const e = { from: species.evolvesFrom[to], to, gen, method: triggers.get(Number(r.evolution_trigger_id)) };
  check(e.from > 0 && e.method, `evolution row ${r.id}`);
  const opt = {
    level: int(r.minimum_level), item: natItem(int(r.trigger_item_id)), heldItem: natItem(int(r.held_item_id)),
    gender: r.gender_id === "1" ? "F" : r.gender_id === "2" ? "M" : null, time: r.time_of_day || null,
    move: int(r.known_move_id), moveType: r.known_move_type_id ? TYPE_NAMES_EN[TYPE_OF_API.get(Number(r.known_move_type_id))] : null,
    happiness: r.minimum_happiness ? FRIENDSHIP_TO_EVOLVE : null, beauty: int(r.minimum_beauty), partySpecies: int(r.party_species_id),
    partner: int(r.trade_species_id), stats: r.relative_physical_stats === "" ? null : Number(r.relative_physical_stats),
    location: r.location_id ? locNameEn.get(Number(r.location_id)) : null,
    fromForm: formIndex(int(r.required_pokemon_form_id)), toForm: formIndex(int(r.evolved_pokemon_form_id)),
  };
  check(!r.party_type_id && r.needs_overworld_rain !== "1" && r.turn_upside_down !== "1", `evolution row ${r.id} uses a Gen 6+ condition`);
  check(!r.minimum_happiness || ["160", "220"].includes(r.minimum_happiness), `evolution row ${r.id} friendship ${r.minimum_happiness}`);
  // ARCHITECTURE.md: `item` is the item that triggers it; for trades that is the held item, which is consumed.
  if (e.method === "trade" && opt.heldItem != null) { opt.item = opt.heldItem; opt.heldItem = null; }
  for (const [k, v] of Object.entries(opt)) if (v != null) e[k] = v;
  EVOLUTIONS.push(e);
}
{ // §3.1 trade evolutions
  const trade = EVOLUTIONS.filter((e) => e.method === "trade").map((e) => [e.from, e.to, e.gen, e.item ?? 0, e.partner ?? 0].join(":")).sort();
  const doc = ["64:65:1:0:0", "67:68:1:0:0", "75:76:1:0:0", "93:94:1:0:0", "61:186:2:221:0", "79:199:2:221:0", "95:208:2:233:0", "123:212:2:233:0",
    "117:230:2:235:0", "137:233:2:252:0", "366:367:3:226:0", "366:368:3:227:0", "112:464:4:321:0", "125:466:4:322:0", "126:467:4:323:0",
    "233:474:4:324:0", "356:477:4:325:0", "525:526:5:0:0", "533:534:5:0:0", "588:589:5:0:616", "616:617:5:0:588", "349:350:5:537:0"].sort();
  check(trade.join() === doc.join(), `trade evolutions differ from §3.1:\n  ${trade.join(" ")}`);
}

/* ---------- Showdown names, sprite stems ---------- */

// Showdown spells species as the English name except the Nidoran pair; formes are "<Species>-<Forme>".
const SHOWDOWN_SPECIES = { 29: "Nidoran-F", 32: "Nidoran-M" };
const SHOWDOWN_FORME_CASE = { "spiky-eared": "Spiky-eared" };
const showdownForme = (ident) => SHOWDOWN_FORME_CASE[ident] ?? ident.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("-");
for (const sp of Object.keys(FORMS)) for (const rec of FORMS[sp].list) rec.showdown = rec.showdown ? showdownForme(rec.showdown) : "";

/* ---------- hand-written rule tables ---------- */

// HM moves per generation (and per game where they differ). Gen 1/2 from the pret HM constants, Gen 3 from
// pokeplatinum sGBAHMMoves; Gen 4 and 5 from data-and-transfers.md §2.3 and the games' HM lists.
const moveByNorm = new Map(moveRows.map((r) => [norm(r.identifier), Number(r.id)]));
const MOVE_ALIAS = { psychicm: "psychic", solarbeam: "solar-beam", dynamicpunch: "dynamic-punch" };
const moveId = (c) => moveByNorm.get(MOVE_ALIAS[norm(c)] ? norm(MOVE_ALIAS[norm(c)]) : norm(c));
const HM_MOVES = {
  1: asmConsts(pret("pokered", "constants/item_constants.asm"), "").filter((c) => c.kind === "hm").map((c) => moveId(c.name)),
  2: asmConsts(pret("pokecrystal", "constants/item_constants.asm"), "").filter((c) => c.kind === "hm").map((c) => moveId(c.name)),
  3: [...pret("pokeplatinum", "src/main_menu/gba_migrator.c").slice(pret("pokeplatinum", "src/main_menu/gba_migrator.c").indexOf("sGBAHMMoves[]")).match(/\{([^}]*)\}/)[1]
    .matchAll(/MOVE_(\w+)/g)].map((m) => moveId(m[1])),
  4: { DP: [15, 19, 57, 70, 432, 249, 127, 431], Pt: [15, 19, 57, 70, 432, 249, 127, 431], HGSS: [15, 19, 57, 70, 250, 249, 127, 431] },
  5: [15, 19, 57, 70, 127, 291],
};
check(HM_MOVES[1].join() === "15,19,57,70,148" && HM_MOVES[2].join() === "15,19,57,70,148,250,127" && HM_MOVES[3].join() === "15,19,57,70,148,249,127,291",
  `HM lists ${JSON.stringify(HM_MOVES)}`);
// Gen 3 records do not store Deoxys' form: it follows the cartridge (§2.2). Gen 4 form numbers.
const DEOXYS_GEN3_FORM = { R: 0, S: 0, RS: 0, FR: 1, LG: 2, E: 3, CXD: 0 };
// Obedience of outsider Pokémon (§3.4): base cap 10, then the highest cap whose rule holds (100 = every level).
// badges: [bit in the game's own badge flags, cap]; count: [number of badges owned, cap]. From the games' code:
// pokered CheckForDisobedience, pokecrystal BattleCommand_CheckObedience (wJohtoBadges order is Zephyr, Hive,
// Plain, Fog, Mineral, Storm, Glacier, Rising, so Storm is bit 5), pokeemerald IsMonDisobedient, pokeplatinum and
// pokeheartgold battle_controller_player.c (DP/Pt count badges; HGSS counts Johto bits 0-7 plus Kanto bits 8-15
// for 20/30/all and tests the Fog and Mineral flags, bits 3 and 5 in BADGE_* order). B/W from Bulbapedia.
const OBEDIENCE = {
  1: { badges: [[1, 30], [3, 50], [5, 70], [7, 100]] },                                   // Cascade, Rainbow, Marsh, Earth
  2: { badges: [[1, 30], [3, 50], [5, 70], [7, 100]] },                                   // Hive, Fog, Storm, Rising
  HGSS: { count: [[1, 20], [2, 30], [8, 100]], badges: [[3, 50], [5, 70]] },              // any 1, any 2, Fog, Mineral, any 8
  3: { badges: [[1, 30], [3, 50], [5, 70], [7, 100]] },                                   // R/S/E: Knuckle, Heat, Feather, Rain
  FRLG: { badges: [[1, 30], [3, 50], [5, 70], [7, 100]] },                                // as R/B/Y
  4: { count: [[2, 30], [4, 50], [6, 70], [8, 100]] },                                    // D/P/Pt
  5: { badges: [[0, 20], [1, 30], [2, 40], [3, 50], [4, 60], [5, 70], [6, 80], [7, 100]] }, // B/W and B2/W2
};

/* ---------- emit ---------- */

if (failures.length) {
  console.error(`build-data: ${failures.length} cross-check failure(s):\n- ` + failures.join("\n- "));
  process.exit(1);
}

const PKAPI = "PokeAPI (BSD-3-Clause, see LICENSE.pokeapi)";
const json = (v) => JSON.stringify(v);
const lines = (arr) => { for (const s of arr) if (/\n/.test(s ?? "")) throw new Error(`newline in ${s}`); return json(arr.map((s) => s ?? "").join("\n")); };
const letters = (arr) => arr.map((t) => String.fromCharCode(97 + t)).join("");
const written = [];
function emit(file, what, sourcesText, exportsObj) {
  let out = `/* Generated by scripts/build-data.mjs; do not edit. ${what}\n   Sources: ${sourcesText}. */\n`;
  for (const [k, v] of Object.entries(exportsObj)) out += `export const ${k} = ${v};\n`;
  fs.writeFileSync(path.join(OUT, file), out);
  written.push(file);
}
fs.mkdirSync(OUT, { recursive: true });

emit("species.js", "Per-species attributes, indexed by National Dex number (index 0 unused).", PKAPI, {
  SPECIES_GEN: json(species.gen.map(String).join("")),
  GENDER: json(species.gender), GROWTH: json(species.growth.map(String).join("")),
  FRIENDSHIP: json(species.friendship), CATCH_RATE: json(species.catchRate), EVOLVES_FROM: json(species.evolvesFrom), EGG_CYCLES: json(species.egg),
});
for (const l of LANGS) emit(`names.${l}.js`, `Species names (${l}), "\\n"-separated, index = National Dex.`, PKAPI, {
  SPECIES: lines(range(0, NSPECIES).map((i) => (i ? speciesNames[l].get(i) : ""))),
});
const natIds = Object.keys(ITEM_NAMES).map(Number).sort((a, b) => a - b);
for (const l of LANGS) emit(`text.${l}.js`, `Move, ability, item, nature and type names (${l}); missing entries fall back to English.`, PKAPI, {
  MOVES: lines(range(0, 559).map((i) => (i ? moveNames[l].get(i) ?? moveNames.en.get(i) : ""))),
  ABILITIES: lines(range(0, 164).map((i) => (i ? abilityNames[l].get(i) ?? abilityNames.en.get(i) : ""))),
  NATURES: lines(natureRows.map((r) => natureNamesApi[l].get(Number(r.id)) ?? natureNamesApi.en.get(Number(r.id)))),
  TYPES: lines(TYPE_IDS.map((api) => typeNamesApi[l].get(api) ?? typeNamesApi.en.get(api) ?? "???")),
  ITEM_IDS: json(natIds),
  ITEMS: lines(natIds.map((n) => ITEM_NAMES[n][l] ?? ITEM_NAMES[n].en)),
});
emit("basestats.js", "Base stats [hp, atk, def, spa, spd, spe] x species (Gen 2-5; Gen 1 differs only by Special).", PKAPI, {
  BASE: json(BASE), SPECIAL1: json(SPECIAL1),
});
emit("types.js", "Types per species (Gen 2-5, two letters a-r per species = canonical type index), Gen 1 differences, stored type bytes.", PKAPI, {
  TYPE_NAMES: json(TYPE_NAMES_EN), SPECIES_TYPES: json(letters(SPECIES_TYPES.flat())), GEN1_TYPES: json(GEN1_TYPES), TYPE_BYTES: json(TYPE_BYTES),
});
emit("abilities.js", "Ability slots per species: Gen 3/4 [slot1, slot2], Gen 5 [slot1, slot2, hidden]; 0 = none.", PKAPI, {
  MAX_ABILITY: json(MAX_ABILITY), AB3: json(AB[3]), AB4: json(AB[4]), AB5: json(AB[5]), NEW_ABILITY_G4: json(NEW_ABILITY_G4),
});
emit("moves.js", "Moves as of Gen 5 (type letter, power, pp, accuracy, category 0 physical / 1 special / 2 status) and older values per generation.", PKAPI, {
  MAX_MOVE: json(MAX_MOVE),
  MOVE_TYPE: json(letters(MOVES5.map((m) => m[0]))), MOVE_POWER: json(MOVES5.map((m) => m[1])), MOVE_PP: json(MOVES5.map((m) => m[2])),
  MOVE_ACC: json(MOVES5.map((m) => m[3])), MOVE_CAT: json(MOVES5.map((m) => m[4]).join("")), MOVES_OLD: json(MOVES_OLD),
});
emit("items.js", "Item index -> national item id per generation (0 = no item); ball ids -> national item ids.",
  `pret pokered/pokecrystal/pokeemerald/pokeheartgold item constants (facts only), ${PKAPI}`, {
  MAX_ITEM: json(MAX_ITEM), ITEMS: json(ITEMS), ITEM_APPROX: json(ITEM_APPROX), BALLS: json(BALLS),
});
emit("item-maps.js", "Item rules for conversions (data-and-transfers.md §2.1-2.3).", "pret pokecrystal catch_rate_items, pokeplatinum gba_migrator (facts only)", {
  G1_CATCH_RATE_FIX: json(G1_CATCH_RATE_FIX), PAL_PARK_BLOCKED_G3: json(PAL_PARK_BLOCKED_G3), G4_TO_G5_EXCEPTIONS: json(G4_TO_G5_EXCEPTIONS), G3_TO_G4: json(G3_TO_G4),
});
emit("locations.js", "Met location names (English) per generation, keyed by the stored id.",
  `pret pokecrystal landmarks, pokeemerald/pokefirered map sections, pokeheartgold/pokeplatinum location text (facts only), ${PKAPI}`, {
  LOCATIONS: json(LOCATIONS),
});
emit("games.js", "Origin-game ids (Gen 3-5 records), game codes per generation, language bytes.", PKAPI, {
  ORIGIN_GAMES: json(ORIGIN_GAMES), GAME_CODES: json(GAME_CODES), LANG_IDS: json(LANG_IDS),
});
emit("exp.js", "Minimum EXP per level: EXP[growth * 101 + level], growth = game index 0-5 (level 1 = 0).", PKAPI, { EXP: json(EXP) });
emit("index-maps.js", "Internal species orders -> National Dex (0 = unused slot).", `${PKAPI}, checked against pret pokered/pokecrystal/pokeemerald`, {
  GEN1_TO_NATIONAL: json(gen1), GEN3_TO_NATIONAL: json(gen3),
});
emit("evolutions.js", "Evolutions up to Gen 5 (gen = generation the method appears in; items are national ids).", PKAPI, { EVOLUTIONS: json(EVOLUTIONS) });
const formsOut = {};
for (const sp of Object.keys(FORMS)) {
  formsOut[sp] = { list: FORMS[sp].list.map((r) => {
    const o = { id: r.ident, name: r.name, stem: r.stem, showdown: r.showdown };
    if (r.battleOnly) o.battleOnly = true;
    if (r.data) o.data = r.data;
    return o;
  }), gens: FORMS[sp].gens };
}
emit("forms.js", "Forms per species: list of forms and, per generation, the form stored at each index. FORM_DATA holds forms whose stats/types/abilities differ.",
  `${PKAPI}; Showdown forme spelling curated`, {
  FORMS: json(formsOut), FORM_DATA: json(VARIANTS), SHOWDOWN_SPECIES: json(SHOWDOWN_SPECIES), DEOXYS_GEN3_FORM: json(DEOXYS_GEN3_FORM),
});
emit("hm.js", "HM moves per generation (Gen 4 per game).", "pret pokered/pokecrystal HM constants, pokeplatinum sGBAHMMoves; Gen 4/5 hand-written", {
  HM_MOVES: json(HM_MOVES),
});
emit("obedience.js", "Obedience level caps for outsider Pokémon by badges (per generation, HGSS and FR/LG separately).",
  "hand-written from pret pokered/pokecrystal/pokeemerald/pokeplatinum/pokeheartgold obedience checks; B/W from Bulbapedia", { OBEDIENCE: json(OBEDIENCE) });

// Licence notice and provenance.
fs.writeFileSync(path.join(OUT, "LICENSE.pokeapi"),
  "Data in this directory derived from PokeAPI (https://github.com/PokeAPI/pokeapi) is distributed under the\n" +
  "following licence (BSD-3-Clause; LICENSE.md of the pinned commit listed in SOURCES.json). Pokémon names and\n" +
  "game data are trademarks of Nintendo, Creatures Inc. and GAME FREAK inc.\n\n" +
  pret("pokeapi", "LICENSE.md"));
const SOURCES = {
  note: "Inputs of scripts/build-data.mjs. Every file is fetched at the pinned commit; sha256 is of the fetched bytes.",
  repos: Object.fromEntries(Object.entries(REPOS).map(([k, [slug, sha]]) => [k, { repo: slug, commit: sha }])),
  files: FILES.map(([repo, file]) => ({ repo, path: file, ...sources[`${repo}:${file}`] })),
  generated: [...written, "LICENSE.pokeapi"],
};
fs.writeFileSync(path.join(OUT, "SOURCES.json"), JSON.stringify(SOURCES, null, 2) + "\n");
const total = written.reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log(`build-data: wrote ${written.length} modules (${(total / 1024).toFixed(1)} KiB) to ${path.relative(ROOT, OUT)}/`);
