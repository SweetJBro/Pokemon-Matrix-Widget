/* shared/pkm/pk5.js and shared/saves/gen5.js against the PKHeX fixtures (test/fixtures/README.md)
   and the vectors and copy-selection cases of docs/research/format-gen5.md §17. No dotnet needed:
   gen5-oracle.test.js runs PKHeX on our output when the oracle is built. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hex, u16le, u32le, setU16le, setU32le, crc16ccitt, getFlag, FormatError } from "../shared/bytes.js";
import { decrypt45 } from "../shared/pkm/crypt.js";
import * as pk5 from "../shared/pkm/pk5.js";
import * as gen5 from "../shared/saves/gen5.js";
import * as D from "../shared/data/index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fromHex = (s) => Uint8Array.from(s.trim().match(/../g), (x) => parseInt(x, 16));
const readSave = (id) => new Uint8Array(fs.readFileSync(path.join(dir, "saves", id + ".sav")));
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(dir, p), "utf8"));
const readRecord = (name) => fromHex(fs.readFileSync(path.join(dir, "records", name + ".hex"), "utf8"));

const SAVES = [
  { id: "black-en", game: "B", lang: "en", layout: "BW" },
  { id: "black2-en", game: "B2", lang: "en", layout: "B2W2" },
  { id: "black-ja", game: "B", lang: "ja", layout: "BW" },
  { id: "black-en.modified", game: "B", lang: "en", layout: "BW" },
];
const GENDER = ["M", "F", null];
const stats6 = (o) => ({ hp: o.hp, atk: o.atk, def: o.def, spa: o.spa, spd: o.spd, spe: o.spe });

/** Every slot PKHeX dumped from a Gen 5 fixture save, plus the single records. */
function fixtureMons() {
  const out = [];
  for (const s of SAVES) {
    const d = readJson(`saves/${s.id}.expected.json`);
    for (const m of [...d.party, ...d.boxes]) out.push({ where: `${s.id} ${m.box ?? "party"}:${m.slot}`, m, lang: s.lang, game: s.game });
  }
  for (const f of fs.readdirSync(path.join(dir, "records")).filter((n) => n.startsWith("pk5-") && n.endsWith(".json"))) {
    out.push({ where: f, m: readJson("records/" + f).pkm, lang: "en", game: "B" });
  }
  return out;
}

/** Recompute a block's CRC (footer + table entry) and the footer CRC of one copy. */
function fixBlock(img, L, base, i) {
  const { off, size } = L.blocks[i];
  const crc = crc16ccitt(img, base + off, size);
  setU16le(img, base + off + size + 2, crc);
  setU16le(img, base + L.table + 2 * i, crc);
  setU16le(img, base + L.footer + 0xe, crc16ccitt(img, base + L.table, L.crcsSize));
}
const mirror = (img, L) => img.copyWithin(L.copySize, 0, L.copySize);
function allMons(save) {
  const out = save.party().map((e, i) => ({ where: `party ${i}`, ...e }));
  for (let b = 0; b < save.boxCount; b++) save.box(b).forEach((e, i) => { if (e) out.push({ where: `box ${b}:${i}`, box: b, slot: i, ...e }); });
  return out;
}
/** Every block of the main copy matches its footer CRC and the table; the footer CRC matches the table. */
function assertCopyValid(img, L, base = 0) {
  L.blocks.forEach(({ off, size }, i) => {
    const crc = crc16ccitt(img, base + off, size);
    assert.equal(u16le(img, base + off + size + 2), crc, `block ${i} footer CRC`);
    assert.equal(u16le(img, base + L.table + 2 * i), crc, `block ${i} table entry`);
  });
  assert.equal(u16le(img, base + L.footer + 0xe), crc16ccitt(img, base + L.table, L.crcsSize), "footer CRC");
  assert.equal(u32le(img, base + L.footer + 4), L.footer + 0x10, "footer size");
  assert.equal(u32le(img, base + L.footer + 8), gen5.MAGIC, "footer magic");
}

/* ---------- pk5 records ---------- */

test("pk5: build(parse(r)) is byte-exact for every fixture record and slot (box and party form, JSON round trip)", () => {
  const all = fixtureMons();
  assert.ok(all.length > 100);
  for (const { where, m, lang } of all) {
    for (const h of new Set([m.recordHex, m.storedHex])) {
      const f = pk5.parse(fromHex(h), { lang });
      assert.equal(hex(pk5.build(f, { lang })), h, where);
      assert.equal(hex(pk5.build(JSON.parse(JSON.stringify(f)), { lang })), h, where + " (JSON)");
    }
  }
});

test("pk5: toView matches PKHeX's reading of every fixture Pokémon", () => {
  for (const { where, m, lang, game } of fixtureMons()) {
    if (!m.species) continue;
    const party = m.partyStats ? pk5.parse(fromHex(m.storedHex), { lang }) : null;
    const v = pk5.toView(party ?? pk5.parse(fromHex(m.recordHex), { lang }), { lang, game });
    const eq = (k, a, b) => assert.deepEqual(a, b, `${where} ${k}`);
    eq("species", [v.species, v.form, v.isEgg, v.level, v.exp], [m.species, m.form, m.isEgg, m.level, m.exp]);
    eq("nickname", [v.nickname, v.isNicknamed], [m.nickname, m.isNicknamed]);
    eq("moves", v.moves.map((x) => [x.id, x.pp, x.ppUps]), m.moves.filter((x) => x.id).map((x) => [x.id, x.pp, x.ppUps]));
    eq("ivs", v.ivs, stats6(m.ivs));
    eq("evs", v.evs, stats6(m.evs));
    eq("nature/ability", [v.natureId, v.abilityId, v.heldItemId], [m.nature, m.ability, m.heldItem]);
    // PKHeX always takes the slot from PID bit 16; the game uses bit 0 for Gen 3/4 origins (§8.6).
    if (m.met.version >= 20) eq("abilityNum", v.abilityNum, m.abilityNumber);
    eq("gender/shiny/pid", [v.gender, v.shiny, v.pid], [GENDER[m.gender], m.isShiny, m.pid]);
    eq("ot", [v.ot.name, v.ot.tid, v.ot.sid, v.ot.gender], [m.ot.name, m.ot.tid, m.ot.sid, ["M", "F"][m.ot.gender]]);
    eq("met", [v.met.location, v.met.level, v.met.date, v.ballId, v.extra.originGame], [m.met.location, m.met.level, m.met.date, m.met.ball, m.met.version]);
    eq("egg", v.extra.egg ? [v.extra.egg.location, v.extra.egg.date] : [0, null], [m.egg.location, m.egg.date]);
    eq("misc", [v.friendship, v.lang, v.pokerus ?? { strain: 0, days: 0 }, v.markings, v.extra.fateful],
      [m.friendship, m.languageCode, m.pokerus, m.markingsRaw, m.fatefulEncounter]);
    eq("extra", [v.extra.hiddenAbility, v.extra.nsPokemon, v.extra.pokeStarFame, v.extra.encounterType],
      [m.extra.hiddenAbility, m.extra.nSparkle, m.extra.pokeStarFame, m.extra.groundTile]);
    eq("contest", v.extra.contest, m.contest);
    eq("ribbons", v.ribbons.length, m.ribbonCount);
    eq("checksum", v.checksumOk, m.checksumValid);
    if (m.partyStats) {
      eq("party stats", v.stats, { hp: m.partyStats.hpMax, atk: m.partyStats.atk, def: m.partyStats.def, spa: m.partyStats.spa, spd: m.partyStats.spd, spe: m.partyStats.spe });
      // Box records carry no stats; the computed ones must equal what the game stored.
      eq("computed stats", pk5.toView(pk5.parse(fromHex(m.recordHex), { lang }), { lang }).stats, v.stats);
    }
    const val = pk5.validate(fromHex(m.recordHex), { lang, game });
    assert.ok(val.ok, `${where} validate: ${val.errors}`);
    assert.deepEqual(val.warnings.filter((w) => !/EV total/.test(w)), [], where + " warnings");
  }
});

test("pk5: hidden ability, N's sparkle, PokéStar fame and ribbons decode", () => {
  const snivy = pk5.toView(pk5.parse(readRecord("pk5-snivy-hidden-ability")));
  assert.equal(snivy.abilityNum, 2);
  assert.equal(snivy.ability, "Contrary");
  assert.equal(pk5.parse(readRecord("pk5-purrloin-nsparkle")).nsPokemon, true);
  const reshiram = readJson("saves/black-en.expected.json").boxes.find((m) => m.species === 643);
  assert.deepEqual(pk5.toView(pk5.parse(fromHex(reshiram.recordHex))).ribbons.sort(), ["Legend", "World Champion"]);
  const hydreigon = readJson("saves/black2-en.expected.json").boxes.find((m) => m.extra.pokeStarFame);
  assert.equal(pk5.parse(fromHex(hydreigon.recordHex)).pokeStarFame, hydreigon.extra.pokeStarFame);
  // Flags survive a field edit + rebuild.
  const f = pk5.parse(readRecord("pk5-purrloin-nsparkle"));
  const g = pk5.parse(pk5.build({ ...f, friendship: 200 }));
  assert.equal(g.nsPokemon, true);
  assert.equal(g.friendship, 200);
  assert.equal(g.checksumOk, true);
});

test("pk5: empty slot encoding and §17 vectors", () => {
  const empty = pk5.emptyRecord();
  assert.equal(hex(empty), hex(readRecord("pk5-empty")));
  assert.equal(hex(empty, 0, 0x18), "0000000000000000" + "00007ee97152b031428ecce2c5afdb67");
  assert.equal(hex(empty, 0x80, 8), "00da6a70c5df84ba");
  const party = pk5.emptyPartySlot();
  assert.equal(hex(party, 0x88, 84), hex(empty, 0x08, 84));
  assert.ok(pk5.isEmpty(empty) && pk5.isEmpty(party) && pk5.isEmpty(new Uint8Array(136)));
  const tray = new Uint8Array(0xff0);
  for (let i = 0; i < 30; i++) tray.set(empty, i * 136);
  assert.equal(crc16ccitt(tray), 0xeb33);
  assert.equal(crc16ccitt(new TextEncoder().encode("123456789")), 0x29b1);
  assert.equal(crc16ccitt(new Uint8Array(0x8c)), 0x2c2c);

  // The sample PK5 of §17, built through parse/build from the empty record's fields.
  const base = pk5.parse(empty);                 // all-zero fields
  const nick = new Uint8Array(22);
  [..."PIKACHU"].forEach((c, i) => setU16le(nick, 2 * i, c.charCodeAt(0)));
  setU16le(nick, 14, 0xffff); setU16le(nick, 20, 0xffff);
  const sample = {
    ...base, pid: 0x12345678, species: 25, tid: 12345, sid: 54321, exp: 1000, friendship: 70, ability: 9, language: 2,
    moves: [84, 0, 0, 0], pp: [30, 0, 0, 0], nature: 3, originGame: 21, nickname: null, nicknameBytes: Array.from(nick), otName: null,
  };
  const rec = pk5.build(sample);
  assert.equal(((0x12345678 >>> 13) & 31) % 24, 2);
  assert.equal(u16le(rec, 6), 0x2e26);
  assert.equal(hex(rec, 0, 16), "785634120000262e9e6560053acd4d65");
  assert.equal(pk5.parse(rec).checksumOk, true);
  assert.equal(hex(pk5.build(pk5.parse(rec))), hex(rec));
});

test("pk5: a Bad Egg keeps its wrong checksum through parse/build and fails validation", () => {
  const rec = readRecord("pk5-snivy-hidden-ability");
  rec[0x30] ^= 0x55;                            // corrupt one encrypted byte
  const f = pk5.parse(rec);
  assert.equal(f.checksumOk, false);
  assert.equal(hex(pk5.build(f)), hex(rec));
  const v = pk5.validate(rec);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(), /Bad Egg/);
  const view = pk5.toView(f);
  assert.equal(view.checksumOk, false);
  assert.equal(view.isEgg, true);
  const flagged = pk5.build({ ...pk5.parse(readRecord("pk5-snivy-hidden-ability")), flags: 4 });
  assert.match(pk5.validate(flagged).errors.join(), /Bad Egg flag/);
});

test("pk5: renaming re-encodes only the edited name; restorePP fills PP to the maximum", () => {
  const f = pk5.parse(readRecord("pk5-oshawott-shell"));
  const g = pk5.parse(pk5.build({ ...f, nickname: "Otter" }));
  assert.equal(g.nickname, "Otter");
  assert.equal(g.otName, f.otName);
  assert.deepEqual(g.otNameBytes, f.otNameBytes);
  assert.equal(hex(Uint8Array.from(g.nicknameBytes)), "4f007400740065007200" + "ffff" + "0".repeat(16) + "ffff");
  const used = { ...f, pp: [1, 0, 2, 0], ppUps: [3, 0, 1, 2] };
  const r = pk5.restorePP(used);
  const moves = f.moves.filter(Boolean);
  assert.ok(moves.length >= 2);
  r.moves.forEach((m, i) => {
    if (!m) return assert.equal(r.pp[i], used.pp[i]);
    const base = D.basePP(m, 5);
    assert.ok(base > 0);
    assert.equal(r.pp[i], base + Math.floor(base * 20 * used.ppUps[i] / 100), `move ${m}`);
  });
});

test("pk5: validate refuses impossible records", () => {
  const base = pk5.parse(readRecord("pk5-oshawott-shell"));
  const bad = (patch, meta, re) => assert.match(pk5.validate(pk5.build({ ...base, ...patch }), meta).errors.join(" | "), re);
  bad({ species: 650 }, {}, /does not exist in Generation 5/);
  bad({ moves: [560, 0, 0, 0] }, {}, /Move 560/);
  bad({ heldItem: 638 }, { game: "B" }, /Held item 638/);
  assert.ok(pk5.validate(pk5.build({ ...base, heldItem: 638 }), { game: "B2" }).ok);
  bad({ species: 646, form: 1, ability: 163 }, { game: "W" }, /Black 2 and White 2/);
  bad({ ppUps: [4, 0, 0, 0] }, {}, /PP Ups/);
  bad({ ball: 26 }, {}, /Ball 26/);
  bad({ exp: 3000000 }, {}, /level 100/);
  bad({ nicknameBytes: Array(22).fill(0), nickname: null }, {}, /Nickname is empty/);
  assert.match(pk5.validate(pk5.emptyRecord()).errors.join(), /empty/);
  assert.equal(pk5.validate(new Uint8Array(80)).ok, false);
  assert.match(pk5.validate(pk5.build({ ...base, gender: base.gender ^ 1 })).warnings.join(), /gender/);
});

/* ---------- saves: reading ---------- */

for (const s of SAVES) {
  test(`gen5 ${s.id}: detect, trainer, party, boxes, names, current box and Pokédex match PKHeX`, () => {
    const img = readSave(s.id), exp = readJson(`saves/${s.id}.expected.json`);
    const det = gen5.detect(img);
    assert.equal(det.game, s.game);
    assert.equal(det.lang, s.lang);
    assert.equal(det.layout, s.layout);
    assert.ok(det.confidence >= 0.9);
    const save = gen5.open(img, det);
    assert.equal(save.gen, 5);
    assert.equal(save.format, "pk5");
    assert.equal(exp.version, save.game);
    assert.equal(save.lang, exp.languageCode);
    const t = exp.trainer;
    assert.deepEqual(save.trainer, { name: t.name, gender: ["M", "F"][t.gender], tid: t.tid, sid: t.sid, money: t.money, playTime: t.playTime });
    assert.equal(save.boxCount, exp.boxCount);
    assert.equal(save.boxCapacity, exp.boxSlotCount);
    assert.equal(save.currentBox, exp.currentBox);
    assert.deepEqual(Array.from({ length: save.boxCount }, (_, b) => save.boxName(b)), exp.boxNames);
    const party = save.party();
    assert.equal(party.length, exp.partyCount);
    party.forEach((e, i) => {
      assert.equal(hex(e.record), exp.party[i].recordHex, `party ${i}`);
      assert.deepEqual(e.meta, { format: "pk5", lang: s.lang, game: s.game });
      assert.equal(e.view.level, exp.party[i].partyStats.level);
    });
    const got = [];
    for (let b = 0; b < save.boxCount; b++) {
      const box = save.box(b);
      assert.equal(box.length, 30);
      box.forEach((e, i) => { if (e) got.push([b, i, hex(e.record), e.view.species]); });
    }
    assert.deepEqual(got, exp.boxes.map((m) => [m.box, m.slot, m.recordHex, m.species]));
    assert.deepEqual(save.pokedex(), exp.pokedex);
    assert.equal(hex(save.serialize()), hex(img), "untouched serialize");
  });
}

test("gen5: block tables follow the alignment rule and match the spec offsets", () => {
  const { BW, B2W2 } = gen5.LAYOUTS;
  assert.equal(BW.blocks.length, 69);
  assert.equal(B2W2.blocks.length, 73);
  assert.deepEqual([BW.table, BW.crcsSize, BW.footer], [0x23f00, 0x8c, 0x23f8c]);
  assert.deepEqual([B2W2.table, B2W2.crcsSize, B2W2.footer], [0x25f00, 0x94, 0x25f94]);
  const spot = (L, i, off) => assert.equal(L.blocks[i].off, off, `${L.name} block ${i}`);
  spot(BW, 25, 0x18400); spot(BW, 26, 0x18e00); spot(BW, 27, 0x19400); spot(BW, 52, 0x21200); spot(BW, 55, 0x21600); spot(BW, 68, 0x23e00);
  spot(B2W2, 43, 0x1fa00); spot(B2W2, 52, 0x21100); spot(B2W2, 54, 0x21400); spot(B2W2, 67, 0x23c00); spot(B2W2, 69, 0x25800); spot(B2W2, 72, 0x25e00);
  for (let b = 0; b < 24; b++) spot(B2W2, 1 + b, 0x400 + 0x1000 * b);
  assert.equal(BW.formBytes, 9);
  assert.equal(B2W2.formBytes, 11);
  for (const s of SAVES) assertCopyValid(readSave(s.id), gen5.LAYOUTS[s.layout]);
});

test("gen5: detection does not misfire on other generations or noise", () => {
  for (const f of fs.readdirSync(path.join(dir, "saves")).filter((n) => n.endsWith(".sav") && !n.startsWith("black"))) {
    assert.equal(gen5.detect(new Uint8Array(fs.readFileSync(path.join(dir, "saves", f)))), null, f);
  }
  let seed = 7;
  const rnd = new Uint8Array(0x80000).map(() => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 24; });
  for (const img of [new Uint8Array(0x80000), new Uint8Array(0x80000).fill(0xff), rnd, new Uint8Array(0x7ffff), new Uint8Array(0)]) {
    assert.equal(gen5.detect(img), null);
  }
  assert.equal(gen5.detect("not bytes"), null);
  assert.equal(gen5.detect(undefined), null);
  assert.throws(() => gen5.open(new Uint8Array(0x80000)), FormatError);
});

/* ---------- copy selection (§5.5, §17 a-e) ---------- */

/** A fixture image whose backup copy equals its main copy (a completed save). */
function mirrored(id = "black-en") {
  const img = readSave(id);
  mirror(img, gen5.LAYOUTS[id.startsWith("black2") ? "B2W2" : "BW"]);
  return img;
}
const slot0 = (save) => save.box(0)[0] && hex(save.box(0)[0].record);

test("gen5 copy selection: (a) equal copies -> main; (b) newer backup wins and our edit lands in both copies", () => {
  const L = gen5.LAYOUTS.BW;
  const a = gen5.open(mirrored());
  assert.deepEqual(a.warnings.filter((w) => /backup/.test(w)), []);

  // (b): backup counter = main + 1 and a different box 1 (slot 0 emptied) in the backup only.
  const img = mirrored();
  const o = L.copySize + L.blocks[1].off;
  img.set(pk5.emptyRecord(), o);
  fixBlock(img, L, L.copySize, 1);
  setU32le(img, L.copySize + L.footer, u32le(img, L.footer) + 1);
  fixBlock(img, L, L.copySize, 1);
  const save = gen5.open(img);
  assert.equal(save.box(0)[0], null, "box 1 comes from the newer backup");
  assert.match(save.warnings.join(), /backup copy of this save is the newer/);
  save.takeFromBox(0, 4);
  const out = save.serialize();
  assert.equal(hex(out.subarray(0, L.copySize)), hex(out.subarray(L.copySize, 2 * L.copySize)), "both copies equal");
  assertCopyValid(out, L, 0);
  assertCopyValid(out, L, L.copySize);
  assert.equal(u32le(out, L.footer), u32le(img, L.copySize + L.footer) + 1, "counter continues from the newer copy");
  const again = gen5.open(out);
  assert.equal(again.box(0)[0], null);
  assert.equal(again.box(0)[4], null, "our edit survives the game's copy choice");
});

test("gen5 copy selection: (c) broken main footer -> backup; both broken -> corrupted", () => {
  const L = gen5.LAYOUTS.B2W2;
  const img = mirrored("black2-en");
  img[L.footer + 0xe] ^= 0xff;
  const det = gen5.detect(img);
  assert.equal(det.copy, 1);
  const save = gen5.open(img, det);
  assert.equal(slot0(save), slot0(gen5.open(readSave("black2-en"))));
  img[L.copySize + L.footer + 0xe] ^= 0xff;
  const both = gen5.detect(img);
  assert.equal(both.broken, true);
  assert.throws(() => gen5.open(img, both), (e) => e instanceof FormatError && /corrupted/.test(e.message));
});

test("gen5 copy selection: (d) a block corrupted in main only is read from the backup", () => {
  const L = gen5.LAYOUTS.BW;
  const img = mirrored();
  const before = allMons(gen5.open(img)).map((e) => hex(e.record));
  img[L.blocks[2].off + 5] ^= 0x01;              // box 2, main copy, CRC now wrong
  const save = gen5.open(img);
  assert.match(save.warnings.join(), /read from the backup/);
  assert.deepEqual(allMons(save).map((e) => hex(e.record)), before);
  // A main block that fails and a backup block that also fails: the game gives up.
  img[L.copySize + L.blocks[2].off + 5] ^= 0x01;
  assert.throws(() => gen5.open(img), /corrupted/);

  // The fixture's backup is an older, complete save (counter 1 < 2). Damage a block of main that the
  // backup holds differently: main's table cannot be satisfied, so the game falls back to the backup.
  const old = readSave("black-en");
  old[L.blocks[1].off + 5] ^= 0x01;
  const fb = gen5.open(old);
  assert.match(fb.warnings.join(), /falls back to the other, older copy/);
  assert.equal(fb.box(0).filter(Boolean).length, 0, "the backup's box 1 is the blank game's");
  assert.equal(fb.party().length, 0);
});

test("gen5 copy selection: (e) bad magic in both copies -> no save; counter wrap; intro save", () => {
  const L = gen5.LAYOUTS.B2W2;
  const img = mirrored("black2-en");
  setU32le(img, L.footer + 8, 0);
  setU32le(img, L.copySize + L.footer + 8, 0);
  assert.equal(gen5.detect(img), null);
  assert.throws(() => gen5.open(img, { layout: "B2W2", game: "B2", lang: "en" }), /empty/);

  // Main counter 0 vs backup 0xFFFFFFFF: main is the newer one (wrap-around).
  const w = mirrored();
  const BW = gen5.LAYOUTS.BW;
  w.set(pk5.emptyRecord(), BW.copySize + BW.blocks[1].off);
  fixBlock(w, BW, BW.copySize, 1);
  setU32le(w, BW.footer, 0); fixBlock(w, BW, 0, 1);
  setU32le(w, BW.copySize + BW.footer, 0xffffffff); fixBlock(w, BW, BW.copySize, 1);
  assert.notEqual(gen5.open(w).box(0)[0], null, "main wins over a wrapped backup counter");

  // isIntroSave = 1 makes the game treat the save as empty.
  const intro = mirrored();
  intro[BW.blocks[27].off + 0x2c] = 1;
  fixBlock(intro, BW, 0, 27);
  mirror(intro, BW);
  assert.throws(() => gen5.open(intro), /empty/);
});

test("gen5: a BW footer with a good CRC but unexpected size/magic still opens, with a warning", () => {
  const L = gen5.LAYOUTS.BW;
  const img = mirrored();
  for (const base of [0, L.copySize]) { setU32le(img, base + L.footer + 8, 0x12345678); fixBlock(img, L, base, 0); }
  const det = gen5.detect(img);
  assert.equal(det.layout, "BW");
  assert.ok(det.confidence < 0.9);
  assert.match(gen5.open(img, det).warnings.join(), /footer's size or magic/);
});

/* ---------- saves: writing ---------- */

test("gen5 black-en: PKHeX's modify ops (clear box 1 slot 10, take party 1, put a B2 record in box 24) give the same save", () => {
  const L = gen5.LAYOUTS.BW;
  const img = readSave("black-en"), ref = readSave("black-en.modified"), refExp = readJson("saves/black-en.modified.expected.json");
  const save = gen5.open(img);
  const reshiram = save.takeFromBox(0, 9);
  assert.equal(hex(reshiram.record), readJson("saves/black-en.expected.json").boxes.find((m) => m.box === 0 && m.slot === 9).recordHex);
  const snivy = save.takeFromParty(0);
  assert.equal(pk5.parse(snivy.record).species, 495);
  assert.deepEqual(save.putInBox(readRecord("pk5-oshawott-shell"), { format: "pk5", lang: "en", game: "B2" }, 23, 0), { box: 23, index: 0 });
  const out = save.serialize();
  assert.equal(out.length, 0x80000);

  // Same Pokémon everywhere as PKHeX's result.
  const re = gen5.open(out);
  assert.deepEqual(re.party().map((e) => hex(e.record)), refExp.party.map((m) => m.recordHex));
  assert.deepEqual(allMons(re).filter((e) => e.box !== undefined).map((e) => [e.box, e.slot, hex(e.record)]),
    refExp.boxes.map((m) => [m.box, m.slot, m.recordHex]));
  assert.deepEqual(re.pokedex(), refExp.pokedex);
  // Main-copy block data equals PKHeX's except where the game differs from PKHeX's editor:
  // the unlocked-box count (box 24 needs 24 unlocked boxes) and the vacated party slot, which the
  // game clears to the seed-0 encoding while PKHeX writes its blank entity's level and stats.
  const vacated = L.blocks[26].off + 8 + 2 * 220;
  L.blocks.forEach(({ off, size }, i) => {
    for (let k = off; k < off + size; k++) {
      if (out[k] === ref[k]) continue;
      const ok = (i === 0 && k === off + 0x3dd) || (i === 26 && k >= vacated + 0x88 && k < vacated + 220);
      assert.ok(ok, `block ${i} +0x${(k - off).toString(16)} differs from PKHeX`);
    }
  });
  assert.equal(out[L.blocks[0].off + 0x3dd], 24);
  assert.equal(hex(out.subarray(L.blocks[26].off + 8 + 2 * 220, L.blocks[26].off + 8 + 3 * 220)), hex(pk5.emptyPartySlot()));
  // Both copies written identically, valid, counters advanced; nothing else touched.
  assert.equal(hex(out.subarray(0, L.copySize)), hex(out.subarray(L.copySize, 2 * L.copySize)));
  assertCopyValid(out, L, 0);
  assert.equal(u32le(out, L.footer), u32le(img, L.footer) + 1);
  for (const i of [0, 1, 24, 26]) assert.equal(u16le(out, L.blocks[i].off + L.blocks[i].size), u16le(img, L.blocks[i].off + L.blocks[i].size) + 1, `block ${i} counter`);
  assert.equal(u16le(out, L.blocks[2].off + L.blocks[2].size), u16le(img, L.blocks[2].off + L.blocks[2].size), "untouched block counter");
  assert.equal(hex(out.subarray(2 * L.copySize)), hex(img.subarray(2 * L.copySize)), "bytes after the copies");
  // serialize() is repeatable.
  assert.equal(hex(save.serialize()), hex(out));
});

for (const s of SAVES.filter((x) => !x.id.includes("modified"))) {
  test(`gen5 ${s.id}: take -> put restores every Pokémon; only its block changes`, () => {
    const L = gen5.LAYOUTS[s.layout];
    const img = readSave(s.id);
    const save = gen5.open(img);
    let n = 0;
    for (const e of allMons(gen5.open(img)).filter((x) => x.box !== undefined)) {
      const t = save.takeFromBox(e.box, e.slot);
      assert.equal(hex(t.record), hex(e.record), e.where);
      assert.equal(save.box(e.box)[e.slot], null);
      assert.deepEqual(save.putInBox(t.record, t.meta, e.box, e.slot), { box: e.box, index: e.slot });
      n++;
    }
    assert.ok(n > 25);
    const out = save.serialize();
    // Box data identical; block 0 only gains the unlocked-box count the game needs for the last box.
    L.blocks.forEach(({ off, size }, i) => {
      for (let k = off; k < off + size; k++) if (out[k] !== img[k]) assert.ok(i === 0 && k === off + 0x3dd, `block ${i} +0x${(k - off).toString(16)}`);
    });
    assert.equal(hex(out.subarray(2 * L.copySize)), hex(img.subarray(2 * L.copySize)), "Key System, Memory Link, extras untouched");
    assertCopyValid(out, L, L.copySize);
  });

  test(`gen5 ${s.id}: party take shifts members down; the record goes back into a box`, () => {
    const save = gen5.open(readSave(s.id));
    const before = save.party();
    const t = save.takeFromParty(1);
    assert.equal(pk5.parse(t.record).species, before[1].view.species);
    const after = save.party();
    assert.equal(after.length, before.length - 1);
    assert.equal(hex(after[1].record), hex(before[2].record));
    const where = save.putInBox(t.record, t.meta);
    assert.deepEqual(where, { box: 0, index: 1 }, "first free slot from the current box");
    assert.equal(save.box(0)[1].view.species, before[1].view.species);
    assert.equal(save.box(0)[1].view.level, before[1].view.level);
    const re = gen5.open(save.serialize());
    assert.equal(re.party().length, before.length - 1);
    assert.equal(re.box(0)[1].view.species, before[1].view.species);
  });
}

test("gen5: refusals (last Pokémon, Bad Egg, fused Kyurem, mail, wrong format, B2W2-only forms, full and taken slots)", () => {
  const save = gen5.open(readSave("black-en"));
  save.takeFromParty(0); save.takeFromParty(0);
  assert.throws(() => save.takeFromParty(0), /last Pokémon/);
  assert.throws(() => save.takeFromParty(3), /no Pokémon in party slot 4/);
  assert.throws(() => save.takeFromBox(0, 1), /empty/);
  assert.throws(() => save.takeFromBox(24, 0), /no box 25/);
  assert.throws(() => save.takeFromBox(0, 30), /30 slots/);

  const rec = readRecord("pk5-oshawott-shell"), meta = { format: "pk5", lang: "en", game: "B2" };
  assert.throws(() => save.putInBox(rec, { format: "pk4" }), /converted/);
  assert.throws(() => save.putInBox(rec.subarray(0, 80), meta), /not a Generation 5/);
  assert.throws(() => save.putInBox(rec, meta, 0, 0), /not empty/);
  const bad = rec.slice(); bad[0x40] ^= 1;
  assert.throws(() => save.putInBox(bad, meta), /Bad Egg/);
  const f = pk5.parse(rec);
  assert.throws(() => save.putInBox(pk5.build({ ...f, heldItem: 137 }), meta), /mail/);
  assert.throws(() => save.putInBox(pk5.build({ ...f, heldItem: 638 }), meta), /Held item 638|does not exist in Black/);
  const kyurem = pk5.parse(fromHex(readJson("saves/black2-en.expected.json").boxes.find((m) => m.species === 646).recordHex));
  assert.throws(() => save.putInBox(pk5.build({ ...kyurem, form: 1, ability: 163 }), meta), /Fused Kyurem/);
  const landorus = { ...kyurem, species: 645, form: 1, ability: 159 };
  assert.throws(() => save.putInBox(pk5.build(landorus), meta), /Black 2 and White 2/);
  assert.ok(gen5.open(readSave("black2-en")).putInBox(pk5.build(landorus), meta), "Therian forms are fine in B2W2");

  // A fused Kyurem or a Bad Egg already in a box cannot be taken.
  const L = gen5.LAYOUTS.B2W2, img = readSave("black2-en");
  const k = readJson("saves/black2-en.expected.json").boxes.find((m) => m.species === 646);
  const o = L.blocks[1 + k.box].off + k.slot * 136;
  img.set(pk5.build({ ...kyurem, form: 2, ability: 164 }), o);
  img[L.blocks[1].off + 0x40] ^= 1;               // box 1 slot 0 becomes a Bad Egg
  fixBlock(img, L, 0, 1 + k.box); fixBlock(img, L, 0, 1);
  const b2 = gen5.open(img);
  assert.throws(() => b2.takeFromBox(k.box, k.slot), /Fused Kyurem/);
  assert.throws(() => b2.takeFromBox(0, 0), /Bad Egg/);
  assert.equal(b2.box(0)[0].view.checksumOk, false);

  // A slot that decrypts to species 0 but fails its checksum is a Bad Egg, not a free slot.
  const z = readSave("black-en"), BW = gen5.LAYOUTS.BW;
  z[BW.blocks[1].off + 136 + 0x30] ^= 0x10;       // box 1 slot 1 (empty) damaged
  fixBlock(z, BW, 0, 1);
  const zs = gen5.open(z);
  assert.equal(zs.box(0)[1].view.isEgg, true);
  assert.equal(zs.box(0)[1].view.checksumOk, false);
  assert.throws(() => zs.takeFromBox(0, 1), /Bad Egg/);
  assert.throws(() => zs.putInBox(rec, meta, 0, 1), /not empty/);
  assert.deepEqual(zs.putInBox(rec, meta, 0), { box: 0, index: 2 });

  // Box 24 of 24 full: putInBox(record, meta, 23) refuses; the full search ends with an error.
  const full = gen5.open(readSave("black-en"));
  for (let i = 0; i < 30; i++) if (!full.box(23)[i]) full.putInBox(rec, meta, 23, i);
  assert.throws(() => full.putInBox(rec, meta, 23), /Box 24 is full/);
});

test("gen5: putInBox searches from the current box and unlocks boxes in steps of 8", () => {
  const L = gen5.LAYOUTS.B2W2, img = mirrored("black2-en");
  img[L.blocks[0].off + 0x3dd] = 8;
  setU32le(img, L.blocks[0].off, 7);              // current box 8
  fixBlock(img, L, 0, 0); mirror(img, L);
  const save = gen5.open(img);
  assert.equal(save.currentBox, 7);
  assert.equal(save.boxesUnlocked, 8);
  const rec = readRecord("pk5-larvesta-egg"), meta = { format: "pk5", lang: "en", game: "B" };
  assert.deepEqual(save.putInBox(rec, meta), { box: 7, index: 0 });
  for (let n = 1; n < 30; n++) save.putInBox(rec, meta);
  assert.deepEqual(save.putInBox(rec, meta), { box: 0, index: 1 }, "wraps to box 1");
  assert.deepEqual(save.putInBox(rec, meta, 12), { box: 12, index: 0 });
  assert.equal(save.boxesUnlocked, 16);
  const out = save.serialize();
  assert.equal(out[L.blocks[0].off + 0x3dd], 16);
  assertCopyValid(out, L);
  // PP is restored when a Pokémon is boxed, as the PC does.
  const tired = pk5.parse(readRecord("pk5-oshawott-shell"));
  const s2 = gen5.open(readSave("black2-en"));
  const at = s2.putInBox(pk5.build({ ...tired, pp: [0, 0, 0, 0] }), meta);
  assert.deepEqual(s2.box(at.box)[at.index].view.moves.map((m) => m.pp), pk5.toView(tired).moves.map((m) => m.pp));
});

/* ---------- Pokédex (§7.5) ---------- */

/** Fixture image with the Pokédex bits cleared (magic, flags, Spinda PID kept), CRCs fixed. */
function blankDex(id) {
  const L = gen5.LAYOUTS[id.startsWith("black2") ? "B2W2" : "BW"];
  const img = readSave(id), dx = L.blocks[L.dexBlock];
  img.fill(0, dx.off + 8, dx.off + dx.size - 4);
  fixBlock(img, L, 0, L.dexBlock);
  return { img, L, dx };
}

for (const id of ["black-en", "black2-en", "black-ja"]) {
  test(`gen5 ${id}: registering every fixture Pokémon reproduces PKHeX's Pokédex bits`, () => {
    const { img, L, dx } = blankDex(id);
    const ref = readSave(id);
    const save = gen5.open(img);
    for (const e of allMons(gen5.open(ref))) {
      if (!e.view.isEgg) save.registerDex(e.view.species, { form: e.view.form, shiny: e.view.shiny, lang: e.view.lang, pid: e.view.pid });
    }
    const out = save.serialize();
    // PKHeX sets one seen-form bit for Darmanitan; the game sets every form bit of Castform,
    // Cherrim, Darmanitan and Meloetta (format-gen5.md §7.5 step 6). Darmanitan is bits 68-69.
    const allForms = new Set([dx.off + 0x2fc + 8]);
    for (let k = dx.off; k < dx.off + dx.size; k++) {
      if (out[k] === ref[k]) continue;
      assert.ok(allForms.has(k) && (out[k] & ~ref[k]) === 0x20, `dex +0x${(k - dx.off).toString(16)}: ${ref[k]} vs ${out[k]}`);
    }
    assertCopyValid(out, L);
  });
}

test("gen5: registerDex follows the game's procedure (sex from PID, shown lists, forms, language, Spinda)", () => {
  const { img, L, dx } = blankDex("black2-en");
  const save = gen5.open(img);
  const D0 = dx.off, F = 11;
  const seen = (k, sp) => getFlag(save.serialize(), D0 + 0x5c + k * 0x54, sp - 1);
  const shown = (out, k, sp) => getFlag(out, D0 + 0x1ac + k * 0x54, sp - 1);
  // Spinda (female ratio 127): PID low byte 0x10 < 127 -> female, so list 1; shiny -> list 3.
  save.registerDex(327, { pid: 0xabcd0010, shiny: true, lang: "ko", gender: "M" });
  let out = save.serialize();
  assert.equal(getFlag(out, D0 + 0x5c + 3 * 0x54, 326), 1, "seen shiny female (sex from the PID, not the gender option)");
  assert.deepEqual([0, 1, 2, 3].map((k) => shown(out, k, 327)), [0, 0, 0, 1]);
  assert.equal(getFlag(out, D0 + 8, 326), 1, "caught");
  assert.equal(getFlag(out, D0 + 0x2fc + 4 * F, 326 * 7 + 6), 1, "Korean language bit");
  assert.equal(u32le(out, D0 + dx.size - 4), 0xabcd0010, "Spinda PID");
  // A second sighting adds a seen bit but keeps the shown choice and the first Spinda PID.
  save.registerDex(327, { pid: 0x000000ff, lang: "en" });
  out = save.serialize();
  assert.equal(seen(0, 327), 1);
  assert.deepEqual([0, 1, 2, 3].map((k) => shown(out, k, 327)), [0, 0, 0, 1]);
  assert.equal(u32le(out, D0 + dx.size - 4), 0xabcd0010);
  assert.equal(getFlag(out, D0 + 0x2fc + 4 * F, 326 * 7 + 1), 1, "English bit");
  // Forms: Deerling autumn (base 58) -> seen-form bit 60 and shown-form bit 60; Castform sets all four (52-55).
  save.registerDex(585, { form: 2, gender: "F" });
  save.registerDex(351, { form: 1 });
  save.registerDex(646, { form: 2 });                // B2W2 Kyurem: base 72
  out = save.serialize();
  const formBit = (list, bit) => getFlag(out, D0 + 0x2fc + list * F, bit);
  assert.equal(formBit(0, 60), 1); assert.equal(formBit(2, 60), 1);
  assert.deepEqual([52, 53, 54, 55].map((b) => formBit(0, b)), [1, 1, 1, 1]);
  assert.equal(formBit(2, 53), 1, "shown form is the registered one");
  assert.equal(formBit(0, 74), 1);
  assert.equal(getFlag(out, D0 + 0x5c + 0x54, 584), 1, "Deerling seen female (gender option without a PID)");
  assert.equal(getFlag(out, D0 + 0x2fc + 4 * F, 584 * 7 + 1), 0, "no language bits past species 493");
  assert.equal(save.registerDex(650), false);
  assert.ok(gen5.open(out).pokedex().caught.includes(585));
  assertCopyValid(out, L);
  // Black/White have no Kyurem form bits: only the species bits change.
  const bw = blankDex("black-en");
  const s = gen5.open(bw.img);
  s.registerDex(646, { form: 1 });
  const o2 = s.serialize();
  assert.equal(hex(o2.subarray(bw.dx.off + 0x2fc, bw.dx.off + 0x2fc + 36)), hex(bw.img.subarray(bw.dx.off + 0x2fc, bw.dx.off + 0x2fc + 36)));
  assert.equal(getFlag(o2, bw.dx.off + 8, 645), 1);
});

test("gen5: Japanese save text, record meta and dates", () => {
  const save = gen5.open(readSave("black-ja"));
  assert.equal(save.boxName(0), "ボックス１");
  assert.equal(save.trainer.name, "トウヤ");
  const tepig = save.party()[0];
  assert.equal(tepig.view.nickname, "ポカ");
  assert.equal(tepig.meta.lang, "ja");
  const english = allMons(save).find((e) => e.view.lang === "en");
  assert.ok(english, "the English Deerling");
  assert.match(english.view.met.date, /^20\d\d-\d\d-\d\d$/);
  assert.equal(decrypt45(tepig.record).length, 136);
});

test("gen5: Node Buffers in, caller's bytes untouched, plain 0x80000-byte image out", () => {
  const buf = fs.readFileSync(path.join(dir, "saves", "black2-en.sav"));
  const copy = Buffer.from(buf);
  const save = gen5.open(buf);
  const t = save.takeFromBox(0, 0);
  save.putInBox(Buffer.from(t.record), t.meta, 3, 3);
  const out = save.serialize();
  assert.ok(buf.equals(copy));
  assert.equal(out.constructor, Uint8Array);
  assert.equal(out.length, 0x80000);
  const rec = Buffer.from(readRecord("pk5-ja-tepig")), before = Buffer.from(rec);
  pk5.toView(pk5.parse(rec)); pk5.validate(rec); pk5.isEmpty(rec);
  assert.ok(rec.equals(before));
});

test("pk5: receiveTrade applies the link-trade side effects", () => {
  const date = new Date(2026, 9, 24);
  const snivy = pk5.parse(readRecord("pk5-snivy-hidden-ability"));
  const g = pk5.parse(pk5.build(pk5.receiveTrade({ ...snivy, friendship: 255, pp: [0, 0, 0, 0] }, { date })));
  assert.equal(g.friendship, 70);
  assert.deepEqual(g.pp, pk5.restorePP(snivy).pp);
  assert.deepEqual([g.metLocation, g.metDate], [snivy.metLocation, snivy.metDate], "non-egg met data kept");
  const egg = pk5.parse(readRecord("pk5-larvesta-egg"));
  const e = pk5.receiveTrade(egg, { date });
  assert.deepEqual([e.friendship, e.metLocation, e.metDate], [egg.friendship, 30003, [26, 10, 24]]);
  const sky = pk5.receiveTrade({ ...snivy, species: 492, form: 1, ability: 32, hiddenAbility: false }, { date });
  assert.deepEqual([sky.form, sky.ability], [0, 30]);
  assert.ok(pk5.validate(pk5.build(sky)).ok);
});
