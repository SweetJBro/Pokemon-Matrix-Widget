/* A dependency-free tracker for the Pokémon Showdown battle protocol.

   Feed it every line of ONE channel in order (p1, p2 or spectator: the server never sends the
   omniscient one) with state.add(line); it keeps what that viewer can know: both sides' active
   Pokémon, HP, status, boosts, volatiles, side and field conditions, the Pokémon seen so far, the
   pending |request| and an English text log. The widget renders it, the practice AI reads it and
   the tests compare it with the sim. Runs unchanged in the browser and in Node.

   Identity: the protocol names Pokémon "p1a: NAME", and two un-nicknamed Pidgey share a name. So
   an ident with a slot letter means "whoever is active in that slot", a switch-in claims a bench
   member with the same name and identical details (species, level, gender, shininess), and Team
   Preview's |poke| lines create placeholders that switch-ins claim (docs/research/battle-engine.md
   §3.4). Fainted Pokémon never come back in Gen 1-5.

   |sentchoice|CHOICE is ours, not Showdown's: the server adds it when this player's choice for
   the pending request was accepted (and an empty one after an undo), so a reconnect knows to show
   "waiting" instead of the move buttons. */

/** "p2a: GARDY" -> { side: "p2", slot: 0, name: "GARDY" }; "p1: Mr. Mime" -> slot null. */
export function parseIdent(ident) {
  const m = /^(p[1-4])([a-c])?: ?(.*)$/.exec(ident ?? "");
  return m ? { side: m[1], slot: m[2] ? m[2].charCodeAt(0) - 97 : null, name: m[3] } : null;
}

/** "Gardevoir, L52, F, shiny" -> { species, level, gender, shiny }. Level 100 is not written. */
export function parseDetails(details = "") {
  const [species, ...rest] = String(details).split(", ");
  const out = { species, level: 100, gender: "", shiny: false };
  for (const t of rest) {
    if (/^L\d+$/.test(t)) out.level = +t.slice(1);
    else if (t === "M" || t === "F") out.gender = t;
    else if (t === "shiny") out.shiny = true;
  }
  return out;
}

/** "87/100 par" | "0 fnt" | "148/148" | "24/48g" (cartridge-style pixel HP) -> { hp, maxhp?, status, fainted }. */
export function parseHP(cond = "") {
  const [hpPart, status = ""] = String(cond).split(" ");
  if (status === "fnt" || hpPart === "0") return { hp: 0, status: "", fainted: true };   // keeps the previous maxhp
  const [hp, max] = hpPart.split("/");
  return { hp: parseInt(hp, 10) || 0, maxhp: parseInt(max, 10) || 100, status, fainted: false };
}

/** "|cmd|a|b|[from] item: Leftovers|[of] p1a: X" -> { cmd, args: ["a", "b"], kw: { from, of } }. */
export function parseLine(line) {
  const parts = line.slice(1).split("|");
  const cmd = parts.shift();
  const kw = {};
  while (parts.length > 1 && /^\[\w+\]/.test(parts[parts.length - 1])) {
    const m = /^\[(\w+)\] ?(.*)$/.exec(parts.pop());
    kw[m[1]] = m[2] || true;
  }
  return { cmd, args: parts, kw };
}

const FROM_NAMES = { psn: "poison", tox: "poison", brn: "burn", par: "paralysis", slp: "sleep", frz: "freeze", confusion: "confusion" };
const effectName = (s = "") => String(s).replace(/^(move|ability|item): /, "");
const fromName = (s) => { const e = effectName(s); return FROM_NAMES[e] ?? e; };

const STATUS_TEXT = { brn: "was burned", par: "is paralyzed! It may be unable to move", slp: "fell asleep", frz: "was frozen solid", psn: "was poisoned", tox: "was badly poisoned" };
const CURE_TEXT = { brn: "'s burn was healed", par: " was cured of paralysis", slp: " woke up", frz: " thawed out", psn: " was cured of its poisoning", tox: " was cured of its poisoning" };
const STAT_NAME = { atk: "Attack", def: "Defense", spa: "Sp. Atk", spd: "Sp. Def", spe: "Speed", accuracy: "accuracy", evasion: "evasiveness", spc: "Special" };
const CANT_TEXT = { slp: "is fast asleep", par: "is paralyzed! It can't move", frz: "is frozen solid", flinch: "flinched and couldn't move", recharge: "must recharge", nopp: "has no PP left", Disable: "can't use its disabled move", Taunt: "can't use status moves after the taunt", Truant: "is loafing around", Focus_Punch: "lost its focus" };
export const WEATHER_NAMES = { RainDance: "Rain", SunnyDay: "Harsh sunlight", Sandstorm: "Sandstorm", Hail: "Hail", none: "" };
const WEATHER_START = { RainDance: "It started to rain!", SunnyDay: "The sunlight turned harsh!", Sandstorm: "A sandstorm kicked up!", Hail: "It started to hail!" };
const WEATHER_END = { RainDance: "The rain stopped.", SunnyDay: "The harsh sunlight faded.", Sandstorm: "The sandstorm subsided.", Hail: "The hail stopped." };

/** Commands the renderer animates (and paces). Everything else applies instantly. */
export const VISIBLE = new Set(["switch", "drag", "replace", "move", "cant", "faint", "-damage", "-heal", "-sethp", "-status",
  "-boost", "-unboost", "-weather", "-sidestart", "-fieldstart", "-crit", "-supereffective", "-resisted", "-immune", "-miss",
  "-fail", "-ohko", "-transform", "win", "tie", "turn", "-start", "-activate", "-item", "-enditem", "-ability", "-curestatus"]);

export class BattleState {
  /** @param {"p1"|"p2"|null} perspective  the player whose channel this is, null for spectators */
  constructor(perspective = null) {
    this.perspective = perspective;
    this.sides = {};                 // p1/p2 -> Side
    this.gen = 0; this.gameType = "singles"; this.tier = ""; this.turn = 0; this.rules = [];
    this.weather = ""; this.fields = new Set();
    this.started = false; this.teamPreview = 0;   // teamPreview: Pokémon to pick while |teampreview| is pending
    this.ended = false; this.winner = undefined;  // winner: player name, null for a tie
    this.request = null; this.sentChoice = "";
    this.textLog = [];               // [{ text, kind: "turn" | "move" | "info" | "result" | "chat" }]
    this.errors = []; this.inactive = "";
    this.lines = 0;
  }

  side(id) {
    return (this.sides[id] ??= { id, name: id, active: [], team: [], teamsize: 0, conditions: new Map() });
  }

  get me() { return this.perspective ?? "p1"; }
  get foe() { return this.me === "p1" ? "p2" : "p1"; }

  #newMon(s, name, details) {
    const mon = {
      name, details: details ?? "", species: name, level: 100, gender: "", shiny: false,
      hp: 100, maxhp: 100, status: "", fainted: false, boosts: {}, volatiles: new Set(),
      item: "", ability: "", revealedMoves: [], placeholder: false, transformed: "",
    };
    if (details) Object.assign(mon, parseDetails(details));
    s.team.push(mon);
    return mon;
  }

  /** Resolve an ident (+ details on switch-in) to { mon, id, side }; creates the Pokémon when first seen. */
  mon(ident, details, switching = false) {
    const id = parseIdent(ident);
    if (!id) return null;
    const s = this.side(id.side);
    const inSlot = id.slot !== null ? s.active[id.slot] : null;
    if (!switching && inSlot && inSlot.name === id.name) return { mon: inSlot, id, side: s };
    const named = s.team.filter((m) => m.name === id.name && !m.placeholder);
    let mon;
    if (switching) {
      const d = parseDetails(details);
      const free = named.filter((m) => !s.active.includes(m) && !m.fainted);
      mon = free.find((m) => m.details === details);   // same name AND details: species, level, gender, shiny
      if (!mon) {   // a Team Preview placeholder ("Arceus-*" in the preview stands for any Arceus forme)
        const base = d.species.replace(/-.*$/, "");
        mon = s.team.find((m) => m.placeholder && (m.species === d.species || m.species === base || m.species.replace(/-.*$/, "") === base));
        if (mon) { mon.placeholder = false; mon.name = id.name; }
      }
    } else {
      mon = named.find((m) => !m.fainted) ?? named[0];
    }
    if (!mon) mon = this.#newMon(s, id.name, details);
    else if (details) Object.assign(mon, parseDetails(details), { details });
    return { mon, id, side: s };
  }

  /** Name as the log shows it: own Pokémon plain, the foe's "The opposing X", spectators "Alice's X". */
  label(r) {
    if (!this.perspective) return `${r.side.name}'s ${r.mon.name}`;
    return r.side.id === this.perspective ? r.mon.name : `The opposing ${r.mon.name}`;
  }

  log(text, kind = "info") { this.textLog.push({ text, kind }); }

  /** Apply one protocol line. Returns { cmd, side, slot } for the renderer's animation, or null. */
  add(line) {
    if (typeof line !== "string" || line[0] !== "|") return null;
    this.lines++;
    if (line.startsWith("|request|")) {   // JSON: never split on "|"
      const req = line.length > 9 ? JSON.parse(line.slice(9)) : null;
      const cur = this.request?.rqid;
      if (this.ended || (req?.rqid && cur && req.rqid < cur)) return { cmd: "request", stale: true };   // replayed twice after a reconnect
      if (!(req?.rqid && req.rqid === cur)) this.sentChoice = "";
      this.request = req;
      return { cmd: "request" };
    }
    if (line.startsWith("|sentchoice|")) { this.sentChoice = line.slice(12); return { cmd: "sentchoice" }; }
    const { cmd, args, kw } = parseLine(line);
    const from = kw.from ? ` (${fromName(kw.from)})` : "";
    let r = null;
    const who = (i = 0) => (r = this.mon(args[i]));
    switch (cmd) {
      case "player": if (args[1]) this.side(args[0]).name = args[1]; break;
      case "teamsize": this.side(args[0]).teamsize = +args[1]; break;
      case "gen": this.gen = +args[0]; break;
      case "tier": this.tier = args[0]; break;
      case "gametype": this.gameType = args[0]; break;
      case "rule": this.rules.push(args[0]); break;
      case "clearpoke": for (const s of Object.values(this.sides)) s.team = s.team.filter((m) => !m.placeholder); break;
      case "poke": {
        const mon = this.#newMon(this.side(args[0]), "", args[1]);
        mon.placeholder = true;
        mon.species = parseDetails(args[1]).species.replace(/-\*$/, "");
        mon.item = args[2] === "item" ? "?" : "";
        break;
      }
      case "teampreview": this.teamPreview = +args[0] || 6; break;
      case "start": this.started = true; this.teamPreview = 0; this.log("The battle started!", "turn"); break;
      case "turn": this.turn = +args[0]; this.inactive = ""; this.log(`Turn ${this.turn}`, "turn"); break;
      case "inactive": this.inactive = args[0] ?? ""; this.log(args[0] ?? "", "chat"); break;
      case "inactiveoff": this.inactive = ""; break;
      case "error": this.errors.push(args.join("|")); this.sentChoice = ""; break;
      case "chat": case "c": this.log(args.length > 1 ? `${args[0]}: ${args.slice(1).join("|")}` : args[0] ?? "", "chat"); break;
      case "message": case "-message": case "raw": this.log(args.join("|"), "chat"); break;

      case "switch": case "drag": case "replace": {
        r = this.mon(args[0], args[1], true);
        if (!r || r.id.slot === null) break;
        const prev = r.side.active[r.id.slot];
        if (cmd === "replace" && prev && prev !== r.mon) {   // Illusion broke: the slot held someone else all along
          Object.assign(r.mon, { hp: prev.hp, maxhp: prev.maxhp, status: prev.status, boosts: prev.boosts, volatiles: prev.volatiles });
          r.side.active[r.id.slot] = r.mon;
          break;
        }
        if (prev && prev !== r.mon) { prev.boosts = {}; prev.volatiles = new Set(); prev.transformed = ""; }
        Object.assign(r.mon, parseHP(args[2] ?? "100/100"), { boosts: {}, volatiles: new Set(), transformed: "" });
        r.side.active[r.id.slot] = r.mon;
        if (cmd === "switch") {
          const name = r.mon.name === r.mon.species || !r.mon.species ? r.mon.name : `${r.mon.name} (${r.mon.species})`;
          this.log(r.side.id === this.perspective ? `Go! ${name}!` : `${r.side.name} sent out ${name}!`, "move");
        } else this.log(`${this.label(r)} was dragged out!`, "move");
        break;
      }
      case "swap": {   // doubles: |swap|p1a: X|1 moves X to position 1
        const id = parseIdent(args[0]); const to = +args[1];
        if (!id || id.slot === null || !(to >= 0)) break;
        const s = this.side(id.side);
        [s.active[id.slot], s.active[to]] = [s.active[to], s.active[id.slot]];
        break;
      }
      case "detailschange": case "-formechange": {
        if (!who()) break;
        const d = parseDetails(args[1]);
        r.mon.species = d.species;
        if (cmd === "detailschange") Object.assign(r.mon, d, { details: args[1] });
        break;
      }
      case "move": {
        if (!who()) break;
        const move = args[1];
        if (!r.mon.revealedMoves.includes(move) && !kw.from) r.mon.revealedMoves.push(move);
        this.log(`${this.label(r)} used ${move}!`, "move");
        if (kw.miss) this.log(`${this.label(r)}'s attack missed!`);
        if (kw.notarget) this.log("But there was no target...");
        break;
      }
      case "cant": {
        if (!who()) break;
        const reason = effectName(args[1]);
        this.log(`${this.label(r)} ${CANT_TEXT[reason] ?? CANT_TEXT[reason.replace(/ /g, "_")] ?? `can't move (${reason})`}!`);
        break;
      }
      case "-damage": case "-heal": case "-sethp": {
        if (!who()) break;
        const before = r.mon.hp / (r.mon.maxhp || 1);
        Object.assign(r.mon, parseHP(args[1]));
        const pct = Math.round(Math.abs(before - r.mon.hp / (r.mon.maxhp || 1)) * 100);
        if (cmd === "-sethp") break;
        if (!pct) break;
        this.log(cmd === "-damage" ? `${this.label(r)} lost ${pct}% of its health${from}.` : `${this.label(r)} restored ${pct}% of its health${from}.`);
        break;
      }
      case "faint": if (who()) { Object.assign(r.mon, { fainted: true, hp: 0, status: "" }); this.log(`${this.label(r)} fainted!`, "move"); } break;
      case "-status": if (who()) { r.mon.status = args[1]; this.log(`${this.label(r)} ${STATUS_TEXT[args[1]] ?? `got ${args[1]}`}${from}!`); } break;
      case "-curestatus": {
        if (!who()) break;
        const st = args[1] || r.mon.status;
        r.mon.status = "";
        if (!kw.silent) this.log(`${this.label(r)}${CURE_TEXT[st] ?? " was cured"}${from}.`);
        break;
      }
      case "-cureteam": { const id = parseIdent(args[0]); if (id) for (const m of this.side(id.side).team) m.status = ""; this.log("The team's status problems were cured."); break; }
      case "-boost": case "-unboost": {
        if (!who()) break;
        const n = (+args[2] || 0) * (cmd === "-boost" ? 1 : -1);
        r.mon.boosts[args[1]] = Math.max(-6, Math.min(6, (r.mon.boosts[args[1]] ?? 0) + n));
        const stat = STAT_NAME[args[1]] ?? args[1];
        this.log(n === 0 ? `${this.label(r)}'s ${stat} won't go any ${cmd === "-boost" ? "higher" : "lower"}!`
          : `${this.label(r)}'s ${stat} ${n > 0 ? "rose" : "fell"}${Math.abs(n) >= 3 ? " drastically" : Math.abs(n) === 2 ? " sharply" : ""}${from}!`);
        break;
      }
      case "-setboost": if (who()) r.mon.boosts[args[1]] = +args[2]; break;
      case "-clearboost": if (who()) { r.mon.boosts = {}; this.log(`${this.label(r)}'s stat changes were removed!`); } break;
      case "-clearpositiveboost": if (who()) for (const k in r.mon.boosts) if (r.mon.boosts[k] > 0) r.mon.boosts[k] = 0; break;
      case "-clearnegativeboost": if (who()) for (const k in r.mon.boosts) if (r.mon.boosts[k] < 0) r.mon.boosts[k] = 0; break;
      case "-clearallboost":
        for (const s of Object.values(this.sides)) for (const m of s.active) if (m) m.boosts = {};
        this.log("All stat changes were eliminated!");
        break;
      case "-invertboost": if (who()) for (const k in r.mon.boosts) r.mon.boosts[k] = -r.mon.boosts[k]; break;
      case "-copyboost": { const a = this.mon(args[0]), b = this.mon(args[1]); if (a && b) a.mon.boosts = { ...b.mon.boosts }; r = a; break; }
      case "-swapboost": {
        const a = this.mon(args[0]), b = this.mon(args[1]);
        if (!a || !b) break;
        const stats = args[2] ? args[2].split(", ") : Object.keys({ ...a.mon.boosts, ...b.mon.boosts });
        for (const k of stats) [a.mon.boosts[k], b.mon.boosts[k]] = [b.mon.boosts[k] ?? 0, a.mon.boosts[k] ?? 0];
        r = a;
        break;
      }
      case "-start": {
        if (!who()) break;
        const eff = effectName(args[1]);
        if (eff === "typechange" || eff === "typeadd") break;
        if (/^perish\d$/.test(eff)) { for (const v of r.mon.volatiles) if (/^perish\d$/.test(v)) r.mon.volatiles.delete(v); this.log(`${this.label(r)}'s perish count fell to ${eff.slice(6)}.`); }
        else if (eff === "confusion") this.log(`${this.label(r)} became confused${from}!`);
        else if (eff === "Substitute") this.log(`${this.label(r)} put in a substitute!`);
        else this.log(`${this.label(r)}: ${eff} started${from}.`);
        r.mon.volatiles.add(eff);
        break;
      }
      case "-end": {
        if (!who()) break;
        const eff = effectName(args[1]);
        r.mon.volatiles.delete(eff);
        if (kw.silent) break;
        if (eff === "confusion") this.log(`${this.label(r)} snapped out of its confusion!`);
        else if (eff === "Substitute") this.log(`${this.label(r)}'s substitute faded!`);
        else this.log(`${this.label(r)}: ${eff} ended.`);
        break;
      }
      case "-item": if (who()) { r.mon.item = args[1]; this.log(`${this.label(r)} has ${args[1]}${from}.`); } break;
      case "-enditem": {
        if (!who()) break;
        r.mon.item = "";
        this.log(kw.eat ? `${this.label(r)} ate its ${args[1]}!` : `${this.label(r)}'s ${args[1]} was used up${from}.`);
        break;
      }
      case "-ability": if (who()) { r.mon.ability = args[1]; this.log(`[${this.label(r)}'s ${args[1]}]`); } break;
      case "-endability": if (who()) r.mon.ability = ""; break;
      case "-transform": {
        if (!who()) break;
        const t = this.mon(args[1]);
        r.mon.transformed = t ? t.mon.species : "?";
        this.log(`${this.label(r)} transformed into ${t ? t.mon.species : "its target"}!`);
        break;
      }
      case "-weather": {
        const w = args[0] === "none" ? "" : args[0];
        if (kw.upkeep) break;
        if (w) this.log(WEATHER_START[w] ?? `Weather: ${w}`);
        else if (this.weather) this.log(WEATHER_END[this.weather] ?? "The weather cleared.");
        this.weather = w;
        break;
      }
      case "-fieldstart": this.fields.add(effectName(args[0])); this.log(`${effectName(args[0])} started${from}!`); break;
      case "-fieldend": this.fields.delete(effectName(args[0])); this.log(`${effectName(args[0])} ended.`); break;
      case "-sidestart": {
        const s = this.side(args[0].slice(0, 2)), eff = effectName(args[1]);
        s.conditions.set(eff, (s.conditions.get(eff) ?? 0) + 1);
        this.log(`${eff} started on ${this.sideLabel(s)}!`);
        break;
      }
      case "-sideend": {
        const s = this.side(args[0].slice(0, 2)), eff = effectName(args[1]);
        s.conditions.delete(eff);
        this.log(`${eff} ended on ${this.sideLabel(s)}.`);
        break;
      }
      case "-miss": if (args[1]) { r = this.mon(args[1]); if (r) this.log(`${this.label(r)} avoided the attack!`); } else this.log("The attack missed!"); break;
      case "-crit": who(); this.log("A critical hit!"); break;
      case "-supereffective": who(); this.log("It's super effective!"); break;
      case "-resisted": who(); this.log("It's not very effective..."); break;
      case "-immune": if (who()) this.log(`It doesn't affect ${this.label(r)}...`); break;
      case "-fail": who(); this.log("But it failed!"); break;
      case "-block": if (who()) this.log(`${this.label(r)} was protected${from}.`); break;
      case "-notarget": this.log("But there was no target..."); break;
      case "-nothing": this.log("But nothing happened!"); break;
      case "-ohko": this.log("It's a one-hit KO!"); break;
      case "-hitcount": this.log(`Hit ${args[1]} time${args[1] === "1" ? "" : "s"}!`); break;
      case "-mustrecharge": if (who()) this.log(`${this.label(r)} must recharge!`); break;
      case "-prepare": if (who()) this.log(`${this.label(r)} is preparing ${args[1]}!`); break;
      case "-singleturn": case "-singlemove": {
        if (!who()) break;
        const eff = effectName(args[1]);
        if (eff === "Protect" || eff === "Detect" || eff === "Endure") this.log(`${this.label(r)} ${eff === "Endure" ? "braced itself" : "protected itself"}!`);
        else if (eff !== "Focus Punch") this.log(`${this.label(r)}: ${eff}.`);
        break;
      }
      case "-activate": {
        if (!who()) break;
        const eff = effectName(args[1]);
        if (eff === "Protect" || eff === "Detect") this.log(`${this.label(r)} protected itself!`);
        else if (eff === "confusion") this.log(`${this.label(r)} is confused!`);
        else if (eff === "Substitute") this.log(`The substitute took damage for ${this.label(r)}!`);
        else if (eff === "Endure") this.log(`${this.label(r)} endured the hit!`);
        else if (eff) this.log(`${this.label(r)}: ${eff}${args[2] ? ` (${effectName(args[2])})` : ""}.`);
        break;
      }
      case "-center": case "-hint": case "-anim": case "-waiting": case "-combine": case "upkeep": case "t:": case "": case "debug": case "split": break;
      case "win":
        this.winner = args[0]; this.ended = true; this.request = null; this.sentChoice = "";
        this.log(`${args[0]} won the battle!`, "result");
        break;
      case "tie":
        this.winner = null; this.ended = true; this.request = null; this.sentChoice = "";
        this.log("The battle ended in a tie.", "result");
        break;
      default: return { cmd };
    }
    return { cmd, side: r?.side.id ?? null, slot: r?.id.slot ?? null };
  }

  sideLabel(s) {
    if (!this.perspective) return `${s.name}'s side`;
    return s.id === this.perspective ? "your team" : "the opposing team";
  }

  /** Which side won: "p1" | "p2" | null (tie) | undefined (still running). */
  get winnerSide() {
    if (!this.ended) return undefined;
    if (this.winner === null) return null;
    return Object.values(this.sides).find((s) => s.name === this.winner)?.id ?? null;
  }

  /** Pokémon of a side, best known order: the ones seen, then unknown slots up to teamsize. */
  roster(id) {
    const s = this.sides[id];
    if (!s) return [];
    const seen = s.team.filter((m) => !m.placeholder || !this.started);
    const unknown = Math.max(0, (s.teamsize || 0) - seen.length);
    return [...seen, ...Array.from({ length: unknown }, () => null)];
  }
}
