/* The Matrix side of the widget: URL hints, the room member list and OpenID tokens.

   Nothing in here proves identity except openIdToken(): URL parameters ($matrix_user_id and
   friends) are hints a user can edit, and member display names are untrusted text. The server
   verifies the OpenID token with the user's homeserver (server/auth.js).

   Member list: since matrix-widget-api 1.13 the client pushes the full room state with the
   `update_state` to-widget action (after capability approval, and again whenever the viewed room
   changes), then single changes the same way. readStateEvents() may only see the loaded timeline
   on Element, but Commet answers it from real room state, so we do both and merge by state_key,
   keeping the newest event (docs/research/matrix-widget.md §1.4). Older clients deliver state
   through `send_event`; those are merged too.

   The WidgetApi itself was started by js/widget-early.js (window.PMW_EARLY), which buffered
   whatever arrived before this module loaded. */

const early = globalThis.PMW_EARLY || { isWidget: false, readyPromise: Promise.resolve(), attach() {} };
const params = new URLSearchParams(globalThis.location ? location.search : "");

/** First URL parameter among names that is present and not an unsubstituted "$template". */
function param(...names) {
  for (const n of names) {
    const v = params.get(n);
    if (v && !v.startsWith("$")) return v;
  }
  return null;
}

export const isWidget = !!early.isWidget;

/** Untrusted hints from the widget URL (Element templates, Commet raw replacement). */
export const hints = Object.freeze({
  roomId: param("roomId", "room_id", "matrix_room_id"),
  userId: param("userId", "user_id", "matrix_user_id"),
  displayName: param("displayName", "display_name", "matrix_display_name"),
  theme: early.normaliseTheme ? early.normaliseTheme(param("theme", "client_theme")) : null,
  lang: param("lang", "language", "client_language"),
  widgetId: param("widgetId"),
});

/* ---------- member list ---------- */

const memberEvents = new Map();   // state_key -> { ev, pushed }
const memberListeners = new Set();
const eventListeners = new Set();
let derivedRoomId = null;
let notifyQueued = false;

function upsertMember(ev, pushed) {
  if (!ev || ev.type !== "m.room.member" || typeof ev.state_key !== "string") return false;
  // A client pushes the state of whichever room is viewed; only the widget's own room counts.
  const expected = hints.roomId || derivedRoomId;
  if (ev.room_id && expected && ev.room_id !== expected) return false;
  if (ev.room_id && !derivedRoomId) derivedRoomId = ev.room_id;
  const cur = memberEvents.get(ev.state_key);
  if (cur) {
    const a = cur.ev.origin_server_ts || 0, b = ev.origin_server_ts || 0;
    if (b < a) return false;                    // older than what we have
    if (b === a && cur.pushed && !pushed) return false;   // a read never beats a push of the same age
  }
  memberEvents.set(ev.state_key, { ev, pushed });
  return true;
}

function queueNotify() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    const list = members();
    for (const fn of memberListeners) {
      try { fn(list); } catch (e) { console.error(e); }
    }
  });
}

/** Joined members, sorted by display name: [{ id, name, avatarUrl, membership }]. */
export function members() {
  const out = [];
  for (const [id, { ev }] of memberEvents) {
    const c = ev.content || {};
    if (c.membership !== "join") continue;
    const name = typeof c.displayname === "string" && c.displayname.trim() ? c.displayname.trim() : id;
    out.push({ id, name, avatarUrl: typeof c.avatar_url === "string" ? c.avatar_url : null, membership: c.membership });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name) || x.id.localeCompare(y.id));
}

/** Display name for a user id from member state (untrusted text; render with textContent). */
export function displayName(userId) {
  const m = memberEvents.get(userId);
  const n = m && m.ev.content && m.ev.content.displayname;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

/** Subscribe to member list changes; fn(members()). Returns an unsubscribe function. */
export function onMembers(fn) {
  memberListeners.add(fn);
  return () => memberListeners.delete(fn);
}

/** Subscribe to non-member room events the client delivers (needs receive.event capabilities). */
export function onRoomEvent(fn) {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

/** The Matrix room this widget lives in: URL hint, else the room_id of pushed member state. */
export function roomId() {
  return hints.roomId || derivedRoomId;
}

function onUpdateState(data) {
  let changed = false;
  for (const ev of (data && data.state) || []) changed = upsertMember(ev, true) || changed;
  if (changed) queueNotify();
}

function onSendEvent(ev) {
  if (ev && ev.state_key !== undefined && ev.state_key !== null) {
    if (upsertMember(ev, true)) queueNotify();
    return;
  }
  for (const fn of eventListeners) {
    try { fn(ev); } catch (e) { console.error(e); }
  }
}

/* ---------- lifecycle ---------- */

let initPromise = null;

/** Wait for the widget handshake, start receiving member state and read what the client has.
    onWaiting(seconds) is called every few seconds while the client has not answered (it may be
    showing a "load this widget?" or capabilities prompt). Resolves immediately outside a widget. */
export function init({ onWaiting } = {}) {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!isWidget) {
      if (early.error) throw new Error(early.error);
      return;
    }
    early.attach("update_state", onUpdateState);
    early.attach("send_event", onSendEvent);
    const started = Date.now();
    const tick = onWaiting ? setInterval(() => onWaiting(Math.round((Date.now() - started) / 1000)), 3000) : null;
    try {
      await early.readyPromise;
    } finally {
      if (tick) clearInterval(tick);
    }
    await refreshMembers();
  })();
  return initPromise;
}

/** Ask the client for member state (best effort; update_state pushes keep coming either way). */
export async function refreshMembers() {
  if (!isWidget || !early.api) return members();
  const cap = "org.matrix.msc2762.receive.state_event:m.room.member";
  if (early.api.hasCapability && early.ready && !early.api.hasCapability(cap)) return members();
  try {
    const evs = await early.api.readStateEvents("m.room.member", 1000);
    let changed = false;
    for (const ev of evs || []) changed = upsertMember(ev, false) || changed;
    if (changed) queueNotify();
  } catch (e) {
    console.warn("readStateEvents failed:", e && e.message);
  }
  return members();
}

/** Capabilities the client approved (null if it did not tell us). */
export function hasCapability(cap) {
  return !!(early.api && early.api.hasCapability && early.api.hasCapability(cap));
}

/* ---------- OpenID ---------- */

export const OPENID_TIMEOUT_MS = 60_000;

/** Get an OpenID token from the Matrix client (MSC1960). Handles both the immediate answer and
    the two-phase flow where the client first replies "request" and asks the user; the user may
    sit on that prompt, so we give up after timeoutMs with a message that says what to do.
    Resolves { access_token, matrix_server_name, expires_in }. */
export async function openIdToken({ timeoutMs = OPENID_TIMEOUT_MS } = {}) {
  if (!isWidget || !early.api) throw new Error("Not running inside a Matrix client.");
  await init();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      "Your Matrix client did not confirm who you are within a minute. If it is showing a " +
      "permission prompt, allow it and press Retry.")), timeoutMs);
  });
  try {
    const r = await Promise.race([early.api.requestOpenIDConnectToken(), timeout]);
    if (!r || typeof r.access_token !== "string" || typeof r.matrix_server_name !== "string")
      throw new Error("Your Matrix client returned an incomplete sign-in token.");
    return { access_token: r.access_token, matrix_server_name: r.matrix_server_name, expires_in: Number(r.expires_in) || 3600 };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/declined/i.test(msg)) throw new Error("You declined the identity check in your Matrix client. Press Retry to be asked again.");
    if (/timed out/i.test(msg)) throw new Error("Your Matrix client did not answer the sign-in request. Press Retry.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** The theme the client asked for ("dark" | "light"), or null to follow prefers-color-scheme. */
export function theme() {
  return document.documentElement.getAttribute("data-theme") || null;
}

/** Test hook: feed member state as if pushed by the client. */
export const _internal = { onUpdateState, onSendEvent, reset() { memberEvents.clear(); derivedRoomId = null; } };
