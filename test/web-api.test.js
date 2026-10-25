/* web/js/api.js under node: REST client with a fake fetch, Socket with a fake WebSocket. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError, wsUrl, Socket } from "../web/js/api.js";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ...init });
    const r = await handler(url, init);
    if (r instanceof Error) throw r;
    const { status = 200, body } = r;
    return { status, ok: status >= 200 && status < 300, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) };
  };
  fn.calls = calls;
  return fn;
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

test("REST paths resolve relative to the page, so BASE_PATH deployments work", async () => {
  const fetchImpl = fakeFetch(() => ({ body: { ok: 1 } }));
  const api = createApi({ base: "https://example.org/pokemon/", fetchImpl, storage: null });
  await api.get("api/me");
  await api.get("/config.json");
  assert.equal(fetchImpl.calls[0].url, "https://example.org/pokemon/api/me");
  assert.equal(fetchImpl.calls[1].url, "https://example.org/pokemon/config.json");
  assert.equal(fetchImpl.calls[0].credentials, "omit");
});

test("bearer token is sent, mirrored to storage, and left out with auth:false", async () => {
  const storage = memoryStorage();
  const fetchImpl = fakeFetch(() => ({ body: {} }));
  const api = createApi({ base: "http://x/", fetchImpl, storage, storageKey: "k" });
  api.setToken("tok123");
  assert.equal(storage.getItem("k"), "tok123");
  await api.post("api/thing", { a: 1 });
  await api.post("api/auth/openid", {}, { auth: false });
  assert.equal(fetchImpl.calls[0].headers.authorization, "Bearer tok123");
  assert.equal(fetchImpl.calls[0].headers["content-type"], "application/json");
  assert.equal(fetchImpl.calls[0].body, '{"a":1}');
  assert.equal(fetchImpl.calls[1].headers.authorization, undefined);
  // a new client in the same tab picks the token up again
  assert.equal(createApi({ base: "http://x/", fetchImpl, storage, storageKey: "k" }).token, "tok123");
  api.clearToken();
  assert.equal(storage.getItem("k"), null);
});

test("storage that throws does not break the client", async () => {
  const bad = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceeded"); }, removeItem() { throw new Error("x"); } };
  const api = createApi({ base: "http://x/", fetchImpl: fakeFetch(() => ({ body: {} })), storage: bad });
  assert.equal(api.token, null);
  api.setToken("t");
  assert.equal(api.token, "t");
});

test("JSON errors become ApiError with the server's message; 204 -> null", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/gone")) return { status: 204 };
    if (url.endsWith("/html")) return { status: 502, body: "<html>bad gateway</html>" };
    return { status: 403, body: { error: "This server is only open to members of its community room" } };
  });
  const api = createApi({ base: "http://x/", fetchImpl, storage: null });
  assert.equal(await api.del("api/gone"), null);
  await assert.rejects(api.get("api/nope"), (e) => e instanceof ApiError && e.status === 403 && /community room/.test(e.message));
  await assert.rejects(api.get("api/html"), (e) => e instanceof ApiError && e.status === 502 && /502/.test(e.message));
});

test("network failures become a readable ApiError with status 0", async () => {
  const api = createApi({ base: "http://x/", fetchImpl: fakeFetch(() => new TypeError("Failed to fetch")), storage: null });
  await assert.rejects(api.get("api/me"), (e) => e instanceof ApiError && e.status === 0 && /reach the server/.test(e.message));
});

test("401 on an authenticated request fires onUnauthorized (not for auth:false calls)", async () => {
  const api = createApi({ base: "http://x/", fetchImpl: fakeFetch(() => ({ status: 401, body: { error: "Not signed in" } })), storage: null });
  let n = 0;
  api.onUnauthorized(() => n++);
  api.setToken("old");
  await assert.rejects(api.get("api/me"));
  await assert.rejects(api.post("api/auth/openid", {}, { auth: false }));
  assert.equal(n, 1);
});

test("wsUrl keeps the base path and picks ws/wss", () => {
  assert.equal(wsUrl("http://127.0.0.1:8090/"), "ws://127.0.0.1:8090/ws");
  assert.equal(wsUrl("https://example.org/pokemon/?widgetId=x#home"), "wss://example.org/pokemon/ws");
});

/* ---------- Socket ---------- */

class FakeWS {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.all.push(this);
  }
  send(s) { if (this.readyState !== 1) throw new Error("not open"); this.sent.push(JSON.parse(s)); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code }), 0); }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  push(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  serverClose(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  welcome(user = { id: "@ash:example.org" }) { this.push({ type: "welcome", user }); }
  /** Answer every unanswered request in sent[] with fn(msg) -> result. */
  answer(fn = () => null) {
    for (const m of this.sent) if (m.rid !== undefined && !m.answered) { m.answered = true; this.push({ type: "reply", rid: m.rid, ok: true, result: fn(m) }); }
  }
}

function socket(opts = {}) {
  FakeWS.all = [];
  return new Socket({ url: "ws://x/ws", getToken: () => "tok", WebSocketImpl: FakeWS, backoffMinMs: 5, backoffMaxMs: 40, pingIntervalMs: 0, ...opts });
}

test("hello carries the token; requests wait for welcome and resolve by rid", async () => {
  const s = socket();
  const states = [];
  s.onState((st) => states.push(st));
  s.connect();
  const ws = FakeWS.all[0];
  const p = s.request("home.list", { box: 2 });
  ws.open();
  assert.deepEqual(ws.sent, [{ type: "hello", token: "tok" }]);
  ws.welcome();
  assert.equal(s.state, "open");
  assert.equal(s.user.id, "@ash:example.org");
  const req = ws.sent[1];
  assert.equal(req.type, "home.list");
  assert.equal(req.box, 2);
  assert.equal(typeof req.rid, "number");
  ws.push({ type: "reply", rid: req.rid, ok: true, result: { mons: [] } });
  assert.deepEqual(await p, { mons: [] });
  assert.deepEqual(states, ["idle", "connecting", "open"]);
  s.close();
});

test("payload cannot override type or rid; error replies reject with the server text", async () => {
  const s = socket();
  s.connect();
  const ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  const p = s.request("trade.offer", { type: "evil", rid: 999 });
  const m = ws.sent.at(-1);
  assert.equal(m.type, "trade.offer");
  assert.notEqual(m.rid, 999);
  ws.push({ type: "reply", rid: m.rid, ok: false, error: "That Pokémon is locked in another trade" });
  await assert.rejects(p, /locked in another trade/);
  s.close();
});

test("pushes go to on(type) listeners; unsubscribe works", () => {
  const s = socket();
  s.connect();
  const ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  const got = [];
  const off = s.on("presence", (m) => got.push(m.users.length));
  ws.push({ type: "presence", roomId: "!r:x", users: [{ id: "@a:x" }, { id: "@b:x" }] });
  off();
  ws.push({ type: "presence", roomId: "!r:x", users: [] });
  assert.deepEqual(got, [2]);
  s.close();
});

test("join before connecting resolves after welcome; rooms are re-joined after a reconnect", async () => {
  const s = socket();
  const joined = [];
  s.on("joined", (m) => joined.push(m.roomId));
  s.connect();
  const j = s.join("!room:example.org");
  let ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  assert.equal(ws.sent[1].type, "join");
  assert.equal(ws.sent[1].roomId, "!room:example.org");
  ws.answer(() => ({ users: [{ id: "@ash:example.org" }] }));
  assert.deepEqual(await j, { users: [{ id: "@ash:example.org" }] });

  ws.serverClose(1006);
  assert.equal(s.state, "reconnecting");
  assert.ok(s.stateInfo.retryIn > 0);
  await tick(30);
  ws = FakeWS.all[1];
  assert.ok(ws, "reconnected");
  ws.open(); ws.welcome();
  assert.deepEqual(ws.sent.map((m) => m.type), ["hello", "join"]);
  ws.answer(() => ({ users: [] }));
  await tick();
  assert.deepEqual(joined, ["!room:example.org", "!room:example.org"]);
  s.close();
});

test("requests in flight when the connection drops are rejected; queued ones survive", async () => {
  const s = socket({ requestTimeoutMs: 1000 });
  s.connect();
  let ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  const inflight = s.request("battle.move", { move: 1 });
  ws.serverClose(1006);
  await assert.rejects(inflight, /Connection lost/);
  const queued = s.request("home.list");   // sent after the next welcome
  await tick(30);
  ws = FakeWS.all[1];
  ws.open(); ws.welcome();
  const m = ws.sent.find((x) => x.type === "home.list");
  ws.push({ type: "reply", rid: m.rid, ok: true, result: 7 });
  assert.equal(await queued, 7);
  s.close();
});

test("backoff grows and is capped", async () => {
  const s = socket({ backoffMinMs: 10, backoffMaxMs: 25 });
  const delays = [];
  s.onState((st, info) => { if (st === "reconnecting") delays.push(info.retryIn); });
  s.connect();
  for (let i = 0; i < 4; i++) {
    FakeWS.all.at(-1).serverClose(1006);
    await tick(45);
  }
  s.close();
  assert.equal(delays.length, 4);
  assert.ok(delays[0] <= 13 && delays[0] >= 7, `first ${delays[0]}`);
  assert.ok(delays[1] >= 15, `second ${delays[1]}`);
  assert.ok(delays.every((d) => d <= 32), delays.join(","));
});

test("close code 4003 (bad token) stops reconnecting until reconnect() after re-auth", async () => {
  const s = socket();
  let unauthorized = 0;
  s.on("unauthorized", () => unauthorized++);
  s.connect();
  FakeWS.all[0].open();
  FakeWS.all[0].serverClose(4003);
  assert.equal(s.state, "unauthorized");
  await tick(30);
  assert.equal(FakeWS.all.length, 1);
  assert.equal(unauthorized, 1);
  s.reconnect();
  assert.equal(FakeWS.all.length, 2);
  assert.equal(s.state, "connecting");
  s.close();
});

test("requests time out, and close() rejects whatever is pending", async () => {
  const s = socket({ requestTimeoutMs: 20 });
  s.connect();
  const ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  await assert.rejects(s.request("slow"), /did not answer/);
  const p = s.request("never", {}, { timeoutMs: 5000 });
  const j = (() => { s.state = "connecting"; return s.join("!other:x"); })();
  s.close();
  await assert.rejects(p, /closed/);
  await assert.rejects(j, /closed/);
  assert.equal(s.state, "closed");
  await assert.rejects(s.request("after"), /closed/);
});

test("send() is fire-and-forget and refuses while disconnected", () => {
  const s = socket();
  assert.equal(s.send("typing", {}), false);
  s.connect();
  const ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  assert.equal(s.send("typing", { on: true }), true);
  assert.deepEqual(ws.sent.at(-1), { on: true, type: "typing" });
  s.close();
});

test("application ping keeps a live connection and drops a dead one", async () => {
  const s = socket({ pingIntervalMs: 10, pingTimeoutMs: 15 });
  s.connect();
  const ws = FakeWS.all[0];
  ws.open(); ws.welcome();
  await tick(14);
  const ping = ws.sent.find((m) => m.type === "ping");
  assert.ok(ping, "ping sent");
  ws.push({ type: "reply", rid: ping.rid, ok: true, result: { t: 1 } });
  assert.equal(s.state, "open");
  await tick(40);   // later pings go unanswered
  assert.equal(s.state === "reconnecting" || s.state === "connecting", true, s.state);
  s.close();
});
