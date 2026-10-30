/* Choose Pokémon from Home inside a dialog: one Home box at a time, Pokémon that can't be
   chosen dimmed with the reason as their tooltip/toast.

     const ids = await pickFromHome({ data, base, title, allow(m) -> null | reason, multiple, max, preselect, note })
     -> array of chosen ids, or null if cancelled */
import { h, clear, dialog, toast } from "../ui.js";
import { boxGrid, boxFrame } from "./box-grid.js";

export async function pickFromHome({ data, base, title = "Choose from Home", allow = () => null, multiple = false, max = Infinity, preselect = [], note = null, confirmLabel = "Choose" }) {
  const chosen = new Set(preselect);
  let box = Math.max(0, data.boxes.findIndex((b) => b.mons.some((m) => chosen.has(m.id) || !allow(m))));
  const holder = h("div");
  const hint = h("p", { class: "field-hint" });
  const draw = () => {
    const b = data.boxes[box];
    const cells = Array.from({ length: data.boxSlots }, () => null);
    for (const m of b.mons) {
      const why = allow(m);
      cells[m.slot] = { view: { ...m.summary, gen: Number(m.format.slice(2)), format: m.format }, id: m.id, why, selected: chosen.has(m.id), dim: !!why, flags: m.flags, locked: m.locked };
    }
    const elsewhere = data.boxes.reduce((n, x, i) => n + (i === box ? 0 : x.mons.filter((m) => !allow(m)).length), 0);
    clear(holder, boxFrame({
      name: b.name,
      onPrev: () => { box = (box + data.boxes.length - 1) % data.boxes.length; draw(); },
      onNext: () => { box = (box + 1) % data.boxes.length; draw(); },
      grid: boxGrid({ cells, base, pickEmpty: false, onPick: (i, c) => {
        if (!c) return;
        if (c.why) { toast(c.why, "warn"); return; }
        if (chosen.has(c.id)) chosen.delete(c.id);
        else {
          if (!multiple) chosen.clear();
          else if (chosen.size >= max) { toast(`You can choose at most ${max}.`, "warn"); return; }
          chosen.add(c.id);
        }
        draw();
      } }),
    }));
    hint.textContent = `${chosen.size}${Number.isFinite(max) ? " of " + max : ""} chosen.${elsewhere ? ` ${elsewhere} more you can choose in other boxes.` : ""}`;
  };
  draw();
  const ok = await dialog({
    title, wide: true,
    body: h("div", null, holder, hint, note),
    buttons: [{ label: "Cancel", value: false, kind: "ghost" }, { label: confirmLabel, value: true, kind: "primary" }],
  });
  return ok && chosen.size ? [...chosen] : null;
}
