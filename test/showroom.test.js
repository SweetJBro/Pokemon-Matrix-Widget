/* server/showroom.js: opt-in, chosen boxes only, nothing private in the public listing, and a new
   link revokes the old one. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { openSave } from "../shared/saves/index.js";
import { toBase64 } from "../shared/bytes.js";

let app, base;
before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1" }));
  base = `http://127.0.0.1:${(await app.listen()).port}`;
});
after(() => app.close());

test("a showroom shows only what its owner chose, without private data", async () => {
  const { token } = await fetch(base + "/api/auth/dev", { method: "POST", body: JSON.stringify({ userId: "@ash:example.org", displayName: "Ash" }) }).then((r) => r.json());
  const call = (method, p, body) => fetch(base + p, { method, body: body && JSON.stringify(body), headers: { authorization: "Bearer " + token } })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const save = await openSave(new Uint8Array(fs.readFileSync(new URL("./fixtures/saves/emerald-en.sav", import.meta.url))), "e.sav");
  const mons = save.box(1).filter(Boolean).slice(0, 6).map((e) => ({ record: toBase64(e.record), meta: e.meta }));
  await call("POST", "/api/home/deposit", { mons: mons.slice(0, 3), box: 0 });
  await call("POST", "/api/home/deposit", { mons: mons.slice(3), box: 2 });

  const s0 = (await call("GET", "/api/showroom")).json;
  assert.equal(s0.enabled, false, "off until the owner turns it on");
  const view = (t) => fetch(`${base}/api/showroom/view/${t}`).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal((await view(s0.token)).status, 404);

  await call("POST", "/api/showroom", { enabled: true, boxes: [2] });
  const v = await view(s0.token);
  assert.equal(v.status, 200);
  assert.equal(v.json.owner, "Ash");
  assert.deepEqual(v.json.boxes.map((b) => b.index), [2], "only the chosen box");
  assert.equal(v.json.counts.pokemon, 3);
  const text = JSON.stringify(v.json);
  assert.ok(!/"tid"|"record"|"locked"|"flags"|@ash/.test(text), "no trainer ids, records, locks or Matrix ids");

  assert.equal((await call("POST", "/api/showroom", { enabled: true, boxes: [] })).status, 400);
  await call("POST", "/api/showroom", { enabled: true, boxes: null });
  assert.equal((await view(s0.token)).json.boxes.length, 2, "every box");

  const rotated = (await call("POST", "/api/showroom/rotate")).json;
  assert.notEqual(rotated.token, s0.token);
  assert.equal((await view(s0.token)).status, 404, "the old link stops working");
  assert.equal((await view(rotated.token)).status, 200);
  assert.equal((await view("short")).status, 404);
  assert.equal((await fetch(base + "/showroom.html")).headers.get("content-security-policy").includes("script-src 'self'"), true);
});
