/* Trade tab: offer a Home Pokémon to someone in this room (or to anyone), answer offers,
   confirm, and see what the trade will do before it happens.

   Each trade is drawn as two sides with an arrow between them. A side shows the Pokémon, its
   generation, and what receiving it will do: "Evolves into Steelix" or "An Everstone stops it
   evolving", worked out by the server with the rules of that Pokémon's own generation. A
   Pokémon another player's Home has seen before (a possible clone, server/home.js) is flagged on
   the card, so nobody trades for one without knowing.

   The server keeps the state; this view re-reads GET /api/trades whenever a { type: "trade" }
   push arrives, and confirms only the exact pair it showed (the server answers 409 otherwise). */
import { h, clear, toast, dialog, confirmDialog, emptyState, badge, fmtRelative, spinner } from "../ui.js";
import { monSprite, genLabel } from "../components/mon-sprite.js";
import { pickFromHome } from "../components/home-picker.js";
import { homeState } from "../home/state.js";
import { speciesName } from "../../shared/data/index.js";

const STATUS = { open: "Waiting for an answer", answered: "Waiting for confirmations", done: "Traded", cancelled: "Cancelled", expired: "Expired" };

export async function mount(el, app) {
  const home = homeState(app);
  const base = app.config.spriteBase;
  const me = app.user.id;
  let data = { mine: [], open: [] };
  const root = h("div", { class: "view-inner trade-view" }, spinner("Loading trades…"));
  el.append(root);

  async function refresh() {
    try {
      data = await app.api.get(`api/trades?roomId=${encodeURIComponent(app.roomId)}`);
      render();
    } catch (e) { clear(root, emptyState({ title: "Trades did not load", text: e.message, action: { label: "Retry", onClick: refresh } })); }
  }
  app.ws.on("trade", (m) => {
    const t = m.trade;
    if (t.status === "done" && (t.from.user === me || t.to?.user === me)) {
      const got = t.from.user === me ? t.to.mon : t.from.mon;
      toast(`Trade done: you received ${got ? got.summary.speciesName : "a Pokémon"}.`, "ok", { timeout: 8000 });
    } else if (t.status === "open" && t.to === null && t.from.user !== me && t.roomId === app.roomId) {
      toast(`${t.from.name || app.nameOf(t.from.user)} is offering ${t.from.mon?.summary.speciesName ?? "a Pokémon"}.`, "info", { action: { label: "See", onClick: () => app.go("trade") } });
    } else if (t.to?.user === me && t.status === "open") {
      toast(`${t.from.name || app.nameOf(t.from.user)} offers you a trade.`, "info", { action: { label: "See", onClick: () => app.go("trade") } });
    }
    refresh();
  });
  app.on("tab", (name) => { if (name === "trade") refresh(); });
  app.on("room", () => refresh());

  function render() {
    const active = data.mine.filter((t) => t.status === "open" || t.status === "answered");
    const past = data.mine.filter((t) => !active.includes(t));
    clear(root,
      h("div", { class: "row trade-head" },
        h("h2", { class: "home-title" }, "Trades"),
        h("button", { type: "button", class: "btn btn-primary", onclick: newOffer }, "Offer a Pokémon…")),
      section("Your trades", active, "No trades in progress. Offer a Pokémon from your Home to someone here, or to anyone in the room."),
      section("Open offers in this room", data.open, "Nobody here has an open offer right now."),
      past.length ? section("Recently finished", past) : null,
      h("details", { class: "help" }, h("summary", null, "How trading works"),
        h("ul", { class: "help-list" },
          h("li", null, "Offer a Pokémon from your Home, to one person or to anyone in this room. While it is offered it can't be moved or withdrawn."),
          h("li", null, "The other player answers with one of theirs. Both of you confirm; the server swaps them in one step."),
          h("li", null, "Trade evolutions happen the way the Pokémon's own game does them (a Gen 2 Onix needs its Metal Coat; an Everstone stops it). Moves it would learn on evolving are not taught."),
          h("li", null, "Received Pokémon arrive in the slot your traded Pokémon left. Withdraw them into any save of their generation."))));
  }

  function section(title, trades, empty) {
    return h("section", { class: "card" },
      h("h3", { class: "section-label" }, title),
      trades.length ? h("div", { class: "trade-list" }, trades.map(tradeCard)) : h("p", { class: "field-hint" }, empty));
  }

  function tradeCard(t) {
    const mineFrom = t.from.user === me, mineTo = t.to?.user === me;
    const party = mineFrom || mineTo;
    const myOk = mineFrom ? t.fromOk : mineTo ? t.toOk : false;
    const actions = [];
    if (t.status === "open" || t.status === "answered") {
      if (!mineFrom && (t.to === null || mineTo)) actions.push(h("button", { type: "button", class: "btn" + (t.status === "open" ? " btn-primary" : ""), onclick: () => answer(t) }, mineTo && t.to?.mon ? "Offer a different one" : "Answer with…"));
      if (party && t.status === "answered" && !myOk) actions.push(h("button", { type: "button", class: "btn btn-primary", onclick: () => confirmTrade(t) }, "Confirm trade"));
      if (party) actions.push(h("button", { type: "button", class: "btn btn-ghost", onclick: () => cancel(t) }, "Cancel"));
    }
    // A finished trade shows the Pokémon as they are now (evolved on arrival), so say who gave them.
    const gave = t.status === "done" ? " gave" : "";
    const fromName = (mineFrom ? "You" : t.from.name || app.nameOf(t.from.user)) + gave;
    const toName = !t.to ? (t.status === "open" ? "Anyone here" : "—") : (mineTo ? "You" : t.to.name || app.nameOf(t.to.user)) + gave;
    const evolvedNote = t.result?.evolved?.length
      ? h("p", { class: "trade-evo" }, t.result.evolved.map((e) => `${speciesName(e.from)} evolved into ${speciesName(e.to)}.`).join(" "))
      : null;
    return h("article", { class: `trade-card status-${t.status}` },
      h("div", { class: "trade-sides" },
        sideBox(fromName, t.from.mon, t.status === "answered" || t.status === "done" ? t.fromOk || t.status === "done" : null),
        h("div", { class: "trade-arrow", "aria-hidden": "true" }, "⇄"),
        t.to?.mon ? sideBox(toName, t.to.mon, t.toOk || t.status === "done")
          : h("div", { class: "trade-side trade-side-empty" }, h("div", { class: "trade-who" }, toName),
              h("p", { class: "field-hint" }, t.wanted?.note ? `Wants: ${t.wanted.note}` : "Waiting for an answer"))),
      evolvedNote,
      h("div", { class: "row trade-foot" },
        badge(STATUS[t.status] || t.status, t.status === "done" ? "ok" : t.status === "answered" ? "warn" : "muted"),
        h("span", { class: "field-hint" }, fmtRelative(t.updatedAt)),
        h("span", { class: "spacer" }), actions));
  }

  function sideBox(who, mon, confirmed) {
    if (!mon) return h("div", { class: "trade-side" }, h("div", { class: "trade-who" }, who));
    const v = { ...mon.summary, gen: Number(mon.format.slice(2)), format: mon.format };
    const evo = mon.evolves;
    return h("div", { class: "trade-side" },
      h("div", { class: "trade-who" }, who, confirmed === true ? h("span", { class: "trade-ok", title: "Confirmed" }, " ✓") : null),
      h("div", { class: "trade-mon" },
        h("div", { class: "trade-art" }, monSprite(v, base, { className: "mini-sprite" })),
        h("div", { class: "trade-mon-text" },
          h("strong", null, v.isEgg ? "Egg" : v.isNicknamed ? `${v.nickname} (${v.speciesName})` : v.speciesName),
          h("span", { class: "field-hint" }, `${v.isEgg ? "" : "Lv. " + v.level + " · "}${genLabel(mon.format)}${mon.game ? " " + mon.game : ""}${v.heldItem ? " · @" + v.heldItem : ""}${v.shiny ? " · ★" : ""}`))),
      evo && (evo.blockedBy
        ? h("div", { class: "trade-evo is-blocked" }, `${evo.blockedBy} stops it evolving into ${speciesName(evo.to)}`)
        : h("div", { class: "trade-evo" }, `Evolves into ${speciesName(evo.to)}`)),
      mon.flags?.includes("seen-before") && h("div", { class: "trade-warn" }, "Seen before: this exact Pokémon was in another player's Home. It may be a clone."));
  }

  /* ---------- actions ---------- */

  const tradable = (m) => (m.locked ? `Can't trade it: ${m.locked}.` : null);

  async function newOffer() {
    let hd;
    try { hd = await home.refresh(); } catch (e) { toast(e.message, "error"); return; }
    if (!hd.boxes.some((b) => b.mons.some((m) => !m.locked))) {
      toast("Your Home has nothing to offer yet. Deposit Pokémon from a save first.", "warn", { action: { label: "Saves", onClick: () => app.go("saves") } });
      return;
    }
    const people = new Map();
    for (const u of app.presence()) if (u.id !== me) people.set(u.id, app.nameOf(u.id));
    for (const m of app.members()) if (m.id !== me && !people.has(m.id)) people.set(m.id, m.name || m.id);
    const to = h("select", { class: "input" }, h("option", { value: "" }, "Anyone in this room"),
      [...people].map(([id, name]) => h("option", { value: id }, `${name}${app.presence().some((u) => u.id === id) ? " (here now)" : ""}`)));
    const wants = h("input", { class: "input", maxlength: 140, placeholder: "e.g. a Gen 3 Eevee, anything shiny" });
    const ids = await pickFromHome({
      data: hd, base, title: "Offer a Pokémon", allow: tradable, confirmLabel: "Next",
      note: h("div", { class: "row-fields row" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Offer to"), to),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "You'd like (optional)"), wants)),
    });
    if (!ids) return;
    try {
      await app.api.post("api/trades", { roomId: app.roomId, to: to.value || null, offerMonId: ids[0], wanted: wants.value.trim() ? { note: wants.value.trim() } : null });
      toast("Offer sent.", "ok");
      home.refresh().catch(() => {});
      refresh();
    } catch (e) { toast(e.message, "error", { timeout: 9000 }); }
  }

  async function answer(t) {
    let hd;
    try { hd = await home.refresh(); } catch (e) { toast(e.message, "error"); return; }
    const offered = t.from.mon ? `${t.from.name || app.nameOf(t.from.user)} offers ${t.from.mon.summary.speciesName} Lv. ${t.from.mon.summary.level} (${genLabel(t.from.mon.format)}).` : "";
    const ids = await pickFromHome({
      data: hd, base, title: "Answer with…", allow: (m) => (m.id === t.to?.mon?.id ? null : tradable(m)),
      preselect: t.to?.mon && t.to.user === me ? [t.to.mon.id] : [], confirmLabel: "Offer this one",
      note: h("p", { class: "field-hint" }, offered, t.wanted?.note ? ` They'd like: ${t.wanted.note}.` : "", " Both of you confirm before anything moves."),
    });
    if (!ids) return;
    try { await app.api.post(`api/trades/${encodeURIComponent(t.id)}/answer`, { monId: ids[0] }); refresh(); home.refresh().catch(() => {}); }
    catch (e) { toast(e.message, "error", { timeout: 9000 }); }
  }

  async function confirmTrade(t) {
    const mineFrom = t.from.user === me;
    const give = mineFrom ? t.from.mon : t.to.mon, get = mineFrom ? t.to.mon : t.from.mon;
    const lines = [
      `You give ${give.summary.speciesName} Lv. ${give.summary.level} and get ${get.summary.speciesName} Lv. ${get.summary.level} (${genLabel(get.format)}).`,
      get.evolves && !get.evolves.blockedBy ? `It will evolve into ${speciesName(get.evolves.to)}.` : "",
      get.flags?.includes("seen-before") ? "Warning: the Pokémon you get was seen in another player's Home before. It may be a clone." : "",
    ].filter(Boolean);
    const ok = await dialog({ title: "Confirm this trade?", body: h("div", null, lines.map((l) => h("p", null, l))),
      buttons: [{ label: "Not yet", value: false, kind: "ghost" }, { label: "Confirm", value: true, kind: "primary" }] });
    if (!ok) return;
    try {
      const r = await app.api.post(`api/trades/${encodeURIComponent(t.id)}/confirm`, { fromMon: t.from.mon.id, toMon: t.to.mon.id });
      toast(r.status === "done" ? "Trade done!" : "Confirmed. Waiting for the other player.", "ok");
      refresh(); home.refresh().catch(() => {});
    } catch (e) { toast(e.message, "error", { timeout: 9000 }); refresh(); }
  }

  async function cancel(t) {
    if (!(await confirmDialog("Both Pokémon stay where they are.", { title: "Cancel this trade?", confirmLabel: "Cancel trade", cancelLabel: "Keep it", danger: true }))) return;
    try { await app.api.post(`api/trades/${encodeURIComponent(t.id)}/cancel`); refresh(); home.refresh().catch(() => {}); }
    catch (e) { toast(e.message, "error"); }
  }

  await refresh();
}
