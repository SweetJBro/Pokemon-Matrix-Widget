/* Saves tab (placeholder; the saves feature replaces this file).

   Contract (js/app.js documents `app`): export function mount(el, app), optional unmount().
   The real view opens files with <input type="file"> (File System Access pickers are refused in
   cross-origin iframes), parses them with shared/saves openSave(), keeps bytes in app.store and
   offers the download of the working copy from a click. */
import { h, emptyState } from "../ui.js";

export function mount(el) {
  el.append(h("div", { class: "view-inner" },
    h("div", { class: "card" }, emptyState({
      icon: "▤",
      title: "Saves are coming soon",
      text: "Open a Gen 1-5 save file from an emulator or PC port, move Pokémon to and from Home, and download the updated save. The file itself never leaves your browser.",
    }))));
}
