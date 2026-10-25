/* shared/battle/ai.js: the greedy practice opponent. It must only make legal choices, beat random
   play clearly, and depend on nothing but its own request and its own channel's state. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dex } from "@pkmn/sim";
import { BattleRoom } from "../server/battle-room.js";
import { ensureFormat, prepareTeam, randomTeam } from "../server/battle-sim.js";
import { BattleState } from "../shared/battle/state.js";
import { chooseGreedy, scoreMove, lookupMove } from "../shared/battle/ai.js";
import { normalizeOptions } from "../shared/battle/formats.js";

const tick = () => new Promise((r) => setImmediate(r));

function lcg(seed) { let x = seed >>> 0; return () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 2 ** 32); }

function randomChoice(req, rnd) {
  if (req.teamPreview) return "default";
  if (req.forceSwitch) {
    const used = [];
    return req.forceSwitch.map((f) => {
      const free = req.side.pokemon.map((p, i) => (!p.active && !p.condition.endsWith(" fnt") && !used.includes(i + 1) ? i + 1 : 0)).filter(Boolean);
      if (!f || !free.length) return "pass";
      const s = free[Math.floor(rnd() * free.length)]; used.push(s); return `switch ${s}`;
    }).join(", ");
  }
  return req.active.map((a, i) => {
    if (req.side.pokemon[i]?.condition.endsWith(" fnt")) return "pass";
    const ok = a.moves.map((m, j) => (m.disabled || m.pp === 0 ? 0 : j + 1)).filter(Boolean);
    if (!ok.length) return "default";
    const n = ok[Math.floor(rnd() * ok.length)];
    const t = req.active.length > 1 && ["normal", "any", "adjacentFoe"].includes(a.moves[n - 1].target) ? ` ${1 + Math.floor(rnd() * 2)}` : "";
    return `move ${n}${t}`;
  }).join(", ");
}

/** Greedy (p1) vs random (p2) with the same team, through BattleRoom; returns { winner, aiErrors }. */
async function match(rawOptions, seed) {
  const options = normalizeOptions(rawOptions);
  const spec = ensureFormat(options);
  const state = new BattleState("p1");
  const rnd = lcg(seed);
  const aiErrors = [];
  const team = (s) => prepareTeam(randomTeam(options, [s, 7, 7, 7]), options).map((x) => ({ ...x, level: 50 }));
  const room = new BattleRoom({
    formatid: spec.id, seed: [seed, 1, 2, 3], timer: { turnSeconds: 0 },
    players: { p1: { name: "Greedy", team: team(seed) }, p2: { name: "Random", team: team(seed) } },   // mirror match
    send: (ch, lines) => { if (ch === "p1") for (const l of lines) { state.add(l); if (l.startsWith("|error|")) aiErrors.push(l); } },
  });
  for (let i = 0; i < 5000 && !room.ended; i++) {
    const a = room.requests.p1, b = room.requests.p2;
    if (a && !a.choice && !a.request.wait && state.request?.rqid === a.rqid) {
      const c = chooseGreedy(a.request, state, { dex: Dex.forGen(options.gen), random: rnd });
      assert.equal(room.choose("p1", c ?? "default", a.rqid), null, c);
    }
    if (b && !b.choice && !b.request.wait) room.choose("p2", randomChoice(b.request, rnd), b.rqid);
    await tick();
  }
  assert.ok(room.ended);
  return { winner: room.winner, aiErrors };
}

test("greedy beats random play and never makes an illegal choice (Gen 1-5, singles and doubles)", async (t) => {
  const formats = [
    { gen: 1, teamSize: 3 }, { gen: 2, teamSize: 3 }, { gen: 3, teamSize: 3 }, { gen: 4, teamSize: 3 }, { gen: 5, teamSize: 3 },
    { gen: 4, gameType: "doubles", teamSize: 4 }, { gen: 5, preset: "tower", teamSize: 6 },
  ];
  let wins = 0, games = 0;
  for (const f of formats) {
    let w = 0;
    for (let s = 1; s <= 10; s++) {
      const r = await match({ timer: 0, ...f }, s * 31 + f.gen);
      assert.deepEqual(r.aiErrors, [], `illegal AI choice in ${JSON.stringify(f)}`);
      if (r.winner === "p1") w++;
    }
    t.diagnostic(`${JSON.stringify(f)}: greedy won ${w}/10`);
    assert.ok(w >= 5, `greedy won only ${w}/10 in ${JSON.stringify(f)}`);
    wins += w; games += 10;
  }
  // Random Battle sets are full of Rest, Explosion and setup moves, so random play is not hopeless:
  // greedy wins about 75-85 % of mirror matches here (90 %+ with plain attacking sets).
  assert.ok(wins / games >= 0.7, `greedy won ${wins}/${games}`);
});

test("scoring uses the generation's own type chart, STAB and the request's move names", () => {
  const g1 = Dex.forGen(1), g2 = Dex.forGen(2), g5 = Dex.forGen(5);
  const gengar = { details: "Gengar, L50", stats: { atk: 100, spa: 150 } };
  assert.equal(scoreMove(g1, g1.moves.get("lick"), gengar, g1.species.get("Alakazam")), 0, "Gen 1: Ghost does nothing to Psychic");
  assert.ok(scoreMove(g2, g2.moves.get("lick"), gengar, g2.species.get("Alakazam")) > 0, "fixed in Gen 2");
  assert.equal(scoreMove(g5, g5.moves.get("earthquake"), gengar, g5.species.get("Zapdos")), 0, "Ground vs Flying");
  const pika = { details: "Pikachu, L50", stats: { atk: 100, spa: 100 } };
  assert.ok(scoreMove(g5, g5.moves.get("thunderbolt"), pika, null) > scoreMove(g5, g5.moves.get("flamethrower"), pika, null), "STAB");
  assert.equal(lookupMove(g5, { move: "Return 102", id: "return" }).id, "return");
  assert.equal(lookupMove(g5, { move: "Hidden Power Fire 60", id: "hiddenpower" }).type, "Fire");
  assert.equal(lookupMove(g5, "return102").id, "return");
  assert.equal(lookupMove(g5, "hiddenpowerice60").type, "Ice");
});

test("requests: wait, team preview, forced switch, doubles targets", () => {
  const dex = Dex.forGen(4);
  const st = new BattleState("p2");
  for (const l of ["|player|p1|A|", "|player|p2|B|", "|gen|4", "|switch|p1a: Golem|Golem, L50, M|100/100", "|switch|p1b: Gyarados|Gyarados, L50, F|100/100"]) st.add(l);
  assert.equal(chooseGreedy({ wait: true }, st, { dex }), null);
  assert.equal(chooseGreedy({ teamPreview: true, side: { id: "p2", pokemon: [] } }, st, { dex }), "default");
  const mon = (ident, details, condition, active, moves, stats = { atk: 100, spa: 100 }) => ({ ident, details, condition, active, moves, stats });
  const side = { id: "p2", pokemon: [
    mon("p2: Pikachu", "Pikachu, L50", "0 fnt", true, ["thunderbolt"]),
    mon("p2: Venusaur", "Venusaur, L50", "120/150", true, ["energyball", "sleeppowder"]),
    mon("p2: Raichu", "Raichu, L50", "10/120", false, ["thunderbolt"]),
    mon("p2: Vaporeon", "Vaporeon, L50", "200/200", false, ["surf"]),
  ] };
  // forced switch: the healthy Vaporeon (Surf hits Golem 4x) over the nearly fainted Raichu
  assert.equal(chooseGreedy({ forceSwitch: [true, false], side }, st, { dex, random: () => 0.5 }), "switch 4, pass");
  // doubles: Venusaur aims Energy Ball at Golem (4x), the fainted slot passes
  const req = { side, active: [
    { moves: [{ move: "Thunderbolt", id: "thunderbolt", pp: 24, maxpp: 24, target: "normal" }] },
    { moves: [{ move: "Energy Ball", id: "energyball", pp: 16, maxpp: 16, target: "normal" }, { move: "Sleep Powder", id: "sleeppowder", pp: 24, maxpp: 24, target: "normal" }] },
  ] };
  assert.equal(chooseGreedy(req, st, { dex, random: () => 0.5 }), "pass, move 1 1");
  // same inputs, same answer: nothing but (request, own state, random) goes in
  assert.equal(chooseGreedy(req, st, { dex, random: () => 0.5 }), chooseGreedy(structuredClone(req), st, { dex, random: () => 0.5 }));
});
