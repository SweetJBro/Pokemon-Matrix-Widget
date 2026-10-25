/* MonView: the one format-independent shape of a Pokémon that the UI, Home, trades and battles
   read (docs/ARCHITECTURE.md). Every pkN.toView fills the raw facts it decoded and passes them
   through makeView(), which adds names, derived values and defaults, so all five formats agree on
   field names, units and null-vs-absent.

   Inputs makeView expects from a codec (ids are in the record's own generation unless noted):
     format, gen, lang, game, species (National Dex), form, nickname, isNicknamed, isEgg,
     level, exp, gender ("M" | "F" | null), shiny, pid (Gen 3+ or null),
     natureId (0-24 or null), abilityId (null in Gen 1/2), abilityNum (0 | 1 | 2 or null),
     heldItemId (item index as stored in that generation, 0 = none),
     moves [{ id, pp, ppUps }] (empty slots left out),
     ivs { hp, atk, def, spa, spd, spe } (Gen 3+) or dvs { atk, def, spe, spc } (Gen 1/2),
     evs { hp, atk, def, spa, spd, spe } (Gen 3+) or statExp { hp, atk, def, spe, spc } (Gen 1/2),
     friendship, pokerus { strain, days } | null, ballId, markings, ot { name, tid, sid, gender },
     met { location, level, date, game } | null, ribbons [names], checksumOk, warnings [],
     stats (optional: party stats as stored; otherwise computed here). */
import * as D from "../data/index.js";
import { calcStats, hpDV } from "./stats.js";

const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"];

export function makeView(v) {
  const gen = v.gen;
  const gb = gen <= 2;
  const moves = (v.moves || []).filter((m) => m && m.id).map((m) => ({
    id: m.id, name: D.moveName(m.id) ?? `Move #${m.id}`, pp: m.pp ?? null, ppUps: m.ppUps ?? 0,
    type: D.moveInfo(m.id, gen)?.type ?? null,
  }));
  const dvs = gb && v.dvs ? { hp: hpDV(v.dvs), ...v.dvs } : null;
  const heldItemId = v.heldItemId || 0;
  const stats = v.stats || (v.isEgg ? null : calcStats(gen, v.species, v.form || 0, v.level, gb ? v.dvs : v.ivs, gb ? v.statExp : v.evs, v.natureId ?? 0));
  const out = {
    format: v.format, gen, lang: v.lang ?? null, game: v.game ?? null,
    species: v.species, speciesName: D.speciesName(v.species) ?? `#${v.species}`,
    form: v.form || 0, formName: D.formName(v.species, v.form || 0, gen),
    nickname: v.nickname ?? "", isNicknamed: !!v.isNicknamed, isEgg: !!v.isEgg,
    level: v.level, exp: v.exp ?? null,
    gender: v.gender ?? null, shiny: !!v.shiny,
    nature: v.natureId == null ? null : D.natureName(v.natureId), natureId: v.natureId ?? null,
    ability: v.abilityId ? D.abilityName(v.abilityId) : null, abilityId: v.abilityId || null, abilityNum: v.abilityNum ?? null,
    heldItem: heldItemId ? (D.itemName(gen, heldItemId) ?? `Item #${heldItemId}`) : null,
    heldItemId, heldItemNational: heldItemId ? D.itemToNational(gen, heldItemId) : 0,
    moves,
    ivs: gb ? null : pick(v.ivs), dvs,
    evs: gb ? null : pick(v.evs), statExp: gb && v.statExp ? { ...v.statExp } : null,
    stats: stats ? pick(stats) : null,
    types: D.types(gen, v.species, v.form || 0),
    friendship: v.friendship ?? null, pokerus: v.pokerus ?? null,
    ball: v.ballId ? D.ballName(v.ballId, Math.max(3, gen)) : null, ballId: v.ballId ?? null,
    markings: v.markings ?? 0,
    ot: { name: v.ot?.name ?? "", tid: v.ot?.tid ?? 0, sid: v.ot?.sid ?? null, gender: v.ot?.gender ?? null },
    met: v.met ? { ...v.met, locationName: v.met.location != null ? D.locationName(gen, v.met.location) : null } : null,
    ribbons: v.ribbons || [],
    pid: v.pid ?? null,
    checksumOk: v.checksumOk !== false,
    warnings: v.warnings || [],
  };
  return out;
}

function pick(o) {
  if (!o) return null;
  const r = {};
  for (const k of STAT_KEYS) r[k] = o[k] ?? 0;
  return r;
}

/** Short label for lists and logs: nickname when set, else species, plus level ("PIKACHU Lv.25"). */
export function label(view) {
  if (view.isEgg) return "Egg";
  const name = view.isNicknamed && view.nickname ? view.nickname : view.speciesName;
  return `${name} Lv.${view.level}`;
}

/** The compact summary the server caches next to each Home record and sends in box listings. */
export function summary(view) {
  return {
    format: view.format, gen: view.gen, game: view.game, lang: view.lang,
    species: view.species, speciesName: view.speciesName, form: view.form, formName: view.formName,
    nickname: view.nickname, isNicknamed: view.isNicknamed, isEgg: view.isEgg,
    level: view.level, gender: view.gender, shiny: view.shiny, heldItem: view.heldItem,
    ot: { name: view.ot.name, tid: view.ot.tid },
  };
}
