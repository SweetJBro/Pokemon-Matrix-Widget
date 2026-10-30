/* One WebSocket per open widget, at /ws.

   Client -> server messages are JSON { type, rid?, ...payload }. The first message must be
     { type: "hello", token }  (the bearer token from /api/auth/*)
   and the server answers { type: "welcome", user }. After that:
     { type: "join", roomId }   subscribe to a Matrix room's presence/trade/battle feed
     { type: "leave", roomId }
   plus whatever feature modules register with hub.on(type, handler). A message carrying `rid`
   gets exactly one { type: "reply", rid, ok, result | error } back.

   Server -> client pushes are { type, ... } (presence, trade, battle, ...).

   Limits (config.ws): connections per signed-in user and per client address (signed in or not),
   all connections, a token bucket of messages per connection (a message over the limit gets an
   error reply and is not run; a connection that keeps going over is closed with 4008), the
   message size, and the backlog of unsent pushes (a client that stops reading is dropped rather
   than buffered without bound). Close codes: 4001 no hello, 4003 bad token, 4008 too many
   messages, 4009 too many connections, 1009 message too big. */
import { WebSocketServer } from "ws";

const MAX_BUFFERED = 1 << 20;   // bytes of unsent pushes before a client counts as gone

export function createHub({ server, auth, config }) {
  const L = { perUser: 10, perIp: 40, total: 5000, burst: 40, perSecond: 10, maxPayload: 64 * 1024, ...(config.ws || {}) };
  const wss = new WebSocketServer({ noServer: true, maxPayload: L.maxPayload });
  const conns = new Set();       // signed-in connections
  const pending = new Set();     // connections that have not said hello yet
  const handlers = new Map();
  const leaveHooks = [];
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const clientIp = (req) => (config.trustProxy && req.headers["x-forwarded-for"]?.split(",").pop().trim()) || req.socket.remoteAddress;
  const countIp = (ip) => { let n = 0; for (const c of conns) if (c.ip === ip) n++; for (const c of pending) if (c.ip === ip) n++; return n; };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== config.basePath + "ws") { socket.destroy(); return; }
    const ip = clientIp(req);
    if (conns.size + pending.size >= L.total || countIp(ip) >= L.perIp) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, ip));
  });

  function accept(ws, ip) {
    const conn = { ws, user: null, rooms: new Set(), alive: true, ip, tokens: L.burst, refilled: Date.now(), strikes: 0 };
    pending.add(conn);
    const helloTimer = setTimeout(() => { if (!conn.user) ws.close(4001, "hello expected"); }, 10_000);
    ws.on("pong", () => { conn.alive = true; });
    // Protocol errors (a message over maxPayload, bad frames) arrive as "error" before the close;
    // without a listener Node treats them as unhandled and takes the whole server down.
    ws.on("error", () => {});
    ws.on("message", async (data) => {
      if (!take(conn)) {
        if (++conn.strikes > L.burst) { ws.close(4008, "too many messages"); return; }
        let rid; try { rid = JSON.parse(data.toString("utf8")).rid; } catch { /* ignore */ }
        if (validRid(rid)) send(conn, { type: "reply", rid, ok: false, error: "Too many messages; slow down" });
        return;
      }
      let msg;
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string" || msg.type.length > 64) return;
      if (msg.rid !== undefined && !validRid(msg.rid)) return;
      if (!conn.user) {
        if (msg.type !== "hello") return;
        const user = auth.userForToken(String(msg.token || ""));
        if (!user) { ws.close(4003, "bad token"); return; }
        let mine = 0;
        for (const c of conns) if (c.user.id === user.id) mine++;
        if (mine >= L.perUser) { ws.close(4009, "too many connections"); return; }
        clearTimeout(helloTimer);
        conn.user = user;
        pending.delete(conn);
        conns.add(conn);
        send(conn, { type: "welcome", user });
        return;
      }
      try {
        let result;
        if (msg.type === "join") result = join(conn, String(msg.roomId || ""));
        else if (msg.type === "leave") result = leave(conn, String(msg.roomId || ""));
        else if (msg.type === "ping") result = { t: Date.now() };
        else {
          const h = handlers.get(msg.type);
          if (!h) throw fail(400, "unknown message type " + msg.type);
          result = await h(msg, conn);
        }
        if (msg.rid !== undefined) send(conn, { type: "reply", rid: msg.rid, ok: true, result: result ?? null });
      } catch (e) {
        if (!e.status || e.status >= 500) console.error("ws", msg.type, e);
        if (msg.rid !== undefined) send(conn, { type: "reply", rid: msg.rid, ok: false, error: e.message || String(e) });
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      pending.delete(conn);
      if (!conns.delete(conn)) return;
      for (const roomId of conn.rooms) broadcastPresence(roomId);
      if (!isOnline(conn.user.id)) for (const fn of leaveHooks) { try { fn(conn.user.id); } catch (e) { console.error(e); } }
    });
  }

  /** Token bucket: L.perSecond messages a second, bursts of up to L.burst. */
  function take(conn) {
    const now = Date.now();
    conn.tokens = Math.min(L.burst, conn.tokens + ((now - conn.refilled) / 1000) * L.perSecond);
    conn.refilled = now;
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    if (conn.strikes) conn.strikes--;
    return true;
  }
  const validRid = (rid) => (typeof rid === "string" && rid.length <= 64) || (Number.isSafeInteger(rid));

  function join(conn, roomId) {
    if (!/^!.{1,250}$/.test(roomId) && roomId !== "standalone") throw fail(400, "bad room id");
    if (conn.rooms.size >= 20) throw fail(400, "too many rooms");
    conn.rooms.add(roomId);
    broadcastPresence(roomId);
    return { users: presence(roomId) };
  }
  function leave(conn, roomId) { conn.rooms.delete(roomId); broadcastPresence(roomId); return null; }

  function send(conn, msg) {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    if (conn.ws.bufferedAmount > MAX_BUFFERED) { conn.ws.terminate(); return; }   // not reading: drop it
    conn.ws.send(JSON.stringify(msg));
  }

  function presence(roomId) {
    const seen = new Map();
    for (const c of conns) if (c.rooms.has(roomId)) seen.set(c.user.id, c.user);
    return [...seen.values()];
  }
  function broadcastPresence(roomId) { broadcastRoom(roomId, { type: "presence", roomId, users: presence(roomId) }); }

  function broadcastRoom(roomId, msg) { for (const c of conns) if (c.rooms.has(roomId)) send(c, msg); }
  function sendUser(userId, msg) { for (const c of conns) if (c.user.id === userId) send(c, msg); }
  function isOnline(userId) { for (const c of conns) if (c.user.id === userId) return true; return false; }
  function roomsOf(userId) { const s = new Set(); for (const c of conns) if (c.user.id === userId) c.rooms.forEach((r) => s.add(r)); return s; }

  const ping = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closed */ }
    }
  }, 30_000);
  ping.unref();

  return {
    /** Register a handler for a client message type: async (msg, conn) => result. conn.user is set. */
    on(type, fn) { handlers.set(type, fn); },
    /** Called with a user id when that user's last connection closes. */
    onUserOffline(fn) { leaveHooks.push(fn); },
    sendUser, broadcastRoom, presence, isOnline, roomsOf,
    close() { clearInterval(ping); for (const c of [...conns, ...pending]) c.ws.terminate(); wss.close(); },
  };
}
