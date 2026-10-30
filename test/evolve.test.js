/* shared/pkm/evolve.js on fixture records reshaped into trade-evolution candidates. The
   expected values were confirmed with the PKHeX oracle (`pkm <format> <hex>`) when written. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as D from "../shared/data/index.js";
import { applyTrade, tradeEvolve, tradeEvolution, receiveTrade } from "../shared/pkm/evolve.js";
import { CODECS, checkRecord } from "../shared/pkm/index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "records");
const rd = (n) => Uint8Array.from(fs.readFileSync(path.join(dir, n + ".hex"), "utf8").trim().match(/../g), (x) => parseInt(x, 16));
const meta = (format) => ({ format, lang: "en" });

function make(format, name, edit) {
  const c = CODECS[format];
  const f = c.parse(rd(name), meta(format));
  edit(f);
  return c.build(f, meta(format));
}
const view = (format, record) => CODECS[format].toView(CODECS[format].parse(record, meta(format)), meta(format));

test("Gen 1 Kadabra becomes Alakazam: type bytes, name and a valid record", () => {
  const rec = make("pk1", "pk1-pikachu-sparky", (f) => { f.species = 64; f.speciesIndex = null; f.nickname = "KADABRA"; f.nicknameBytes = null; });
  const r = applyTrade(rec, meta("pk1"));
  assert.deepEqual(r.evolved, { from: 64, to: 65 });
  const f = CODECS.pk1.parse(r.record, meta("pk1"));
  assert.deepEqual([f.species, f.type1, f.type2, f.nickname], [65, 0x18, 0x18, "ALAKAZAM"]);
  assert.ok(checkRecord(r.record, meta("pk1")).ok);
});

test("Gen 2: Metal Coat is used up, nickname kept, friendship 70; Everstone blocks", () => {
  const onix = make("pk2", "pk2-cyndaquil-blaze", (f) => { f.species = 95; f.heldItem = 143; f.listByte = null; f.friendship = 200; });
  const r = applyTrade(onix, meta("pk2"));
  assert.deepEqual(r.evolved, { from: 95, to: 208 });
  const v = view("pk2", r.record);
  assert.deepEqual([v.species, v.heldItem, v.nickname, v.friendship], [208, null, "BLAZE", 70]);
  const held = make("pk2", "pk2-cyndaquil-blaze", (f) => { f.species = 64; f.heldItem = 112; });   // Kadabra + Everstone
  assert.equal(applyTrade(held, meta("pk2")).evolved, null);
  assert.equal(tradeEvolution(CODECS.pk2.parse(held, meta("pk2")), meta("pk2")).blockedBy, "Everstone");
});

test("Gen 3 Clamperl picks its evolution by item and is renamed when not nicknamed", () => {
  const tooth = make("pk3", "pk3-zigzagoon-oranberry", (f) => { f.growth.species = D.nationalToGen3(366); f.growth.heldItem = 192; f.nickname = "CLAMPERL"; });
  const scale = make("pk3", "pk3-zigzagoon-oranberry", (f) => { f.growth.species = D.nationalToGen3(366); f.growth.heldItem = 193; f.nickname = "CLAMPERL"; });
  const a = view("pk3", applyTrade(tooth, meta("pk3")).record), b = view("pk3", applyTrade(scale, meta("pk3")).record);
  assert.deepEqual([a.speciesName, a.nickname, a.heldItem], ["Huntail", "HUNTAIL", null]);
  assert.deepEqual([b.speciesName, b.nickname], ["Gorebyss", "GOREBYSS"]);
  assert.ok(checkRecord(applyTrade(tooth, meta("pk3")).record, meta("pk3")).ok);
});

test("Gen 4: Kadabra ignores the Everstone, ability recomputed", () => {
  const rec = make("pk4", "pk4-turtwig-shelly", (f) => { f.species = 64; f.heldItem = 229; f.nickname = "KADABRA"; f.nicknameCodes = null; f.isNicknamed = false; });
  const r = applyTrade(rec, meta("pk4"));
  assert.deepEqual(r.evolved, { from: 64, to: 65 });
  const v = view("pk4", r.record);
  assert.deepEqual([v.speciesName, v.nickname, v.heldItem], ["Alakazam", "ALAKAZAM", "Everstone"]);
  assert.ok(D.abilities(4, 65).includes(v.abilityId));
  // Onix still needs its Metal Coat in Gen 4, and an Everstone blocks it there.
  const onix = make("pk4", "pk4-turtwig-shelly", (f) => { f.species = 95; f.heldItem = 229; });
  assert.equal(tradeEvolve(onix, meta("pk4")), null);
});

test("Gen 5 Karrablast needs Shelmet as the partner; names in title case", () => {
  const rec = make("pk5", "pk5-oshawott-shell", (f) => { f.species = 588; f.isNicknamed = false; f.nickname = "Karrablast"; });
  assert.equal(tradeEvolve(rec, meta("pk5"), { partnerSpecies: 25 }), null);
  assert.equal(tradeEvolve(rec, meta("pk5"), { partnerSpecies: 616, partnerEverstone: true }), null);
  const v = view("pk5", tradeEvolve(rec, meta("pk5"), { partnerSpecies: 616 }).record);
  assert.deepEqual([v.speciesName, v.nickname], ["Escavalier", "Escavalier"]);
  assert.ok(D.abilities(5, 589).includes(v.abilityId));
});

test("a trade evolution from a later generation does not happen in an earlier format", () => {
  const rhydon = make("pk3", "pk3-zigzagoon-oranberry", (f) => { f.growth.species = D.nationalToGen3(112); f.growth.heldItem = 0; });
  assert.equal(tradeEvolve(rhydon, meta("pk3")), null, "Rhyperior is Gen 4");
});

test("receiving an Egg in Gen 4 sets the link-trade met location and keeps friendship", () => {
  const egg = rd("pk4-riolu-egg");
  const before = CODECS.pk4.parse(egg, meta("pk4"));
  const f = CODECS.pk4.parse(receiveTrade(egg, meta("pk4"), { now: new Date(2026, 9, 29) }).record, meta("pk4"));
  assert.equal(f.metLocationPt, 2002);
  assert.deepEqual(f.metDate, [26, 10, 29]);
  assert.equal(f.friendship, before.friendship, "Eggs keep their hatch counter");
});
