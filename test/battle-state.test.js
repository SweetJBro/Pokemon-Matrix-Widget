/* shared/battle/state.js (the protocol tracker) and shared/battle/formats.js against real battles.

   Battles run in-process through server/battle-room.js with both sides played by bots; every
   channel the room sends is fed to its own BattleState. The sim's own Battle object is the truth:
   who fainted, who won, each player's exact HP. Teams include two un-nicknamed Pidgey (same name
   in the protocol) and doubles / Team Preview formats, the cases the identity rules exist for. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Dex } from "@pkmn/sim";
import { BattleRoom } from "../server/battle-room.js";
import { ensureFormat, prepareTeam, randomTeam } from "../server/battle-sim.js";
import { BattleState, parseIdent, parseDetails, parseHP, parseLine } from "../shared/battle/state.js";
import { chooseGreedy } from "../shared/battle/ai.js";
import { normalizeOptions, formatSpec, describeOptions, OptionError, PRESETS } from "../shared/battle/formats.js";

const tick = () => new Promise((r) => setImmediate(r));

/** Run a battle to the end; both sides answered by `pick(side, request, state)`. */
async function play(options, teams, { pick, seed = [1, 2, 3, 4], maxSteps = 4000, raw = false } = {}) {
  const spec = ensureFormat(options);
  const states = { p1: new BattleState("p1"), p2: new BattleState("p2"), spectator: new BattleState(null) };
  const sent = { p1: [], p2: [], spectator: [] };
  const errors = [];
  const room = new BattleRoom({
    formatid: spec.id, seed, timer: { turnSeconds: 0 },
    players: { p1: { name: "Alice", team: raw ? teams.p1 : prepareTeam(teams.p1, options) }, p2: { name: "Bob", team: raw ? teams.p2 : prepareTeam(teams.p2, options) } },
    send: (ch, lines) => { sent[ch].push(...lines); for (const l of lines) { states[ch].add(l); if (l.startsWith("|error|")) errors.push(`${ch} ${l}`); } },
  });
  for (let i = 0; i < maxSteps && !room.ended; i++) {
    for (const side of ["p1", "p2"]) {
      const r = room.requests[side];
      if (r && !r.choice && !r.request.wait && states[side].request?.rqid === r.rqid) {
        const err = room.choose(side, pick(side, r.request, states[side]) ?? "default", r.rqid);
        assert.equal(err, null, `${side} choice refused: ${err}`);
      }
    }
    await tick();
  }
  await tick();
  assert.ok(room.ended, "battle finished");
  return { room, states, sent, errors, battle: room.battle };
}

const randomPick = (seed) => {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return (side, req) => {
    if (req.teamPreview) return "default";
    if (req.forceSwitch) {
      const free = req.side.pokemon.map((p, i) => (!p.active && !p.condition.endsWith(" fnt") ? i + 1 : 0)).filter(Boolean);
      const used = [];
      return req.forceSwitch.map((f) => { if (!f) return "pass"; const s = free.find((n) => !used.includes(n)); if (!s) return "pass"; used.push(s); return `switch ${s}`; }).join(", ");
    }
    const bench = req.side.pokemon.map((p, i) => (!p.active && !p.condition.endsWith(" fnt") ? i + 1 : 0)).filter(Boolean);
    if (req.active.length === 1 && !req.active[0].trapped && !req.active[0].maybeTrapped && bench.length && rnd() < 0.3)
      return `switch ${bench[Math.floor(rnd() * bench.length)]}`;   // switch out voluntarily now and then
    return req.active.map((a, i) => {
      if (req.side.pokemon[i]?.condition.endsWith(" fnt")) return "pass";
      const ok = a.moves.map((m, j) => (m.disabled || m.pp === 0 ? 0 : j + 1)).filter(Boolean);
      if (!ok.length) return "default";
      const n = ok[Math.floor(rnd() * ok.length)];
      const m = a.moves[n - 1];
      const needsTarget = req.active.length > 1 && ["normal", "any", "adjacentFoe"].includes(m.target);
      return `move ${n}${needsTarget ? ` ${1 + Math.floor(rnd() * 2)}` : ""}`;
    }).join(", ");
  };
};

const greedy = (gen) => (side, req, state) => chooseGreedy(req, state, { dex: Dex.forGen(gen), random: () => 0.5 });

/** The sim's truth vs each tracker: per side, the HP of every Pokémon that was ever sent out
    (exact on the player's own channel, percent/pixels within rounding elsewhere), fainted counts, winner. */
function checkAgainstSim({ states, battle }, label) {
  for (const [ch, st] of Object.entries(states)) {
    assert.equal(st.ended, true, `${label} ${ch} ended`);
    assert.equal(st.winner, battle.winner || null, `${label} ${ch} winner`);
    for (const [i, side] of battle.sides.entries()) {
      const id = `p${i + 1}`;
      const out = side.pokemon.filter((p) => p.previouslySwitchedIn > 0 || p.isActive);
      const seen = st.sides[id].team.filter((m) => !m.placeholder);
      assert.equal(seen.length, out.length, `${label} ${ch} ${id}: Pokémon seen ${seen.map((m) => m.details)} vs ${out.map((p) => p.details)}`);
      assert.equal(seen.filter((m) => m.fainted).length, side.pokemon.filter((p) => p.fainted).length, `${label} ${ch} ${id}: fainted`);
      const exact = ch === id;
      const truth = out.map((p) => (exact ? p.hp : (100 * p.hp) / p.maxhp)).sort((a, b) => a - b);
      const mine = seen.map((m) => (exact ? m.hp : (100 * m.hp) / (m.maxhp || 1))).sort((a, b) => a - b);
      truth.forEach((v, k) => {
        if (exact) assert.equal(mine[k], v, `${label} ${ch} ${id}: exact HP`);
        else assert.ok(Math.abs(mine[k] - v) <= 3, `${label} ${ch} ${id}: HP ${mine[k]} vs ${v}`);
      });
      // and the active slots hold the right Pokémon
      side.active.forEach((p, slot) => {
        if (!p || p.fainted) return;
        const m = st.sides[id].active[slot];
        assert.ok(m && m.species.replace(/-.*$/, "") === p.species.baseSpecies, `${label} ${ch} ${id} slot ${slot}: ${m?.species} vs ${p.species.name}`);
        if (exact) assert.equal(m.hp, p.hp, `${label} ${ch} ${id} slot ${slot} HP`);
      });
    }
  }
}

const set = (species, moves, extra = {}) => ({ species, moves, level: 50, ...extra });

test("parsers", () => {
  assert.deepEqual(parseIdent("p2a: GARDY"), { side: "p2", slot: 0, name: "GARDY" });
  assert.deepEqual(parseIdent("p1b: Mr. Mime"), { side: "p1", slot: 1, name: "Mr. Mime" });
  assert.deepEqual(parseIdent("p1: Mr. Mime"), { side: "p1", slot: null, name: "Mr. Mime" });
  assert.equal(parseIdent("garbage"), null);
  assert.deepEqual(parseDetails("Gardevoir, L52, F, shiny"), { species: "Gardevoir", level: 52, gender: "F", shiny: true });
  assert.deepEqual(parseDetails("Mewtwo"), { species: "Mewtwo", level: 100, gender: "", shiny: false });
  assert.deepEqual(parseHP("87/100 par"), { hp: 87, maxhp: 100, status: "par", fainted: false });
  assert.deepEqual(parseHP("24/48g"), { hp: 24, maxhp: 48, status: "", fainted: false });
  assert.equal(parseHP("0 fnt").fainted, true);
  assert.deepEqual(parseLine("|-heal|p1a: X|50/100|[from] item: Leftovers"), { cmd: "-heal", args: ["p1a: X", "50/100"], kw: { from: "item: Leftovers" } });
  assert.deepEqual(parseLine("|error|[Invalid choice] Can't move"), { cmd: "error", args: ["[Invalid choice] Can't move"], kw: {} });
});

test("tracker: request lines, sentchoice, errors, log text by perspective", () => {
  const st = new BattleState("p1");
  for (const l of ["|player|p1|Alice|", "|player|p2|Bob|", "|gen|3", "|start",
    "|switch|p1a: Zap|Pikachu, L50, M|100/110", "|switch|p2a: Rock|Geodude, L50, F|100/100", "|turn|1",
    "|move|p2a: Rock|Tackle|p1a: Zap", "|-damage|p1a: Zap|55/110", "|-status|p1a: Zap|par",
    "|-sidestart|p2: Bob|move: Spikes", "|-sidestart|p2: Bob|Spikes", "|-weather|Sandstorm", "|-weather|Sandstorm|[upkeep]"]) st.add(l);
  st.add('|request|{"rqid":4,"active":[{"moves":[{"move":"A|B","id":"x"}]}],"side":{"id":"p1","pokemon":[]}}');
  assert.equal(st.request.rqid, 4);
  assert.equal(st.request.active[0].moves[0].move, "A|B", "request JSON is never split on |");
  st.add("|sentchoice|move 1");
  assert.equal(st.sentChoice, "move 1");
  st.add("|error|[Invalid choice] Can't move: no such move");
  assert.equal(st.sentChoice, "");
  assert.equal(st.errors.length, 1);
  const zap = st.sides.p1.active[0];
  assert.equal(zap.hp, 55); assert.equal(zap.maxhp, 110); assert.equal(zap.status, "par");
  assert.equal(st.sides.p2.conditions.get("Spikes"), 2);
  assert.equal(st.weather, "Sandstorm");
  const text = st.textLog.map((e) => e.text);
  assert.ok(text.includes("The opposing Rock used Tackle!"));
  assert.ok(text.includes("Zap lost 41% of its health."));
  const spec = new BattleState(null);
  spec.add("|player|p1|Alice|"); spec.add("|switch|p1a: Zap|Pikachu, L50|100/100"); spec.add("|move|p1a: Zap|Thunder Shock|");
  assert.ok(spec.textLog.some((e) => e.text === "Alice's Zap used Thunder Shock!"));
});

test("Gen 1 singles with duplicate names: every channel agrees with the sim", async () => {
  const opts = { gen: 1, preset: "cartridge", teamSize: 4, timer: 0 };
  const teams = {
    p1: [set("Pidgey", ["tackle", "gust"]), set("Pidgey", ["quickattack", "sandattack"], { level: 48 }), set("Starmie", ["surf", "recover"]), set("Snorlax", ["bodyslam"])],
    p2: [set("Pidgey", ["tackle"]), set("Rattata", ["tackle", "hyperfang"]), set("Pidgey", ["gust"]), set("Gengar", ["nightshade", "hypnosis"])],
  };
  // raw: skip prepareTeam (which would rename the second one "Pidgey 2") so the protocol really says "p1a: Pidgey" twice
  let seen = 0;
  for (const seed of [7, 8, 9, 10, 11, 12, 13, 14]) {
    const r = await play(opts, teams, { pick: randomPick(seed), seed: [seed, 1, 1, 1], raw: true });
    assert.deepEqual(r.errors, []);
    checkAgainstSim(r, `gen1 seed ${seed}`);
    for (const side of ["p1", "p2"]) {
      const pidgeys = r.states.spectator.sides[side].team.filter((m) => m.species === "Pidgey");
      assert.ok(pidgeys.length <= 2, "never more Pidgey than the team has");
      if (pidgeys.length === 2) seen++;
    }
  }
  assert.ok(seen > 0, "some battle sent out both Pidgey");
});

test("hidden information: spectators and the foe never see exact HP or requests", async () => {
  const opts = { gen: 3, preset: "smogon", teamSize: 3, timer: 0 };
  const r = await play(opts, { p1: randomTeam(opts, [1, 1, 1, 1]), p2: randomTeam(opts, [2, 2, 2, 2]) }, { pick: greedy(3) });
  const hpOf = (l) => { const m = /^\|(?:switch|drag|-damage|-heal|-sethp)\|(p[12])[ab]?: [^|]*\|(?:[^|]*\|)?(\d+)\/(\d+)/.exec(l); return m && { side: m[1], max: +m[3] }; };
  for (const [ch, lines] of Object.entries(r.sent)) {
    assert.ok(!lines.some((l) => l.startsWith("|split|")), `${ch}: no split markers`);
    for (const l of lines) {
      const hp = hpOf(l);
      if (hp && hp.side !== ch) assert.equal(hp.max, 100, `${ch} saw exact HP: ${l}`);
      if (l.startsWith("|request|")) assert.equal(JSON.parse(l.slice(9)).side.id, ch, `${ch} got another side's request`);
    }
  }
  assert.ok(r.sent.p1.some((l) => hpOf(l)?.side === "p1" && hpOf(l).max !== 100), "own channel has exact HP");
  checkAgainstSim(r, "gen3");
});

test("Gen 3 and Gen 5 doubles, Gen 5 Team Preview with pick 4: trackers match the sim", async () => {
  for (const [opts, seed] of [
    [{ gen: 3, preset: "smogon", gameType: "doubles", teamSize: 4, timer: 0 }, 11],
    [{ gen: 5, preset: "tower", teamSize: 6, timer: 0 }, 12],
    [{ gen: 4, preset: "cartridge", gameType: "doubles", teamSize: 3, levelRule: "cap100", timer: 0 }, 13],
  ]) {
    const teams = { p1: randomTeam(opts, [seed, 1, 2, 3]), p2: randomTeam(opts, [seed, 4, 5, 6]) };
    if (opts.gen === 3) teams.p1[1] = { ...teams.p1[0], name: "" }, teams.p1[1].species = teams.p1[0].species === "Pidgey" ? "Rattata" : "Pidgey", teams.p1[1].moves = ["tackle"], teams.p1[1].item = "", teams.p1[1].ability = "";
    const r = await play(normalizeOptions(opts), teams, { pick: seed % 2 ? greedy(opts.gen) : randomPick(seed) });
    assert.deepEqual(r.errors, [], formatSpec(normalizeOptions(opts)).name);
    checkAgainstSim(r, formatSpec(normalizeOptions(opts)).name);
    if (opts.preset === "tower") {
      assert.ok(r.sent.spectator.some((l) => l.startsWith("|poke|")), "team preview shown");
      assert.ok(r.sent.spectator.some((l) => l === "|teamsize|p1|4"), "picked 4");
    }
    if (opts.levelRule === "cap100") assert.ok(r.sent.spectator.filter((l) => l.startsWith("|switch|")).every((l) => !/, L\d+/.test(l)), "everyone at level 100");
  }
});

test("a late spectator replaying the log ends in the same state as a live one", async () => {
  const opts = { gen: 2, preset: "smogon", teamSize: 3, timer: 0 };
  const r = await play(opts, { p1: randomTeam(opts, [3, 3, 3, 3]), p2: randomTeam(opts, [4, 4, 4, 4]) }, { pick: randomPick(3) });
  const late = new BattleState(null);
  for (const l of r.room.snapshot("spectator").lines) late.add(l);
  assert.equal(late.winner, r.states.spectator.winner);
  assert.equal(late.turn, r.states.spectator.turn);
  assert.deepEqual(late.textLog, r.states.spectator.textLog);
});

test("formats: options are validated and map to stable format ids", () => {
  const o = normalizeOptions({ gen: 3, preset: "tower" });
  assert.deepEqual(o, { gen: 3, gameType: "doubles", preset: "tower", levelRule: "cap50", teamSize: 6, timer: 90 });
  const spec = formatSpec(o);
  assert.equal(spec.name, "[Gen 3] W Dbl L50 6v4 ItmPrvSpc");
  assert.equal(spec.id, "gen3wdbll506v4itmprvspc");
  assert.equal(spec.pick, 4);
  assert.ok(spec.ruleset.includes("Picked Team Size = 4") && spec.ruleset.includes("Adjust Level Down = 50"));
  assert.equal(formatSpec(normalizeOptions({ gen: 1 })).name, "[Gen 1] W 6v6 Dsc", "Gen 1 always gets the Desync Clause");
  assert.match(describeOptions(o), /Gen 3 · Doubles · Battle Tower · Lv 50 · pick 4 of 6 · 90 s timer/);
  for (const bad of [{ gen: 6 }, { gen: 2, gameType: "doubles" }, { preset: "tower", gen: 2 }, { preset: "nope" }, { preset: "__proto__" },
    { teamSize: 7 }, { timer: -1 }, { timer: 601 }, { levelRule: "cap75" }, { gen: "3; drop" }, null])
    assert.throws(() => normalizeOptions(bad), OptionError, JSON.stringify(bad));
  // every option combination gives a distinct, short-enough name
  const names = new Set();
  for (const gen of [1, 2, 3, 4, 5]) for (const preset of Object.keys(PRESETS)) for (const gameType of ["singles", "doubles"])
    for (const levelRule of ["asis", "cap50", "cap100"]) for (const teamSize of [1, 2, 3, 4, 5, 6]) {
      let n; try { n = normalizeOptions({ gen, preset, gameType, levelRule, teamSize }); } catch { continue; }
      const s = formatSpec(n);
      assert.ok(s.name.length <= 50);
      assert.ok(!names.has(s.id), s.name);
      names.add(s.id);
    }
  assert.ok(names.size > 300);
});
