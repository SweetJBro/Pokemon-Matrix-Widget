/* The battle lobby: who is here to challenge, challenges in and out, your running battles, the
   room's battles to watch, and recent results. A pure render of the data the view keeps; every
   action is a callback. */
import { h, avatar, badge, fmtRelative, plural } from "../ui.js";

function card(title, body, extra) {
  return h("div", { class: "card bt-card" }, h("div", { class: "bt-card-head" }, h("h3", { class: "section-label" }, title), extra ?? null), body);
}

function battleLine(b, me, actions) {
  const side = b.players.p1.id === me ? "p1" : b.players.p2.id === me ? "p2" : null;
  const vs = side ? `vs ${b.players[side === "p1" ? "p2" : "p1"].name}` : `${b.players.p1.name} vs ${b.players.p2.name}`;
  let status = null;
  if (b.status === "active") status = badge(b.turn ? `turn ${b.turn}` : "starting", "ok");
  else if (b.status === "aborted") status = badge("ended early", "warn");
  else if (b.winner) status = badge(side ? (b.winner === side ? "you won" : "you lost") : `${b.winnerName} won`, side && b.winner === side ? "accent" : null);
  else status = badge("tie");
  return h("li", { class: "bt-line" },
    h("div", { class: "bt-line-text" },
      h("span", { class: "bt-line-title" }, vs, " ", status),
      h("span", { class: "bt-line-sub" }, b.desc, b.endedAt ? ` · ${fmtRelative(b.endedAt)}` : "")),
    h("div", { class: "bt-line-actions" }, actions));
}

/**
 * data: { me, people: [{ id, name, activity?, battleId? }], challenges: [Challenge], battles: [Summary], recent: [Summary], loading, error }
 * on: { practice(), challenge(personId?), accept(c), decline(c), cancel(c), open(battleId) }
 */
export function renderLobby(data, on) {
  const me = data.me;
  const incoming = data.challenges.filter((c) => c.to.id === me && c.status === "pending");
  const outgoing = data.challenges.filter((c) => c.from.id === me && c.status === "pending");
  const mine = data.battles.filter((b) => b.status === "active" && (b.players.p1.id === me || b.players.p2.id === me));
  const watch = data.battles.filter((b) => b.status === "active" && !mine.includes(b));
  const others = data.people.filter((p) => p.id !== me);
  const btn = (label, fn, kind = "", extra = {}) => h("button", { type: "button", class: ["btn", "btn-sm", kind && "btn-" + kind], onclick: fn, ...extra }, label);

  return h("div", { class: "view-inner bt-lobby" },
    h("div", { class: "card bt-hero" },
      h("div", { class: "bt-hero-text" },
        h("h2", null, "Battle"),
        h("p", { class: "muted" }, "Challenge someone who has the widget open in this room, or warm up against the CPU. Battles run on the Pokémon Showdown simulator with Gen 1-5 rules; nothing that happens in a battle changes your stored Pokémon.")),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn btn-primary", onclick: () => on.challenge(), disabled: !others.length, title: others.length ? "" : "Nobody else has the widget open here" }, "Challenge…"),
        h("button", { type: "button", class: "btn", onclick: () => on.practice() }, "Practice vs CPU"))),
    data.error ? h("div", { class: "notice notice-error" }, data.error) : null,
    incoming.length ? card("Challenges for you", h("ul", { class: "bt-list" }, incoming.map((c) => h("li", { class: "bt-line bt-incoming" },
      avatar(c.from.name, c.from.id, "sm"),
      h("div", { class: "bt-line-text" }, h("span", { class: "bt-line-title" }, `${c.from.name} challenges you`), h("span", { class: "bt-line-sub" }, c.desc)),
      h("div", { class: "bt-line-actions" }, btn("Decline", () => on.decline(c), "ghost"), btn("Accept…", () => on.accept(c), "primary")))))) : null,
    mine.length ? card("Your battles", h("ul", { class: "bt-list" }, mine.map((b) => battleLine(b, me, btn(b.practice ? "Continue" : "Resume", () => on.open(b.id), "primary"))))) : null,
    outgoing.length ? card("Waiting for an answer", h("ul", { class: "bt-list" }, outgoing.map((c) => h("li", { class: "bt-line" },
      avatar(c.to.name, c.to.id, "sm"),
      h("div", { class: "bt-line-text" }, h("span", { class: "bt-line-title" }, `You challenged ${c.to.name}`), h("span", { class: "bt-line-sub" }, c.desc)),
      h("div", { class: "bt-line-actions" }, btn("Cancel", () => on.cancel(c), "ghost")))))) : null,
    card("Battles in this room", watch.length
      ? h("ul", { class: "bt-list" }, watch.map((b) => battleLine(b, me, btn("Watch", () => on.open(b.id)))))
      : h("p", { class: "muted small" }, data.loading ? "Loading…" : "No battles right now.")),
    card(`Here now (${others.length})`, others.length
      ? h("ul", { class: "people" }, others.map((p) => {
        const pending = outgoing.some((c) => c.to.id === p.id);
        return h("li", { class: "person" }, avatar(p.name, p.id, "sm"),
          h("span", { class: "person-text" }, h("span", { class: "person-name" }, p.name), h("span", { class: "person-id" }, p.id)),
          p.activity === "battling" ? badge("Battling", "accent") : null,
          p.battleId ? btn("Watch", () => on.open(p.battleId), "ghost") : null,
          btn(pending ? "Challenged" : "Challenge", () => on.challenge(p.id), pending ? "ghost" : "", { disabled: pending }));
      }))
      : h("p", { class: "muted small" }, "Nobody else has the widget open in this room. Ask someone to open it, or practice against the CPU.")),
    data.recent.length ? card("Recent results", h("ul", { class: "bt-list" }, data.recent.map((b) => battleLine(b, me, btn("Log", () => on.open(b.id), "ghost")))),
      h("span", { class: "muted small" }, plural(data.recent.length, "battle"))) : null);
}
