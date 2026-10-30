/* Saves tab: open a save, move Pokémon to and from Home, download the result.

   The loop the player follows, shown as steps at the top: 1 open a save, 2 pick Pokémon,
   3 deposit (or withdraw from Home), 4 download and replace the file in the emulator or port.
   The file never leaves the browser; only the chosen Pokémon's records go to the server
   (js/saves/session.js does the moving). Files are read with <input type="file"> and drag and
   drop, because File System Access pickers are refused inside the widget iframe.

   Route: #saves/withdraw/<monId> opens the withdraw picker with that Pokémon chosen (the Home
   tab links here). */
import { h, clear, toast, dialog, confirmDialog, emptyState, badge, plural, fmtRelative, fmtBytes, spinner } from "../ui.js";
import { openSave, exportSave } from "../../shared/saves/index.js";
import { boxGrid, boxFrame } from "../components/box-grid.js";
import { monCard } from "../components/mon-card.js";
import { genLabel, monSprite } from "../components/mon-sprite.js";
import { homeState } from "../home/state.js";
import { deposit, withdraw, openEntry, describe } from "../saves/session.js";

const PARTY = -1;

export async function mount(el, app) {
  const { store } = app;
  const home = homeState(app);
  const base = app.config.spriteBase;
  const st = { activeId: null, save: null, box: 0, picks: new Map(), focus: null, error: null, busy: false };

  const root = h("div", { class: "view-inner saves-view" });
  el.append(root);
  await store.ready?.();
  store.onChange(() => render());
  app.on("tab", (name, route) => {
    if (name !== "saves") return;
    if (route?.rest?.[0] === "withdraw" && route.rest[1]) openWithdraw([route.rest[1]]);
  });

  const key = (box, index) => `${box}:${index}`;

  async function activate(id) {
    st.activeId = id; st.picks.clear(); st.focus = null; st.error = null;
    const entry = store.get(id);
    try {
      st.save = await openEntry(entry);
      st.box = st.save.currentBox ?? 0;
    } catch (e) { st.save = null; st.error = e.message; }
    render();
  }

  async function reopen() {
    if (!st.activeId) return;
    try { st.save = await openEntry(store.get(st.activeId)); } catch (e) { st.save = null; st.error = e.message; }
  }

  async function takeFiles(files) {
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const save = await openSave(bytes, file.name);
        const entry = await store.add(bytes, file.name, describe(save));
        toast(`Opened ${save.gameName || "save"} (${save.trainer?.name || "no trainer"}).`, "ok");
        await activate(entry.id);
      } catch (e) {
        await dialog({ title: `Can't open ${file.name}`, body: h("div", null, h("p", null, e.message), whereIsMySave()) });
      }
    }
  }

  /* ---------- rendering ---------- */

  function render() {
    const entries = store.list();
    const active = st.activeId && store.get(st.activeId);
    // With a save open, its boxes come first: in Element's narrow side panel the list and the
    // drop zone would otherwise push them off screen.
    clear(root,
      steps(active),
      active ? activePanel(active) : null,
      openCard(entries.length === 0),
      entries.length ? savesList(entries) : null);
  }

  function steps(active) {
    const n = !active ? 1 : st.picks.size ? 3 : active.dirty ? 4 : 2;
    const items = ["Open a save", "Pick Pokémon", "Deposit or withdraw", "Download the updated save"];
    return h("ol", { class: "stepper", "aria-label": "How it works" }, items.map((t, i) =>
      h("li", { class: i + 1 < n ? "is-done" : i + 1 === n ? "is-current" : "" }, h("span", { class: "step-n" }, String(i + 1)), t)));
  }

  function openCard(first) {
    const input = h("input", { type: "file", class: "visually-hidden", multiple: true, "aria-label": "Choose a save file" });
    input.addEventListener("change", () => { takeFiles([...input.files]); input.value = ""; });
    const zone = h("label", { class: "dropzone" + (first ? "" : " dropzone-compact") }, input,
      h("strong", null, first ? "Open a save file" : "+ Open another save"),
      first && h("span", { class: "field-hint" }, "Drop a .sav, .srm, .dsv, .dat or save.bin here, or click to choose. Gen 1–5, from emulators, RetroArch and PC ports."));
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("is-over"); takeFiles([...e.dataTransfer.files]); });
    return h("div", { class: "card" },
      first && emptyState({
        icon: "▤", title: "Bring your Pokémon",
        text: "Open a save from your emulator or PC port. Deposit Pokémon into Home, trade or battle with them here, and withdraw them into any save of the same generation. Your save file stays in this browser: only the Pokémon you move are sent to the server.",
      }),
      zone,
      !store.persistent && h("p", { class: "field-hint" }, "This browser is not keeping saves between visits here, so download your save before closing the widget."),
      h("details", { class: "help" }, h("summary", null, "Where is my save file?"), whereIsMySave()));
  }

  function savesList(entries) {
    return h("div", { class: "card" },
      h("h3", { class: "section-label" }, "Open saves"),
      h("ul", { class: "save-list" }, entries.map((e) => {
        const m = e.meta || {};
        return h("li", { class: "save-item" + (e.id === st.activeId ? " is-active" : "") },
          h("button", { type: "button", class: "save-pick", onclick: () => activate(e.id) },
            h("span", { class: "save-title" }, `${m.gameName || "Save"} · ${m.trainer || "?"}`),
            h("span", { class: "field-hint" }, `${e.filename} · ${fmtBytes(e.size)} · opened ${fmtRelative(e.addedAt)}`)),
          m.readOnly && badge("read-only", "warn"),
          e.dirty && badge("not downloaded", "danger"),
          h("button", { type: "button", class: "btn btn-sm" + (e.dirty ? " btn-primary" : ""), onclick: () => download(e) }, "Download"),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", "aria-label": `Close ${e.filename}`, onclick: () => closeEntry(e) }, "✕"));
      })));
  }

  function activePanel(entry) {
    if (!st.save) return h("div", { class: "card" }, h("p", { class: "field-error" }, st.error || "This save can't be opened any more."));
    const s = st.save;
    const banners = [
      s.readOnly && h("div", { class: "banner banner-warn" }, h("strong", null, "Read-only. "), s.readOnly),
      ...(s.warnings || []).filter((w) => w !== s.readOnly).map((w) => h("div", { class: "banner" }, w)),
      entry.dirty && h("div", { class: "banner banner-danger" },
        h("strong", null, "Your changes are only in this browser. "),
        "Download the updated save and replace the file in your emulator or port (close the game first) before you play again.",
        h("div", { class: "row" },
          h("button", { type: "button", class: "btn btn-primary", onclick: () => download(entry) }, "Download updated save"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => download(entry, "plain") }, "Download as plain .sav"))),
    ];
    const boxCount = s.boxCount;
    const isParty = st.box === PARTY;
    const slots = isParty ? s.party() : s.box(st.box);
    const cap = isParty ? 6 : s.boxCapacity;
    const cells = Array.from({ length: cap }, (_, i) => {
      const e = slots[i];
      return e ? { view: e.view, selected: st.picks.has(key(st.box, i)) } : null;
    });
    const grid = boxGrid({ cells, base, label: (i) => (isParty ? `Party ${i + 1}` : `Slot ${i + 1}`), onPick: (i) => pick(i), pickEmpty: false });
    const frame = boxFrame({
      name: isParty ? "Party" : s.boxName(st.box) || `Box ${st.box + 1}`,
      onPrev: () => { st.box = st.box <= PARTY ? boxCount - 1 : st.box - 1; render(); },
      onNext: () => { st.box = st.box >= boxCount - 1 ? PARTY : st.box + 1; render(); },
      grid,
    });
    const jump = h("select", { class: "input box-jump", "aria-label": "Box" },
      h("option", { value: String(PARTY), selected: isParty }, "Party"),
      Array.from({ length: boxCount }, (_, b) => h("option", { value: String(b), selected: b === st.box }, `${s.boxName(b) || "Box " + (b + 1)} (${s.box(b).filter(Boolean).length})`)));
    jump.addEventListener("change", () => { st.box = Number(jump.value); render(); });

    const n = st.picks.size;
    const actions = h("div", { class: "row action-bar" },
      h("button", { type: "button", class: "btn btn-primary", disabled: !n || !!s.readOnly || st.busy, onclick: confirmDeposit },
        n ? `Deposit ${plural(n, "Pokémon", "Pokémon")} to Home` : "Select Pokémon to deposit"),
      n ? h("button", { type: "button", class: "btn btn-ghost", onclick: () => { st.picks.clear(); st.focus = null; render(); } }, "Clear selection") : null,
      h("button", { type: "button", class: "btn", disabled: !!s.readOnly || st.busy, onclick: () => openWithdraw([]) }, "Withdraw from Home…"));

    const focus = st.focus && st.focus.box === st.box ? (isParty ? s.party() : s.box(st.box))[st.focus.index] : null;
    return h("div", { class: "card save-panel" },
      h("div", { class: "save-head" },
        h("div", null,
          h("h2", { class: "save-game" }, s.gameName || `Generation ${s.gen}`),
          h("div", { class: "field-hint" }, `${s.trainer?.name ?? ""} · ID ${String(s.trainer?.tid ?? "").padStart(5, "0")} · ${genLabel(`pk${s.gen}`)} · ${s.container?.label || ""}`)),
        jump),
      banners,
      h("div", { class: "split" }, h("div", null, frame, actions),
        focus ? monCard(focus.view, { base }) : h("div", { class: "card mon-card mon-card-hint" }, h("p", { class: "field-hint" }, "Click Pokémon to select them for depositing. The last one you click is shown here."))));
  }

  function pick(i) {
    const k = key(st.box, i);
    if (st.picks.has(k)) { st.picks.delete(k); if (st.focus?.index === i && st.focus?.box === st.box) st.focus = null; }
    else { st.picks.set(k, st.box === PARTY ? { party: true, index: i } : { box: st.box, index: i }); st.focus = { box: st.box, index: i }; }
    render();
  }

  /* ---------- actions ---------- */

  async function confirmDeposit() {
    const s = st.save;
    const picks = [...st.picks.values()];
    const views = picks.map((p) => (p.party ? s.party()[p.index] : s.box(p.box)[p.index]).view);
    let data;
    try { data = await home.load(); } catch (e) { toast(`Can't reach Home: ${e.message}`, "error"); return; }
    const free = data.boxes.map((b) => data.boxSlots - b.mons.length);
    const totalFree = free.reduce((a, b) => a + b, 0);
    const boxSel = h("select", { class: "input" },
      h("option", { value: "" }, "First free slots"),
      data.boxes.map((b, i) => h("option", { value: String(i), disabled: free[i] === 0 }, `${b.name} (${free[i]} free)`)));
    const ok = await dialog({
      title: `Deposit ${plural(views.length, "Pokémon", "Pokémon")}?`,
      body: h("div", null,
        h("ul", { class: "mini-list" }, views.map((v) => h("li", null, monSprite(v, base, { className: "mini-sprite" }), v.isEgg ? "Egg" : `${v.isNicknamed ? v.nickname + " · " : ""}${v.speciesName} Lv. ${v.level}`))),
        h("label", { class: "field" }, h("span", { class: "field-label" }, "Put them in"), boxSel),
        totalFree < views.length && h("p", { class: "field-error" }, `Home only has ${totalFree} free slots.`),
        h("p", { class: "field-hint" }, "They leave this save and go to Home. Afterwards, download the updated save and replace your file, or the game will still have them.")),
      buttons: [{ label: "Cancel", value: false, kind: "ghost" }, { label: "Deposit", value: true, kind: "primary" }],
    });
    if (!ok || totalFree < views.length) return;
    st.busy = true; render();
    try {
      const res = await deposit({ api: app.api, store, entryId: st.activeId, picks, homeBox: boxSel.value === "" ? null : Number(boxSel.value) });
      st.picks.clear(); st.focus = null;
      await reopen();
      home.refresh().catch(() => {});
      for (const w of res.warnings) toast(w, "warn", { timeout: 9000 });
      await afterChange(`Deposited ${plural(res.stored.length, "Pokémon", "Pokémon")} into Home.`);
    } catch (e) {
      toast(`Nothing was moved: ${e.message}`, "error", { timeout: 10000 });
    } finally { st.busy = false; render(); }
  }

  async function openWithdraw(preselect) {
    if (!st.save) { toast("Open the save you want to withdraw into first.", "warn"); return; }
    if (st.save.readOnly) { toast(st.save.readOnly, "warn"); return; }
    const s = st.save;
    const format = s.format || `pk${s.gen}`;
    let data;
    try { data = await home.refresh(); } catch (e) { toast(`Can't reach Home: ${e.message}`, "error"); return; }
    const chosen = new Set(preselect);
    let hbox = 0;
    const firstPre = data.boxes.findIndex((b) => b.mons.some((m) => chosen.has(m.id)));
    if (firstPre >= 0) hbox = firstPre;
    const holder = h("div");
    const targetSel = h("select", { class: "input" },
      h("option", { value: "" }, "First free slot"),
      Array.from({ length: s.boxCount }, (_, b) => h("option", { value: String(b), selected: st.box === b }, `${s.boxName(b) || "Box " + (b + 1)} (${s.boxCapacity - s.box(b).filter(Boolean).length} free)`)));
    const draw = () => {
      const b = data.boxes[hbox];
      const cells = Array.from({ length: data.boxSlots }, () => null);
      for (const m of b.mons) {
        const fits = m.format === format;
        cells[m.slot] = { view: { ...m.summary, gen: Number(m.format.slice(2)) }, selected: chosen.has(m.id), dim: !fits || !!m.locked, locked: m.locked, flags: m.flags, id: m.id, fits };
      }
      const other = data.boxes.reduce((n, x, i) => n + (i === hbox ? 0 : x.mons.filter((m) => m.format === format && !m.locked).length), 0);
      clear(holder,
        boxFrame({
          name: b.name,
          onPrev: () => { hbox = (hbox + data.boxes.length - 1) % data.boxes.length; draw(); },
          onNext: () => { hbox = (hbox + 1) % data.boxes.length; draw(); },
          grid: boxGrid({ cells, base, pickEmpty: false, onPick: (i, c) => {
            if (!c?.fits) { toast(c ? `That is a ${genLabel(c.view.format)} Pokémon; this save holds ${genLabel(format)} Pokémon.` : "", "warn"); return; }
            if (c.locked) { toast(`Can't withdraw it: ${c.locked}.`, "warn"); return; }
            chosen.has(c.id) ? chosen.delete(c.id) : chosen.add(c.id); draw();
          } }),
        }),
        h("p", { class: "field-hint" }, `${chosen.size} chosen. Dimmed Pokémon can't go into ${s.gameName}${other ? `; ${other} more fit in other boxes` : ""}.`));
    };
    draw();
    const ok = await dialog({
      title: `Withdraw into ${s.gameName}`, wide: true,
      body: h("div", null, holder, h("label", { class: "field" }, h("span", { class: "field-label" }, "Put them in"), targetSel),
        h("p", { class: "field-hint" }, "Each Pokémon stays in Home until it is safely in this save. Moving Pokémon between generations is not available yet.")),
      buttons: [{ label: "Cancel", value: false, kind: "ghost" }, { label: "Withdraw", value: true, kind: "primary" }],
    });
    if (!ok || !chosen.size) return;
    st.busy = true; render();
    try {
      const res = await withdraw({ api: app.api, store, entryId: st.activeId, monIds: [...chosen], targetBox: targetSel.value === "" ? null : Number(targetSel.value) });
      await reopen();
      home.refresh().catch(() => {});
      if (res.done.length && targetSel.value !== "") st.box = Number(targetSel.value);
      for (const f of res.failed) toast(`${f.view ? f.view.speciesName + ": " : ""}${f.error}`, "error", { timeout: 10000 });
      if (res.done.some((d) => d.commitError)) toast("Some withdrawals could not be finished on the server; the Home tab lists them.", "warn", { timeout: 10000 });
      if (res.done.length) await afterChange(`Withdrew ${plural(res.done.length, "Pokémon", "Pokémon")} into ${s.gameName}.`);
    } catch (e) {
      toast(`Nothing was moved: ${e.message}`, "error", { timeout: 10000 });
    } finally { st.busy = false; render(); }
  }

  async function afterChange(message) {
    render();
    const entry = store.get(st.activeId);
    const go = await dialog({
      title: message,
      body: "Download the updated save now and replace the file in your emulator or port. Close the game first: a running game would overwrite it.",
      buttons: [{ label: "Later", value: false, kind: "ghost" }, { label: "Download", value: true, kind: "primary" }],
    });
    if (go) download(entry);
  }

  async function download(entry, mode = "same") {
    try {
      if (mode === "plain") {
        const s = await openEntry(entry);
        store.downloadBlob(exportSave(s, "plain"), entry.filename.replace(/\.[^.]*$/, "") + ".sav");
      } else {
        await store.download(entry.id);
      }
      toast(`Downloaded ${entry.filename}. Replace your old file with it.`, "ok");
    } catch (e) { toast(`Download failed: ${e.message}`, "error"); }
  }

  async function closeEntry(entry) {
    if (entry.dirty && !(await confirmDialog("This save has changes you have not downloaded. Pokémon you deposited are safe in Home, but Pokémon you withdrew into it are only in this copy.", { title: `Close ${entry.filename}?`, confirmLabel: "Close anyway", danger: true }))) return;
    await store.remove(entry.id);
    if (st.activeId === entry.id) { st.activeId = null; st.save = null; }
    render();
  }

  render();
  const pre = store.list()[0];
  if (pre && !st.activeId) activate(pre.id);
}

/** Short "where is my save" help; the full table is in docs/research/ports-and-emulators.md §3.3. */
function whereIsMySave() {
  const rows = [
    ["mGBA, VBA-M, SameBoy, melonDS", "Next to the ROM, same name, .sav"],
    ["RetroArch", "saves/<core name>/<game>.srm (turn off SRAM compression or upload as is)"],
    ["DeSmuME", "Battery/<game>.dsv"],
    ["3DS Virtual Console", "sav.dat, exported with a save manager"],
    ["Switch Online (Game Boy)", "exported save; the SRAM header is kept"],
    ["gb-recompiled / gbarecomp ports", "next to the program or the ROM, .sav"],
    ["Platinum PC port", "save.bin in the game folder"],
    ["Frigate (Black 2 / White 2)", "IREO.sav / IRDO.sav in the Frigate data folder"],
  ];
  return h("div", { class: "help-body" },
    h("table", { class: "help-table" }, h("tbody", null, rows.map(([a, b]) => h("tr", null, h("th", { scope: "row" }, a), h("td", null, b))))),
    h("p", { class: "field-hint" }, "Close the game or emulator before you upload and before you replace the file. Replace only the .sav/.srm/.dsv, never a separate .rtc file."));
}
