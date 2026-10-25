/* Stat, Hidden Power, gender, shininess, Unown, Spinda and EXP formulas for Gen 1-5.

   Integer formulas exactly as the cartridges compute them (docs/research/data-and-transfers.md §4,
   from pokecrystal CalcMonStatC/HiddenPowerDamage/GetGender/CheckShininess/GetUnownLetter and
   pokeemerald CalculateMonStats/Cmd_hiddenpowercalc/GET_UNOWN_LETTER). Home records are box structs,
   whose stats the game recomputes on withdrawal, so these are also the stats a player will see.

   Gen 1/2 take DVs { atk, def, spe, spc } (0-15; the HP DV is always derived) and stat experience
   { hp, atk, def, spe, spc } (0-65535). Gen 3-5 take IVs/EVs { hp, atk, def, spa, spd, spe } and a
   nature index 0-24. PIDs are unsigned 32-bit numbers. */
import { baseStats, genderThreshold, basePP, expAtLevel, levelAtExp, HIDDEN_POWER_TYPES } from "../data/index.js";

export { levelAtExp, expAtLevel };

const STATS = ["hp", "atk", "def", "spa", "spd", "spe"];
const NATURE_ORDER = ["atk", "def", "spe", "spa", "spd"];   // raised = floor(n / 5), lowered = n % 5

/** Gen 1/2 HP DV: the low bits of Atk, Def, Spe, Spc. */
export const hpDV = (dvs) => ((dvs.atk & 1) << 3) | ((dvs.def & 1) << 2) | ((dvs.spe & 1) << 1) | (dvs.spc & 1);

/** Smallest n >= 0 with n * n >= x. */
function ceilSqrt(x) {
  let n = Math.floor(Math.sqrt(x));
  while (n * n < x) n++;
  while (n > 0 && (n - 1) * (n - 1) >= x) n--;
  return n;
}
/** Gen 1/2 stat-experience bonus: floor(min(255, ceilSqrt(statExp)) / 4). The cartridge's square-root loop
    stops at 255, so stat exp above 254^2 = 64516 always gives 255 (bonus 63). */
export const statExpBonus = (statExp) => Math.floor(Math.min(255, ceilSqrt(Math.max(0, statExp | 0))) / 4);

/** Nature 0-24 -> { atk, def, spe, spa, spd } multipliers in percent (110 / 100 / 90). */
export function natureModifiers(nature) {
  const m = { atk: 100, def: 100, spe: 100, spa: 100, spd: 100 };
  const up = Math.floor(nature / 5), down = nature % 5;
  if (up !== down) { m[NATURE_ORDER[up]] = 110; m[NATURE_ORDER[down]] = 90; }
  return m;
}

/** calcStats(gen, species, form, level, ivs | dvs, evs | statExp, nature) -> { hp, atk, def, spa, spd, spe }.
    Gen 1 returns the Special stat in both spa and spd. Returns null for a species that is not in the gen. */
export function calcStats(gen, species, form, level, ivs, evs, nature = 0) {
  const base = baseStats(gen, species, form ?? 0);
  if (!base) return null;
  const L = level | 0;
  const out = {};
  if (gen <= 2) {
    const dv = { hp: hpDV(ivs), atk: ivs.atk, def: ivs.def, spe: ivs.spe, spa: ivs.spc, spd: ivs.spc };
    const se = evs ?? {};
    const exp = { hp: se.hp, atk: se.atk, def: se.def, spe: se.spe, spa: se.spc, spd: se.spc };
    for (const s of STATS) {
      const core = Math.floor(((base[s] + (dv[s] & 15)) * 2 + statExpBonus(exp[s] ?? 0)) * L / 100);
      out[s] = Math.min(999, s === "hp" ? core + L + 10 : core + 5);
    }
    return out;
  }
  const mod = natureModifiers(nature);
  for (const s of STATS) {
    const core = Math.floor((2 * base[s] + (ivs[s] ?? 0) + Math.floor((evs?.[s] ?? 0) / 4)) * L / 100);
    out[s] = s === "hp" ? core + L + 10 : Math.floor((core + 5) * mod[s] / 100);
  }
  if (species === 292) out.hp = 1;   // Shedinja
  return out;
}

/** hiddenPower(gen, ivs | dvs) -> { type, power }. Gen 1/2 use DVs (the Gen 2 rule; Gen 1 has no Hidden Power but the
    same DVs decide it once the Pokémon reaches Gen 2); Gen 3-5 use IVs (power 30-70; Gen 6+ fixes it at 60). */
export function hiddenPower(gen, iv) {
  if (gen <= 2) {
    const type = HIDDEN_POWER_TYPES[4 * (iv.atk & 3) + (iv.def & 3)];
    const x = (iv.atk >= 8 ? 8 : 0) + (iv.def >= 8 ? 4 : 0) + (iv.spe >= 8 ? 2 : 0) + (iv.spc >= 8 ? 1 : 0);
    return { type, power: Math.floor((5 * x + (iv.spc & 3)) / 2) + 31 };
  }
  const order = ["hp", "atk", "def", "spe", "spa", "spd"];
  let t = 0, p = 0;
  order.forEach((s, i) => { t += (iv[s] & 1) << i; p += ((iv[s] >> 1) & 1) << i; });
  return { type: HIDDEN_POWER_TYPES[Math.floor(15 * t / 63)], power: Math.floor(40 * p / 63) + 30 };
}

/** Gen 2 gender from the Attack DV: female iff (atk << 4 | spe) <= ratio, i.e. atk <= ratio >> 4.
    -> "M" | "F" | null (genderless). Also how Gen 2 and Virtual Console read Gen 1 Pokémon. */
export function gen2Gender(species, atkDV) {
  const r = genderThreshold(species);
  if (r === 255) return null;
  if (r === 0) return "M";
  if (r === 254) return "F";
  return (atkDV & 15) <= r >> 4 ? "F" : "M";
}
/** Gen 2 shininess: Def = Spe = Spc = 10 and Atk in {2, 3, 6, 7, 10, 11, 14, 15}. */
export const gen2Shiny = (dvs) => dvs.def === 10 && dvs.spe === 10 && dvs.spc === 10 && (dvs.atk & 2) !== 0;
/** Gen 2 Unown letter 0 (A) .. 25 (Z) from the middle two bits of each DV. */
export function unownLetterGen2(dvs) {
  const v = ((dvs.atk & 6) << 5) | ((dvs.def & 6) << 3) | ((dvs.spe & 6) << 1) | ((dvs.spc & 6) >> 1);
  return Math.floor(v / 10);
}

/** Gen 3-5 gender: female iff (pid & 0xFF) < ratio. -> "M" | "F" | null. Gen 4/5 also store it, and the two must agree. */
export function gen3Gender(species, pid) {
  const r = genderThreshold(species);
  if (r === 255) return null;
  if (r === 0) return "M";
  if (r === 254) return "F";
  return (pid & 0xff) < r ? "F" : "M";
}
/** Shiny value (TID ^ SID ^ PID high ^ PID low); Gen 3-5 shiny iff < 8 (Gen 6+ uses < 16). */
export const shinyValue = (pid, tid, sid) => ((tid ^ sid ^ (pid >>> 16) ^ (pid & 0xffff)) & 0xffff);
/** Gen 3-5 shininess. */
export const gen3Shiny = (pid, tid, sid) => shinyValue(pid, tid, sid) < 8;
/** Gen 3 Unown form 0-27 (26 = !, 27 = ?) from the low two bits of each PID byte; Gen 4/5 store it. */
export function unownFormGen3(pid) {
  const v = (((pid >>> 24) & 3) << 6) | (((pid >>> 16) & 3) << 4) | (((pid >>> 8) & 3) << 2) | (pid & 3);
  return v % 28;
}
/** Nature index from a PID (Gen 3/4; Gen 5 stores the nature byte, which Poké Transfer sets to this). */
export const natureFromPid = (pid) => (pid >>> 0) % 25;
/** Spinda's four spots: PID byte i (least significant first) -> { x: (b & 15) - 8, y: (b >> 4) - 8 } from each spot's base position. */
export const spindaSpots = (pid) => [0, 1, 2, 3].map((i) => { const b = (pid >>> (8 * i)) & 0xff; return { x: (b & 15) - 8, y: (b >> 4) - 8 }; });
/** Ability slot (0 = first, 1 = second) a game computes from the PID: Gen 3/4 bit 0; Gen 5 bit 16 for Gen 5 origins (game >= 20), bit 0 otherwise. */
export const abilitySlotFromPid = (pid, gen, originGame = 0) => (gen >= 5 && originGame >= 20 ? (pid >>> 16) & 1 : pid & 1);

/** Maximum PP with PP Ups: Gen 1/2 base + ups * min(7, floor(base / 5)) (6-bit field); Gen 3-5 base + floor(base * ups / 5). */
export function maxPP(gen, moveId, ppUps = 0) {
  const base = basePP(moveId, gen);
  const ups = Math.max(0, Math.min(3, ppUps | 0));
  return gen <= 2 ? base + ups * Math.min(7, Math.floor(base / 5)) : base + Math.floor(base * ups / 5);
}

/** Gen 1/2 Medium Slow level 1: the games evaluate the formula (-54) at run time and store it in 24 bits. */
export const GEN12_MEDIUM_SLOW_L1 = 0xffffca;
/** Minimum EXP for a level as that generation stores it: the shared tables, except Gen 1/2 Medium Slow level 1. */
export const expAtLevelForGen = (gen, rate, level) => (gen <= 2 && rate === 3 && level === 1 ? GEN12_MEDIUM_SLOW_L1 : expAtLevel(rate, level));
