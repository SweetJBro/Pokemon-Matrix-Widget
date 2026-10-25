/* Home tab (placeholder; the Home feature replaces this file).

   Contract (js/app.js documents `app`): export function mount(el, app), optional unmount().
   The empty box below previews the .box-grid styles from css/app.css (6 x 5 cells). */
import { h, emptyState } from "../ui.js";

export function mount(el, app) {
  const cells = Array.from({ length: 30 }, (_, i) => h("button", { type: "button", class: "box-cell", "aria-label": `Slot ${i + 1}, empty`, disabled: true }));
  el.append(h("div", { class: "view-inner" },
    h("div", { class: "card" }, emptyState({
      icon: "▦",
      title: "Home is coming soon",
      text: `${app.config.homeBoxes} cloud boxes for the Pokémon you deposit from your saves, ready to trade, battle or withdraw into any compatible game.`,
    })),
    h("div", { class: "box" },
      h("div", { class: "box-header" },
        h("button", { type: "button", class: "btn btn-icon", disabled: true, "aria-label": "Previous box" }, "‹"),
        h("span", { class: "box-name" }, "Box 1"),
        h("button", { type: "button", class: "btn btn-icon", disabled: true, "aria-label": "Next box" }, "›")),
      h("div", { class: "box-grid" }, cells))));
}
