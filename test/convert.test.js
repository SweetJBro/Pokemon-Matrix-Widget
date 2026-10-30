/* shared/pkm/convert.js. Official paths are compared with PKHeX's conversions in
   test/fixtures/convert (where PKHeX follows the games; the research doc lists where it doesn't:
   it keeps held items through Poké Transfer, deletes HMs instead of refusing, force-hatches Eggs).
   The unofficial Gen 1/2 -> Gen 3 rule is checked for what it promises to keep. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convert, canConvert } from "../shared/pkm/convert.js";
import { CODECS, checkRecord, readRecord } from "../shared/pkm/index.js";
import { hiddenPower } from "../shared/pkm/stats.js";
import { openSave } from "../shared/saves/index.js";
import { hex } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const vector = (n) => JSON.parse(fs.readFileSync(path.join(dir, "convert", n + ".json"), "utf8"));
const NOW = new Date(2010, 0, 1);
const KEYS = ["species", "form", "nickname", "isNicknamed", "level", "exp", "nature", "ability", "gender", "isShiny", "pid", "friendship", "language", "fatefulEncounter"];

function compare(name, { target = {}, skip = [] } = {}) {
  const j = vector(name);
  const lang = j.input.languageCode && j.input.languageCode !== "?" ? j.input.languageCode : name.includes("-ja-") ? "ja" : "en";
  const r = convert(fromHex(j.input.recordHex), { format: j.from, lang, game: null }, j.to, { now: NOW, target: { lang, ...target } });
  const v = readRecord(r.record, r.meta).view;
  const o = j.output;
  const ours = { species: v.species, form: v.form, nickname: v.nickname, isNicknamed: v.isNicknamed, level: v.level, exp: v.exp,
    nature: v.natureId, ability: v.abilityId, gender: v.gender == null ? 2 : v.gender === "M" ? 0 : 1, isShiny: v.shiny, pid: v.pid,
    friendship: v.friendship, language: o.language, fatefulEncounter: o.fatefulEncounter };
  for (const k of KEYS) {
    if (skip.includes(k) || (j.from <= "pk2" && ["nature", "ability", "pid", "language", "fatefulEncounter", "isNicknamed"].includes(k))) continue;
    if (j.to <= "pk2" && k === "friendship") continue;
    assert.deepEqual(ours[k] ?? null, o[k] ?? null, `${name}: ${k}`);
  }
  assert.deepEqual(v.moves.map((m) => [m.id, m.pp]), o.moves.filter((m) => m.id).map((m) => [m.id, m.pp]), `${name}: moves`);
  assert.ok(checkRecord(r.record, r.meta).ok, `${name}: passes the record gate`);
  return { r, v, o };
}

test("Time Capsule matches PKHeX both ways, items via the catch-rate byte", () => {
  compare("pk1-pk2-pikachu-sparky");
  compare("pk1-pk2-ja-pikachu");
  const { v } = compare("pk1-pk2-yellow-pikachu-lightball");
  assert.equal(v.heldItem, "Light Ball", "Yellow's Pikachu catch rate 0xA3 is a Light Ball in Gen 2");
  compare("pk2-pk1-crystal-pikachu");
  for (const n of ["pk2-pk1-cyndaquil-fails", "pk2-pk1-unown-fails"]) {
    const j = vector(n);
    assert.throws(() => convert(fromHex(j.input.recordHex), { format: "pk2", lang: "en" }, "pk1", { now: NOW }), /doesn't exist in Generation 1/);
  }
});

test("Pal Park matches PKHeX: PID, ability, ribbons, met data", () => {
  for (const n of ["pk3-pk4-treecko-leafy", "pk3-pk4-zigzagoon-oranberry", "pk3-pk4-mew-fateful"]) {
    const { v } = compare(n, { target: { game: "Pt" } });
    assert.equal(v.met.location, 55);
  }
  const egg = vector("pk3-pk4-azurill-egg");
  assert.throws(() => convert(fromHex(egg.input.recordHex), { format: "pk3", lang: "en" }, "pk4", { now: NOW }), /Eggs can't go to Pal Park/);
});

test("Poké Transfer matches PKHeX except where PKHeX departs from the game", () => {
  for (const n of ["pk4-pk5-turtwig-shelly", "pk4-pk5-hgss-pikachu-fastball", "pk3-pk5-treecko-chain"]) {
    const { v, r } = compare(n);
    assert.equal(v.met.location, 30001);
    assert.equal(v.heldItem, null, "the real Poké Transfer leaves the item behind");
    if (n.includes("fastball")) assert.equal(v.ballId, 17, "HG/SS Apricorn balls survive");
    if (n.includes("chain")) assert.deepEqual(r.provenance.map((p) => p.rule), ["pal-park", "poke-transfer"]);
  }
  const g = compare("pk4-pk5-giratina-origin", { skip: ["form"] });
  assert.equal(g.v.form, 0, "Giratina loses the Griseous Orb and its Origin Forme");
  const hm = vector("pk4-pk5-bibarel-hms");
  assert.throws(() => convert(fromHex(hm.input.recordHex), { format: "pk4", lang: "en", game: "D" }, "pk5", { now: NOW }), /knows Surf, an HM/);
});

test("routes: nothing goes back up, unofficial needs consent", () => {
  assert.deepEqual(canConvert({ format: "pk4" }, "pk3"), { ok: false, unofficial: false, reason: canConvert({ format: "pk4" }, "pk3").reason });
  assert.equal(canConvert({ format: "pk2" }, "pk1").ok, true);
  assert.equal(canConvert({ format: "pk1" }, "pk3").ok, false);
  assert.equal(canConvert({ format: "pk1" }, "pk3", { allowUnofficial: true }).unofficial, true);
  assert.equal(canConvert({ format: "pk3" }, "pk5").ok, true);
  const j = vector("pk1-pk3-pikachu-fails");
  assert.throws(() => convert(fromHex(j.input.recordHex), { format: "pk1", lang: "en" }, "pk3", { now: NOW }), /unofficial/);
});

test("unofficial Gen 1/2 -> Gen 3 keeps gender, shininess, Unown letter and Hidden Power, deterministically", async () => {
  let n = 0;
  for (const f of ["red-en.sav", "gold-en.sav", "crystal-en.sav", "red-ja.sav"]) {
    const s = await openSave(new Uint8Array(fs.readFileSync(path.join(dir, "saves", f))), f);
    const all = [...s.party(), ...s.box(0)].filter((e) => e && !e.view.isEgg);
    for (const { record, meta, view } of all) {
      const opts = { allowUnofficial: true, dropItem: true, now: NOW, target: { lang: meta.lang } };
      const r = convert(record, meta, "pk3", opts);
      assert.equal(hex(convert(record, meta, "pk3", opts).record), hex(r.record), "same input, same bytes");
      const v = readRecord(r.record, r.meta).view;
      const where = `${f} ${view.speciesName}`;
      assert.deepEqual([v.species, v.level, v.shiny, v.gender, v.natureId], [view.species, view.level, view.shiny, view.gender, view.exp % 25], where);
      if (view.species === 201) assert.equal(v.form, view.form, `${where}: Unown letter`);
      assert.equal(hiddenPower(3, v.ivs).type, hiddenPower(2, view.dvs).type, `${where}: Hidden Power type`);
      assert.deepEqual(v.moves.map((m) => m.id), view.moves.map((m) => m.id));
      assert.ok(checkRecord(r.record, r.meta).ok, where);
      assert.equal(r.provenance[0].rule, "vc-model-v1");
      n++;
    }
  }
  assert.ok(n >= 20);
});

test("unofficial conversion refuses Korean and held items unless the item may be lost", async () => {
  const ko = await openSave(new Uint8Array(fs.readFileSync(path.join(dir, "saves", "gold-ko.sav"))), "ko.sav");
  const k = ko.party()[0];
  assert.throws(() => convert(k.record, k.meta, "pk3", { allowUnofficial: true }), /Korean/);
  const g = await openSave(new Uint8Array(fs.readFileSync(path.join(dir, "saves", "gold-en.sav"))), "g.sav");
  const holder = g.party().find((e) => e.view.heldItem);
  assert.throws(() => convert(holder.record, holder.meta, "pk3", { allowUnofficial: true }), /holds/);
  const r = convert(holder.record, holder.meta, "pk3", { allowUnofficial: true, dropItem: true, now: NOW });
  assert.ok(r.notes.some((x) => /lost/.test(x)));
});
