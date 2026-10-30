/* Battle teams made of real Pokémon: the "home" and "party" team sources (server/battles.js
   loads this module on demand).

     home   { monIds: [...] }                      Pokémon in the player's own Home
     party  { records: [{ record, meta }, ...] }   Pokémon from a save the browser opened, sent for
                                                   this battle only; they are checked like deposits
                                                   (server/records.js) and never stored

   Either way the server turns its own reading of the record into a PokemonSet; the browser
   never sends a set. toShowdownSet follows docs/research/battle-engine.md §2.3-2.5: Gen 1/2 DVs
   become ivs = 2 * DV (HP DV derived) and Stat Exp becomes evs = min(255, ceil(sqrt(statExp))),
   which reproduces the cartridge stats exactly; gender, shininess, ability and friendship are
   always passed (the sim would otherwise pick them at random or default them); moves and items
   are matched by number, not name, because our names are PokeAPI's modern spellings. Items the
   sim does not know have no battle effect and are left out with a note.

   Battles never change stored Pokémon: these are copies. */
import { Dex } from "@pkmn/sim";
import { registerTeamSource } from "./battles.js";
import { BattleError } from "./battle-sim.js";
import { acceptRecord } from "./records.js";
import { readRecord } from "../shared/pkm/index.js";
import { showdownName } from "../shared/data/index.js";
import { normalizeOptions } from "../shared/battle/formats.js";
import { hpDV } from "../shared/pkm/stats.js";

const MAX_TEAM = 6;
const byNum = new Map();   // gen -> { moves: Map(num -> id), items: Map(num -> name) }
function tables(gen) {
  let t = byNum.get(gen);
  if (!t) {
    const dex = Dex.forGen(gen);
    const moves = new Map(), items = new Map();
    for (const mv of dex.moves.all())
      if (mv.num > 0 && mv.gen <= gen && !mv.isNonstandard && !(mv.id.startsWith("hiddenpower") && mv.id !== "hiddenpower")) moves.set(mv.num, mv.id);
    for (const it of dex.items.all()) if (it.num > 0 && it.gen <= gen && !it.isNonstandard) items.set(it.num, it.name);
    byNum.set(gen, t = { moves, items });
  }
  return t;
}

const era = (g) => (g <= 2 ? "gb" : "ds");
const label = (v) => (v.isNicknamed && v.nickname ? `${v.nickname} (${v.speciesName})` : v.speciesName);

/** MonView + mechanics generation -> { set, notes }. Throws BattleError with a reason players understand. */
export function toShowdownSet(view, gen) {
  if (view.isEgg) throw new BattleError("Eggs can't battle");
  if (era(view.gen) !== era(gen)) throw new BattleError(`${label(view)} is a Gen ${view.gen} Pokémon; Gen 1-2 and Gen 3-5 Pokémon can't battle under each other's rules`);
  if (view.gen > gen) throw new BattleError(`${label(view)} is a Gen ${view.gen} Pokémon; it can't battle under Gen ${gen} rules`);
  const dex = Dex.forGen(gen);
  const want = dex.species.get(showdownName(view.species, view.form || 0, gen) ?? view.speciesName);
  const base = dex.species.get(showdownName(view.species, 0, gen) ?? view.speciesName);
  const sp = want.exists && want.gen <= gen && !want.battleOnly ? want : base;
  if (!sp.exists || sp.gen > gen) throw new BattleError(`${view.speciesName} does not exist in Gen ${gen}`);
  const { moves: moveIds, items } = tables(gen);
  const notes = [];
  const known = view.moves.map((m) => moveIds.get(m.id));
  if (known.some((m) => !m)) throw new BattleError(`${label(view)} knows a move that does not exist in Gen ${gen}`);
  // The games never store a move twice, but edited saves can; the sim refuses the whole team for it.
  const moves = [...new Set(known)];
  if (moves.length < known.length) notes.push(`${label(view)} knows a move twice; it battles with it once.`);
  if (!moves.length) throw new BattleError(`${label(view)} knows no moves`);
  const set = {
    name: view.isNicknamed ? view.nickname : "",
    species: sp.name, level: view.level, moves,
    gender: sp.gender || gen === 1 ? "" : (view.gender ?? ""),
    shiny: gen >= 2 && !!view.shiny,
  };
  if (gen <= 2) {
    const d = view.dvs, se = view.statExp;
    const ev = (x) => Math.min(255, Math.ceil(Math.sqrt(x || 0)));
    set.ivs = { hp: 2 * hpDV(d), atk: 2 * d.atk, def: 2 * d.def, spa: 2 * d.spc, spd: 2 * d.spc, spe: 2 * d.spe };
    set.evs = { hp: ev(se.hp), atk: ev(se.atk), def: ev(se.def), spa: ev(se.spc), spd: ev(se.spc), spe: ev(se.spe) };
    set.ability = ""; set.nature = "";
  } else {
    set.ivs = { ...view.ivs }; set.evs = { ...view.evs };
    set.nature = view.nature ?? ""; set.ability = view.ability ?? "";
  }
  if (gen >= 2) {
    set.happiness = view.friendship ?? 70;
    if (view.heldItemNational) {
      // Gen 2-only items (Berry, MiracleBerry, Berserk Gene...) have no modern number; match those by name.
      const byName = dex.items.get(String(view.heldItem || ""));
      const name = items.get(view.heldItemNational) ?? (byName.exists && byName.gen <= gen ? byName.name : null);
      if (name) set.item = name;
      else notes.push(`${label(view)}'s ${view.heldItem} has no effect in battle and is left out.`);
    }
  }
  return { set, notes };
}

function convertAll(entries, gen) {
  if (!entries.length) throw new BattleError("Choose at least one Pokémon for your team");
  if (entries.length > MAX_TEAM) throw new BattleError(`A team has at most ${MAX_TEAM} Pokémon`);
  return entries.map((v) => toShowdownSet(v, gen).set);
}

registerTeamSource("home", async (user, spec, options, ctx) => {
  const { gen } = normalizeOptions(options);
  const ids = Array.isArray(spec.monIds) ? spec.monIds.map(String) : [];
  if (new Set(ids).size !== ids.length) throw new BattleError("The same Pokémon is in the team twice");
  const views = ids.slice(0, MAX_TEAM + 1).map((id) => {
    const r = ctx.db.get("SELECT owner, record, format, lang, game, locked_by FROM home_mons WHERE id = ?", id);
    if (!r || r.owner !== user.id) throw new BattleError("One of those Pokémon is not in your Home any more");
    if (r.locked_by === "withdraw") throw new BattleError("A Pokémon that is being withdrawn can't battle");
    return readRecord(new Uint8Array(r.record), { format: r.format, lang: r.lang, game: r.game }).view;
  });
  return convertAll(views, gen);
});

registerTeamSource("party", async (user, spec, options) => {
  const { gen } = normalizeOptions(options);
  const list = Array.isArray(spec.records) ? spec.records : [];
  if (list.length > MAX_TEAM) throw new BattleError(`A team has at most ${MAX_TEAM} Pokémon`);
  const views = list.map((m, i) => {
    try { return acceptRecord(m, `Pokémon ${i + 1}`).view; }
    catch (e) { throw new BattleError(e.message); }
  });
  return convertAll(views, gen);
});
