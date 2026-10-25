/* Battle options, presets, and the Showdown formats they turn into.

   A battle is described by plain options that the challenge dialog, the server and the stored
   battle row all share:
     { gen: 1-5, gameType: "singles" | "doubles", preset: "cartridge" | "smogon" | "tower",
       levelRule: "asis" | "cap50" | "cap100", teamSize: 1-6, timer: seconds per turn, 0 = off }
   normalizeOptions() checks them and fills defaults (throws OptionError with a message fit for
   a toast). formatSpec() maps them to the @pkmn/sim format that server/battle-sim.js registers
   with Dex.formats.extend(). The format name, and so its id, is a pure function of the options,
   so a stored battle replays into the same format after a restart.

   Why not the stock "[Gen N] Custom Game": those formats run in debug mode, which sends exact HP
   to the opponent, and replace the games' 16-bit truncation with Math.trunc. We also never add
   "Standard"/"Obtainable": they check learnsets and event data and would refuse real cartridge
   Pokémon. Our record validation is the authority; the sim's validator only applies team clauses
   and level rules (docs/research/battle-engine.md §2.2). No dependencies; browser and Node. */

export class OptionError extends Error {}

export const toID = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Showdown rules we use, with the 3-letter code that goes into our format names. */
export const RULES = Object.freeze({
  sleep:      { rule: "Sleep Clause Mod",           code: "Slp", label: "Sleep Clause" },
  freeze:     { rule: "Freeze Clause Mod",          code: "Frz", label: "Freeze Clause" },
  desync:     { rule: "Desync Clause Mod",          code: "Dsc", label: "Desync Clause" },
  endless:    { rule: "Endless Battle Clause",      code: "End", label: "Endless Battle Clause" },
  percent:    { rule: "HP Percentage Mod",          code: "Pct", label: "HP shown in percent" },
  preview:    { rule: "Team Preview",               code: "Prv", label: "Team Preview" },
  switchprio: { rule: "Switch Priority Clause Mod", code: "Swp", label: "Faster Pokémon switch first" },
  species:    { rule: "Species Clause",             code: "Spc", label: "Species Clause" },
  item:       { rule: "Item Clause = 1",            code: "Itm", label: "Item Clause" },
  ohko:       { rule: "OHKO Clause",                code: "Ohk", label: "OHKO Clause" },
  evasion:    { rule: "Evasion Moves Clause",       code: "Eva", label: "Evasion Clause" },
});

/* Gen 5 link battles showed both teams before the battle, so the Gen 5 presets turn Team Preview
   on; Gen 1-4 cartridges had nothing like it. Gen 3 doubles switch in player order unless
   Switch Priority Clause Mod is on (Smogon's Gen 3 rule). */
export const PRESETS = Object.freeze({
  cartridge: {
    label: "Cartridge link battle", short: "Cartridge",
    hint: "No clauses, real levels, the opponent's HP bar in pixels like the games.",
    gameTypes: ["singles", "doubles"], minGen: 1, levelRule: "asis",
    rules: (gen) => (gen === 5 ? ["preview"] : []),
  },
  smogon: {
    label: "Smogon-style", short: "Smogon",
    hint: "Sleep, Species, OHKO and Evasion clauses, Endless Battle Clause, HP in percent.",
    gameTypes: ["singles", "doubles"], minGen: 1, levelRule: "asis",
    rules: (gen) => ["sleep", "species", "ohko", "evasion", "endless", "percent",
      ...(gen <= 2 ? ["freeze"] : []), ...(gen === 3 ? ["switchprio"] : []), ...(gen === 5 ? ["preview"] : [])],
  },
  tower: {
    label: "Battle Tower doubles", short: "Battle Tower",
    hint: "Double battle at level 50, one of each species and item; bring up to 6 and pick 4.",
    gameTypes: ["doubles"], minGen: 3, levelRule: "cap50",
    rules: () => ["species", "item"],
    pick: 4,
  },
});

export const LEVEL_RULES = Object.freeze({
  asis:   { label: "Levels as they are", short: "" },
  cap50:  { label: "Level 50 (higher levels battle at 50)", short: "Lv 50", rule: "Adjust Level Down = 50", code: "L50" },
  cap100: { label: "Level 100 (everyone battles at 100)", short: "Lv 100", rule: "Adjust Level = 100", code: "A100" },
});

export const GENS = Object.freeze({
  1: { label: "Gen 1", games: "Red, Blue, Yellow" },
  2: { label: "Gen 2", games: "Gold, Silver, Crystal" },
  3: { label: "Gen 3", games: "Ruby, Sapphire, Emerald, FireRed, LeafGreen" },
  4: { label: "Gen 4", games: "Diamond, Pearl, Platinum, HeartGold, SoulSilver" },
  5: { label: "Gen 5", games: "Black, White, Black 2, White 2" },
});

/** Turn timer choices offered by the dialog (seconds; 0 = off). The server accepts 1-600. */
export const TIMERS = Object.freeze([0, 30, 60, 90, 120, 180, 300]);
export const DEFAULT_TIMER = 90;
export const MAX_TIMER = 600;

const int = (v) => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN);

/** Validate untrusted options and fill defaults. Returns a new plain object. */
export function normalizeOptions(raw = {}) {
  if (!raw || typeof raw !== "object") throw new OptionError("Battle options are missing");
  const preset = raw.preset ?? "cartridge";
  const p = PRESETS[preset];
  if (!p || !Object.hasOwn(PRESETS, preset)) throw new OptionError("Unknown battle preset");
  const gen = int(raw.gen ?? 3);
  if (!Number.isInteger(gen) || gen < 1 || gen > 5) throw new OptionError("Pick a generation from 1 to 5");
  if (gen < p.minGen) throw new OptionError(`${p.label} needs Gen ${p.minGen} or later`);
  const gameType = raw.gameType ?? p.gameTypes[0];
  if (!p.gameTypes.includes(gameType)) throw new OptionError(`${p.label} is ${p.gameTypes.join(" or ")} only`);
  if (gameType === "doubles" && gen < 3) throw new OptionError("Double battles exist from Gen 3 on");
  const levelRule = raw.levelRule ?? p.levelRule;
  if (!Object.hasOwn(LEVEL_RULES, levelRule)) throw new OptionError("Unknown level rule");
  const teamSize = int(raw.teamSize ?? 6);
  if (!Number.isInteger(teamSize) || teamSize < 1 || teamSize > 6) throw new OptionError("Team size must be 1 to 6");
  if (gameType === "doubles" && teamSize < 2) throw new OptionError("A double battle needs at least 2 Pokémon each");
  const timer = int(raw.timer ?? DEFAULT_TIMER);
  if (!Number.isInteger(timer) || timer < 0 || timer > MAX_TIMER) throw new OptionError(`The turn timer must be off or 1 to ${MAX_TIMER} seconds`);
  return { gen, gameType, preset, levelRule, teamSize, timer };
}

/** How many Pokémon each player picks at Team Preview, or null when everyone battles. */
export function pickCount(o) {
  const n = PRESETS[o.preset].pick;
  return n && o.teamSize > n ? n : null;
}

/** Rule keys (sorted) the options turn on. */
export function ruleKeys(o) {
  const keys = new Set(PRESETS[o.preset].rules(o.gen, o.gameType === "doubles"));
  if (pickCount(o)) keys.add("preview");
  if (o.gen === 1) keys.add("desync");   // a Gen 1 desync (Bide, Counter, Psywave) becomes a failed move
  return [...keys].sort();
}

/**
 * The @pkmn/sim format for normalized options:
 *   { name, id, mod, gameType, ruleset, pick, rules }
 * name looks like "[Gen 3] W Dbl L50 6v4 ItmPrvSpc" (Showdown caps names at 50 characters).
 */
export function formatSpec(o) {
  const keys = ruleKeys(o);
  const pick = pickCount(o);
  const level = LEVEL_RULES[o.levelRule];
  const ruleset = ["Cancel Mod", `Max Team Size = ${o.teamSize}`, "Max Level = 100", "Default Level = 100",
    ...keys.map((k) => RULES[k].rule)];
  if (level.rule) ruleset.push(level.rule);
  if (pick) ruleset.push(`Picked Team Size = ${pick}`);
  const name = `[Gen ${o.gen}] W${o.gameType === "doubles" ? " Dbl" : ""}${level.code ? " " + level.code : ""} ${o.teamSize}v${pick ?? o.teamSize}` +
    (keys.length ? " " + keys.map((k) => RULES[k].code).join("") : "");
  if (name.length > 50) throw new OptionError("Too many rules for one format");
  return { name, id: toID(name), mod: `gen${o.gen}`, gameType: o.gameType, ruleset, pick, rules: keys };
}

/** One-line summary: "Gen 3 · Doubles · Battle Tower · Lv 50 · pick 4 of 6 · 90 s". */
export function describeOptions(o) {
  const pick = pickCount(o);
  return [
    GENS[o.gen].label,
    o.gameType === "doubles" ? "Doubles" : "Singles",
    PRESETS[o.preset].short,
    LEVEL_RULES[o.levelRule].short,
    pick ? `pick ${pick} of ${o.teamSize}` : `${o.teamSize} vs ${o.teamSize}`,
    o.timer ? `${o.timer} s timer` : "no timer",
  ].filter(Boolean).join(" · ");
}

/** Human-readable list of the clauses in force (for the challenge card). */
export const ruleLabels = (o) => ruleKeys(o).filter((k) => k !== "desync").map((k) => RULES[k].label);
