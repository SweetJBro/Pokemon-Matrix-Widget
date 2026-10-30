/* Battles: challenges between people in a Matrix room, practice battles against the CPU, and the
   live battle rooms (server/battle-room.js), over the hub's WebSocket.

   Client -> server (all answer through the hub's rid reply):
     battle.challenge { to, roomId, options, team }  -> { challenge }; to = "cpu" starts a practice
                                                       battle at once and returns { battle }
     battle.accept    { id, team }                   -> { battle }       (the challenged player)
     battle.decline   { id }    battle.cancel { id } (the challenger)
     battle.choose    { id, choice, rqid }           choice: "move 1", "move 2 1, switch 3", "team 2143", "undo" ...
     battle.forfeit   { id }
     battle.join      { id }                         -> { battle, role, seq, lines, now }: a snapshot of the
                                                       caller's channel (p1, p2 or spectator) to replay
     battle.leave     { id }                         stop spectating
     battle.list      { roomId }                     -> { challenges, battles, recent }
   Server -> client pushes:
     { type: "battle.challenge", challenge }         to both parties on every change (status
                                                       pending | accepted | declined | cancelled | expired)
     { type: "battle", battle }                      summary on start, each turn and at the end, to the
                                                       battle's room and both players
     { type: "battle.log", id, role, seq, lines, now }  protocol lines of the receiver's own channel;
                                                       seq numbers the channel log (null for the extras
                                                       |request|, |error| and |sentchoice|)
   options: shared/battle/formats.js. team: { source: "random" } (default) | { source: "sets", sets }
   (DEV_AUTH only) | whatever other sources accept.

   Hidden information: a player's connections get only that player's channel and requests; anyone
   else in the room gets the spectator channel (HP in percent or pixels, nothing unrevealed). The
   omniscient log and the input log (which holds both full teams) never leave the server.

   Team sources are pluggable: registerTeamSource(name, async (user, spec, options, ctx) => sets),
   ctx = { db, config }. "random" and "sets" live here; "home" (spec { monIds }) and "party" (spec
   { records: [{ record, meta }] }) belong in server/battle-teams.js, which imports
   registerTeamSource from this module and is loaded on demand the first time a team is built (a
   missing file just means those sources are not there yet). Whatever a source returns goes
   through prepareTeam() (server/battle-sim.js) before the sim sees it. Battles never write
   stored Pokémon: Home records are copied into sets, nothing flows back.

   Persistence: the battles row (options, format id, seed, @pkmn/sim version, names) and every
   input line (battle_input) are stored as the battle runs. On start the server replays every
   active battle from its input log through a new BattleRoom, which reproduces it exactly; timers
   restart from a fresh deadline and the practice CPU picks up from its replayed channel. A battle
   whose log cannot be replayed (a different @pkmn/sim version, a format that no longer resolves,
   a sim error) is marked "aborted" and shows a message instead. Finished battles keep their
   spectator log in battles.log; their input log is deleted. Challenges live in memory only. */
import crypto from "node:crypto";
import { BattleRoom } from "./battle-room.js";
import { BattleError, ensureFormat, prepareTeam, randomTeam, randomSeed, annotateRequest, cleanName, dexFor, SIM_VERSION } from "./battle-sim.js";
import { normalizeOptions, describeOptions, OptionError } from "../shared/battle/formats.js";
import { BattleState } from "../shared/battle/state.js";
import { chooseGreedy } from "../shared/battle/ai.js";

export const CPU = "cpu";
export const CPU_NAME = "CPU";
export const AI_DELAY_MS = 600;           // the practice CPU "thinks" this long
const CHALLENGE_MS = 10 * 60_000;         // unanswered challenges expire
const OFFLINE_GRACE_MS = 30_000;          // a widget reload must not cancel a challenge
const KEEP_FINISHED_MS = 10 * 60_000;     // finished battles stay live for the result screen and late joins
const MAX_ACTIVE_PER_USER = 3, MAX_CHALLENGES_PER_USER = 5, MAX_LIVE = 500;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS battle_input (
  battle_id     TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  line          TEXT NOT NULL,             -- one line written to the simulator (>start, >player, >p1 move 1 ...)
  PRIMARY KEY (battle_id, seq)
);`;

/* ---------- team sources ---------- */

const sources = new Map();

/** fn: async (user, spec, options, ctx) => PokemonSet[]; throw an Error with status 400 for player mistakes. */
export function registerTeamSource(name, fn) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || typeof fn !== "function") throw new TypeError("registerTeamSource(name, fn)");
  sources.set(name, fn);
}
export const teamSourceNames = () => [...sources.keys()];

registerTeamSource("random", async (user, spec, options) => randomTeam(options));
registerTeamSource("sets", async (user, spec, options, ctx) => {
  if (!ctx.config.devAuth) throw new BattleError("Explicit sets are only accepted on development servers");
  if (!Array.isArray(spec.sets)) throw new BattleError("sets must be a list of Pokémon");
  return spec.sets;
});

let extraSources = null;
function loadExtraSources() {
  return (extraSources ??= import("./battle-teams.js").catch((e) => {
    if (e?.code !== "ERR_MODULE_NOT_FOUND" || !String(e.message).includes("battle-teams.js")) console.error("battle-teams.js failed to load:", e);
  }));
}

async function buildTeam(user, spec, options, ctx) {
  await loadExtraSources();
  if (spec !== undefined && (typeof spec !== "object" || spec === null || Array.isArray(spec))) throw new BattleError("Bad team choice");
  const name = spec?.source ?? "random";
  const fn = typeof name === "string" && sources.get(name);
  if (!fn) throw new BattleError(`Unknown team source "${String(name).slice(0, 32)}"`);
  return prepareTeam(await fn(user, spec ?? {}, options, ctx), options);
}

/* ---------- module ---------- */

const instances = new Map();   // hub -> instance (one per createServer())

/** Stop the battles of one server (or of all), timers and streams; active battles resume from the database. */
export function shutdown(deps) {
  for (const [hub, inst] of [...instances]) if (!deps || deps.hub === hub) inst.shutdown();
}

export function register(app, deps) {
  const inst = createBattles(deps);
  instances.set(deps.hub, inst);
  return inst;
}

function createBattles({ db, config, hub }) {
  // Presence shows who is in a battle (and which), whatever tab their widget shows.
  hub.addStatusProvider((userId) => {
    for (const b of battles.values()) if (b.status === "active" && (b.players.p1.id === userId || b.players.p2.id === userId)) return { battleId: b.id };
    return null;
  });
  db.raw.exec(SCHEMA);
  const challenges = new Map();   // id -> challenge
  const battles = new Map();      // id -> live battle (also finished ones for KEEP_FINISHED_MS)
  const offlineTimers = new Map();
  let closed = false;

  const bad = (m) => new BattleError(m);
  const newId = () => crypto.randomBytes(9).toString("base64url");
  const nameOf = (user) => cleanName(user.displayName || /^@([^:]+)/.exec(user.id)?.[1] || user.id, 24) || "Trainer";
  const ctx = { db, config };

  function sendConn(conn, msg) {
    if (conn.ws.readyState !== conn.ws.OPEN) return false;
    conn.ws.send(JSON.stringify(msg));
    return true;
  }

  /* ----- summaries ----- */

  function summary(b) {
    return {
      id: b.id, roomId: b.roomId, status: b.status, options: b.options, desc: describeOptions(b.options),
      players: { p1: { ...b.players.p1 }, p2: { ...b.players.p2 } },
      practice: b.players.p2.id === CPU, turn: b.turn,
      winner: b.winner ?? null, winnerName: b.winner ? b.players[b.winner].name : null,
      createdAt: b.createdAt, endedAt: b.endedAt ?? null, note: b.note ?? null,
    };
  }

  function rowSummary(row) {
    const meta = JSON.parse(row.format);
    const names = meta.names ?? {};
    const winner = row.winner === row.p1 ? "p1" : row.winner === row.p2 ? "p2" : null;
    return {
      id: row.id, roomId: row.room_id, status: row.status, options: meta.options, desc: describeOptions(meta.options),
      players: { p1: { id: row.p1, name: names.p1 ?? row.p1 }, p2: { id: row.p2, name: names.p2 ?? row.p2 } },
      practice: row.p2 === CPU, turn: meta.turn ?? 0,
      winner, winnerName: winner ? names[winner] ?? null : null,
      createdAt: row.created_at, endedAt: row.ended_at ?? null, note: meta.note ?? null,
    };
  }

  function challengeView(c) {
    return { id: c.id, roomId: c.roomId, from: c.from, to: c.to, options: c.options, desc: describeOptions(c.options),
      source: c.source, status: c.status, reason: c.reason ?? null, battleId: c.battleId ?? null, createdAt: c.createdAt, expiresAt: c.expiresAt };
  }

  function pushChallenge(c) {
    const msg = { type: "battle.challenge", challenge: challengeView(c) };
    hub.sendUser(c.from.id, msg);
    hub.sendUser(c.to.id, msg);
  }

  function pushSummary(b) {
    const msg = { type: "battle", battle: summary(b) };
    if (b.roomId) hub.broadcastRoom(b.roomId, msg);
    for (const p of [b.players.p1, b.players.p2]) if (p.id !== CPU && !hub.roomsOf(p.id).has(b.roomId)) hub.sendUser(p.id, msg);
  }

  /* ----- channels ----- */

  function deliver(b, channel, lines, seq) {
    const msg = { type: "battle.log", id: b.id, role: channel, seq, lines, now: Date.now() };
    if (channel === "spectator") {
      for (const c of b.spectators) if (!sendConn(c, msg)) b.spectators.delete(c);
      return;
    }
    const p = b.players[channel];
    if (p.id === CPU) feedCpu(b, lines);
    else hub.sendUser(p.id, msg);
  }

  /* The practice CPU reads its own channel only, like a human in its seat. */
  function feedCpu(b, lines) {
    for (const l of lines) {
      b.cpu.state.add(l);
      const retry = l.startsWith("|error|");   // the sim refused its choice: fall back to "default"
      if (!l.startsWith("|request|") && !retry) continue;
      const req = b.cpu.state.request;
      clearTimeout(b.cpu.timer);
      if (!req || req.wait) continue;
      b.cpu.timer = setTimeout(() => {
        const pending = b.room.requests.p2;
        if (b.room.ended || pending?.rqid !== req.rqid || pending.choice) return;
        let choice = null;
        if (!retry) try { choice = chooseGreedy(req, b.cpu.state, { dex: dexFor(b.options.gen) }); } catch (e) { console.error("practice AI:", e); }
        if (b.room.choose("p2", choice || "default", req.rqid)) b.room.choose("p2", "default", req.rqid);
      }, retry ? 0 : AI_DELAY_MS);
      b.cpu.timer.unref?.();
    }
  }

  /* ----- starting, finishing, restoring ----- */

  function startBattle({ roomId, options, p1, p2, teams }) {
    if (battles.size >= MAX_LIVE) throw bad("The server is running too many battles; try again later");
    const spec = ensureFormat(options);
    const id = newId(), seed = randomSeed(), createdAt = Date.now();
    if (p2.name === p1.name) p2 = { ...p2, name: `${[...p2.name].slice(0, 20).join("")} (2)` };
    const meta = { options, formatid: spec.id, seed, sim: SIM_VERSION, names: { p1: p1.name, p2: p2.name } };
    db.run("INSERT INTO battles (id, room_id, format, p1, p2, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
      id, roomId, JSON.stringify(meta), p1.id, p2.id, createdAt);
    const b = makeBattle({ id, roomId, options, meta, players: { p1, p2 }, createdAt });
    b.room = newRoom(b, { formatid: spec.id, seed, players: { p1: { name: p1.name, team: teams.p1 }, p2: { name: p2.name, team: teams.p2 } } });
    pushSummary(b);
    for (const p of [p1, p2]) if (p.id !== CPU) hub.refreshUser(p.id);   // presence: now "battling"
    return b;
  }

  function makeBattle({ id, roomId, options, meta, players, createdAt }) {
    const b = { id, roomId, options, meta, players, createdAt, status: "active", turn: 0, winner: null, endedAt: null,
      spectators: new Set(), seq: 0, room: null, cpu: null, evict: null, note: null };
    if (players.p2.id === CPU) b.cpu = { state: new BattleState("p2"), timer: null };
    battles.set(id, b);
    return b;
  }

  function newRoom(b, extra) {
    return new BattleRoom({
      ...extra,
      timer: { turnSeconds: b.options.timer, autoChooses: 2, sides: ["p1", "p2"].filter((s) => b.players[s].id !== CPU) },
      send: (channel, lines, seq) => deliver(b, channel, lines, seq),
      persist: (line) => db.run("INSERT INTO battle_input (battle_id, seq, line) VALUES (?, ?, ?)", b.id, b.seq++, line),
      decorate: (side, request) => annotateRequest(b.options.gen, request),
      onUpdate: (lines) => {
        const turn = lines.findLast((l) => l.startsWith("|turn|"));
        if (turn) { b.turn = Number(turn.slice(6)) || b.turn; if (!closed) pushSummary(b); }
      },
      onEnd: (winner, reason) => finishBattle(b, winner, reason),
    });
  }

  function finishBattle(b, winner, reason) {
    if (b.status !== "active") return;
    queueMicrotask(() => { for (const s of ["p1", "p2"]) if (b.players[s].id !== CPU) hub.refreshUser(b.players[s].id); });
    b.status = reason === "crash" ? "aborted" : "done";
    b.winner = winner;
    b.endedAt = Date.now();
    if (reason === "crash") b.note = "The battle engine failed and the battle was ended.";
    if (b.cpu) clearTimeout(b.cpu.timer);
    const meta = { ...b.meta, turn: b.turn, note: b.note };
    db.tx(() => {
      db.run("UPDATE battles SET status = ?, winner = ?, log = ?, format = ?, ended_at = ? WHERE id = ?",
        b.status, winner ? b.players[winner].id : null, JSON.stringify(b.room.logs.spectator), JSON.stringify(meta), b.endedAt, b.id);
      db.run("DELETE FROM battle_input WHERE battle_id = ?", b.id);
    });
    if (!closed) pushSummary(b);
    b.evict = setTimeout(() => { if (battles.get(b.id) === b) battles.delete(b.id); }, KEEP_FINISHED_MS);
    b.evict.unref?.();
  }

  function abortRow(row, note) {
    const meta = { ...JSON.parse(row.format), note };
    db.tx(() => {
      db.run("UPDATE battles SET status = 'aborted', format = ?, log = ?, ended_at = ? WHERE id = ?",
        JSON.stringify(meta), JSON.stringify([`|-message|${note}`]), Date.now(), row.id);
      db.run("DELETE FROM battle_input WHERE battle_id = ?", row.id);
    });
  }

  function restore() {
    for (const row of db.all("SELECT * FROM battles WHERE status = 'active'")) {
      let meta;
      try { meta = JSON.parse(row.format); } catch { abortRow({ ...row, format: "{}" }, "The stored battle could not be read."); continue; }
      if (meta.sim !== SIM_VERSION) { abortRow(row, "The server's battle engine was updated, so this battle could not be resumed."); continue; }
      const input = db.all("SELECT line FROM battle_input WHERE battle_id = ? ORDER BY seq", row.id).map((r) => r.line);
      try {
        const options = normalizeOptions(meta.options);
        if (ensureFormat(options).id !== meta.formatid || !input.length) throw new Error("format or input log mismatch");
        const players = {
          p1: { id: row.p1, name: meta.names?.p1 ?? row.p1 },
          p2: { id: row.p2, name: meta.names?.p2 ?? row.p2 },
        };
        const b = makeBattle({ id: row.id, roomId: row.room_id, options, meta, players, createdAt: row.created_at });
        b.seq = input.length;
        b.room = newRoom(b, { inputLog: input });
      } catch (e) {
        console.error(`battle ${row.id} could not be resumed:`, e);
        battles.delete(row.id);
        abortRow(row, "This battle could not be resumed after a server restart.");
      }
    }
  }

  /* ----- lookups and checks ----- */

  function live(id) {
    const b = battles.get(String(id ?? ""));
    if (!b) throw bad("That battle is not running");
    return b;
  }
  const sideOf = (b, userId) => (b.players.p1.id === userId ? "p1" : b.players.p2.id === userId ? "p2" : null);
  const activeCount = (userId) => [...battles.values()].filter((b) => b.status === "active" && sideOf(b, userId)).length;

  function checkRoom(conn, roomId) {
    roomId = String(roomId ?? "");
    if (!conn.rooms.has(roomId)) throw bad("Join the room first");
    return roomId;
  }
  function parseOptions(raw) {
    try { return normalizeOptions(raw); } catch (e) { throw e instanceof OptionError ? bad(e.message) : e; }
  }
  function sourceName(spec) { return typeof spec?.source === "string" ? spec.source.slice(0, 32) : "random"; }

  function endChallenge(c, status, reason) {
    if (c.status !== "pending") return;
    c.status = status; c.reason = reason ?? null;
    clearTimeout(c.timer);
    challenges.delete(c.id);
    pushChallenge(c);
  }

  /* ----- handlers ----- */

  hub.on("battle.challenge", async (msg, conn) => {
    const roomId = checkRoom(conn, msg.roomId);
    const options = parseOptions(msg.options);
    const me = { id: conn.user.id, name: nameOf(conn.user) };
    if (activeCount(me.id) >= MAX_ACTIVE_PER_USER) throw bad(`You already have ${MAX_ACTIVE_PER_USER} battles running`);
    if (msg.to === CPU) {
      const team = await buildTeam(conn.user, msg.team, options, ctx);
      const cpuTeam = prepareTeam(randomTeam(options), options);
      const b = startBattle({ roomId, options, p1: me, p2: { id: CPU, name: CPU_NAME }, teams: { p1: team, p2: cpuTeam } });
      return { battle: summary(b) };
    }
    const to = String(msg.to ?? "");
    if (to === me.id) throw bad("You cannot challenge yourself");
    const target = hub.presence(roomId).find((u) => u.id === to);
    if (!target) throw bad("That person does not have the widget open in this room");
    const mine = [...challenges.values()].filter((c) => c.from.id === me.id);
    if (mine.length >= MAX_CHALLENGES_PER_USER) throw bad("You have too many open challenges");
    if (mine.some((c) => c.to.id === to)) throw bad("You already challenged them; wait for an answer or cancel it");
    const team = await buildTeam(conn.user, msg.team, options, ctx);
    const now = Date.now();
    const c = { id: newId(), roomId, from: me, to: { id: to, name: nameOf(target) }, options, source: sourceName(msg.team),
      team, status: "pending", createdAt: now, expiresAt: now + CHALLENGE_MS, timer: null };
    c.timer = setTimeout(() => endChallenge(c, "expired", "Nobody answered in time"), CHALLENGE_MS);
    c.timer.unref?.();
    challenges.set(c.id, c);
    pushChallenge(c);
    return { challenge: challengeView(c) };
  });

  hub.on("battle.accept", async (msg, conn) => {
    const c = challenges.get(String(msg.id ?? ""));
    if (!c || c.to.id !== conn.user.id) throw bad("That challenge is no longer open");
    if (activeCount(conn.user.id) >= MAX_ACTIVE_PER_USER) throw bad(`You already have ${MAX_ACTIVE_PER_USER} battles running`);
    const team = await buildTeam(conn.user, msg.team, c.options, ctx);
    if (c.status !== "pending" || !challenges.has(c.id)) throw bad("That challenge is no longer open");   // cancelled while building
    const b = startBattle({ roomId: c.roomId, options: c.options, p1: c.from, p2: { id: conn.user.id, name: nameOf(conn.user) }, teams: { p1: c.team, p2: team } });
    c.battleId = b.id;
    endChallenge(c, "accepted");
    return { battle: summary(b) };
  });

  hub.on("battle.decline", (msg, conn) => {
    const c = challenges.get(String(msg.id ?? ""));
    if (!c || c.to.id !== conn.user.id) throw bad("That challenge is no longer open");
    endChallenge(c, "declined", `${nameOf(conn.user)} declined`);
    return null;
  });

  hub.on("battle.cancel", (msg, conn) => {
    const c = challenges.get(String(msg.id ?? ""));
    if (!c || c.from.id !== conn.user.id) throw bad("That challenge is no longer open");
    endChallenge(c, "cancelled", `${c.from.name} withdrew the challenge`);
    return null;
  });

  hub.on("battle.choose", (msg, conn) => {
    const b = live(msg.id);
    const side = sideOf(b, conn.user.id);
    if (!side) throw bad("You are not playing in this battle");
    const err = b.room.choose(side, msg.choice, msg.rqid);
    if (err) throw bad(err);
    return null;
  });

  hub.on("battle.forfeit", (msg, conn) => {
    const b = live(msg.id);
    const side = sideOf(b, conn.user.id);
    if (!side) throw bad("You are not playing in this battle");
    b.room.forfeit(side);
    return null;
  });

  hub.on("battle.join", (msg, conn) => {
    const id = String(msg.id ?? "");
    const b = battles.get(id);
    if (b) {
      const role = sideOf(b, conn.user.id) ?? "spectator";
      if (role === "spectator") {
        if (!conn.rooms.has(b.roomId)) throw bad("Open the widget in that room to watch this battle");
        b.spectators.add(conn);
      }
      const snap = b.room.snapshot(role);
      return { battle: summary(b), role, seq: snap.seq, lines: snap.lines, now: Date.now() };
    }
    const row = db.get("SELECT * FROM battles WHERE id = ?", id);
    if (!row || row.status === "active") throw bad("That battle is not running");
    const s = rowSummary(row);
    const role = sideOf(s, conn.user.id) ?? "spectator";
    if (role === "spectator" && !conn.rooms.has(row.room_id)) throw bad("Open the widget in that room to see this battle");
    const lines = row.log ? JSON.parse(row.log) : [];
    return { battle: s, role: "spectator", seq: lines.length, lines, now: Date.now(), finished: true };
  });

  hub.on("battle.leave", (msg, conn) => {
    battles.get(String(msg.id ?? ""))?.spectators.delete(conn);
    return null;
  });

  hub.on("battle.list", async (msg, conn) => {
    await loadExtraSources();   // so `sources` already lists "home" and "party" before anyone has battled
    const roomId = checkRoom(conn, msg.roomId);
    const me = conn.user.id;
    const mine = [...challenges.values()].filter((c) => c.from.id === me || c.to.id === me).map(challengeView);
    const running = [...battles.values()].filter((b) => b.status === "active" && (b.roomId === roomId || sideOf(b, me))).map(summary);
    const recent = db.all("SELECT * FROM battles WHERE room_id = ? AND status != 'active' ORDER BY ended_at DESC LIMIT 10", roomId).map(rowSummary);
    return { challenges: mine, battles: running, recent, sources: teamSourceNames() };
  });

  /* Challenges die with their people, after a grace period for reloads. */
  hub.onUserOffline((userId) => {
    clearTimeout(offlineTimers.get(userId));
    const t = setTimeout(() => {
      offlineTimers.delete(userId);
      if (hub.isOnline(userId)) return;
      for (const c of [...challenges.values()]) if (c.from.id === userId || c.to.id === userId) endChallenge(c, "cancelled", `${c.from.id === userId ? c.from.name : c.to.name} went offline`);
    }, OFFLINE_GRACE_MS);
    t.unref?.();
    offlineTimers.set(userId, t);
  });

  restore();

  return {
    battles, challenges,
    shutdown() {
      closed = true;
      instances.delete(hub);
      for (const c of challenges.values()) clearTimeout(c.timer);
      for (const t of offlineTimers.values()) clearTimeout(t);
      for (const b of battles.values()) { clearTimeout(b.evict); if (b.cpu) clearTimeout(b.cpu.timer); b.room?.close(); }
      battles.clear();
    },
  };
}
