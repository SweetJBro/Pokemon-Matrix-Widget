/* One WebSocket per open widget, at /ws.

   Client -> server messages are JSON { type, rid?, ...payload }. The first message must be
     { type: "hello", token }  (the bearer token from /api/auth/*)
   and the server answers { type: "welcome", user }. After that:
     { type: "join", roomId }   subscribe to a Matrix room's presence/trade/battle feed
     { type: "leave", roomId }
   plus whatever feature modules register with hub.on(type, handler). A message carrying `rid`
   gets exactly one { type: "reply", rid, ok, result | error } back.

   Server -> client pushes are { type, ... } (presence, trade, battle, ...). */
import { WebSocketServer } from "ws";

export function createHub({ server, auth, config }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
  const conns = new Set();
  const handlers = new Map();
  const leaveHooks = [];

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== config.basePath + "ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => accept(ws, req));
  });

  function accept(ws, req) {
    const conn = { ws, user: null, rooms: new Set(), alive: true, ip: req.socket.remoteAddress };
    const helloTimer = setTimeout(() => { if (!conn.user) ws.close(4001, "hello expected"); }, 10_000);
    ws.on("pong", () => { conn.alive = true; });
    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString("utf8")); } catch { return; }
      if (!msg || typeof msg.type !== "string") return;
      if (!conn.user) {
        if (msg.type !== "hello") return;
        const user = auth.userForToken(String(msg.token || ""));
        if (!user) { ws.close(4003, "bad token"); return; }
        clearTimeout(helloTimer);
        conn.user = user;
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
          if (!h) throw Object.assign(new Error("unknown message type " + msg.type), { status: 400 });
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
      if (!conns.delete(conn)) return;
      for (const roomId of conn.rooms) broadcastPresence(roomId);
      if (!isOnline(conn.user.id)) for (const fn of leaveHooks) { try { fn(conn.user.id); } catch (e) { console.error(e); } }
    });
  }

  function join(conn, roomId) {
    if (!/^!.{1,250}$/.test(roomId) && roomId !== "standalone") throw Object.assign(new Error("bad room id"), { status: 400 });
    if (conn.rooms.size >= 20) throw Object.assign(new Error("too many rooms"), { status: 400 });
    conn.rooms.add(roomId);
    broadcastPresence(roomId);
    return { users: presence(roomId) };
  }
  function leave(conn, roomId) { conn.rooms.delete(roomId); broadcastPresence(roomId); return null; }

  function send(conn, msg) {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
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
    close() { clearInterval(ping); for (const c of conns) c.ws.terminate(); wss.close(); },
  };
}
