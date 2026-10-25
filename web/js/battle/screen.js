/* The battle screen: both sides with sprites, name plates and HP bars, a field-effects line, the
   running log, and the controls for the pending request (moves with type and PP, switches,
   doubles targets, Team Preview order), a turn timer, forfeit, and the result.

   The field keeps one element per active slot and updates it in place, so HP bars can animate
   (css: .hpbar-fill transition) and sprites are not reloaded on every event. The log only
   appends. Controls are rebuilt when the request or the local choice-in-progress changes; their
   buttons carry nothing but slot numbers, which the server checks again.

   Perspective: a player sees their own side at the bottom (back sprites, exact HP); spectators see
   p1 at the bottom. All text from the protocol (nicknames, player names) goes in as text nodes. */
import { h, clear, confirmDialog, toast } from "../ui.js";
import { WEATHER_NAMES } from "../../shared/battle/state.js";
import { FOE_TARGETS } from "../../shared/battle/ai.js";
import { monSprites, speciesIcon, onSpriteError } from "./sprites.js";

const STATUS_LABEL = { brn: "BRN", par: "PAR", slp: "SLP", frz: "FRZ", psn: "PSN", tox: "TOX" };
const BOOST_LABEL = { atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe", accuracy: "Acc", evasion: "Eva", spc: "Spc" };
const HIDDEN_VOLATILES = new Set(["typechange", "typeadd", "Disable", "stockpile1", "stockpile2", "stockpile3"]);
const ANIM = { move: "attack", "-damage": "hit", faint: "faint", switch: "enter", drag: "enter", replace: "enter", "-heal": "heal", "-status": "status", "-boost": "boost", "-unboost": "drop" };

const hpLevel = (f) => (f > 0.5 ? "high" : f > 0.2 ? "mid" : "low");
const cleanMoveName = (n) => String(n ?? "").replace(/ \d+$/, "");   // "Return 102", "Hidden Power Fire 60"
const condHP = (cond = "") => { const [a, b] = cond.split(" ")[0].split("/").map(Number); return cond.endsWith(" fnt") ? 0 : b ? a / b : 0; };
const condStatus = (cond = "") => { const s = cond.split(" ")[1]; return s && s !== "fnt" ? s : ""; };
const reqName = (p) => p.ident.replace(/^p\d: /, "");
const reqSpecies = (p) => p.details.split(", ")[0];

/* ---------- one active slot ---------- */

function slotView() {
  const name = h("span", { class: "bt-name" });
  const gender = h("span", { class: "bt-gender" });
  const level = h("span", { class: "bt-level" });
  const status = h("span", { class: "bt-status", hidden: true });
  const fill = h("span", { class: "hpbar-fill" });
  const bar = h("div", { class: "hpbar", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100 }, fill);
  const hpText = h("span", { class: "bt-hp" });
  const chips = h("div", { class: "bt-chips" });
  const img = h("img", { class: "bt-sprite", alt: "", draggable: "false", decoding: "async" });
  const placeholder = h("span", { class: "bt-sprite-ph", "aria-hidden": "true" });
  const el = h("div", { class: "bt-slot is-empty" },
    h("div", { class: "bt-plate" },
      h("div", { class: "bt-plate-head" }, name, gender, level, status),
      bar, h("div", { class: "bt-plate-foot" }, hpText), chips),
    h("div", { class: "bt-sprite-wrap" }, img, placeholder));
  let spriteKey = "";
  let animTimer = null;
  return {
    el,
    update(mon, { exact, back, gen, base }) {
      el.classList.toggle("is-empty", !mon);
      if (!mon) { spriteKey = ""; img.removeAttribute("src"); return; }
      el.classList.toggle("is-fainted", !!mon.fainted);
      name.textContent = mon.name || mon.species;
      name.title = mon.species && mon.species !== mon.name ? mon.species : "";
      gender.textContent = mon.gender === "M" ? "♂" : mon.gender === "F" ? "♀" : "";
      gender.className = "bt-gender" + (mon.gender ? " g-" + mon.gender : "");
      level.textContent = `Lv${mon.level}`;
      status.hidden = !mon.status;
      status.textContent = STATUS_LABEL[mon.status] ?? mon.status ?? "";
      status.className = "bt-status st-" + (mon.status || "none");
      const frac = mon.maxhp ? Math.max(0, Math.min(1, mon.hp / mon.maxhp)) : 0;
      bar.style.setProperty("--hp", frac.toFixed(3));
      bar.dataset.level = hpLevel(frac);
      bar.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
      bar.setAttribute("aria-label", `${mon.name} HP`);
      hpText.textContent = mon.fainted ? "fainted" : exact ? `${mon.hp}/${mon.maxhp}` : `${Math.max(mon.hp > 0 ? 1 : 0, Math.round(frac * 100))}%`;
      const chipList = [];
      for (const [k, v] of Object.entries(mon.boosts ?? {})) if (v) chipList.push(h("span", { class: ["bt-chip", v > 0 ? "up" : "down"] }, `${BOOST_LABEL[k] ?? k} ${v > 0 ? "+" : ""}${v}`));
      for (const v of mon.volatiles ?? []) if (!HIDDEN_VOLATILES.has(v)) chipList.push(h("span", { class: "bt-chip" }, v.replace(/^perish(\d)$/, "Perish $1")));
      if (mon.transformed) chipList.push(h("span", { class: "bt-chip" }, `→ ${mon.transformed}`));
      clear(chips, chipList);
      const key = [mon.species, mon.transformed, mon.shiny, mon.gender, back, gen, base].join("|");
      if (key !== spriteKey) {
        spriteKey = key;
        const urls = monSprites(mon, { gen, back, base });
        img.classList.remove("is-missing");
        img.alt = mon.transformed || mon.species || "";
        if (urls.length) { img.dataset.fallback = urls.slice(1).join(" "); img.src = urls[0]; }
        else { img.removeAttribute("src"); img.classList.add("is-missing"); }
        placeholder.textContent = String(mon.species || "?").slice(0, 1);
      }
    },
    animate(kind) {
      el.classList.remove(...[...el.classList].filter((c) => c.startsWith("anim-")));
      void el.offsetWidth;   // restart the CSS animation
      el.classList.add("anim-" + kind);
      clearTimeout(animTimer);
      animTimer = setTimeout(() => el.classList.remove("anim-" + kind), 700);
    },
  };
}

/* ---------- the screen ---------- */

/**
 * app: the widget app; client: a BattleClient (joined); hooks: { onExit(), onRematch(summary) }.
 * Returns { el, update(ev), destroy() }.
 */
export function createBattleScreen(app, client, { onExit, onRematch } = {}) {
  const base = app.config?.spriteBase ?? "";
  const title = h("span", { class: "bt-title" });
  const turnEl = h("span", { class: "bt-turn" });
  const timerEl = h("span", { class: "bt-timer", hidden: true, role: "timer" });
  const forfeitBtn = h("button", { type: "button", class: "btn btn-sm btn-danger", onclick: forfeit }, "Forfeit");
  const backBtn = h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => onExit?.() }, "‹ Lobby");
  const sides = { top: sideView("foe"), bottom: sideView("me") };
  const effects = h("div", { class: "bt-effects", "aria-label": "Field effects" });
  const field = h("div", { class: "bt-field" }, sides.top.el, effects, sides.bottom.el);
  const log = h("div", { class: "bt-log", role: "log", "aria-live": "polite", "aria-label": "Battle log" });
  const controls = h("div", { class: "bt-controls" });
  const result = h("div", { class: "bt-result", hidden: true });
  const el = h("section", { class: "bt-screen" },
    h("header", { class: "bt-head" }, backBtn, h("div", { class: "bt-head-text" }, title, turnEl), timerEl, forfeitBtn),
    field, result, controls, log);
  el.addEventListener("error", onSpriteError, true);   // capture: error events do not bubble

  let logCount = 0;
  let pick = null;                 // choice in progress: { rqid, parts: [], slot, move: null, order: [] }
  let controlsKey = "";
  const tick = setInterval(renderTimer, 500);

  function sideView(kind) {
    const name = h("span", { class: "bt-trainer-name" });
    const balls = h("span", { class: "bt-balls" });
    const slots = h("div", { class: "bt-slots" });
    const views = [];
    const el = h("div", { class: ["bt-side", "bt-" + kind] }, h("div", { class: "bt-trainer" }, name, balls), slots);
    return { el, name, balls, slots, views };
  }

  const persp = () => (client.isPlayer ? client.role : "p1");
  const other = (s) => (s === "p1" ? "p2" : "p1");

  function renderSide(view, sideId, bottom) {
    const st = client.state;
    const side = st.sides[sideId];
    view.name.textContent = side?.name && side.name !== sideId ? side.name : client.battle?.players?.[sideId]?.name ?? sideId;
    const n = st.gameType === "doubles" ? 2 : 1;
    while (view.views.length < n) { const sv = slotView(); view.views.push(sv); view.slots.appendChild(sv.el); }
    while (view.views.length > n) view.views.pop().el.remove();
    const gen = Math.min(5, Math.max(1, st.gen || 5));
    // Slots run in opposite directions (SIM-PROTOCOL.md): ours a, b from the left; the foe's b, a.
    const order = bottom ? view.views : [...view.views].reverse();
    if (order.some((sv, k) => view.slots.children[k] !== sv.el)) for (const sv of order) view.slots.appendChild(sv.el);
    view.views.forEach((sv, slot) => sv.update(side?.active[slot] ?? null, { exact: client.isPlayer && sideId === client.role, back: bottom, gen, base }));
    // party balls: own team from the request (exact), others from what has been seen
    const req = st.request;
    let marks;
    if (client.isPlayer && sideId === client.role && req?.side?.pokemon) {
      marks = req.side.pokemon.map((p) => ({ name: reqName(p), out: p.condition.endsWith(" fnt"), status: condStatus(p.condition) }));
    } else {
      marks = st.roster(sideId).map((m) => (m ? { name: m.name || m.species, out: m.fainted, status: m.status } : null));
    }
    clear(view.balls, marks.map((m) => h("i", { class: ["bt-ball", !m && "unknown", m?.out && "out", m?.status && "status"], title: m ? m.name : "Not seen yet" })));
  }

  function renderEffects() {
    const st = client.state;
    const chips = [];
    if (st.weather) chips.push(h("span", { class: "bt-effect weather" }, WEATHER_NAMES[st.weather] ?? st.weather));
    for (const f of st.fields) chips.push(h("span", { class: "bt-effect field" }, f));
    for (const sideId of ["p1", "p2"]) {
      const s = st.sides[sideId];
      if (!s?.conditions.size) continue;
      const whose = client.isPlayer ? (sideId === client.role ? "You" : "Foe") : s.name;
      for (const [c, n] of s.conditions) chips.push(h("span", { class: ["bt-effect", "side", sideId === persp() ? "mine" : "theirs"] }, `${whose}: ${c}${n > 1 ? ` ×${n}` : ""}`));
    }
    clear(effects, chips);
    effects.hidden = !chips.length;
  }

  function renderLog(reset) {
    const entries = client.state.textLog;
    if (reset || entries.length < logCount) { clear(log); logCount = 0; }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    for (; logCount < entries.length; logCount++) {
      const e = entries[logCount];
      if (!e.text) continue;
      log.appendChild(h("p", { class: "bt-log-" + e.kind }, e.text));
    }
    if (atBottom || reset) log.scrollTop = log.scrollHeight;
  }

  function renderHeader() {
    const b = client.battle;
    const st = client.state;
    const names = ["p1", "p2"].map((s) => st.sides[s]?.name && st.sides[s].name !== s ? st.sides[s].name : b?.players?.[s]?.name ?? s);
    title.textContent = `${names[0]} vs ${names[1]}`;
    title.title = b?.desc ?? st.tier;
    turnEl.textContent = [b?.desc, st.turn ? `Turn ${st.turn}` : st.teamPreview ? "Team Preview" : ""].filter(Boolean).join(" · ");
    forfeitBtn.hidden = !client.isPlayer || st.ended || client.finished;
    renderTimer();
  }

  function renderTimer() {
    const ms = client.timeLeft();
    const show = ms !== null && client.isPlayer && !client.busy;
    timerEl.hidden = !show;
    if (!show) return;
    const s = Math.max(0, Math.ceil(ms / 1000));
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    timerEl.classList.toggle("urgent", s <= 10);
    timerEl.title = "Time left to choose; when it runs out a move is picked for you (the third time, you lose).";
  }

  function renderResult() {
    const st = client.state;
    result.hidden = !st.ended;
    if (!st.ended) return;
    const win = st.winnerSide;
    const text = win === null ? "It's a tie." : client.isPlayer ? (win === client.role ? "You won!" : `${st.winner} won.`) : `${st.winner} won!`;
    const b = client.battle;
    clear(result,
      h("div", { class: ["bt-result-text", client.isPlayer && win === client.role && "won"] }, text),
      b?.note ? h("p", { class: "muted small" }, b.note) : null,
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn btn-primary", onclick: () => onExit?.() }, "Back to the lobby"),
        client.isPlayer && onRematch ? h("button", { type: "button", class: "btn", onclick: () => onRematch(b) }, b?.practice ? "Play again" : "Rematch") : null));
  }

  /* ----- controls ----- */

  function renderControls() {
    const st = client.state;
    const req = st.request;
    if (st.ended || client.finished) { clear(controls); controls.hidden = true; controlsKey = ""; return; }
    controls.hidden = false;
    if (!client.isPlayer) {
      if (controlsKey !== "watching") clear(controls, h("p", { class: "bt-wait" }, "You are watching this battle."));
      controlsKey = "watching";
      return;
    }
    if (client.busy) return;   // let the animation finish; the request shows after it
    const foeName = st.sides[other(client.role)]?.name ?? "the opponent";
    if (!req) { clear(controls, h("p", { class: "bt-wait" }, "Waiting for the battle to start…")); controlsKey = ""; return; }
    if (req.wait || st.sentChoice) {
      clear(controls, h("div", { class: "bt-wait" },
        h("span", { class: "spinner", "aria-hidden": "true" }), ` Waiting for ${foeName}…`,
        st.sentChoice && !req.wait ? h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: undo }, "Change my choice") : null));
      controlsKey = "";
      pick = null;
      return;
    }
    if (!pick || pick.rqid !== req.rqid) {
      pick = { rqid: req.rqid, parts: [], move: null, order: [] };
      if (!req.teamPreview && skipPasses(req)) return;
    }
    const key = JSON.stringify([req.rqid, pick.parts, pick.move, pick.order]);
    if (key === controlsKey) return;
    controlsKey = key;
    if (req.teamPreview) return clear(controls, teamPreview(req));
    clear(controls, slotChooser(req));
  }

  /** Slots of the request (1 in singles, 2 in doubles). */
  const slotCount = (req) => (req.forceSwitch ?? req.active ?? []).length;
  const takenSwitches = () => pick.parts.map((p) => /^switch (\d)/.exec(p)?.[1]).filter(Boolean).map(Number);
  const benchOf = (req) => req.side.pokemon.map((p, k) => ({ p, n: k + 1 })).filter(({ p, n }) => !p.active && !p.condition.endsWith(" fnt") && !takenSwitches().includes(n));

  /** Does slot i need a decision from the player (else it is a "pass")? */
  function needsChoice(req, i) {
    if (req.forceSwitch) return !!req.forceSwitch[i] && benchOf(req).length > 0;
    const mon = req.side.pokemon[i];
    return !!mon && !mon.condition.endsWith(" fnt") && !mon.commanding;
  }

  /** Fill in passes; when every slot is decided, send the choice. Returns true when sent. */
  function skipPasses(req) {
    while (pick.parts.length < slotCount(req) && !needsChoice(req, pick.parts.length)) pick.parts.push("pass");
    if (pick.parts.length < slotCount(req)) return false;
    send(pick.parts.join(", "));
    return true;
  }

  function back() {
    while (pick.parts.at(-1) === "pass") pick.parts.pop();
    pick.parts.pop();
    pick.move = null;
    const req = client.state.request;
    while (pick.parts.length < slotCount(req) && !needsChoice(req, pick.parts.length)) pick.parts.push("pass");
    controlsKey = "";
    renderControls();
  }

  function slotChooser(req) {
    const i = pick.parts.length;
    const mon = req.side.pokemon[i];
    const doubles = slotCount(req) > 1;
    const taken = takenSwitches();
    const canGoBack = pick.parts.some((p) => p !== "pass");
    const head = h("div", { class: "bt-prompt" },
      h("span", null, req.forceSwitch ? `Choose a Pokémon to send out${doubles ? ` for slot ${i + 1}` : ""}` : `What will ${reqName(mon)} do?`),
      canGoBack ? h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: back }, "‹ Back") : null);
    if (pick.move) return h("div", null, head, targetChooser(req, i));
    const act = req.active?.[i];
    const parts = [head];
    if (!req.forceSwitch && act) {
      const usable = act.moves.filter((m) => !m.disabled && m.pp !== 0);
      parts.push(h("div", { class: "move-grid" }, act.moves.map((m, j) => {
        const disabled = !!m.disabled || (m.pp === 0 && usable.length > 0);
        return h("button", {
          type: "button", class: ["bt-move", m.type && "t-" + m.type.toLowerCase()], disabled,
          title: [m.type, m.category, m.power && `Power ${m.power}`].filter(Boolean).join(" · "),
          onclick: () => chooseMove(req, i, j, m),
        },
        h("span", { class: "bt-move-name" }, cleanMoveName(m.move)),
        h("span", { class: "bt-move-meta" },
          m.type ? h("span", { class: ["type", "type-" + m.type.toLowerCase()] }, m.type) : null,
          m.maxpp ? h("span", { class: "bt-pp" }, `${m.pp}/${m.maxpp}`) : null));
      })));
    }
    const trapped = !req.forceSwitch && (act?.trapped);
    if (!trapped) {
      parts.push(h("div", { class: "bt-switches" },
        req.side.pokemon.map((p, k) => {
          const n = k + 1;
          const out = p.condition.endsWith(" fnt");
          const disabled = p.active || out || taken.includes(n);
          const frac = condHP(p.condition);
          const icon = speciesIcon(reqSpecies(p), base);
          return h("button", { type: "button", class: ["bt-switch", out && "is-fainted", p.active && "is-active"], disabled, onclick: () => choosePart(`switch ${n}`), title: p.details },
            icon ? h("img", { class: "bt-icon", src: icon, alt: "", "data-fallback": "" }) : null,
            h("span", { class: "bt-switch-name" }, reqName(p)),
            h("span", { class: "hpbar hpbar-sm", style: { "--hp": frac.toFixed(3) }, dataset: { level: hpLevel(frac) } }, h("span", { class: "hpbar-fill" })),
            condStatus(p.condition) ? h("span", { class: "bt-status st-" + condStatus(p.condition) }, STATUS_LABEL[condStatus(p.condition)]) : null);
        })));
    } else parts.push(h("p", { class: "muted small" }, `${reqName(mon)} can't be switched out.`));
    if (!req.forceSwitch) parts.push(h("div", { class: "row bt-actions" },
      h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => choosePart("default") }, "Let the game choose")));
    return h("div", { class: "bt-chooser" }, parts);
  }

  function chooseMove(req, i, j, m) {
    const doubles = (req.active ?? []).length > 1;
    if (doubles && (FOE_TARGETS.has(m.target) || m.target === "adjacentAlly" || m.target === "adjacentAllyOrSelf")) {
      pick.move = { j, target: m.target, name: cleanMoveName(m.move) };
      controlsKey = "";
      renderControls();
      return;
    }
    choosePart(`move ${j + 1}`);
  }

  function targetChooser(req, i) {
    const st = client.state;
    const m = pick.move;
    const foeSide = st.sides[other(client.role)];
    const mine = st.sides[client.role];
    const buttons = [];
    const add = (label, target, mon) => buttons.push(h("button", { type: "button", class: "btn bt-target", disabled: !mon || mon.fainted, onclick: () => { pick.move = null; choosePart(`move ${m.j + 1} ${target}`); } },
      h("span", null, mon ? mon.name : "(empty)"), h("small", { class: "muted" }, label)));
    // as drawn: the foe's slot b (+2) on the left, slot a (+1) on the right
    if (FOE_TARGETS.has(m.target)) [1, 0].forEach((k) => add(k === 1 ? "foe, left" : "foe, right", k + 1, foeSide?.active[k]));
    if (m.target !== "adjacentFoe") {
      const ally = 1 - i;
      if (m.target === "adjacentAllyOrSelf") add("itself", -(i + 1), mine?.active[i]);
      add("partner", -(ally + 1), mine?.active[ally]);
    }
    return h("div", null,
      h("p", { class: "bt-prompt" }, `${m.name}: choose a target`,
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => { pick.move = null; controlsKey = ""; renderControls(); } }, "‹ Back")),
      h("div", { class: "bt-targets" }, buttons));
  }

  function teamPreview(req) {
    const max = req.maxChosenTeamSize || req.side.pokemon.length;
    const order = pick.order;
    const mons = req.side.pokemon.map((p, k) => {
      const at = order.indexOf(k + 1);
      return h("button", {
        type: "button", class: ["bt-switch", at >= 0 && "is-picked"], disabled: at < 0 && order.length >= max,
        onclick: () => { if (at >= 0) order.splice(at, 1); else order.push(k + 1); controlsKey = ""; renderControls(); },
        "aria-pressed": at >= 0 ? "true" : "false",
      },
      speciesIcon(reqSpecies(p), base) ? h("img", { class: "bt-icon", src: speciesIcon(reqSpecies(p), base), alt: "", "data-fallback": "" }) : null,
      h("span", { class: "bt-switch-name" }, reqName(p)), h("small", { class: "muted" }, reqSpecies(p) !== reqName(p) ? reqSpecies(p) : p.details.split(", ").slice(1).join(" ")),
      at >= 0 ? h("span", { class: "bt-order" }, String(at + 1)) : null);
    });
    const rest = req.side.pokemon.map((_, k) => k + 1).filter((n) => !order.includes(n));
    return h("div", { class: "bt-chooser" },
      h("p", { class: "bt-prompt" }, max < req.side.pokemon.length ? `Pick ${max} Pokémon in the order they go in (first = lead).` : "Choose your lead, then the order of the rest."),
      h("div", { class: "bt-switches" }, mons),
      h("div", { class: "row bt-actions" },
        h("button", { type: "button", class: "btn btn-primary", disabled: !order.length, onclick: () => send(`team ${[...order, ...rest].join("")}`) }, "Confirm"),
        h("button", { type: "button", class: "btn btn-ghost", onclick: () => send("default") }, "Team order")));
  }

  function choosePart(part) {
    if (part === "default") return send("default");
    pick.parts.push(part);
    if (skipPasses(client.state.request)) return;
    controlsKey = "";
    renderControls();
  }

  async function send(choice) {
    try { await client.choose(choice); }
    catch (e) { toast(e.message, "error"); pick = null; controlsKey = ""; renderControls(); }
  }

  async function undo() {
    try { await client.undo(); } catch (e) { toast(e.message, "error"); }
  }

  async function forfeit() {
    if (!(await confirmDialog("Give up this battle? Your opponent wins.", { title: "Forfeit", confirmLabel: "Forfeit", danger: true }))) return;
    try { await client.forfeit(); } catch (e) { toast(e.message, "error"); }
  }

  /* ----- updates ----- */

  function render(reset = false) {
    const me = persp();
    renderSide(sides.top, other(me), false);
    renderSide(sides.bottom, me, true);
    field.className = `bt-field gen${Math.min(5, Math.max(1, client.state.gen || 5))} ${client.state.gameType === "doubles" ? "doubles" : "singles"}`;
    renderEffects();
    renderLog(reset);
    renderHeader();
    renderResult();
    renderControls();
  }

  function update(ev = {}) {
    if (ev.type === "reset") { pick = null; controlsKey = ""; render(true); return; }
    if (ev.type === "choice") { controlsKey = ""; renderControls(); return; }
    render(false);
    if (ev.type === "event" && ev.side && ev.slot !== null && ev.slot !== undefined && ANIM[ev.cmd]) {
      const view = ev.side === persp() ? sides.bottom : sides.top;
      view.views[ev.slot]?.animate(ANIM[ev.cmd]);
    }
    if (ev.type === "event" && ev.cmd === "error") {
      const msg = client.state.errors.at(-1)?.replace(/^\[[^\]]+\] /, "");
      if (msg) toast(msg, "warn");
      pick = null; controlsKey = "";
    }
  }

  render(true);
  return { el, update, destroy() { clearInterval(tick); } };
}
