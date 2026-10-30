/* What a trade does to a Pokémon, with the rules of the record's own generation
   (docs/research/data-and-transfers.md §3.5): Home trades swap records of any formats, so a
   Gen 2 Onix holding a Metal Coat traded for a Gen 5 Pokémon evolves the way Gold/Silver would
   evolve it, and comes out with what Gold/Silver would write.

   receiveTrade() is what every received Pokémon gets (friendship back to 70 in Gen 2-5; a
   traded Egg's met data in Gen 4/5). tradeEvolve() is the evolution on top: the trigger from
   that generation's table, the Everstone rule of that generation, the held item consumed,
   Gen 1 type bytes and HP, Gen 4/5 ability recomputation, and the default name updated when the
   Pokémon was not nicknamed. The "game language" for renaming is the Pokémon's own language,
   because the receiver's game is not known when the trade commits.

   Not done here, on purpose (the UI says so): learning moves on evolution (nobody to ask), and
   FireRed/LeafGreen's pre-National-Dex cancel (the receiver's save is not known yet). */
import * as D from "../data/index.js";
import { calcStats } from "./stats.js";
import { defaultName, isDefaultName } from "./names.js";
import * as pk1 from "./pk1.js";
import * as pk2 from "./pk2.js";
import * as pk3 from "./pk3.js";
import * as pk4 from "./pk4.js";
import * as pk5 from "./pk5.js";

const CODEC = { pk1, pk2, pk3, pk4, pk5 };
const EVERSTONE = 229;           // national item id
const KADABRA = 64;
const PK4_TRADED_EGG = 2002, PK5_TRADED_EGG = 30003;

/** Uniform access to the fields evolution touches, per format. */
const ACCESS = {
  pk1: {
    species: (f) => f.species, setSpecies: (f, s) => { f.species = s; f.speciesIndex = D.nationalToGen1(s); },
    item: () => 0, setItem: () => {}, isEgg: () => false,
    lang: (f, meta) => meta.lang, nicknamed: (f, meta) => !isDefaultName(f.nickname, f.species, 1, meta.lang),
    rename: (f, s, meta) => { f.nickname = defaultName(s, 1, meta.lang); f.nicknameBytes = null; },
  },
  pk2: {
    species: (f) => f.species, setSpecies: (f, s) => { f.species = s; },
    item: (f) => D.itemToNational(2, f.heldItem), setItem: (f, n) => { f.heldItem = n ? D.itemFromNational(2, n) : 0; },
    isEgg: (f) => f.isEgg,
    lang: (f, meta) => meta.lang, nicknamed: (f, meta) => !isDefaultName(f.nickname, f.species, 2, meta.lang),
    rename: (f, s, meta) => { f.nickname = defaultName(s, 2, meta.lang); f.nicknameBytes = null; },
  },
  pk3: {
    species: (f) => D.gen3ToNational(f.growth.species), setSpecies: (f, s) => { f.growth.species = D.nationalToGen3(s); },
    item: (f) => D.itemToNational(3, f.growth.heldItem), setItem: (f, n) => { f.growth.heldItem = n ? D.itemFromNational(3, n) : 0; },
    isEgg: (f) => f.misc.isEgg,
    lang: (f, meta) => pk3.nameLang(f.language, meta.lang),
    nicknamed: (f, meta) => !isDefaultName(f.derived.nickname, D.gen3ToNational(f.growth.species), 3, pk3.nameLang(f.language, meta.lang)),
    rename: (f, s, meta) => { f.nickname = defaultName(s, 3, pk3.nameLang(f.language, meta.lang)); },
  },
  pk4: {
    species: (f) => f.species, setSpecies: (f, s) => { f.species = s; f.ability = pk4.calcAbility(f) ?? f.ability; },
    item: (f) => D.itemToNational(4, f.heldItem), setItem: (f, n) => { f.heldItem = n; },
    isEgg: (f) => f.isEgg,
    lang: (f, meta) => D.langFromId(f.language) ?? meta.lang, nicknamed: (f) => f.isNicknamed,
    rename: (f, s, meta) => { f.nickname = defaultName(s, 4, D.langFromId(f.language) ?? meta.lang); f.nicknameCodes = null; },
  },
  pk5: {
    species: (f) => f.species,
    setSpecies: (f, s) => {
      f.species = s;
      const slots = D.abilities(5, s, f.form) ?? [0, 0, 0];
      const slot = f.hiddenAbility ? 2 : (f.pid >>> (f.originGame >= 20 ? 16 : 0)) & 1;
      f.ability = slots[slot] || slots[0] || f.ability;
    },
    item: (f) => D.itemToNational(5, f.heldItem), setItem: (f, n) => { f.heldItem = n; },
    isEgg: (f) => f.isEgg,
    lang: (f, meta) => D.langFromId(f.language) ?? meta.lang, nicknamed: (f) => f.isNicknamed,
    rename: (f, s, meta) => { f.nickname = defaultName(s, 5, D.langFromId(f.language) ?? meta.lang); },
  },
};

/** The trade evolution that would happen, without changing anything: -> { from, to, item, blockedBy } | null. */
export function tradeEvolution(fields, meta, { partnerSpecies = 0 } = {}) {
  const A = ACCESS[meta.format], gen = Number(meta.format.slice(2));
  if (!A || A.isEgg(fields)) return null;
  const species = A.species(fields), held = A.item(fields);
  const options = D.evolutions(species).filter((e) => e.method === "trade" && e.gen <= gen && e.to <= D.MAX_SPECIES[gen]);
  const evo = options.find((e) => (!e.item || e.item === held) && (!e.partner || e.partner === partnerSpecies));
  if (!evo) return null;
  if (held === EVERSTONE && gen >= 2 && !(gen >= 4 && species === KADABRA))
    return { from: species, to: evo.to, item: evo.item ?? 0, blockedBy: "Everstone" };
  return { from: species, to: evo.to, item: evo.item ?? 0, blockedBy: null };
}

/** record + meta -> { record, meta, from, to, notes } | null (no evolution). partnerSpecies is the
    National Dex number of the Pokémon it was traded for (Karrablast and Shelmet need each other).
    An Everstone on either side of a Karrablast/Shelmet trade stops both; pass partnerEverstone. */
export function tradeEvolve(record, meta, { partnerSpecies = 0, partnerEverstone = false } = {}) {
  const codec = CODEC[meta.format];
  const f = codec.parse(record, meta);
  const t = tradeEvolution(f, meta, { partnerSpecies });
  if (!t || t.blockedBy || (partnerEverstone && (t.from === 588 || t.from === 616))) return null;
  const A = ACCESS[meta.format];
  const notes = [];
  const wasNicknamed = A.nicknamed(f, meta);
  if (meta.format === "pk1") {
    // Gen 1 box records keep current HP and type bytes: the game sets the new types and adds the max-HP gain.
    const level = pk1.levelFromExp(t.from, f.exp);
    const before = calcStats(1, t.from, 0, level, f.dvs, f.statExp)?.hp ?? 0;
    const after = calcStats(1, t.to, 0, level, f.dvs, f.statExp)?.hp ?? before;
    [f.type1, f.type2] = pk1.baseTypeBytes(t.to);
    f.hp = Math.min(after, f.hp + Math.max(0, after - before));
  }
  A.setSpecies(f, t.to);
  if (t.item) { A.setItem(f, 0); notes.push(`Its ${D.nationalItemName(t.item)} was used up.`); }
  if (!wasNicknamed) A.rename(f, t.to, meta);
  notes.push(`It evolved into ${D.speciesName(t.to)}. Moves it would learn on evolving are not taught here.`);
  return { record: codec.build(f, meta), meta, from: t.from, to: t.to, notes };
}

/** What receiving any Pokémon in a trade changes, before any evolution. now: Date for Gen 4/5 Eggs. */
export function receiveTrade(record, meta, { now = new Date() } = {}) {
  const codec = CODEC[meta.format];
  const f = codec.parse(record, meta);
  const date = [now.getFullYear() - 2000, now.getMonth() + 1, now.getDate()];
  switch (meta.format) {
    case "pk1": return { record, meta, notes: [] };
    case "pk2": if (!f.isEgg) f.friendship = 70; break;
    case "pk3": if (!f.misc.isEgg) f.growth.friendship = 70; break;
    case "pk4":
      if (f.isEgg) { pk4.setLocation(f, "met", PK4_TRADED_EGG); f.metDate = date; }
      else f.friendship = 70;
      break;
    case "pk5":
      if (f.isEgg) { f.metLocation = PK5_TRADED_EGG; f.metDate = date; }
      else f.friendship = 70;
      break;
  }
  return { record: codec.build(f, meta), meta, notes: [] };
}

/** Both steps, as the server applies them when a trade commits. */
export function applyTrade(record, meta, opts = {}) {
  const r = receiveTrade(record, meta, opts);
  const e = tradeEvolve(r.record, meta, opts);
  return e ? { record: e.record, meta, evolved: { from: e.from, to: e.to }, notes: e.notes } : { record: r.record, meta, evolved: null, notes: r.notes };
}
