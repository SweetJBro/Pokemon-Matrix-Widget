/* server/trades.js over HTTP with real records: offers, answers, confirmations, the atomic swap
   with trade evolution, locks, cancellation, and the races a two-player flow invites. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { CODECS } from "../shared/pkm/index.js";
import { toBase64 } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "records");
const rd = (n) => Uint8Array.from(fs.readFileSync(path.join(dir, n + ".hex"), "utf8").trim().match(/../g), (x) => parseInt(x, 16));
const ROOM = "!trade:example.org";

let app, base;
before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1" }));
  base = `http://127.0.0.1:${(await app.listen()).port}`;
});
after(() => app.close());

async function login(userId) {
  const r = await fetch(base + "/api/auth/dev", { method: "POST", body: JSON.stringify({ userId, displayName: userId.slice(1, 4) }) }).then((x) => x.json());
  const call = (method, p, body) => fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: "Bearer " + r.token, "content-type": "application/json" } })
    .then(async (x) => ({ status: x.status, json: x.status === 204 ? null : await x.json() }));
  return { id: userId, get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}) };
}

/** A pk2 record edited into `species` holding `item` (Gen 2 item index), with distinct DVs per call. */
let seq = 0;
function gb2(species, item = 0) {
  const meta = { format: "pk2", lang: "en", game: "GS" };
  const f = CODECS.pk2.parse(rd("pk2-cyndaquil-blaze"), meta);
  seq++;
  Object.assign(f, { species, heldItem: item, listByte: null, nickname: `MON${seq}`, nicknameBytes: null, exp: f.exp + seq });
  return { record: toBase64(CODECS.pk2.build(f, meta)), meta };
}
async function depositOne(user, entry) {
  const r = await user.post("/api/home/deposit", { mons: [entry] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.stored[0];
}
const homeOf = async (u) => (await u.get("/api/home")).json.boxes.flatMap((b) => b.mons);

test("direct trade with a trade evolution on each side", async () => {
  const ash = await login("@ash:example.org"), gary = await login("@gary:example.org");
  const onix = await depositOne(ash, gb2(95, 143));     // Onix @ Metal Coat
  const kadabra = await depositOne(gary, gb2(64));      // Kadabra
  const offer = await ash.post("/api/trades", { roomId: ROOM, to: gary.id, offerMonId: onix.id, wanted: { note: "anything" } });
  assert.equal(offer.status, 200);
  assert.equal(offer.json.from.mon.evolves, null, "no partner yet");
  assert.equal((await ash.post("/api/home/move", { id: onix.id, box: 3, slot: 0 })).status, 409, "offered Pokémon is locked");
  assert.equal((await ash.post("/api/trades", { roomId: ROOM, to: gary.id, offerMonId: onix.id })).status, 409, "can't be offered twice");

  const ans = await gary.post(`/api/trades/${offer.json.id}/answer`, { monId: kadabra.id });
  assert.equal(ans.status, 200);
  assert.deepEqual(ans.json.from.mon.evolves, { to: 208, blockedBy: null }, "Steelix preview");
  assert.deepEqual(ans.json.to.mon.evolves, { to: 65, blockedBy: null }, "Alakazam preview");

  const deal = { fromMon: onix.id, toMon: kadabra.id };
  assert.equal((await ash.post(`/api/trades/${offer.json.id}/confirm`, { fromMon: onix.id, toMon: "x" })).status, 409, "stale view");
  const c1 = await ash.post(`/api/trades/${offer.json.id}/confirm`, deal);
  assert.equal(c1.json.status, "answered");
  assert.equal(c1.json.fromOk, true);
  const c2 = await gary.post(`/api/trades/${offer.json.id}/confirm`, deal);
  assert.equal(c2.json.status, "done");
  assert.equal(c2.json.result.evolved.length, 2);

  const [ashHome, garyHome] = [await homeOf(ash), await homeOf(gary)];
  assert.deepEqual(ashHome.map((m) => m.summary.speciesName), ["Alakazam"]);
  assert.deepEqual(garyHome.map((m) => m.summary.speciesName), ["Steelix"]);
  assert.equal(garyHome[0].summary.heldItem, null, "Metal Coat used up");
  assert.equal(ashHome[0].slot, onix.slot, "received Pokémon takes the slot of the one given");
  assert.ok(ashHome[0].flags.includes("trade"));
  const detail = (await ash.get(`/api/home/mon/${ashHome[0].id}`)).json;
  assert.equal(detail.view.friendship, 70, "friendship reset on receipt");
  assert.equal(detail.provenance.at(-1).rule, "trade");
  assert.equal((await gary.post(`/api/trades/${offer.json.id}/confirm`, deal)).status, 409, "a done trade stays done");
});

test("open offers, counter-offers reset confirmations, cancel unlocks", async () => {
  const misty = await login("@misty:example.org"), brock = await login("@brock:example.org"), may = await login("@may:example.org");
  const staryu = await depositOne(misty, gb2(120));
  const onix = await depositOne(brock, gb2(95));
  const geodude = await depositOne(brock, gb2(74));
  const torchic = await depositOne(may, gb2(152));
  const offer = (await misty.post("/api/trades", { roomId: ROOM, to: null, offerMonId: staryu.id })).json;
  const list = (await brock.get(`/api/trades?roomId=${encodeURIComponent(ROOM)}`)).json;
  assert.ok(list.open.some((t) => t.id === offer.id), "visible to the room");
  assert.ok(!(await misty.get(`/api/trades?roomId=${encodeURIComponent(ROOM)}`)).json.open.some((t) => t.id === offer.id), "not to its author as an open offer");

  await brock.post(`/api/trades/${offer.id}/answer`, { monId: onix.id });
  assert.equal((await may.post(`/api/trades/${offer.id}/answer`, { monId: torchic.id })).status, 403, "answered offers belong to the answerer");
  await misty.post(`/api/trades/${offer.id}/confirm`, { fromMon: staryu.id, toMon: onix.id });
  // Brock swaps his answer: Misty's confirmation is cleared and Onix is unlocked.
  const changed = (await brock.post(`/api/trades/${offer.id}/answer`, { monId: geodude.id })).json;
  assert.equal(changed.fromOk, false);
  assert.equal((await homeOf(brock)).find((m) => m.id === onix.id).locked, null);
  assert.equal((await brock.post(`/api/trades/${offer.id}/confirm`, { fromMon: staryu.id, toMon: onix.id })).status, 409, "old deal");

  assert.equal((await may.post(`/api/trades/${offer.id}/cancel`)).status, 403, "only the two parties can cancel");
  const cancelled = (await brock.post(`/api/trades/${offer.id}/cancel`)).json;
  assert.equal(cancelled.status, "cancelled");
  assert.ok((await homeOf(misty)).every((m) => !m.locked));
  assert.ok((await homeOf(brock)).every((m) => !m.locked));
  assert.equal((await misty.post(`/api/trades/${offer.id}/confirm`, { fromMon: staryu.id, toMon: geodude.id })).status, 409);
});

test("bad requests and Pokémon that are not yours", async () => {
  const red = await login("@red:example.org"), blue = await login("@blue:example.org");
  const mine = await depositOne(red, gb2(25));
  const theirs = await depositOne(blue, gb2(133));
  assert.equal((await red.post("/api/trades", { roomId: ROOM, to: null, offerMonId: theirs.id })).status, 404);
  assert.equal((await red.post("/api/trades", { roomId: "lobby", to: null, offerMonId: mine.id })).status, 400);
  assert.equal((await red.post("/api/trades", { roomId: ROOM, to: red.id, offerMonId: mine.id })).status, 400);
  assert.equal((await red.post("/api/trades", { roomId: ROOM, to: "@nobody:example.org", offerMonId: mine.id })).status, 404);
  const t = (await red.post("/api/trades", { roomId: ROOM, to: blue.id, offerMonId: mine.id })).json;
  assert.equal((await red.post(`/api/trades/${t.id}/answer`, { monId: mine.id })).status, 400, "can't answer own offer");
  assert.equal((await blue.post(`/api/trades/${t.id}/answer`, { monId: mine.id })).status, 404, "can't answer with someone else's Pokémon");
  assert.equal((await blue.post(`/api/trades/${t.id}/confirm`, { fromMon: mine.id, toMon: null })).status, 409, "nothing to confirm yet");
  // A Pokémon being withdrawn can't be offered, and an offered one can't be withdrawn.
  assert.equal((await red.post("/api/home/withdraw", { id: mine.id, target: { format: "pk2" } })).status, 409);
});

test("both confirming at once makes exactly one swap", async () => {
  const a = await login("@ann:example.org"), b = await login("@ben:example.org");
  const x = await depositOne(a, gb2(1)), y = await depositOne(b, gb2(4));
  const t = (await a.post("/api/trades", { roomId: ROOM, to: b.id, offerMonId: x.id })).json;
  await b.post(`/api/trades/${t.id}/answer`, { monId: y.id });
  const deal = { fromMon: x.id, toMon: y.id };
  const [r1, r2] = await Promise.all([a.post(`/api/trades/${t.id}/confirm`, deal), b.post(`/api/trades/${t.id}/confirm`, deal)]);
  assert.ok([r1.json.status, r2.json.status].includes("done"));
  assert.deepEqual((await homeOf(a)).map((m) => m.summary.species), [4]);
  assert.deepEqual((await homeOf(b)).map((m) => m.summary.species), [1]);
});
