/* Game data for Gen 1-5. The only module other code imports from shared/data/.

   Everything here is a synchronous lookup over the generated tables next to this file (built by
   scripts/build-data.mjs from pinned PokeAPI and pret inputs; see docs/research/data-and-transfers.md).
   Conventions:
   - species = National Dex number; form = the form index the record stores in that generation (0 = base).
   - types are English names ("Fire", "???"); typeName() localizes them.
   - items: each generation has its own index space. A "national" item id is the Gen 5 index when the item
     exists in Gen 5 (so Gen 4/5 records already hold it, except Gen 4 mails 137-148 and HM07/HM08 426/427),
     10000 + PokeAPI id for other items PokeAPI knows, 20000 + gen * 1000 + index for generation-only items.
     Convert between generations with itemFromNational(toGen, itemToNational(fromGen, index)).
   - lang is "en" | "fr" | "de" | "it" | "es" | "ja" | "ko". Species names are loaded for every language;
     move/item/ability/nature/type names other than English need `await loadLanguage(lang)` first and fall
     back to English until then. */
import { SPECIES_GEN, GENDER, GROWTH, FRIENDSHIP, CATCH_RATE, EVOLVES_FROM, EGG_CYCLES } from "./species.js";
import { SPECIES as N_EN } from "./names.en.js";
import { SPECIES as N_FR } from "./names.fr.js";
import { SPECIES as N_DE } from "./names.de.js";
import { SPECIES as N_IT } from "./names.it.js";
import { SPECIES as N_ES } from "./names.es.js";
import { SPECIES as N_JA } from "./names.ja.js";
import { SPECIES as N_KO } from "./names.ko.js";
import * as TEXT_EN from "./text.en.js";
import { BASE, SPECIAL1 } from "./basestats.js";
import { TYPE_NAMES, SPECIES_TYPES, GEN1_TYPES, TYPE_BYTES } from "./types.js";
import { MAX_ABILITY as MAX_AB, AB3, AB4, AB5, NEW_ABILITY_G4 } from "./abilities.js";
import { MAX_MOVE as MAX_MV, MOVE_TYPE, MOVE_POWER, MOVE_PP, MOVE_ACC, MOVE_CAT, MOVES_OLD } from "./moves.js";
import { MAX_ITEM as MAX_IT, ITEMS, ITEM_APPROX, BALLS } from "./items.js";
import { LOCATIONS } from "./locations.js";
import { ORIGIN_GAMES, GAME_CODES, LANG_IDS as LANG_BYTES } from "./games.js";
import { EXP } from "./exp.js";
import { GEN1_TO_NATIONAL, GEN3_TO_NATIONAL } from "./index-maps.js";
import { EVOLUTIONS } from "./evolutions.js";
import { FORMS, FORM_DATA, SHOWDOWN_SPECIES, DEOXYS_GEN3_FORM as DEOXYS_G3 } from "./forms.js";
import { HM_MOVES } from "./hm.js";
import { OBEDIENCE } from "./obedience.js";
import { G1_CATCH_RATE_FIX, PAL_PARK_BLOCKED_G3, G4_TO_G5_EXCEPTIONS, G3_TO_G4 } from "./item-maps.js";

const split = (s) => s.split("\n");
const freeze = (o) => Object.freeze(o);

/* ---------- limits ---------- */

/** Highest National Dex number per generation. */
export const MAX_SPECIES = freeze({ 1: 151, 2: 251, 3: 386, 4: 493, 5: 649 });
/** Highest move id per generation (165 Struggle, 251 Beat Up, 354 Psycho Boost, 467 Shadow Force, 559 Fusion Bolt). */
export const MAX_MOVE = freeze({ ...MAX_MV });
/** Highest item index per generation (in that generation's index space). */
export const MAX_ITEM = freeze({ ...MAX_IT });
/** Highest ability id per generation (Gen 1/2 have none). Ability ids are the Gen 4+ numbering everywhere: Gen 3
    records store only a slot bit, and Gen 3's own table (unused Cacophony 76, Air Lock 77) is never needed. */
export const MAX_ABILITY = freeze({ 1: 0, 2: 0, ...MAX_AB });
/** Supported languages. */
export const LANGS = freeze(["en", "fr", "de", "it", "es", "ja", "ko"]);
/** Language byte stored in Gen 3-5 records (1 ja, 2 en, 3 fr, 4 it, 5 de, 7 es, 8 ko). */
export const LANG_IDS = freeze({ ...LANG_BYTES });
/** Language byte -> code, or null. */
export const langFromId = (id) => Object.keys(LANG_BYTES).find((k) => LANG_BYTES[k] === id) ?? null;
/** moveCountForGen(gen) -> MAX_MOVE[gen]. */
export const moveCountForGen = (gen) => MAX_MV[gen] ?? 0;

/* ---------- names ---------- */

const SPECIES_NAMES = { en: split(N_EN), fr: split(N_FR), de: split(N_DE), it: split(N_IT), es: split(N_ES), ja: split(N_JA), ko: split(N_KO) };
const text = {};
function addText(lang, m) {
  const ids = m.ITEM_IDS, names = split(m.ITEMS), items = new Map();
  ids.forEach((id, i) => items.set(id, names[i]));
  text[lang] = { moves: split(m.MOVES), abilities: split(m.ABILITIES), natures: split(m.NATURES), types: split(m.TYPES), items };
}
addText("en", TEXT_EN);
const loading = {};
/** Loads move/item/ability/nature/type names for a language (species names are always loaded). */
export function loadLanguage(lang) {
  if (text[lang]) return Promise.resolve();
  if (!LANGS.includes(lang)) return Promise.reject(new Error(`unknown language ${lang}`));
  return (loading[lang] ??= import(`./text.${lang}.js`).then((m) => addText(lang, m)));
}
/** True once loadLanguage(lang) has finished (always for "en"). */
export const languageLoaded = (lang) => !!text[lang];
const T = (lang) => text[lang] ?? text.en;

/** National Dex -> species name ("Bulbasaur"); null for an unknown number. */
export function speciesName(species, lang = "en") {
  if (!(species >= 1 && species <= 649)) return null;
  return (SPECIES_NAMES[lang] ?? SPECIES_NAMES.en)[species];
}
/** Move id -> name, null when unknown. */
export const moveName = (id, lang = "en") => (id >= 1 && id <= 559 ? T(lang).moves[id] : null);
/** Ability id -> name, null when unknown or 0. */
export const abilityName = (id, lang = "en") => (id >= 1 && id <= 164 ? T(lang).abilities[id] : null);
/** Nature 0..24 (Hardy..Quirky, game order) -> name. */
export const natureName = (i, lang = "en") => (i >= 0 && i < 25 ? T(lang).natures[i] : null);
/** English type name ("Fire") -> localized name. */
export const typeName = (type, lang = "en") => { const i = TYPE_NAMES.indexOf(type); return i < 0 ? null : T(lang).types[i]; };
/** All type names in canonical order (the Gen 3/4 type byte order, ??? = index 9). */
export const TYPES = freeze([...TYPE_NAMES]);
/** Hidden Power type order (Fighting .. Dark). */
export const HIDDEN_POWER_TYPES = freeze(TYPE_NAMES.filter((t, i) => i !== 0 && i !== 9));

/* ---------- species attributes ---------- */

const known = (sp) => sp >= 1 && sp <= 649;
/** Generation that introduced the species, or 0. */
export const speciesGen = (species) => (known(species) ? Number(SPECIES_GEN[species]) : 0);
/** Gender ratio byte: 0 male only, 31/63/127/191 (12.5/25/50/75 % female), 254 female only, 255 genderless. */
export const genderThreshold = (species) => (known(species) ? GENDER[species] : 255);
/** Special genderThreshold() values. */
export const MALE_ONLY = 0, FEMALE_ONLY = 254, GENDERLESS = 255;
/** Growth rate game index: 0 Medium Fast, 1 Erratic, 2 Fluctuating, 3 Medium Slow, 4 Fast, 5 Slow. */
export const growthRate = (species) => (known(species) ? Number(GROWTH[species]) : 0);
/** Species base friendship (Gen 2-4 trades and Pal Park use 70 instead). */
export const baseFriendship = (species) => (known(species) ? FRIENDSHIP[species] : 0);
/** Catch rate, PokeAPI's current value (display only: a few differ in their own games, e.g. Raticate 90 in Gen 1/2,
    Rayquaza 3 in Gen 3/4; Gen 1 records carry their own byte, which Gen 2 reads as the held item). */
export const catchRate = (species) => (known(species) ? CATCH_RATE[species] : 0);
/** Egg cycles. */
export const eggCycles = (species) => (known(species) ? EGG_CYCLES[species] : 0);
/** Pre-evolution's National Dex number, 0 for none. */
export const evolvesFrom = (species) => (known(species) ? EVOLVES_FROM[species] : 0);

/* ---------- experience ---------- */

/** Minimum EXP for a level (1-100) in a growth rate (level 1 = 0, as every Gen 3+ table). */
export function expAtLevel(rate, level) {
  if (!(rate >= 0 && rate <= 5)) throw new RangeError(`growth rate ${rate}`);
  return EXP[rate * 101 + Math.max(1, Math.min(100, level | 0))];
}
/** Largest level whose minimum EXP is <= exp (1-100). */
export function levelAtExp(rate, exp) {
  if (!(rate >= 0 && rate <= 5)) throw new RangeError(`growth rate ${rate}`);
  let lo = 1, hi = 100;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (EXP[rate * 101 + mid] <= exp) lo = mid; else hi = mid - 1; }
  return lo;
}

/* ---------- forms ---------- */

const formList = (species, gen) => {
  const f = FORMS[species];
  if (!f) return null;
  // Gen 3 stores no Deoxys form; callers pass the Gen 4 number derived from the cartridge (DEOXYS_GEN3_FORM).
  const order = f.gens[species === 386 && gen === 3 ? 4 : gen];
  return order ? order.map((i) => f.list[i]) : null;
};
const formRec = (species, form, gen) => formList(species, gen)?.[form] ?? null;
/** Number of forms a record of this species can store in that generation (1 when it has none). */
export const formCount = (species, gen = 5) => formList(species, gen)?.length ?? (known(species) && species <= MAX_SPECIES[gen] ? 1 : 0);
/** Forms of a species in a generation, base form first: [{ form, id, name, battleOnly }]; [] for species without forms. */
export const formsOf = (species, gen = 5) =>
  (formList(species, gen) ?? []).map((r, form) => ({ form, id: r.id, name: r.name || null, battleOnly: !!r.battleOnly }));
/** Form name ("Attack Forme", "B"), null for the base form or an unknown form. Gen selects the numbering (Arceus differs in Gen 4/5). */
export function formName(species, form, gen = 5) {
  if (!form) return null;
  return formRec(species, form, gen)?.name || null;
}
/** Deoxys' form in Gen 3 follows the cartridge: { R, S, RS, FR, LG, E, CXD } -> Gen 4 form number. */
export const DEOXYS_GEN3_FORM = freeze({ ...DEOXYS_G3 });
const formData = (species, form, gen) => { const r = formRec(species, form, gen); return r?.data ? FORM_DATA[r.data] : null; };

/* ---------- base stats, types, abilities ---------- */

/** { hp, atk, def, spa, spd, spe } for that generation (Gen 1: spa = spd = Special); null if the species is not in the gen. */
export function baseStats(gen, species, form = 0) {
  if (!known(species) || species > MAX_SPECIES[gen]) return null;
  const v = formData(species, form, gen)?.stats ?? BASE.slice(species * 6, species * 6 + 6);
  const s = { hp: v[0], atk: v[1], def: v[2], spa: v[3], spd: v[4], spe: v[5] };
  if (gen === 1) s.spa = s.spd = SPECIAL1[species];
  return s;
}
/** Types as English names, one or two entries; null if the species is not in the gen. */
export function types(gen, species, form = 0) {
  if (!known(species) || species > MAX_SPECIES[gen]) return null;
  const fd = formData(species, form, gen);
  const t = fd?.types?.[gen] ?? (gen === 1 ? GEN1_TYPES[species] : null) ??
    [SPECIES_TYPES.charCodeAt(species * 2 - 2) - 97, SPECIES_TYPES.charCodeAt(species * 2 - 1) - 97];
  const names = t.map((i) => TYPE_NAMES[i]);
  return names[0] === names[1] ? [names[0]] : names;
}
/** Type byte stored by that generation (Gen 1/2 struct bytes: Fire 20, ...), or -1 if the type does not exist there. */
export const typeByte = (gen, type) => TYPE_BYTES[gen]?.[TYPE_NAMES.indexOf(type)] ?? -1;
/** Stored type byte -> English type name, or null. */
export function typeFromByte(gen, byte) {
  const i = TYPE_BYTES[gen]?.indexOf(byte) ?? -1;
  return i < 0 ? null : TYPE_NAMES[i];
}
/** [slot1, slot2, hidden] ability ids (0 = none) for Gen 3-5; [0, 0, 0] for Gen 1/2; null if the species is not in the gen. */
export function abilities(gen, species, form = 0) {
  if (!known(species) || species > MAX_SPECIES[gen]) return null;
  if (gen < 3) return [0, 0, 0];
  const fd = formData(species, form, gen)?.abilities?.[gen];
  if (fd) return fd.slice();
  if (gen === 5) return AB5.slice(species * 3 - 3, species * 3);
  const a = gen === 3 ? AB3 : AB4;
  return [a[species * 2 - 2], a[species * 2 - 1], 0];
}
/** True for the 89 species that had one ability in Gen 3 and gained a second in Gen 4 (Pal Park gives them ability 1). */
export const gainedAbilityInGen4 = (species) => NEW_ABILITY_G4.includes(species);

/* ---------- moves ---------- */

/** -> { id, name, type, power, accuracy, pp, category: "Physical" | "Special" | "Status" } as of that gen, or null. */
export function moveInfo(id, gen = 5, lang = "en") {
  if (!(id >= 1 && id <= (MAX_MV[gen] ?? 0))) return null;
  const old = MOVES_OLD[gen]?.[id];
  const [t, power, pp, acc, cat] = old ?? [MOVE_TYPE.charCodeAt(id) - 97, MOVE_POWER[id], MOVE_PP[id], MOVE_ACC[id], Number(MOVE_CAT[id])];
  return { id, name: moveName(id, lang), type: TYPE_NAMES[t], power, accuracy: acc, pp, category: ["Physical", "Special", "Status"][cat] };
}
/** Base PP of a move in that generation (0 when unknown). */
export const basePP = (id, gen = 5) => moveInfo(id, gen)?.pp ?? 0;
/** HM move ids of a generation; Gen 4 depends on the game ("DP", "Pt", "HGSS"; default Pt). */
export function hmMoves(gen, game) {
  const h = HM_MOVES[gen];
  if (!h) return [];
  if (Array.isArray(h)) return h.slice();
  return (h[game === "HGSS" || game === "HG" || game === "SS" ? "HGSS" : game === "DP" || game === "D" || game === "P" ? "DP" : "Pt"]).slice();
}

/* ---------- items ---------- */

/** Item index of a generation -> national item id (0 = none / unused id). */
export const itemToNational = (gen, index) => ITEMS[gen]?.[index] ?? 0;
const reverse = {};
/** National item id -> that generation's index, 0 when the item does not exist there. */
export function itemFromNational(gen, national) {
  if (!national || !ITEMS[gen]) return 0;
  if (!reverse[gen]) { reverse[gen] = new Map(); ITEMS[gen].forEach((n, i) => { if (n && !reverse[gen].has(n)) reverse[gen].set(n, i); }); }
  return reverse[gen].get(national) ?? 0;
}
/** Name of a national item id, null if unknown. */
export const nationalItemName = (national, lang = "en") => T(lang).items.get(national) ?? text.en.items.get(national) ?? null;
/** Name of the item stored with this index in that generation, null for none/unused. */
export const itemName = (gen, index, lang = "en") => nationalItemName(itemToNational(gen, index), lang);
/** -> { gen, index, national, name, approx } | null. approx: for Gen 1/2-only items that PokeAPI merges into a later
    item (Gen 2 MiracleBerry -> Lum Berry), that item's national id; a conversion hint, not an identity. */
export function itemInfo(gen, index, lang = "en") {
  const national = itemToNational(gen, index);
  if (!national) return null;
  return { gen, index, national, name: nationalItemName(national, lang), approx: ITEM_APPROX[national] ?? null };
}
/** Item index in one generation -> the same item's index in another, 0 when it does not exist there. With
    { approx: true } a Gen 1/2-only item falls back to the later item PokeAPI merges it into (our own choice for
    the unofficial Gen 2 -> Gen 3 path, never an official rule). TMs and HMs keep their number, not their move
    (Gen 2 TM01 DynamicPunch -> Gen 3 TM01 Focus Punch), as the games' own item ids do. */
export function convertItem(fromGen, index, toGen, { approx = false } = {}) {
  const n = itemToNational(fromGen, index);
  return itemFromNational(toGen, n) || (approx && ITEM_APPROX[n] ? itemFromNational(toGen, ITEM_APPROX[n]) : 0);
}
/** Time Capsule: Gen 1 catch-rate bytes that are unused Gen 2 ids -> the Gen 2 item that replaces them. */
export { G1_CATCH_RATE_FIX };
/** Gen 1 catch-rate byte -> the Gen 2 held item index it becomes in the Time Capsule (0 stays 0). */
export const gen1CatchRateItem = (byte) => G1_CATCH_RATE_FIX[byte] ?? byte;
/** Gen 3 item ids a Pokémon may not hold through Pal Park (145 ids: Safari Ball, unused ids, mail, key items, HMs). */
export { PAL_PARK_BLOCKED_G3 };
/** Gen 4 item ids that do not exist under the same id in Gen 5 (mails 137-148, HM07/HM08). */
export { G4_TO_G5_EXCEPTIONS };
/** Gen 3 item id -> Gen 4 item id as Pal Park converts it (Item_FromGBAID), 0 = no equivalent. */
export const g3ItemToG4 = (index) => G3_TO_G4[index] ?? 0;
/** Gen 4 item id -> Gen 5 item id (same id except the exceptions and unused Gen 4 ids, which become 0). */
export const g4ItemToG5 = (index) => (itemToNational(4, index) && !G4_TO_G5_EXCEPTIONS.includes(index) ? index : 0);

/* ---------- balls, games, locations ---------- */

/** Ball id stored in a Gen 3-5 record -> national item id (0 if invalid). Gen 4 id 25 is the Park Ball, Gen 5 25 the Dream Ball. */
export const ballItem = (id, gen = 5) => BALLS[gen]?.[id] ?? 0;
/** Ball id -> name, null if invalid for that generation. */
export const ballName = (id, gen = 5, lang = "en") => (ballItem(id, gen) ? nationalItemName(ballItem(id, gen), lang) : null);
/** Highest ball id per generation (Gen 4: 24; 25 Park Ball exists but is never stored). */
export const MAX_BALL = freeze({ 3: 12, 4: 24, 5: 25 });
/** Gen 3-5 origin-game byte -> name ("Platinum", "Colosseum/XD"), null if unknown. */
export const gameName = (versionId, lang = "en") => ORIGIN_GAMES[versionId]?.names[lang] ?? ORIGIN_GAMES[versionId]?.names.en ?? null;
/** Origin-game byte -> short code ("E", "Pt", "B2"), null if unknown. */
export const gameCode = (versionId) => ORIGIN_GAMES[versionId]?.code ?? null;
/** Origin-game byte -> generation, 0 if unknown. */
export const gameGen = (versionId) => ORIGIN_GAMES[versionId]?.gen ?? 0;
/** Game code of a generation ("RB", "C", "E", "FRLG", "HGSS", "B2W2", ...) -> name, null if unknown. */
export const gameCodeName = (gen, code, lang = "en") => GAME_CODES[gen]?.[code]?.names[lang] ?? GAME_CODES[gen]?.[code]?.names.en ?? null;
/** Game code -> the origin-game bytes it covers (Gen 3-5), [] for Gen 1/2. */
export const gameCodeOrigins = (gen, code) => (GAME_CODES[gen]?.[code]?.origins ?? []).slice();
/** Game codes known for a generation. */
export const gameCodes = (gen) => Object.keys(GAME_CODES[gen] ?? {});
/** Met location id -> English name for Gen 2 (Crystal), 3, 4, 5; null when unknown. */
export const locationName = (gen, id) => LOCATIONS[gen]?.[id] ?? null;

/** Highest level an outsider Pokémon obeys (100 = all) for a game and its badges: bit i = the game's own badge
    flag i (Gen 2 wJohtoBadges: Zephyr, Hive, Plain, Fog, Mineral, Storm, Glacier, Rising; HGSS: Johto bits 0-7 in
    BADGE_* order, which swaps Storm and Mineral, plus Kanto bits 8-15, which count too). Mew and Deoxys without
    the fateful-encounter flag never obey in FR/LG and Emerald. */
export function obedienceLevel(gen, game, badgeBits) {
  const rule = (gen === 4 && /^(HGSS|HG|SS)$/.test(game) ? OBEDIENCE.HGSS : gen === 3 && /^(FRLG|FR|LG)$/.test(game) ? OBEDIENCE.FRLG : null) ?? OBEDIENCE[gen];
  if (!rule) return 100;
  let cap = 10, n = 0;
  for (let b = badgeBits >>> 0; b; b >>>= 1) n += b & 1;
  for (const [k, c] of rule.count ?? []) if (n >= k) cap = Math.max(cap, c);
  for (const [i, c] of rule.badges ?? []) if (badgeBits & (1 << i)) cap = Math.max(cap, c);
  return cap;
}

/* ---------- natures ---------- */

const NATURE_STATS = ["atk", "def", "spe", "spa", "spd"];
/** Nature 0..24 -> { up, down } stat keys, null for the five neutral natures. */
export function natureStats(n) {
  if (!(n >= 0 && n < 25)) return null;
  const up = Math.floor(n / 5), down = n % 5;
  return up === down ? null : { up: NATURE_STATS[up], down: NATURE_STATS[down] };
}

/* ---------- internal species orders ---------- */

const G1_FROM_NATIONAL = new Map(GEN1_TO_NATIONAL.map((sp, i) => [sp, i]).filter(([sp]) => sp));
/** Gen 1 internal index (1-190) -> National Dex, 0 for unused/glitch slots. */
export const gen1ToNational = (internal) => GEN1_TO_NATIONAL[internal] ?? 0;
/** National Dex (1-151) -> Gen 1 internal index, 0 if none. */
export const nationalToGen1 = (species) => G1_FROM_NATIONAL.get(species) ?? 0;
const G3_FROM_NATIONAL = new Map(GEN3_TO_NATIONAL.map((sp, i) => [sp, i]).filter(([sp]) => sp));
/** Gen 3 internal index (1-411) -> National Dex, 0 for 252-276 (unused) and 412 (Egg). */
export const gen3ToNational = (internal) => GEN3_TO_NATIONAL[internal] ?? 0;
/** National Dex (1-386) -> Gen 3 internal index, 0 if none. */
export const nationalToGen3 = (species) => G3_FROM_NATIONAL.get(species) ?? 0;
/** Gen 3 internal index of an Egg. */
export const GEN3_EGG = 412;

/* ---------- evolutions ---------- */

/** Evolutions out of a species: [{ from, to, gen, method: "level-up" | "trade" | "use-item" | "shed", level?, item?, heldItem?,
    partner?, gender?, time?, move?, moveType?, happiness?, beauty?, partySpecies?, stats?, location?, fromForm?, toForm? }].
    gen = first generation with that method; item = the evolution stone (use-item) or the held, consumed item (trade);
    heldItem = item held while levelling up; partner = required trade partner species; item ids are national. */
export const evolutions = (species) => EVOLUTIONS.filter((e) => e.from === species).map((e) => ({ ...e }));
/** Evolutions into a species. */
export const evolutionsInto = (species) => EVOLUTIONS.filter((e) => e.to === species).map((e) => ({ ...e }));

/* ---------- Showdown names, sprites ---------- */

const toID = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Showdown species name ("Nidoran-F", "Unown-B", "Rotom-Wash"); null if unknown. */
export function showdownName(species, form = 0, gen = 5) {
  const base = SHOWDOWN_SPECIES[species] ?? speciesName(species);
  if (!base) return null;
  const r = form ? formRec(species, form, gen) : null;
  return r?.showdown ? `${base}-${r.showdown}` : base;
}
/** Showdown species id ("charizard", "unownb", "nidoranf"). */
export const showdownId = (species, form = 0, gen = 5) => { const n = showdownName(species, form, gen); return n && toID(n); };
let sdIndex = null;
/** Showdown species/forme name or id -> { species, form } (Gen 5 form numbering; Gen 4-only forms use Gen 4's), null if unknown. */
export function showdownToSpecies(name) {
  if (!sdIndex) {
    sdIndex = new Map();
    for (let sp = 1; sp <= 649; sp++) {
      sdIndex.set(showdownId(sp), { species: sp, form: 0 });
      for (const gen of [5, 4, 3, 2]) (formList(sp, gen) ?? []).forEach((r, form) => {
        if (r.showdown && !sdIndex.has(showdownId(sp, form, gen))) sdIndex.set(showdownId(sp, form, gen), { species: sp, form });
      });
    }
  }
  const hit = sdIndex.get(toID(String(name)));
  return hit ? { ...hit } : null;
}
/** PokeAPI sprite file stem for a species/form: "25", "201-b", "10001" (Deoxys-Attack). Fall back to the species number. */
export function spriteStem(species, form = 0, gen = 5) {
  if (!known(species)) return null;
  return (form ? formRec(species, form, gen)?.stem : null) ?? String(species);
}
/** Showdown species name -> { num, file } for sprite URLs (file omitted when it is just the number); null if unknown. */
export function showdownSprite(name) {
  const hit = showdownToSpecies(name);
  if (!hit) return null;
  const gen = FORMS[hit.species]?.gens[5]?.[hit.form] != null ? 5 : 4;
  const stem = spriteStem(hit.species, hit.form, gen);
  return stem === String(hit.species) ? { num: hit.species } : { num: hit.species, file: stem };
}
