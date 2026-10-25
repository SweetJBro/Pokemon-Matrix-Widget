/* Gen 1/2 records (pk1, pk2) and saves (saves/gen1.js, saves/gen2.js), tested against the
   PKHeX-derived fixtures in test/fixtures (no .NET needed). test/gen12-oracle.test.js re-checks
   written saves with the oracle itself when it is built. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pk1 from "../shared/pkm/pk1.js";
import * as pk2 from "../shared/pkm/pk2.js";
import * as gbl from "../shared/pkm/gblist.js";
import * as gen1 from "../shared/saves/gen1.js";
import * as gen2 from "../shared/saves/gen2.js";
import { hex, u16le, setU16le, FormatError } from "../shared/bytes.js";
import { nationalToGen1 } from "../shared/data/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fromHex = (s) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const load = (id) => new Uint8Array(fs.readFileSync(path.join(FIX, "saves", id + ".sav")));
const expected = (id) => JSON.parse(fs.readFileSync(path.join(FIX, "saves", id + ".expected.json"), "utf8"));
const record = (name) => fromHex(fs.readFileSync(path.join(FIX, "records", name + ".hex"), "utf8").trim());
const recordJson = (name) => JSON.parse(fs.readFileSync(path.join(FIX, "records", name + ".json"), "utf8")).pkm;

const SAVES = {
  "red-en": { gen: 1, game: "RB", lang: "en", layout: "int" },
  "yellow-en": { gen: 1, game: "Y", lang: "en", layout: "int" },
  "red-ja": { gen: 1, game: "RB", lang: "ja", layout: "jp" },
  "red-en.modified": { gen: 1, game: "RB", lang: "en", layout: "int" },
  "gold-en": { gen: 2, game: "GS", lang: "en", layout: "gs-int" },
  "crystal-en": { gen: 2, game: "C", lang: "en", layout: "c-int" },
  "gold-ja": { gen: 2, game: "GS", lang: "ja", layout: "gs-jp" },
  "crystal-ja": { gen: 2, game: "C", lang: "ja", layout: "c-jp" },
  "gold-ko": { gen: 2, game: "GS", lang: "ko", layout: "gs-ko" },
  "gold-en.modified": { gen: 2, game: "GS", lang: "en", layout: "gs-int" },
};
const PKHEX_VERSION = { RB: "RB", Y: "YW", GS: "GS", C: "C" };
const mod = (gen) => (gen === 1 ? gen1 : gen2);
const pkOf = (gen) => (gen === 1 ? pk1 : pk2);
const GENDER = ["M", "F", null];

/** Compares one of our MonViews with PKHeX's JSON for the same Pokémon. */
function sameMon(v, m, where) {
  assert.equal(v.species, m.species, where + " species");
  assert.equal(v.form, m.form, where + " form");
  assert.equal(v.isEgg, m.isEgg, where + " egg");
  assert.equal(v.level, m.level, where + " level");
  assert.equal(v.exp, m.exp, where + " exp");
  assert.equal(v.nickname, m.nickname, where + " nickname");
  if (!m.isEgg) assert.equal(v.isNicknamed, m.isNicknamed, where + " nicknamed");
  assert.deepEqual(v.moves.map((x) => [x.id, x.pp, x.ppUps]), m.moves.filter((x) => x.id).map((x) => [x.id, x.pp, x.ppUps]), where + " moves");
  assert.deepEqual(v.dvs, { hp: m.dvs.hp, atk: m.dvs.atk, def: m.dvs.def, spe: m.dvs.spe, spc: m.dvs.spc }, where + " dvs");
  assert.deepEqual(v.statExp, m.statExp, where + " stat exp");
  assert.equal(v.shiny, m.isShiny, where + " shiny");
  assert.equal(v.gender, GENDER[m.gender], where + " gender");
  assert.equal(v.ot.name, m.ot.name, where + " OT");
  assert.equal(v.ot.tid, m.ot.tid, where + " TID");
  if (m.format === "pk1") assert.equal(v.catchRate, m.extra.catchRate, where + " catch rate");
  if (m.format === "pk2") {
    assert.equal(v.heldItemId, m.heldItem, where + " item");
    assert.equal(v.friendship, m.friendship, where + " friendship");
    assert.deepEqual(v.pokerus ?? { strain: 0, days: 0 }, m.pokerus, where + " pokerus");
    const met = v.met ? { location: v.met.location, level: v.met.level, timeOfDay: v.met.timeOfDay } : { location: 0, level: 0, timeOfDay: 0 };
    assert.deepEqual(met, { location: m.met.location, level: m.met.level, timeOfDay: m.met.timeOfDay }, where + " met");
    if (v.met) assert.equal(v.ot.gender, m.ot.gender, where + " OT gender");
  }
  if (m.partyStats) {
    const p = m.partyStats;
    assert.deepEqual(v.stats, { hp: p.hpMax, atk: p.atk, def: p.def, spa: p.spa, spd: p.spd, spe: p.spe }, where + " party stats");
  }
}

/* ---------- records ---------- */

test("pk1/pk2: every fixture record and save slot round-trips, views match PKHeX, validate is clean", () => {
  let n = 0;
  const check = (gen, lang, game, m, where) => {
    const pk = pkOf(gen), meta = { format: pk.FORMAT, lang, game };
    const r = fromHex(m.recordHex);
    assert.equal(r.length, pk.recordSize(lang), where + " size");
    const f = pk.parse(r, meta);
    assert.equal(hex(pk.build(JSON.parse(JSON.stringify(f)), meta)), m.recordHex, where + " round trip");
    sameMon(pk.toView(f, meta), { ...m, partyStats: m.partyStats }, where);   // computed stats = PKHeX's party stats
    const val = pk.validate(r, meta);
    assert.deepEqual(val, { ok: true, errors: [], warnings: [] }, where + " validate");
    n++;
  };
  for (const [id, s] of Object.entries(SAVES)) {
    const d = expected(id);
    for (const m of d.party) check(s.gen, s.lang, s.game, m, `${id} party ${m.slot}`);
    for (const m of d.boxes) check(s.gen, s.lang, s.game, m, `${id} box ${m.box}:${m.slot}`);
  }
  for (const f of fs.readdirSync(path.join(FIX, "records")).filter((x) => /^pk[12]-.*\.hex$/.test(x))) {
    const name = f.slice(0, -4), m = recordJson(name), gen = m.format === "pk1" ? 1 : 2;
    const lang = name.includes("-ja-") ? "ja" : name.includes("-ko-") ? "ko" : "en";
    assert.equal(hex(record(name)), m.recordHex, name);
    check(gen, lang, null, m, name);
  }
  assert.ok(n > 300, `covered ${n} records`);
});

test("pk1/pk2: format-gen1-gen2.md §13.2 vectors and field details", () => {
  // Gen 1 box Bulbasaur (box struct only; names appended for the record).
  const names = new Uint8Array(22).fill(0x50);
  const bulba = fromHex("990020 0a 00 16 03 2d 21 2d 00 00 3039 000230 00000000000000000000 ffff 2328 0000".replace(/ /g, ""));
  const f = pk1.parse(Uint8Array.from([...bulba, ...names]), { lang: "en" });
  assert.equal(f.species, 1);
  assert.equal(f.speciesIndex, 0x99);
  assert.equal(f.exp, 560);
  assert.equal(f.hp, 32);
  assert.deepEqual([f.type1, f.type2, f.catchRate], [0x16, 0x03, 0x2d]);
  assert.deepEqual(f.pp, [35, 40, 0, 0]);
  // Yellow starter Pikachu keeps catch rate 0xA3 (Light Ball in Gen 2).
  assert.equal(pk1.parse(record("pk1-yellow-pikachu-lightball"), { lang: "en" }).catchRate, 0xa3);
  // Gen 2 egg: the record's first byte is the 0xFD list entry, friendship = hatch cycles.
  const egg = pk2.parse(record("pk2-togepi-egg"), { lang: "en" });
  assert.equal(egg.isEgg, true);
  assert.equal(egg.species, 175);
  assert.equal(egg.friendship, 10);
  assert.equal(pk2.toView(egg, { lang: "en" }).stats, null);
  // Crystal caught data (bytes 44 a5: morning, met level 4, female OT, landmark 37).
  const pika = pk2.parse(record("pk2-crystal-pikachu-caught"), { lang: "en" });
  assert.deepEqual(pika.caught, { timeOfDay: 1, level: 4, otGender: 1, location: 37 });
  assert.deepEqual(pk2.toView(pika, { lang: "en", game: "C" }).ot.gender, 1);
  // Japanese records are 45 bytes, Korean 55 (Hangul names).
  assert.equal(pk1.recordSize("ja"), 45);
  assert.equal(pk2.recordSize("ja"), 45);
  assert.equal(pk2.recordSize("ko"), 55);
  assert.equal(pk2.toView(pk2.parse(record("pk2-ko-cyndaquil"), { lang: "ko" }), { lang: "ko" }).nickname, "불꽃");
});

test("pk1/pk2: build from scratch, edits and validation errors", () => {
  // A converter can build from a few fields: types, box level and catch rate get the species' defaults.
  const r = pk1.build({ species: 25, exp: 125, moves: [84, 45], pp: [30, 40], tid: 12345, dvs: { atk: 10, def: 9, spe: 8, spc: 12 }, otName: "ASH", nickname: "PIKACHU" }, { lang: "en" });
  const f = pk1.parse(r, { lang: "en" });
  assert.equal(f.speciesIndex, 0x54);
  assert.deepEqual([f.type1, f.type2, f.boxLevel, f.catchRate], [0x17, 0x17, 5, 190]);
  assert.equal(pk1.toView(f, { lang: "en" }).isNicknamed, false);
  // Editing species wins over the stale index byte.
  assert.equal(pk1.build({ ...f, species: 26 }, { lang: "en" })[0], nationalToGen1(26));
  // Names re-encode when the string changes; other bytes stay.
  const renamed = pk1.build({ ...f, nickname: "SPARKY" }, { lang: "en" });
  assert.equal(pk1.parse(renamed, { lang: "en" }).nickname, "SPARKY");
  assert.equal(hex(renamed.subarray(0, 33)), hex(r.subarray(0, 33)));
  // Validation errors.
  const bad = r.slice(); bad[0] = 0x1f;   // MissingNo. slot
  assert.equal(pk1.validate(bad, { lang: "en" }).ok, false);
  const badMove = r.slice(); badMove[8] = 200;
  assert.match(pk1.validate(badMove, { lang: "en" }).errors[0], /move/);
  const types = r.slice(); types[6] = 0x02;
  assert.match(pk1.validate(types, { lang: "en" }).warnings.join(), /type bytes/);
  assert.equal(pk1.validate(r.subarray(0, 40), { lang: "en" }).ok, false);
  assert.throws(() => pk1.parse(r, { lang: "ja" }), FormatError);
  const e = record("pk2-cyndaquil-blaze");
  const list = e.slice(); list[0] = 0x10;
  assert.match(pk2.validate(list, { lang: "en" }).errors[0], /list entry/);
  const lvl = e.slice(); lvl[1 + 0x1f] = 101;
  assert.equal(pk2.validate(lvl, { lang: "en" }).ok, false);
  const mail = e.slice(); mail[2] = 0x9e;
  assert.match(pk2.validate(mail, { lang: "en" }).warnings.join(), /Mail/);
  const sp = e.slice(); sp[0] = sp[1] = 0;
  assert.equal(pk2.validate(sp, { lang: "en" }).ok, false);
  const noTerm = e.slice(); noTerm.fill(0x80, 33, 44);
  assert.match(pk2.validate(noTerm, { lang: "en" }).warnings.join(), /terminator/);
});

/* ---------- saves: reading ---------- */

for (const [id, s] of Object.entries(SAVES)) {
  test(`${id}: detect, trainer, party, boxes, names, current box, Pokédex, untouched serialize`, () => {
    const img = load(id), d = expected(id), M = mod(s.gen);
    const det = M.detect(img);
    assert.ok(det, "detected");
    assert.deepEqual([det.game, det.lang, det.layout], [s.game, s.lang, s.layout]);
    assert.equal(PKHEX_VERSION[det.game], d.version);
    assert.equal(mod(3 - s.gen).detect(img), null, "the other generation does not claim it");
    const save = M.open(img, det);
    assert.equal(save.gen, s.gen);
    assert.equal(save.format, `pk${s.gen}`);
    assert.equal(save.lang, s.lang);
    assert.equal(typeof save.gameName, "string");
    const t = save.trainer;
    assert.deepEqual({ name: t.name, tid: t.tid, sid: t.sid, money: t.money, playTime: t.playTime, gender: t.gender },
      { name: d.trainer.name, tid: d.trainer.tid, sid: null, money: d.trainer.money, playTime: d.trainer.playTime, gender: d.trainer.gender });
    assert.equal(save.boxCount, d.boxCount);
    assert.equal(save.boxCapacity, d.boxSlotCount);
    assert.equal(save.currentBox, d.currentBox);
    assert.deepEqual([...Array(save.boxCount).keys()].map((i) => save.boxName(i)), d.boxNames);
    const party = save.party();
    assert.equal(party.length, d.partyCount);
    party.forEach((p, i) => {
      assert.equal(hex(p.record), d.party[i].recordHex, `party ${i}`);
      assert.deepEqual(p.meta, { format: `pk${s.gen}`, lang: s.lang, game: s.game });
      sameMon(p.view, d.party[i], `party ${i}`);
    });
    let used = 0;
    for (let b = 0; b < save.boxCount; b++) {
      const slots = save.box(b);
      assert.equal(slots.length, save.boxCapacity);
      slots.forEach((x, k) => {
        const m = d.boxes.find((q) => q.box === b && q.slot === k);
        assert.equal(x ? hex(x.record) : null, m ? m.recordHex : null, `box ${b}:${k}`);
        if (x) { used++; sameMon(x.view, m, `box ${b}:${k}`); }
      });
    }
    assert.equal(used, d.boxSlotsUsed);
    assert.deepEqual(save.pokedex(), d.pokedex);
    assert.deepEqual(save.serialize(), img, "untouched serialize = original bytes");
    assert.deepEqual(img, load(id), "open() does not modify the caller's bytes");
  });
}

/* ---------- saves: writing ---------- */

const sum8 = (b, from, to) => { let s = 0; for (let i = from; i < to; i++) s += b[i]; return ~s & 0xff; };
const sum16 = (b, from, to) => { let s = 0; for (let i = from; i < to; i++) s += b[i]; return s & 0xffff; };
const GS_PIECES = [[0x2009, 0x222f, 0x15c7], [0x222f, 0x23d9, 0x3d96], [0x23d9, 0x2856, 0x0c6b], [0x2856, 0x288a, 0x7e39], [0x288a, 0x2d69, 0x10e8]];

/** Every checksum the game (and our writer) maintains, recomputed independently. */
function checksumsOk(id, b) {
  const lay = SAVES[id].layout;
  if (lay === "int") {
    assert.equal(b[0x3523], sum8(b, 0x2598, 0x3523), "Gen 1 main checksum");
    for (const base of [0x4000, 0x6000]) {
      if (!b[base + 0x1a4c] && !b[base + 0x1a4d]) continue;   // bank never written (PKHeX leaves 0)
      assert.equal(b[base + 0x1a4c], sum8(b, base, base + 0x1a4c), "bank checksum");
      for (let k = 0; k < 6; k++) assert.equal(b[base + 0x1a4d + k], sum8(b, base + k * 0x462, base + (k + 1) * 0x462), "box checksum");
    }
  } else if (lay === "jp") {
    assert.equal(b[0x3594], sum8(b, 0x2598, 0x3594), "Gen 1 JP main checksum");
  } else if (lay === "gs-int") {
    assert.equal(u16le(b, 0x2d69), sum16(b, 0x2009, 0x2d69), "GS primary");
    for (const [from, to, at] of GS_PIECES) assert.deepEqual(b.subarray(at, at + to - from), b.subarray(from, to), "GS backup piece");
    assert.equal(u16le(b, 0x7e6d), u16le(b, 0x2d69), "GS backup checksum");
  } else if (lay === "c-int") {
    assert.equal(u16le(b, 0x2d0d), sum16(b, 0x2009, 0x2b83), "Crystal primary");
    assert.deepEqual(b.subarray(0x1209, 0x1d83), b.subarray(0x2009, 0x2b83), "Crystal backup copy");
    assert.equal(u16le(b, 0x1f0d), u16le(b, 0x2d0d), "Crystal backup checksum");
  } else {
    const end = lay === "gs-jp" ? 0x2c8c : 0x2ae3;
    assert.equal(u16le(b, 0x2d0d), sum16(b, 0x2009, end), "JP primary");
    assert.deepEqual(b.subarray(0x7209, 0x7209 + end - 0x2009), b.subarray(0x2009, end), "JP backup copy");
    assert.equal(u16le(b, 0x7f0d), u16le(b, 0x2d0d), "JP backup checksum");
  }
}

/** Byte ranges that may differ from PKHeX's output: vacated list entries (PKHeX writes its blank
    entity, we zero them; neither game nor PKHeX reads them) and checksum bytes. */
function maskedRanges(gen, d, lists) {
  const out = [];
  const nl = d.japanese ? 6 : 11, cap = d.boxSlotCount;
  const add = (off, capacity, ss, count) => {
    const L = gbl.listLayout(capacity, ss, nl);
    for (let i = count; i < capacity; i++) {
      out.push([off + L.structs + i * ss, off + L.structs + (i + 1) * ss]);
      out.push([off + L.ots + i * nl, off + L.ots + (i + 1) * nl]);
      out.push([off + L.nicks + i * nl, off + L.nicks + (i + 1) * nl]);
    }
  };
  const box = gen === 1 ? 33 : 32, party = gen === 1 ? 44 : 48;
  for (const [off, count, isParty] of lists) add(off, isParty ? 6 : cap, isParty ? party : box, count);
  return out;
}

function compareWithPkhex(id, ours) {
  const d = expected(id + ".modified"), pkhex = load(id + ".modified"), gen = SAVES[id].gen;
  const lists = [[d.gb.partyList.offset, d.gb.partyList.count, true]];
  d.gb.boxListOffsets.forEach((o, i) => lists.push([o, d.gb.boxListCounts[i], false]));
  if (gen === 1) lists.push([d.gb.currentBoxCopyOffset, d.gb.boxListCounts[d.currentBox], false]);
  else {
    lists.push([d.gb.currentBoxCopyOffset, d.gb.boxListCounts[d.currentBox], false]);
    lists.push([0x10e8, d.gb.partyList.count, true]);   // GS backup piece 5 holds a copy of the party
  }
  const mask = new Uint8Array(ours.length);
  for (const [a, b] of maskedRanges(gen, d, lists)) mask.fill(1, a, b);
  for (const o of gen === 1 ? [0x3523, ...[0x4000, 0x6000].flatMap((b) => [0, 1, 2, 3, 4, 5, 6].map((k) => b + 0x1a4c + k))] : [0x2d69, 0x2d6a, 0x7e6d, 0x7e6e]) mask[o] = 1;
  const diffs = [];
  for (let i = 0; i < ours.length; i++) if (!mask[i] && ours[i] !== pkhex[i]) diffs.push(i.toString(16));
  assert.deepEqual(diffs, [], `bytes differing from PKHeX's ${id}.modified.sav outside vacated entries and checksums`);
  // And the result reads back exactly as PKHeX's view of its own file.
  const s = mod(gen).open(ours);
  assert.equal(s.currentBox, d.currentBox);
  assert.deepEqual(s.party().map((p) => hex(p.record)), d.party.map((m) => m.recordHex));
  const boxes = [];
  for (let b = 0; b < s.boxCount; b++) s.box(b).forEach((x, k) => { if (x) boxes.push(`${b}:${k}:${hex(x.record)}`); });
  assert.deepEqual(boxes, d.boxes.map((m) => `${m.box}:${m.slot}:${m.recordHex}`));
  assert.deepEqual(s.pokedex(), d.pokedex);
}

test("red-en: take/put/change box reproduce PKHeX's red-en.modified.sav", () => {
  const s = gen1.open(load("red-en"));
  const eevee = s.takeFromBox(0, 2);
  assert.equal(pk1.parse(eevee.record, eevee.meta).nickname, "VEE");
  assert.deepEqual(eevee.meta, { format: "pk1", lang: "en", game: "RB" });
  s.takeFromParty(1);
  assert.deepEqual(s.putInBox(record("pk1-pikachu-sparky"), { format: "pk1", lang: "en", game: "RB" }, 3, 0), { box: 3, index: 0 });
  s.setCurrentBox(11);
  const out = s.serialize();
  checksumsOk("red-en", out);
  compareWithPkhex("red-en", out);
});

test("gold-en: take/put reproduce PKHeX's gold-en.modified.sav", () => {
  const s = gen2.open(load("gold-en"));
  const egg = s.takeFromBox(0, 0);
  assert.equal(egg.record[0], 0xfd, "an Egg record keeps its 0xFD list entry");
  assert.deepEqual(s.putInBox(record("pk2-crystal-pikachu-caught"), { format: "pk2", lang: "en", game: "C" }, 1, 0), { box: 1, index: 0 });
  s.takeFromParty(2);
  const out = s.serialize();
  checksumsOk("gold-en", out);
  compareWithPkhex("gold-en", out);
});

const WRITABLE = ["red-en", "yellow-en", "red-ja", "gold-en", "crystal-en", "gold-ja", "crystal-ja"];

for (const id of WRITABLE) {
  test(`${id}: take -> put round trips restore the Pokémon; lists stay packed; checksums valid`, () => {
    const { gen } = SAVES[id], M = mod(gen), img = load(id);
    const s = M.open(img);
    const before = s.box(0).filter(Boolean).map((x) => hex(x.record));
    const taken = s.takeFromBox(0, 1);
    assert.equal(hex(taken.record), before[1]);
    const after = s.box(0);
    assert.deepEqual(after.filter(Boolean).map((x) => hex(x.record)), [before[0], ...before.slice(2)], "later entries shifted down");
    assert.equal(after[before.length - 1], null);
    const back = s.putInBox(taken.record, taken.meta, 0);
    assert.deepEqual(back, { box: 0, index: before.length - 1 }, "appended at the end of the packed list");
    assert.equal(hex(s.box(0)[back.index].record), before[1]);
    // Party -> box: the record is what party() showed; into another box, then read back.
    const partyBefore = s.party().map((p) => hex(p.record));
    const p = s.takeFromParty(0);
    assert.equal(hex(p.record), partyBefore[0]);
    assert.deepEqual(s.party().map((x) => hex(x.record)), partyBefore.slice(1));
    const where = s.putInBox(p.record, p.meta);
    assert.equal(hex(s.box(where.box)[where.index].record), partyBefore[0]);
    const into = s.putInBox(p.record, p.meta, 2);
    assert.deepEqual(into, { box: 2, index: 0 });
    const out = s.serialize();
    assert.equal(out.length, img.length, "image size kept");
    checksumsOk(id, out);
    // Reopen: detection still works and the edits are there.
    const again = M.open(out, M.detect(out));
    assert.equal(hex(again.box(2)[0].record), partyBefore[0]);
    assert.equal(again.party().length, partyBefore.length - 1);
    // Bytes outside bank 1/game data, boxes and party mail are untouched.
    for (const [a, b] of gen === 1 ? [[0, 0x2598]] : [[0x0c60, 0x0c70], [0x3e3c, 0x3e45]]) assert.deepEqual(out.subarray(a, b), img.subarray(a, b));
  });
}

test("gen1: current box lives in bank 1 (authoritative) and is mirrored; other boxes go to their slot with bank checksums", () => {
  const img = load("red-en");
  const s = gen1.open(img);
  const rec = record("pk1-pikachu-sparky"), meta = { format: "pk1", lang: "en" };
  s.putInBox(rec, meta, 0);
  let out = s.serialize();
  assert.equal(out[0x30c0], 6, "bank-1 copy");
  assert.deepEqual(out.subarray(0x4000, 0x4462), out.subarray(0x30c0, 0x3522), "mirrored into its slot");
  assert.deepEqual(out.subarray(0x6000, 0x8000), img.subarray(0x6000, 0x8000), "bank 3 untouched");
  checksumsOk("red-en", out);
  s.putInBox(rec, meta, 7);
  out = s.serialize();
  assert.equal(out[0x6462], 1, "box 8 slot in bank 3");
  checksumsOk("red-en", out);
  assert.notEqual(out[0x7a4c], 0, "bank 3 checksum written");
  // The current box reads from bank 1 even when its slot says otherwise (a game-written save marks it empty).
  const game = out.slice();
  game[0x4000] = 0; game[0x4001] = 0xff;
  game[0x3523] = sum8(game, 0x2598, 0x3523);
  assert.equal(gen1.open(game).box(0).filter(Boolean).length, 6);
});

test("gen1: first write to another box initialises every slot and sets bit 7 (the game's first-box-change wipe)", () => {
  const img = load("red-en");
  img[0x284c] = 0x00;                      // never changed boxes: slots are uninitialised
  img.fill(0xaa, 0x4000 + 0x462, 0x4000 + 2 * 0x462);   // garbage in box 2's slot
  img[0x3523] = sum8(img, 0x2598, 0x3523);
  const s = gen1.open(img);
  assert.equal(s.box(11).filter(Boolean).length, 0, "non-current boxes read as empty while bit 7 is clear");
  assert.equal(s.box(0).filter(Boolean).length, 5);
  assert.deepEqual(s.serialize(), img);
  s.putInBox(record("pk1-mewtwo-maxdv"), { format: "pk1", lang: "en" }, 4);
  const out = s.serialize();
  assert.equal(out[0x284c], 0x80, "bit 7 set");
  for (let i = 0; i < 12; i++) {
    const off = i < 6 ? 0x4000 + i * 0x462 : 0x6000 + (i - 6) * 0x462;
    assert.equal(out[off + 1 + out[off]], 0xff, `slot ${i} has a valid list`);
    assert.equal(out[off], i === 0 ? 5 : i === 4 ? 1 : 0, `slot ${i} count`);
  }
  checksumsOk("red-en", out);
  const again = gen1.open(out);
  assert.equal(again.box(4)[0].view.species, 150);
  assert.equal(again.box(0).filter(Boolean).length, 5);
});

test("gen2: current box is written to its slot and mirrored to sBox; box edits need no checksum", () => {
  const img = load("crystal-en");
  const s = gen2.open(img);
  s.takeFromBox(0, 2);
  let out = s.serialize();
  assert.equal(out[0x4000], 4);
  assert.deepEqual(out.subarray(0x2d10, 0x2d10 + 0x44e), out.subarray(0x4000, 0x444e), "sBox mirrors the slot");
  assert.deepEqual(out.subarray(0x2000, 0x2d10), img.subarray(0x2000, 0x2d10), "game data and checksums unchanged");
  s.takeFromBox(13, 19);
  out = s.serialize();
  assert.equal(out[0x79e0], 19, "box 14 slot");
  assert.deepEqual(out.subarray(0x2d10, 0x2d10 + 0x44e), out.subarray(0x4000, 0x444e), "sBox still box 1");
  s.setCurrentBox(13);
  out = s.serialize();
  assert.equal(out[0x2700], 13);
  assert.deepEqual(out.subarray(0x2d10, 0x2d10 + 0x44e), out.subarray(0x79e0, 0x79e0 + 0x44e));
  checksumsOk("crystal-en", out);
  assert.equal(gen2.open(out).currentBox, 13);
});

test("registerDex: Gen 1 owned + seen; Gen 2 caught + seen, Unown Dex letter and first Unown; Eggs skipped", () => {
  const s1 = gen1.open(load("red-en"));
  assert.ok(!s1.pokedex().caught.includes(149));
  s1.registerDex(149);
  s1.registerDex(200);   // not a Gen 1 species: ignored
  const o1 = s1.serialize();
  assert.ok(gen1.open(o1).pokedex().caught.includes(149) && gen1.open(o1).pokedex().seen.includes(149));
  assert.equal(o1[0x25a3 + 18] & (1 << 4), 1 << 4, "bit (149 - 1) of the owned array");
  checksumsOk("red-en", o1);

  const img = load("gold-en");
  img.fill(0, 0x2a8c, 0x2a8c + 26); img[0x2aa7] = 0;   // empty Unown Dex
  setU16le(img, 0x2d69, sum16(img, 0x2009, 0x2d69));
  const s2 = gen2.open(img);
  s2.registerDex(201, { form: 16 });    // Q
  s2.registerDex(201, { form: 16 });    // already there
  s2.registerDex(201, { form: 0 });     // A
  s2.registerDex(248);
  s2.registerDex(1, { isEgg: true });
  const o2 = s2.serialize();
  const r = gen2.open(o2);
  assert.deepEqual(r.unownDex(), [16, 0]);
  assert.equal(o2[0x2aa7], 17, "first Unown seen = Q");
  assert.ok(r.pokedex().caught.includes(248) && r.pokedex().seen.includes(201));
  assert.ok(!r.pokedex().seen.includes(1), "eggs are not registered");
  checksumsOk("gold-en", o2);
});

test("refusals: last Pokémon, wrong format or language, full box, taken slot, bad record, read-only Korean", () => {
  const s = gen1.open(load("red-en"));
  s.takeFromParty(0); s.takeFromParty(0);
  assert.throws(() => s.takeFromParty(0), (e) => e instanceof FormatError && /last Pokémon/.test(e.message));
  assert.throws(() => s.takeFromParty(5), FormatError);
  assert.throws(() => s.takeFromBox(1, 0), FormatError);
  assert.throws(() => s.putInBox(record("pk2-cyndaquil-blaze"), { format: "pk2", lang: "en" }), /converted/);
  assert.throws(() => s.putInBox(record("pk1-ja-pikachu"), { format: "pk1", lang: "ja" }), /Japanese/);
  assert.throws(() => s.putInBox(record("pk1-pikachu-sparky"), { format: "pk1", lang: "en" }, 11), /full/);
  assert.throws(() => s.putInBox(record("pk1-pikachu-sparky"), { format: "pk1", lang: "en" }, 0, 1), /taken/);
  assert.throws(() => s.putInBox(record("pk1-pikachu-sparky"), { format: "pk1", lang: "en" }, 12), /no box/);
  const glitch = record("pk1-pikachu-sparky"); glitch[0] = 0;
  assert.throws(() => s.putInBox(glitch, { format: "pk1", lang: "en" }), /can't be stored/);
  // Gen 2: Eggs do not count as the last Pokémon; Mail blocks both directions.
  const g = gen2.open(load("gold-en"));
  assert.throws(() => g.putInBox(record("pk2-ja-chikorita"), { format: "pk2", lang: "ja" }), /Japanese/);
  assert.throws(() => g.putInBox(record("pk2-ko-cyndaquil"), { format: "pk2", lang: "ko" }), /Korean/);
  const mail = record("pk2-cyndaquil-blaze"); mail[2] = 0xb5;
  assert.throws(() => g.putInBox(mail, { format: "pk2", lang: "en" }), /Mail/);
  const ko = gen2.open(load("gold-ko"));
  assert.ok(ko.readOnly);
  for (const op of [() => ko.takeFromParty(0), () => ko.takeFromBox(0, 0), () => ko.registerDex(1), () => ko.putInBox(record("pk2-ko-cyndaquil"), { format: "pk2", lang: "ko" })]) {
    assert.throws(op, (e) => e instanceof FormatError && /Korean/.test(e.message));
  }
  assert.deepEqual(ko.serialize(), load("gold-ko"));
  // A Gen 1 save with a wrong main checksum is not detected; forced open, it is read-only.
  const broken = load("red-en"); broken[0x2600] ^= 1;
  assert.equal(gen1.detect(broken), null);
  const b = gen1.open(broken, { game: "RB", lang: "en", layout: "int" });
  assert.match(b.readOnly, /checksum/);
  assert.equal(b.party().length, 3);
  assert.throws(() => b.takeFromBox(0, 0), /checksum/);
});

/** A Gold save with a party of [egg?, ...] built from fixture records, for mail and egg tests. */
function goldWithParty(entries, mails = []) {
  const img = load("gold-en");
  const L = gbl.listLayout(6, 48, 11);
  gbl.clearList(img, 0x288a, L);
  for (const r of entries) {
    const k = gbl.append(img, 0x288a, L, gbl.recordToEntry(r, 2, 32, 11));
    if (r[0] !== 0xfd) img[0x288a + L.structs + k * 48 + 0x23] = 20;   // current HP 20 (Eggs have 0)
  }
  mails.forEach((m, i) => { if (m) for (const base of [0x0600, 0x071a]) img.fill(m, base + i * 0x2f, base + (i + 1) * 0x2f); });
  setU16le(img, 0x2d69, sum16(img, 0x2009, 0x2d69));
  return img;
}

test("gen2 party: Eggs can't be the last Pokémon left; Mail moves with its holder in both copies", () => {
  const egg = record("pk2-togepi-egg"), mon = record("pk2-cyndaquil-blaze");
  const s = gen2.open(goldWithParty([egg, mon]));
  assert.throws(() => s.takeFromParty(1), /last Pokémon/);
  assert.equal(s.takeFromParty(0).record[0], 0xfd);
  const holder = mon.slice(); holder[2] = 0x9e;   // Flower Mail
  const img = goldWithParty([mon, mon, holder], [0x11, 0x22, 0x33]);
  const t = gen2.open(img);
  assert.throws(() => t.takeFromParty(2), /Mail/);
  t.takeFromParty(0);
  const out = t.serialize();
  for (const base of [0x0600, 0x071a]) {
    assert.equal(out[base + 1 * 0x2f], 0x33, "the holder's mail moved from slot 3 to slot 2");
    assert.equal(out[base + 0 * 0x2f], 0x22);
    assert.equal(out[base + 2 * 0x2f], 0, "vacated mail slot cleared");
  }
  checksumsOk("gold-en", out);
  // No mail holder after the removed one: mail bytes stay as they are.
  const u = gen2.open(goldWithParty([mon, mon, mon], [0x11, 0x22, 0x33]));
  u.takeFromParty(0);
  assert.equal(u.serialize()[0x0600], 0x11);
});

test("gen2: a damaged primary copy is replaced by the backup, as the game does on load", () => {
  for (const id of ["gold-en", "crystal-en", "crystal-ja"]) {
    const img = load(id);
    img[0x2100] ^= 0xff;   // inside every layout's primary block
    const det = gen2.detect(img);
    assert.ok(det && det.layout === SAVES[id].layout, id);
    const s = gen2.open(img, det);
    assert.match(s.warnings.join(), /backup/);
    assert.equal(s.trainer.name, expected(id).trainer.name);
    assert.deepEqual(s.serialize(), load(id), `${id}: repaired from the backup`);
  }
  const img = load("crystal-en");
  img[0x2100] ^= 0xff; img[0x1300] ^= 0xff;
  assert.equal(gen2.detect(img), null, "both copies bad: not a usable save");
  const s = gen2.open(img, { game: "C", lang: "en", layout: "c-int" });
  assert.ok(s.readOnly);
  assert.throws(() => s.takeFromBox(0, 0), FormatError);
});

/* ---------- detection robustness ---------- */

test("detect: never misfires on other generations, blank, 0xFF, random or truncated images", () => {
  for (const f of fs.readdirSync(path.join(FIX, "saves")).filter((x) => x.endsWith(".sav"))) {
    const id = f.slice(0, -4), img = load(id);
    const gen = SAVES[id]?.gen;
    if (gen !== 1) assert.equal(gen1.detect(img), null, `gen1 on ${id}`);
    if (gen !== 2) assert.equal(gen2.detect(img), null, `gen2 on ${id}`);
  }
  let seed = 12345;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
  for (const size of [0, 1, 0x7fff, 0x8000, 0x10000, 0x20000]) {
    for (const fill of [0x00, 0xff, null]) {
      const b = new Uint8Array(size);
      if (fill === null) for (let i = 0; i < size; i++) b[i] = rnd(); else b.fill(fill);
      assert.equal(gen1.detect(b), null, `gen1 ${size} ${fill}`);
      assert.equal(gen2.detect(b), null, `gen2 ${size} ${fill}`);
    }
  }
  for (const junk of [null, undefined, "save", 42, {}, [1, 2, 3], new ArrayBuffer(0x8000)]) {
    assert.equal(gen1.detect(junk), null);
    assert.equal(gen2.detect(junk), null);
  }
  assert.throws(() => gen1.open(new Uint8Array(0x8000)), FormatError);
  assert.throws(() => gen2.open(new Uint8Array(0x8000)), FormatError);
  assert.throws(() => gen1.open(new Uint8Array(10)), FormatError);
  // A 32 KiB cut of the 64 KiB Japanese Crystal fixture is still Japanese Crystal.
  const half = load("crystal-ja").slice(0, 0x8000);
  assert.equal(gen2.detect(half)?.layout, "c-jp");
  assert.equal(gen2.open(half).trainer.gender, 1);
});

test("detect: the guessed Yellow Extended layout is refused with a clear message", () => {
  // Synthetic (UNVERIFIED layout): bank 1 of a Yellow save shifted by 26 bytes after the player name.
  const src = load("yellow-en"), img = src.slice();
  img.copyWithin(0x25a3 + 26, 0x25a3, 0x3523);
  img.fill(0, 0x25a3, 0x25a3 + 26);
  img[0x3523 + 26] = sum8(img, 0x2598, 0x3523 + 26);
  const det = gen1.detect(img);
  assert.equal(det?.layout, "yellow-extended");
  assert.throws(() => gen1.open(img, det), (e) => e instanceof FormatError && /Extended/.test(e.message));
});

test("language: Western saves are guessed from default species names and character sets", () => {
  const nick = (s) => gbl.encodeName(1, s, "fr", 11);
  assert.equal(gbl.guessWesternLang(1, [], [{ species: 1, nick: nick("BULBIZARRE") }]), "fr");
  assert.equal(gbl.guessWesternLang(1, [], [{ species: 1, nick: gbl.encodeName(1, "BISASAM", "de", 11) }]), "de");
  assert.equal(gbl.guessWesternLang(1, [], [{ species: 1, nick: gbl.encodeName(1, "BULBASAUR", "en", 11) }]), "en");
  assert.equal(gbl.guessWesternLang(2, [gbl.encodeName(2, "JÖRG", "de", 11)], []), "de");
  // The detection's language can be overridden by the player (same layout).
  const s = gen1.open(load("red-en"), { ...gen1.detect(load("red-en")), lang: "fr" });
  assert.equal(s.lang, "fr");
  assert.equal(s.party()[0].meta.lang, "fr");
});

/* ---------- regressions from the adversarial verification (differential fuzzing against PKHeX) ---------- */

test("Node Buffers: detect/open never write to the caller's bytes and serialize() results are snapshots", () => {
  // Buffer#slice() shares memory, so a "copy" made with it would let edits leak into the caller's file.
  for (const id of ["red-en", "crystal-en"]) {
    const M = mod(SAVES[id].gen);
    const buf = fs.readFileSync(path.join(FIX, "saves", id + ".sav"));
    if (id === "crystal-en") buf[0x2100] ^= 0xff;   // damaged primary: detect and open restore it from the backup
    const before = Buffer.from(buf);
    const s = M.open(buf, M.detect(buf));
    s.takeFromBox(0, 0);
    s.registerDex(100);
    const first = s.serialize();
    const firstHex = hex(first);
    s.takeFromBox(0, 0);
    s.serialize();
    assert.ok(before.equals(buf), `${id}: caller's buffer untouched`);
    assert.equal(hex(first), firstHex, `${id}: an earlier serialize() result does not change`);
  }
});

test("a box whose species list detect() would reject is damaged: not shown, not writable, never made current", () => {
  // Found by fuzzing: such a box made current turned a loadable save into one detect() refuses.
  const img = load("red-en");
  const box2 = 0x4000 + 0x462;
  img[box2] = 3; img.fill(0xff, box2 + 1, box2 + 5);        // count 3, but no species before the terminator
  const s = gen1.open(img);
  assert.match(s.warnings.join(), /Box 2 is damaged/);
  assert.equal(s.box(1).filter(Boolean).length, 0);
  assert.throws(() => s.setCurrentBox(1), /damaged/);
  assert.throws(() => s.putInBox(record("pk1-pikachu-sparky"), { format: "pk1", lang: "en" }, 1), /damaged/);
  s.setCurrentBox(2);
  assert.ok(gen1.detect(s.serialize()), "the written save still loads");

  const g = load("gold-en");
  const box3 = 0x4000 + 2 * 0x450;
  g[box3] = 2; g[box3 + 1] = 0; g[box3 + 2] = 0; g[box3 + 3] = 0xff;   // two "species 0" entries
  const t = gen2.open(g);
  assert.match(t.warnings.join(), /Box 3 is damaged/);
  assert.throws(() => t.setCurrentBox(2), /damaged/);
  t.setCurrentBox(1);
  assert.ok(gen2.detect(t.serialize()), "the written save still loads");
});

test("pk1: EXP past the level-100 amount is an error (Gen 1 computes levels from EXP with no cap)", () => {
  const r = record("pk1-pikachu-sparky");
  const meta = { format: "pk1", lang: "en" };
  r[0x0e] = 0x0f; r[0x0f] = 0x42; r[0x10] = 0x41;           // 1,000,001: one past Medium Fast level 100
  assert.match(pk1.validate(r, meta).errors.join(), /past level 100/);
  assert.throws(() => gen1.open(load("red-en")).putInBox(r, meta, 0), /can't be stored/);
  const under = pk1.build({ species: 1, exp: 0xffffca, moves: [33], pp: [35], otName: "RED", nickname: "BULBASAUR", boxLevel: 1 }, meta);
  assert.match(pk1.validate(under, meta).errors.join(), /underflow/);
  // Gen 2 caps the level at 100 (CalcLevel), so there it stays a warning.
  const p = record("pk2-cyndaquil-blaze");
  p[1 + 0x08] = 0x7f;
  assert.equal(pk2.validate(p, { format: "pk2", lang: "en" }).ok, true);
});

test("gen2 party: Bill's PC refuses to take the last Pokémon that has not fainted", () => {
  const mon = record("pk2-cyndaquil-blaze");
  const img = goldWithParty([mon, mon]);
  img[0x288a + 8 + 48 + 0x22] = 0; img[0x288a + 8 + 48 + 0x23] = 0;   // party slot 2 has fainted
  setU16le(img, 0x2d69, sum16(img, 0x2009, 0x2d69));
  const s = gen2.open(img);
  assert.throws(() => s.takeFromParty(0), (e) => e instanceof FormatError && /fainted/.test(e.message));
  assert.equal(s.takeFromParty(1).record[1], 155, "the fainted one can go");
});

test("putInBox refuses a record without a format (pk1 and pk2 records have the same sizes)", () => {
  assert.equal(pk1.recordSize("en"), pk2.recordSize("en"));
  assert.throws(() => gen1.open(load("red-en")).putInBox(record("pk2-cyndaquil-blaze"), { lang: "en" }, 0), /format/);
  assert.throws(() => gen2.open(load("gold-en")).putInBox(record("pk1-pikachu-sparky"), undefined, 1), /format/);
});

test("gold-en: backup piece 2 goes to 0x3D96 (pret) and the Hall of Fame tail at 0x3D69 is left alone", () => {
  const img = load("gold-en");
  for (let i = 0x222f; i < 0x23d9; i++) img[i] = (i * 7) & 0xff;   // non-zero wPlayerData2
  img.fill(0x11, 0x3d69, 0x3d96);                                // a full Hall of Fame
  img.copyWithin(0x3d96, 0x222f, 0x23d9);
  setU16le(img, 0x2d69, sum16(img, 0x2009, 0x2d69));
  setU16le(img, 0x7e6d, u16le(img, 0x2d69));
  const s = gen2.open(img);
  s.registerDex(5);
  s.takeFromParty(0);
  const out = s.serialize();
  checksumsOk("gold-en", out);
  assert.ok(out.subarray(0x3d69, 0x3d96).every((x) => x === 0x11), "Hall of Fame untouched");
});
