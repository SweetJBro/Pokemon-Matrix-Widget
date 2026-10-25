/* The widget shell against the real server: what index.html loads (order matters for the widget
   handshake), that every URL is relative (BASE_PATH), and web/js/api.js talking to the real
   REST endpoints and WebSocket hub with node's own fetch and WebSocket. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { createApi, Socket, wsUrl } from "../web/js/api.js";

let app, base;

before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1", BASE_PATH: "/pokemon/" }));
  const a = await app.listen();
  base = `http://127.0.0.1:${a.port}/pokemon/`;
});
after(() => app.close());

test("index.html: widget API bundle, then widget-early.js (classic), then app.js (module); relative URLs only", async () => {
  const html = await fetch(base).then((r) => r.text());
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts.map((a) => a.match(/src="([^"]+)"/)[1]), ["vendor/matrix-widget-api/api.min.js", "js/widget-early.js", "js/app.js"]);
  assert.ok(!/type="module"/.test(scripts[0]) && !/type="module"/.test(scripts[1]), "first two are classic scripts");
  assert.ok(!/\b(defer|async)\b/.test(scripts[0] + scripts[1]), "classic scripts run before load");
  assert.match(scripts[2], /type="module"/);
  for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!url.startsWith("/"), `absolute URL ${url} breaks BASE_PATH deployments`);
  }
  for (const id of ["app", "tabs", "main", "toasts", "dialog-root", "presence", "conn", "user-chip"]) assert.match(html, new RegExp(`id="${id}"`));
  for (const tab of ["saves", "home", "trade", "battle"]) assert.match(html, new RegExp(`href="#${tab}"`));
});

test("vendored matrix-widget-api, its licence, the views and the dev harness are served", async () => {
  const r = await fetch(base + "vendor/matrix-widget-api/api.min.js");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /javascript/);
  assert.match(await r.text(), /mxwidgets/);
  assert.equal((await fetch(base + "vendor/matrix-widget-api/LICENSE")).status, 200);
  for (const v of ["saves", "home", "trade", "battle"]) assert.equal((await fetch(base + `js/views/${v}.js`)).status, 200, v);
  const harness = await fetch(base + "dev/fake-matrix.html").then((x) => x.text());
  assert.match(harness, /src="\.\.\/vendor\/matrix-widget-api\/api\.min\.js"/);
});

test("malformed percent-encoding is a 400, not a 500", async () => {
  assert.equal((await fetch(base + "%E0%A4%A")).status, 400);
  assert.equal((await fetch(base + "api/%E0%A4%A")).status, 400);
});

test("api.js + Socket against the real server: dev OpenID token, hello, join, presence, ping", async () => {
  const api = createApi({ base, storage: null });
  const cfg = await api.get("config.json", { auth: false });
  assert.equal(cfg.devAuth, true);
  const r = await api.post("api/auth/openid", { openid: { access_token: "dev:@alice:example.org", matrix_server_name: "example.org", expires_in: 3600 }, displayName: "Alice" }, { auth: false });
  api.setToken(r.token);
  assert.deepEqual((await api.get("api/me")).user, { id: "@alice:example.org", displayName: "Alice" });

  const bob = createApi({ base, storage: null });
  bob.setToken((await bob.post("api/auth/dev", { userId: "@bob:example.org", displayName: "Bob" }, { auth: false })).token);

  const room = "!pokemon:example.org";
  const a = new Socket({ url: wsUrl(base), getToken: () => api.token, pingIntervalMs: 0 });
  const b = new Socket({ url: wsUrl(base), getToken: () => bob.token, pingIntervalMs: 0 });
  const seen = [];
  a.on("presence", (m) => seen.push(m.users.map((u) => u.id).sort().join(",")));
  a.connect();
  b.connect();
  const ja = await a.join(room);
  assert.deepEqual(ja.users.map((u) => u.id), ["@alice:example.org"]);
  await b.join(room);
  assert.equal(a.user.id, "@alice:example.org");
  assert.ok((await a.request("ping")).t > 0);
  await assert.rejects(a.request("no.such.thing"), /unknown message type/);
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(seen.includes("@alice:example.org,@bob:example.org"), seen.join(" | "));
  b.close();
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(seen.at(-1), "@alice:example.org");
  a.close();

  const bad = new Socket({ url: wsUrl(base), getToken: () => "not-a-token", pingIntervalMs: 0 });
  const unauthorized = new Promise((res) => bad.on("unauthorized", res));
  bad.connect();
  await unauthorized;
  assert.equal(bad.state, "unauthorized");
  bad.close();
});
