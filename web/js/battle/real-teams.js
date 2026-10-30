/* "From Home" and "From a save" team pickers for the challenge and accept dialogs
   (web/js/battle/teams.js registerTeamPicker; the server side is server/battle-teams.js).

   Both send references, never battle sets: Home sends Pokémon ids, a save sends the chosen
   records, and the server reads them itself. Gen 1-2 and Gen 3-5 Pokémon only battle under
   their own era's rules, and a Pokémon can't battle under the rules of a generation older than
   its own, so those are dimmed with the reason. */
import { h, dialog, toast } from "../ui.js";
import { registerTeamPicker } from "./teams.js";
import { pickFromHome } from "../components/home-picker.js";
import { boxGrid } from "../components/box-grid.js";
import { homeState } from "../home/state.js";
import { openEntry } from "../saves/session.js";
import { toBase64 } from "../../shared/bytes.js";

const era = (g) => (g <= 2 ? 1 : 3);
function whyNot(gen, battleGen, isEgg) {
  if (isEgg) return "Eggs can't battle.";
  if (era(gen) !== era(battleGen)) return `Gen ${gen} Pokémon can't battle under Gen ${battleGen} rules (Gen 1-2 and Gen 3-5 don't mix).`;
  if (gen > battleGen) return `A Gen ${gen} Pokémon can't battle under older Gen ${battleGen} rules.`;
  return null;
}

registerTeamPicker("home", {
  label: "From Home",
  hint: "Choose Pokémon from your Home boxes.",
  async pick(app, options) {
    const data = await homeState(app).refresh();
    const allow = (m) => whyNot(Number(m.format.slice(2)), options.gen, m.summary.isEgg) ?? (m.lockedBy === "withdraw" ? "It is being withdrawn." : null);
    if (!data.boxes.some((b) => b.mons.some((m) => !allow(m)))) {
      throw new Error(`Your Home has no Pokémon that can battle under Gen ${options.gen} rules.`);
    }
    const ids = await pickFromHome({
      data, base: app.config.spriteBase, title: `Your team (up to ${options.teamSize})`, allow, multiple: true, max: options.teamSize,
      confirmLabel: "Use this team",
      note: h("p", { class: "field-hint" }, "They fight as copies: battles never change your Pokémon. Every move starts at full PP."),
    });
    return ids ? { source: "home", monIds: ids } : null;
  },
});

registerTeamPicker("party", {
  label: "From a save",
  hint: "Use Pokémon from a save you opened in the Saves tab (they are not deposited).",
  async pick(app, options) {
    const usable = [];
    for (const entry of app.store.list()) {
      try {
        const save = await openEntry(entry);
        if (era(save.gen) === era(options.gen) && save.gen <= options.gen) usable.push({ entry, save });
      } catch { /* a save that no longer opens is just skipped */ }
    }
    if (!usable.length) throw new Error(`Open a Gen ${options.gen <= 2 ? "1-2" : "3-" + options.gen} save in the Saves tab first.`);
    let cur = 0, where = -1;   // -1 = party, else box index
    const chosen = new Map();  // key -> { record, meta }
    const holder = h("div");
    const saveSel = h("select", { class: "input" }, usable.map((u, i) => h("option", { value: String(i) }, `${u.save.gameName} · ${u.save.trainer?.name ?? ""} (${u.entry.filename})`)));
    const whereSel = h("select", { class: "input" });
    const hint = h("p", { class: "field-hint" });
    const fillWhere = () => {
      const s = usable[cur].save;
      whereSel.replaceChildren(h("option", { value: "-1" }, "Party"), ...Array.from({ length: s.boxCount }, (_, b) => h("option", { value: String(b) }, s.boxName(b) || `Box ${b + 1}`)));
      whereSel.value = String(where);
    };
    const draw = () => {
      const s = usable[cur].save;
      const slots = where < 0 ? s.party() : s.box(where);
      const cap = where < 0 ? 6 : s.boxCapacity;
      const cells = Array.from({ length: cap }, (_, i) => {
        const e = slots[i];
        if (!e) return null;
        const key = `${cur}:${where}:${i}`;
        const why = whyNot(s.gen, options.gen, e.view.isEgg);
        return { view: e.view, key, why, e, dim: !!why, selected: chosen.has(key) };
      });
      holder.replaceChildren(boxGrid({ cells, base: app.config.spriteBase, pickEmpty: false, onPick: (i, c) => {
        if (!c) return;
        if (c.why) { toast(c.why, "warn"); return; }
        if (chosen.has(c.key)) chosen.delete(c.key);
        else if (chosen.size >= options.teamSize) { toast(`This battle allows ${options.teamSize} Pokémon.`, "warn"); return; }
        else chosen.set(c.key, { record: toBase64(c.e.record), meta: c.e.meta });
        draw();
      } }));
      hint.textContent = `${chosen.size} of ${options.teamSize} chosen.`;
    };
    saveSel.addEventListener("change", () => { cur = Number(saveSel.value); where = -1; chosen.clear(); fillWhere(); draw(); });
    whereSel.addEventListener("change", () => { where = Number(whereSel.value); draw(); });
    fillWhere(); draw();
    const ok = await dialog({
      title: `Your team (up to ${options.teamSize})`, wide: true,
      body: h("div", null,
        h("div", { class: "row row-fields" },
          h("label", { class: "field" }, h("span", { class: "field-label" }, "Save"), saveSel),
          h("label", { class: "field" }, h("span", { class: "field-label" }, "From"), whereSel)),
        holder, hint,
        h("p", { class: "field-hint" }, "Only these Pokémon's data is sent, for this battle. Your save is not changed.")),
      buttons: [{ label: "Cancel", value: false, kind: "ghost" }, { label: "Use this team", value: true, kind: "primary" }],
    });
    return ok && chosen.size ? { source: "party", records: [...chosen.values()] } : null;
  },
});
