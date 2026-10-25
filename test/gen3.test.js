/* Gen 3 records (shared/pkm/pk3.js) and saves (shared/saves/gen3.js) against the PKHeX fixtures
   and against synthetic flash images built here from format-gen3.md (§3, §14). The sector helpers
   below are written from the spec, not from gen3.js, so the two check each other. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pk3 from "../shared/pkm/pk3.js";
import * as gen3 from "../shared/saves/gen3.js";
import { hex, u16le, u32le, setU16le, setU32le, getFlag, FormatError } from "../shared/bytes.js";
import * as T from "../shared/text/gen3.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fromHex = (s) => Uint8Array.from(s.trim().match(/../g), (x) => parseInt(x, 16));
const readSave = (id) => new Uint8Array(fs.readFileSync(path.join(dir, "saves", id + ".sav")));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), "utf8"));
const record = (name) => fromHex(fs.readFileSync(path.join(dir, "records", name + ".hex"), "utf8"));

const SAVES = fs.readdirSync(path.join(dir, "saves")).filter((f) => f.endsWith(".sav")).map((f) => f.slice(0, -4));
const GEN3 = SAVES.filter((id) => readJson(`saves/${id}.expected.json`).generation === 3);
const FAMILY = { SAV3E: "E", SAV3FRLG: "FRLG", SAV3RS: "RS" };
const GENDER = ["M", "F", null];

/* ---------- spec-side helpers: sectors, checksums, synthetic saves ---------- */

const SIZES = {
  RS: [0x890, 0xf80, 0xf80, 0xf80, 0xc40, ...Array(8).fill(0xf80), 0x7d0],
  FRLG: [0xf24, 0xf80, 0xf80, 0xf80, 0xee8, ...Array(8).fill(0xf80), 0x7d0],
  E: [0xf2c, 0xf80, 0xf80, 0xf80, 0xf08, ...Array(8).fill(0xf80), 0x7d0],
};
const SB1 = { RS: { party: 0x234, money: 0x490, seen1: 0x938, seen2: 0x3a8c }, E: { party: 0x234, money: 0x490, seen1: 0x988, seen2: 0x3b24 },
  FRLG: { party: 0x034, money: 0x290, seen1: 0x5f8, seen2: 0x3a18 } };

function checksum(b, o, size) {
  let s = 0;
  for (let i = 0; i < size; i += 4) s = (s + u32le(b, o + i)) >>> 0;
  return ((s >>> 16) + s) & 0xffff;
}
/** File offset of the sector holding section `id` in slot 0 (A) or 1 (B). */
function sectorOf(img, slot, id) {
  for (let i = 0; i < 14; i++) {
    const o = (slot * 14 + i) * 0x1000;
    if (u32le(img, o + 0xff8) === 0x08012025 && u16le(img, o + 0xff4) === id) return o;
  }
  return -1;
}
/** Logical offset in SaveBlock1 / PC -> [section id, offset in the section]. */
const sb1At = (off) => [1 + Math.floor(off / 0xf80), off % 0xf80];
const pcAt = (off) => [5 + Math.floor(off / 0xf80), off % 0xf80];
/** Edit one section of a slot in place and fix its checksum, as a game (or a test) writing it would. */
function patch(img, slot, id, game, fn) {
  const o = sectorOf(img, slot, id);
  fn(img.subarray(o, o + 0xf80));
  setU16le(img, o + 0xff6, checksum(img, o, SIZES[game][id]));
}
/** The fixtures are "saved twice": slot A (counter 2) is the active copy. */
const ACTIVE = 0;

/** A flash image built from format-gen3.md §14.3: erased flash, then each requested slot as 14
    rotated sections with footers. `content(slot)` returns { sb2, sb1, pc } buffers to store. */
function synth(game, slots, content) {
  const img = new Uint8Array(0x20000).fill(0xff);
  for (const s of slots) {
    const { sb2, sb1, pc } = content(s);
    const chunk = (id) => (id === 0 ? sb2 : id <= 4 ? sb1.subarray((id - 1) * 0xf80) : pc.subarray((id - 5) * 0xf80));
    for (let id = 0; id < 14; id++) {
      const o = (s.slot * 14 + ((id + s.base) % 14)) * 0x1000;
      img.fill(0, o, o + 0x1000);
      img.set(chunk(id).subarray(0, SIZES[game][id]), o);
      setU16le(img, o + 0xff4, id);
      setU16le(img, o + 0xff6, checksum(img, o, SIZES[game][id]));
      setU32le(img, o + 0xff8, 0x08012025);
      setU32le(img, o + 0xffc, s.counter);
    }
  }
  return img;
}
/** Minimal, consistent contents for a game: trainer TID as a slot marker, the game's SB2 marks, an empty
    party, money 1000, the Union Room phrases (Emerald) and box names. */
function blank(game, tid, edit = () => {}) {
  const sb2 = new Uint8Array(0xf2c), sb1 = new Uint8Array(0x3d88), pc = new Uint8Array(0x83d0);
  sb2.set(T.encode("TEST", "en", 8));
  setU16le(sb2, 0x0a, tid); setU16le(sb2, 0x0c, 777);
  let key = 0;
  if (game === "E") { key = 0x12345678; setU32le(sb2, 0xac, key); sb2[0xeb8] = 1; sb1[0x3c88] = 1; }
  if (game === "FRLG") { setU32le(sb2, 0xac, 1); key = 0x0badf00d; setU32le(sb2, 0xf20, key); }
  setU32le(sb1, SB1[game].money, (1000 ^ key) >>> 0);
  for (let b = 0; b < 14; b++) pc.set(T.encode(`BOX ${b + 1}`, "en", 9), 0x8344 + 9 * b);
  edit({ sb2, sb1, pc });
  return { sb2, sb1, pc };
}

/* ---------- PK3 records ---------- */

const META = { format: "pk3", lang: "en", game: "E" };

function slotsOf(id) {
  const d = readJson(`saves/${id}.expected.json`);
  const meta = { format: "pk3", lang: d.japanese ? "ja" : "en", game: FAMILY[d.saveType] };
  return [...d.party.map((m) => ({ m, meta, where: `${id} party ${m.slot}` })), ...d.boxes.map((m) => ({ m, meta, where: `${id} box ${m.box}:${m.slot}` }))];
}

/** Our MonView against PKHeX's dump of the same Pokémon. */
function assertSameMon(v, m, where) {
  const eq = (a, b, what) => assert.deepEqual(a, b, `${where}: ${what}`);
  eq(v.species, m.species, "species"); eq(v.form, m.form, "form"); eq(v.speciesName, m.speciesName, "species name");
  eq(v.nickname, m.nickname, "nickname"); eq(v.isNicknamed, m.isNicknamed, "nicknamed"); eq(v.isEgg, m.isEgg, "egg");
  eq(v.level, m.level, "level"); eq(v.exp, m.exp, "exp");
  eq(v.moves.map((x) => [x.id, x.pp, x.ppUps]), m.moves.filter((x) => x.id).map((x) => [x.id, x.pp, x.ppUps]), "moves");
  eq(v.ivs, m.ivs, "ivs"); eq(v.evs, m.evs, "evs");
  eq(v.natureId, m.nature, "nature"); eq(v.abilityId, m.ability, "ability"); eq(v.abilityNum, m.abilityNumber, "ability slot");
  eq(v.heldItemId, m.heldItem, "item"); eq(v.heldItem, m.heldItemName, "item name");
  eq(v.gender, GENDER[m.gender], "gender"); eq(v.shiny, m.isShiny, "shiny"); eq(v.pid, m.pid, "pid");
  eq(v.ot, { ...m.ot, gender: GENDER[m.ot.gender] }, "OT");
  eq([v.met.location, v.met.level, v.ballId, v.game], [m.met.location, m.met.level, m.met.ball, m.met.versionName], "met");
  eq(v.friendship, m.friendship, "friendship"); eq(v.lang, m.languageCode, "language");
  eq(v.pokerus, m.pokerus, "pokerus"); eq(v.markings, m.markingsRaw, "markings");
  eq(v.fateful, m.fatefulEncounter, "fateful"); eq(v.contest, m.contest, "contest");
  const count = m.ribbons.reduce((s, r) => s + (r.includes("=") ? Number(r.split("=")[1]) : 1), 0);
  eq(v.ribbons.length, count, "ribbon count");
  eq(v.checksumOk, m.checksumValid, "checksum");
  if (m.partyStats) {
    const p = m.partyStats;
    eq(v.stats, { hp: p.hpMax, atk: p.atk, def: p.def, spa: p.spa, spd: p.spd, spe: p.spe }, "party stats");
  }
}

test("pk3: constants and record size", () => {
  assert.equal(pk3.FORMAT, "pk3");
  assert.equal(pk3.GEN, 3);
  assert.equal(pk3.RECORD_SIZE, 80);
  for (const l of ["en", "ja", "de"]) assert.equal(pk3.recordSize(l), 80);
});

test("pk3: build(parse(r)) is byte-exact and the view matches PKHeX for every fixture slot", () => {
  let n = 0;
  for (const id of GEN3) {
    for (const { m, meta, where } of slotsOf(id)) {
      const stored = fromHex(m.storedHex), rec = fromHex(m.recordHex);
      const f = pk3.parse(stored, meta);
      assert.equal(hex(pk3.build(JSON.parse(JSON.stringify(f)), meta)), m.storedHex, where + " stored round trip (JSON-safe fields)");
      assert.equal(hex(pk3.build(pk3.parse(rec, meta), meta)), m.recordHex, where + " record round trip");
      assert.equal(hex(rec), m.storedHex.slice(0, 160), where + " record = first 80 stored bytes");
      assertSameMon(pk3.toView(f, meta), m, where);
      const v = pk3.validate(rec, meta);
      assert.ok(v.ok, `${where}: ${v.errors}`);
      n++;
    }
  }
  assert.ok(n >= 120, `covered ${n} slots`);
});

test("pk3: record fixtures (PKHeX pkm parses) round-trip and match", () => {
  for (const f of fs.readdirSync(path.join(dir, "records")).filter((x) => x.startsWith("pk3-") && x.endsWith(".hex"))) {
    const name = f.slice(0, -4), rec = record(name), j = readJson(`records/${name}.json`);
    assert.equal(hex(pk3.build(pk3.parse(rec, META), META)), hex(rec), name);
    if (name === "pk3-empty") {
      assert.deepEqual(pk3.validate(rec, META), { ok: false, errors: ["This slot is empty."], warnings: [] });
      continue;
    }
    assertSameMon(pk3.toView(pk3.parse(rec, META), META), j.pkm, name);
    assert.ok(pk3.validate(rec, META).ok, name);
  }
});

test("pk3: format-gen3.md §14.1 vectors decode to the documented fields", () => {
  const v1 = pk3.parse(record("pk3-docvec-1"), META);
  assert.equal(v1.pid, 0xdeadbeef);
  assert.deepEqual(v1.otId, { tid: 4660, sid: 48879 });
  assert.equal(v1.growth.species, 283); assert.equal(v1.derived.species, 258);
  assert.equal(v1.growth.heldItem, 200); assert.equal(v1.growth.exp, 135);
  assert.equal(v1.growth.ppBonuses, 0x1b); assert.equal(v1.growth.friendship, 70);
  assert.equal(v1.derived.nickname, "MUDKIP"); assert.equal(v1.derived.otName, "SAM");
  assert.equal(v1.language, 2); assert.equal(v1.markings, 5); assert.equal(v1.checksum, 0x4930);
  assert.deepEqual(v1.attacks, { moves: [33, 45, 0, 0], pp: [35, 40, 0, 0] });
  assert.deepEqual(v1.condition.evs, { hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 });
  assert.equal(v1.condition.contest.cool, 7); assert.equal(v1.condition.contest.sheen, 8);
  assert.equal(v1.misc.pokerus, 0x21);
  assert.deepEqual([v1.misc.metLocation, v1.misc.metLevel, v1.misc.metGame, v1.misc.ball, v1.misc.otGender], [16, 5, 3, 4, 1]);
  assert.deepEqual(v1.misc.ivs, { hp: 31, atk: 1, def: 2, spe: 3, spa: 4, spd: 5 });
  assert.equal(v1.misc.abilityNum, 1); assert.equal(v1.misc.isEgg, false);
  assert.equal(v1.misc.ribbons.cool, 4); assert.equal(v1.misc.ribbons.champion, true); assert.equal(v1.misc.fatefulEncounter, true);
  const view1 = pk3.toView(v1, META);
  assert.deepEqual(view1.ribbons, ["Cool Ribbon", "Cool Ribbon Super", "Cool Ribbon Hyper", "Cool Ribbon Master", "Champion Ribbon"]);
  assert.equal(view1.heldItem, "Leftovers");

  const v2 = pk3.toView(pk3.parse(record("pk3-docvec-2-shiny"), META), META);
  assert.equal(v2.shiny, true); assert.equal(v2.nature, "Gentle"); assert.equal(v2.pid, 0xf6825a5a);

  const v3 = pk3.parse(record("pk3-docvec-3-egg"), META);
  assert.equal(v3.language, 1); assert.equal(v3.derived.nickname, "タマゴ");
  assert.deepEqual(v3.flags, { badEgg: false, hasSpecies: true, useEggName: true, blockBoxRS: false, unused: 0 });
  assert.equal(v3.misc.isEgg, true); assert.equal(v3.checksum, 0x4663);
  assert.equal(pk3.toView(v3, META).isEgg, true);
});

test("pk3: build from hand-written fields reproduces the §14.1 cipher text", () => {
  const fields = {
    pid: 0xdeadbeef, otId: { tid: 0x1234, sid: 0xbeef },
    nickname: [0xc7, 0xcf, 0xbe, 0xc5, 0xc3, 0xca, 0xff, 0, 0, 0], language: 2,
    flags: { hasSpecies: true }, otName: [0xcd, 0xbb, 0xc7, 0xff, 0, 0, 0], markings: 5,
    growth: { species: 283, heldItem: 200, exp: 135, ppBonuses: 0x1b, friendship: 70 },
    attacks: { moves: [33, 45], pp: [35, 40] },
    condition: { evs: { hp: 1, atk: 2, def: 3, spe: 4, spa: 5, spd: 6 }, contest: { cool: 7, sheen: 8 } },
    misc: { pokerus: 0x21, metLocation: 16, metLevel: 5, metGame: 3, ball: 4, otGender: 1,
      ivs: { hp: 31, atk: 1, def: 2, spe: 3, spa: 4, spd: 5 }, abilityNum: 1, ribbons: { cool: 4, champion: true }, fatefulEncounter: true },
  };
  assert.equal(hex(pk3.build(fields, META)), hex(record("pk3-docvec-1")));
  // Names may also be given as strings; they are encoded in the record's language and 0xFF-padded.
  const named = pk3.parse(pk3.build({ ...fields, nickname: "MUDDY", otName: "MAY" }, META), META);
  assert.equal(named.derived.nickname, "MUDDY");
  assert.deepEqual(named.nickname, [...T.encode("MUDDY", "en", 10)]);
  assert.equal(named.derived.checksumOk, true);
});

test("pk3: parse never changes the caller's bytes (Buffer input)", () => {
  const buf = Buffer.from(record("pk3-treecko-leafy"));
  const before = hex(buf);
  pk3.parse(buf, META);
  pk3.validate(buf, META);
  assert.equal(hex(buf), before);
});

test("pk3: party struct (100 bytes) keeps its stats and round-trips", () => {
  const d = readJson("saves/emerald-en.expected.json");
  for (const m of d.party) {
    const f = pk3.parse(fromHex(m.storedHex), META);
    assert.equal(f.party.level, m.partyStats.level);
    assert.equal(f.party.mail, 0xff);
    assert.equal(hex(pk3.build(f, META)).length, 200);
  }
});

test("pk3: validate catches damaged and impossible records", () => {
  const good = record("pk3-treecko-leafy");
  for (let bit = 0x20 * 8; bit < 0x50 * 8; bit += 37) {
    const bad = good.slice(); bad[bit >> 3] ^= 1 << (bit & 7);
    const v = pk3.validate(bad, META);
    assert.equal(v.ok, false); assert.match(v.errors[0], /Bad Egg/);
  }
  const edit = (fn) => { const f = pk3.parse(good, META); fn(f); return pk3.validate(pk3.build(f, META), META); };
  assert.match(edit((f) => { f.flags.badEgg = true; }).errors.join(), /flagged/);
  assert.match(edit((f) => { f.growth.species = 260; }).errors.join(), /does not exist/);    // an "old Unown" dummy slot
  assert.match(edit((f) => { f.growth.species = 412; }).errors.join(), /does not exist/);    // the Egg placeholder
  assert.match(edit((f) => { f.misc.isEgg = true; }).errors.join(), /Egg flags/);
  assert.match(edit((f) => { f.flags.hasSpecies = false; }).errors.join(), /species flag/);
  assert.match(edit((f) => { f.attacks.moves = [0, 0, 0, 0]; }).errors.join(), /no moves/);
  assert.match(edit((f) => { f.attacks.moves[1] = 355; }).errors.join(), /Move 355/);
  assert.match(edit((f) => { f.growth.heldItem = 52; }).errors.join(), /Held item 52/);       // unnamed placeholder id
  assert.match(edit((f) => { f.growth.heldItem = 377; }).errors.join(), /Held item 377/);
  assert.match(edit((f) => { f.growth.exp = 2_000_000; }).errors.join(), /EXP/);
  const rsItem = pk3.parse(good, META); rsItem.growth.heldItem = 375;                          // Magma Emblem: Emerald only
  assert.match(pk3.validate(pk3.build(rsItem, META), { ...META, game: "RS" }).warnings.join(), /does not exist in Ruby/);
  assert.equal(pk3.validate(new Uint8Array(81), META).ok, false);
});

test("pk3: Deoxys takes the cartridge's form, Unown the PID's letter", () => {
  const f = pk3.parse(record("pk3-treecko-leafy"), META);
  f.growth.species = 410;                                            // Deoxys' internal index
  const r = pk3.build(f, META), p = pk3.parse(r, META);
  assert.equal(pk3.toView(p, { ...META, game: "E" }).formName, "Speed Forme");
  assert.equal(pk3.toView(p, { ...META, game: "FR" }).formName, "Attack Forme");
  assert.equal(pk3.toView(p, { ...META, game: "LG" }).form, 2);
  assert.equal(pk3.toView(p, { ...META, game: "RS" }).form, 0);
  const unk = pk3.toView(p, { ...META, game: "FRLG" });
  assert.equal(unk.form, 0); assert.match(unk.warnings.join(), /Deoxys/);
});

/* ---------- saves: fixtures ---------- */

test("gen3 fixtures: detect gives the game and language", () => {
  assert.deepEqual(GEN3.sort(), ["emerald-en", "emerald-en.modified", "firered-en", "ruby-en", "ruby-ja"]);
  for (const id of GEN3) {
    const d = readJson(`saves/${id}.expected.json`), det = gen3.detect(readSave(id));
    assert.ok(det, id);
    assert.equal(det.game, FAMILY[d.saveType], id);
    assert.equal(det.lang, d.japanese ? "ja" : "en", id);
    assert.ok(det.confidence >= 0.9, id);
  }
});

test("gen3 fixtures: trainer, party, every box slot, names, current box and Pokédex match PKHeX", () => {
  for (const id of GEN3) {
    const d = readJson(`saves/${id}.expected.json`), img = readSave(id);
    const s = gen3.open(img, gen3.detect(img));
    assert.equal(s.gen, 3); assert.equal(s.format, "pk3"); assert.equal(s.readOnly, null, id); assert.equal(s.restricted, null, id);
    assert.deepEqual(s.warnings, [], id);
    assert.deepEqual(s.trainer, { ...d.trainer, gender: GENDER[d.trainer.gender] }, id);
    assert.equal(s.boxCount, d.boxCount); assert.equal(s.boxCapacity, d.boxSlotCount); assert.equal(s.currentBox, d.currentBox);
    assert.deepEqual(Array.from({ length: 14 }, (_, i) => s.boxName(i)), d.boxNames, id);
    const party = s.party();
    assert.equal(party.length, d.partyCount, id);
    party.forEach((p, i) => {
      assert.equal(hex(p.record), d.party[i].recordHex, `${id} party ${i}`);
      assert.deepEqual(p.meta, { format: "pk3", lang: s.lang, game: s.version ?? s.game });
      assertSameMon(p.view, d.party[i], `${id} party ${i}`);
    });
    let used = 0;
    for (let b = 0; b < 14; b++) {
      const box = s.box(b);
      assert.equal(box.length, 30);
      box.forEach((m, k) => {
        const e = d.boxes.find((x) => x.box === b && x.slot === k);
        if (!e) return assert.equal(m, null, `${id} box ${b}:${k} should be empty`);
        used++;
        assert.equal(hex(m.record), e.recordHex, `${id} box ${b}:${k}`);
        assertSameMon(m.view, e, `${id} box ${b}:${k}`);
      });
    }
    assert.equal(used, d.boxSlotsUsed, id);
    assert.deepEqual(s.pokedex(), d.pokedex, id);
  }
});

test("gen3 fixtures: Ruby/FireRed version guess comes from the player's own Pokémon", () => {
  const v = (id) => gen3.open(readSave(id));
  assert.equal(v("ruby-en").version, "R"); assert.equal(v("ruby-ja").version, "R");
  assert.equal(v("firered-en").version, "FR"); assert.equal(v("emerald-en").version, "E");
  const s = v("firered-en");
  s.setVersion("LG"); assert.equal(s.party()[0].meta.game, "LG");
  s.setVersion("FRLG"); assert.equal(s.version, null); assert.equal(s.party()[0].meta.game, "FRLG");
  assert.throws(() => s.setVersion("E"), FormatError);
});

test("gen3 fixtures: serialize() of an untouched save is the original image", () => {
  for (const id of GEN3) {
    const img = readSave(id);
    assert.equal(hex(gen3.open(img).serialize()), hex(img), id);
  }
});

test("gen3 fixtures: opening never changes the caller's bytes", () => {
  const img = Buffer.from(readSave("emerald-en")), before = hex(img);
  const s = gen3.open(img);
  s.takeFromBox(0, 7);
  s.serialize();
  assert.equal(hex(img), before);
});

/** The Emerald modified fixture: PKHeX cleared box 1 slot 8, took party slot 1, put a Ruby record into
    box 3 slot 6 and appended a record to the party (no such operation here: records only go to boxes). */
test("gen3 emerald: take/put reproduce PKHeX's modified save", () => {
  const img = readSave("emerald-en"), want = readSave("emerald-en.modified");
  const exp = readJson("saves/emerald-en.modified.expected.json");
  const s = gen3.open(img);
  const kyogre = s.takeFromBox(0, 7), mudkip = s.takeFromParty(0);
  assert.equal(hex(kyogre.record), readJson("saves/emerald-en.expected.json").boxes.find((b) => b.box === 0 && b.slot === 7).recordHex);
  assert.equal(hex(mudkip.record), readJson("saves/emerald-en.expected.json").party[0].recordHex);
  assert.deepEqual(kyogre.meta, { format: "pk3", lang: "en", game: "E" });
  assert.deepEqual(s.putInBox(record("pk3-treecko-leafy"), { format: "pk3", lang: "en", game: "RS" }, 2, 5), { box: 2, index: 5 });
  const out = s.serialize();

  const again = gen3.open(out);
  for (let b = 0; b < 14; b++) again.box(b).forEach((m, k) => {
    const e = exp.boxes.find((x) => x.box === b && x.slot === k);
    assert.equal(m ? hex(m.record) : null, e ? e.recordHex : null, `box ${b}:${k}`);
  });
  assert.deepEqual(again.party().map((p) => hex(p.record)), exp.party.slice(0, 2).map((p) => p.recordHex));
  assert.deepEqual(again.pokedex(), exp.pokedex);

  // Byte level: identical to PKHeX's file except the party slot PKHeX filled and the count, plus that
  // sector's checksum. The vacated slot is the game's ZeroMonData (zeros, mail byte 0xFF).
  const party = sectorOf(out, ACTIVE, 1);
  const allowed = (i) => i === party + 0x234 || (i >= party + 0x238 + 200 && i < party + 0x238 + 300) || i === party + 0xff6 || i === party + 0xff7;
  for (let i = 0; i < out.length; i++) if (out[i] !== want[i]) assert.ok(allowed(i), `unexpected difference at 0x${i.toString(16)}`);
  const vacated = out.subarray(party + 0x238 + 200, party + 0x238 + 300);
  assert.ok(vacated.every((x, i) => (i === 0x55 ? x === 0xff : x === 0)));
  assert.equal(out[party + 0x234], 2);
});

test("gen3: take -> put restores the Pokémon (box and party), byte for byte in the box case", () => {
  for (const id of GEN3) {
    const img = readSave(id), s = gen3.open(img), d = readJson(`saves/${id}.expected.json`);
    const e = d.boxes[d.boxes.length - 1];                          // box 14 slot 30 in every fixture
    const t = s.takeFromBox(e.box, e.slot);
    assert.equal(s.box(e.box)[e.slot], null);
    assert.deepEqual(s.putInBox(t.record, t.meta, e.box, e.slot), { box: e.box, index: e.slot });
    assert.equal(hex(s.serialize()), hex(img), id + " box round trip");

    const p = s.takeFromParty(1);
    const at = s.putInBox(p.record, p.meta);
    const back = gen3.open(s.serialize());
    assert.equal(hex(back.box(at.box)[at.index].record), d.party[1].recordHex, id + " party -> box");
    assert.equal(back.party().length, d.partyCount - 1);
    assert.equal(hex(back.party()[1].record), d.party[2].recordHex, id + " later members shift down");
  }
});

test("gen3: putInBox picks the first free slot from the current box on, and refuses what the game cannot hold", () => {
  const s = gen3.open(readSave("ruby-en"));
  const rec = record("pk3-treecko-leafy"), meta = { format: "pk3", lang: "en", game: "RS" };
  assert.deepEqual(s.putInBox(rec, meta), { box: 0, index: 1 });           // box 1 slot 0 holds the egg
  assert.deepEqual(s.putInBox(rec, meta, 1), { box: 1, index: 24 });       // box 2 holds 24 Pokémon in slots 0-23
  assert.throws(() => s.putInBox(rec, meta, 0, 0), /not empty/);
  assert.throws(() => s.putInBox(rec, { format: "pk4" }), /converted/);
  assert.throws(() => s.putInBox(rec.subarray(0, 79), meta), /80 bytes/);
  assert.throws(() => s.putInBox(record("pk3-empty"), meta), /empty/);
  const bad = rec.slice(); bad[0x30] ^= 1;
  assert.throws(() => s.putInBox(bad, meta), /Bad Egg/);
  const withItem = (item) => { const f = pk3.parse(rec, meta); f.growth.heldItem = item; return pk3.build(f, meta); };
  assert.throws(() => s.putInBox(withItem(121), meta), /Mail/);
  assert.throws(() => s.putInBox(withItem(350), meta), /does not exist in Ruby\/Sapphire/);    // a FRLG key item
  assert.deepEqual(gen3.open(readSave("emerald-en")).putInBox(withItem(350), meta, 5, 5), { box: 5, index: 5 });
  // Wrap-around from the current box, and a full PC.
  const full = gen3.open(readSave("firered-en"));
  let n = 0;
  for (;;) { try { full.putInBox(rec, meta); n++; } catch (e) { assert.match(e.message, /All boxes in the PC are full/); break; } }
  assert.equal(n, 420 - 30);
});

test("gen3: a box edit rewrites only the changed sectors of the active slot, even across sector boundaries", () => {
  // Global slots 49 and 396 straddle sections 5/6 and 12/13 (format-gen3.md §7).
  const img = readSave("emerald-en"), s = gen3.open(img);
  const rec = record("pk3-mew-fateful");
  const taken = s.takeFromBox(1, 19);                              // box 2 position 20: 44 bytes in section 5, 36 in 6
  s.putInBox(rec, META, 13, 6);                                    // box 14 position 7: 60 bytes in section 12, 20 in 13
  const out = s.serialize();
  const off = (g) => 4 + g * 80;
  const touched = new Set();
  for (const g of [49, 396]) for (let i = 0; i < 80; i++) {
    const [id, at] = pcAt(off(g) + i);
    touched.add(sectorOf(img, ACTIVE, id) + at);
  }
  const sums = [5, 6, 12, 13].flatMap((id) => [sectorOf(img, ACTIVE, id) + 0xff6, sectorOf(img, ACTIVE, id) + 0xff7]);
  sums.forEach((o) => touched.add(o));
  for (let i = 0; i < out.length; i++) if (out[i] !== img[i]) assert.ok(touched.has(i), `0x${i.toString(16)} changed`);
  for (const id of [5, 6, 12, 13]) {
    const o = sectorOf(out, ACTIVE, id);
    assert.equal(u16le(out, o + 0xff6), checksum(out, o, SIZES.E[id]), `section ${id} checksum`);
  }
  const back = gen3.open(out);
  assert.equal(back.box(1)[19], null);
  assert.equal(hex(taken.record), readJson("saves/emerald-en.expected.json").boxes.find((b) => b.box === 1 && b.slot === 19).recordHex);
  assert.equal(hex(back.box(13)[6].record), hex(rec));
  const z = sectorOf(out, ACTIVE, 5) + ((4 + 49 * 80) % 0xf80);
  assert.ok(out.subarray(z, z + 44).every((x) => x === 0) && out.subarray(sectorOf(out, ACTIVE, 6), sectorOf(out, ACTIVE, 6) + 36).every((x) => x === 0));
  // The other slot and sectors 28-31 are untouched.
  assert.equal(hex(out.subarray(0xe000)), hex(img.subarray(0xe000)));
});

test("gen3: registerDex sets seen in all three copies and caught, and the first Unown/Spinda PID", () => {
  for (const [id, game] of [["emerald-en", "E"], ["firered-en", "FRLG"], ["ruby-en", "RS"]]) {
    const s = gen3.open(readSave(id));
    assert.ok(!s.pokedex().caught.includes(327));
    assert.equal(s.registerDex(327, { pid: 0x12345678 }), true);
    assert.equal(s.registerDex(252), true);
    const out = s.serialize(), back = gen3.open(out);
    assert.ok(back.pokedex().caught.includes(327) && back.pokedex().caught.includes(252));
    const sb2 = sectorOf(out, ACTIVE, 0);
    const flag = (o, bit) => getFlag(out, o, bit);
    for (const sp of [252, 327]) {
      assert.equal(flag(sb2 + 0x28, sp - 1), 1); assert.equal(flag(sb2 + 0x5c, sp - 1), 1);
      for (const o of [SB1[game].seen1, SB1[game].seen2]) {
        const [sec, at] = sb1At(o + ((sp - 1) >> 3));
        assert.equal((out[sectorOf(out, ACTIVE, sec) + at] >> ((sp - 1) & 7)) & 1, 1, `${id} seen copy ${o.toString(16)}`);
      }
    }
    assert.equal(u32le(out, sb2 + 0x20), 0x12345678, id + " Spinda PID");
    // Already caught: the PID stays. Only bits 0-385 exist.
    s.registerDex(327, { pid: 1 });
    assert.equal(u32le(s.serialize(), sb2 + 0x20), 0x12345678);
    assert.throws(() => s.registerDex(387), FormatError);
    assert.throws(() => s.registerDex(0), FormatError);
  }
  // Emerald's fixture registered Unown already (PKHeX stored its PID): a second Unown leaves it.
  const e = gen3.open(readSave("emerald-en")), img = readSave("emerald-en");
  const before = u32le(img, sectorOf(img, ACTIVE, 0) + 0x1c);
  e.registerDex(201, { pid: 99 });
  assert.equal(u32le(e.serialize(), sectorOf(img, ACTIVE, 0) + 0x1c), before);
});

test("gen3: registerDex leaves a Pokédex whose seen copies disagree alone", () => {
  const img = readSave("ruby-en");
  const [id, at] = sb1At(SB1.RS.seen2);
  patch(img, ACTIVE, id, "RS", (sec) => { sec[at] ^= 0x01; });   // Bulbasaur seen in one copy only
  const s = gen3.open(img);
  assert.equal(s.registerDex(25), false);
  assert.match(s.warnings.join(), /Pokédex was not updated/);
  assert.equal(hex(s.serialize()), hex(img));
});

test("gen3: party guards (last able Pokémon, mail, Battle Frontier, Battle Tower)", () => {
  const s = gen3.open(readSave("emerald-en"));
  s.takeFromParty(0); s.takeFromParty(0);
  assert.throws(() => s.takeFromParty(0), /leave no Pokémon/);
  assert.throws(() => s.takeFromParty(3), /no Pokémon in party slot 4/);

  const mail = readSave("firered-en");
  patch(mail, ACTIVE, 1, "FRLG", (sec) => { sec[SB1.FRLG.party + 4 + 0x55] = 0; });
  assert.throws(() => gen3.open(mail).takeFromParty(0), /Mail/);

  const frontier = readSave("emerald-en");
  patch(frontier, ACTIVE, 0, "E", (sec) => { sec[0xca8] = 2; });
  const f = gen3.open(frontier);
  assert.throws(() => f.takeFromParty(0), /Battle Frontier/);
  f.takeFromBox(0, 7);                                            // boxes stay editable

  for (const state of [1, 2, 4, 5]) {
    const tower = readSave("ruby-en");
    patch(tower, ACTIVE, 0, "RS", (sec) => { sec[0x557] = state; });
    assert.throws(() => gen3.open(tower).takeFromParty(0), /Battle Tower/);
  }
  const done = readSave("ruby-en");
  patch(done, ACTIVE, 0, "RS", (sec) => { sec[0x556] = 3; });     // a finished challenge
  gen3.open(done).takeFromParty(0);
});

test("gen3: takeFromBox refuses empty slots and Bad Eggs", () => {
  const img = readSave("emerald-en");
  const s = gen3.open(img);
  assert.throws(() => s.takeFromBox(0, 1), /empty/);
  assert.throws(() => s.takeFromBox(14, 0), /no box 15/);
  assert.throws(() => s.takeFromBox(0, 30), /no slot 31/);
  const [id, at] = pcAt(4 + 7 * 80 + 0x30);
  patch(img, ACTIVE, id, "E", (sec) => { sec[at] ^= 0x10; });
  const b = gen3.open(img);
  assert.equal(b.box(0)[7].view.checksumOk, false);
  assert.equal(b.box(0)[7].view.isEgg, true);
  assert.throws(() => b.takeFromBox(0, 7), /damaged/);
});

/* ---------- saves: slot selection and synthetic layouts (§3.5, §14.3) ---------- */

test("gen3: section checksum vectors (§14.2)", () => {
  const buf = Uint8Array.from({ length: 0xf80 }, (_, i) => (i * 7 + 3) & 0xff);
  const want = { 0xf80: 0x1ff0, 0x890: 0xbcb2, 0x7d0: 0x6b1a, 0xf2c: 0xc9ca, 0xf24: 0x5c7a, 0xc40: 0x7008, 0xee8: 0x05fd, 0xf08: 0xbe42 };
  for (const [size, sum] of Object.entries(want)) assert.equal(gen3.sectionChecksum(buf, 0, Number(size)), sum, size);
});

test("gen3: slot selection matrix as the game loads it", () => {
  const A = (counter, base = 0) => ({ slot: 0, counter, base }), B = (counter, base = 1) => ({ slot: 1, counter, base });
  const make = (slots, edit) => {
    const img = synth("E", slots, (s) => blank("E", s.slot === 0 ? 100 : 200));
    if (edit) edit(img);
    return img;
  };
  const loads = (img) => { const s = gen3.open(img); return [s.trainer.tid === 100 ? "A" : "B", s.readOnly ? "ro" : "rw"]; };
  assert.deepEqual(loads(make([B(1)])), ["B", "rw"], "first save");
  assert.deepEqual(loads(make([B(5), A(6)])), ["A", "rw"], "normal");
  assert.deepEqual(loads(make([A(7), B(7)])), ["B", "rw"], "tie, odd counter");
  assert.deepEqual(loads(make([A(8), B(8)])), ["A", "rw"], "tie, even counter");
  assert.deepEqual(loads(make([A(5), B(4)])), ["B", "ro"], "parity mismatch: the game loads the older data");
  assert.deepEqual(loads(make([B(0xffffffff), A(0)])), ["A", "rw"], "counter wrap");
  const corrupt = make([B(5), A(6)], (img) => { img[sectorOf(img, 0, 0) + 0x40] ^= 1; });
  assert.deepEqual(loads(corrupt), ["B", "ro"], "newest slot damaged");
  assert.match(gen3.open(corrupt).warnings.join(), /previous save/);
  const padding = make([B(5), A(6)], (img) => { img[sectorOf(img, 0, 0) + 0xf30] = 0x55; });
  assert.deepEqual(loads(padding), ["A", "rw"], "non-zero padding is outside the checksum");
  const badId = make([B(5), A(6)], (img) => { setU16le(img, sectorOf(img, 0, 3) + 0xff4, 14); });
  assert.deepEqual(loads(badId), ["B", "ro"], "a footer id >= 14 makes the slot incomplete");
  // Every rotation base and both slot parities read the same contents and write back in place.
  for (let base = 0; base < 14; base++) for (const counter of [9, 10]) {
    const img = synth("E", [{ slot: counter % 2, counter, base }], () => blank("E", 300));
    const s = gen3.open(img);
    assert.equal(s.trainer.tid, 300);
    s.putInBox(record("pk3-groudon-ribbons"), META, 3, 9);
    const back = gen3.open(s.serialize());
    assert.equal(hex(back.box(3)[9].record), hex(record("pk3-groudon-ribbons")), `base ${base} counter ${counter}`);
  }
});

test("gen3: empty and corrupt flash", () => {
  const erased = new Uint8Array(0x20000).fill(0xff);
  assert.equal(gen3.detect(erased), null);
  assert.throws(() => gen3.open(erased, { game: "E", lang: "en" }), /no saved game/);
  const both = synth("E", [{ slot: 0, counter: 2, base: 0 }, { slot: 1, counter: 1, base: 1 }], () => blank("E", 1));
  for (const slot of [0, 1]) both[sectorOf(both, slot, 2) + 8] ^= 1;
  assert.equal(gen3.detect(both), null);
  assert.throws(() => gen3.open(both, { game: "E", lang: "en" }), /erase it as corrupted/);
});

test("gen3: RS / FRLG / E detection on synthetic saves, and conflicting marks stay read-only", () => {
  const one = (game, edit) => synth(game, [{ slot: 0, counter: 2, base: 3 }], () => blank(game, 5, edit));
  for (const game of ["RS", "FRLG", "E"]) {
    const det = gen3.detect(one(game));
    assert.equal(det.game, game); assert.equal(det.lang, "en");
    const s = gen3.open(one(game));
    assert.equal(s.readOnly, null, game); assert.equal(s.trainer.money, 1000, game);
  }
  // Emerald sizes with FireRed's 0xAC mark: no game fits every check.
  const odd = one("E", ({ sb2 }) => { setU32le(sb2, 0xac, 1); sb2[0xf28] = 1; });
  const det = gen3.detect(odd);
  assert.equal(det.game, "E"); assert.ok(det.confidence < 0.5);
  const s = gen3.open(odd, det);
  assert.match(s.readOnly, /does not look like a normal Emerald save/);
  assert.throws(() => s.takeFromBox(0, 0), FormatError);
  assert.throws(() => s.registerDex(1), FormatError);
  // A game forced against the evidence is read-only too (Emerald read with FireRed's layout).
  assert.match(gen3.open(readSave("emerald-en"), { game: "FRLG", lang: "en" }).readOnly, /FireRed\/LeafGreen/);
});

test("gen3: Japanese layout detection uses the player name buffer", () => {
  const img = synth("RS", [{ slot: 0, counter: 2, base: 0 }], () => blank("RS", 5, ({ sb2 }) => {
    sb2.fill(0, 0, 8); sb2.set(T.encode("ハルカ", "ja", 6)); sb2[6] = 0; sb2[7] = 0;
  }));
  const det = gen3.detect(img);
  assert.equal(det.lang, "ja");
  assert.equal(gen3.open(img, det).trainer.name, "ハルカ");
});

test("gen3: a 64 KiB half image reads slot A but stays read-only", () => {
  const half = readSave("emerald-en").subarray(0, 0x10000);
  const det = gen3.detect(half);
  assert.equal(det.game, "E");
  const s = gen3.open(half, det);
  assert.match(s.readOnly, /64 KiB/);
  assert.equal(s.party().length, 3);
  assert.throws(() => s.takeFromBox(0, 0), /64 KiB/);
  assert.throws(() => s.putInBox(record("pk3-mew-fateful"), META), /64 KiB/);
  assert.equal(hex(s.serialize()), hex(half));
  assert.match(gen3.open(readSave("emerald-en"), { ...det, readOnly: "Container says no." }).readOnly, /Container says no/);
});

test("gen3: old 64-bit pokeemerald PC-port layout is restricted to box edits", () => {
  // Port saves keep SaveBlock1 at the GBA offsets only below 0xC70: the Union Room phrases and the second
  // seen copy are not where a GBA save has them. The fixture already lacks the phrases (PKHeX does not set
  // them); clearing the second seen copy makes it look like such a port save.
  const img = readSave("emerald-en");
  for (let i = 0; i < 52; i++) {
    const [id, at] = sb1At(SB1.E.seen2 + i);
    patch(img, ACTIVE, id, "E", (sec) => { sec[at] = 0; });
  }
  const s = gen3.open(img);
  assert.match(s.restricted, /PC port/);
  assert.equal(s.readOnly, null);
  assert.equal(s.registerDex(252), false);
  const t = s.takeFromBox(0, 7);
  s.putInBox(t.record, t.meta, 5, 5);
  s.takeFromParty(2);                                              // the party sits below 0xC70
  const out = s.serialize();
  for (const id of [2, 3, 4]) {
    const o = sectorOf(img, ACTIVE, id);
    assert.equal(hex(out.subarray(o, o + 0x1000)), hex(img.subarray(o, o + 0x1000)), `section ${id} untouched`);
  }
  assert.equal(hex(gen3.open(out).box(5)[5].record), hex(t.record));
  // The fixture as PKHeX wrote it (consistent, non-empty Pokédex at the GBA offsets) is not restricted.
  assert.equal(gen3.open(readSave("emerald-en")).restricted, null);
  // A save with the Union Room phrases present is never suspected.
  const real = synth("E", [{ slot: 0, counter: 2, base: 0 }], () => blank("E", 5));
  assert.equal(gen3.open(real).restricted, null);
});

test("gen3: detection does not misfire on other generations or junk", () => {
  for (const id of SAVES.filter((x) => !GEN3.includes(x))) assert.equal(gen3.detect(readSave(id)), null, id);
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  for (const len of [0, 1, 0x1000, 0x8000, 0x10000, 0x1ffff, 0x20000, 0x20010, 0x80000]) {
    for (const fill of [0x00, 0xff, -1]) {
      const b = new Uint8Array(len);
      if (fill >= 0) b.fill(fill); else for (let i = 0; i < len; i++) b[i] = rnd();
      assert.equal(gen3.detect(b), null, `${len} ${fill}`);
    }
  }
  // Signatures alone (zeroed data, wrong checksums) are not a save.
  const sig = new Uint8Array(0x20000);
  for (let s = 0; s < 28; s++) { setU32le(sig, s * 0x1000 + 0xff8, 0x08012025); setU16le(sig, s * 0x1000 + 0xff4, s % 14); setU16le(sig, s * 0x1000 + 0xff6, 0x1234); }
  assert.equal(gen3.detect(sig), null);
  // Damaged real saves: detect returns null or a result, never throws.
  const img = readSave("firered-en");
  for (let k = 0; k < 40; k++) {
    const b = img.slice();
    for (let j = 0; j < 64; j++) b[(rnd() << 9 | rnd()) % b.length] = rnd();
    gen3.detect(b);
  }
  assert.equal(gen3.detect(undefined), null);
  assert.equal(gen3.detect("not bytes"), null);
  assert.throws(() => gen3.open(new Uint8Array(0x8000)), FormatError);
});

test("gen3: an egg PKHeX made keeps the game's bytes (Japanese name, international OT)", () => {
  const s = gen3.open(readSave("emerald-en"));
  const egg = s.box(0)[0];
  assert.equal(egg.view.isEgg, true);
  assert.equal(egg.view.nickname, "タマゴ");
  const f = pk3.parse(egg.record, egg.meta);
  assert.equal(f.language, 1);
  assert.equal(T.decode(f.otName, "en"), "BRENDAN");
  assert.equal(egg.view.ot.name, "ＢＲＥＮＤＡＮ");                       // drawn with the Japanese font, as PKHeX and the game do
});
