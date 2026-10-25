/* web/js/savestore.js under node: node has no IndexedDB, which is exactly the "storage
   unavailable" case the widget must survive (partitioned/ephemeral iframe storage). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveStore, safeFilename } from "../web/js/savestore.js";

test("works in memory when IndexedDB is missing", async () => {
  const store = createSaveStore({ indexedDB: null });
  assert.deepEqual(await store.ready(), []);
  const changes = [];
  store.onChange((list) => changes.push(list.length));

  const bytes = new Uint8Array([1, 2, 3, 4]);
  const e = await store.add(bytes, "POKEMON EMERALD.sav", { game: "E" });
  bytes[0] = 99;                                   // the caller's buffer is not shared
  assert.equal(store.persistent, false);
  assert.equal(e.filename, "POKEMON EMERALD.sav");
  assert.equal(e.size, 4);
  assert.deepEqual([...e.original], [1, 2, 3, 4]);
  assert.deepEqual([...e.working], [1, 2, 3, 4]);
  assert.notEqual(e.original, e.working);
  assert.equal(e.dirty, false);
  assert.equal(e.lastExported, null);
  assert.deepEqual(e.meta, { game: "E" });
  assert.equal(store.get(e.id), e);
  assert.equal(store.get("nope"), null);

  await store.update(e.id, new Uint8Array([1, 2, 3, 5]), { party: 6 });
  assert.equal(store.get(e.id).dirty, true);
  assert.equal(store.changedSinceOpen(e.id), true);
  assert.equal(store.get(e.id).meta.party, 6);

  await store.markExported(e.id);
  assert.equal(store.get(e.id).dirty, false);
  assert.ok(store.get(e.id).lastExported > 0);
  assert.equal(store.changedSinceOpen(e.id), true);   // still differs from the file as opened

  await store.revert(e.id);
  assert.deepEqual([...store.get(e.id).working], [1, 2, 3, 4]);
  assert.equal(store.changedSinceOpen(e.id), false);

  const e2 = await store.add(new ArrayBuffer(8), "second.sav");
  assert.deepEqual(store.list().map((x) => x.id), [e.id, e2.id]);
  assert.equal(await store.remove(e.id), true);
  assert.equal(await store.remove(e.id), false);
  assert.deepEqual(store.list().map((x) => x.id), [e2.id]);
  await assert.rejects(store.update(e.id, new Uint8Array(1)), /no longer open/);
  assert.ok(changes.length >= 6);
});

test("an IndexedDB that throws or errors is treated as unavailable", async () => {
  const throwing = { open() { throw new Error("SecurityError: access denied for this storage partition"); } };
  const s1 = createSaveStore({ indexedDB: throwing });
  await s1.ready();
  const e = await s1.add(new Uint8Array([7]), "a.sav");
  assert.equal(s1.persistent, false);
  assert.equal(s1.get(e.id).working[0], 7);

  const erroring = { open() { const req = {}; setTimeout(() => { req.error = new Error("UnknownError"); req.onerror?.(); }, 0); return req; } };
  const s2 = createSaveStore({ indexedDB: erroring });
  await s2.ready();
  await s2.add(new Uint8Array([8]), "b.sav");
  assert.equal(s2.list().length, 1);
});

test("useScope must come before storage is touched", async () => {
  const s = createSaveStore({ indexedDB: null });
  s.useScope("@ash:example.org");
  await s.ready();
  assert.throws(() => s.useScope("@gary:example.org"), /before the first storage access/);
});

test("file names are cleaned for downloads", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.equal(safeFilename("C:\\Users\\ash\\Pokemon Red.sav"), "Pokemon Red.sav");
  assert.equal(safeFilename('a<b>c:"d"|e?.sav'), "a_b_c__d__e_.sav");
  assert.equal(safeFilename(".hidden.sav"), "hidden.sav");
  assert.equal(safeFilename(""), "save.sav");
  assert.equal(safeFilename("x".repeat(300)).length, 120);
});
