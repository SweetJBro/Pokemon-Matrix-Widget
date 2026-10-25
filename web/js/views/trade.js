/* Trade tab (placeholder; the trading feature replaces this file).

   Contract (js/app.js documents `app`): export function mount(el, app), optional unmount().
   Shows who is here (app.presence(), kept fresh with app.on("presence")) because that is who
   the real view will offer trades to. */
import { h, emptyState, avatar, badge, clear } from "../ui.js";

let off = null;

export function mount(el, app) {
  const list = h("ul", { class: "people" });
  const render = () => clear(list, app.presence().map((u) => h("li", { class: "person" },
    avatar(app.nameOf(u.id), u.id, "sm"),
    h("span", { class: "person-text" }, h("span", { class: "person-name" }, app.nameOf(u.id)), h("span", { class: "person-id" }, u.id)),
    u.id === app.user.id ? badge("you", "accent") : badge("online", "ok"))));
  render();
  const offs = [app.on("presence", render), app.on("members", render)];
  off = () => offs.forEach((f) => f());
  el.append(h("div", { class: "view-inner" },
    h("div", { class: "card" }, emptyState({
      icon: "⇄",
      title: "Trading is coming soon",
      text: "Offer Pokémon from your Home boxes to someone in this room. When both of you confirm, the server swaps them in one step, trade evolutions included.",
    })),
    h("div", { class: "card" }, h("h3", { class: "section-label" }, "Here now"), list)));
}

export function unmount() {
  if (off) off();
  off = null;
}
