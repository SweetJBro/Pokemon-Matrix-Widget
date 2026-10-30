/* server/battle-teams.js: real Pokémon as battle teams.

   1. For every non-Egg Pokémon in every fixture save, the simulator builds exactly the stats the
      record has (Gen 1/2 DVs and Stat Exp, Gen 3-5 IVs, EVs and nature), at its own generation.
   2. "home" and "party" team sources through the WebSocket, in a practice battle against the CPU. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Battle } from "@pkmn/sim";
import { toShowdownSet } from "../server/battle-teams.js";
import { ensureFormat, prepareTeam } from "../server/battle-sim.js";
import { openSave } from "../shared/saves/index.js";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { createApi, Socket, wsUrl } from "../web/js/api.js";
import { toBase64 } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "saves");
const loadSave = (n) => openSave(new Uint8Array(fs.readFileSync(path.join(dir, n))), n);
const SAVES = fs.readdirSync(dir).filter((n) => n.endsWith(".sav") && !n.includes("modified"));
const ROOM = "!teams:example.org";

/** Stats the sim gives a set, one Pokémon per battle (no clauses to trip over). */
function simStats(set, gen) {
  const options = { gen, preset: "cartridge", teamSize: 1, timer: 0, levelRule: "asis" };
  const spec = ensureFormat(options);
  const [s] = prepareTeam([set], options);
  const b = new Battle({ formatid: spec.id, seed: [1, 2, 3, 4] });
  b.setPlayer("p1", { team: [s] });
  b.setPlayer("p2", { team: [s] });
  const p = b.p1.pokemon[0];
  return { hp: p.maxhp, ...p.storedStats };
}

for (const name of SAVES) {
  test(`${name}: the simulator reproduces every Pokémon's stats`, async () => {
    const save = await loadSave(name);
    const all = [...save.party(), ...Array.from({ length: save.boxCount }, (_, b) => save.box(b)).flat()].filter((e) => e && !e.view.isEgg);
    let n = 0;
    for (const { view } of all.slice(0, 40)) {
      const { set } = toShowdownSet(view, view.gen);
      const got = simStats(set, view.gen);
      const want = view.stats;
      const keys = view.gen === 1 ? ["hp", "atk", "def", "spa", "spe"] : ["hp", "atk", "def", "spa", "spd", "spe"];
      for (const k of keys) assert.equal(got[k], want[k], `${name} ${view.speciesName} Lv${view.level} ${k}`);
      if (view.gen >= 3) assert.ok(set.ability, `${view.speciesName} has an ability`);
      n++;
    }
    assert.ok(n > 0);
  });
}

test("eras and Eggs are refused with readable reasons; Gen 3-4 Pokémon can battle in Gen 5", async () => {
  const em = await loadSave("emerald-en.sav");
  const kyogre = em.box(0).find((e) => e?.view.speciesName === "Kyogre").view;
  assert.throws(() => toShowdownSet(kyogre, 2), /Gen 1-2 and Gen 3-5/);
  assert.equal(toShowdownSet(kyogre, 5).set.species, "Kyogre");
  const egg = em.box(0).find((e) => e?.view.isEgg).view;
  assert.throws(() => toShowdownSet(egg, 3), /Eggs/);
  const bw = await loadSave("black-en.sav");
  const reshiram = bw.box(0).find((e) => e?.view.speciesName === "Reshiram").view;
  assert.throws(() => toShowdownSet(reshiram, 4), /Gen 5 Pokémon/);
  const cr = await loadSave("crystal-en.sav");
  const chikorita = cr.box(0).find((e) => e?.view.speciesName === "Chikorita").view;
  assert.equal(toShowdownSet(chikorita, 2).set.item, "Berry", "Gen 2-only items are matched by name");
});

/* ---------- through the server ---------- */

let app, base, token;
before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1" }));
  base = `http://127.0.0.1:${(await app.listen()).port}/`;
  token = (await createApi({ base, storage: null }).post("api/auth/dev", { userId: "@ash:example.org" }, { auth: false })).token;
});
after(() => app.close());

async function withSocket(fn) {
  const ws = new Socket({ url: wsUrl(base), getToken: () => token, pingIntervalMs: 0 });
  ws.connect();
  try { await ws.join(ROOM); return await fn(ws); } finally { ws.close(); }
}
const authed = (method, p, body) => fetch(base + p, { method, body: body && JSON.stringify(body), headers: { authorization: "Bearer " + token, "content-type": "application/json" } }).then((r) => r.json());

test("a practice battle with a team from Home, and one with a save's party", async () => {
  const save = await loadSave("crystal-en.sav");
  const picks = save.box(0).map((e, i) => [e, i]).filter(([e]) => e && !e.view.isEgg).slice(0, 3);
  const mons = picks.map(([e]) => ({ record: toBase64(e.record), meta: e.meta }));
  const dep = await authed("POST", "api/home/deposit", { mons });
  const monIds = dep.stored.map((s) => s.id);
  const options = { gen: 2, preset: "cartridge", teamSize: 3, timer: 0 };
  await withSocket(async (ws) => {
    const list = await ws.request("battle.list", { roomId: ROOM });
    assert.ok(list.sources.includes("home") && list.sources.includes("party"), "listed before anyone has battled");
    const { battle } = await ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options, team: { source: "home", monIds } });
    assert.equal(battle.practice, true);
    const snap = await ws.request("battle.join", { id: battle.id });
    const lines = snap.lines.join("\n");
    for (const [e] of picks) assert.match(lines, new RegExp(e.view.speciesName.replace(/\W/g, ".")), `${e.view.speciesName} is in the team`);
    await ws.request("battle.forfeit", { id: battle.id });

    const party = save.party().slice(0, 2).map((e) => ({ record: toBase64(e.record), meta: e.meta }));
    const r2 = await ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options: { ...options, teamSize: 2 }, team: { source: "party", records: party } });
    assert.equal(r2.battle.practice, true);
    await ws.request("battle.forfeit", { id: r2.battle.id });

    await assert.rejects(ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options: { ...options, gen: 3 }, team: { source: "home", monIds } }), /Gen 1-2 and Gen 3-5/);
    await assert.rejects(ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options, team: { source: "home", monIds: ["nope"] } }), /not in your Home/);
    const broken = { ...party[0], record: toBase64(new Uint8Array(55)) };
    await assert.rejects(ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options, team: { source: "party", records: [broken] } }));
  });
  const home = await authed("GET", "api/home");
  assert.equal(home.boxes[0].mons.length, 3, "battling changed nothing in Home");
});

test("exported Showdown text imports back as the same set (what Home's Export gives players)", async () => {
  const { Teams, Dex } = await import("@pkmn/sim");
  let n = 0;
  for (const f of ["red-en.sav", "crystal-en.sav", "emerald-en.sav", "platinum-en.sav", "black2-en.sav"]) {
    const save = await loadSave(f);
    for (const e of [...save.party(), ...save.box(0)].filter((x) => x && !x.view.isEgg)) {
      const { set } = toShowdownSet(e.view, e.view.gen);
      const dex = Dex.forGen(e.view.gen);
      const text = Teams.exportSet({ ...set, moves: set.moves.map((id) => dex.moves.get(id).name) });
      const back = Teams.import(text)[0];
      const pack = (x) => Teams.pack([{ ...x, moves: x.moves.map((m) => dex.moves.get(m).id) }]);
      assert.equal(pack(back), pack(set), `${f} ${e.view.speciesName}`);
      n++;
    }
  }
  assert.ok(n > 30);
});
