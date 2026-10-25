/* PK3: the 80-byte Pokémon record of Ruby, Sapphire, Emerald, FireRed and LeafGreen
   (docs/research/format-gen3.md §8; docs/ARCHITECTURE.md "Records").

   A record is the box struct exactly as the PC stores it: PID, OT id, nickname, language, flags,
   OT name, markings and checksum in the clear, then 48 bytes of four substructures (Growth,
   Attacks, EVs/condition, Misc) shuffled by PID % 24 and XORed with PID ^ OTID (shared/pkm/crypt.js).
   A party Pokémon is the same 80 bytes plus 20 bytes of status/level/stats that the game rebuilds
   whenever a Pokémon leaves the PC, so the party block is never part of a record. parse() also
   accepts that 100-byte party struct (fields.party) so a save can show the stats it stores.

   Fields keep every stored bit exactly once, so build(parse(r)) gives r back byte for byte.
   Names stay raw bytes, because the bytes after the terminator are whatever buffer the game copied
   (format-gen3.md §10). build() also takes a string for a name and encodes it in the charset of the
   record's language byte. fields.derived (national species, decoded names, checksum status) is
   for reading only; build ignores it. build always recomputes the checksum.

   Charset of the names: Western games print the nickname and OT of a Japanese-language Pokémon
   (language byte 1, which every Egg has until it hatches) with the Japanese font, so names decode
   with the table of the record's language byte, as the games and PKHeX do. That makes an Egg's OT
   read in full-width letters ("ＢＲＥＮＤＡＮ"), which is also what the game would draw. */
import { u16le, u32le, setU16le, setU32le, FormatError } from "../bytes.js";
import { decrypt3, encrypt3, checksum3 } from "./crypt.js";
import * as D from "../data/index.js";
import * as text from "../text/gen3.js";
import { makeView } from "./view.js";
import { gen3Gender, gen3Shiny, unownFormGen3, natureFromPid, maxPP } from "./stats.js";
import { isDefaultName } from "./names.js";

export const FORMAT = "pk3";
export const GEN = 3;
export const RECORD_SIZE = 80;
export const PARTY_SIZE = 100;
export const recordSize = () => RECORD_SIZE;

const STATS = ["hp", "atk", "def", "spe", "spa", "spd"];          // stored order of EVs, IVs and party stats
const CONTEST = ["cool", "beauty", "cute", "smart", "tough", "sheen"];
const RIBBON_FLAGS = ["champion", "winning", "victory", "artist", "effort", "marine", "land", "sky",
  "country", "national", "earth", "world"];                       // ribbon word bits 15-26
const RIBBON_NAMES = ["Champion", "Winning", "Victory", "Artist", "Effort", "Marine", "Land", "Sky",
  "Country", "National", "Earth", "World"].map((n) => n + " Ribbon");
const CONTEST_RIBBONS = ["Cool", "Beauty", "Cute", "Smart", "Tough"];
const RANKS = ["", " Super", " Hyper", " Master"];
/** Highest held-item id each game knows (format-gen3.md §9.2); one numbering for all five games. */
export const MAX_ITEM_BY_GAME = { RS: 346, FRLG: 374, E: 376 };
/** Mail items, which only party Pokémon may hold (format-gen3.md §8.8). */
export const isMail = (item) => item >= 121 && item <= 132;

/** "R", "S", "RS" -> "RS"; "FR", "LG", "FRLG" -> "FRLG"; "E" -> "E"; anything else null. */
export function gameFamily(game) {
  if (game === "R" || game === "S" || game === "RS") return "RS";
  if (game === "FR" || game === "LG" || game === "FRLG") return "FRLG";
  return game === "E" ? "E" : null;
}

/** Charset ("ja", "en", "fr", "de", "it", "es") for a record's names, from its language byte. */
export function nameLang(languageByte, fallback = "en") {
  const l = D.langFromId(languageByte);
  if (l && text.LANGS.includes(l)) return l;
  return text.LANGS.includes(fallback) ? fallback : "en";
}

/** A plain copy: Node's Buffer.slice() is a view, and decrypting in place would change the caller's bytes. */
const own = (b) => (b instanceof Uint8Array ? new Uint8Array(b) : new Uint8Array(b ?? []));

function checkSize(b) {
  if (b.length !== RECORD_SIZE && b.length !== PARTY_SIZE)
    throw new FormatError(`A Gen 3 Pokémon record is 80 bytes (or 100 with party data), not ${b.length}.`, { code: "pk3-size" });
}

const bits = (v, at, n) => (v >>> at) & ((1 << n) - 1);

/* ---------- parse ---------- */

export function parse(record, meta = {}) {
  const raw = own(record);
  checkSize(raw);
  const p = decrypt3(raw);
  const flags = p[0x13], origins = u16le(p, 0x46), ivWord = u32le(p, 0x48), rib = u32le(p, 0x4c);
  const stat = (o) => Object.fromEntries(STATS.map((k, i) => [k, p[o + i]]));
  const f = {
    pid: u32le(p, 0), otId: { tid: u16le(p, 4), sid: u16le(p, 6) },
    nickname: Array.from(p.subarray(0x08, 0x12)),
    language: p[0x12],
    flags: { badEgg: !!(flags & 1), hasSpecies: !!(flags & 2), useEggName: !!(flags & 4), blockBoxRS: !!(flags & 8), unused: flags >> 4 },
    otName: Array.from(p.subarray(0x14, 0x1b)),
    markings: p[0x1b],
    checksum: u16le(p, 0x1c),
    unknown: u16le(p, 0x1e),
    growth: { species: u16le(p, 0x20), heldItem: u16le(p, 0x22), exp: u32le(p, 0x24), ppBonuses: p[0x28], friendship: p[0x29], filler: u16le(p, 0x2a) },
    attacks: { moves: [0, 1, 2, 3].map((i) => u16le(p, 0x2c + 2 * i)), pp: Array.from(p.subarray(0x34, 0x38)) },
    condition: { evs: stat(0x38), contest: Object.fromEntries(CONTEST.map((k, i) => [k, p[0x3e + i]])) },
    misc: {
      pokerus: p[0x44], metLocation: p[0x45],
      metLevel: bits(origins, 0, 7), metGame: bits(origins, 7, 4), ball: bits(origins, 11, 4), otGender: bits(origins, 15, 1),
      ivs: Object.fromEntries(STATS.map((k, i) => [k, bits(ivWord, 5 * i, 5)])),
      isEgg: !!bits(ivWord, 30, 1), abilityNum: bits(ivWord, 31, 1),
      ribbons: {
        ...Object.fromEntries(CONTEST_RIBBONS.map((c, i) => [c.toLowerCase(), bits(rib, 3 * i, 3)])),
        ...Object.fromEntries(RIBBON_FLAGS.map((k, i) => [k, !!bits(rib, 15 + i, 1)])),
        unused: bits(rib, 27, 4),
      },
      fatefulEncounter: !!bits(rib, 31, 1),
    },
  };
  if (raw.length === PARTY_SIZE) {
    f.party = { status: u32le(p, 0x50), level: p[0x54], mail: p[0x55], hp: u16le(p, 0x56), maxHp: u16le(p, 0x58),
      ...Object.fromEntries(STATS.slice(1).map((k, i) => [k, u16le(p, 0x5a + 2 * i)])) };
  }
  const lang = nameLang(f.language, meta.lang);
  f.derived = {
    species: D.gen3ToNational(f.growth.species),
    nickname: text.decode(f.nickname, lang), otName: text.decode(f.otName, lang), nameLang: lang,
    checksumOk: checksum3(p) === f.checksum,
  };
  return f;
}

/* ---------- build ---------- */

/** A name given as bytes is copied (cut or 0xFF-padded to the field); a string is encoded for the language. */
function nameBytes(v, len, lang) {
  if (typeof v === "string") return text.encode(v, lang, len);
  const out = new Uint8Array(len).fill(0xff);
  if (v) out.set(Array.from(v).slice(0, len));
  return out;
}

const n = (v) => Number(v) || 0;

export function build(fields, meta = {}) {
  const f = fields || {};
  const p = new Uint8Array(f.party ? PARTY_SIZE : RECORD_SIZE);
  const g = f.growth || {}, a = f.attacks || {}, c = f.condition || {}, m = f.misc || {};
  const fl = f.flags || {}, r = m.ribbons || {};
  const lang = nameLang(n(f.language), meta.lang);
  setU32le(p, 0, n(f.pid));
  setU16le(p, 4, n(f.otId?.tid)); setU16le(p, 6, n(f.otId?.sid));
  p.set(nameBytes(f.nickname, 10, lang), 0x08);
  p[0x12] = n(f.language);
  p[0x13] = (fl.badEgg ? 1 : 0) | (fl.hasSpecies ? 2 : 0) | (fl.useEggName ? 4 : 0) | (fl.blockBoxRS ? 8 : 0) | ((n(fl.unused) & 15) << 4);
  p.set(nameBytes(f.otName, 7, lang), 0x14);
  p[0x1b] = n(f.markings);
  setU16le(p, 0x1e, n(f.unknown));
  setU16le(p, 0x20, n(g.species)); setU16le(p, 0x22, n(g.heldItem)); setU32le(p, 0x24, n(g.exp));
  p[0x28] = n(g.ppBonuses); p[0x29] = n(g.friendship); setU16le(p, 0x2a, n(g.filler));
  for (let i = 0; i < 4; i++) { setU16le(p, 0x2c + 2 * i, n(a.moves?.[i])); p[0x34 + i] = n(a.pp?.[i]); }
  STATS.forEach((k, i) => { p[0x38 + i] = n(c.evs?.[k]); });
  CONTEST.forEach((k, i) => { p[0x3e + i] = n(c.contest?.[k]); });
  p[0x44] = n(m.pokerus); p[0x45] = n(m.metLocation);
  setU16le(p, 0x46, (n(m.metLevel) & 0x7f) | ((n(m.metGame) & 15) << 7) | ((n(m.ball) & 15) << 11) | ((n(m.otGender) & 1) << 15));
  let iv = 0;
  STATS.forEach((k, i) => { iv |= (n(m.ivs?.[k]) & 31) << (5 * i); });
  setU32le(p, 0x48, iv | (m.isEgg ? 1 << 30 : 0) | ((n(m.abilityNum) & 1) << 31));
  let rw = 0;
  CONTEST_RIBBONS.forEach((k, i) => { rw |= (n(r[k.toLowerCase()]) & 7) << (3 * i); });
  RIBBON_FLAGS.forEach((k, i) => { if (r[k]) rw |= 1 << (15 + i); });
  setU32le(p, 0x4c, rw | ((n(r.unused) & 15) << 27) | (m.fatefulEncounter ? 1 << 31 : 0));
  if (f.party) {
    const q = f.party;
    setU32le(p, 0x50, n(q.status)); p[0x54] = n(q.level); p[0x55] = q.mail ?? 0xff;
    setU16le(p, 0x56, n(q.hp)); setU16le(p, 0x58, n(q.maxHp));
    STATS.slice(1).forEach((k, i) => setU16le(p, 0x5a + 2 * i, n(q[k])));
  }
  return encrypt3(p);
}

/* ---------- view ---------- */

const ppUpsOf = (bonuses, i) => (bonuses >> (2 * i)) & 3;
const toShowdownOrder = (s) => ({ hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe });

/** Ribbon names in game order (Hoenn contest ribbons: rank n earns the first n of Normal/Super/Hyper/Master). */
export function ribbonNames(ribbons) {
  const out = [];
  CONTEST_RIBBONS.forEach((c) => {
    const rank = ribbons[c.toLowerCase()];
    if (rank <= 4) for (let i = 0; i < rank; i++) out.push(`${c} Ribbon${RANKS[i]}`);
  });
  RIBBON_FLAGS.forEach((k, i) => { if (ribbons[k]) out.push(RIBBON_NAMES[i]); });
  return out;
}

/** Deoxys has no stored form in Gen 3: it takes the form of the cartridge it is in (format-gen3.md §8.6). */
function deoxysForm(game) {
  return D.DEOXYS_GEN3_FORM[game] ?? null;
}

export function toView(fields, meta = {}) {
  const f = fields;
  const species = D.gen3ToNational(f.growth.species);
  const warnings = [];
  const ok = f.derived?.checksumOk ?? true;
  if (!ok) warnings.push("The checksum does not match: the game shows this Pokémon as a Bad Egg.");
  if (f.flags.badEgg) warnings.push("This record is marked as a Bad Egg.");
  if (!species) warnings.push(`Unknown species index ${f.growth.species}.`);
  const lang = nameLang(f.language, meta.lang);
  const nickname = text.decode(f.nickname, lang), otName = text.decode(f.otName, lang);
  let form = 0;
  if (species === 201) form = unownFormGen3(f.pid);
  if (species === 386) {
    const d = deoxysForm(meta.game);
    if (d == null) warnings.push("Deoxys takes the form of the game it is in (FireRed: Attack, LeafGreen: Defense); the game was not given.");
    form = d ?? 0;
  }
  const tid = f.otId.tid, sid = f.otId.sid;
  const rate = species ? D.growthRate(species) : 0;
  const level = f.party?.level || D.levelAtExp(rate, f.growth.exp);
  const ivs = toShowdownOrder(f.misc.ivs), evs = toShowdownOrder(f.condition.evs);
  const abilities = species ? D.abilities(3, species) : null;
  // The game reads abilities[bit] with no fallback (an empty second slot gives no ability); PKHeX and
  // Showdown use the first ability then, and so do we for display.
  const abilityId = abilities ? (abilities[f.misc.abilityNum] || abilities[0]) : null;
  const isEgg = f.misc.isEgg || f.flags.badEgg || !ok;
  const moves = f.attacks.moves.map((id, i) => ({ id, pp: f.attacks.pp[i], ppUps: ppUpsOf(f.growth.ppBonuses, i) }));
  const pkrs = f.misc.pokerus;
  const view = makeView({
    format: FORMAT, gen: GEN, lang: D.langFromId(f.language) ?? meta.lang ?? null, game: D.gameCode(f.misc.metGame),
    species, form, nickname, isNicknamed: !!species && !isDefaultName(nickname, species, 3, lang), isEgg,
    level, exp: f.growth.exp,
    gender: species ? gen3Gender(species, f.pid) : null, shiny: gen3Shiny(f.pid, tid, sid), pid: f.pid,
    natureId: natureFromPid(f.pid), abilityId, abilityNum: f.misc.abilityNum,
    heldItemId: f.growth.heldItem, moves, ivs, evs,
    friendship: f.growth.friendship, pokerus: { strain: pkrs >> 4, days: pkrs & 15 },
    ballId: f.misc.ball, markings: f.markings,
    ot: { name: otName, tid, sid, gender: f.misc.otGender ? "F" : "M" },
    met: { location: f.misc.metLocation, level: f.misc.metLevel, date: null, game: D.gameCode(f.misc.metGame) },
    ribbons: ribbonNames(f.misc.ribbons),
    stats: f.party ? { hp: f.party.maxHp, atk: f.party.atk, def: f.party.def, spa: f.party.spa, spd: f.party.spd, spe: f.party.spe } : null,
    checksumOk: ok, warnings,
  });
  view.contest = { ...f.condition.contest };
  view.fateful = f.misc.fatefulEncounter;
  if (f.party) view.party = { status: f.party.status, hp: f.party.hp, maxHp: f.party.maxHp, mail: f.party.mail };
  return view;
}

/* ---------- validate ---------- */

/** -> { ok, errors, warnings }. errors: the record must not be stored or written into a save
    (empty, damaged, impossible for Gen 3); warnings: odd but loadable. meta.game narrows the item check. */
export function validate(record, meta = {}) {
  const errors = [], warnings = [];
  const raw = own(record);
  if (raw.length !== RECORD_SIZE && raw.length !== PARTY_SIZE) {
    return { ok: false, errors: [`A Gen 3 Pokémon record is 80 bytes, not ${raw.length}.`], warnings };
  }
  if (raw.subarray(0, RECORD_SIZE).every((x) => x === 0)) return { ok: false, errors: ["This slot is empty."], warnings };
  const f = parse(raw, meta);
  const sp = f.growth.species, species = D.gen3ToNational(sp);
  if (!f.derived.checksumOk) errors.push("Bad Egg: the record's checksum does not match its data.");
  if (f.flags.badEgg) errors.push("Bad Egg: the record is flagged as damaged.");
  if (!species) errors.push(sp === 0 ? "The record holds no species." : `Species index ${sp} does not exist in Generation 3.`);
  if (sp && !f.flags.hasSpecies) errors.push("The record's species flag is not set (the game would treat it as damaged).");
  if (f.flags.useEggName !== f.misc.isEgg) errors.push("The two Egg flags disagree.");
  if (!errors.length) checkContents(f, species, meta, errors, warnings);
  return { ok: errors.length === 0, errors, warnings };
}

function checkContents(f, species, meta, errors, warnings) {
  const { moves, pp } = f.attacks;
  if (!moves[0]) errors.push("The Pokémon has no moves.");
  moves.forEach((id, i) => {
    if (id > D.MAX_MOVE[3]) errors.push(`Move ${id} does not exist in Generation 3.`);
    else if (id && pp[i] > maxPP(3, id, ppUpsOf(f.growth.ppBonuses, i))) warnings.push(`Move ${i + 1} has more PP than it can have.`);
    if (!id && pp[i]) warnings.push(`Empty move slot ${i + 1} has PP.`);
    if (id && moves.indexOf(id) !== i) warnings.push(`Move ${D.moveName(id)} is listed twice.`);
  });
  if (moves.some((id, i) => id && i > 0 && !moves[i - 1])) warnings.push("The moves have a gap.");
  const item = f.growth.heldItem;
  const fam = gameFamily(meta.game);
  if (item && (item > MAX_ITEM_BY_GAME.E || !D.itemName(3, item))) errors.push(`Held item ${item} does not exist in Generation 3.`);
  else if (item && fam && item > MAX_ITEM_BY_GAME[fam]) warnings.push(`${D.itemName(3, item)} does not exist in ${D.gameCodeName(3, fam)}.`);
  const rate = D.growthRate(species), max = D.expAtLevel(rate, 100);
  if (f.growth.exp > max) errors.push(`The EXP (${f.growth.exp}) is above the level 100 maximum (${max}).`);
  if (f.party && f.party.level !== D.levelAtExp(rate, f.growth.exp)) warnings.push("The party level does not match the EXP.");
  if (f.misc.ball < 1 || f.misc.ball > D.MAX_BALL[3]) warnings.push(`Unknown Poké Ball ${f.misc.ball}.`);
  if (!D.gameCode(f.misc.metGame)) warnings.push(`Unknown origin game ${f.misc.metGame}.`);
  const langCode = D.langFromId(f.language);
  if (!langCode || langCode === "ko") warnings.push(`Unknown language byte ${f.language}.`);
  if (f.misc.isEgg && f.language !== 1) warnings.push("Eggs have the Japanese language byte until they hatch.");
  const evTotal = Object.values(f.condition.evs).reduce((s, v) => s + v, 0);
  if (evTotal > 510) warnings.push(`The EVs add up to ${evTotal}, more than 510.`);
  if ((f.misc.pokerus & 15) > 4) warnings.push("Pokérus lasts at most 4 days.");
  if ((f.misc.pokerus & 15) && !(f.misc.pokerus >> 4)) warnings.push("Pokérus days without a strain.");
  const lang = f.derived.nameLang;
  for (const [what, bytes, len] of [["nickname", f.nickname, 10], ["OT name", f.otName, 7]]) {
    const end = bytes.indexOf(0xff), used = bytes.slice(0, end < 0 ? len : end);
    const s = text.decode(bytes, lang);
    if (!used.length) warnings.push(`The ${what} is empty.`);
    else if (s.includes("�") || used.some((b) => b >= 0xf7)) warnings.push(`The ${what} has characters the game cannot show in a name.`);
  }
}
