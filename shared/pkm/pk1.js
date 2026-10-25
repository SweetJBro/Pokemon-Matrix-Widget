/* pk1: Gen 1 (Red, Green, Blue, Yellow) Pokémon records. docs/research/format-gen1-gen2.md §6.1,
   §7 (DV-derived values), §8 (catch rate), §9.1 (internal species index).

   Record = the 33-byte box struct, then the OT name and the nickname (11 bytes each, 6 in
   Japanese): Gen 1 lists keep names in separate arrays, so they travel with the struct. Nothing is
   encrypted or checksummed; multi-byte values are big-endian.

     0x00 species (internal index: Rhydon = 1, not the Dex number)   0x01 current HP (u16)
     0x03 box level   0x04 status   0x05 type 1   0x06 type 2   0x07 catch rate (Gen 2's held item)
     0x08 moves[4]    0x0C OT ID (u16)   0x0E EXP (u24)   0x11 stat exp HP/Atk/Def/Spe/Spc (u16 each)
     0x1B DVs (Atk<<4|Def, Spe<<4|Spc)   0x1D PP[4] (PP Ups in bits 7-6)

   Current HP and status persist in boxes (Gen 1 does not heal on deposit). The party tail (level,
   stats) is not part of a record: the game recomputes it from EXP when it withdraws a Pokémon, so
   EXP is the real level and the box-level byte is only what the PC shows. Types and the catch rate
   are per Pokémon and are kept verbatim (Gen 2 rejects wrong types; the catch rate becomes an item). */
import { u16be, u24be, setU16be, setU24be, FormatError } from "../bytes.js";
import * as D from "../data/index.js";
import { gen2Gender, gen2Shiny, maxPP, calcStats, expAtLevelForGen } from "./stats.js";
import { isDefaultName } from "./names.js";
import { makeView } from "./view.js";
import { nameLength, decodeName, encodeName, nameProblems } from "./gblist.js";

export const FORMAT = "pk1";
export const GEN = 1;
export const STRUCT_SIZE = 33;
export const PARTY_STRUCT_SIZE = 44;
export const RECORD_SIZE = STRUCT_SIZE + 2 * 11;
export const recordSize = (lang) => STRUCT_SIZE + 2 * nameLength(lang);

const STAT_EXP = ["hp", "atk", "def", "spe", "spc"];
const langOf = (meta) => meta?.lang || "en";

/** Record -> Fields (plain, JSON-able, lossless).
    { speciesIndex, species, hp, boxLevel, status, type1, type2, catchRate, moves[4], pp[4], ppUps[4],
      tid, exp, dvs { atk, def, spe, spc }, statExp { hp, atk, def, spe, spc },
      otName, nickname, otNameBytes[], nicknameBytes[] }
    species is the National Dex number (0 when the index byte is not a Pokémon); type bytes are
    Gen 1 type ids. */
export function parse(record, meta) {
  const lang = langOf(meta), nl = nameLength(lang);
  if (!record || record.length !== STRUCT_SIZE + 2 * nl) throw new FormatError(`A ${lang === "ja" ? "Japanese " : ""}Gen 1 record is ${STRUCT_SIZE + 2 * nl} bytes, got ${record?.length ?? 0}.`);
  const b = record;
  const ot = b.slice(STRUCT_SIZE, STRUCT_SIZE + nl), nick = b.slice(STRUCT_SIZE + nl);
  return {
    speciesIndex: b[0], species: D.gen1ToNational(b[0]),
    hp: u16be(b, 1), boxLevel: b[3], status: b[4], type1: b[5], type2: b[6], catchRate: b[7],
    moves: [b[8], b[9], b[10], b[11]],
    tid: u16be(b, 0x0c), exp: u24be(b, 0x0e),
    statExp: Object.fromEntries(STAT_EXP.map((k, i) => [k, u16be(b, 0x11 + 2 * i)])),
    dvs: { atk: b[0x1b] >> 4, def: b[0x1b] & 15, spe: b[0x1c] >> 4, spc: b[0x1c] & 15 },
    pp: [0, 1, 2, 3].map((i) => b[0x1d + i] & 0x3f),
    ppUps: [0, 1, 2, 3].map((i) => b[0x1d + i] >> 6),
    otName: decodeName(1, ot, lang), nickname: decodeName(1, nick, lang),
    otNameBytes: [...ot], nicknameBytes: [...nick],
  };
}

/** The species' own type bytes in Gen 1 ([t1, t2]; t2 = t1 for one type). */
export function baseTypeBytes(species) {
  const t = D.types(1, species);
  if (!t) return null;
  const a = D.typeByte(1, t[0]);
  return [a, t[1] ? D.typeByte(1, t[1]) : a];
}

/** Level the game derives from EXP (what a withdrawal produces), 1-100. */
export function levelFromExp(species, exp) {
  if (!(species >= 1 && species <= D.MAX_SPECIES[1])) return 0;
  return D.levelAtExp(D.growthRate(species), exp);
}

/** Fields -> record. Recomputes nothing it can keep: a parsed record builds back byte for byte.
    For records built from scratch, missing fields default sensibly: types = the species' types,
    box level = level from EXP, catch rate = the species' rate, names are encoded from the strings.
    When `species` disagrees with `speciesIndex`, species wins (an edit). */
export function build(fields, meta) {
  const lang = langOf(meta), nl = nameLength(lang);
  const f = fields;
  const b = new Uint8Array(STRUCT_SIZE + 2 * nl);
  let index = f.speciesIndex ?? 0;
  if (f.species && D.gen1ToNational(index) !== f.species) index = D.nationalToGen1(f.species);
  if (!index && f.species) throw new FormatError(`Species #${f.species} does not exist in Generation 1.`);
  const species = D.gen1ToNational(index);
  const types = f.type1 == null || f.type2 == null ? baseTypeBytes(species) ?? [0, 0] : [f.type1, f.type2];
  b[0] = index;
  setU16be(b, 1, f.hp ?? 0);
  b[3] = f.boxLevel ?? levelFromExp(species, f.exp ?? 0);
  b[4] = f.status ?? 0;
  b[5] = types[0]; b[6] = types[1];
  b[7] = f.catchRate ?? D.catchRate(species);
  for (let i = 0; i < 4; i++) b[8 + i] = f.moves?.[i] ?? 0;
  setU16be(b, 0x0c, f.tid ?? 0);
  setU24be(b, 0x0e, f.exp ?? 0);
  STAT_EXP.forEach((k, i) => setU16be(b, 0x11 + 2 * i, f.statExp?.[k] ?? 0));
  const dv = f.dvs ?? {};
  b[0x1b] = ((dv.atk & 15) << 4) | (dv.def & 15);
  b[0x1c] = ((dv.spe & 15) << 4) | (dv.spc & 15);
  for (let i = 0; i < 4; i++) b[0x1d + i] = (((f.ppUps?.[i] ?? 0) & 3) << 6) | ((f.pp?.[i] ?? 0) & 0x3f);
  b.set(encodeName(1, f.otName, lang, nl, f.otNameBytes), STRUCT_SIZE);
  b.set(encodeName(1, f.nickname, lang, nl, f.nicknameBytes), STRUCT_SIZE + nl);
  return b;
}

/** Display level: the box-level byte when it is a level, else the level from EXP. */
const displayLevel = (f) => (f.boxLevel >= 1 && f.boxLevel <= 100 ? f.boxLevel : levelFromExp(f.species, f.exp) || 1);

/** Field-level checks shared by toView and validate. */
function check(f) {
  const errors = [], warnings = [];
  if (!f.species) { errors.push(`Species index 0x${f.speciesIndex.toString(16).padStart(2, "0")} is not a Pokémon (glitch or empty slot).`); return { errors, warnings }; }
  const ids = f.moves.filter(Boolean);
  if (f.moves.some((m) => m > D.MAX_MOVE[1])) errors.push("Knows a move that does not exist in Generation 1.");
  if (!ids.length) warnings.push("Knows no moves.");
  if (new Set(ids).size !== ids.length) warnings.push("Knows the same move twice.");
  if (f.moves.some((m, i) => !m && f.moves.slice(i + 1).some(Boolean))) warnings.push("Has an empty move slot before a move.");
  f.moves.forEach((m, i) => { if (m && m <= D.MAX_MOVE[1] && f.pp[i] > maxPP(1, m, f.ppUps[i])) warnings.push(`Move ${i + 1} has more PP than it can.`); });
  if (f.boxLevel > 100) errors.push(`Level ${f.boxLevel} is above 100.`);
  const rate = D.growthRate(f.species);
  // Gen 1's CalcLevelFromExperience has no level cap (Gen 2's stops at 100): EXP past the level-100
  // amount comes out of the PC as level 101+, and past level 255's amount the loop never ends.
  if (f.exp > D.expAtLevel(rate, 100)) {
    errors.push(f.exp === expAtLevelForGen(1, rate, 1) && rate === 3
      ? "Has the level-1 EXP underflow value; withdrawing it can freeze Gen 1 games."
      : "EXP is above the level-100 amount; a Gen 1 game would raise it past level 100 when it is withdrawn.");
  }
  const expLevel = levelFromExp(f.species, f.exp);
  if (f.boxLevel <= 100 && f.boxLevel !== expLevel) warnings.push(`Level ${f.boxLevel} does not match its EXP (level ${expLevel}); the game uses the EXP level when it is withdrawn.`);
  const base = baseTypeBytes(f.species);
  if (base && (f.type1 !== base[0] || f.type2 !== base[1])) {
    warnings.push("Its type bytes differ from the species' types; Gen 2 would reject it in a Time Capsule trade.");
  }
  const st = calcStats(1, f.species, 0, expLevel, f.dvs, f.statExp);
  if (st && f.hp > st.hp) warnings.push("Current HP is above its maximum HP.");
  if (f.status & 0x80) warnings.push("Has an unknown status bit set.");
  return { errors, warnings };
}

/** Fields -> MonView. `party` (optional, for party slots): { level, stats } as the party struct
    stores them. Gen 1 has no gender or shininess; both use the Gen 2 rules (how Gen 2 and the
    Virtual Console read Gen 1 Pokémon). The view adds `catchRate`. */
export function toView(fields, meta, party) {
  const f = fields, lang = langOf(meta);
  const { errors, warnings } = check(f);
  const valid = !!f.species;
  const view = makeView({
    format: FORMAT, gen: GEN, lang, game: meta?.game ?? null,
    species: f.species, form: 0,
    nickname: f.nickname, isNicknamed: valid && !isDefaultName(f.nickname, f.species, 1, lang), isEgg: false,
    level: party?.level ?? displayLevel(f), exp: f.exp,
    gender: valid ? gen2Gender(f.species, f.dvs.atk) : null, shiny: gen2Shiny(f.dvs), pid: null,
    natureId: null, abilityId: null, abilityNum: null, heldItemId: 0,
    moves: f.moves.map((id, i) => ({ id, pp: f.pp[i], ppUps: f.ppUps[i] })),
    dvs: { ...f.dvs }, statExp: { ...f.statExp },
    friendship: null, pokerus: null, ballId: null, markings: 0,
    ot: { name: f.otName, tid: f.tid, sid: null, gender: null },
    met: null, ribbons: [], checksumOk: true,
    warnings: [...errors, ...warnings],
    stats: party?.stats,
  });
  view.catchRate = f.catchRate;
  return view;
}

/** -> { ok, errors, warnings }. Never throws. */
export function validate(record, meta) {
  const lang = langOf(meta), nl = nameLength(lang);
  let f;
  try { f = parse(record, meta); } catch (e) { return { ok: false, errors: [e.message], warnings: [] }; }
  const { errors, warnings } = check(f);
  for (const [bytes, what] of [[record.subarray(STRUCT_SIZE, STRUCT_SIZE + nl), "OT name"], [record.subarray(STRUCT_SIZE + nl), "Nickname"]]) {
    warnings.push(...nameProblems(1, bytes, lang, what));
  }
  return { ok: errors.length === 0, errors, warnings };
}
