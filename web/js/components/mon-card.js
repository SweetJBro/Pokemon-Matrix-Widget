/* The detail panel for one Pokémon: everything a player wants to check before depositing,
   withdrawing or trading it. Works from a full MonView; a Home listing summary shows a reduced
   card until the full record is fetched. Every string from a record (nickname, OT name) is
   untrusted and only ever goes through textContent (h() does that). */
import { h, badge, fmtDateTime } from "../ui.js";
import { monSprite, genLabel } from "./mon-sprite.js";

const STAT_NAMES = { hp: "HP", atk: "Atk", def: "Def", spa: "SpA", spd: "SpD", spe: "Spe" };
const GENDER = { M: "♂", F: "♀" };

/** opts: { base, provenance?, locked?, flags?, actions: [HTMLElement] } */
export function monCard(view, { base, provenance, locked, flags = [], actions = [] } = {}) {
  const title = view.isEgg ? "Egg" : (view.isNicknamed && view.nickname ? view.nickname : view.speciesName);
  const badges = h("div", { class: "row mon-badges" },
    badge(genLabel(view.format) + (view.game ? ` · ${view.game}` : ""), "muted"),
    view.shiny && badge("★ Shiny", "warn"),
    locked && badge(locked, "warn"),
    flags.includes("seen-before") && badge("Seen before", "danger"),
    flags.includes("unofficial") && badge("Unofficial transfer", "danger"),
    view.checksumOk === false && badge("Bad checksum", "danger"));
  const head = h("div", { class: "mon-head" },
    h("div", { class: "mon-art" }, monSprite(view, base, { className: "mon-sprite" })),
    h("div", { class: "mon-title" },
      h("div", { class: "mon-name" }, title, view.gender && !view.isEgg ? h("span", { class: `mon-gender g-${view.gender}` }, " " + GENDER[view.gender]) : null),
      h("div", { class: "mon-sub" }, view.isEgg ? "Not hatched yet" : `${view.isNicknamed ? view.speciesName + " · " : ""}Lv. ${view.level}${view.formName ? " · " + view.formName : ""}`),
      view.types && !view.isEgg && h("div", { class: "row" }, view.types.map((t) => h("span", { class: `type type-${typeClass(t)}` }, t))),
      badges));
  const facts = h("dl", { class: "mon-facts" },
    fact("OT", view.ot?.name ? (view.ot.tid != null ? `${view.ot.name} · ${String(view.ot.tid).padStart(5, "0")}` : view.ot.name) : null),   // the showroom has no IDs
    fact("Nature", view.nature), fact("Ability", view.ability), fact("Item", view.heldItem),
    fact("Ball", view.ball), fact("Friendship", view.friendship),
    fact("Met", view.met ? [view.met.locationName, view.met.level ? `Lv. ${view.met.level}` : null, view.met.date].filter(Boolean).join(" · ") || null : null),
    fact("Pokérus", view.pokerus?.strain ? (view.pokerus.days ? "Infected" : "Cured") : null));   // strain 0 = never had it
  const moves = view.moves?.length ? h("ul", { class: "mon-moves" }, view.moves.map((m) =>
    h("li", { class: "mon-move" },
      m.type && h("span", { class: `type type-${typeClass(m.type)} type-mini` }, m.type),
      h("span", { class: "mon-move-name" }, m.name),
      m.pp != null && h("span", { class: "mon-move-pp" }, `${m.pp} PP${m.ppUps ? ` (+${m.ppUps})` : ""}`)))) : null;
  const stats = view.stats && !view.isEgg ? statTable(view) : null;
  const prov = provenance?.length ? h("details", { class: "mon-provenance" },
    h("summary", null, "History"),
    h("ol", null, provenance.map((p) => h("li", null,
      h("strong", null, PROV_LABEL[p.rule] || p.rule), " ", p.at ? fmtDateTime(p.at) : "",
      p.note ? h("div", { class: "field-hint" }, p.note) : null)))) : null;
  const warn = view.warnings?.length ? h("ul", { class: "mon-warnings" }, view.warnings.map((w) => h("li", null, w))) : null;
  return h("article", { class: "card mon-card" }, head, warn, moves, stats, facts, prov,
    actions.length ? h("div", { class: "row mon-actions" }, actions) : null);
}

const typeClass = (t) => (t === "???" ? "unknown" : t.toLowerCase());
const PROV_LABEL = { deposit: "Deposited", "seen-before": "Seen before", trade: "Traded", convert: "Converted", unofficial: "Unofficial transfer" };

function fact(k, v) {
  return v == null || v === "" ? null : [h("dt", null, k), h("dd", null, String(v))];
}

function statTable(view) {
  const gb = view.gen <= 2;
  const keys = gb && view.gen === 1 ? ["hp", "atk", "def", "spa", "spe"] : Object.keys(STAT_NAMES);
  const genes = gb ? view.dvs : view.ivs, effort = gb ? view.statExp : view.evs;
  const geneOf = (k) => (gb ? genes?.[k === "spa" || k === "spd" ? "spc" : k] : genes?.[k]);
  const effortOf = (k) => (gb ? effort?.[k === "spa" || k === "spd" ? "spc" : k] : effort?.[k]);
  return h("table", { class: "mon-stats" },
    h("thead", null, h("tr", null, h("th", null, ""), h("th", null, "Stat"), h("th", null, gb ? "DV" : "IV"), h("th", null, gb ? "Stat Exp" : "EV"))),
    h("tbody", null, keys.map((k) => h("tr", null,
      h("th", { scope: "row" }, gb && view.gen === 1 && k === "spa" ? "Spc" : STAT_NAMES[k]),
      h("td", null, String(view.stats[k] ?? "")),
      h("td", null, String(geneOf(k) ?? "")),
      h("td", null, String(effortOf(k) ?? ""))))));
}
