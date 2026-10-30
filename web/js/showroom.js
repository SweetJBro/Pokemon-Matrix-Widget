/* The public, read-only showroom page (server/showroom.js): showroom.html#<token>. No sign-in;
   the token stays in the fragment, so it is never in a request line or a log, and the page sends
   it only as the path of one API call. Uses the same boxes and cards as Home. */
import { h, clear, emptyState, plural, dialog } from "./ui.js";
import { boxGrid, boxFrame } from "./components/box-grid.js";
import { monCard } from "./components/mon-card.js";

const root = document.getElementById("showroom");

async function main() {
  const token = location.hash.slice(1);
  const config = await fetch("config.json").then((r) => r.json()).catch(() => ({}));
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return show("This link is incomplete", "Ask for the whole showroom link again.");
  const r = await fetch(`api/showroom/view/${encodeURIComponent(token)}`);
  if (!r.ok) return show("This showroom is closed", "The link was turned off or replaced by its owner.");
  const data = await r.json();
  document.title = `${data.owner}'s Pokémon`;
  // The card opens in a dialog: below a column of boxes it would be out of sight on a phone.
  const pick = (m) => dialog({
    title: m.summary.isEgg ? "Egg" : m.summary.isNicknamed ? `${m.summary.nickname} (${m.summary.speciesName})` : m.summary.speciesName,
    body: monCard({ ...m.summary, gen: Number(m.format.slice(2)), format: m.format, ot: m.summary.ot }, { base: config.spriteBase }),
    buttons: [{ label: "Close", value: true, kind: "primary" }],
  });
  clear(root,
    h("div", { class: "card" },
      h("h1", { class: "home-title" }, `${data.owner}'s Pokémon`),
      h("p", { class: "field-hint" }, `${plural(data.counts.pokemon, "Pokémon", "Pokémon")} · ${data.counts.species} species · ${data.counts.shiny} shiny. Click one to see it.`)),
    data.boxes.length ? h("div", { class: "showroom-boxes" }, data.boxes.map((b) => {
        const cells = Array.from({ length: data.boxSlots }, () => null);
        for (const m of b.mons) cells[m.slot] = { view: { ...m.summary, gen: Number(m.format.slice(2)) }, m };
        return boxFrame({ name: b.name, grid: boxGrid({ cells, base: config.spriteBase, pickEmpty: false, onPick: (i, c) => c && pick(c.m) }) });
      })) : h("div", { class: "card" }, emptyState({ title: "Nothing to show yet", text: "The boxes in this showroom are empty." })));
}

function show(title, text) { clear(root, h("div", { class: "card" }, emptyState({ title, text }))); }

main().catch((e) => show("The showroom did not load", e.message));
