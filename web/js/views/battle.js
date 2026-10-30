/* Battle tab: the lobby at #battle, one battle at a time at #battle/<id> (playing, watching, or
   the log of a finished one).

   Data comes from the hub (server/battles.js): battle.list when the tab opens, the room changes or
   the socket reconnects, then pushes: "battle.challenge" (challenges to or from us), "battle"
   (summaries of battles in the room and our own) and "battle.log" (lines of the battle we have
   open, handed to its BattleClient). The view stays mounted while hidden, so a battle keeps
   running (without animation pauses) while the player looks at another tab; a challenge or an
   accepted challenge shows a toast wherever they are. */
import { h, clear, toast } from "../ui.js";
import { renderLobby } from "../battle/lobby.js";
import { challengeDialog, acceptDialog } from "../battle/challenge.js";
import { BattleClient } from "../battle/client.js";
import { createBattleScreen } from "../battle/screen.js";
import "../battle/real-teams.js";   // registers the "From Home" and "From a save" team pickers

const OPTIONS_KEY = "pmw.battle.options";
let teardown = null;

function loadOptions() {
  try { return JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "null") ?? {}; } catch { return {}; }
}
function saveOptions(o) {
  try { globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(o)); } catch { /* storage blocked: fine */ }
}

export function mount(el, app) {
  const me = app.user.id;
  const data = { me, people: [], challenges: [], battles: [], recent: [], sources: ["random"], loading: true, error: null };
  const root = h("div", { class: "bt-root" });
  el.append(root);
  let current = null;              // { id, client, screen }
  let onBattleTab = false;
  let lastOptions = loadOptions();
  const offs = [];

  const people = () => {
    const seen = new Map();
    for (const u of app.presence()) seen.set(u.id, { id: u.id, name: app.nameOf(u.id) });
    return [...seen.values()];
  };
  const isVisible = () => !el.hidden && globalThis.document?.visibilityState !== "hidden";

  /* ----- lobby data ----- */

  function upsert(list, item, keep) {
    const i = list.findIndex((x) => x.id === item.id);
    if (!keep) { if (i >= 0) list.splice(i, 1); return; }
    if (i >= 0) list[i] = item; else list.unshift(item);
  }

  async function refresh() {
    try {
      const r = await app.ws.request("battle.list", { roomId: app.roomId });
      Object.assign(data, { challenges: r.challenges, battles: r.battles, recent: r.recent, sources: r.sources ?? ["random"], error: null });
    } catch (e) {
      data.error = /Join the room/.test(e.message) ? null : e.message;   // the hub join may still be on its way
    }
    data.loading = false;
    renderLobbyIfShown();
  }

  function renderLobbyIfShown() {
    if (current) return;
    data.people = people();
    clear(root, renderLobby(data, handlers));
  }

  async function startPractice(options) {
    const r = await challengeDialog(app, { practice: true, options: options ?? lastOptions, sources: data.sources });
    if (!r) return;
    lastOptions = r.options; saveOptions(r.options);
    try {
      const { battle } = await app.ws.request("battle.challenge", { to: "cpu", roomId: app.roomId, options: r.options, team: r.team });
      upsert(data.battles, battle, true);
      app.go("battle", battle.id);
    } catch (e) { toast(e.message, "error"); }
  }

  async function challenge(to, options) {
    const opponents = people().filter((p) => p.id !== me);
    const r = await challengeDialog(app, { opponents, to, options: options ?? lastOptions, sources: data.sources });
    if (!r) return;
    lastOptions = r.options; saveOptions(r.options);
    try {
      const { challenge: c } = await app.ws.request("battle.challenge", { to: r.to, roomId: app.roomId, options: r.options, team: r.team });
      upsert(data.challenges, c, true);
      toast(`Challenge sent to ${c.to.name}`, "ok");
      renderLobbyIfShown();
    } catch (e) { toast(e.message, "error"); }
  }

  async function answer(c) {
    const r = await acceptDialog(app, c, { sources: data.sources });
    if (!r) return;
    try {
      if (r.action === "decline") { await app.ws.request("battle.decline", { id: c.id }); return; }
      const { battle } = await app.ws.request("battle.accept", { id: c.id, team: r.team });
      upsert(data.battles, battle, true);
      app.go("battle", battle.id);
    } catch (e) { toast(e.message, "error"); refresh(); }
  }

  const handlers = {
    practice: () => startPractice(),
    challenge: (to) => challenge(to),
    accept: (c) => answer(c),
    decline: (c) => app.ws.request("battle.decline", { id: c.id }).catch((e) => toast(e.message, "error")),
    cancel: (c) => app.ws.request("battle.cancel", { id: c.id }).catch((e) => toast(e.message, "error")),
    open: (id) => app.go("battle", id),
  };

  /* ----- one battle ----- */

  function closeBattle() {
    if (!current) return;
    current.client.close();
    current.screen?.destroy();
    current = null;
  }

  async function openBattle(id) {
    if (current?.id === id) return;
    closeBattle();
    const client = new BattleClient({ id, ws: app.ws, isVisible, onChange: (ev) => cur.screen?.update(ev) });
    const cur = { id, client, screen: null };
    current = cur;
    clear(root, h("div", { class: "screen screen-center" }, app.ui.spinner("Joining the battle…")));
    try {
      await client.join();
    } catch (e) {
      if (current !== cur) return;
      current = null;
      toast(e.message, "error");
      app.go("battle");
      return;
    }
    if (current !== cur) return;
    cur.screen = createBattleScreen(app, client, {
      onExit: () => app.go("battle"),
      onRematch: (b) => {
        if (!b) return;
        if (b.practice) return startPractice(b.options);
        const side = b.players.p1.id === me ? "p2" : "p1";
        return challenge(b.players[side].id, b.options);
      },
    });
    clear(root, h("div", { class: "view-inner bt-wrap" }, cur.screen.el));
  }

  function showLobby() {
    closeBattle();
    renderLobbyIfShown();
    refresh();
  }

  /* ----- pushes ----- */

  offs.push(app.ws.on("battle.challenge", ({ challenge: c }) => {
    const known = data.challenges.find((x) => x.id === c.id);
    upsert(data.challenges, c, c.status === "pending");
    if (c.status === "pending" && !known && c.to.id === me) {
      toast(`${c.from.name} challenges you to a battle`, "info", { timeout: 15000, action: { label: "View", onClick: () => app.go("battle") } });
    } else if (c.status === "accepted" && c.from.id === me && c.battleId) {
      if (onBattleTab && !current) app.go("battle", c.battleId);
      else toast(`${c.to.name} accepted your challenge`, "ok", { timeout: 15000, action: { label: "Open", onClick: () => app.go("battle", c.battleId) } });
    } else if ((c.status === "declined" || c.status === "expired" || c.status === "cancelled") && known && c.reason && (c.from.id === me || c.status !== "cancelled")) {
      toast(c.reason, "info");
    }
    renderLobbyIfShown();
  }));

  offs.push(app.ws.on("battle", ({ battle: b }) => {
    const live = b.status === "active";
    upsert(data.battles, b, live);
    if (!live && (b.roomId === app.roomId)) { upsert(data.recent, b, true); data.recent.splice(10); }
    if (current?.id === b.id) { current.client.battle = b; current.screen?.update({ type: "summary" }); }
    renderLobbyIfShown();
  }));

  offs.push(app.ws.on("battle.log", (m) => { if (current?.id === m.id) current.client.push(m); }));

  // After a reconnect the hub re-joins the room; our open battle may have moved on meanwhile.
  offs.push(app.ws.on("joined", (m) => {
    if (m.roomId !== app.roomId) return;
    refresh();
    if (current?.screen) current.client.join().catch((e) => console.warn("battle rejoin:", e.message));
  }));
  offs.push(app.on("room", () => { data.challenges = []; data.battles = []; data.recent = []; refresh(); }));
  offs.push(app.on("presence", () => renderLobbyIfShown()));
  offs.push(app.on("tab", (name, route) => {
    onBattleTab = name === "battle";
    if (!onBattleTab) return;
    const id = route?.rest?.[0];
    if (id) openBattle(id); else showLobby();
  }));

  renderLobbyIfShown();
  refresh();

  teardown = () => { closeBattle(); for (const off of offs) off(); };
}

export function unmount() {
  teardown?.();
  teardown = null;
}
