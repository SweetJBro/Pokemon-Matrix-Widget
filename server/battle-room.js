/* One running battle: owns a @pkmn/sim BattleStream and is the only thing that talks to it.

   * Channels. The sim writes one "update" per step with |split|pN blocks (secret line for that
     player, public line for everyone else) and "sideupdate"s carrying a player's |request| or
     |error|. extractChannelMessages() resolves the splits into omniscient / spectator / p1 / p2
     logs; send() only ever gets the last three, and a request or error only goes to its own
     side. The omniscient log stays in memory for tests and is never sent anywhere.
   * Choices are untrusted strings that end up after ">p1 " in the sim's input; a newline would
     start a new command (">forcewin p1", or ">eval" which runs code), so only a strict
     whitelist of slot-number grammar is accepted, for the pending request's rqid only.
   * Timer: per turn, for the sides listed in timer.sides (humans). On expiry the sim picks
     "default" for that player, twice; the third expiry forfeits. Choosing resets the count.
   * Input log: every line we write to the sim goes through persist(), so a restart can replay
     the battle exactly (same seed, same choices). Our own announcements (forfeits, timeouts) are
     written as ">chat" so they are part of that log too.
   * A sim exception ends the battle as a tie instead of taking the server down.

   Tested design: docs/research/battle-engine.md §3.3 and §3.5. */
import { BattleStreams, extractChannelMessages } from "@pkmn/sim";

const CHANNELS = { omniscient: -1, spectator: 0, p1: 1, p2: 2 };
const SIDES = ["p1", "p2"];
// "move 1", "move 2 -1, switch 4", "team 3142", "default", "pass", "undo": letters, digits, spaces, commas, signs.
const CHOICE_RE = /^(move|switch|team|default|pass|undo)\b[a-z0-9 ,+-]*$/i;
const oneLine = (s) => String(s).replace(/[\r\n|]+/g, " ").slice(0, 200);

export class BattleRoom {
  /**
   * o.formatid, o.seed, o.players { p1: { name, team }, p2: { name, team } }  (names unique, teams prepared)
   * o.inputLog       stored input lines: rebuild a battle after a restart instead of starting one
   * o.send(channel, lines, seq)  channel "p1" | "p2" | "spectator"; seq = index of lines[0] in that
   *                  channel's log, or null for per-player extras (|request|, |error|, |sentchoice|)
   * o.persist(line)  store one input line             o.decorate(side, request)  add fields to a request
   * o.timer { turnSeconds = 90, autoChooses = 2, sides = ["p1", "p2"] }
   * o.onUpdate(spectatorLines)   o.onEnd(winnerSide | null, reason: "win" | "tie" | "crash")
   */
  constructor(o) {
    this.send = o.send;
    this.persist = o.persist ?? (() => {});
    this.decorate = o.decorate ?? ((side, r) => r);
    this.onUpdate = o.onUpdate ?? (() => {});
    this.onEnd = o.onEnd ?? (() => {});
    this.logs = { omniscient: [], spectator: [], p1: [], p2: [] };
    this.requests = { p1: null, p2: null };    // { rqid, request, choice, prev }
    this.rqid = 0;
    this.ended = false; this.winner = undefined; this.closed = false;
    this.timerCfg = { turnSeconds: 90, autoChooses: 2, sides: SIDES, ...o.timer };
    this.timers = { p1: null, p2: null };
    this.timeouts = { p1: 0, p2: 0 };
    this.names = { p1: o.players?.p1?.name ?? "", p2: o.players?.p2?.name ?? "" };
    this.stream = new BattleStreams.BattleStream({ keepAlive: false });
    this.done = this.#readLoop();
    const lines = o.inputLog ?? [
      `>start ${JSON.stringify({ formatid: o.formatid, seed: o.seed })}`,
      `>player p1 ${JSON.stringify(o.players.p1)}`,
      `>player p2 ${JSON.stringify(o.players.p2)}`,
    ];
    if (o.inputLog) for (const l of lines) this.#nameFromInput(l);
    this.#write(lines, !o.inputLog);
  }

  /** The sim's Battle object (same process): sides, turn, inputLog. */
  get battle() { return this.stream.battle; }

  #nameFromInput(line) {
    const m = /^>player (p[12]) (.*)$/.exec(line);
    if (m) { try { this.names[m[1]] = JSON.parse(m[2]).name ?? ""; } catch { /* the sim will complain */ } }
  }

  #write(lines, persist = true) {
    if (!Array.isArray(lines)) lines = [lines];
    if (persist) for (const l of lines) this.persist(l);
    void this.stream.write(lines.join("\n"));
  }

  async #readLoop() {
    try {
      for await (const chunk of this.stream) this.#onChunk(chunk);
    } catch (err) {
      if (this.closed || this.ended) return;
      console.error("battle crashed:", err);
      this.#broadcast([`|-message|The battle crashed and was ended (${oneLine(err?.message ?? err).slice(0, 100)}).`, "|tie"]);
      this.#finish(null, "crash");
    }
  }

  #onChunk(chunk) {
    const nl = chunk.indexOf("\n");
    const type = chunk.slice(0, nl), data = chunk.slice(nl + 1);
    if (type === "update") {
      const ch = extractChannelMessages(data, [-1, 0, 1, 2]);
      for (const [name, id] of Object.entries(CHANNELS)) this.#append(name, ch[id]);
      this.onUpdate(ch[0]);
      for (const l of ch[-1]) {
        if (l.startsWith("|win|")) this.#finish(SIDES.find((s) => this.names[s] === l.slice(5)) ?? null, "win");
        else if (l === "|tie") this.#finish(null, "tie");
      }
    } else if (type === "sideupdate") {
      const side = data.slice(0, 2), msg = data.slice(3);
      if (!SIDES.includes(side)) return;
      if (msg.startsWith("|request|")) {
        const request = this.decorate(side, JSON.parse(msg.slice(9)));
        request.rqid = ++this.rqid;
        const timed = this.#timed(side) && !request.wait;
        if (timed) request.deadline = Date.now() + this.timerCfg.turnSeconds * 1000;
        this.requests[side] = { rqid: this.rqid, request, choice: "", prev: "" };
        this.send(side, [`|request|${JSON.stringify(request)}`], null);
        if (timed) this.#startTimer(side); else this.#stopTimer(side);
      } else if (msg.startsWith("|error|")) {
        const r = this.requests[side];
        if (r) {
          if (/Can't undo/.test(msg)) r.choice = r.prev;   // the old choice still stands
          else { r.choice = ""; if (this.#timed(side) && !r.request.wait) this.#startTimer(side); }
        }
        this.send(side, [msg, `|sentchoice|${r?.choice ?? ""}`], null);
      }
    }
  }

  #append(name, lines) {
    if (!lines?.length) return;
    const seq = this.logs[name].length;
    this.logs[name].push(...lines);
    if (name !== "omniscient") this.send(name, lines, seq);
  }

  /** Server-made lines (after a crash) go into every log and every channel. */
  #broadcast(lines) { for (const name of Object.keys(CHANNELS)) this.#append(name, lines); }

  #finish(winner, reason) {
    if (this.ended) return;
    this.ended = true; this.winner = winner;
    this.#stopTimer("p1"); this.#stopTimer("p2");
    try { this.onEnd(winner, reason); } catch (e) { console.error(e); }
  }

  /** A player's choice; returns null or a message for the player. `choice` and `rqid` are untrusted. */
  choose(side, choice, rqid) {
    const r = this.requests[side];
    if (this.ended) return "The battle is over";
    if (!r || r.request.wait) return "There is nothing to choose right now";
    if (rqid !== r.rqid) return "That choice was for an earlier turn";
    choice = String(choice ?? "").trim();
    if (choice.length > 100 || !CHOICE_RE.test(choice)) return "That is not a valid choice";
    if (choice === "undo") {
      if (!r.choice) return "There is no choice to undo";
      r.prev = r.choice; r.choice = "";
      if (this.#timed(side)) this.#startTimer(side);
    } else {
      if (r.choice) return "You already chose; undo it first";
      r.choice = choice;
      this.#stopTimer(side);
      this.timeouts[side] = 0;
    }
    this.send(side, [`|sentchoice|${r.choice}`], null);
    this.#write(`>${side} ${choice}`);
    return null;
  }

  /** Concede (or lose on time); `why` is announced to everyone first. */
  forfeit(side, why = `${this.names[side]} forfeited.`) {
    if (this.ended || !SIDES.includes(side)) return;
    this.#write([`>chat ${oneLine(why)}`, `>forcelose ${side}`]);
  }

  /** What a (re)connecting viewer needs: its channel's log, then its pending request. */
  snapshot(role) {
    const own = SIDES.includes(role);
    const log = this.logs[own ? role : "spectator"];
    const lines = [...log];
    const r = own ? this.requests[role] : null;
    if (r && !this.ended) {
      lines.push(`|request|${JSON.stringify(r.request)}`);
      if (r.choice) lines.push(`|sentchoice|${r.choice}`);
    }
    return { seq: log.length, lines };
  }

  /** Stop timers and drop the stream (server shutdown; the stored input log lives on). */
  close() {
    this.closed = true;
    this.#stopTimer("p1"); this.#stopTimer("p2");
    void this.stream.writeEnd?.();
  }

  #timed(side) { return !!this.timerCfg.turnSeconds && this.timerCfg.sides.includes(side) && !this.closed; }

  #startTimer(side) {
    this.#stopTimer(side);
    if (!this.#timed(side) || this.ended) return;
    this.timers[side] = setTimeout(() => this.#expire(side), this.timerCfg.turnSeconds * 1000);
    this.timers[side].unref?.();
  }

  #expire(side) {
    this.timers[side] = null;
    const r = this.requests[side];
    if (this.ended || !r || r.choice || r.request.wait) return;
    if (++this.timeouts[side] > this.timerCfg.autoChooses) { this.forfeit(side, `${this.names[side]} lost due to inactivity.`); return; }
    r.choice = "default";
    this.send(side, ["|sentchoice|default"], null);
    this.#write([`>chat ${oneLine(`${this.names[side]} ran out of time; a move was chosen automatically.`)}`, `>${side} default`]);
  }

  #stopTimer(side) { clearTimeout(this.timers[side]); this.timers[side] = null; }
}
