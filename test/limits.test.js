/* Abuse limits: WebSocket message rate, connections per user and per address, message size,
   the API's per-address rate, and the page's Content-Security-Policy. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";

const servers = [];
after(() => Promise.all(servers.map((s) => s.close())));

async function start(env = {}) {
  const s = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1", ...env }));
  servers.push(s);
  const port = (await s.listen()).port;
  const base = `http://127.0.0.1:${port}`;
  const login = async (userId) => (await fetch(base + "/api/auth/dev", { method: "POST", body: JSON.stringify({ userId }) }).then((r) => r.json())).token;
  return { base, ws: `ws://127.0.0.1:${port}/ws`, login };
}

/** Open a socket, say hello; resolves { ws, messages, closed } once welcomed (or closed). */
function connect(url, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const messages = [];
    const closed = new Promise((r) => ws.on("close", (code) => r(code)));
    ws.on("message", (d) => { const m = JSON.parse(d); messages.push(m); if (m.type === "welcome") resolve({ ws, messages, closed }); });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token })));
    ws.on("error", () => {});
    closed.then((code) => resolve({ ws, messages, closed, code }));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("message rate: bursts beyond the limit are refused, a flood closes the connection", async () => {
  const s = await start({ WS_MESSAGES_PER_SECOND: "5", WS_BURST: "10" });
  const c = await connect(s.ws, await s.login("@ash:example.org"));
  for (let i = 0; i < 15; i++) c.ws.send(JSON.stringify({ type: "ping", rid: i }));
  await sleep(200);
  const replies = c.messages.filter((m) => m.type === "reply");
  assert.ok(replies.filter((r) => r.ok).length <= 11, "about one burst gets through");
  assert.ok(replies.some((r) => !r.ok && /slow down/.test(r.error)), "the rest are told to slow down");
  for (let i = 0; i < 100; i++) c.ws.send(JSON.stringify({ type: "ping" }));
  assert.equal(await c.closed, 4008);
});

test("connections per user are capped; unknown rid shapes and oversized messages are rejected", async () => {
  const s = await start({ WS_PER_USER: "2" });
  const token = await s.login("@misty:example.org");
  const a = await connect(s.ws, token), b = await connect(s.ws, token);
  const c = await connect(s.ws, token);
  assert.equal(c.code, 4009);
  a.ws.send(JSON.stringify({ type: "ping", rid: { evil: true } }));
  a.ws.send(JSON.stringify({ type: "ping", rid: "ok" }));
  await sleep(100);
  assert.deepEqual(a.messages.filter((m) => m.type === "reply").map((m) => m.rid), ["ok"], "object rids are ignored");
  a.ws.send("x".repeat(70 * 1024));
  assert.equal(await a.closed, 1009, "message too big");
  b.ws.close();
});

test("connections per address are capped before the upgrade", async () => {
  const s = await start({ WS_PER_IP: "3" });
  const open = [];
  for (let i = 0; i < 3; i++) open.push(new WebSocket(s.ws));
  await Promise.all(open.map((w) => new Promise((r) => w.on("open", r))));
  const refused = await new Promise((r) => { const w = new WebSocket(s.ws); w.on("error", (e) => r(e.message)); w.on("open", () => r("opened")); });
  assert.match(refused, /503/);
  open.forEach((w) => w.close());
});

test("API requests per address are limited", async () => {
  const s = await start({ API_REQUESTS_PER_MINUTE: "5" });
  const statuses = [];
  for (let i = 0; i < 7; i++) statuses.push((await fetch(s.base + "/api/auth/methods")).status);
  assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.equal(statuses[6], 429);
});

test("the app page gets a strict Content-Security-Policy; the dev harness keeps its inline scripts", async () => {
  const s = await start();
  const page = (await fetch(s.base + "/")).headers.get("content-security-policy");
  for (const d of ["script-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors * vector:"]) assert.ok(page.includes(d), d);
  assert.ok(page.includes("https://raw.githubusercontent.com"), "sprites may come from the configured host");
  assert.equal((await fetch(s.base + "/dev/fake-matrix.html")).headers.get("content-security-policy"), "frame-ancestors * vector:");
  assert.equal((await fetch(s.base + "/js/app.js")).headers.get("x-content-type-options"), "nosniff");
});
