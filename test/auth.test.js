import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { isBlockedAddress } from "../server/auth.js";

let fed, app, base;

before(async () => {
  // A fake homeserver federation listener: "good" -> @ash:example.org, "foreign" -> a user on another server.
  fed = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname !== "/fed/_matrix/federation/v1/openid/userinfo") { res.writeHead(404); return res.end(); }
    const t = u.searchParams.get("access_token");
    const sub = { good: "@ash:example.org", foreign: "@ash:evil.org" }[t];
    res.writeHead(sub ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify(sub ? { sub } : { errcode: "M_UNKNOWN_TOKEN" }));
  });
  await new Promise((r) => fed.listen(0, "127.0.0.1", r));
  const config = loadConfig({
    DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1",
    MATRIX_FEDERATION_OVERRIDES: `example.org=http://127.0.0.1:${fed.address().port}/fed`,
  });
  app = createServer(config);
  const a = await app.listen();
  base = `http://127.0.0.1:${a.port}`;
});

after(async () => { await app.close(); fed.close(); });

const post = (path, body, token) => fetch(base + path, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) },
}).then(async (r) => ({ status: r.status, json: r.status === 204 ? null : await r.json() }));

test("OpenID login issues a session for the verified user", async () => {
  const r = await post("/api/auth/openid", { openid: { access_token: "good", matrix_server_name: "example.org", expires_in: 3600 }, displayName: "Ash" });
  assert.equal(r.status, 200);
  assert.equal(r.json.user.id, "@ash:example.org");
  const me = await fetch(base + "/api/me", { headers: { authorization: "Bearer " + r.json.token } }).then((x) => x.json());
  assert.equal(me.user.id, "@ash:example.org");
});

test("sub on another server is rejected", async () => {
  const r = await post("/api/auth/openid", { openid: { access_token: "foreign", matrix_server_name: "example.org" } });
  assert.equal(r.status, 401);
});

test("unknown token is rejected", async () => {
  const r = await post("/api/auth/openid", { openid: { access_token: "nope", matrix_server_name: "example.org" } });
  assert.equal(r.status, 401);
});

test("dev tokens are refused without DEV_AUTH", async () => {
  const r = await post("/api/auth/openid", { openid: { access_token: "dev:@ash:example.org", matrix_server_name: "example.org" } });
  assert.equal(r.status, 401);
  assert.equal((await post("/api/auth/dev", { userId: "@ash:example.org" })).status, 404);
});

test("private homeservers are refused", async () => {
  for (const name of ["127.0.0.1", "[::1]", "10.1.2.3:8448"]) {
    const r = await post("/api/auth/openid", { openid: { access_token: "x", matrix_server_name: name } });
    assert.equal(r.status, 403, name);
  }
  assert.equal(isBlockedAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedAddress("169.254.169.254"), true);
  assert.equal(isBlockedAddress("1.1.1.1"), false);
});

test("malformed input is a 400", async () => {
  assert.equal((await post("/api/auth/openid", {})).status, 400);
  assert.equal((await post("/api/auth/openid", { openid: { access_token: "a b", matrix_server_name: "example.org" } })).status, 400);
  assert.equal((await post("/api/auth/openid", { openid: { access_token: "x", matrix_server_name: "exa mple.org" } })).status, 400);
});

test("handoff codes work once", async () => {
  const login = await post("/api/auth/openid", { openid: { access_token: "good", matrix_server_name: "example.org" } });
  const h = await post("/api/auth/handoff", {}, login.json.token);
  assert.equal(h.status, 200);
  const r1 = await post("/api/auth/handoff/redeem", { code: h.json.code });
  assert.equal(r1.status, 200);
  assert.equal(r1.json.user.id, "@ash:example.org");
  const r2 = await post("/api/auth/handoff/redeem", { code: h.json.code });
  assert.equal(r2.status, 401);
});

test("API needs a session", async () => {
  assert.equal((await fetch(base + "/api/me")).status, 401);
  assert.equal((await fetch(base + "/api/me", { headers: { authorization: "Bearer junk" } })).status, 401);
});
