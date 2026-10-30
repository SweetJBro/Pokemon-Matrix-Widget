/* web/js/saves/session.js against the real server: deposit from a fixture save into Home,
   withdraw into another save, and the failure paths that must leave save and Home unchanged. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { createSaveStore } from "../web/js/savestore.js";
import { deposit, withdraw, openEntry } from "../web/js/saves/session.js";
import { hex } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "saves");
const bytes = (n) => new Uint8Array(fs.readFileSync(path.join(dir, n)));

let app, base;
before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1" }));
  base = `http://127.0.0.1:${(await app.listen()).port}`;
});
after(() => app.close());

async function apiFor(userId) {
  const { token } = await fetch(base + "/api/auth/dev", { method: "POST", body: JSON.stringify({ userId }) }).then((r) => r.json());
  const call = async (method, p, body) => {
    const r = await fetch(`${base}/${p}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: "Bearer " + token, "content-type": "application/json" } });
    const json = r.status === 204 ? null : await r.json();
    if (!r.ok) throw Object.assign(new Error(json?.error || r.statusText), { status: r.status });
    return json;
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}) };
}

const memStore = () => createSaveStore({ indexedDB: null });

test("deposit from party and boxes, then withdraw into another save of that generation", async () => {
  const api = await apiFor("@ash:example.org");
  const store = memStore();
  const src = await store.add(bytes("crystal-en.sav"), "crystal.sav");
  const dst = await store.add(bytes("gold-en.sav"), "gold.sav");
  const before = await openEntry(store.get(src.id));
  const box0 = before.box(0).filter(Boolean).length;

  const res = await deposit({ api, store, entryId: src.id, picks: [{ box: 0, index: 0 }, { box: 0, index: 2 }, { party: true, index: 2 }] });
  assert.equal(res.stored.length, 3);
  const afterDep = await openEntry(store.get(src.id));
  assert.equal(afterDep.box(0).filter(Boolean).length, box0 - 2, "two left the box (packed list shifted correctly)");
  assert.equal(afterDep.party().length, before.party().length - 1);
  assert.ok(store.get(src.id).dirty);

  const home = await api.get("api/home");
  const ids = home.boxes[0].mons.map((m) => m.id);
  const target = await openEntry(store.get(dst.id));
  const free = target.box(1).filter(Boolean).length;
  const w = await withdraw({ api, store, entryId: dst.id, monIds: ids, targetBox: 1 });
  assert.equal(w.failed.length, 0, JSON.stringify(w.failed));
  assert.equal(w.done.length, 3);
  const g = await openEntry(store.get(dst.id));
  assert.equal(g.box(1).filter(Boolean).length, free + 3);
  const after = await api.get("api/home");
  assert.equal(after.boxes[0].mons.length, 0);
  assert.equal(after.pendingWithdrawals.length, 0);
});

test("a failed deposit leaves the save as it was", async () => {
  const api = await apiFor("@misty:example.org");
  const store = memStore();
  const e = await store.add(bytes("emerald-en.sav"), "e.sav");
  await deposit({ api, store, entryId: e.id, picks: [{ box: 0, index: 3 }] });
  // Revert the save to the original bytes and try the same Pokémon again: the server refuses it.
  await store.revert(e.id);
  const original = hex(store.get(e.id).working);
  await assert.rejects(deposit({ api, store, entryId: e.id, picks: [{ box: 0, index: 3 }] }), /already in Home/);
  assert.equal(hex(store.get(e.id).working), original, "untouched");
  // The save module itself refuses to empty the party.
  const p = await store.add(bytes("emerald-en.sav"), "e2.sav");
  await assert.rejects(deposit({ api, store, entryId: p.id, picks: [0, 1, 2].map((index) => ({ party: true, index })) }));
  assert.equal(hex(store.get(p.id).working), hex(bytes("emerald-en.sav")));
});

test("a Gen 5 Pokémon can't go into a Gen 4 save; it stays in Home, unlocked", async () => {
  const api = await apiFor("@brock:example.org");
  const store = memStore();
  const bw = await store.add(bytes("black-en.sav"), "b.sav");
  await deposit({ api, store, entryId: bw.id, picks: [{ box: 0, index: 9 }] });
  const id = (await api.get("api/home")).boxes[0].mons[0].id;
  const pt = await store.add(bytes("platinum-en.sav"), "pt.sav");
  const before = hex(store.get(pt.id).working);
  const r = await withdraw({ api, store, entryId: pt.id, monIds: [id] });
  assert.equal(r.done.length, 0);
  assert.match(r.failed[0].error, /older generation/);
  assert.equal(hex(store.get(pt.id).working), before);
  assert.equal((await api.get("api/home")).boxes[0].mons[0].locked, null);
});

test("a Gen 4 Pokémon withdrawn into a Gen 5 save goes through Poké Transfer", async () => {
  const api = await apiFor("@dawn:example.org");
  const store = memStore();
  const pt = await store.add(bytes("platinum-en.sav"), "pt.sav");
  const src = await openEntry(store.get(pt.id));
  const i = src.box(0).findIndex((e) => e && !e.view.isEgg && !e.view.heldItem && !e.view.moves.some((m) => [15, 19, 57, 70, 432, 249, 127, 431].includes(m.id)));
  const species = src.box(0)[i].view.species;
  await deposit({ api, store, entryId: pt.id, picks: [{ box: 0, index: i }] });
  const id = (await api.get("api/home")).boxes[0].mons[0].id;
  const bw = await store.add(bytes("black-en.sav"), "b.sav");
  const r = await withdraw({ api, store, entryId: bw.id, monIds: [id], targetBox: 5 });
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
  const after = await openEntry(store.get(bw.id));
  const got = after.box(r.done[0].box)[r.done[0].index].view;
  assert.deepEqual([got.format, got.species, got.met.location], ["pk5", species, 30001]);
  const hist = await api.get("api/home/history");
  assert.equal(hist.entries[0].detail.conversions[0].rule, "poke-transfer");
});
