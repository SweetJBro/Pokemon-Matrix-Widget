/* server/battles.js end to end: a real createServer() (":memory:" DB, DEV_AUTH=1), dev sign-ins,
   one WebSocket per person through web/js/api.js's Socket, and battles played to the end with
   valid choices (the greedy AI picks them from each player's own request and channel).

   Hidden information is checked on what each socket actually received: the opponent and the
   spectator never get the other side's |request| (or anything carrying its idents "p1: X"), never
   exact HP of the other side's Pokémon, never |split| markers. Also: forfeit, the turn timer
   (auto-move twice, then a loss), choice validation, reconnect snapshots, practice vs CPU and a
   server restart that replays running battles from the database. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Dex } from "@pkmn/sim";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { createApi, Socket, wsUrl } from "../web/js/api.js";
import { BattleState } from "../shared/battle/state.js";
import { chooseGreedy } from "../shared/battle/ai.js";

const ROOM = "!battle:example.org";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, what = "condition") {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(10); }
  throw new Error(`timed out waiting for ${what}`);
}

let app, base;
const tokens = {};

async function startServer(env = {}) {
  const s = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1", ...env }));
  const a = await s.listen();
  return { s, base: `http://127.0.0.1:${a.port}/` };
}

async function signIn(b, who) {
  const api = createApi({ base: b, storage: null });
  const r = await api.post("api/auth/dev", { userId: `@${who}:example.org`, displayName: who[0].toUpperCase() + who.slice(1) }, { auth: false });
  return r.token;
}

/** One widget: a socket plus the battle views it has joined, replayed the way the browser does it. */
class Client {
  constructor(b, token, { play = true } = {}) {
    this.ws = new Socket({ url: wsUrl(b), getToken: () => token, pingIntervalMs: 0 });
    this.views = new Map();      // battle id -> { role, state, nextSeq, answered }
    this.joining = new Map();    // battle id -> pushes that arrived while battle.join was in flight
    this.received = new Map();   // battle id -> every line this socket got (pushes and snapshots)
    this.summaries = [];
    this.challenges = [];
    this.play = play;
    this.stopAt = new Map();     // battle id -> stop choosing from this turn on
    this.errors = [];
    this.ws.on("battle.log", (m) => this.#onLog(m));
    this.ws.on("battle", (m) => this.summaries.push(m.battle));
    this.ws.on("battle.challenge", (m) => this.challenges.push(m.challenge));
  }
  async open() { this.ws.connect(); await this.ws.join(ROOM); return this; }
  close() { this.ws.close(); }
  #got(id, lines) { if (!this.received.has(id)) this.received.set(id, []); this.received.get(id).push(...lines); }
  async join(id) {
    // Pushes can arrive before the reply's continuation runs (several frames in one chunk), so
    // they wait in a buffer and are replayed through the seq check after the snapshot.
    const pending = [];
    this.joining.set(id, pending);
    let r;
    try { r = await this.ws.request("battle.join", { id }); } finally { this.joining.delete(id); }
    this.#got(id, r.lines);
    const v = { id, role: r.role, state: new BattleState(r.role === "spectator" ? null : r.role), nextSeq: r.seq, answered: 0, battle: r.battle };
    for (const l of r.lines) v.state.add(l);
    this.views.set(id, v);
    for (const m of pending) this.#apply(v, m);
    this.#maybePlay(v);
    return v;
  }
  #onLog(m) {
    this.#got(m.id, m.lines);
    if (this.joining.has(m.id)) { this.joining.get(m.id).push(m); return; }
    const v = this.views.get(m.id);
    if (v) this.#apply(v, m);
  }
  #apply(v, m) {
    assert.equal(m.role, v.role, "pushes carry the receiver's own role");
    if (m.seq === null || m.seq === undefined) for (const l of m.lines) v.state.add(l);
    else {
      assert.ok(m.seq <= v.nextSeq, `gap in the log: ${m.seq} > ${v.nextSeq}`);
      for (const l of m.lines.slice(v.nextSeq - m.seq)) v.state.add(l);
      v.nextSeq = Math.max(v.nextSeq, m.seq + m.lines.length);
    }
    for (const l of m.lines) if (l.startsWith("|error|")) this.errors.push(l);
    this.#maybePlay(v);
  }
  #maybePlay(v) {
    const req = v.state.request;
    if (!this.play || v.role === "spectator" || !req || req.wait || v.state.sentChoice || v.answered === req.rqid || v.state.ended) return;
    if (v.state.turn >= (this.stopAt.get(v.id) ?? Infinity)) return;
    v.answered = req.rqid;
    const choice = chooseGreedy(req, v.state, { dex: Dex.forGen(v.state.gen || 5) }) ?? "default";
    this.ws.request("battle.choose", { id: v.id, choice, rqid: req.rqid }).catch((e) => this.errors.push(`choose: ${e.message}`));
  }
  view(id) { return this.views.get(id); }
  resume(id) { this.stopAt.delete(id); const v = this.views.get(id); if (v) this.#maybePlay(v); }
}

before(async () => {
  ({ s: app, base } = await startServer());
  for (const who of ["alice", "bob", "carol"]) tokens[who] = await signIn(base, who);
});
after(() => app.close());

async function trio(opts = {}) {
  const alice = await new Client(base, tokens.alice, opts.alice).open();
  const bob = await new Client(base, tokens.bob, opts.bob).open();
  const carol = await new Client(base, tokens.carol, { play: false }).open();
  return { alice, bob, carol, close: () => [alice, bob, carol].forEach((c) => c.close()) };
}

/** Alice challenges Bob, Bob accepts; everyone joins. Returns the battle id. */
async function startBattle({ alice, bob, carol }, options, teams = {}) {
  const { challenge } = await alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options, team: teams.alice });
  assert.equal(challenge.status, "pending");
  await until(() => bob.challenges.find((c) => c.id === challenge.id), 5000, "challenge push");
  const { battle } = await bob.ws.request("battle.accept", { id: challenge.id, team: teams.bob });
  assert.equal(battle.status, "active");
  await Promise.all([alice.join(battle.id), bob.join(battle.id), carol.join(battle.id)]);
  return battle.id;
}

/** What the opponent and a spectator received must not reveal the other side's secrets. */
function checkNoLeaks(c, id, otherSide, label) {
  const lines = c.received.get(id) ?? [];
  assert.ok(lines.length > 10, `${label}: got the battle`);
  for (const l of lines) {
    assert.ok(!l.startsWith("|split|"), `${label}: split marker`);
    if (l.startsWith("|request|")) {
      assert.notEqual(JSON.parse(l.slice(9)).side.id, otherSide, `${label}: got ${otherSide}'s request`);
      assert.ok(!l.includes(`"ident":"${otherSide}: `), `${label}: request mentions ${otherSide}'s team`);
    }
    const hp = new RegExp(`^\\|(?:switch|drag|replace|-damage|-heal|-sethp)\\|${otherSide}[ab]?: [^|]*\\|(?:[^|]*\\|)?\\d+\\/(\\d+)`).exec(l);
    if (hp) assert.ok(hp[1] === "100" || hp[1] === "48", `${label}: exact HP of ${otherSide}: ${l}`);
  }
}

async function playOut(clients, id, ms = 60000) {
  await until(() => clients.every((c) => c.view(id)?.state.ended), ms, "battle end");
  const winners = new Set(clients.map((c) => c.view(id).state.winner));
  assert.equal(winners.size, 1, "everyone saw the same result");
  for (const c of clients) assert.deepEqual(c.errors, [], "no refused choices");
  return [...winners][0];
}

test("Gen 1 (cartridge), Gen 3 (explicit sets) and Gen 5 (Smogon, team preview) singles, played to the end", async () => {
  const t = await trio();
  try {
    const dupes = [
      { species: "Pidgey", level: 30, moves: ["tackle", "gust", "quickattack"] },
      { species: "Pidgey", level: 30, moves: ["tackle", "sandattack"], gender: "F" },
      { species: "Swampert", name: "MUD|DY", level: 40, ability: "Torrent", nature: "Relaxed", item: "Leftovers", moves: ["surf", "earthquake"] },
    ];
    for (const [options, teams] of [
      [{ gen: 1, preset: "cartridge", teamSize: 6, timer: 0 }, {}],
      [{ gen: 3, preset: "cartridge", teamSize: 3, timer: 0 }, { alice: { source: "sets", sets: dupes }, bob: { source: "random" } }],
      [{ gen: 5, preset: "smogon", teamSize: 4, timer: 0 }, {}],
    ]) {
      const id = await startBattle(t, options, teams);
      const winner = await playOut([t.alice, t.bob, t.carol], id);
      assert.ok(["Alice", "Bob"].includes(winner));
      checkNoLeaks(t.bob, id, "p1", `gen${options.gen} Bob`);
      checkNoLeaks(t.alice, id, "p2", `gen${options.gen} Alice`);
      checkNoLeaks(t.carol, id, "p1", `gen${options.gen} Carol`);
      checkNoLeaks(t.carol, id, "p2", `gen${options.gen} Carol`);
      const st = t.alice.view(id).state;
      assert.equal(st.gen, options.gen);
      if (options.gen === 3) {
        assert.ok(st.sides.p1.team.some((m) => m.name === "Pidgey 2"), "duplicate names numbered");
        assert.ok(t.carol.received.get(id).every((l) => !l.includes("MUD|DY")), "nickname cleaned");
      }
      if (options.gen === 5) assert.ok(t.carol.received.get(id).some((l) => l.startsWith("|poke|p1|")), "team preview");
      // the room heard about it, and the result is stored
      await until(() => t.carol.summaries.find((b) => b.id === id && b.status === "done"), 5000, "done summary");
      const row = app.db.get("SELECT status, winner, log FROM battles WHERE id = ?", id);
      assert.equal(row.status, "done");
      assert.equal(row.winner, winner === "Alice" ? "@alice:example.org" : "@bob:example.org");
      assert.ok(JSON.parse(row.log).some((l) => l.startsWith("|win|")));
      assert.equal(app.db.get("SELECT count(*) AS n FROM battle_input WHERE battle_id = ?", id).n, 0);
    }
    assert.equal(app.db.get("SELECT count(*) AS n FROM home_mons").n, 0, "battles never touch stored Pokémon");
  } finally { t.close(); }
});

test("Gen 4 doubles and Gen 3 Battle Tower (pick 4 of 6, level 50)", async () => {
  const t = await trio();
  try {
    for (const options of [
      { gen: 4, preset: "cartridge", gameType: "doubles", teamSize: 4, timer: 0 },
      { gen: 3, preset: "tower", teamSize: 6, timer: 0 },
    ]) {
      const id = await startBattle(t, options);
      await playOut([t.alice, t.bob, t.carol], id);
      checkNoLeaks(t.bob, id, "p1", "doubles Bob");
      checkNoLeaks(t.carol, id, "p2", "doubles Carol");
      const st = t.carol.view(id).state;
      assert.equal(st.gameType, "doubles");
      if (options.preset === "tower") {
        assert.ok(t.carol.received.get(id).includes("|teamsize|p1|4"));
        assert.ok(st.sides.p1.team.filter((m) => !m.placeholder).every((m) => m.level <= 50));
      }
    }
  } finally { t.close(); }
});

test("choices are validated: injection, stale rqid, wrong player, bad options and teams", async () => {
  const t = await trio({ alice: { play: false }, bob: { play: false } });
  try {
    const bad = (p) => assert.rejects(p);
    await bad(t.alice.ws.request("battle.challenge", { to: "@alice:example.org", roomId: ROOM, options: {} }));
    await bad(t.alice.ws.request("battle.challenge", { to: "@nobody:example.org", roomId: ROOM, options: {} }));
    await bad(t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: "!other:example.org", options: {} }));
    await assert.rejects(t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: { gen: 2, gameType: "doubles" } }), /Gen 3/);
    await assert.rejects(t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: { gen: 1 }, team: { source: "sets", sets: [{ species: "Chikorita", moves: ["tackle"] }] } }), /cannot battle in Gen 1/);
    await assert.rejects(t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: {}, team: { source: "nope" } }), /Unknown team source/);
    const id = await startBattle(t, { gen: 2, preset: "smogon", teamSize: 2, timer: 0 });
    const a = t.alice.view(id);
    await until(() => a.state.request?.rqid, 5000, "request");
    const rqid = a.state.request.rqid;
    await assert.rejects(t.alice.ws.request("battle.choose", { id, choice: "move 1\n>forcewin p1", rqid }), /not a valid choice/);
    await assert.rejects(t.alice.ws.request("battle.choose", { id, choice: "move 1|>eval process.exit()", rqid }), /not a valid choice/);
    await assert.rejects(t.alice.ws.request("battle.choose", { id, choice: "move 1", rqid: rqid - 1 }), /earlier turn/);
    await assert.rejects(t.carol.ws.request("battle.choose", { id, choice: "move 1", rqid }), /not playing/);
    await assert.rejects(t.carol.ws.request("battle.forfeit", { id }), /not playing/);
    // a choice the sim refuses comes back to that player only, who may choose again
    await t.alice.ws.request("battle.choose", { id, choice: "move 9", rqid });
    await until(() => t.alice.received.get(id).some((l) => l.startsWith("|error|")), 5000, "sim error");
    assert.ok(!t.bob.received.get(id).some((l) => l.startsWith("|error|")));
    await until(() => a.state.sentChoice === "", 2000, "choice cleared");
    await t.alice.ws.request("battle.choose", { id, choice: "move 1", rqid });
    await until(() => a.state.sentChoice === "move 1", 2000, "sentchoice");
    await assert.rejects(t.alice.ws.request("battle.choose", { id, choice: "move 2", rqid }), /already chose/);
    await t.alice.ws.request("battle.choose", { id, choice: "undo", rqid });
    await until(() => a.state.sentChoice === "", 2000, "undo");
    // forfeit
    await t.bob.ws.request("battle.forfeit", { id });
    await until(() => a.state.ended, 5000, "forfeit");
    assert.equal(a.state.winner, "Alice");
    assert.ok(t.carol.received.get(id).some((l) => l === "|chat|Bob forfeited."));
    await assert.rejects(t.alice.ws.request("battle.choose", { id, choice: "move 1", rqid }));
    const row = app.db.get("SELECT status, winner FROM battles WHERE id = ?", id);
    assert.deepEqual({ ...row }, { status: "done", winner: "@alice:example.org" });
    // decline and cancel
    const { challenge: c1 } = await t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: { gen: 1 } });
    await bad(t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: { gen: 1 } }));
    await t.bob.ws.request("battle.decline", { id: c1.id });
    await until(() => t.alice.challenges.find((c) => c.id === c1.id && c.status === "declined"), 3000, "declined");
    const { challenge: c2 } = await t.alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: { gen: 1 } });
    await bad(t.bob.ws.request("battle.cancel", { id: c2.id }));
    await t.alice.ws.request("battle.cancel", { id: c2.id });
    await until(() => t.bob.challenges.find((c) => c.id === c2.id && c.status === "cancelled"), 3000, "cancelled");
    await bad(t.bob.ws.request("battle.accept", { id: c2.id }));
    const list = await t.carol.ws.request("battle.list", { roomId: ROOM });
    assert.ok(list.recent.some((b) => b.id === id && b.winnerName === "Alice"));
  } finally { t.close(); }
});

test("turn timer: two automatic moves, then a loss on time", async () => {
  const t = await trio({ bob: { play: false } });
  try {
    const id = await startBattle(t, { gen: 3, preset: "smogon", teamSize: 6, timer: 1 });
    const b = t.bob.view(id);
    await until(() => b.state.request?.deadline, 5000, "deadline");
    assert.ok(b.state.request.deadline > Date.now() - 1500 && b.state.request.deadline <= Date.now() + 1500);
    await until(() => t.alice.view(id).state.ended, 15000, "timeout loss");
    const st = t.carol.view(id).state;
    if (st.winner === "Alice") {   // (a lucky KO streak could end it first; then the timer never had to)
      const msgs = st.textLog.filter((e) => e.kind === "chat").map((e) => e.text);
      assert.equal(msgs.filter((m) => m === "Bob ran out of time; a move was chosen automatically.").length, 2, msgs.join(" / "));
      assert.ok(msgs.includes("Bob lost due to inactivity."));
    }
    assert.equal(st.winner, "Alice");
  } finally { t.close(); }
});

test("reconnect and late spectators get a snapshot that replays to the live state", async () => {
  const t = await trio();
  const extra = [];
  try {
    const id = await startBattle(t, { gen: 2, preset: "cartridge", teamSize: 6, timer: 0 });
    await until(() => t.carol.view(id).state.turn >= 3, 20000, "turn 3");
    const bob2 = await new Client(base, tokens.bob, { play: false }).open();
    extra.push(bob2);
    const v = await bob2.join(id);
    assert.equal(v.role, "p2");
    // The players keep playing while the snapshot travels, so the replayed state can only be
    // compared with the live one once nothing moves any more (after the battle ends, below).
    assert.ok(v.state.turn >= 3, "the snapshot replays the turns already played");
    const dan = new Client(base, await signIn(base, "dan"), { play: false });
    extra.push(dan);
    dan.ws.connect();
    await assert.rejects(dan.join(id), /in that room/);   // not in the room: no peeking
    await dan.ws.join(ROOM);
    const dv = await dan.join(id);
    assert.equal(dv.role, "spectator");
    await playOut([t.alice, t.bob, t.carol, dan], id);
    const live = t.bob.view(id).state;
    await until(() => bob2.view(id).state.ended, 10000, "second widget sees the end");
    const mine = bob2.view(id).state;
    assert.equal(mine.winner, live.winner, "the second widget followed along");
    assert.equal(mine.turn, live.turn);
    assert.deepEqual(mine.sides.p2.active.map((m) => m?.hp), live.sides.p2.active.map((m) => m?.hp));
  } finally {
    // A failed assertion must not leave reconnecting sockets behind: they keep the test process alive.
    extra.forEach((c) => c.close());
    t.close();
  }
});

test("practice battle against the CPU", async () => {
  const alice = await new Client(base, tokens.alice).open();
  try {
    const { battle } = await alice.ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options: { gen: 3, preset: "smogon", teamSize: 2, timer: 0 } });
    assert.equal(battle.practice, true);
    assert.equal(battle.players.p2.name, "CPU");
    await alice.join(battle.id);
    await playOut([alice], battle.id, 60000);
    checkNoLeaks(alice, battle.id, "p2", "practice");
    assert.ok(alice.view(battle.id).state.turn >= 1);
  } finally { alice.close(); }
});

test("a server restart replays running battles from the database (player and practice)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pmw-battle-"));
  const env = { DB_FILE: path.join(dir, "test.db") };
  const open = [];
  let { s, base: b1 } = await startServer(env);
  try {
    const tk = { alice: await signIn(b1, "alice"), bob: await signIn(b1, "bob") };
    const mk = async (who, b, play = true) => { const c = new Client(b, tk[who], { play }); open.push(c); return c.open(); };
    let alice = await mk("alice", b1), bob = await mk("bob", b1);
    const { challenge } = await alice.ws.request("battle.challenge", { to: "@bob:example.org", roomId: ROOM, options: { gen: 4, preset: "smogon", teamSize: 6, timer: 30 } });
    await until(() => bob.challenges.length, 3000, "challenge");
    const { battle } = await bob.ws.request("battle.accept", { id: challenge.id });
    const { battle: practice } = await alice.ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options: { gen: 5, teamSize: 6, timer: 0 } });
    for (const c of [alice, bob]) c.stopAt.set(battle.id, 4);
    alice.stopAt.set(practice.id, 3);
    await Promise.all([alice.join(battle.id), bob.join(battle.id), alice.join(practice.id)]);
    await until(() => alice.view(battle.id).state.turn >= 4 && bob.view(battle.id).state.turn >= 4 && alice.view(practice.id).state.turn >= 3, 30000, "a few turns");
    await sleep(800);   // let in-flight choices land
    assert.ok(!alice.view(battle.id).state.ended && !alice.view(practice.id).state.ended, "both still running before the restart");
    const before = { turn: alice.view(battle.id).state.turn, practiceTurn: alice.view(practice.id).state.turn,
      hp: bob.view(battle.id).state.sides.p2.active.map((m) => m?.hp) };
    alice.close(); bob.close();
    await s.close();

    ({ s, base: b1 } = await startServer(env));
    alice = await mk("alice", b1); bob = await mk("bob", b1);
    const list = await alice.ws.request("battle.list", { roomId: ROOM });
    const status = s.db.all("SELECT id, status, format FROM battles").map((r) => `${r.id}:${r.status}:${JSON.parse(r.format).note ?? ""}`);
    assert.ok(list.battles.some((x) => x.id === battle.id) && list.battles.some((x) => x.id === practice.id), `both still running: ${status}`);
    alice.stopAt.set(battle.id, 0); bob.stopAt.set(battle.id, 0); alice.stopAt.set(practice.id, 0);   // look first, then play on
    const [va, vb, vp] = await Promise.all([alice.join(battle.id), bob.join(battle.id), alice.join(practice.id)]);
    assert.equal(va.state.turn, before.turn);
    assert.equal(vb.state.turn, before.turn);
    assert.deepEqual(vb.state.sides.p2.active.map((m) => m?.hp), before.hp, "same HP as before the restart");
    assert.equal(vp.state.turn, before.practiceTurn);
    assert.ok(va.state.request?.deadline > Date.now(), "the timer restarted with a fresh deadline");
    alice.resume(battle.id); bob.resume(battle.id); alice.resume(practice.id);
    await playOut([alice, bob], battle.id, 60000);
    await playOut([alice], practice.id, 90000);
    assert.equal(s.db.get("SELECT status FROM battles WHERE id = ?", battle.id).status, "done");

    // an input log that cannot be replayed is aborted cleanly, not half-resumed
    s.db.run("INSERT INTO battles (id, room_id, format, p1, p2, status, created_at) VALUES ('broken', ?, ?, '@a:x', '@b:x', 'active', 0)",
      ROOM, JSON.stringify({ options: { gen: 3 }, formatid: "nope", sim: "0.0.1", names: { p1: "A", p2: "B" } }));
    for (const c of open) c.close();
    await s.close();
    ({ s } = await startServer(env));
    const row = s.db.get("SELECT status, format FROM battles WHERE id = 'broken'");
    assert.equal(row.status, "aborted");
    assert.match(JSON.parse(row.format).note, /could not be resumed/);
  } finally {
    for (const c of open) c.close();
    await s.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
