/* Moving a Pokémon to another generation's record format, the way the games do it
   (docs/research/data-and-transfers.md §2, which cites the game code each rule comes from).

     pk1 <-> pk2   Time Capsule        official, both ways (Gen 2 -> 1 only for Time Capsule-compatible Pokémon)
     pk3  -> pk4   Pal Park            official
     pk4  -> pk5   Poké Transfer       official
     pk3  -> pk5   Pal Park, then Poké Transfer (what the real chain produces)
     pk1/pk2 -> pk3 (and on to pk4/pk5)  "vc-model-v1": UNOFFICIAL, opt-in (allowUnofficial), modelled on the
                   Virtual Console -> Gen 7 transfer: nature from EXP mod 25, IVs from DVs, deterministic PID
                   keeping gender, shininess and Unown letter. No game ever did this.

   Nothing goes back up the generations except pk2 -> pk1. Every refusal is a FormatError whose
   message tells the player what to do ("forget Surf first"). Conversions are deterministic for a
   given `now` (the met date), so the server can re-run one and compare bytes.

     convert(record, meta, toFormat, { allowUnofficial, target: { game, lang }, now, dropItem })
       -> { record, meta, notes, provenance: [{ from, to, rule, at }] }
     canConvert(meta, toFormat, { allowUnofficial }) -> { ok, unofficial, reason } */
import { FormatError, sha1 } from "../bytes.js";
import * as D from "../data/index.js";
import { calcStats, gen2Gender, gen2Shiny, unownLetterGen2, gen3Gender, unownFormGen3, maxPP, hpDV } from "./stats.js";
import { defaultName, isDefaultName } from "./names.js";
import * as pk1 from "./pk1.js";
import * as pk2 from "./pk2.js";
import * as pk3 from "./pk3.js";
import * as pk4 from "./pk4.js";
import * as pk5 from "./pk5.js";
import { decodeName } from "./gblist.js";
import * as t3 from "../text/gen3.js";

const CODEC = { pk1, pk2, pk3, pk4, pk5 };
const GROUP = (lang) => (lang === "ja" ? "ja" : lang === "ko" ? "ko" : "west");
const fail = (msg, code) => { throw new FormatError(msg, { code }); };
const PAL_PARK = 55, POKE_TRANSFER = 30001;
const genderCode = (g) => (g === "M" ? 0 : g === "F" ? 1 : 2);
const dateOf = (now) => [now.getFullYear() - 2000, now.getMonth() + 1, now.getDate()];

/** Steps from one format to another: [[from, to, rule], ...] or null when there is no path. */
function route(from, to, unofficial) {
  const OFFICIAL = { "pk1>pk2": "time-capsule", "pk2>pk1": "time-capsule", "pk3>pk4": "pal-park", "pk4>pk5": "poke-transfer" };
  if (from === to) return [];
  if (OFFICIAL[`${from}>${to}`]) return [[from, to, OFFICIAL[`${from}>${to}`]]];
  if (from === "pk3" && to === "pk5") return [["pk3", "pk4", "pal-park"], ["pk4", "pk5", "poke-transfer"]];
  if ((from === "pk1" || from === "pk2") && ["pk3", "pk4", "pk5"].includes(to) && unofficial) {
    const rest = route("pk3", to, false);
    return [[from, "pk3", "vc-model-v1"], ...rest];
  }
  return null;
}

export function canConvert(meta, toFormat, { allowUnofficial = false } = {}) {
  const official = route(meta.format, toFormat, false);
  if (official) return { ok: true, unofficial: false, reason: null };
  const any = route(meta.format, toFormat, true);
  if (any) return allowUnofficial
    ? { ok: true, unofficial: true, reason: null }
    : { ok: false, unofficial: true, reason: "No game can move Gen 1/2 Pokémon to Gen 3 or later. This server can do an unofficial conversion if you allow it." };
  const back = Number(toFormat.slice(2)) < Number(meta.format.slice(2));
  return { ok: false, unofficial: false, reason: back ? "Pokémon can't go back to an older generation (except Gen 2 to Gen 1 through the Time Capsule)." : "There is no way to move this Pokémon there." };
}

export function convert(record, meta, toFormat, opts = {}) {
  const now = opts.now ?? new Date();
  const steps = route(meta.format, toFormat, !!opts.allowUnofficial);
  if (!steps) fail(canConvert(meta, toFormat, opts).reason, "no-route");
  let cur = { record, meta }, notes = [], provenance = [];
  for (const [from, to, rule] of steps) {
    // Chains through Gen 4 need a Gen 4 game to stand in for; Platinum knows every Gen 3 move's HM status.
    const target = to === toFormat ? opts.target ?? {} : { game: "Pt", lang: opts.target?.lang ?? cur.meta.lang };
    const out = STEP[rule](cur.record, cur.meta, { ...opts, target, now });
    notes = notes.concat(out.notes);
    provenance.push({ from, to, rule, at: now.getTime() });
    cur = { record: out.record, meta: out.meta };
  }
  return { record: cur.record, meta: cur.meta, notes, provenance };
}

/* ---------- Time Capsule (§2.1) ---------- */

function timeCapsule(record, meta, opts) {
  return meta.format === "pk1" ? gen1to2(record, meta, opts) : gen2to1(record, meta, opts);
}

function sameGroup(meta, target) {
  if (target.lang && GROUP(target.lang) !== GROUP(meta.lang))
    fail("Pokémon from Japanese, Korean and other-language Game Boy games can't be moved between each other.", "language");
}

function gen1to2(record, meta, { target = {} }) {
  sameGroup(meta, target);
  const f = pk1.parse(record, meta);
  const level = pk1.levelFromExp(f.species, f.exp);
  const [t1, t2] = pk1.baseTypeBytes(f.species);
  if (level > 100) fail("A Pokémon above level 100 can't go through the Time Capsule.", "level");
  if (f.type1 !== t1 || f.type2 !== t2) fail("Gold, Silver and Crystal would call this Pokémon abnormal: its types don't match its species.", "types");
  const out = {
    isEgg: false, listByte: null, species: f.species, heldItem: D.gen1CatchRateItem(f.catchRate),
    moves: f.moves, tid: f.tid, exp: f.exp, statExp: f.statExp, dvs: f.dvs, pp: f.pp, ppUps: f.ppUps,
    friendship: 70, pokerus: { strain: 0, days: 0 }, caught: { timeOfDay: 0, level: 0, otGender: 0, location: 0 }, level,
    otName: decodeName(2, f.otNameBytes, meta.lang), nickname: decodeName(2, f.nicknameBytes, meta.lang),
    otNameBytes: f.otNameBytes, nicknameBytes: f.nicknameBytes,
  };
  const m = { format: "pk2", lang: meta.lang, game: target.game ?? null };
  const notes = out.heldItem ? [`It arrives holding ${D.itemName(2, out.heldItem) ?? "an item"} (Gen 1 stores a catch rate where Gen 2 keeps the held item).`] : [];
  return { record: pk2.build(out, m), meta: m, notes };
}

function gen2to1(record, meta, { target = {} }) {
  if (meta.lang === "ko") fail("Korean Gold and Silver Pokémon can't go to Generation 1 (there is no Korean Red, Blue or Yellow).", "language");
  sameGroup(meta, target);
  const f = pk2.parse(record, meta);
  if (f.isEgg) fail("Eggs can't go through the Time Capsule.", "egg");
  if (f.species > 151) fail(`${D.speciesName(f.species)} doesn't exist in Generation 1.`, "species");
  const newMove = f.moves.find((m) => m > 165);
  if (newMove) fail(`It knows ${D.moveName(newMove)}, which doesn't exist in Generation 1. Make it forget the move first.`, "move");
  if (pk2.isMail(f.heldItem)) fail("Take the Mail off first.", "mail");
  const level = pk2.levelFromExp(f.species, f.exp);
  const hp = calcStats(1, f.species, 0, level, f.dvs, f.statExp)?.hp ?? 1;
  const [type1, type2] = pk1.baseTypeBytes(f.species);
  const out = {
    speciesIndex: D.nationalToGen1(f.species), species: f.species, hp, boxLevel: level, status: 0, type1, type2,
    catchRate: f.heldItem, moves: f.moves, tid: f.tid, exp: f.exp, statExp: f.statExp, dvs: f.dvs, pp: f.pp, ppUps: f.ppUps,
    otName: decodeName(1, f.otNameBytes, meta.lang), nickname: decodeName(1, f.nicknameBytes, meta.lang),
    otNameBytes: f.otNameBytes, nicknameBytes: f.nicknameBytes,
  };
  const m = { format: "pk1", lang: meta.lang, game: target.game ?? null };
  const notes = ["Friendship, Pokérus and Crystal's caught data don't exist in Generation 1 and are lost."];
  if (f.heldItem) notes.push("Its held item becomes its Gen 1 catch rate and comes back if it returns to Gen 2.");
  return { record: pk1.build(out, m), meta: m, notes };
}

/* ---------- Pal Park (§2.2) ---------- */

const ppUpsOf = (b) => [0, 1, 2, 3].map((i) => (b >> (2 * i)) & 3);
const CONTEST_CATS = ["cool", "beauty", "cute", "smart", "tough"];
const OTHER_G3 = ["champion", "winning", "victory", "artist", "effort", "marine", "land", "sky", "country", "national", "earth", "world"];

function palPark(record, meta, { target = {}, now }) {
  const g = pk3.parse(record, meta);
  const species = D.gen3ToNational(g.growth.species);
  const name = D.speciesName(species) ?? "This Pokémon";
  if (!g.derived.checksumOk || g.flags.badEgg) fail("This Pokémon's data is damaged (a Bad Egg) and can't be moved.", "bad-egg");
  if (g.misc.isEgg) fail("Eggs can't go to Pal Park. Hatch it first.", "egg");
  if (!species) fail("This is not a real Pokémon species and can't be moved.", "species");
  const hm = g.attacks.moves.find((m) => D.hmMoves(3).includes(m));
  if (hm) fail(`${name} knows ${D.moveName(hm)}, an HM. Pal Park refuses Pokémon that know HMs; make it forget the move first.`, "hm");
  if (D.PAL_PARK_BLOCKED_G3.includes(g.growth.heldItem))
    fail(`${name} holds ${D.itemName(3, g.growth.heldItem) ?? "an item"}, which can't go to Pal Park. Take it off first.`, "item");

  const lang = pk3.nameLang(g.language, meta.lang);
  const dstLang = target.lang ?? lang;
  const fam = pk4.gameFamily(target.game ?? "Pt") ?? "Pt";
  const f = pk4.parse(pk4.emptyRecord(), { format: "pk4", lang: dstLang });
  const level = D.levelAtExp(D.growthRate(species), g.growth.exp);
  const moves = g.attacks.moves, ppUps = ppUpsOf(g.growth.ppBonuses);
  const [a1, a2] = D.abilities(4, species) ?? [0, 0];
  const ability = a2 && D.gainedAbilityInGen4(species) ? a1 : a2 && g.misc.abilityNum ? a2 : a1;
  let ribbons = 0, bit = 0;
  for (const c of CONTEST_CATS) { const rank = g.misc.ribbons[c]; for (let i = 0; i < 4; i++, bit++) if (rank > i && rank <= 4) ribbons |= 1 << bit; }
  for (const r of OTHER_G3) { if (g.misc.ribbons[r]) ribbons |= 1 << bit; bit++; }
  const nickname = t3.decode(g.nickname, lang);
  const deoxys = species === 386 ? (D.DEOXYS_GEN3_FORM[meta.game] ?? 0) : 0;
  Object.assign(f, {
    pid: g.pid, species, heldItem: g.growth.heldItem ? D.g3ItemToG4(g.growth.heldItem) : 0,
    tid: g.otId.tid, sid: g.otId.sid, exp: g.growth.exp, friendship: 70, ability,
    markings: g.markings & 0x0f, language: g.language, evs: { ...g.condition.evs },
    contest: { ...g.condition.contest }, moves: [...moves], ppUps, pp: moves.map((m, i) => (m ? maxPP(4, m, ppUps[i]) : 0)),
    ivs: { ...g.misc.ivs }, isEgg: false,
    isNicknamed: !isDefaultName(nickname, species, 4, dstLang) || lang !== dstLang,
    ribbonsHoenn: ribbons >>> 0, fateful: !!g.misc.fatefulEncounter,
    gender: genderCode(gen3Gender(species, g.pid)),
    form: species === 201 ? unownFormGen3(g.pid) % 28 : deoxys,
    nickname, nicknameCodes: null, otName: t3.decode(g.otName, lang), otNameCodes: null,
    version: g.misc.metGame, pokerus: g.misc.pokerus, ballDP: g.misc.ball, otGender: g.misc.otGender,
    metLevel: level, metDate: dateOf(now), eggDate: [0, 0, 0], groundTile: 0,
  });
  f.metLocationDP = PAL_PARK; f.metLocationPt = fam === "DP" ? 0 : PAL_PARK;
  f.eggLocationDP = 0; f.eggLocationPt = 0;
  if (fam === "HGSS" && g.misc.ball <= 16) f.ballHGSS = g.misc.ball;
  const notes = [];
  if (species === 386) notes.push(`Deoxys takes the form of the Gen 3 game it came from (${["Normal", "Attack", "Defense", "Speed"][deoxys]} Forme).`);
  if (g.growth.heldItem && !f.heldItem) notes.push("Its held item has no Generation 4 equivalent and is lost.");
  const m = { format: "pk4", lang: D.langFromId(g.language) ?? dstLang, game: target.game ?? null };
  return { record: pk4.build(f, m), meta: m, notes };
}

/* ---------- Poké Transfer (§2.3) ---------- */

const MOVIE_DOGS = [243, 244, 245], CELEBI = 251;

function pokeTransfer(record, meta, { target = {}, now }) {
  const p = pk4.parse(record, meta);
  const name = D.speciesName(p.species) ?? "This Pokémon";
  if (!p.checksumOk) fail("This Pokémon's data is damaged (a Bad Egg) and can't be moved.", "bad-egg");
  if (p.isEgg) fail("Eggs can't be transferred. Hatch it first.", "egg");
  if (p.species === 172 && p.form === 1) fail("The Spiky-eared Pichu can't be transferred to Generation 5.", "species");
  const srcGame = pk4.gameFamily(meta.game ?? "") === "HGSS" ? "HGSS" : "Pt";
  const hm = p.moves.find((m) => D.hmMoves(4, srcGame).includes(m));
  if (hm) fail(`${name} knows ${D.moveName(hm)}, an HM. Poké Transfer refuses Pokémon that know HMs; make it forget the move first.`, "hm");

  // The PK4 and PK5 box layouts coincide; read the same bytes as PK5 and fix what differs.
  const f = pk5.parse(record.slice(0, 136), { format: "pk5", lang: meta.lang });
  const level = D.levelAtExp(D.growthRate(p.species), p.exp);
  const notes = [];
  f.nature = p.pid % 25;
  f.hiddenAbility = false; f.nsPokemon = false; f.flags42 = 0; f.unused44 = 0;
  f.eggLocation = p.eggLocationDP;
  f.metLocation = p.fateful && p.version >= 7 && MOVIE_DOGS.includes(p.species) ? 30012 : p.fateful && p.species === CELEBI ? 30010 : POKE_TRANSFER;
  f.metDate = dateOf(now);
  f.metLevel = level;
  f.ball = pk4.ball(p);
  f.unused86 = 0; f.pokeStarFame = 0;
  f.friendship = 70;
  if (p.heldItem) notes.push(`Its ${D.itemName(4, p.heldItem) ?? "held item"} is not transferred (Poké Transfer leaves held items behind).`);
  f.heldItem = 0;
  if (p.species === 493 && f.form) { f.form = 0; notes.push("Arceus becomes Normal type without its Plate."); }
  if (p.species === 487 && f.form) { f.form = 0; notes.push("Giratina returns to Altered Forme without the Griseous Orb."); }
  if (p.species === 292) f.gender = 2;
  f.pp = f.moves.map((m, i) => (m ? maxPP(5, m, f.ppUps[i]) : 0));
  // Names: Gen 4 character codes become Gen 5 text (pk5.build re-encodes when the bytes differ).
  f.nickname = p.nickname;
  f.otName = p.otName;
  const m = { format: "pk5", lang: meta.lang, game: target.game ?? null };
  return { record: pk5.build(f, m), meta: m, notes };
}

/* ---------- Unofficial Gen 1/2 -> Gen 3 (§2.5, rule "vc-model-v1") ---------- */

/** Hidden Power bits b (one per stat) so the Gen 3 type equals the Gen 1/2 type: fewest bits, then smallest v. */
function hiddenPowerBits(dvs) {
  const t = 4 * (dvs.atk % 4) + (dvs.def % 4);
  let best = null;
  for (let v = 0; v < 64; v++) {
    if (Math.floor((15 * v) / 63) !== t) continue;
    const bits = v.toString(2).replace(/0/g, "").length;
    if (!best || bits < best.bits) best = { v, bits };
  }
  const v = best.v;
  return { hp: v & 1, atk: (v >> 1) & 1, def: (v >> 2) & 1, spe: (v >> 3) & 1, spa: (v >> 4) & 1, spd: (v >> 5) & 1 };
}

function findPid({ species, tid, nature, shiny, gender, letter, seed }) {
  let x = seed >>> 0 || 0x9e3779b9;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
  const ratio = D.genderThreshold(species);
  const twoGenders = ratio !== D.GENDERLESS && ratio !== D.MALE_ONLY && ratio !== D.FEMALE_ONLY;
  for (let i = 0; i < 5_000_000; i++) {
    const lo = rnd() & 0xffff;
    const hi = shiny ? (tid ^ lo ^ (rnd() & 7)) & 0xffff : rnd() & 0xffff;
    const p = ((hi << 16) | lo) >>> 0;
    if (p % 25 !== nature) continue;
    if (!shiny && (tid ^ hi ^ lo) < 8) continue;
    if (twoGenders && gen3Gender(species, p) !== gender) continue;
    if (letter != null && unownFormGen3(p) !== letter) continue;
    return p;
  }
  fail("No Gen 3 personality matches this Pokémon (please report this).", "pid");
}

const FR = 4, LG = 5;
function vcModel(record, meta, { target = {}, dropItem = false }) {
  if (meta.lang === "ko") fail("There are no Korean Gen 3 games, so Korean Gold and Silver Pokémon can't be converted.", "language");
  const gb = CODEC[meta.format].parse(record, meta);
  const gen = meta.format === "pk1" ? 1 : 2;
  if (gb.isEgg) fail("Eggs can't be converted. Hatch it first.", "egg");
  const species = gb.species;
  if (!(species >= 1 && species <= 251)) fail("This is not a real Pokémon species and can't be converted.", "species");
  const notes = ["Unofficial conversion: no game moves Generation 1/2 Pokémon to Generation 3. It is modelled on the Virtual Console transfer to Gen 7."];
  if (gen === 2 && gb.heldItem) {
    if (!dropItem) fail(`It holds ${D.itemName(2, gb.heldItem) ?? "an item"}. The conversion can't keep held items: take it off first, or allow the item to be lost.`, "item");
    notes.push("Its held item was lost.");
  }
  const rate = D.growthRate(species);
  const level = Math.min(100, D.levelAtExp(rate, gb.exp));
  const nature = gb.exp % 25;
  const dvs = gb.dvs;
  const b = hiddenPowerBits(dvs);
  const hp = hpDV(dvs);
  const ivs = { hp: 2 * hp + b.hp, atk: 2 * dvs.atk + b.atk, def: 2 * dvs.def + b.def, spe: 2 * dvs.spe + b.spe, spa: 2 * dvs.spc + b.spa, spd: 2 * dvs.spc + b.spd };
  const shiny = gen2Shiny(dvs);
  const gender = gen2Gender(species, dvs.atk);
  const letter = species === 201 ? unownLetterGen2(dvs) : null;
  const seed = new DataView(sha1(record).buffer).getUint32(0, false);
  const pid = findPid({ species, tid: gb.tid, nature, shiny, gender, letter, seed });
  const lang = meta.lang;
  const gbName = decodeName(gen, gb.nicknameBytes, lang);
  const nickname = isDefaultName(gbName, species, gen, lang) ? defaultName(species, 3, lang) : g3Text(gbName, lang, 10);
  const otName = g3Text(decodeName(gen, gb.otNameBytes, lang), lang, 7);
  const ppUps = gb.ppUps;
  const game = String(meta.game || "");
  const origin = /^(B|G|S|LG)$/i.test(game) || /blue|green|silver/i.test(game) ? LG : FR;
  const f = pk3.parse(new Uint8Array(80), { format: "pk3", lang });
  Object.assign(f, {
    pid, otId: { tid: gb.tid, sid: 0 }, nickname, language: D.LANG_IDS[lang] ?? 2, otName, markings: 0,
    flags: { ...f.flags, badEgg: false, hasSpecies: true, useEggName: false },
  });
  Object.assign(f.growth, { species: D.nationalToGen3(species), heldItem: 0, exp: D.expAtLevel(rate, level), friendship: 70,
    ppBonuses: ppUps.reduce((acc, u, i) => acc | ((u & 3) << (2 * i)), 0) });
  Object.assign(f.attacks, { moves: [...gb.moves], pp: gb.moves.map((m, i) => (m ? maxPP(3, m, ppUps[i]) : 0)) });
  Object.assign(f.misc, {
    pokerus: 0, metLocation: 0xd5, metLevel: level, metGame: origin, ball: 4,
    otGender: gen === 2 && gb.caught?.otGender ? 1 : 0, ivs, isEgg: false, abilityNum: pid & 1,
    fatefulEncounter: species === 151 || species === 251,
  });
  notes.push(`Nature ${D.natureName(nature)} (from its Exp.), IVs from its DVs, EVs reset; it was met at level ${level} in a trade.`);
  const m = { format: "pk3", lang, game: target.game ?? null };
  return { record: pk3.build(f, m), meta: m, notes };
}

/** Gen 1/2 text in Gen 3's character set, replacing the few characters Gen 3 lacks as Poké Transporter does. */
function g3Text(s, lang, len) {
  let out = s.replace(/×/g, "x").replace(/\[/g, "(").replace(/\]/g, ")");
  out = [...out].map((ch) => (t3.canEncode(ch, lang) ? ch : "?")).join("");
  const max = len === 10 ? (lang === "ja" ? 5 : 10) : (lang === "ja" ? 5 : 7);
  return [...out].slice(0, max).join("");
}

const STEP = { "time-capsule": timeCapsule, "pal-park": palPark, "poke-transfer": pokeTransfer, "vc-model-v1": vcModel };
