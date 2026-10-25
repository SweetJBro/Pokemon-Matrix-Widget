/* The practice opponent: a greedy, one-turn-lookahead player that cannot cheat.

   It sees exactly what a human in its seat sees: its own |request| (its team, moves, PP, stats)
   and a BattleState fed with its own channel (the foe's visible species, HP and status). No logs
   of the other side, no RNG peeking. Scoring (docs/research/battle-engine.md §4.2): base power
   (fixed damage ~60, OHKO 25) x type effectiveness / immunity against the visible foe x STAB 1.5
   x the attacker's Atk or SpA / 100 x its stat stage x accuracy, recharge and charge moves x 0.6,
   +-10 % noise; status moves score by what they would do now (see scoreMove); the best
   (move, target) per active slot. On a forced switch it sends the healthiest bench Pokémon with
   the best move against the current foe; it switches voluntarily only when its active Pokémon
   can do almost nothing and a bench Pokémon could do far more. Team Preview: default order.

   The game data comes in as `dex`, an object with the shape of @pkmn/sim's Dex.forGen(gen)
   (moves.get, species.get, getImmunity, getEffectiveness), so this module stays
   dependency-free: the server passes the sim's own per-generation Dex, which is also what
   decides physical vs special by type in Gen 1-3. */

// Doubles: only these move targets take a target slot. A move locked in by Outrage, Rollout or a
// charge turn comes back without a target field and must be chosen without one.
export const FOE_TARGETS = new Set(["normal", "any", "adjacentFoe"]);

const hpFrac = (cond = "") => {
  if (cond.endsWith(" fnt") || cond.startsWith("0")) return 0;
  const [a, b] = cond.split(" ")[0].split("/").map(Number);
  return b ? a / b : 0;
};

/** A request move ({ move: "Return 102", id }) or a team move id ("return102", "hiddenpowerfire60"):
    request names and ids carry the power of Return, Frustration and Hidden Power -> a Dex move. */
export function lookupMove(dex, m) {
  const name = String(typeof m === "string" ? m : m.move);
  if (/^Hidden Power /.test(name)) return dex.moves.get(name.replace(/ \d+$/, ""));
  const first = dex.moves.get(typeof m === "string" ? name : m.id);
  return first?.exists ? first : dex.moves.get(name.replace(/ ?\d+$/, ""));
}

const HEALS = new Set(["recover", "softboiled", "milkdrink", "slackoff", "roost", "rest", "synthesis", "morningsun", "moonlight", "healorder", "wish"]);
const STATUS_VALUE = { slp: 55, par: 40, tox: 40, brn: 35, psn: 30, frz: 50 };

/**
 * Expected value of `move` used by `me` (a request side.pokemon entry) against `foe` (Dex species or
 * null). ctx (all optional, from what the player can see): { hp: own HP fraction, foeStatus,
 * foeVolatiles: Set, boosts: own stat stages }. Status moves are worth something only when they
 * do something: put a status on a foe that has none, heal when hurt, boost when healthy.
 */
export function scoreMove(dex, move, me, foe, ctx = {}) {
  if (!move?.exists) return 0;
  const hp = ctx.hp ?? 1;
  if (move.category === "Status") {
    if (HEALS.has(move.id) || move.heal) return hp < 0.35 ? (move.id === "rest" ? 55 : 75) : hp < 0.6 ? 25 : 2;
    if (move.status) {
      if (!foe?.exists || ctx.foeStatus) return 1;
      if (!dex.getImmunity(move.type, foe.types) || !dex.getImmunity(move.status, foe.types)) return 0;
      return (STATUS_VALUE[move.status] ?? 20) * (move.accuracy === true ? 1 : (move.accuracy || 100) / 100);
    }
    if (move.volatileStatus === "confusion") return foe?.exists && !ctx.foeVolatiles?.has("confusion") ? 20 * ((move.accuracy || 100) / 100) : 1;
    if (move.boosts && move.target === "self") {
      const gain = Object.entries(move.boosts).reduce((sum, [k, v]) => sum + (v > 0 && (ctx.boosts?.[k] ?? 0) < 2 ? v : 0), 0);
      return hp > 0.7 ? 18 * gain : 2;
    }
    return 5;
  }
  if (move.ohko) return 25;
  let s = move.basePower || (move.damage ? 60 : 40);
  if (move.multihit) s *= Array.isArray(move.multihit) ? 3 : move.multihit;
  if (move.flags?.recharge || move.self?.volatileStatus === "mustrecharge") s *= 0.6;
  if (move.flags?.charge) s *= 0.6;   // Solar Beam, Sky Attack, Razor Wind: a turn of nothing first
  if (move.selfdestruct) s *= hp < 0.3 ? 1 : 0.25;   // Explosion only as a last act
  if (foe?.exists) {
    if (!dex.getImmunity(move.type, foe.types)) return 0;
    s *= 2 ** dex.getEffectiveness(move.type, foe.types);
  }
  const mine = dex.species.get(String(me.details).split(", ")[0]);
  if (mine.exists && mine.types.includes(move.type)) s *= 1.5;
  const stats = me.stats ?? {};
  const physical = move.category === "Physical";
  s *= ((physical ? stats.atk : stats.spa) || 100) / 100;
  const stage = ctx.boosts?.[physical ? "atk" : "spa"] ?? 0;
  s *= stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  if (move.accuracy !== true) s *= (move.accuracy || 100) / 100;
  return s;
}

const bench = (req, taken) => req.side.pokemon
  .map((p, i) => ({ p, slot: i + 1 }))
  .filter(({ p, slot }) => !p.active && hpFrac(p.condition) > 0 && !taken.includes(slot));

function bestBench(dex, options, foe) {
  let best = null, bestScore = -1;
  for (const o of options) {
    const sc = Math.max(0, ...o.p.moves.map((id) => scoreMove(dex, lookupMove(dex, id), o.p, foe))) * (0.25 + hpFrac(o.p.condition));
    if (sc > bestScore) { best = o; bestScore = sc; }
  }
  return { best, score: bestScore };
}

/**
 * request: this side's |request| JSON; state: a BattleState fed with this side's channel.
 * Returns a choice string ("move 2", "move 1 2, switch 4", "team 123456" ...) or null when waiting.
 */
export function chooseGreedy(request, state, { dex, random = Math.random } = {}) {
  if (!request || request.wait) return null;
  if (request.teamPreview) return "default";
  const foeSide = request.side.id === "p1" ? "p2" : "p1";
  const foes = (state.sides[foeSide]?.active ?? []).map((m) => (m && !m.fainted ? dex.species.get(m.transformed || m.species) : null));
  const anyFoe = foes.find(Boolean) ?? null;
  const taken = [];
  if (request.forceSwitch) {
    return request.forceSwitch.map((must) => {
      if (!must) return "pass";
      const { best } = bestBench(dex, bench(request, taken), anyFoe);
      if (!best) return "pass";
      taken.push(best.slot);
      return `switch ${best.slot}`;
    }).join(", ");
  }
  const doubles = request.active.length > 1;
  return request.active.map((act, i) => {
    const mon = request.side.pokemon[i];
    if (!mon || hpFrac(mon.condition) === 0 || mon.commanding) return "pass";
    const own = state.sides[request.side.id]?.active[i];
    let best = null, bestScore = -1;
    act.moves.forEach((m, j) => {
      if (m.disabled || (m.pp === 0 && act.moves.some((x) => x.pp > 0 && !x.disabled))) return;
      if (m.target === "adjacentAlly") return;
      const move = lookupMove(dex, m);
      const targets = doubles && FOE_TARGETS.has(m.target) ? [1, 2] : [null];
      for (const t of targets) {
        const foe = t ? foes[t - 1] : anyFoe;
        if (t && !foe) continue;
        const seen = state.sides[foeSide]?.active[t ? t - 1 : foes.indexOf(anyFoe)];
        const ctx = { hp: hpFrac(mon.condition), boosts: own?.boosts, foeStatus: seen?.status, foeVolatiles: seen?.volatiles };
        const sc = scoreMove(dex, move, mon, foe, ctx) * (0.9 + 0.2 * random());
        if (sc > bestScore) { bestScore = sc; best = `move ${j + 1}${t ? ` ${t}` : ""}`; }
      }
    });
    // A Pokémon that can barely scratch the foe (immune, walled) makes way for a much better one.
    if (!doubles && !act.trapped && !act.maybeTrapped && bestScore < 15 && anyFoe) {
      const sw = bestBench(dex, bench(request, taken), anyFoe);
      if (sw.best && sw.score > 3 * Math.max(bestScore, 5)) { taken.push(sw.best.slot); return `switch ${sw.best.slot}`; }
    }
    return best ?? "default";
  }).join(", ");
}
