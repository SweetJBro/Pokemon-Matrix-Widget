/* Home tab: the player's cloud boxes.

   One box at a time (Home has up to HOME_BOXES boxes of 30), with filters that dim what does
   not match and count matches in the other boxes, a detail card with the Pokémon's full record
   and history, and three ways to move: drag a Pokémon onto a cell, click "Move" then a cell
   (works on touch and keyboard), or "Move to box…". Withdrawing happens in the Saves tab, where
   the save it goes into is open; the card links there.

   A withdrawal whose tab closed half-way (server/home.js two-phase withdrawal) is listed at the
   top with "It's in my save" (commit) and "Keep it in Home" (cancel): only the player knows which
   is true. */
import { h, clear, toast, dialog, confirmDialog, promptDialog, emptyState, badge, plural, spinner, fmtRelative } from "../ui.js";
import { boxGrid, boxFrame } from "../components/box-grid.js";
import { monCard } from "../components/mon-card.js";
import { genLabel } from "../components/mon-sprite.js";
import { filterBar, matchesFilter, isFiltering, EMPTY_FILTER } from "../components/filters.js";
import { homeState } from "../home/state.js";

export async function mount(el, app) {
  const home = homeState(app);
  const base = app.config.spriteBase;
  const st = { box: 0, filter: { ...EMPTY_FILTER }, focusId: null, detail: null, moving: null, busy: false };
  const root = h("div", { class: "view-inner home-view" });
  const bar = filterBar((f) => { st.filter = f; render(); });
  const body = h("div");
  root.append(body);
  el.append(root);
  clear(body, spinner("Loading your Home…"));
  home.onChange(() => render());
  app.on("tab", (name) => { if (name === "home") home.refresh().catch(() => {}); });
  try { await home.load(); } catch (e) { clear(body, emptyState({ title: "Home did not load", text: e.message, action: { label: "Retry", onClick: () => home.refresh().catch((x) => toast(x.message, "error")) } })); return; }

  function render() {
    const d = home.data;
    if (!d) return;
    const total = d.boxes.reduce((n, b) => n + b.mons.length, 0);
    const b = d.boxes[st.box];
    const cells = Array.from({ length: d.boxSlots }, () => null);
    const filtering = isFiltering(st.filter);
    for (const m of b.mons) {
      cells[m.slot] = { view: { ...m.summary, gen: Number(m.format.slice(2)) }, id: m.id, locked: m.locked, flags: m.flags,
        selected: m.id === st.focusId || m.id === st.moving, dim: filtering && !matchesFilter(st.filter, m) };
    }
    const elsewhere = filtering ? d.boxes.map((x, i) => [i, x.mons.filter((m) => matchesFilter(st.filter, m)).length]).filter(([i, n]) => i !== st.box && n) : [];
    const grid = boxGrid({ cells, base, onPick: pick, onDrop: (from, to) => move(cells[from].id, st.box, to) });
    const frame = boxFrame({
      name: `${b.name} (${b.mons.length}/${d.boxSlots})`,
      onPrev: () => { st.box = (st.box + d.boxCount - 1) % d.boxCount; render(); },
      onNext: () => { st.box = (st.box + 1) % d.boxCount; render(); },
      onName: renameBox, grid,
    });
    const jump = h("select", { class: "input box-jump", "aria-label": "Box" },
      d.boxes.map((x, i) => h("option", { value: String(i), selected: i === st.box }, `${x.name} (${x.mons.length})`)));
    jump.addEventListener("change", () => { st.box = Number(jump.value); render(); });
    const focus = st.focusId ? b.mons.find((m) => m.id === st.focusId) || home.find(st.focusId) : null;

    clear(body,
      pendingBanner(d),
      total === 0 && h("div", { class: "card" }, emptyState({
        icon: "▦", title: "Your Home is empty",
        text: "Open a save in the Saves tab, pick Pokémon and deposit them. They wait here for trades and battles, and you can withdraw them into any save of the same generation.",
        action: { label: "Open a save", onClick: () => app.go("saves") },
      })),
      h("div", { class: "row home-head" }, h("h2", { class: "home-title" }, `Home · ${plural(total, "Pokémon", "Pokémon")}`), jump),
      bar,
      st.moving && h("div", { class: "banner" }, "Choose where it goes: click a slot in any box (switch boxes with ‹ ›). ",
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => { st.moving = null; render(); } }, "Cancel")),
      elsewhere.length ? h("p", { class: "field-hint" }, "Also in: ", elsewhere.map(([i, n]) =>
        h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => { st.box = i; render(); } }, `${d.boxes[i].name} (${n})`))) : null,
      h("div", { class: "split" }, h("div", null, frame), focus ? detailCard(focus) : h("div", { class: "card mon-card mon-card-hint" },
        h("p", { class: "field-hint" }, total ? "Click a Pokémon to see it. Drag it onto another slot to move it." : "Deposited Pokémon appear here."))));
  }

  function pendingBanner(d) {
    if (!d.pendingWithdrawals?.length) return null;
    return h("div", { class: "card banner banner-warn" },
      h("strong", null, `${plural(d.pendingWithdrawals.length, "withdrawal is", "withdrawals are")} not finished.`),
      h("p", null, "These Pokémon were sent to a save but the widget never heard back. If the save you downloaded has them, finish the withdrawal; otherwise keep them in Home."),
      h("ul", { class: "mini-list" }, d.pendingWithdrawals.map((w) => {
        const m = home.find(w.id);
        return h("li", null,
          h("span", null, `${m ? m.summary.speciesName + " Lv. " + m.summary.level : w.id} → ${genLabel(w.target.format)} ${w.target.game || ""}, ${fmtRelative(w.createdAt)}`),
          h("button", { type: "button", class: "btn btn-sm", onclick: () => finishPending(w.id, "commit") }, "It's in my save"),
          h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => finishPending(w.id, "cancel") }, "Keep it in Home"));
      })));
  }

  function detailCard(m) {
    const full = st.detail?.id === m.id ? st.detail : null;
    if (!full) loadDetail(m.id);
    const view = full ? full.view : { ...m.summary, gen: Number(m.format.slice(2)), format: m.format };
    const actions = [
      h("button", { type: "button", class: "btn btn-primary", disabled: !!m.locked, onclick: () => app.go("saves", "withdraw", m.id) }, "Withdraw…"),
      h("button", { type: "button", class: "btn", disabled: !!m.locked, onclick: () => { st.moving = m.id; render(); } }, "Move"),
      h("button", { type: "button", class: "btn", disabled: !!m.locked, onclick: () => moveToBox(m) }, "Move to box…"),
      h("button", { type: "button", class: "btn btn-danger", disabled: !!m.locked, onclick: () => release(m) }, "Release"),
    ];
    const card = monCard(view, { base, provenance: full?.provenance, locked: m.locked, flags: m.flags, actions });
    if (m.flags?.includes("seen-before")) {
      card.insertBefore(h("p", { class: "banner banner-danger" },
        "This exact Pokémon was in another player's Home before it came here. That happens when a save is copied before depositing, so it may be a clone."), card.children[1]);
    }
    return card;
  }

  async function loadDetail(id) {
    if (loadDetail.pending === id) return;
    loadDetail.pending = id;
    try {
      const d = await app.api.get(`api/home/mon/${encodeURIComponent(id)}`);
      if (st.focusId === id) { st.detail = d; render(); }
    } catch (e) { toast(e.message, "error"); }
    finally { loadDetail.pending = null; }
  }

  function pick(i, cell) {
    if (st.moving) {
      const id = st.moving;
      st.moving = null;
      if (cell?.id !== id) move(id, st.box, i); else render();
      return;
    }
    st.focusId = cell?.id ?? null;
    if (st.detail?.id !== st.focusId) st.detail = null;
    render();
  }

  async function move(id, box, slot) {
    try {
      await app.api.post("api/home/move", { id, box, slot });
      await home.refresh();
    } catch (e) { toast(e.message, "error"); render(); }
  }

  async function moveToBox(m) {
    const d = home.data;
    const sel = h("select", { class: "input" }, d.boxes.map((b, i) => h("option", { value: String(i), disabled: b.mons.length >= d.boxSlots }, `${b.name} (${d.boxSlots - b.mons.length} free)`)));
    const ok = await dialog({ title: `Move ${m.summary.speciesName}`, body: h("label", { class: "field" }, h("span", { class: "field-label" }, "To box"), sel),
      buttons: [{ label: "Cancel", value: false, kind: "ghost" }, { label: "Move", value: true, kind: "primary" }] });
    if (!ok) return;
    const box = Number(sel.value);
    const used = new Set(d.boxes[box].mons.map((x) => x.slot));
    const slot = Array.from({ length: d.boxSlots }, (_, i) => i).find((i) => !used.has(i));
    if (slot === undefined) { toast("That box is full.", "warn"); return; }
    await move(m.id, box, slot);
    st.box = box; render();
  }

  async function renameBox() {
    const b = home.data.boxes[st.box];
    const name = await promptDialog({ title: "Rename box", label: "Name", value: b.name, maxLength: 24, validate: (v) => (v.trim() ? null : "Enter a name") });
    if (name == null) return;
    try { await app.api.put(`api/home/box/${st.box}`, { name: name.trim() }); await home.refresh(); }
    catch (e) { toast(e.message, "error"); }
  }

  async function release(m) {
    const name = m.summary.isNicknamed ? `${m.summary.nickname} (${m.summary.speciesName})` : m.summary.speciesName;
    if (!(await confirmDialog(`${name} will be gone for good. This can't be undone.`, { title: `Release ${name}?`, confirmLabel: "Release", danger: true }))) return;
    try {
      await app.api.post("api/home/release", { id: m.id });
      st.focusId = null; st.detail = null;
      await home.refresh();
      toast(`Released ${name}.`, "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  async function finishPending(id, how) {
    try {
      await app.api.post(`api/home/withdraw/${encodeURIComponent(id)}/${how}`);
      await home.refresh();
      toast(how === "commit" ? "Withdrawal finished." : "Kept in Home.", "ok");
    } catch (e) { toast(e.message, "error"); }
  }

  render();
}
