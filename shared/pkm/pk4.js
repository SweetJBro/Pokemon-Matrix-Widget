/* PK4: one Gen 4 Pokémon (Diamond, Pearl, Platinum, HeartGold, SoulSilver).

   Spec: docs/research/format-gen4.md §12 (field map, encryption, forms, the dual location and ball
   fields), §13 (text), §16 (what each game accepts) and §10.4 (empty slots). The record is the
   136-byte box struct exactly as the PC stores it: PID, a RAM flags word, the checksum, then four
   32-byte blocks shuffled by the PID and XORed with an LCRNG stream seeded by the checksum
   (shared/pkm/crypt.js). A 236-byte party struct is accepted too; its battle part (stats, mail, seal
   capsule) lands in `party` and is rebuilt only when present.

   parse() keeps every bit (unused bytes, the RAM flags word, name codes after the terminator), so
   build(parse(r)) gives r back byte for byte for any record whose checksum is valid; build() always
   recomputes the checksum and the encryption. Names are kept as raw u16 codes because the Gen 4
   charset has look-alike glyphs and trash after the terminator (§13); build() encodes the `nickname`
   and `otName` strings only when `nicknameCodes` / `otNameCodes` are absent (set them to null after
   renaming).

   Dual fields: DP stores the egg/met location at 0x7E/0x80 and the ball at 0x83; Pt and HGSS added
   0x44/0x46 and HGSS the ball at 0x86. metLocation(), setLocation() and ball() follow the games' own
   read and write rules (§12.8, §12.9). Gender is "M" | "F" | null in views; Fields keep the stored
   0/1/2 bits. */
import { u16le, u32le, setU16le, setU32le, FormatError } from "../bytes.js";
import { decrypt45, encrypt45, checksum45 } from "./crypt.js";
import * as T from "../text/gen4.js";
import * as D from "../data/index.js";
import { makeView } from "./view.js";
import { gen3Gender, gen3Shiny, maxPP, levelAtExp, expAtLevel } from "./stats.js";

export const FORMAT = "pk4";
export const GEN = 4;
export const RECORD_SIZE = 136;
export const PARTY_SIZE = 236;
export const recordSize = () => RECORD_SIZE;

const STATS4 = ["hp", "atk", "def", "spe", "spa", "spd"];   // stored order of IVs, EVs and party stats
const CONTEST = ["cool", "beauty", "cute", "smart", "tough", "sheen"];
const LANG_BYTES = new Set([1, 2, 3, 4, 5, 7, 8]);
const ORIGINS = new Set([1, 2, 3, 4, 5, 7, 8, 10, 11, 12, 15]);   // Gen 3 and Gen 4 version bytes (§8)
export const MAX_ITEM_BY_GAME = { DP: 464, Pt: 467, HGSS: 536 };   // highest valid held item (§14)
export const FARAWAY_PLACE = 3002;
const GRISEOUS_ORB = 112, MAIL = [137, 148];

/** "D" | "P" | "DP" | "Pt" | "HG" | "SS" | "HGSS" -> "DP" | "Pt" | "HGSS" (null for anything else). */
export function gameFamily(game) {
  if (/^(D|P|DP)$/.test(game)) return "DP";
  if (game === "Pt") return "Pt";
  if (/^(HG|SS|HGSS)$/.test(game)) return "HGSS";
  return null;
}

/* ---------- empty slots ---------- */

/** The canonical empty box slot: zeros, encrypted with seed (= checksum) 0 (§10.4). Fresh copy. */
export const emptyRecord = () => encrypt45(new Uint8Array(RECORD_SIZE));
/** The empty party slot the game writes (Pokemon_Init): zeros, both parts encrypted with seed 0. */
export const emptyPartyRecord = () => encrypt45(new Uint8Array(PARTY_SIZE));
/** True when the slot holds no Pokémon: decrypted species 0, whatever the checksum (the game's SPECIES_EXISTS). */
export const isEmptySlot = (stored) => decryptedSpecies(stored) === 0;
/** Species word of a stored record without a full parse (0 = empty). */
export function decryptedSpecies(stored) {
  const p = decrypt45(stored.subarray(0, RECORD_SIZE));
  return u16le(p, 0x08);
}
/** True when the stored checksum matches the decrypted data. */
export function checksumValid(stored) {
  const p = decrypt45(stored.subarray(0, RECORD_SIZE));
  return checksum45(p) === u16le(p, 0x06);
}

/* ---------- text ---------- */

const codesOf = (b, o, n) => Array.from({ length: n }, (_, i) => u16le(b, o + 2 * i));
function codesToBytes(codes) {
  const b = new Uint8Array(codes.length * 2);
  codes.forEach((c, i) => setU16le(b, 2 * i, c));
  return b;
}
const textLang = (byte, fallback) => D.langFromId(byte) ?? (D.LANGS.includes(fallback) ? fallback : "en");
const decodeName = (codes, lang) => T.decode(codesToBytes(codes), lang);

/* ---------- parse / build ---------- */

/** record (136 or 236 bytes, encrypted as stored) -> Fields. */
export function parse(record, meta = {}) {
  if (!(record instanceof Uint8Array) || (record.length !== RECORD_SIZE && record.length !== PARTY_SIZE)) {
    throw new FormatError(`A Gen 4 Pokémon record is ${RECORD_SIZE} bytes (${PARTY_SIZE} in the party), got ${record?.length}.`);
  }
  const p = decrypt45(record);
  const iv = u32le(p, 0x38), b40 = p[0x40], b84 = p[0x84];
  const ivs = {}, evs = {}, contest = {};
  STATS4.forEach((s, i) => { ivs[s] = (iv >>> (5 * i)) & 31; evs[s] = p[0x18 + i]; });
  CONTEST.forEach((s, i) => { contest[s] = p[0x1e + i]; });
  const lang = textLang(p[0x17], meta.lang);
  const nicknameCodes = codesOf(p, 0x48, 11), otNameCodes = codesOf(p, 0x68, 8);
  const f = {
    pid: u32le(p, 0x00), flags: u16le(p, 0x04), checksum: u16le(p, 0x06), checksumOk: checksum45(p) === u16le(p, 0x06),
    species: u16le(p, 0x08), heldItem: u16le(p, 0x0a), tid: u16le(p, 0x0c), sid: u16le(p, 0x0e), exp: u32le(p, 0x10),
    friendship: p[0x14], ability: p[0x15], markings: p[0x16], language: p[0x17], evs, contest,
    ribbonsSinnoh: u32le(p, 0x24),
    moves: [0, 1, 2, 3].map((i) => u16le(p, 0x28 + 2 * i)), pp: [...p.subarray(0x30, 0x34)], ppUps: [...p.subarray(0x34, 0x38)],
    ivs, isEgg: !!(iv & 0x40000000), isNicknamed: !!(iv & 0x80000000),
    ribbonsHoenn: u32le(p, 0x3c),
    fateful: !!(b40 & 1), gender: (b40 >> 1) & 3, form: b40 >> 3, shinyLeaves: p[0x41], unused42: u16le(p, 0x42),
    eggLocationPt: u16le(p, 0x44), metLocationPt: u16le(p, 0x46),
    nickname: decodeName(nicknameCodes, lang), nicknameCodes, unused5E: p[0x5e], version: p[0x5f],
    ribbonsContest: [u32le(p, 0x60), u32le(p, 0x64)],
    otName: decodeName(otNameCodes, lang), otNameCodes,
    eggDate: [...p.subarray(0x78, 0x7b)], metDate: [...p.subarray(0x7b, 0x7e)],
    eggLocationDP: u16le(p, 0x7e), metLocationDP: u16le(p, 0x80), pokerus: p[0x82], ballDP: p[0x83],
    metLevel: b84 & 0x7f, otGender: b84 >> 7, groundTile: p[0x85], ballHGSS: p[0x86], walkingMood: (p[0x87] << 24) >> 24,
  };
  if (record.length === PARTY_SIZE) {
    const stats = {};
    STATS4.forEach((s, i) => { stats[s] = u16le(p, 0x90 + 2 * i); });
    f.party = { status: u32le(p, 0x88), level: p[0x8c], capsule: p[0x8d], hp: u16le(p, 0x8e), stats,
      mail: [...p.subarray(0x9c, 0xd4)], seals: [...p.subarray(0xd4, 0xec)] };
  }
  return f;
}

function nameCodes(codes, str, lang, bytes) {
  if (Array.isArray(codes)) {
    if (codes.length !== bytes / 2) throw new FormatError(`Name code array must have ${bytes / 2} entries.`);
    return codesToBytes(codes);
  }
  return T.encode(str ?? "", lang, bytes);
}

/** Fields -> encrypted record (136 bytes, or 236 when `party` is present). Recomputes the checksum. */
export function build(f, meta = {}) {
  const b = new Uint8Array(f.party ? PARTY_SIZE : RECORD_SIZE);
  const lang = textLang(f.language, meta.lang);
  setU32le(b, 0x00, f.pid); setU16le(b, 0x04, f.flags ?? 0);
  setU16le(b, 0x08, f.species); setU16le(b, 0x0a, f.heldItem); setU16le(b, 0x0c, f.tid); setU16le(b, 0x0e, f.sid);
  setU32le(b, 0x10, f.exp);
  b[0x14] = f.friendship; b[0x15] = f.ability; b[0x16] = f.markings; b[0x17] = f.language;
  STATS4.forEach((s, i) => { b[0x18 + i] = f.evs?.[s] ?? 0; });
  CONTEST.forEach((s, i) => { b[0x1e + i] = f.contest?.[s] ?? 0; });
  setU32le(b, 0x24, f.ribbonsSinnoh ?? 0);
  for (let i = 0; i < 4; i++) { setU16le(b, 0x28 + 2 * i, f.moves[i] ?? 0); b[0x30 + i] = f.pp[i] ?? 0; b[0x34 + i] = f.ppUps[i] ?? 0; }
  let iv = 0;
  STATS4.forEach((s, i) => { iv |= ((f.ivs?.[s] ?? 0) & 31) << (5 * i); });
  setU32le(b, 0x38, (iv | (f.isEgg ? 0x40000000 : 0) | (f.isNicknamed ? 0x80000000 : 0)) >>> 0);
  setU32le(b, 0x3c, f.ribbonsHoenn ?? 0);
  b[0x40] = (f.fateful ? 1 : 0) | ((f.gender & 3) << 1) | ((f.form & 31) << 3);
  b[0x41] = f.shinyLeaves ?? 0; setU16le(b, 0x42, f.unused42 ?? 0);
  setU16le(b, 0x44, f.eggLocationPt ?? 0); setU16le(b, 0x46, f.metLocationPt ?? 0);
  b.set(nameCodes(f.nicknameCodes, f.nickname, lang, 22), 0x48);
  b[0x5e] = f.unused5E ?? 0; b[0x5f] = f.version;
  setU32le(b, 0x60, f.ribbonsContest?.[0] ?? 0); setU32le(b, 0x64, f.ribbonsContest?.[1] ?? 0);
  b.set(nameCodes(f.otNameCodes, f.otName, lang, 16), 0x68);
  b.set((f.eggDate ?? [0, 0, 0]).slice(0, 3), 0x78); b.set((f.metDate ?? [0, 0, 0]).slice(0, 3), 0x7b);
  setU16le(b, 0x7e, f.eggLocationDP ?? 0); setU16le(b, 0x80, f.metLocationDP ?? 0);
  b[0x82] = f.pokerus ?? 0; b[0x83] = f.ballDP ?? 0; b[0x84] = (f.metLevel & 0x7f) | (f.otGender ? 0x80 : 0);
  b[0x85] = f.groundTile ?? 0; b[0x86] = f.ballHGSS ?? 0; b[0x87] = (f.walkingMood ?? 0) & 0xff;
  if (f.party) {
    const q = f.party;
    setU32le(b, 0x88, q.status ?? 0); b[0x8c] = q.level ?? 0; b[0x8d] = q.capsule ?? 0; setU16le(b, 0x8e, q.hp ?? 0);
    STATS4.forEach((s, i) => setU16le(b, 0x90 + 2 * i, q.stats?.[s] ?? 0));
    b.set((q.mail ?? []).slice(0, 0x38), 0x9c); b.set((q.seals ?? []).slice(0, 0x18), 0xd4);
  }
  return encrypt45(b);
}

/* ---------- dual fields, ribbons, forms ---------- */

/** True for locations that exist in Diamond/Pearl (pret sub_0201708C): 1-111, 2000-2010, 3000-3076. */
export const locationInDP = (v) => (v >= 1 && v <= 111) || (v >= 2000 && v <= 2010) || (v >= 3000 && v <= 3076);
/** Met location as the games read it: the Pt/HGSS copy when the DP copy says Faraway Place. */
export const metLocation = (f) => (f.metLocationDP === FARAWAY_PLACE && f.metLocationPt ? f.metLocationPt : f.metLocationDP);
export const eggLocation = (f) => (f.eggLocationDP === FARAWAY_PLACE && f.eggLocationPt ? f.eggLocationPt : f.eggLocationDP);
/** Writes a location the way Pt/HGSS do: both copies, or 3002 in the DP copy when DP lacks the place. kind "met" | "egg". */
export function setLocation(f, kind, value) {
  const dp = value === 0 || locationInDP(value) ? value : FARAWAY_PLACE;
  if (kind === "egg") { f.eggLocationDP = dp; f.eggLocationPt = value; } else { f.metLocationDP = dp; f.metLocationPt = value; }
  return f;
}
/** Ball as HGSS reads it: the HGSS byte for HeartGold/SoulSilver origins when set, else the DP/Pt byte. */
export const ball = (f) => ((f.version === 7 || f.version === 8) && f.ballHGSS ? f.ballHGSS : f.ballDP);

// Ribbon bit names, in bit order from 0x24, 0x3C and 0x60 (§12.6). null = unused bit.
const CONTEST4 = (c) => [c, c + "Great", c + "Ultra", c + "Master"];
const CONTEST3 = (c) => [c, c + "Super", c + "Hyper", c + "Master"];
const RIBBONS = {
  sinnoh: ["ChampionSinnoh", "Ability", "AbilityGreat", "AbilityDouble", "AbilityMulti", "AbilityPair", "AbilityWorld", "Alert",
    "Shock", "Downcast", "Careless", "Relax", "Snooze", "Smile", "Gorgeous", "Royal",
    "GorgeousRoyal", "Footprint", "Record", "Event", "Legend", "ChampionWorld", "Birthday", "Special",
    "Souvenir", "Wishing", "Classic", "Premier", null, null, null, null],
  hoenn: [...["Cool", "Beauty", "Cute", "Smart", "Tough"].flatMap((c) => CONTEST3("G3" + c)),
    "ChampionG3", "Winning", "Victory", "Artist", "Effort", "ChampionBattle", "ChampionRegional", "ChampionNational",
    "Country", "National", "Earth", "World"],
  contest: ["Cool", "Beauty", "Cute", "Smart", "Tough"].flatMap((c) => CONTEST4("G4" + c)),
};
/** Ribbon names ("RibbonChampionSinnoh", ...) of a record's set bits. */
export function ribbonNames(f) {
  const out = [];
  const add = (word, names) => names.forEach((n, i) => { if (n && (word >>> i) & 1) out.push("Ribbon" + n); });
  add(f.ribbonsSinnoh >>> 0, RIBBONS.sinnoh);
  add(f.ribbonsHoenn >>> 0, RIBBONS.hoenn);
  add((f.ribbonsContest?.[0] ?? 0) >>> 0, RIBBONS.contest);
  return out;
}
/** Bits set in ribbon fields that no ribbon uses. */
const unusedRibbonBits = (f) => ((f.ribbonsSinnoh >>> 28) !== 0) || ((f.ribbonsContest?.[0] >>> 20) !== 0) || f.ribbonsContest?.[1] !== 0;

// Arceus' form follows its Plate (pret BoxPokemon_SetArceusForm): Gen 4 item 298 Flame .. 313 Iron.
const PLATE_FORMS = [10, 11, 13, 12, 15, 1, 3, 4, 2, 14, 6, 5, 7, 16, 17, 8];
export const arceusFormForItem = (item) => (item >= 298 && item <= 313 ? PLATE_FORMS[item - 298] : 0);

/** The ability the game assigns for the current species and form (pret BoxPokemon_CalcAbility): the second one when
    the form has two and PID bit 0 is set, else the first. null when the species is unknown. */
export function calcAbility(f) {
  const [a1, a2] = D.abilities(4, f.species, f.form) ?? [];
  return (a2 && f.pid & 1 ? a2 : a1) || null;
}

/* ---------- view ---------- */

const statsView = (s) => (s ? { hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe } : null);
const dateString = ([y, m, d]) => (y || m || d ? `${2000 + y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);
const GENDERS = ["M", "F", null];

/** Ability slot: the slot whose ability the record holds when the species has two, else PID bit 0 (what the games use). */
export function abilitySlot(f) {
  const list = D.abilities(4, f.species, f.form);
  if (list && list[1] && list[0] !== list[1]) {
    if (f.ability === list[1]) return 1;
    if (f.ability === list[0]) return 0;
  }
  return f.pid & 1;
}

/** Fields -> MonView (shared/pkm/view.js). */
export function toView(f, meta = {}) {
  const warnings = [];
  if (!f.checksumOk) warnings.push("Checksum mismatch: the game shows this Pokémon as a Bad Egg.");
  const level = f.species ? levelAtExp(D.growthRate(f.species), f.exp) : 0;
  const view = makeView({
    format: FORMAT, gen: GEN, lang: D.langFromId(f.language) ?? meta.lang ?? null, game: D.gameCode(f.version),
    species: f.species, form: f.form, nickname: f.nickname, isNicknamed: f.isNicknamed, isEgg: f.isEgg || !f.checksumOk,
    level, exp: f.exp, gender: GENDERS[f.gender] ?? null, shiny: gen3Shiny(f.pid, f.tid, f.sid), pid: f.pid,
    natureId: f.pid % 25, abilityId: f.ability, abilityNum: abilitySlot(f), heldItemId: f.heldItem,
    moves: f.moves.map((id, i) => ({ id, pp: f.pp[i], ppUps: f.ppUps[i] })),
    ivs: { ...f.ivs }, evs: { ...f.evs },
    friendship: f.friendship, pokerus: f.pokerus ? { strain: f.pokerus >> 4, days: f.pokerus & 15 } : null,
    ballId: ball(f), markings: f.markings,
    ot: { name: f.otName, tid: f.tid, sid: f.sid, gender: f.otGender ? "F" : "M" },
    met: f.isEgg ? null : { location: metLocation(f), level: f.metLevel, date: dateString(f.metDate), game: D.gameCode(f.version) },
    ribbons: ribbonNames(f), checksumOk: f.checksumOk, warnings,
    stats: f.party && !f.isEgg ? statsView(f.party.stats) : undefined,
  });
  const egg = eggLocation(f);
  view.egg = egg || f.eggDate.some(Boolean) ? { location: egg, locationName: D.locationName(4, egg), date: dateString(f.eggDate) } : null;
  view.fateful = f.fateful;
  if (f.party) view.hp = f.party.hp;
  return view;
}

/* ---------- validation ---------- */

/** -> { ok, errors, warnings }: what the server checks before accepting a record into Home. */
export function validate(record, meta = {}) {
  const errors = [], warnings = [];
  let f;
  try { f = parse(record, meta); } catch (e) { return { ok: false, errors: [e.message], warnings }; }
  const name = D.speciesName(f.species) ?? `species #${f.species}`;
  if (!f.checksumOk) errors.push("The record's checksum does not match its data (the game shows it as a Bad Egg).");
  if (f.species === 0) errors.push("The record is an empty slot.");
  else if (f.species > D.MAX_SPECIES[4]) errors.push(`Species #${f.species} does not exist in Generation 4.`);
  if (errors.length) return { ok: false, errors, warnings };
  if (f.flags & 4) errors.push("The record is marked as a Bad Egg.");
  else if (f.flags) warnings.push("The record's in-memory flags are set; they are cleared when it is stored.");
  if (f.form >= Math.max(1, D.formCount(f.species, 4))) errors.push(`${name} has no form ${f.form} in Generation 4.`);
  const moves = f.moves.filter(Boolean);
  if (!moves.length) errors.push(`${name} knows no moves.`);
  f.moves.forEach((m, i) => {
    if (m > D.MAX_MOVE[4]) errors.push(`Move #${m} does not exist in Generation 4.`);
    else if (m) {
      if (f.ppUps[i] > 3) warnings.push(`Move ${i + 1} has ${f.ppUps[i]} PP Ups (at most 3).`);
      if (f.pp[i] > maxPP(4, m, f.ppUps[i])) warnings.push(`Move ${i + 1} has more PP than its maximum.`);
    }
  });
  if (new Set(moves).size !== moves.length) warnings.push(`${name} knows the same move twice.`);
  if (f.heldItem > D.MAX_ITEM[4] || (f.heldItem && !D.itemToNational(4, f.heldItem))) errors.push(`Held item #${f.heldItem} does not exist in Generation 4.`);
  if (!f.ability || f.ability > D.MAX_ABILITY[4]) errors.push(`Ability #${f.ability} does not exist in Generation 4.`);
  else if (!(D.abilities(4, f.species, f.form) ?? []).includes(f.ability)) warnings.push(`${name} cannot normally have ${D.abilityName(f.ability)}.`);
  const pidGender = ["M", "F", null].indexOf(gen3Gender(f.species, f.pid));
  if (f.gender !== pidGender) warnings.push("The stored gender does not match the one the PID gives.");
  const rate = D.growthRate(f.species);
  if (f.exp > expAtLevel(rate, 100)) warnings.push("EXP is above the level 100 maximum.");
  if (f.party && f.party.level !== levelAtExp(rate, f.exp)) warnings.push("The party level does not match the EXP.");
  if (f.isEgg && f.friendship > 255) warnings.push("Egg cycles out of range.");
  if (!LANG_BYTES.has(f.language)) warnings.push(`Unknown language byte ${f.language}.`);
  if (D.gameGen(f.version) >= 5) errors.push("The record claims a Generation 5 origin, which a Gen 4 record cannot have.");
  else if (!ORIGINS.has(f.version)) warnings.push(`Unknown origin game ${f.version}.`);
  if (!f.ballDP || f.ballDP > 16) warnings.push(`Unexpected ball byte ${f.ballDP}.`);
  if (f.ballHGSS > D.MAX_BALL[4]) warnings.push(`Unexpected HeartGold/SoulSilver ball byte ${f.ballHGSS}.`);
  if (f.metLevel > 100) warnings.push("Met level above 100.");
  const evTotal = STATS4.reduce((n, s) => n + f.evs[s], 0);
  if (evTotal > 510) warnings.push(`EV total ${evTotal} is above 510.`);
  if (f.species === 493 && f.ability === 121 && f.form !== arceusFormForItem(f.heldItem)) warnings.push("Arceus' form does not match its held Plate.");
  if (unusedRibbonBits(f)) warnings.push("Unused ribbon bits are set.");
  for (const [label, codes, n] of [["Nickname", f.nicknameCodes, 11], ["OT name", f.otNameCodes, 8]]) {
    const end = codes.findIndex((c) => c === 0xffff || c === 0);
    if (end < 0) warnings.push(`${label} has no terminator.`);
    else if (end === 0) warnings.push(`${label} is empty.`);
    else if (end > n - 1) warnings.push(`${label} is too long.`);
    const text = label === "Nickname" ? f.nickname : f.otName;
    if (text.includes("�")) warnings.push(`${label} contains characters with no glyph.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/* ---------- storing into a game's PC ---------- */

/** What storing a record in a box of `game` does to it (§10.3, §16): the game refills PP and returns Shaymin to Land
    Forme; boxed Pokémon hold walking mood 0 (§16; PKHeX does the same for HGSS); the RAM flags are cleared; content the target
    game cannot hold is stripped (item it lacks, mail, Pt Giratina-Origin in DP) or refused (Spiky-eared Pichu
    outside HGSS, a Bad Egg, a non-Gen 4 record). -> { fields, notes } (a new Fields object). */
export function prepareForBox(fields, game) {
  const fam = gameFamily(game);
  if (!fam) throw new FormatError(`Unknown Generation 4 game "${game}".`);
  const f = structuredClone(fields), notes = [];
  delete f.party;
  const name = D.speciesName(f.species) ?? `#${f.species}`;
  if (!f.checksumOk) throw new FormatError("This Pokémon's data is corrupted (a Bad Egg) and cannot be stored.");
  if (!(f.species >= 1 && f.species <= D.MAX_SPECIES[4])) throw new FormatError(`Species #${f.species} cannot be stored in a Generation 4 game.`);
  if (D.gameGen(f.version) >= 5) throw new FormatError("Pokémon from Generation 5 games cannot go back to Generation 4.");
  if (f.moves.some((m) => m > D.MAX_MOVE[4]) || f.ability > D.MAX_ABILITY[4]) throw new FormatError(`${name} has moves or an ability that Generation 4 does not have.`);
  if (f.species === 172 && f.form === 1 && fam !== "HGSS") throw new FormatError("The Spiky-eared Pichu can only live in HeartGold and SoulSilver.");
  if (f.flags) { f.flags = 0; notes.push("Cleared the in-memory flags."); }
  if (f.heldItem >= MAIL[0] && f.heldItem <= MAIL[1]) { notes.push(`Removed the ${D.itemName(4, f.heldItem)} (mail cannot be stored in a box).`); f.heldItem = 0; }
  if (f.heldItem > MAX_ITEM_BY_GAME[fam] || (fam === "DP" && f.heldItem === GRISEOUS_ORB) || (f.heldItem && !D.itemToNational(4, f.heldItem))) {
    notes.push(`Removed the ${D.itemName(4, f.heldItem) ?? "item #" + f.heldItem}, which ${D.gameCodeName(4, game)} does not have.`);
    f.heldItem = 0;
  }
  // Giratina's and Shaymin's forms have their own abilities: the game's form setters (BoxPokemon_SetGiratinaForm,
  // BoxPokemon_SetShayminForm, which Platinum's PC calls on every store) recompute the ability from the new form.
  const setForm = (form, note) => {
    if (f.form !== form) { notes.push(note); f.form = form; }
    const ability = calcAbility(f);
    if (ability && ability !== f.ability) { notes.push(`Its ability becomes ${D.abilityName(ability)}.`); f.ability = ability; }
  };
  if (f.species === 487) {
    const form = fam === "DP" ? 0 : f.heldItem === GRISEOUS_ORB ? 1 : 0;
    setForm(form, form ? "Giratina holds the Griseous Orb: Origin Forme." : "Giratina returns to Altered Forme.");
  }
  if (f.species === 492) setForm(0, "Shaymin returns to Land Forme in the PC.");
  if (f.species === 493 && f.ability === 121 && f.form !== arceusFormForItem(f.heldItem)) { f.form = arceusFormForItem(f.heldItem); notes.push("Arceus' type follows its Plate."); }
  f.moves.forEach((m, i) => { if (m) f.pp[i] = maxPP(4, m, f.ppUps[i]); });
  f.walkingMood = 0;
  return { fields: f, notes };
}
