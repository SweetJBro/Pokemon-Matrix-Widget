/* pk2: Gen 2 (Gold, Silver, Crystal) Pokémon records, Japanese and Korean included.
   docs/research/format-gen1-gen2.md §5.8 (eggs), §6.2 (struct), §7 (DV-derived values).

   Record = the species-list entry (1 byte), the 32-byte box struct, then the OT name and the
   nickname (11 bytes each, 6 in Japanese). The list entry comes along because Gen 2 marks an Egg
   only there (0xFD); the struct always holds the real species. Big-endian, no encryption.

     0x00 species (National Dex)   0x01 held item   0x02 moves[4]   0x06 OT ID (u16)   0x08 EXP (u24)
     0x0B stat exp HP/Atk/Def/Spe/Spc (u16 each; Special serves SpA and SpD)   0x15 DVs
     0x17 PP[4] (PP Ups in bits 7-6)   0x1B friendship (an Egg's remaining hatch cycles)
     0x1C Pokérus (strain << 4 | days)   0x1D caught data (Crystal; 00 00 elsewhere)   0x1F level
   (struct offsets; the record adds 1.) Caught data: byte 0 = time of day (bits 7-6, 1 morning
   2 day 3 night) | met level (bits 5-0, 1 = hatched); byte 1 = OT gender (bit 7, 1 = female) |
   location (bits 6-0, a Crystal landmark id; 0x7E gift, 0x7F event).
   Party data (status, current HP, stats) is not part of a record: the game recomputes the level
   from EXP and the stats on withdrawal, and heals the Pokémon. */
import { u16be, u24be, setU16be, setU24be, FormatError } from "../bytes.js";
import * as D from "../data/index.js";
import { gen2Gender, gen2Shiny, unownLetterGen2, maxPP } from "./stats.js";
import { isDefaultName } from "./names.js";
import { makeView } from "./view.js";
import { nameLength, decodeName, encodeName, nameProblems, EGG } from "./gblist.js";

export const FORMAT = "pk2";
export const GEN = 2;
export const STRUCT_SIZE = 32;
export const PARTY_STRUCT_SIZE = 48;
export const RECORD_SIZE = 1 + STRUCT_SIZE + 2 * 11;
export const recordSize = (lang) => 1 + STRUCT_SIZE + 2 * nameLength(lang);
export { EGG };

/** Gen 2 mail item ids: a Pokémon holding one cannot be put in a box (§5.6). */
export const MAIL_ITEMS = Object.freeze([0x9e, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd]);
export const isMail = (item) => MAIL_ITEMS.includes(item);

const STAT_EXP = ["hp", "atk", "def", "spe", "spc"];
const S = 1;   // struct offset inside the record
const langOf = (meta) => meta?.lang || "en";

/** Record -> Fields (plain, JSON-able, lossless).
    { isEgg, listByte, species, heldItem, moves[4], pp[4], ppUps[4], tid, exp, dvs { atk, def, spe, spc },
      statExp { hp, atk, def, spe, spc }, friendship, pokerus { strain, days },
      caught { timeOfDay, level, otGender, location }, level, otName, nickname, otNameBytes[], nicknameBytes[] }
    listByte is null unless the list entry is neither the species nor 0xFD (damaged data, kept as is). */
export function parse(record, meta) {
  const lang = langOf(meta), nl = nameLength(lang);
  if (!record || record.length !== 1 + STRUCT_SIZE + 2 * nl) throw new FormatError(`A ${lang === "ja" ? "Japanese " : ""}Gen 2 record is ${1 + STRUCT_SIZE + 2 * nl} bytes, got ${record?.length ?? 0}.`);
  const b = record, list = b[0], sp = b[S];
  const ot = b.slice(S + STRUCT_SIZE, S + STRUCT_SIZE + nl), nick = b.slice(S + STRUCT_SIZE + nl);
  const c0 = b[S + 0x1d], c1 = b[S + 0x1e];
  return {
    isEgg: list === EGG, listByte: list === EGG || list === sp ? null : list,
    species: sp, heldItem: b[S + 1],
    moves: [b[S + 2], b[S + 3], b[S + 4], b[S + 5]],
    tid: u16be(b, S + 6), exp: u24be(b, S + 8),
    statExp: Object.fromEntries(STAT_EXP.map((k, i) => [k, u16be(b, S + 0x0b + 2 * i)])),
    dvs: { atk: b[S + 0x15] >> 4, def: b[S + 0x15] & 15, spe: b[S + 0x16] >> 4, spc: b[S + 0x16] & 15 },
    pp: [0, 1, 2, 3].map((i) => b[S + 0x17 + i] & 0x3f),
    ppUps: [0, 1, 2, 3].map((i) => b[S + 0x17 + i] >> 6),
    friendship: b[S + 0x1b],
    pokerus: { strain: b[S + 0x1c] >> 4, days: b[S + 0x1c] & 15 },
    caught: { timeOfDay: c0 >> 6, level: c0 & 0x3f, otGender: c1 >> 7, location: c1 & 0x7f },
    level: b[S + 0x1f],
    otName: decodeName(2, ot, lang), nickname: decodeName(2, nick, lang),
    otNameBytes: [...ot], nicknameBytes: [...nick],
  };
}

/** Fields -> record. A parsed record builds back byte for byte. Missing fields default to 0, the
    level to the level from EXP, and names are encoded from the strings when their bytes are absent. */
export function build(fields, meta) {
  const lang = langOf(meta), nl = nameLength(lang);
  const f = fields;
  const b = new Uint8Array(1 + STRUCT_SIZE + 2 * nl);
  const sp = f.species ?? 0;
  b[0] = f.isEgg ? EGG : f.listByte ?? sp;
  b[S] = sp;
  b[S + 1] = f.heldItem ?? 0;
  for (let i = 0; i < 4; i++) b[S + 2 + i] = f.moves?.[i] ?? 0;
  setU16be(b, S + 6, f.tid ?? 0);
  setU24be(b, S + 8, f.exp ?? 0);
  STAT_EXP.forEach((k, i) => setU16be(b, S + 0x0b + 2 * i, f.statExp?.[k] ?? 0));
  const dv = f.dvs ?? {};
  b[S + 0x15] = ((dv.atk & 15) << 4) | (dv.def & 15);
  b[S + 0x16] = ((dv.spe & 15) << 4) | (dv.spc & 15);
  for (let i = 0; i < 4; i++) b[S + 0x17 + i] = (((f.ppUps?.[i] ?? 0) & 3) << 6) | ((f.pp?.[i] ?? 0) & 0x3f);
  b[S + 0x1b] = f.friendship ?? 0;
  b[S + 0x1c] = (((f.pokerus?.strain ?? 0) & 15) << 4) | ((f.pokerus?.days ?? 0) & 15);
  const c = f.caught ?? {};
  b[S + 0x1d] = ((c.timeOfDay & 3) << 6) | (c.level & 0x3f);
  b[S + 0x1e] = ((c.otGender & 1) << 7) | (c.location & 0x7f);
  b[S + 0x1f] = f.level ?? levelFromExp(sp, f.exp ?? 0);
  b.set(encodeName(2, f.otName, lang, nl, f.otNameBytes), S + STRUCT_SIZE);
  b.set(encodeName(2, f.nickname, lang, nl, f.nicknameBytes), S + STRUCT_SIZE + nl);
  return b;
}

/** Level the game derives from EXP on withdrawal (1-100), 0 for an unknown species. */
export function levelFromExp(species, exp) {
  if (!(species >= 1 && species <= D.MAX_SPECIES[2])) return 0;
  return D.levelAtExp(D.growthRate(species), exp);
}

const hasCaughtData = (c) => !!(c.timeOfDay || c.level || c.otGender || c.location);

function check(f) {
  const errors = [], warnings = [];
  if (f.listByte != null) errors.push(`Its list entry (0x${f.listByte.toString(16).padStart(2, "0")}) does not match its species; the game would treat it as abnormal.`);
  if (!(f.species >= 1 && f.species <= D.MAX_SPECIES[2])) { errors.push(`Species #${f.species} does not exist in Generation 2.`); return { errors, warnings }; }
  const ids = f.moves.filter(Boolean);
  if (f.moves.some((m) => m > D.MAX_MOVE[2])) errors.push("Knows a move that does not exist in Generation 2.");
  if (!ids.length) warnings.push("Knows no moves.");
  if (new Set(ids).size !== ids.length) warnings.push("Knows the same move twice.");
  if (f.moves.some((m, i) => !m && f.moves.slice(i + 1).some(Boolean))) warnings.push("Has an empty move slot before a move.");
  f.moves.forEach((m, i) => { if (m && m <= D.MAX_MOVE[2] && f.pp[i] > maxPP(2, m, f.ppUps[i])) warnings.push(`Move ${i + 1} has more PP than it can.`); });
  if (f.heldItem && !D.itemName(2, f.heldItem)) warnings.push(`Holds an unknown item (#${f.heldItem}).`);
  if (isMail(f.heldItem)) warnings.push("Holds Mail; the game does not allow it in a PC box.");
  if (f.level > 100) errors.push(`Level ${f.level} is above 100.`);
  else if (f.level === 0) warnings.push("Its level byte is 0.");
  const rate = D.growthRate(f.species), expLevel = levelFromExp(f.species, f.exp);
  if (f.exp > D.expAtLevel(rate, 100)) warnings.push("EXP is above the level-100 amount.");
  if (f.level >= 1 && f.level <= 100 && f.level !== expLevel) warnings.push(`Level ${f.level} does not match its EXP (level ${expLevel}); the game uses the EXP level when it is withdrawn.`);
  if (f.pokerus.strain === 0 && f.pokerus.days) warnings.push("Has Pokérus days without a strain.");
  return { errors, warnings };
}

/** Fields -> MonView. `party` (optional, for party slots): { level, stats } from the party struct.
    Eggs: nickname is the egg name, friendship the remaining hatch cycles, no stats. */
export function toView(fields, meta, party) {
  const f = fields, lang = langOf(meta);
  const { errors, warnings } = check(f);
  const valid = f.species >= 1 && f.species <= D.MAX_SPECIES[2];
  const level = party?.level ?? (f.level >= 1 && f.level <= 100 ? f.level : levelFromExp(f.species, f.exp) || 1);
  const caught = hasCaughtData(f.caught);
  const pkrs = f.pokerus.strain || f.pokerus.days ? { ...f.pokerus } : null;
  return makeView({
    format: FORMAT, gen: GEN, lang, game: meta?.game ?? null,
    species: f.species, form: f.species === 201 ? unownLetterGen2(f.dvs) : 0,
    nickname: f.nickname, isNicknamed: valid && !f.isEgg && !isDefaultName(f.nickname, f.species, 2, lang), isEgg: f.isEgg,
    level, exp: f.exp,
    gender: valid ? gen2Gender(f.species, f.dvs.atk) : null, shiny: gen2Shiny(f.dvs), pid: null,
    natureId: null, abilityId: null, abilityNum: null, heldItemId: f.heldItem,
    moves: f.moves.map((id, i) => ({ id, pp: f.pp[i], ppUps: f.ppUps[i] })),
    dvs: { ...f.dvs }, statExp: { ...f.statExp },
    friendship: f.friendship, pokerus: pkrs, ballId: null, markings: 0,
    ot: { name: f.otName, tid: f.tid, sid: null, gender: caught ? f.caught.otGender : null },
    met: caught ? { location: f.caught.location, level: f.caught.level, date: null, game: "C", timeOfDay: f.caught.timeOfDay } : null,
    ribbons: [], checksumOk: true,
    warnings: [...errors, ...warnings],
    stats: f.isEgg ? null : party?.stats,
  });
}

/** -> { ok, errors, warnings }. Never throws. */
export function validate(record, meta) {
  const lang = langOf(meta), nl = nameLength(lang);
  let f;
  try { f = parse(record, meta); } catch (e) { return { ok: false, errors: [e.message], warnings: [] }; }
  const { errors, warnings } = check(f);
  const at = S + STRUCT_SIZE;
  for (const [bytes, what] of [[record.subarray(at, at + nl), "OT name"], [record.subarray(at + nl), "Nickname"]]) {
    warnings.push(...nameProblems(2, bytes, lang, what));
  }
  return { ok: errors.length === 0, errors, warnings };
}
