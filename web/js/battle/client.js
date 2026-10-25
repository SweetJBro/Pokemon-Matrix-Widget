/* One battle as this widget sees it: joins it, keeps a protocol tracker in step with the server's
   pushes, paces what happens so people can follow it, and sends choices. No DOM, so it runs under
   node too; the battle screen listens through onChange.

   Sync rules (server/battles.js): `battle.join` answers a snapshot of our own channel, { seq,
   lines }; afterwards every "battle.log" push carries the seq of its first line, or none for the
   extras (|request|, |error|, |sentchoice|) that are not part of the log. Pushes that arrive while
   the join is in flight wait in a buffer (several frames can land before the reply's continuation
   runs); a push that starts past what we have means we missed something, so we join again. A
   snapshot is applied at once (reconnects and late joins skip the animation); live lines go
   through a queue with short pauses on visible events, and skip the pauses while the tab is
   hidden or the queue is long (the widget was asleep). */
import { BattleState, VISIBLE } from "../../shared/battle/state.js";

const DELAYS = { move: 700, switch: 550, drag: 550, faint: 650, "-damage": 450, "-heal": 400, turn: 250, win: 0, tie: 0 };
const DEFAULT_DELAY = 300;
const FAST_QUEUE = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BattleClient {
  /** ws: js/api.js Socket; onChange(ev): ev.type "reset" | "event" (+ cmd, side, slot) | "choice" | "idle" */
  constructor({ id, ws, onChange = () => {}, isVisible = () => true, delays = DELAYS }) {
    this.id = id;
    this.ws = ws;
    this.onChange = onChange;
    this.isVisible = isVisible;
    this.delays = delays;
    this.state = new BattleState(null);
    this.role = null;                 // "p1" | "p2" | "spectator"
    this.battle = null;               // summary from the server
    this.finished = false;            // a stored battle (no live room)
    this.nextSeq = 0;
    this.queue = [];
    this.running = false;
    this.joining = false;
    this.buffer = [];
    this.offset = 0;                  // server clock - our clock, ms
    this.closed = false;
    this.epoch = 0;
  }

  get isPlayer() { return this.role === "p1" || this.role === "p2"; }
  /** Still animating earlier events (the controls wait for this). */
  get busy() { return this.queue.length > 0 || this.running; }

  async join() {
    const epoch = ++this.epoch;
    this.joining = true;
    let r;
    try {
      r = await this.ws.request("battle.join", { id: this.id });
    } finally {
      if (epoch === this.epoch) this.joining = false;
    }
    if (epoch !== this.epoch || this.closed) return;
    this.role = r.role;
    this.battle = r.battle;
    this.finished = !!r.finished;
    if (typeof r.now === "number") this.offset = r.now - Date.now();
    this.state = new BattleState(this.isPlayer ? r.role : null);
    this.queue = [];
    for (const l of r.lines) this.state.add(l);
    this.nextSeq = r.seq;
    this.onChange({ type: "reset" });
    const buffered = this.buffer.splice(0);
    for (const m of buffered) this.push(m);
  }

  /** A "battle.log" push. */
  push(msg) {
    if (this.closed || msg.id !== this.id) return;
    if (this.joining) { this.buffer.push(msg); return; }
    if (!this.role || msg.role !== this.role) return;
    if (typeof msg.now === "number") this.offset = msg.now - Date.now();
    let lines = msg.lines ?? [];
    if (msg.seq !== null && msg.seq !== undefined) {
      if (msg.seq > this.nextSeq) { this.join().catch((e) => console.warn("battle resync failed:", e.message)); return; }
      lines = lines.slice(this.nextSeq - msg.seq);
      this.nextSeq = Math.max(this.nextSeq, msg.seq + msg.lines.length);
    }
    if (!lines.length) return;
    this.queue.push(...lines);
    this.#run();
  }

  async #run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const fast = !this.isVisible() || this.queue.length > FAST_QUEUE;
        const line = this.queue.shift();
        const state = this.state;
        const ev = state.add(line);
        if (!ev) continue;
        const visible = VISIBLE.has(ev.cmd) && !ev.stale;
        if (visible && !fast) {
          this.onChange({ type: "event", ...ev, line });
          await sleep(this.delays[ev.cmd] ?? DEFAULT_DELAY);
        } else if (!this.queue.length || ev.cmd === "error") {
          this.onChange({ type: "event", ...ev, line });
        }
      }
    } finally {
      this.running = false;
    }
    if (!this.closed) this.onChange({ type: "idle" });
  }

  /** Send a choice for the pending request ("move 1", "switch 3", "move 2 1, move 1 2", "team 213"). */
  async choose(choice) {
    const req = this.state.request;
    if (!req || req.wait) throw new Error("There is nothing to choose right now");
    this.state.sentChoice = choice;   // optimistic; the server's |sentchoice| confirms it
    this.onChange({ type: "choice" });
    try {
      await this.ws.request("battle.choose", { id: this.id, choice, rqid: req.rqid });
    } catch (e) {
      if (this.state.request === req && this.state.sentChoice === choice) { this.state.sentChoice = ""; this.onChange({ type: "choice" }); }
      throw e;
    }
  }

  async undo() {
    const req = this.state.request;
    if (!req || !this.state.sentChoice) return;
    await this.ws.request("battle.choose", { id: this.id, choice: "undo", rqid: req.rqid });
  }

  forfeit() { return this.ws.request("battle.forfeit", { id: this.id }); }

  /** ms left on our turn timer (server clock), or null when no timer runs for us. */
  timeLeft() {
    const d = this.state.request?.deadline;
    return d && !this.state.sentChoice && !this.state.ended ? d - (Date.now() + this.offset) : null;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    if (this.role === "spectator" && !this.finished) this.ws.send("battle.leave", { id: this.id });
  }
}
