/* server/home.js end to end over HTTP: real records taken out of the fixture saves with
   shared/saves, deposited, moved, withdrawn in two phases and put back into a save. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { openSave } from "../shared/saves/index.js";
import { toBase64, fromBase64, hex } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "saves");
const loadSave = (n) => openSave(new Uint8Array(fs.readFileSync(path.join(dir, n))), n);

let app, base;
before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1", HOME_BOXES: "4" }));
  base = `http://127.0.0.1:${(await app.listen()).port}`;
});
after(() => app.close());

async function login(userId) {
  const r = await fetch(base + "/api/auth/dev", { method: "POST", body: JSON.stringify({ userId }) }).then((x) => x.json());
  const call = (method, p, body) => fetch(base + p, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { authorization: "Bearer " + r.token, "content-type": "application/json" },
  }).then(async (x) => ({ status: x.status, json: x.status === 204 ? null : await x.json() }));
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), put: (p, b) => call("PUT", p, b) };
}

/** Every boxed Pokémon of a save as deposit entries (taken out of the save object). */
function takeAll(save, n) {
  const out = [];
  for (let b = 0; b < save.boxCount && out.length < n; b++) {
    for (let i = save.boxCapacity - 1; i >= 0 && out.length < n; i--) {
      if (!save.box(b)[i]) continue;
      const { record, meta } = save.takeFromBox(b, i);
      out.push({ record: toBase64(record), meta });
    }
  }
  return out;
}

test("deposit, list, move, rename, history", async () => {
  const ash = await login("@ash:example.org");
  const save = await loadSave("emerald-en.sav");
  const mons = takeAll(save, 3);
  const d = await ash.post("/api/home/deposit", { mons });
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.equal(d.json.stored.length, 3);
  const home = (await ash.get("/api/home")).json;
  assert.equal(home.boxCount, 4);
  assert.equal(home.boxes[0].mons.length, 3);
  assert.ok(home.boxes[0].mons.every((m) => m.format === "pk3" && m.summary.speciesName));

  const [a, b] = d.json.stored;
  assert.equal((await ash.post("/api/home/move", { id: a.id, box: b.box, slot: b.slot })).status, 204, "swap");
  const after = (await ash.get("/api/home")).json.boxes[0].mons;
  assert.equal(after.find((m) => m.id === a.id).slot, b.slot);
  assert.equal(after.find((m) => m.id === b.id).slot, a.slot);
  assert.equal((await ash.post("/api/home/move", { id: a.id, box: 3, slot: 29 })).status, 204, "to an empty slot");
  assert.equal((await ash.post("/api/home/move", { id: a.id, box: 4, slot: 0 })).status, 400, "box out of range");

  assert.equal((await ash.put("/api/home/box/1", { name: "Shinies" })).status, 204);
  assert.equal((await ash.get("/api/home")).json.boxes[1].name, "Shinies");
  assert.equal((await ash.put("/api/home/box/1", { name: "" })).status, 400);

  const detail = await ash.get(`/api/home/mon/${a.id}`);
  assert.equal(detail.json.record, mons.find((m) => m.record === detail.json.record)?.record, "stored bytes are the deposited bytes");
  assert.ok((await ash.get("/api/home/history")).json.entries.some((e) => e.action === "deposit"));
});

test("deposits are checked and all-or-nothing", async () => {
  const misty = await login("@misty:example.org");
  const save = await loadSave("platinum-en.sav");
  const [good] = takeAll(save, 1);
  const broken = { record: toBase64(fromBase64(good.record).map((x, i) => (i === 0x10 ? x ^ 0xff : x))), meta: good.meta };
  const r = await misty.post("/api/home/deposit", { mons: [good, broken] });
  assert.equal(r.status, 422, "a damaged record is refused");
  assert.equal((await misty.get("/api/home")).json.boxes[0].mons.length, 0, "and nothing was stored");
  assert.equal((await misty.post("/api/home/deposit", { mons: [{ ...good, meta: { ...good.meta, format: "pk5" } }] })).status, 422, "wrong format");
  assert.equal((await misty.post("/api/home/deposit", { mons: [{ record: "!!", meta: good.meta }] })).status, 400, "not base64");
  assert.equal((await misty.post("/api/home/deposit", { mons: [good, good] })).status, 409, "same Pokémon twice");
  assert.equal((await misty.post("/api/home/deposit", { mons: [good] })).status, 200);
  const again = await misty.post("/api/home/deposit", { mons: [good] });
  assert.equal(again.status, 409, "already in Home");
  const brock = await login("@brock:example.org");
  assert.equal((await brock.post("/api/home/deposit", { mons: [good] })).status, 409, "already in someone else's Home");
});

test("two-phase withdrawal into a save of the same generation", async () => {
  const gary = await login("@gary:example.org");
  const from = await loadSave("gold-en.sav");
  const [entry] = takeAll(from, 1);
  const { json: dep } = await gary.post("/api/home/deposit", { mons: [entry] });
  const id = dep.stored[0].id;

  const target = await loadSave("crystal-en.sav");
  const want = { format: "pk2", game: target.game, lang: target.lang };
  const wrong = await gary.post("/api/home/withdraw/preview", { id, target: { format: "pk3", game: "E", lang: "en" } });
  assert.equal(wrong.json.ok, false);
  assert.equal(wrong.json.code, "conversion");
  assert.equal((await gary.post("/api/home/withdraw", { id, target: { format: "pk3" } })).status, 409);

  const w = await gary.post("/api/home/withdraw", { id, target: want });
  assert.equal(w.status, 200);
  assert.equal((await gary.post("/api/home/move", { id, box: 1, slot: 0 })).status, 409, "locked while withdrawing");
  assert.equal((await gary.post("/api/home/withdraw", { id, target: want })).status, 409, "only one withdrawal at a time");
  let home = (await gary.get("/api/home")).json;
  assert.equal(home.pendingWithdrawals.length, 1);

  // Cancel puts it back; withdraw again and finish.
  assert.equal((await gary.post(`/api/home/withdraw/${id}/cancel`)).status, 204);
  assert.equal((await gary.get("/api/home")).json.boxes[0].mons[0].locked, null);
  const w2 = (await gary.post("/api/home/withdraw", { id, target: want })).json;
  const put = target.putInBox(fromBase64(w2.record), w2.meta);
  assert.equal(hex(target.box(put.box)[put.index].record), hex(fromBase64(entry.record)));
  assert.equal((await gary.post(`/api/home/withdraw/${id}/commit`)).status, 204);
  home = (await gary.get("/api/home")).json;
  assert.equal(home.boxes[0].mons.length, 0);
  assert.equal(home.pendingWithdrawals.length, 0);
  assert.equal((await gary.post(`/api/home/withdraw/${id}/commit`)).status, 404, "commit is not repeatable");

  // The same Pokémon deposited again by someone else carries a "seen before" mark.
  const rival = await login("@rival:example.org");
  const r = await rival.post("/api/home/deposit", { mons: [entry] });
  assert.equal(r.status, 200);
  assert.match(r.json.warnings.join(" "), /left another player's Home/);
  assert.deepEqual((await rival.get("/api/home")).json.boxes[0].mons[0].flags, ["deposit", "seen-before"]);
});

test("a full Home refuses more", async () => {
  const red = await login("@red:example.org");
  const save = await loadSave("red-en.sav");
  const all = takeAll(save, 200);
  assert.ok(all.length >= 25);
  for (let i = 0; i < all.length; i += 30) {
    const r = await red.post("/api/home/deposit", { mons: all.slice(i, i + 30) });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const total = (await red.get("/api/home")).json.boxes.reduce((n, b) => n + b.mons.length, 0);
  assert.equal(total, all.length);
  assert.equal((await red.post("/api/home/deposit", { mons: [] })).status, 400);
});

test("unofficial Gen 1/2 -> Gen 3 needs the server flag and consent, and the result is badged for good", async () => {
  const srv = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1", UNOFFICIAL_TRANSFERS: "1" }));
  const b = `http://127.0.0.1:${(await srv.listen()).port}`;
  try {
    const { token } = await fetch(b + "/api/auth/dev", { method: "POST", body: JSON.stringify({ userId: "@oak:example.org" }) }).then((x) => x.json());
    const call = (p, body) => fetch(b + p, { method: body === undefined ? "GET" : "POST", body: body && JSON.stringify(body), headers: { authorization: "Bearer " + token } }).then(async (x) => ({ status: x.status, json: x.status === 204 ? null : await x.json() }));
    const red = await loadSave("red-en.sav");
    const [entry] = takeAll(red, 1);
    const id = (await call("/api/home/deposit", { mons: [entry] })).json.stored[0].id;
    const target = { format: "pk3", game: "E", lang: "en" };
    const pre = await call("/api/home/withdraw/preview", { id, target });
    assert.equal(pre.json.code, "unofficial");
    assert.equal((await call("/api/home/withdraw", { id, target })).status, 409, "no consent");
    const ok = await call("/api/home/withdraw/preview", { id, target, allowUnofficial: true });
    assert.deepEqual([ok.json.ok, ok.json.unofficial, ok.json.rules], [true, true, ["vc-model-v1"]]);
    const w = (await call("/api/home/withdraw", { id, target, allowUnofficial: true })).json;
    assert.equal(w.meta.format, "pk3");
    const em = await loadSave("emerald-en.sav");
    em.putInBox(fromBase64(w.record), w.meta);
    assert.equal((await call(`/api/home/withdraw/${id}/commit`, {})).status, 204);
    // The converted Gen 3 Pokémon comes back later: it carries the unofficial badge.
    const again = await call("/api/home/deposit", { mons: [{ record: w.record, meta: w.meta }] });
    assert.equal(again.status, 200);
    const listed = (await call("/api/home")).json.boxes[0].mons[0];
    assert.ok(listed.flags.includes("unofficial"), JSON.stringify(listed.flags));
  } finally { await srv.close(); }
});
