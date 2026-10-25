/* pk5: the Gen 5 Pokémon record (Black, White, Black 2, White 2). docs/research/format-gen5.md §8-§11.

   A record is the 136-byte box struct exactly as the PC stores it: an 8-byte header (PID, runtime
   flags, checksum) and 128 bytes of four 32-byte blocks A-D, shuffled by ((PID >> 13) & 31) % 24
   and XORed with an LCRNG keystream seeded by the checksum (shared/pkm/crypt.js). A party slot adds
   an 84-byte extension (level, current HP, stats, mail) keyed by the PID; parse() and build() also
   take that 220-byte form so the save module can read party stats, but records never carry it.

   parse() decodes every byte into a plain JSON-able object and build() writes them back, so
   build(parse(r)) is r byte for byte. Names are kept as their raw buffers next to the decoded text
   (Gen 5 leaves trash after the terminator, and gifts and trades lack the final 0xFFFF, §9);
   build() re-encodes a name only when its text was changed. build() recomputes the checksum
   unless parse() found it wrong: a Bad Egg stays a Bad Egg, it is never repaired (§16 #13).

   Gen 5 rules the view and the validator rely on (§8.6): gender is re-derived from the PID by the
   game, the nature byte is authoritative, the ability slot comes from PID bit 16 for Gen 5 origins
   and bit 0 for Gen 3/4 transfers, the box level is derived from EXP, and the PC restores full PP
   whenever it stores a Pokémon (restorePP). */
import { u16le, u32le, setU16le, setU32le, sum16le } from "../bytes.js";
import { decrypt45, encrypt45 } from "./crypt.js";
import { decode, encode } from "../text/gen5.js";
import * as D from "../data/index.js";
import { makeView } from "./view.js";
import { gen3Gender, gen3Shiny, abilitySlotFromPid, levelAtExp, expAtLevel, maxPP } from "./stats.js";

export const FORMAT = "pk5";
export const GEN = 5;
export const RECORD_SIZE = 136;
export const PARTY_SIZE = 220;
export const recordSize = () => RECORD_SIZE;

/** Mail items 137-148 (Greet Mail .. Bridge Mail M): the PC refuses boxed Pokémon holding them. */
export const isMailItem = (item) => item >= 137 && item <= 148;
/** Highest item id per game pair (format-gen5.md §0). */
export const MAX_ITEM_BW = 632, MAX_ITEM_B2W2 = 638;
const MAX_BALL = 25;
const LANG_BYTES = new Set([1, 2, 3, 4, 5, 7, 8]);
const EV_ORDER = ["hp", "atk", "def", "spe", "spa", "spd"];     // EVs, IVs and party stats all use this order
const CONTEST = ["cool", "beauty", "cute", "smart", "tough", "sheen"];

/* Ribbon names by bit, for the four ribbon words at 0x24, 0x3C, 0x60, 0x64 (§8.8). null = unused bit. */
const four = (prefix, kinds) => kinds.flatMap((k) => [`${prefix}${k}`, `${prefix}${k} Super`, `${prefix}${k} Hyper`, `${prefix}${k} Master`]);
const RIBBONS = [
  ["Sinnoh Champion", "Ability", "Great Ability", "Double Ability", "Multi Ability", "Pair Ability", "World Ability", "Alert",
    "Shock", "Downcast", "Careless", "Relax", "Snooze", "Smile", "Gorgeous", "Royal",
    "Gorgeous Royal", "Footprint", "Record", "Event", "Legend", "World Champion", "Birthday", "Special",
    "Souvenir", "Wishing", "Classic", "Premier", null, null, null, null],
  [...four("Hoenn ", ["Cool", "Beauty", "Cute", "Smart", "Tough"]), "Hoenn Champion", "Winning", "Victory", "Artist",
    "Effort", "Battle Champion", "Regional Champion", "National Champion", "Country", "National", "Earth", "World"],
  [...["Cool", "Beauty", "Cute", "Smart", "Tough"].flatMap((k) => [`Sinnoh ${k}`, `Sinnoh ${k} Great`, `Sinnoh ${k} Ultra`, `Sinnoh ${k} Master`]),
    ...Array(12).fill(null)],
  Array(32).fill(null),
];

/* Node's Buffer is a Uint8Array whose slice() is a view; crypt.js decrypts a slice() in place, so
   every input is viewed as a plain Uint8Array first (a view, no copy). */
const plain = (b) => (b.constructor === Uint8Array ? b : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

/* ---------- empty slots ---------- */

/** The game's empty box slot: a zeroed struct "encrypted" with checksum 0 and PID 0, so its bytes
    are the seed-0 keystream, not zeros (§8.7). */
export const emptyRecord = () => encrypt45(new Uint8Array(RECORD_SIZE));
/** The game's empty party slot: the same, with the extension XORed by a PID-0 keystream. */
export const emptyPartySlot = () => encrypt45(new Uint8Array(PARTY_SIZE));
/** True for the game's empty slot (decrypts to species 0 with a valid checksum) and for raw zeros
    (PKHeX's blank saves; they also decrypt to species 0). Anything else with species 0 is a Bad Egg. */
export function isEmpty(stored) {
  const box = plain(stored).subarray(0, RECORD_SIZE), p = decrypt45(box);
  if (u16le(p, 0x08) !== 0) return false;
  return sum16le(p, 0x08, 128) === u16le(p, 0x06) || box.every((x) => x === 0);
}

/* ---------- parse / build ---------- */

const bytesOf = (b, o, n) => Array.from(b.subarray(o, o + n));
const textLang = (fields, meta) => D.langFromId(fields.language) ?? (D.LANGS.includes(meta?.lang) ? meta.lang : "en");

function checkSize(record) {
  if (!(record instanceof Uint8Array)) throw new TypeError("pk5 record must be a Uint8Array");
  if (record.length !== RECORD_SIZE && record.length !== PARTY_SIZE) throw new RangeError(`pk5 record must be ${RECORD_SIZE} bytes (got ${record.length})`);
}

/** record (136 stored bytes, or a 220-byte party slot) -> Fields. */
export function parse(record, meta = {}) {
  checkSize(record);
  const p = decrypt45(plain(record));
  const checksum = u16le(p, 0x06);
  const iv = u32le(p, 0x38), b40 = p[0x40], w42 = u16le(p, 0x42), b84 = p[0x84];
  const f = {
    pid: u32le(p, 0x00), flags: u16le(p, 0x04), checksum, checksumOk: sum16le(p, 0x08, 128) === checksum,
    // block A
    species: u16le(p, 0x08), heldItem: u16le(p, 0x0a), tid: u16le(p, 0x0c), sid: u16le(p, 0x0e),
    exp: u32le(p, 0x10), friendship: p[0x14], ability: p[0x15], markings: p[0x16], language: p[0x17],
    evs: Object.fromEntries(EV_ORDER.map((k, i) => [k, p[0x18 + i]])),
    contest: Object.fromEntries(CONTEST.map((k, i) => [k, p[0x1e + i]])),
    ribbons: [u32le(p, 0x24), u32le(p, 0x3c), u32le(p, 0x60), u32le(p, 0x64)],
    // block B
    moves: [0, 1, 2, 3].map((i) => u16le(p, 0x28 + 2 * i)), pp: bytesOf(p, 0x30, 4), ppUps: bytesOf(p, 0x34, 4),
    ivs: Object.fromEntries(EV_ORDER.map((k, i) => [k, (iv >>> (5 * i)) & 31])),
    isEgg: !!((iv >>> 30) & 1), isNicknamed: !!(iv >>> 31),
    fateful: !!(b40 & 1), gender: (b40 >> 1) & 3, form: b40 >> 3, nature: p[0x41],
    hiddenAbility: !!(w42 & 1), nsPokemon: !!(w42 & 2), flags42: w42 >> 2, unused44: u32le(p, 0x44),
    // block C
    nickname: null, nicknameBytes: bytesOf(p, 0x48, 22), unused5E: p[0x5e], originGame: p[0x5f],
    // block D
    otName: null, otNameBytes: bytesOf(p, 0x68, 16),
    eggDate: bytesOf(p, 0x78, 3), metDate: bytesOf(p, 0x7b, 3),
    eggLocation: u16le(p, 0x7e), metLocation: u16le(p, 0x80), pokerus: p[0x82], ball: p[0x83],
    metLevel: b84 & 0x7f, otGender: b84 >> 7, encounterType: p[0x85], unused86: p[0x86], pokeStarFame: p[0x87],
  };
  const lang = textLang(f, meta);
  f.nickname = decode(f.nicknameBytes, lang);
  f.otName = decode(f.otNameBytes, lang);
  if (record.length === PARTY_SIZE) {
    f.party = {
      status: u32le(p, 0x88), level: p[0x8c], unknown8D: p[0x8d], hp: u16le(p, 0x8e),
      stats: Object.fromEntries(EV_ORDER.map((k, i) => [k, u16le(p, 0x90 + 2 * i)])),
      mail: bytesOf(p, 0x9c, 0x38), tail: bytesOf(p, 0xd4, 8),
    };
  }
  return f;
}

const sameText = (bytes, text, lang) => decode(bytes, lang) === text;
/** XOR the 128 block bytes with the LCRNG keystream for seed (the game's cipher, as in crypt.js). */
function xorStream(b, seed) {
  for (let o = 0x08, s = seed >>> 0; o < 0x88; o += 2) {
    s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0;
    setU16le(b, o, u16le(b, o) ^ (s >>> 16));
  }
}

/** Fields -> stored record: 136 bytes, or 220 when fields.party is present. */
export function build(f, meta = {}) {
  const p = new Uint8Array(f.party ? PARTY_SIZE : RECORD_SIZE);
  const lang = textLang(f, meta);
  setU32le(p, 0x00, f.pid); setU16le(p, 0x04, f.flags ?? 0);
  setU16le(p, 0x08, f.species); setU16le(p, 0x0a, f.heldItem); setU16le(p, 0x0c, f.tid); setU16le(p, 0x0e, f.sid);
  setU32le(p, 0x10, f.exp); p[0x14] = f.friendship; p[0x15] = f.ability; p[0x16] = f.markings; p[0x17] = f.language;
  EV_ORDER.forEach((k, i) => { p[0x18 + i] = f.evs[k]; });
  CONTEST.forEach((k, i) => { p[0x1e + i] = f.contest[k]; });
  setU32le(p, 0x24, f.ribbons[0]); setU32le(p, 0x3c, f.ribbons[1]); setU32le(p, 0x60, f.ribbons[2]); setU32le(p, 0x64, f.ribbons[3]);
  f.moves.forEach((m, i) => setU16le(p, 0x28 + 2 * i, m));
  p.set(f.pp, 0x30); p.set(f.ppUps, 0x34);
  let iv = 0;
  EV_ORDER.forEach((k, i) => { iv |= (f.ivs[k] & 31) << (5 * i); });
  setU32le(p, 0x38, (iv | (f.isEgg ? 1 << 30 : 0) | (f.isNicknamed ? 1 << 31 : 0)) >>> 0);
  p[0x40] = (f.fateful ? 1 : 0) | ((f.gender & 3) << 1) | ((f.form & 31) << 3);
  p[0x41] = f.nature;
  setU16le(p, 0x42, (f.hiddenAbility ? 1 : 0) | (f.nsPokemon ? 2 : 0) | ((f.flags42 ?? 0) << 2));
  setU32le(p, 0x44, f.unused44 ?? 0);
  // A name whose text was edited is encoded afresh ([text][FFFF][0000 ...][FFFF], §9); otherwise its bytes stay.
  p.set(f.nickname == null || sameText(f.nicknameBytes, f.nickname, lang) ? f.nicknameBytes : encode(f.nickname, lang, 22), 0x48);
  p[0x5e] = f.unused5E ?? 0; p[0x5f] = f.originGame;
  p.set(f.otName == null || sameText(f.otNameBytes, f.otName, lang) ? f.otNameBytes : encode(f.otName, lang, 16), 0x68);
  p.set(f.eggDate, 0x78); p.set(f.metDate, 0x7b);
  setU16le(p, 0x7e, f.eggLocation); setU16le(p, 0x80, f.metLocation);
  p[0x82] = f.pokerus; p[0x83] = f.ball; p[0x84] = (f.metLevel & 0x7f) | (f.otGender ? 0x80 : 0);
  p[0x85] = f.encounterType; p[0x86] = f.unused86 ?? 0; p[0x87] = f.pokeStarFame;
  if (f.party) {
    const x = f.party;
    setU32le(p, 0x88, x.status); p[0x8c] = x.level; p[0x8d] = x.unknown8D ?? 0; setU16le(p, 0x8e, x.hp);
    EV_ORDER.forEach((k, i) => setU16le(p, 0x90 + 2 * i, x.stats[k]));
    p.set(x.mail, 0x9c); p.set(x.tail, 0xd4);
  }
  const out = encrypt45(p);
  // Keep a wrong checksum wrong: swap the keystream of the computed checksum for the stored one's.
  if (f.checksumOk === false && f.checksum != null && f.checksum !== u16le(out, 0x06)) {
    xorStream(out, u16le(out, 0x06));
    xorStream(out, f.checksum);
    setU16le(out, 0x06, f.checksum);
  }
  return out;
}

/** The 136-byte box record of a stored party slot (the box part is encrypted the same way in both). */
export const boxPart = (stored) => plain(stored).slice(0, RECORD_SIZE);

/** Fields with every move's PP set to its maximum, as the PC does when it stores a Pokémon (§7.2). */
export function restorePP(f) {
  const pp = f.moves.map((m, i) => {
    const max = m ? maxPP(5, m, Math.min(3, f.ppUps[i])) : 0;
    return m && max ? max : f.pp[i];
  });
  return { ...f, pp };
}

/** What the game does to a Pokémon arriving by link trade (format-gen5.md §15.3 step 2): PP restored,
    friendship 70 (an Egg keeps its hatch counter but gets met location 30003 and today's date), and
    Sky Shaymin reverts to Land Forme with that form's ability. Registering it in the Pokédex is the
    save's job (registerDex). For withdrawals into a save of another trainer, not same-owner moves. */
export function receiveTrade(f, { date = new Date() } = {}) {
  const g = restorePP(f);
  if (!g.isEgg) g.friendship = 70;
  else { g.metLocation = 30003; g.metDate = [date.getFullYear() - 2000, date.getMonth() + 1, date.getDate()]; }
  if (g.species === 492 && g.form === 1) {
    g.form = 0;
    const slots = D.abilities(5, 492, 0);
    g.ability = (g.hiddenAbility && slots[2]) || slots[abilitySlotFromPid(g.pid, 5, g.originGame)] || slots[0];
  }
  return g;
}

/* ---------- derived values ---------- */

/** The gender the game derives from the PID (§8.6): 0 male, 1 female, 2 genderless. */
export function pidGender(species, pid) {
  const g = gen3Gender(species, pid);
  return g === "M" ? 0 : g === "F" ? 1 : 2;
}
const GENDER = ["M", "F", null, null];

/** Ability slot 0/1/2 (2 = hidden). Taken from the stored ability id when it identifies a slot,
    else from the PID bit the game would use (bit 16 for Gen 5 origins, bit 0 otherwise). */
export function abilityNumber(f) {
  if (f.hiddenAbility) return 2;
  const slots = D.abilities(5, f.species, f.form) ?? [0, 0, 0];
  const two = slots[1] && slots[1] !== slots[0];
  if (two && f.ability === slots[1]) return 1;
  if (two && f.ability === slots[0]) return 0;
  return abilitySlotFromPid(f.pid, 5, f.originGame);
}

const dateOf = ([y, m, d]) => (y || m || d ? `${2000 + y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null);
function ribbonNames(words) {
  const out = [];
  words.forEach((w, i) => { for (let bit = 0; bit < 32; bit++) if ((w >>> bit) & 1) out.push(RIBBONS[i][bit] ?? `Unknown ribbon ${i}:${bit}`); });
  return out;
}
/** The level a record has: the party byte when present, else from EXP (box structs store none). */
export const levelOf = (f) => (D.speciesGen(f.species) ? levelAtExp(D.growthRate(f.species), f.exp) : 1);

/** Fields -> MonView. */
export function toView(f, meta = {}) {
  const warnings = [];
  const badEgg = !f.checksumOk || !!(f.flags & 4);
  if (!f.checksumOk) warnings.push("Checksum mismatch: the game shows this Pokémon as a Bad Egg.");
  const level = f.party ? f.party.level : levelOf(f);
  const derived = D.speciesGen(f.species) ? pidGender(f.species, f.pid) : f.gender;
  if (!badEgg && derived !== f.gender) warnings.push(`Stored gender does not match the PID; the game will show ${["male", "female", "genderless"][derived]}.`);
  const view = makeView({
    format: FORMAT, gen: GEN, lang: D.langFromId(f.language) ?? meta.lang ?? null, game: D.gameCode(f.originGame) ?? meta.game ?? null,
    species: f.species, form: f.form, nickname: f.nickname ?? decode(f.nicknameBytes, textLang(f, meta)),
    isNicknamed: f.isNicknamed, isEgg: f.isEgg || badEgg,
    level, exp: f.exp, gender: GENDER[f.gender], shiny: gen3Shiny(f.pid, f.tid, f.sid), pid: f.pid,
    natureId: f.nature < 25 ? f.nature : null, abilityId: f.ability, abilityNum: abilityNumber(f),
    heldItemId: f.heldItem,
    moves: f.moves.map((id, i) => ({ id, pp: f.pp[i], ppUps: f.ppUps[i] })),
    ivs: f.ivs, evs: f.evs,
    stats: f.party && !f.isEgg ? f.party.stats : undefined,
    friendship: f.friendship, pokerus: f.pokerus ? { strain: f.pokerus >> 4, days: f.pokerus & 15 } : null,
    ballId: f.ball, markings: f.markings,
    ot: { name: f.otName ?? decode(f.otNameBytes, textLang(f, meta)), tid: f.tid, sid: f.sid, gender: f.otGender ? "F" : "M" },
    met: { location: f.metLocation, level: f.metLevel, date: dateOf(f.metDate), game: D.gameCode(f.originGame) },
    ribbons: ribbonNames(f.ribbons), checksumOk: f.checksumOk, warnings,
  });
  view.extra = {
    hiddenAbility: f.hiddenAbility, nsPokemon: f.nsPokemon, fateful: f.fateful, pokeStarFame: f.pokeStarFame,
    encounterType: f.encounterType, originGame: f.originGame, language: f.language, badEgg,
    egg: f.eggLocation || f.eggDate.some(Boolean) ? { location: f.eggLocation, locationName: D.locationName(5, f.eggLocation), date: dateOf(f.eggDate) } : null,
    contest: { ...f.contest },
    party: f.party ? { status: f.party.status, hp: f.party.hp, level: f.party.level } : null,
  };
  return view;
}

/* ---------- validate ---------- */

const CONTROL = /[\u0000-\u001f�]/;
function checkName(bytes, label, errors, warnings, lang, required) {
  const units = bytes.length / 2;
  let end = -1;
  for (let i = 0; i < units; i++) { const c = bytes[2 * i] | (bytes[2 * i + 1] << 8); if (c === 0xffff || c === 0) { end = i; break; } }
  const text = decode(Uint8Array.from(bytes), lang, { unknown: "�" });
  if (end < 0) warnings.push(`${label} has no terminator.`);
  if (required && !text.length) errors.push(`${label} is empty.`);
  if (CONTROL.test(text)) errors.push(`${label} contains characters the game cannot show.`);
}

/** -> { ok, errors, warnings }. meta.game ("B", "W", "BW", "B2", ...) narrows the item range. */
export function validate(record, meta = {}) {
  const errors = [], warnings = [];
  if (!(record instanceof Uint8Array) || (record.length !== RECORD_SIZE && record.length !== PARTY_SIZE)) {
    return { ok: false, errors: [`A pk5 record is ${RECORD_SIZE} bytes.`], warnings };
  }
  const f = parse(record, meta);
  if (!f.checksumOk) errors.push("Checksum mismatch (the game shows a Bad Egg).");
  if (f.flags & 4) errors.push("The Bad Egg flag is set.");
  // The game reads a struct with these set as already decrypted, i.e. as scrambled data (§8.1).
  if (f.flags & 3) errors.push("The header's decryption flags are set (the game would read scrambled data).");
  if (f.species === 0) errors.push("The slot is empty.");
  else if (f.species > D.MAX_SPECIES[5]) errors.push(`Species ${f.species} does not exist in Generation 5.`);
  if (errors.length) return { ok: false, errors, warnings };

  const bw = /^(B|W|BW)$/.test(meta.game ?? "");
  const maxItem = bw ? MAX_ITEM_BW : MAX_ITEM_B2W2;
  if (f.heldItem > maxItem || (f.heldItem && !D.itemToNational(5, f.heldItem))) errors.push(`Held item ${f.heldItem} does not exist in ${bw ? "Black/White" : "Generation 5"}.`);
  if (isMailItem(f.heldItem)) warnings.push("Holds mail; the PC does not store Pokémon holding mail.");
  const moves = f.moves.filter(Boolean);
  if (!moves.length && !f.isEgg) errors.push("Knows no moves.");
  for (const m of f.moves) if (m > D.MAX_MOVE[5]) errors.push(`Move ${m} does not exist in Generation 5.`);
  f.moves.forEach((m, i) => {
    if (f.ppUps[i] > 3) errors.push(`Move ${i + 1} has ${f.ppUps[i]} PP Ups (maximum 3).`);
    if (m && m <= D.MAX_MOVE[5] && f.pp[i] > maxPP(5, m, Math.min(3, f.ppUps[i]))) warnings.push(`Move ${i + 1} has more PP than its maximum.`);
  });
  if (new Set(moves).size !== moves.length) warnings.push("Knows the same move twice.");
  if (!f.ability || f.ability > D.MAX_ABILITY[5]) errors.push(`Ability ${f.ability} does not exist in Generation 5.`);
  else {
    const slots = D.abilities(5, f.species, f.form) ?? [];
    if (!slots.includes(f.ability)) warnings.push(`${D.abilityName(f.ability)} is not an ability of this species.`);
    else if (f.hiddenAbility && slots[2] && f.ability !== slots[2]) warnings.push("The hidden-ability flag is set but the ability is not the hidden one.");
  }
  if (f.nature > 24) errors.push(`Nature ${f.nature} does not exist.`);
  if (!f.ball || f.ball > MAX_BALL) errors.push(`Ball ${f.ball} does not exist in Generation 5.`);
  if (f.form >= D.formCount(f.species, 5)) errors.push(`Form ${f.form} does not exist for this species.`);
  if (bw && ((f.species === 646 && f.form) || (f.species === 647 && f.form) || ([641, 642, 645].includes(f.species) && f.form))) {
    errors.push("This form only exists in Black 2 and White 2.");
  }
  const evTotal = EV_ORDER.reduce((n, k) => n + f.evs[k], 0);
  if (evTotal > 510) warnings.push(`EV total ${evTotal} is above 510.`);
  const rate = D.growthRate(f.species);
  if (f.exp > expAtLevel(rate, 100)) errors.push("Experience is above the level 100 maximum.");
  if (f.party && f.party.level !== levelAtExp(rate, f.exp)) warnings.push("Party level does not match the experience.");
  if (f.isEgg && f.exp > expAtLevel(rate, 1)) warnings.push("An Egg with experience above level 1.");
  if (pidGender(f.species, f.pid) !== f.gender) warnings.push("Stored gender does not match the PID and gender ratio.");
  if (f.language && !LANG_BYTES.has(f.language)) warnings.push(`Unknown language byte ${f.language}.`);
  if (!D.gameGen(f.originGame)) warnings.push(`Unknown origin game ${f.originGame}.`);
  const lang = textLang(f, meta);
  checkName(f.nicknameBytes, "Nickname", errors, warnings, lang, true);
  checkName(f.otNameBytes, "OT name", errors, warnings, lang, true);
  return { ok: errors.length === 0, errors, warnings };
}
