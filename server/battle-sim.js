/* Glue between our battle options / team sources and @pkmn/sim (server only).

   * ensureFormat(options): registers our own format for a set of options once
     (Dex.formats.extend throws on a duplicate id, and an unknown id silently becomes a Gen 9
     battle, so we always check .exists). The id is a pure function of the options, so stored
     battles replay into the same format after a restart.
   * prepareTeam(sets, options): every team, whatever its source, is rebuilt field by field here
     before the sim sees it. `>player` does not validate anything (a Gen 1 Gyarados with
     Intimidate would happily use it), so this drops what the generation does not have
     (abilities and natures before Gen 3, items in Gen 1, moves/species/items from later
     games), makes Gen 1/2 DVs consistent (HP DV derived, one Special DV and Stat Exp), cleans
     nicknames of protocol characters and numbers duplicates ("Pidgey 2"), then runs the sim's
     TeamValidator for the team-level clauses and level rules (it rewrites levels for
     "Adjust Level"). No learnset checks: our record validation is the authority.
   * randomTeam(options): @pkmn/randoms' Random Battle sets for the generation.
   * annotateRequest(gen, request): adds each move's type and category to a player's own
     request so the widget can colour its buttons without a Dex in the browser.

   See docs/research/battle-engine.md §2. */
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Dex, TeamValidator, Teams, toID } from "@pkmn/sim";
import { TeamGenerators } from "@pkmn/randoms";
import { formatSpec, normalizeOptions, ruleKeys, OptionError } from "../shared/battle/formats.js";

/** A problem the player can fix (bad team, bad options): shown to them as is. */
export class BattleError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** The installed @pkmn/sim version. An input log replays correctly only with the same version. */
export const SIM_VERSION = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.resolve("@pkmn/sim")));
  for (let i = 0; i < 6; i++, dir = path.dirname(dir)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkg.name === "@pkmn/sim") return pkg.version;
    } catch { /* keep walking up */ }
  }
  return "unknown";
})();

const MAX_SPECIES = { 1: 151, 2: 251, 3: 386, 4: 493, 5: 649 };
const STATS = ["hp", "atk", "def", "spa", "spd", "spe"];

/** Normalize options and register their format; returns formatSpec() (id, name, ruleset, pick ...). */
export function ensureFormat(options) {
  let spec;
  try { spec = formatSpec(normalizeOptions(options)); } catch (e) { throw e instanceof OptionError ? new BattleError(e.message) : e; }
  if (!Dex.formats.get(spec.id).exists) {
    Dex.formats.extend([{ section: "Matrix Widget", name: spec.name, mod: spec.mod, gameType: spec.gameType,
      ruleset: spec.ruleset, challengeShow: false, searchShow: false, tournamentShow: false }]);
  }
  const f = Dex.formats.get(spec.id);
  if (!f.exists || f.mod !== spec.mod || f.gameType !== spec.gameType) throw new Error(`format ${spec.id} did not register`);
  return spec;
}

/** Nicknames and player names go into protocol lines ("|switch|p1a: NAME|..."), so no | , [ ] or controls. */
export function cleanName(s, max = 18) {
  return [...String(s ?? "").replace(/[|,[\]\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("").trim();
}

const int = (v, lo, hi, dflt) => (Number.isInteger(v) && v >= lo && v <= hi ? v : dflt);
const usable = (x, gen) => x?.exists && x.gen <= gen && x.gen > 0 && !x.isNonstandard;

function statTable(raw, hi, dflt) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const k of STATS) out[k] = Math.max(0, Math.min(hi, Math.trunc(Number(raw[k] ?? dflt)) || 0));
  return out;
}

/** One untrusted PokemonSet -> a clean set for `gen`. Throws BattleError naming the problem. */
export function cleanSet(raw, gen, n = 1) {
  const dex = Dex.forGen(gen);
  if (!raw || typeof raw !== "object") throw new BattleError(`Pokémon ${n} is not a valid set`);
  let sp = dex.species.get(String(raw.species ?? "").slice(0, 40));
  if (sp.exists && sp.battleOnly && typeof sp.battleOnly === "string") sp = dex.species.get(sp.battleOnly);   // Castform-Sunny -> Castform
  if (!sp.exists || sp.isNonstandard || sp.gen > gen || sp.num < 1 || sp.num > MAX_SPECIES[gen])
    throw new BattleError(`${cleanName(raw.species, 30) || `Pokémon ${n}`} cannot battle in Gen ${gen}`);
  const shown = cleanName(raw.name) || sp.baseSpecies;
  const label = shown === sp.baseSpecies ? sp.name : `${shown} (${sp.name})`;
  const moves = (Array.isArray(raw.moves) ? raw.moves : []).slice(0, 4).map((m) => dex.moves.get(String(m ?? "").slice(0, 40)));
  for (const m of moves) if (!usable(m, gen)) throw new BattleError(`${label} knows a move that does not exist in Gen ${gen}`);
  if (!moves.length) throw new BattleError(`${label} has no moves`);
  if (new Set(moves.map((m) => m.id)).size !== moves.length) throw new BattleError(`${label} knows the same move twice`);
  const set = {
    name: shown === sp.baseSpecies ? "" : shown,
    species: sp.name,
    level: int(Number(raw.level ?? 100), 1, 100, null),
    moves: moves.map((m) => m.id),
    gender: sp.gender || gen === 1 ? "" : (raw.gender === "M" || raw.gender === "F" ? raw.gender : ""),
    shiny: gen >= 2 && raw.shiny === true,
    ability: "", nature: "", item: "",
  };
  if (set.level === null) throw new BattleError(`${label} has an impossible level`);
  const ivs = statTable(raw.ivs, 31, 31), evs = statTable(raw.evs, 255, 0);
  if (gen <= 2) {
    // DV d travels as IV 2d; the HP DV is derived from the others' low bits and Special is one
    // DV and one Stat Exp for both SpA and SpD (docs/research/battle-engine.md §2.4).
    if (ivs) {
      const dv = (k) => ivs[k] >> 1;
      ivs.spd = ivs.spa;
      ivs.hp = 2 * (((dv("atk") & 1) << 3) | ((dv("def") & 1) << 2) | ((dv("spe") & 1) << 1) | (dv("spa") & 1));
      for (const k of STATS) ivs[k] = 2 * (ivs[k] >> 1);
      set.ivs = ivs;
    }
    if (evs) { evs.spd = evs.spa; set.evs = evs; }
  } else {
    if (ivs) set.ivs = ivs;
    if (evs) set.evs = evs;
    const nature = dex.natures.get(String(raw.nature ?? ""));
    if (nature.exists) set.nature = nature.name;
    const ability = dex.abilities.get(String(raw.ability ?? ""));
    set.ability = usable(ability, gen) ? ability.name : (sp.abilities[0] ?? "");
  }
  if (gen >= 2) {
    const item = dex.items.get(String(raw.item ?? "").slice(0, 40));
    if (item.exists && item.gen <= gen && (!item.isNonstandard || item.isNonstandard === "Unobtainable")) set.item = item.name;
    if (raw.happiness !== undefined) set.happiness = int(Number(raw.happiness), 0, 255, 255);
  }
  return set;
}

/** The protocol identifies Pokémon as "p1a: NAME", so names must be unique within a team. */
export function uniqueNames(sets) {
  const seen = new Map();
  for (const s of sets) {
    const shown = s.name || Dex.species.get(s.species).baseSpecies;
    const n = (seen.get(shown) ?? 0) + 1;
    seen.set(shown, n);
    if (n > 1) s.name = `${[...shown].slice(0, 15).join("")} ${n}`;
  }
  return sets;
}

/** Untrusted sets from any team source -> a clean, validated team for the options' format. */
export function prepareTeam(sets, options) {
  const o = normalizeOptions(options);
  const spec = ensureFormat(o);
  if (!Array.isArray(sets) || !sets.length) throw new BattleError("The team is empty");
  if (sets.length > o.teamSize) throw new BattleError(`This battle allows ${o.teamSize} Pokémon per team; the team has ${sets.length}`);
  if (spec.pick && sets.length < spec.pick) throw new BattleError(`Bring at least ${spec.pick} Pokémon to pick ${spec.pick}`);
  if (o.gameType === "doubles" && sets.length < 2) throw new BattleError("A double battle needs at least 2 Pokémon");
  const team = uniqueNames(sets.map((s, i) => cleanSet(s, o.gen, i + 1)));
  const problems = new TeamValidator(spec.id).validateTeam(team);
  if (problems?.length) throw new BattleError(problems.slice(0, 3).join(" "));
  return team;
}

let randomsReady = false;
/** A Random Battle team for the options' generation, trimmed to the team size. */
export function randomTeam(options, seed = randomSeed()) {
  if (!randomsReady) { Teams.setGeneratorFactory(TeamGenerators); randomsReady = true; }
  const o = normalizeOptions(options);
  const sets = Teams.generate(`gen${o.gen}randombattle`, { seed }).slice(0, o.teamSize);
  if (ruleKeys(o).includes("item")) {   // Random Battle hands out Leftovers freely; Item Clause allows one
    const seen = new Set();
    for (const s of sets) {
      const id = toID(s.item);
      if (id && seen.has(id)) s.item = ""; else if (id) seen.add(id);
    }
  }
  return sets;
}

/** PRNG seed for a battle or a team: four 16-bit numbers (stored with the battle). */
export function randomSeed() {
  return [...crypto.getRandomValues(new Uint16Array(4))];
}

/** Add { type, category } to the moves of a player's own request (their own data, nothing hidden). */
export function annotateRequest(gen, request) {
  const dex = Dex.forGen(gen);
  for (const act of request.active ?? []) {
    for (const m of act.moves ?? []) {
      const name = String(m.move ?? "");
      const mv = /^Hidden Power /.test(name) ? dex.moves.get(name.replace(/ \d+$/, "")) : dex.moves.get(m.id);
      if (mv.exists) { m.type = mv.type; m.category = mv.category; if (mv.basePower) m.power = mv.basePower; }
    }
  }
  return request;
}

/** The per-generation Dex the practice AI scores moves with. */
export const dexFor = (gen) => Dex.forGen(gen);
