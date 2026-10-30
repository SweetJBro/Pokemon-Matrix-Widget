/* Home's quick filters. filterBar(onChange) renders the controls and reports a predicate over
   a Home listing entry ({ format, summary, locked, flags }); matchesFilter is exported so the
   view can count hits in other boxes with the same rule. */
import { h } from "../ui.js";

export const EMPTY_FILTER = Object.freeze({ text: "", gen: "", shiny: false, eggs: "any", locked: false, flagged: false });

export function matchesFilter(f, m) {
  const s = m.summary;
  if (f.gen && m.format !== `pk${f.gen}`) return false;
  if (f.shiny && !s.shiny) return false;
  if (f.eggs === "hide" && s.isEgg) return false;
  if (f.eggs === "only" && !s.isEgg) return false;
  if (f.locked && !m.locked) return false;
  if (f.flagged && !m.flags?.includes("seen-before")) return false;
  if (f.text) {
    const q = f.text.toLowerCase();
    const hay = [s.speciesName, s.nickname, s.ot?.name, s.heldItem, String(s.species)].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export const isFiltering = (f) => Object.keys(EMPTY_FILTER).some((k) => f[k] !== EMPTY_FILTER[k]);

export function filterBar(onChange, initial = EMPTY_FILTER) {
  const f = { ...initial };
  const emit = () => onChange({ ...f });
  const text = h("input", { type: "search", class: "input", placeholder: "Search species, nickname, OT, item", value: f.text, "aria-label": "Search" });
  text.addEventListener("input", () => { f.text = text.value.trim(); emit(); });
  const gen = h("select", { class: "input", "aria-label": "Generation" },
    h("option", { value: "" }, "All gens"), [1, 2, 3, 4, 5].map((g) => h("option", { value: String(g) }, `Gen ${g}`)));
  gen.addEventListener("change", () => { f.gen = gen.value; emit(); });
  const eggs = h("select", { class: "input", "aria-label": "Eggs" },
    h("option", { value: "any" }, "Eggs: any"), h("option", { value: "hide" }, "Hide eggs"), h("option", { value: "only" }, "Only eggs"));
  eggs.addEventListener("change", () => { f.eggs = eggs.value; emit(); });
  const toggle = (key, label) => {
    const box = h("input", { type: "checkbox" });
    box.addEventListener("change", () => { f[key] = box.checked; emit(); });
    return h("label", { class: "check" }, box, " ", label);
  };
  return h("div", { class: "filter-bar row" }, text, gen, eggs, toggle("shiny", "Shiny"), toggle("locked", "Locked"), toggle("flagged", "Seen before"));
}
