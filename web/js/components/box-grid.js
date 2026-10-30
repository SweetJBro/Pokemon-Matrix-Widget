/* A PC box: 30 cells (or however many the box holds) in the .box-grid layout from app.css.

   Used for boxes inside a save, Home boxes and pickers. Cells are buttons, so keyboard and
   screen readers work without extra code; a cell's label says what is in it.

     boxGrid({
       cells: [{ view, locked?, flags?, dim?, selected? } | null, ...],
       base,                      config.spriteBase
       onPick(index, cell),       click / Enter on a cell (empty cells too, unless pickEmpty is false)
       pickEmpty = true,
       onDrop(from, to),          drag-and-drop between cells; omit to disable dragging
       label(i) -> string         accessible name prefix ("Slot 3")
     }) -> HTMLElement */
import { h } from "../ui.js";
import { monSprite } from "./mon-sprite.js";

export function boxGrid({ cells, base, onPick, pickEmpty = true, onDrop, label = (i) => `Slot ${i + 1}` }) {
  const grid = h("div", { class: "box-grid", role: "grid" });
  let dragFrom = null;
  cells.forEach((cell, i) => {
    const v = cell?.view;
    const name = v ? (v.isEgg ? "Egg" : `${v.isNicknamed && v.nickname ? v.nickname + " (" + v.speciesName + ")" : v.speciesName}, level ${v.level}${v.shiny ? ", shiny" : ""}`) : "empty";
    const cls = ["box-cell", !v && "is-empty", cell?.locked && "is-locked", cell?.selected && "is-selected", cell?.dim && "is-dim",
      cell?.flags?.includes("seen-before") && "is-flagged"].filter(Boolean).join(" ");
    const btn = h("button", {
      type: "button", class: cls, role: "gridcell",
      "aria-label": `${label(i)}: ${name}${cell?.locked ? " (" + cell.locked + ")" : ""}`,
      "aria-pressed": cell?.selected ? "true" : "false",
      title: v ? name + (cell?.locked ? ` — ${cell.locked}` : "") : "",
      disabled: !v && !pickEmpty,
    },
    v && monSprite(v, base),
    v && !v.isEgg && h("span", { class: "cell-level" }, String(v.level)),
    v?.shiny && h("span", { class: "cell-shiny", "aria-hidden": "true" }, "★"),
    v?.heldItem && h("span", { class: "cell-item", "aria-hidden": "true" }, "●"));
    if (onPick) btn.addEventListener("click", () => onPick(i, cell));
    if (onDrop) {
      if (v && !cell.locked) {
        btn.draggable = true;
        btn.addEventListener("dragstart", (e) => { dragFrom = i; btn.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); });
        btn.addEventListener("dragend", () => { dragFrom = null; btn.classList.remove("is-dragging"); });
      }
      btn.addEventListener("dragover", (e) => { if (dragFrom !== null && dragFrom !== i) { e.preventDefault(); btn.classList.add("is-drop-target"); } });
      btn.addEventListener("dragleave", () => btn.classList.remove("is-drop-target"));
      btn.addEventListener("drop", (e) => {
        e.preventDefault(); btn.classList.remove("is-drop-target");
        const from = dragFrom ?? Number(e.dataTransfer.getData("text/plain"));
        if (Number.isInteger(from) && from !== i) onDrop(from, i);
      });
    }
    grid.append(btn);
  });
  return grid;
}

/** Box frame with ‹ name › header around a grid. onName (optional) makes the name a rename button. */
export function boxFrame({ name, onPrev, onNext, onName, grid, extra }) {
  return h("div", { class: "box" },
    h("div", { class: "box-header" },
      h("button", { type: "button", class: "btn btn-icon", "aria-label": "Previous box", onclick: onPrev, disabled: !onPrev }, "‹"),
      onName
        ? h("button", { type: "button", class: "box-name box-name-btn", title: "Rename this box", onclick: onName }, name)
        : h("span", { class: "box-name" }, name),
      h("button", { type: "button", class: "btn btn-icon", "aria-label": "Next box", onclick: onNext, disabled: !onNext }, "›")),
    grid, extra);
}
