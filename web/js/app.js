/* Boot and app shell: config -> Matrix handshake -> sign-in -> WebSocket -> tabs.

   Each tab is a module in js/views/ that exports
       mount(el, app)      called once, the first time the tab is opened (may be async)
       unmount()           optional; called when the shell tears down (sign-out)
   Views stay mounted while hidden, so a battle keeps running while the player looks at Saves;
   listen to app.on("tab") to react to becoming visible.

   The `app` object every view receives:

   app = {
     config,       /config.json: { devAuth, unofficialTransfers, spriteBase, homeBoxes,
                   publicUrl, dmCodeLogin }
     user,         { id, displayName }: the Matrix user the server verified (never a URL hint)
     api,          REST client (js/api.js createApi). Paths are relative to the page, no
                   leading slash: app.api.get("api/me"), app.api.post("api/home/deposit", body),
                   .put(path, body), .del(path), .request(method, path, body, { raw, signal }).
                   Resolves parsed JSON (null for 204); throws ApiError { message, status, data }
                   whose message is the server's own text, fit for a toast.
     ws,           WebSocket client (js/api.js Socket):
                     ws.request(type, payload) -> Promise of the reply's result (rejects with
                       the server's error text, or on timeout / lost connection)
                     ws.send(type, payload)    fire and forget
                     ws.on(type, fn) -> off    server pushes ("presence", "trade", "battle", ...)
                     ws.state                  "connecting" | "open" | "reconnecting" | ...
     matrix,       js/matrix.js: isWidget, hints (untrusted URL values), members(), onMembers(fn),
                   displayName(userId), roomId(), onRoomEvent(fn)
     store,        js/savestore.js store: add(bytes, name), list(), get(id), update(id, bytes),
                   markExported(id), remove(id), download(id), onChange(fn), downloadBlob(...)
     ui,           js/ui.js: h(), dialog(), confirmDialog(), promptDialog(), toast(), spinner(),
                   emptyState(), formatting helpers
     roomId,       the hub room this widget joined: the Matrix room id, or "standalone"
     members(),    Matrix room members [{ id, name, avatarUrl }] (empty outside a widget;
                   names are untrusted text, render with textContent)
     presence(),   users with the widget open in this room right now [{ id, displayName }]
     nameOf(id),   best display name for a user id (member state, hub presence, then localpart)
     on(event, fn) -> off. Events:
                     "presence"   (users)          hub presence for app.roomId changed
                     "members"    (members)        Matrix member list changed
                     "connection" (state, info)    WebSocket state changed
                     "room"       (roomId)         app.roomId changed (room id learnt late)
                     "tab"        (name, route)    a tab became visible; route = { name, rest, params }
     go(tab, ...rest)  navigate, e.g. app.go("trade", tradeId)
   }
*/
import * as ui from "./ui.js";
import * as matrix from "./matrix.js";
import { createApi, Socket } from "./api.js";
import { signIn, openIdLogin, openInBrowserTab, signOut } from "./auth.js";
import { store } from "./savestore.js";
import * as announcer from "./announce.js";

const { h, clear } = ui;

const VIEWS = {
  saves: () => import("./views/saves.js"),
  home: () => import("./views/home.js"),
  trade: () => import("./views/trade.js"),
  battle: () => import("./views/battle.js"),
};
const TABS = Object.keys(VIEWS);

const $ = (id) => document.getElementById(id);
const mainEl = $("main");
const tabsEl = $("tabs");

/* ---------- app events ---------- */

const listeners = new Map();
function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}
function emit(event, ...args) {
  for (const fn of [...(listeners.get(event) || [])]) {
    try { fn(...args); } catch (e) { console.error(e); }
  }
}

let presenceUsers = [];
let router = null;

const app = {
  config: null,
  user: null,
  api: null,
  ws: null,
  matrix,
  store,
  ui,
  roomId: "standalone",
  members: () => matrix.members(),
  presence: () => presenceUsers.slice(),
  nameOf(userId) {
    // Room member state is what the Matrix client shows right now; the hub's name is from sign-in.
    const p = presenceUsers.find((u) => u.id === userId);
    return matrix.displayName(userId) || (p && p.displayName) || ui.localpart(userId);
  },
  on,
  go: (tab, ...rest) => router && router.go(tab, ...rest),
};
// Handy in the browser console and for the dev harness; views get `app` as an argument.
globalThis.PMW_APP = app;

/* ---------- boot ---------- */

function setPhase(phase) {
  document.body.dataset.phase = phase;
}

function bootScreen(text) {
  clear(mainEl, h("div", { class: "screen screen-center" }, ui.spinner(text)));
}

function errorScreen(title, message, { retry = true } = {}) {
  setPhase("error");
  clear(mainEl, h("div", { class: "screen screen-center" },
    h("div", { class: "card card-narrow" },
      h("h1", null, title),
      h("p", { class: "muted" }, message),
      retry && h("button", { type: "button", class: "btn btn-primary", onclick: () => location.reload() }, "Reload"))));
}

async function loadConfig() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await app.api.get("config.json", { auth: false });
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

async function main() {
  setPhase("boot");
  app.api = createApi({ storageKey: "pmw.token." + (matrix.hints.widgetId || "tab") });

  try {
    app.config = await loadConfig();
  } catch (e) {
    errorScreen("Cannot reach the server", e.message);
    return;
  }

  if (matrix.isWidget) {
    bootScreen("Connecting to your Matrix client…");
    try {
      await matrix.init({
        onWaiting: (s) => bootScreen(s < 6
          ? "Connecting to your Matrix client…"
          : "Still waiting for your Matrix client. If it asks whether to load this widget or grant it permissions, accept to continue."),
      });
    } catch (e) {
      errorScreen("The Matrix connection failed", e.message);
      return;
    }
  }
  matrix.onMembers((list) => { emit("members", list); syncRoom(); });

  setPhase("signin");
  const user = await signIn({ api: app.api, config: app.config, matrix, el: mainEl, status: bootScreen });
  app.user = user;
  store.useScope(user.id);
  await store.ready().catch(() => { /* in-memory only */ });
  startShell();
}

/* ---------- shell ---------- */

function startShell() {
  setPhase("app");
  announcer.init(app);
  clear(mainEl);
  renderUser();
  app.api.onUnauthorized(() => reauth());

  const ws = new Socket({ getToken: () => app.api.token });
  app.ws = ws;
  ws.onState((state, info) => {
    renderConnection(state, info); emit("connection", state, info);
    if (state === "open") reportActivity(true);   // presence starts empty on a fresh connection
  });
  ws.on("presence", (m) => { if (m.roomId === app.roomId) setPresence(m.users); });
  ws.on("joined", (m) => { if (m.roomId === app.roomId && Array.isArray(m.users)) setPresence(m.users); });
  ws.on("welcome", (m) => { if (m.user && m.user.id !== app.user.id) console.warn("hub welcomed a different user", m.user.id); });
  ws.on("unauthorized", () => reauth());
  ws.connect();
  syncRoom(true);
  globalThis.addEventListener("online", () => { if (ws.state === "reconnecting") ws.reconnect(); });

  $("presence").addEventListener("click", showPresence);
  $("user-chip").addEventListener("click", showUserMenu);

  router = ui.createRouter({ routes: TABS, fallback: "saves", onRoute: showTab });
  router.start();
  ui.toast(`Signed in as ${app.user.displayName || app.user.id}`, "ok", { timeout: 2500 });
}

/** Join the Matrix room's hub channel, or "standalone" until a room id is known. */
function syncRoom(force = false) {
  if (!app.ws) return;
  const target = matrix.roomId() || "standalone";
  if (!force && target === app.roomId) return;
  const previous = app.roomId;
  app.roomId = target;
  if (previous !== target) {
    app.ws.leave(previous).catch(() => {});
    presenceUsers = [];
    renderPresence();
    emit("room", target);
  }
  app.ws.join(target).then((r) => {
    if (app.roomId === target && r && Array.isArray(r.users)) setPresence(r.users);
  }, (e) => console.warn("join failed:", e.message));
}

function setPresence(users) {
  presenceUsers = (users || []).filter((u) => u && typeof u.id === "string");
  renderPresence();
  emit("presence", app.presence());
}

/* ---------- re-authentication ---------- */

let reauthing = null;
function reauth() {
  if (reauthing) return reauthing;
  reauthing = (async () => {
    if (matrix.isWidget) {
      try {
        const user = await openIdLogin({ api: app.api, matrix });
        if (user.id !== app.user.id) { location.reload(); return; }
        app.ws.reconnect();
        return;
      } catch (e) {
        console.warn("silent re-auth failed:", e.message);
      }
    }
    app.api.clearToken();
    await ui.dialog({
      title: "Signed out",
      body: "Your session ended. Sign in again to continue.",
      buttons: [{ label: "Sign in", value: true, kind: "primary" }],
      dismissable: false,
    });
    location.reload();
  })().finally(() => { reauthing = null; });
  return reauthing;
}

/* ---------- top bar ---------- */

function renderUser() {
  const chip = $("user-chip");
  const name = app.user.displayName || ui.localpart(app.user.id);
  clear(chip.querySelector(".user-avatar"), ui.avatar(name, app.user.id, "sm"));
  chip.querySelector(".user-name").textContent = name;
  chip.title = app.user.id;
  chip.hidden = false;
}

const CONN_TEXT = { idle: "Offline", connecting: "Connecting…", open: "Online", reconnecting: "Reconnecting…", unauthorized: "Signed out", closed: "Offline" };

function renderConnection(state, info = {}) {
  const el = $("conn");
  el.hidden = false;
  el.dataset.state = state;
  el.querySelector(".conn-text").textContent = CONN_TEXT[state] || state;
  el.title = state === "reconnecting" && info.retryIn
    ? `Lost the connection to the game server; retrying in ${Math.ceil(info.retryIn / 1000)} s`
    : "Connection to the game server: " + (CONN_TEXT[state] || state);
}

function renderPresence() {
  const el = $("presence");
  el.hidden = false;
  const n = presenceUsers.length;
  el.querySelector(".presence-count").textContent = String(n);
  el.title = n ? `${ui.plural(n, "person", "people")} with the widget open: ${presenceUsers.map((u) => u.displayName || u.id).join(", ")}` : "Nobody else has the widget open";
  el.setAttribute("aria-label", `${ui.plural(n, "person", "people")} here`);
}

/** Tell the hub which tab this widget shows, for the activity in everyone's presence list. */
let reportedTab = null;
function reportActivity(force = false) {
  if (!app.ws || app.ws.state !== "open" || !currentTab || (!force && reportedTab === currentTab)) return;
  reportedTab = currentTab;
  app.ws.send("activity", { tab: currentTab });
}

/** A person's activity as a badge: what they are doing in the widget right now. */
export const ACTIVITY = { battling: ["Battling", "accent"], trading: ["Trading", "warn"], home: ["In Home", "ok"], saves: ["Moving Pokémon", "ok"], "battle-lobby": ["Looking for a battle", "ok"] };
function activityBadge(u) {
  const [text, kind] = ACTIVITY[u.activity] || ["Online", "ok"];
  return ui.badge(text, kind);
}

function personRow(id, name, extra) {
  return h("li", { class: "person" }, ui.avatar(name, id, "sm"),
    h("span", { class: "person-text" }, h("span", { class: "person-name" }, name), h("span", { class: "person-id" }, id)),
    extra);
}

let closePresence = null;
function showPresence() {
  const online = new Set(presenceUsers.map((u) => u.id));
  const others = app.members().filter((m) => !online.has(m.id));
  ui.dialog({
    title: app.roomId === "standalone" ? "Online now" : "In this room",
    body: [
      h("h3", { class: "section-label" }, `Widget open (${presenceUsers.length})`),
      presenceUsers.length
        ? h("ul", { class: "people" }, presenceUsers.map((u) => personRow(u.id, app.nameOf(u.id), [
            u.id === app.user.id ? ui.badge("you", "muted") : null,
            activityBadge(u),
            u.battleId && u.id !== app.user.id
              ? h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => { closePresence?.(); app.go("battle", u.battleId); } }, "Watch")
              : null,
          ])))
        : h("p", { class: "muted" }, "Nobody yet."),
      others.length ? h("h3", { class: "section-label" }, `Other room members (${others.length})`) : null,
      others.length ? h("ul", { class: "people people-dim" }, others.map((m) => personRow(m.id, m.name))) : null,
    ],
    buttons: [{ label: "Close", value: true, kind: "primary" }],
    onOpen: (ctx) => { closePresence = () => ctx.close(true); },
  }).then(() => { closePresence = null; });
}

function showUserMenu() {
  const name = app.user.displayName || ui.localpart(app.user.id);
  const buttons = [];
  if (matrix.isWidget) buttons.push({ label: "Open in browser tab", value: "tab", kind: "ghost" });
  else buttons.push({ label: "Sign out", value: "signout", kind: "danger" });
  buttons.push({ label: "Close", value: null, kind: "primary" });
  ui.dialog({
    title: "Your account",
    body: [
      h("div", { class: "account" }, ui.avatar(name, app.user.id, "lg"),
        h("div", null, h("div", { class: "account-name" }, name), h("code", { class: "account-id" }, app.user.id))),
      h("p", { class: "muted" }, matrix.isWidget
        ? "Verified by your homeserver through your Matrix client."
        : "Signed in in this browser tab."),
      store.persistent ? null : h("p", { class: "muted small" }, "This browser does not keep opened saves between visits here; always download your changes."),
      announceSwitch(),
    ],
    buttons,
  }).then(async (v) => {
    if (v === "tab") openInBrowserTab({ api: app.api, matrix });
    if (v === "signout") {
      const dirty = store.list().filter((s) => s.dirty);
      if (dirty.length && !(await ui.confirmDialog(`${ui.plural(dirty.length, "save has", "saves have")} changes you have not downloaded. Sign out anyway?`, { title: "Unsaved changes", confirmLabel: "Sign out", danger: true }))) return;
      teardownViews();
      await signOut({ api: app.api });
      location.reload();
    }
  });
}

/** "Announce my trades and battles in the room": asks the Matrix client for permission to post when switched on. */
function announceSwitch() {
  if (!announcer.available()) return null;
  const box = h("input", { type: "checkbox", checked: announcer.enabled() });
  const note = h("span", { class: "field-hint" }, "Posts a short notice in this room when you offer a trade, finish one, challenge someone or win a battle. Your Matrix client asks you to allow it.");
  box.addEventListener("change", async () => {
    box.disabled = true;
    const ok = await announcer.setEnabled(app, box.checked);
    box.checked = announcer.enabled();
    box.disabled = false;
    if (!ok) ui.toast("Your Matrix client did not allow the widget to post in the room.", "warn");
  });
  return h("label", { class: "check announce-switch" }, box, h("span", null, h("strong", null, "Announce my trades and battles in the room"), h("br"), note));
}

/* ---------- tabs ---------- */

const views = new Map();   // name -> { el, mod }
let currentTab = null;

async function showTab(route) {
  const name = route.name;
  currentTab = name;
  ui.setActiveTab(tabsEl, name);
  for (const [n, v] of views) v.el.hidden = n !== name;
  let v = views.get(name);
  if (!v) {
    const el = h("section", { class: "view", dataset: { view: name }, role: "tabpanel", "aria-labelledby": "tab-" + name });
    mainEl.appendChild(el);
    v = { el, mod: null };
    views.set(name, v);
    el.appendChild(h("div", { class: "screen screen-center" }, ui.spinner()));
    try {
      v.mod = await VIEWS[name]();
      clear(el);
      await v.mod.mount(el, app);
    } catch (e) {
      console.error(`view ${name} failed:`, e);
      clear(el, ui.emptyState({ title: "This tab failed to load", text: e.message, action: { label: "Reload", onClick: () => location.reload() } }));
    }
    el.hidden = currentTab !== name;   // the player may have switched tabs meanwhile
  }
  if (currentTab === name) { emit("tab", name, route); reportActivity(); }
}

function teardownViews() {
  for (const [, v] of views) {
    try { v.mod && v.mod.unmount && v.mod.unmount(); } catch (e) { console.error(e); }
  }
  views.clear();
}

/* ---------- global safety nets ---------- */

globalThis.addEventListener("unhandledrejection", (ev) => {
  const msg = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason);
  console.warn("unhandled:", ev.reason);
  if (document.body.dataset.phase === "app") ui.toast(msg, "error");
});

main().catch((e) => {
  console.error(e);
  errorScreen("Something went wrong", e.message || String(e));
});
