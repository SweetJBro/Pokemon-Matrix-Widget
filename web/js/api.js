/* Clients for our own server: JSON REST and the /ws WebSocket.

   Every URL is resolved relative to the page, never from "/", so a deployment under BASE_PATH
   (https://example.org/pokemon/) works without configuration. The bearer token lives in memory
   and is mirrored to sessionStorage when that works, so a reload inside the same tab does not
   need a new OpenID round trip. Widget iframes get partitioned or ephemeral storage and several
   widgets of the same origin can share one tab's sessionStorage, so the key includes the widget
   id and nothing ever depends on the copy being there. No cookies (docs/research/matrix-widget.md
   §5.4).

   Server errors are JSON { error }; request() throws ApiError(message, status, data) with the
   server's message so views can show it as is.

   The WebSocket protocol is in server/hub.js: { type: "hello", token } first, then
   { type: "join", roomId } and feature messages. Messages carrying `rid` get exactly one
   { type: "reply", rid, ok, result | error }; Socket.request() turns that into a Promise.
   Socket reconnects with exponential backoff and re-joins its rooms. Nothing here touches the
   DOM, so test/web-api.test.js runs it under node with a fake fetch and a fake WebSocket. */

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

/** The directory the page was loaded from ("https://host/base/"). */
export function pageBase() {
  return globalThis.location ? new URL(".", globalThis.location.href).href : "http://localhost/";
}

/** ws(s):// URL of the hub, relative to base. */
export function wsUrl(base = pageBase()) {
  const u = new URL("ws", base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.hash = "";
  u.search = "";
  return u.href;
}

function safeSessionStorage() {
  try {
    const s = globalThis.sessionStorage;
    if (!s) return null;
    const k = "pmw.probe";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;   // blocked third-party storage, sandbox without allow-same-origin, ...
  }
}

/** REST client. Options are injectable for tests. */
export function createApi({
  base = pageBase(),
  fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null,
  storage = safeSessionStorage(),
  storageKey = "pmw.token",
} = {}) {
  let token = null;
  try { token = storage ? storage.getItem(storageKey) : null; } catch { token = null; }
  const unauthorized = new Set();

  function url(path) {
    return new URL(String(path).replace(/^\/+/, ""), base).href;
  }

  async function request(method, path, body, { auth = true, signal, raw = false, headers: extra } = {}) {
    if (!fetchImpl) throw new ApiError("This browser cannot make network requests.");
    const headers = { accept: "application/json", ...(extra || {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const sentToken = auth ? token : null;
    if (sentToken) headers.authorization = "Bearer " + sentToken;
    let res;
    try {
      res = await fetchImpl(url(path), {
        method, headers, signal,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
    }
    if (raw && res.ok) return res;
    if (res.status === 204) return null;
    let data = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = null; }
    }
    if (!res.ok) {
      const msg = (data && typeof data.error === "string" && data.error) || `The server answered ${res.status}.`;
      if (res.status === 401 && sentToken && sentToken === token) {
        for (const fn of unauthorized) {
          try { fn(); } catch (e) { console.error(e); }
        }
      }
      throw new ApiError(msg, res.status, data);
    }
    return data;
  }

  return {
    url,
    request,
    get: (path, opts) => request("GET", path, undefined, opts),
    post: (path, body = {}, opts) => request("POST", path, body, opts),
    put: (path, body = {}, opts) => request("PUT", path, body, opts),
    del: (path, opts) => request("DELETE", path, undefined, opts),
    get token() { return token; },
    setToken(t) {
      token = t || null;
      try {
        if (!storage) return;
        if (token) storage.setItem(storageKey, token); else storage.removeItem(storageKey);
      } catch { /* storage went away; memory copy is enough */ }
    },
    clearToken() { this.setToken(null); },
    /** fn() runs when a request carrying the current token gets 401 (session expired). */
    onUnauthorized(fn) { unauthorized.add(fn); return () => unauthorized.delete(fn); },
  };
}

/* ---------- WebSocket ---------- */

const OPEN = 1;

/**
 * Connection states (socket.state, onState listeners):
 *   "idle"         not started
 *   "connecting"   socket opening or waiting for "welcome"
 *   "open"         welcomed; requests flow
 *   "reconnecting" closed unexpectedly; info.retryIn ms until the next attempt
 *   "unauthorized" the server refused the token (close code 4003); call reconnect() after re-auth
 *   "closed"       close() was called
 */
export class Socket {
  constructor({
    url = wsUrl(),
    getToken,
    WebSocketImpl = globalThis.WebSocket,
    requestTimeoutMs = 20_000,
    backoffMinMs = 1000,
    backoffMaxMs = 30_000,
    pingIntervalMs = 25_000,
    pingTimeoutMs = 10_000,
  } = {}) {
    this.url = url;
    this.getToken = getToken || (() => null);
    this.WebSocketImpl = WebSocketImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.pingIntervalMs = pingIntervalMs;
    this.pingTimeoutMs = pingTimeoutMs;
    this.state = "idle";
    this.stateInfo = {};
    this.user = null;
    this.ws = null;
    this.seq = 0;
    this.attempt = 0;
    this.pending = new Map();     // rid -> { msg, resolve, reject, timer, sent }
    this.queue = [];              // entries waiting for "open"
    this.rooms = new Set();
    this.joinWaiters = [];        // joins requested while not open
    this.listeners = new Map();   // push type -> Set(fn)
    this.stateListeners = new Set();
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.closed = false;
  }

  /** Subscribe to server pushes of one type ("presence", "trade", ..., "welcome", "joined").
      Returns an unsubscribe function. */
  on(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    return () => this.listeners.get(type)?.delete(fn);
  }

  /** Subscribe to connection state changes: fn(state, info). Called once immediately. */
  onState(fn) {
    this.stateListeners.add(fn);
    try { fn(this.state, this.stateInfo); } catch (e) { console.error(e); }
    return () => this.stateListeners.delete(fn);
  }

  connect() {
    if (this.closed || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._setState("connecting");
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (e) {
      console.warn("WebSocket failed to open:", e && e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ type: "hello", token: this.getToken() || "" }));
    };
    ws.onmessage = (ev) => { if (this.ws === ws) this._onMessage(ev.data); };
    ws.onclose = (ev) => { if (this.ws === ws) this._onClose(ev || {}); };
    ws.onerror = () => { /* a close event follows */ };
  }

  /** Drop the current connection (if any) and connect again now, e.g. after a new token. */
  reconnect() {
    if (this.closed) return;
    this.attempt = 0;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      this._failInFlight("Reconnecting");
      try { ws.close(1000, "reconnect"); } catch { /* already closed */ }
    }
    this.connect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, "bye"); } catch { /* ignore */ } }
    for (const [rid, e] of this.pending) { clearTimeout(e.timer); this.pending.delete(rid); e.reject(new Error("Connection closed")); }
    this.queue = [];
    for (const w of this.joinWaiters.splice(0)) w.reject(new Error("Connection closed"));
    this._setState("closed");
  }

  /** Send { type, ...payload, rid } and resolve with the reply's result (reject with its error).
      While not connected the request waits in a queue; it times out after timeoutMs either way. */
  request(type, payload = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error("Connection closed")); return; }
      const rid = ++this.seq;
      const entry = { rid, msg: { ...payload, type, rid }, resolve, reject, sent: false, timer: null };
      entry.timer = setTimeout(() => {
        this.pending.delete(rid);
        const i = this.queue.indexOf(entry);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error(this.state === "open" ? `The server did not answer (${type}).` : "Not connected to the server."));
      }, timeoutMs);
      this.pending.set(rid, entry);
      if (this.state === "open") this._sendEntry(entry); else this.queue.push(entry);
    });
  }

  /** Fire-and-forget message (no rid, no reply). Dropped when not connected. */
  send(type, payload = {}) {
    if (this.state !== "open" || !this.ws || this.ws.readyState !== OPEN) return false;
    this.ws.send(JSON.stringify({ ...payload, type }));
    return true;
  }

  /** Subscribe to a room's presence (and later trade/battle) feed; re-joined after reconnects.
      Resolves with the server's reply ({ users }) once joined. */
  join(roomId) {
    this.rooms.add(roomId);
    if (this.state === "open") {
      return this.request("join", { roomId }).then((r) => { this._emit("joined", { type: "joined", roomId, ...(r || {}) }); return r; });
    }
    return new Promise((resolve, reject) => this.joinWaiters.push({ roomId, resolve, reject }));
  }

  leave(roomId) {
    this.rooms.delete(roomId);
    if (this.state !== "open") return Promise.resolve(null);
    return this.request("leave", { roomId });
  }

  /* ----- internals ----- */

  _setState(state, info = {}) {
    this.state = state;
    this.stateInfo = info;
    for (const fn of this.stateListeners) {
      try { fn(state, info); } catch (e) { console.error(e); }
    }
  }

  _emit(type, msg) {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(msg); } catch (e) { console.error(e); }
    }
  }

  _sendEntry(entry) {
    if (!this.ws || this.ws.readyState !== OPEN) { this.queue.push(entry); return; }
    entry.sent = true;
    this.ws.send(JSON.stringify(entry.msg));
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === "string" ? data : String(data)); } catch { return; }
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "welcome") {
      this.user = msg.user || null;
      this.attempt = 0;
      this._setState("open");
      this._emit("welcome", msg);
      this._rejoin();
      for (const e of this.queue.splice(0)) if (this.pending.has(e.rid)) this._sendEntry(e);
      this._startPing();
      return;
    }
    if (msg.type === "reply") {
      const e = this.pending.get(msg.rid);
      if (!e) return;
      this.pending.delete(msg.rid);
      clearTimeout(e.timer);
      if (msg.ok) e.resolve(msg.result === undefined ? null : msg.result);
      else e.reject(new Error(msg.error || "The server refused the request."));
      return;
    }
    this._emit(msg.type, msg);
  }

  _rejoin() {
    const waiters = this.joinWaiters.splice(0);
    for (const roomId of this.rooms) {
      this.request("join", { roomId }).then((r) => {
        this._emit("joined", { type: "joined", roomId, ...(r || {}) });
        for (const w of waiters) if (w.roomId === roomId) w.resolve(r);
      }, (err) => {
        for (const w of waiters) if (w.roomId === roomId) w.reject(err);
      });
    }
    // Joins for rooms that were left again before we connected.
    for (const w of waiters) if (!this.rooms.has(w.roomId)) w.resolve(null);
  }

  _failInFlight(reason) {
    for (const [rid, e] of this.pending) {
      if (!e.sent) continue;   // never left the browser: keep it queued for the next connection
      clearTimeout(e.timer);
      this.pending.delete(rid);
      e.reject(new Error(`Connection lost before the server answered (${reason}).`));
    }
  }

  _onClose(ev) {
    this.ws = null;
    clearInterval(this.pingTimer);
    this._failInFlight("connection closed");
    if (this.closed) { this._setState("closed"); return; }
    if (ev.code === 4003) {
      this._setState("unauthorized");
      this._emit("unauthorized", { type: "unauthorized" });
      return;
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    this.ws = null;
    const base = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** this.attempt);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this._setState("reconnecting", { retryIn: delay, attempt: this.attempt });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  _startPing() {
    clearInterval(this.pingTimer);
    if (!this.pingIntervalMs) return;
    // An application-level ping notices dead connections (laptop sleep, NAT timeouts) that the
    // browser would otherwise report as open for minutes.
    this.pingTimer = setInterval(() => {
      if (this.state !== "open") return;
      const ws = this.ws;
      this.request("ping", {}, { timeoutMs: this.pingTimeoutMs }).catch(() => {
        if (this.ws === ws && ws) { try { ws.close(4000, "ping timeout"); } catch { /* ignore */ } this._onClose({ code: 4000 }); }
      });
    }, this.pingIntervalMs);
  }
}
