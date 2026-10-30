// PK4 record codec (shared/pkm/pk4.js) against the PKHeX-derived fixtures in test/fixtures/ and the
// known answers of docs/research/format-gen4.md §10.4 and §19.1. No .NET needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as P from "../shared/pkm/pk4.js";
import { decrypt45, encrypt45, checksum45 } from "../shared/pkm/crypt.js";
import { FormatError, sum16le } from "../shared/bytes.js";

const FIX = new URL("./fixtures/", import.meta.url);
const read = (p) => readFileSync(new URL(p, FIX));
const fromHex = (h) => Uint8Array.from(h.trim().match(/../g), (x) => parseInt(x, 16));
const toHex = (b) => Buffer.from(b).toString("hex");

const RECORDS = readdirSync(new URL("records/", FIX)).filter((f) => f.startsWith("pk4-") && f.endsWith(".hex")).map((f) => {
  const name = f.slice(0, -4);
  return { name, hex: read(`records/${f}`).toString("utf8").trim(), pkm: JSON.parse(read(`records/${name}.json`)).pkm };
});
const SAVES = readdirSync(new URL("saves/", FIX)).filter((f) => f.endsWith(".expected.json"))
  .map((f) => JSON.parse(read(`saves/${f}`))).filter((d) => d.format === "pk4");
const SLOTS = SAVES.flatMap((d) => [
  ...d.party.map((m) => ({ where: `${d.file.name} party ${m.slot}`, m })),
  ...d.boxes.map((m) => ({ where: `${d.file.name} box ${m.box}/${m.slot}`, m })),
]);

const GENDER = ["M", "F", null];
/** Compares our view with PKHeX's dump of the same Pokémon, field by field. */
function sameAsPKHeX(view, f, m, where) {
  const eq = (k, a, b) => assert.deepEqual(a, b, `${where}: ${k}`);
  eq("species", view.species, m.species); eq("form", view.form, m.form);
  eq("nickname", view.nickname, m.nickname); eq("isNicknamed", view.isNicknamed, m.isNicknamed); eq("isEgg", view.isEgg, m.isEgg);
  eq("level", view.level, m.level); eq("exp", view.exp, m.exp);
  eq("moves", view.moves.map((x) => [x.id, x.pp, x.ppUps]), m.moves.filter((x) => x.id).map((x) => [x.id, x.pp, x.ppUps]));
  eq("ivs", view.ivs, m.ivs); eq("evs", view.evs, m.evs);
  eq("nature", view.natureId, m.nature); eq("ability", view.abilityId, m.ability); eq("abilityNum", view.abilityNum, m.abilityNumber);
  eq("item", view.heldItemId, m.heldItem); eq("gender", view.gender, GENDER[m.gender]); eq("shiny", view.shiny, m.isShiny);
  eq("pid", view.pid, m.pid); eq("lang", view.lang, m.languageCode); eq("friendship", view.friendship, m.friendship);
  eq("ot", view.ot, { name: m.ot.name, tid: m.ot.tid, sid: m.ot.sid, gender: ["M", "F"][m.ot.gender] });
  if (!m.isEgg) eq("met", [view.met.location, view.met.level, view.met.date, view.met.game], [m.met.location, m.met.level, m.met.date, m.met.versionName === "SS" ? "SS" : m.met.versionName]);
  eq("egg", view.egg ? [view.egg.location, view.egg.date] : [0, null], [m.egg.location, m.egg.date]);
  eq("ball", view.ballId, m.met.ball); eq("version", f.version, m.met.version);
  eq("pokerus", view.pokerus ? [view.pokerus.strain, view.pokerus.days] : [0, 0], [m.pokerus.strain, m.pokerus.days]);
  eq("markings", view.markings, m.markingsRaw); eq("fateful", view.fateful, m.fatefulEncounter);
  eq("ribbons", [...view.ribbons].sort(), [...m.ribbons].sort());
  eq("contest", f.contest, m.contest);
  eq("dual fields", [f.metLocationDP, f.metLocationPt, f.eggLocationDP, f.eggLocationPt, f.ballDP, f.ballHGSS, f.groundTile, f.shinyLeaves],
    [m.extra.metLocationDP, m.extra.metLocationExtended, m.extra.eggLocationDP, m.extra.eggLocationExtended, m.extra.ballDPPt, m.extra.ballHGSS, m.extra.groundTile, m.extra.shinyLeaf]);
  eq("checksum", [view.checksumOk, f.checksum], [m.checksumValid, m.checksum]);
  if (m.partyStats && !m.isEgg) {
    const s = m.partyStats;
    eq("party stats", view.stats, { hp: s.hpMax, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe });
    eq("party level/hp", [f.party.level, f.party.hp, f.party.status], [s.level, s.hpCurrent, s.status]);
  }
}

test("constants and the record size", () => {
  assert.equal(P.FORMAT, "pk4"); assert.equal(P.GEN, 4); assert.equal(P.RECORD_SIZE, 136);
  for (const lang of ["en", "ja", "ko", "fr", "de", "it", "es"]) assert.equal(P.recordSize(lang), 136);
});

test("every fixture record and save slot round-trips byte for byte", () => {
  let n = 0;
  for (const r of RECORDS) { assert.equal(toHex(P.build(P.parse(fromHex(r.hex)))), r.hex, r.name); n++; }
  for (const { where, m } of SLOTS) {
    for (const hex of [m.storedHex, m.recordHex]) { assert.equal(toHex(P.build(P.parse(fromHex(hex)))), hex, where); n++; }
  }
  assert.ok(n > 200, `checked ${n}`);
});

test("decoded fields match PKHeX for every fixture record and save slot", () => {
  for (const r of RECORDS.filter((x) => x.pkm.species)) {
    const f = P.parse(fromHex(r.hex));
    sameAsPKHeX(P.toView(f), f, r.pkm, r.name);
  }
  for (const { where, m } of SLOTS) {
    const f = P.parse(fromHex(m.storedHex));
    sameAsPKHeX(P.toView(f), f, m, where);
  }
});

test("the canonical empty record (§10.4) equals PKHeX's empty slot", () => {
  const doc = "0000000000000000" + "00007ee97152b031428ecce2c5afdb6733fc2cef5efcc5cad6eb3d99bc7aa7cbd65d7891a6278d619216b8cf5d3780307c40fb481332e7fea3df693d9e63291d8dea9662689297a3491c036eaa3189aac5d3eac3d982c6e05c943b4e5f5a2824b3fbe1bf8e7b7f00c44048c8d1bfb6383b9023fb237d34be00da6a70c5df84ba";
  assert.equal(toHex(P.emptyRecord()), doc);
  assert.equal(toHex(P.emptyRecord()), RECORDS.find((r) => r.name === "pk4-empty").hex);
  assert.ok(P.isEmptySlot(P.emptyRecord()) && P.checksumValid(P.emptyRecord()));
  // A raw-zero slot decrypts to the bare seed-0 keystream: species 0 (empty for the game's PC) but a failed checksum.
  const zeros = new Uint8Array(136);
  assert.ok(P.isEmptySlot(zeros));
  assert.equal(P.checksumValid(zeros), false);
  assert.equal(sum16le(decrypt45(zeros), 8, 128), 0xbdda);
  // The empty party slot the game writes: the party part is the seed-0 keystream again (PID 0).
  const party = P.emptyPartyRecord();
  assert.equal(party.length, 236);
  assert.equal(toHex(party.subarray(0x88, 0x90)), "00007ee97152b031");
  assert.deepEqual([...party.subarray(0, 136)], [...P.emptyRecord()]);
});

test("the §19.1 regression vector decodes to the documented fields", () => {
  const r = fromHex(RECORDS.find((x) => x.name === "pk4-docvec-pikachu").hex);
  const f = P.parse(r);
  assert.equal(f.checksum, 0xcdbd);
  assert.equal(f.checksumOk, true);
  assert.equal(f.pid, 0x12345678);
  assert.deepEqual([f.species, f.tid, f.sid, f.exp, f.friendship, f.ability, f.language], [25, 12345, 54321, 1000, 70, 9, 2]);
  assert.deepEqual([f.moves, f.pp], [[84, 45, 0, 0], [30, 40, 0, 0]]);
  assert.deepEqual(Object.values(f.ivs), [31, 31, 31, 31, 31, 31]);
  assert.deepEqual([f.gender, f.nickname, f.otName, f.version], [1, "PIKACHU", "JBRO", 12]);
  assert.deepEqual([f.metDate, f.metLocationDP, f.metLocationPt, f.ballDP, f.metLevel, f.groundTile], [[26, 10, 24], 16, 16, 4, 5, 2]);
  const plain = `
    0000: 78 56 34 12 00 00 bd cd 19 00 00 00 39 30 31 d4
    0010: e8 03 00 00 46 09 00 02 00 00 00 00 00 00 00 00
    0020: 00 00 00 00 00 00 00 00 54 00 2d 00 00 00 00 00
    0030: 1e 28 00 00 00 00 00 00 ff ff ff 3f 00 00 00 00
    0040: 02 00 00 00 00 00 10 00 3a 01 33 01 35 01 2b 01
    0050: 2d 01 32 01 3f 01 ff ff 00 00 00 00 00 00 00 0c
    0060: 00 00 00 00 00 00 00 00 34 01 2c 01 3c 01 39 01
    0070: ff ff 00 00 00 00 00 00 00 00 00 1a 0a 18 00 00
    0080: 10 00 00 04 05 02 00 00`.replace(/^\s*[0-9a-f]{4}:/gm, "").replace(/\s+/g, "");
  assert.equal(toHex(decrypt45(r)), plain);
  const v = P.toView(f);
  assert.deepEqual([v.level, v.gender, v.game, v.met.date, v.met.locationName], [10, "F", "Pt", "2026-10-24", "Route 201"]);
});

test("encryption round-trips for all 32 shuffle selectors with random contents", () => {
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
  for (let sel = 0; sel < 32; sel++) {
    for (let k = 0; k < 4; k++) {
      const plain = new Uint8Array(136).map(() => rnd() & 0xff);
      const pid = ((rnd() & ~0x3e000) | (sel << 13)) >>> 0;
      plain.set([pid & 0xff, (pid >>> 8) & 0xff, (pid >>> 16) & 0xff, pid >>> 24], 0);
      plain[4] = plain[5] = 0;
      const stored = encrypt45(plain);
      const f = P.parse(stored);
      assert.ok(f.checksumOk);
      assert.equal(toHex(P.build(f)), toHex(stored), `selector ${sel}`);
      assert.equal(checksum45(decrypt45(stored)), f.checksum);
    }
  }
});

test("parse rejects records of the wrong size with a FormatError", () => {
  for (const bad of [new Uint8Array(0), new Uint8Array(80), new Uint8Array(137), new Uint8Array(220), "00ff"]) {
    assert.throws(() => P.parse(bad), FormatError);
  }
  assert.equal(P.validate(new Uint8Array(100)).ok, false);
});

test("validate: fixture Pokémon pass; damaged, empty and impossible records fail", () => {
  for (const { where, m } of SLOTS) {
    const v = P.validate(fromHex(m.recordHex));
    assert.ok(v.ok, `${where}: ${v.errors}`);
  }
  assert.deepEqual(P.validate(P.emptyRecord()).ok, false);
  const good = fromHex(RECORDS.find((x) => x.name === "pk4-turtwig-shelly").hex);
  const broken = good.slice(); broken[0x30] ^= 0xff;
  assert.match(P.validate(broken).errors.join(), /checksum/);
  const edit = (fn) => { const f = P.parse(good); fn(f); return P.validate(P.build(f)); };
  assert.match(edit((f) => { f.species = 494; }).errors.join(), /does not exist/);
  assert.match(edit((f) => { f.moves = [468, 0, 0, 0]; }).errors.join(), /Move #468/);
  assert.match(edit((f) => { f.moves = [0, 0, 0, 0]; }).errors.join(), /no moves/);
  assert.match(edit((f) => { f.heldItem = 537; }).errors.join(), /item/);
  assert.match(edit((f) => { f.ability = 124; }).errors.join(), /Ability/);
  assert.match(edit((f) => { f.form = 3; }).errors.join(), /form/);
  assert.match(edit((f) => { f.version = 20; }).errors.join(), /Generation 5/);
  assert.match(edit((f) => { f.flags = 4; }).errors.join(), /Bad Egg/);
  assert.match(edit((f) => { f.exp = 2000000; }).warnings.join(), /level 100/);
  assert.match(edit((f) => { f.gender = f.gender ^ 1; }).warnings.join(), /gender/);
  assert.match(edit((f) => { f.nicknameCodes = Array(11).fill(0x12b); }).warnings.join(), /terminator/);
  assert.match(edit((f) => { f.pp = [99, 0, 0, 0]; }).warnings.join(), /PP/);
});

test("dual location fields follow the games' read and write rules (§12.8)", () => {
  const f = P.parse(fromHex(RECORDS.find((x) => x.name === "pk4-turtwig-shelly").hex));
  const cases = [[0, 0], [16, 16], [111, 111], [112, 3002], [117, 3002], [126, 3002], [233, 3002], [2000, 2000], [2002, 2002],
    [2010, 2010], [2011, 3002], [3001, 3001], [3076, 3076], [3077, 3002], [55, 55]];
  for (const [value, dp] of cases) {
    P.setLocation(f, "met", value);
    assert.deepEqual([f.metLocationDP, f.metLocationPt, P.metLocation(f)], [dp, value, value], `met ${value}`);
    P.setLocation(f, "egg", value);
    assert.deepEqual([f.eggLocationDP, f.eggLocationPt, P.eggLocation(f)], [dp, value, value], `egg ${value}`);
  }
  // DP-origin data leaves the Pt/HGSS copy 0; a 3002 with no extended value is a genuine Faraway Place.
  Object.assign(f, { metLocationDP: 3002, metLocationPt: 0 });
  assert.equal(P.metLocation(f), 3002);
});

test("the ball is read the HGSS way: HGSS byte for HeartGold/SoulSilver origins only (§12.9)", () => {
  const f = P.parse(fromHex(RECORDS.find((x) => x.name === "pk4-hgss-pikachu-fastball").hex));
  assert.deepEqual([f.ballDP, f.ballHGSS, f.version, P.ball(f)], [4, 17, 7, 17]);
  assert.equal(P.toView(f).ball, "Fast Ball");
  assert.equal(P.ball({ ...f, version: 12 }), 4);
  assert.equal(P.ball({ ...f, ballHGSS: 0 }), 4);
});

test("names: raw codes are kept; strings are encoded only when the codes are dropped", () => {
  const r = fromHex(RECORDS.find((x) => x.name === "pk4-turtwig-shelly").hex);
  const f = P.parse(r);
  assert.equal(f.nickname, "SHELLY");
  const renamed = { ...f, nickname: "TURTLE", nicknameCodes: null };
  const g = P.parse(P.build(renamed));
  assert.equal(g.nickname, "TURTLE");
  assert.deepEqual(g.nicknameCodes.slice(6), [0xffff, 0, 0, 0, 0]);
  assert.equal(P.parse(P.build({ ...f, nickname: "IGNORED" })).nickname, "SHELLY");
  const ja = P.parse(fromHex(RECORDS.find((x) => x.name === "pk4-ja-chimchar").hex));
  assert.equal(ja.language, 1);
  assert.equal(P.toView(ja).lang, "ja");
});

test("prepareForBox applies what storing in each game's PC does (§10.3, §16)", () => {
  const giratina = P.parse(fromHex(RECORDS.find((x) => x.name === "pk4-giratina-origin").hex));
  assert.deepEqual([giratina.form, giratina.heldItem], [1, 112]);
  const inPt = P.prepareForBox(giratina, "Pt");
  assert.deepEqual([inPt.fields.form, inPt.fields.heldItem, inPt.notes], [1, 112, []]);
  assert.equal(toHex(P.build(inPt.fields)), toHex(P.build(giratina)), "nothing to change for Platinum");
  const inDP = P.prepareForBox(giratina, "D");
  assert.deepEqual([inDP.fields.form, inDP.fields.heldItem, inDP.fields.ability], [0, 0, 46], "Altered Forme has Pressure");
  assert.equal(inDP.notes.length, 3, "orb removed, form reverted, ability recomputed");
  const noOrb = P.prepareForBox({ ...giratina, heldItem: 0 }, "HG");
  assert.equal(noOrb.fields.form, 0);
  assert.equal(giratina.form, 1, "the input is not changed");

  const base = P.parse(fromHex(RECORDS.find((x) => x.name === "pk4-turtwig-shelly").hex));
  const shaymin = P.prepareForBox({ ...base, species: 492, form: 1 }, "HGSS");
  assert.equal(shaymin.fields.form, 0);
  assert.throws(() => P.prepareForBox({ ...base, species: 172, form: 1 }, "Pt"), /Spiky-eared/);
  assert.equal(P.prepareForBox({ ...base, species: 172, form: 1 }, "SS").fields.form, 1);
  assert.equal(P.prepareForBox({ ...base, heldItem: 492 }, "Pt").fields.heldItem, 0, "Fast Ball is HGSS-only");
  assert.equal(P.prepareForBox({ ...base, heldItem: 492 }, "HG").fields.heldItem, 492);
  assert.equal(P.prepareForBox({ ...base, heldItem: 137 }, "HG").fields.heldItem, 0, "mail");
  assert.equal(P.prepareForBox({ ...base, heldItem: 466 }, "D").fields.heldItem, 0, "Pt-only item in DP");
  const used = P.prepareForBox({ ...base, pp: [1, 0, 2, 0], flags: 3, walkingMood: -5 }, "HG").fields;
  assert.deepEqual([used.pp, used.flags, used.walkingMood], [base.pp, 0, 0]);
  assert.throws(() => P.prepareForBox({ ...base, version: 21 }, "Pt"), /Generation 5/);
  assert.throws(() => P.prepareForBox({ ...base, checksumOk: false }, "Pt"), /Bad Egg/);
  assert.throws(() => P.prepareForBox(base, "E"), FormatError);
  const arceus = P.prepareForBox({ ...base, species: 493, ability: 121, form: 0, heldItem: 298 }, "Pt").fields;
  assert.equal(arceus.form, 10, "Flame Plate -> Fire");
});

test("ribbon names cover the three ribbon fields", () => {
  const f = { ribbonsSinnoh: 0b111 | (1 << 14), ribbonsHoenn: (1 << 20) | 1, ribbonsContest: [0b11, 0] };
  assert.deepEqual(P.ribbonNames(f), ["RibbonChampionSinnoh", "RibbonAbility", "RibbonAbilityGreat", "RibbonGorgeous",
    "RibbonG3Cool", "RibbonChampionG3", "RibbonG4Cool", "RibbonG4CoolGreat"]);
});
