// Gen 4 saves (shared/saves/gen4.js) against the PKHeX-derived fixtures: detection, contents, write-back
// (both strategies), the games' copy selection (format-gen4.md §6, §19.2), Pokédex registration (§15.3),
// the Platinum PC port layout (§17.1) and robustness. No .NET needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import * as G4 from "../shared/saves/gen4.js";
import * as P from "../shared/pkm/pk4.js";
import { unwrap, rebuild } from "../shared/saves/container.js";
import { FormatError, crc16ccitt, u32le, u16le, setU32le, setU16le } from "../shared/bytes.js";

const FIX = new URL("./fixtures/", import.meta.url);
const sav = (id) => new Uint8Array(readFileSync(new URL(`saves/${id}.sav`, FIX)));
const expected = (id) => JSON.parse(readFileSync(new URL(`saves/${id}.expected.json`, FIX)));
const recordHex = (name) => readFileSync(new URL(`records/${name}.hex`, FIX), "utf8").trim();
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const toHex = (b) => Buffer.from(b).toString("hex");
const PART = 0x40000;

const FIXTURES = [
  { id: "diamond-en", game: "D", lang: "en", layout: "DP" },
  { id: "platinum-en", game: "Pt", lang: "en", layout: "Pt" },
  { id: "platinum-ja", game: "Pt", lang: "ja", layout: "Pt" },
  { id: "heartgold-en", game: "HG", lang: "en", layout: "HGSS" },
  { id: "heartgold-ko", game: "HG", lang: "ko", layout: "HGSS" },
  { id: "platinum-en.modified", game: "Pt", lang: "en", layout: "Pt" },
];

/** Byte ranges [start, end) where a and b differ. */
function diffs(a, b) {
  const out = [];
  for (let i = 0, s = -1; i <= a.length; i++) {
    const d = i < a.length && a[i] !== b[i];
    if (d && s < 0) s = i;
    if (!d && s >= 0) { out.push([s, i]); s = -1; }
  }
  return out;
}
/** Every differing byte lies inside one of the allowed [start, end) ranges. */
function onlyChanged(a, b, allowed, msg) {
  for (const [s, e] of diffs(a, b)) {
    for (let i = s; i < e; i++) assert.ok(allowed.some(([x, y]) => i >= x && i < y), `${msg}: unexpected change at 0x${i.toString(16)}`);
  }
}
const blockStart = (L, part, kind) => part * PART + (kind ? L.storageStart : 0);
const blockSize = (L, kind) => (kind ? L.storageSize : L.generalSize);
/** Rewrites footer counters of one block and refreshes its CRC, as a game save would. */
function setFooter(img, L, part, kind, { saveCounter, blockCounter, count } = {}) {
  const start = blockStart(L, part, kind), size = blockSize(L, kind), end = start + size;
  if (L.footer === 0x10) { if (count != null) setU32le(img, end - 0x10, count); }
  else {
    if (saveCounter != null) setU32le(img, end - 0x14, saveCounter);
    if (blockCounter != null) setU32le(img, end - 0x10, blockCounter);
  }
  setU16le(img, end - 2, crc16ccitt(img, start, size - L.footer));
}
const fixCrc = (img, L, part, kind) => setFooter(img, L, part, kind);
const crcOk = (img, L, part, kind) => {
  const start = blockStart(L, part, kind), size = blockSize(L, kind);
  return crc16ccitt(img, start, size - L.footer) === u16le(img, start + size - 2);
};
const slotOffset = (L, part, b, s) => blockStart(L, part, 1) + L.boxes + b * L.stride + s * 0x88;
const openFixture = (id, opts) => { const img = sav(id); return G4.open(img, G4.detect(img), opts); };

/* ---------- detection and contents ---------- */

test("detect identifies every Gen 4 fixture with its game, language and layout", () => {
  for (const f of FIXTURES) {
    const d = G4.detect(sav(f.id));
    assert.ok(d, f.id);
    assert.deepEqual([d.gen, d.game, d.lang, d.layout, d.port], [4, f.game, f.lang, f.layout, false], f.id);
    assert.ok(d.confidence >= 0.9, f.id);
    assert.ok(d.status === "OK" || d.status === "IS_GOOD", f.id);
  }
});

test("trainer, party, every box slot, box names, current box and Pokédex match PKHeX", () => {
  for (const f of FIXTURES) {
    const ex = expected(f.id), s = openFixture(f.id);
    assert.deepEqual([s.gen, s.format, s.game, s.lang, s.boxCount, s.boxCapacity], [4, "pk4", f.game, f.lang, ex.boxCount, ex.boxSlotCount], f.id);
    assert.equal(s.readOnly, null, f.id);
    const t = ex.trainer;
    assert.deepEqual(s.trainer, { name: t.name, gender: ["M", "F"][t.gender], tid: t.tid, sid: t.sid, money: t.money, playTime: t.playTime, badges: 0 }, f.id);
    assert.equal(s.currentBox, ex.currentBox, f.id);
    assert.deepEqual(Array.from({ length: 18 }, (_, i) => s.boxName(i)), ex.boxNames, f.id);
    assert.deepEqual(s.pokedex(), ex.pokedex, f.id);

    const party = s.party();
    assert.equal(party.length, ex.partyCount, f.id);
    party.forEach((e, i) => {
      const m = ex.party[i];
      assert.equal(toHex(e.record), m.recordHex, `${f.id} party ${i}`);
      assert.deepEqual(e.meta, { format: "pk4", lang: f.lang, game: f.game });
      assert.deepEqual([e.view.species, e.view.nickname, e.view.level, e.view.isEgg, e.view.stats?.hp], [m.species, m.nickname, m.level, m.isEgg, m.partyStats.hpMax]);
    });

    let used = 0;
    for (let b = 0; b < 18; b++) {
      const box = s.box(b);
      assert.equal(box.length, 30);
      box.forEach((e, i) => {
        const m = ex.boxes.find((x) => x.box === b && x.slot === i);
        assert.equal(!!e, !!m, `${f.id} box ${b} slot ${i}`);
        if (!e) return;
        used++;
        assert.equal(toHex(e.record), m.recordHex, `${f.id} box ${b} slot ${i}`);
        assert.deepEqual([e.view.species, e.view.form, e.view.nickname, e.view.level, e.view.isEgg, e.view.shiny],
          [m.species, m.form, m.nickname, m.level, m.isEgg, m.isShiny], `${f.id} box ${b} slot ${i}`);
      });
    }
    assert.equal(used, ex.boxSlotsUsed, f.id);
  }
});

test("serialize() of an untouched save returns the original bytes (both strategies)", () => {
  for (const f of FIXTURES) {
    const img = sav(f.id), s = G4.open(img, G4.detect(img));
    s.party(); s.box(0); s.pokedex();
    assert.deepEqual(s.serialize(), img, f.id);
    assert.deepEqual(s.serialize({ strategy: "newSave" }), img, f.id);
  }
});

/* ---------- write-back ---------- */

const PT_OPS = (s) => {
  s.takeFromBox(0, 9);
  s.takeFromParty(2);
  return s.putInBox(fromHex(recordHex("pk4-turtwig-shelly")), { format: "pk4", lang: "en", game: "D" }, 4, 29);
};

test("Platinum take/put reproduces platinum-en.modified.sav (in place, like PKHeX)", () => {
  const img = sav("platinum-en"), mod = sav("platinum-en.modified"), L = G4.LAYOUTS.Pt;
  const s = G4.open(img, G4.detect(img));
  assert.deepEqual(PT_OPS(s), { box: 4, index: 29, notes: [] });
  const out = s.serialize();
  // The only differences from PKHeX: the vacated party slot's battle part (PKHeX writes level-1 stats for its blank,
  // the game's Pokemon_Init writes zeros) and therefore the general block's CRC.
  const vacated = L.party + 4 + 2 * 0xec;
  onlyChanged(out, mod, [[vacated + 0x88, vacated + 0xec], [L.generalSize - 2, L.generalSize]], "vs PKHeX");
  assert.deepEqual(out.subarray(vacated, vacated + 0xec), P.emptyPartyRecord());
  assert.deepEqual(out.subarray(vacated, vacated + 0x88), mod.subarray(vacated, vacated + 0x88));
  for (const [part, kind] of [[0, 0], [0, 1], [1, 0], [1, 1]]) assert.ok(crcOk(out, L, part, kind));
  assert.deepEqual(out.subarray(PART), img.subarray(PART), "partition B untouched");
  // Re-opened, it holds what PKHeX's modified save holds.
  const ex = expected("platinum-en.modified"), re = G4.open(out, G4.detect(out));
  assert.deepEqual(re.party().map((e) => toHex(e.record)), ex.party.map((m) => m.recordHex));
  const boxes = [];
  for (let b = 0; b < 18; b++) re.box(b).forEach((e, i) => e && boxes.push([b, i, toHex(e.record)]));
  assert.deepEqual(boxes, ex.boxes.map((m) => [m.box, m.slot, m.recordHex]));
  assert.deepEqual(re.pokedex(), ex.pokedex);
});

test("newSave strategy writes both blocks into the next partitions with saveCounter/blockCounter + 1", () => {
  const img = sav("platinum-en"), L = G4.LAYOUTS.Pt;
  const s = G4.open(img, G4.detect(img), { writeStrategy: "newSave" });
  assert.equal(s.writeStrategy, "newSave");
  PT_OPS(s);
  const out = s.serialize();
  assert.deepEqual(out.subarray(0, PART), img.subarray(0, PART), "the loaded copies stay as the backup");
  for (const kind of [0, 1]) {
    const end = blockStart(L, 1, kind) + blockSize(L, kind);
    assert.deepEqual([u32le(out, end - 0x14), u32le(out, end - 0x10)], [3, 3]);
    assert.ok(crcOk(out, L, 1, kind));
  }
  const re = G4.open(out, G4.detect(out));
  assert.deepEqual([re.loadStatus, re.copies], ["OK", { general: 1, storage: 1 }]);
  const inPlace = G4.open(img, G4.detect(img));
  PT_OPS(inPlace);
  const ref = G4.open(inPlace.serialize(), G4.detect(inPlace.serialize()));
  assert.deepEqual(re.party().map((e) => toHex(e.record)), ref.party().map((e) => toHex(e.record)));
  for (let b = 0; b < 18; b++) assert.deepEqual(re.box(b).map((e) => e && toHex(e.record)), ref.box(b).map((e) => e && toHex(e.record)));
  // Blocks outside the general and storage blocks (Hall of Fame and the rest) are never touched.
  onlyChanged(out, img, [[PART, PART + L.storageStart + L.storageSize]], "newSave");
  assert.throws(() => { s.writeStrategy = "both"; }, FormatError);
});

test("DP and HGSS take/put: slot, party and footer changes only where expected", () => {
  const cases = [
    { id: "diamond-en", put: ["pk4-hgss-pikachu-fastball", 3, 7], box: [0, 4], party: 0 },
    { id: "heartgold-en", put: ["pk4-giratina-origin", 17, 0], box: [0, 9], party: 1 },
    { id: "heartgold-ko", put: ["pk4-giratina-origin", 17, 0], box: [0, 9], party: 1 },
  ];
  for (const c of cases) {
    const img = sav(c.id), s = G4.open(img, G4.detect(img)), L = G4.LAYOUTS[s.layout];
    const before = s.party().map((e) => toHex(e.record));
    const taken = s.takeFromBox(...c.box);
    assert.equal(toHex(taken.record), expected(c.id).boxes.find((m) => m.box === c.box[0] && m.slot === c.box[1]).recordHex);
    assert.equal(toHex(s.takeFromParty(c.party).record), before[c.party]);
    const rec = fromHex(recordHex(c.put[0]));
    assert.deepEqual(s.putInBox(rec, { format: "pk4" }, c.put[1], c.put[2]), { box: c.put[1], index: c.put[2], notes: [] });
    const out = s.serialize();
    const S = L.storageStart, n = before.length;
    const allowed = [
      [L.party, L.party + 4 + 6 * 0xec], [L.generalSize - 2, L.generalSize],
      [slotOffset(L, 0, ...c.box), slotOffset(L, 0, ...c.box) + 0x88],
      [slotOffset(L, 0, c.put[1], c.put[2]), slotOffset(L, 0, c.put[1], c.put[2]) + 0x88],
      [S + L.storageSize - 2, S + L.storageSize],
    ];
    if (L.aprijuice) allowed.push([L.aprijuice, L.aprijuice + 30]);
    if (L.modified) allowed.push([S + L.modified, S + L.modified + 4]);
    onlyChanged(out, img, allowed, c.id);
    const re = G4.open(out, G4.detect(out));
    assert.deepEqual(re.party().map((e) => toHex(e.record)), before.filter((_, i) => i !== c.party), `${c.id} party closes up`);
    assert.equal(u32le(out, L.party), n - 1);
    assert.deepEqual(out.subarray(L.party + 4 + (n - 1) * 0xec, L.party + 4 + n * 0xec), P.emptyPartyRecord());
    assert.deepEqual(out.subarray(slotOffset(L, 0, ...c.box), slotOffset(L, 0, ...c.box) + 0x88), P.emptyRecord());
    assert.equal(toHex(re.box(c.put[1])[c.put[2]].record), toHex(rec));
    if (L.modified) assert.equal(u32le(out, S + L.modified), (1 << c.box[0]) | (1 << c.put[1]), "HGSS box-modified mask");
    for (const kind of [0, 1]) assert.ok(crcOk(out, L, 0, kind));
  }
});

test("HGSS: per-box padding is preserved and newSave writes both blocks to the other partition with count + 1", () => {
  const img = sav("heartgold-en"), L = G4.LAYOUTS.HGSS;
  const s = G4.open(img, G4.detect(img), { writeStrategy: "newSave" });
  s.takeFromBox(1, 3);
  const out = s.serialize();
  for (let b = 0; b < 18; b++) {
    const pad = blockStart(L, 1, 1) + b * 0x1000 + 0xff0;
    assert.deepEqual(out.subarray(pad, pad + 16), img.subarray(blockStart(L, 0, 1) + b * 0x1000 + 0xff0, blockStart(L, 0, 1) + b * 0x1000 + 0x1000));
  }
  for (const kind of [0, 1]) {
    const end = blockStart(L, 1, kind) + blockSize(L, kind);
    assert.equal(u32le(out, end - 0x10), 3);
    assert.ok(crcOk(out, L, 1, kind));
  }
  assert.equal(u32le(out, blockStart(L, 1, 1) + L.modified), 1 << 1);
  assert.deepEqual(out.subarray(0, PART), img.subarray(0, PART));
  const re = G4.open(out, G4.detect(out));
  assert.deepEqual([re.loadStatus, re.copies], ["IS_GOOD", { general: 1, storage: 1 }]);
  assert.equal(re.box(1)[3], null);
});

test("take -> put round trips restore the Pokémon (box slots and party members)", () => {
  for (const f of FIXTURES.filter((x) => !x.id.includes("modified"))) {
    const img = sav(f.id), s = G4.open(img, G4.detect(img)), L = G4.LAYOUTS[s.layout];
    const occupied = [];
    for (let b = 0; b < 18; b++) s.box(b).forEach((e, i) => e && occupied.push([b, i]));
    for (const [b, i] of occupied) {
      const { record, meta } = s.takeFromBox(b, i);
      assert.equal(s.box(b)[i], null);
      assert.deepEqual(s.putInBox(record, meta, b, i), { box: b, index: i, notes: [] });
    }
    const out = s.serialize();
    if (L.modified) {
      const m = L.storageStart + L.modified;
      onlyChanged(out, img, [[m, m + 4], [L.storageStart + L.storageSize - 2, L.storageStart + L.storageSize]], f.id);
    } else assert.deepEqual(out, img, f.id);
    // A party member goes into the first free box slot and comes back out with the same box data.
    const t = G4.open(img, G4.detect(img));
    const want = t.party()[1], firstFree = t.box(0).indexOf(null);
    const { record, meta } = t.takeFromParty(1);
    const put = t.putInBox(record, meta);
    assert.deepEqual(put, { box: 0, index: firstFree, notes: [] }, f.id);
    assert.equal(toHex(t.box(put.box)[put.index].record), toHex(want.record), f.id);
    assert.equal(t.box(put.box)[put.index].view.nickname, want.view.nickname);
  }
});

test("put/take refuse what the game would not do, with player-facing errors", () => {
  const s = openFixture("platinum-en");
  const rec = fromHex(recordHex("pk4-turtwig-shelly"));
  assert.throws(() => s.putInBox(rec, { format: "pk4" }, 0, 9), /not empty/);
  assert.throws(() => s.putInBox(rec, { format: "pk5" }), /convert/);
  assert.throws(() => s.putInBox(new Uint8Array(80), { format: "pk4" }), FormatError);
  assert.throws(() => s.putInBox(P.emptyRecord(), { format: "pk4" }), FormatError);
  assert.throws(() => s.putInBox(rec, { format: "pk4" }, 18, 0), /no box 19/);
  assert.throws(() => s.putInBox(rec, { format: "pk4" }, 0, 30), /no slot 31/);
  assert.throws(() => s.takeFromBox(0, 1), /empty/);
  assert.throws(() => s.takeFromParty(5), /party slot 6/);
  const spiky = P.parse(rec); spiky.species = 172; spiky.form = 1;
  assert.throws(() => s.putInBox(P.build(spiky), { format: "pk4" }), /Spiky-eared/);
  // First free slot: box 1 slot 2 (slot 1 holds the egg).
  assert.deepEqual(s.putInBox(rec, { format: "pk4" }), { box: 0, index: 1, notes: [] });
  // Fill box 18 and the in-box search reports it.
  for (let i = 0; i < 30; i++) if (!s.box(17)[i]) s.putInBox(rec, { format: "pk4" }, 17);
  assert.throws(() => s.putInBox(rec, { format: "pk4" }, 17), /Box 18 is full/);
  // Party: the last non-egg Pokémon stays.
  s.takeFromParty(0); s.takeFromParty(0);
  assert.throws(() => s.takeFromParty(0), /at least one/);
  // Notes report what storing changed.
  const shaymin = P.parse(rec); shaymin.species = 492; shaymin.form = 1; shaymin.ability = 30; shaymin.pp = [0, 0, 0, 0];
  const r = s.putInBox(P.build(shaymin), { format: "pk4" });
  assert.equal(r.notes.length, 1);
  const stored = P.parse(s.box(r.box)[r.index].record);
  assert.deepEqual([stored.form, stored.pp], [0, P.parse(rec).pp]);
});

test("a party member holding mail is refused", () => {
  const img = sav("diamond-en"), L = G4.LAYOUTS.DP;
  const o = L.party + 4;
  const f = P.parse(img.slice(o, o + 0xec));
  f.heldItem = 140;
  img.set(P.build(f), o);
  fixCrc(img, L, 0, 0);
  const s = G4.open(img, G4.detect(img));
  assert.throws(() => s.takeFromParty(0), /mail/);
});

/* ---------- Pokédex ---------- */

const dexBase = (s) => G4.LAYOUTS[s.layout].dex;
const bit1 = (img, o, n) => (img[o + ((n - 1) >> 3)] >> ((n - 1) & 7)) & 1;

test("registerDex sets seen, caught, genders, Spinda's PID and the language bit like Pokedex_Capture", () => {
  for (const id of ["diamond-en", "platinum-en", "heartgold-en", "heartgold-ko"]) {
    const s = openFixture(id), d = dexBase(s);
    assert.equal(s.registerDex(327, { gender: "F", lang: "fr", pid: 0xdeadbeef }), true);
    assert.equal(s.registerDex(327, { gender: "M", lang: "es", pid: 1 }), true);
    assert.equal(s.registerDex(0), false);
    assert.equal(s.registerDex(494), false);
    assert.equal(s.registerDex(25, { isEgg: true }), false);
    const out = s.serialize();
    const re = G4.open(out, G4.detect(out));
    assert.ok(re.pokedex().seen.includes(327) && re.pokedex().caught.includes(327), id);
    assert.deepEqual([bit1(out, d + 0x84, 327), bit1(out, d + 0xc4, 327)], [1, 0], `${id}: first female, then male`);
    assert.equal(u32le(out, d + 0x104), 0xdeadbeef, `${id}: Spinda PID from the first sighting`);
    const fam = G4.LAYOUTS[s.layout].family;
    if (fam === "Pt") assert.equal(out[d + 0x128 + 327], (1 << 2) | (1 << 5), "French bit 2, Spanish bit 5 (pret, not PKHeX)");
    if (fam === "HGSS") {
      assert.equal(out[d + 0x144 + 327], (1 << 2) | (1 << 5));
      assert.equal(out[d + 0x335], 1, "foreign language enables the international view");
    }
    if (fam === "DP") assert.deepEqual(out.subarray(d + 0x129, d + 0x137), sav(id).subarray(d + 0x129, d + 0x137), "Spinda is no meister species");
    onlyChanged(out, sav(id), [[d, d + 0x340], [G4.LAYOUTS[s.layout].generalSize - 2, G4.LAYOUTS[s.layout].generalSize]], id);
  }
  // DP keeps languages only for the 14 meister species; Korean sets no bit anywhere.
  const dp = openFixture("diamond-en"), d = dexBase(dp);
  dp.registerDex(25, { gender: "M", lang: "de" });
  dp.registerDex(129, { gender: "M", lang: "ko" });
  const out = dp.serialize();
  assert.equal(out[d + 0x129 + 1], sav("diamond-en")[d + 0x129 + 1] | (1 << 3), "Pikachu German bit");
  assert.equal(out[d + 0x129 + 5], sav("diamond-en")[d + 0x129 + 5], "Korean Magikarp: no bit");
});

/** A Pokédex as Pokedex_Init leaves it (magic, empty form lists), big enough for every game. */
function freshDex() {
  const img = new Uint8Array(0x400);
  setU32le(img, 0, 0xbeefcafe);
  img.fill(0xff, 0x108, 0x128);   // Shellos/Gastrodon/Burmy/Wormadam orders + Unown seen list
  img.fill(0xff, 0x128, 0x144);   // HGSS Unown caught list
  img[0x43] = img[0x83] = 0xff;   // Deoxys nibbles
  setU32le(img, 0x31c, 0xffffffff); img[0x320] = img[0x321] = 0xff;            // Pt Rotom, Shaymin, Giratina
  setU32le(img, 0x338, 0xffffffff); img[0x33c] = img[0x33d] = img[0x33e] = 0xff; // HGSS
  return img;
}

test("Pokédex form tracking follows the 2-form, 3-form, Deoxys, Rotom, Unown and Pichu schemes", () => {
  const reg = (img, fam, sp, opt) => G4.registerDex(img, 0, fam, sp, { langByte: 2, gameLangByte: 2, ...opt });
  let x = freshDex();
  reg(x, "Pt", 422, { form: 1 });
  assert.equal(x[0x108] & 3, 0b11, "first sighting writes the form into both bits");
  reg(x, "Pt", 422, { form: 0 });
  assert.equal(x[0x108] & 3, 0b01, "second form goes to bit 1");
  reg(x, "Pt", 422, { form: 1 });
  assert.equal(x[0x108] & 3, 0b01, "already seen: unchanged");
  reg(x, "Pt", 412, { form: 2 }); reg(x, "Pt", 412, { form: 0 }); reg(x, "Pt", 412, { form: 2 }); reg(x, "Pt", 412, { form: 1 });
  assert.equal(x[0x10a], 0b00_01_00_10 | 0xc0, "Burmy slots: Trash, Plant, Sandy");
  reg(x, "Pt", 386, { form: 2 }); reg(x, "Pt", 386, { form: 0 }); reg(x, "Pt", 386, { form: 2 }); reg(x, "Pt", 386, { form: 3 }); reg(x, "Pt", 386, { form: 1 });
  assert.deepEqual([x[0x43], x[0x83]], [0x02, 0x13], "Deoxys nibbles 2, 0 | 3, 1");
  reg(x, "Pt", 479, { form: 3 }); reg(x, "Pt", 479, { form: 1 }); reg(x, "Pt", 479, { form: 3 });
  assert.equal(u32le(x, 0x31c) & 0x3f, 3 | (1 << 3), "Rotom: Frost then Wash");
  reg(x, "Pt", 201, { form: 26 }); reg(x, "Pt", 201, { form: 5 }); reg(x, "Pt", 201, { form: 26 });
  assert.deepEqual([...x.subarray(0x10c, 0x10f)], [26, 5, 0xff]);
  reg(x, "Pt", 487, { form: 1 }); reg(x, "Pt", 492, { form: 0 });
  assert.deepEqual([x[0x321] & 3, x[0x320] & 3], [3, 0]);
  // HGSS: Unown also goes to the caught list; Pichu's 3-form scheme is male / female / Spiky-eared.
  x = freshDex();
  reg(x, "HGSS", 201, { form: 7 });
  assert.deepEqual([x[0x10c], x[0x128]], [7, 7]);
  reg(x, "HGSS", 172, { form: 0, gender: "F" }); reg(x, "HGSS", 172, { form: 1, gender: "M" }); reg(x, "HGSS", 172, { form: 0, gender: "M" });
  assert.equal(x[0x33e], 1 | (2 << 2) | (0 << 4) | 0xc0);
  reg(x, "HGSS", 25, { langByte: 2, gameLangByte: 2 });
  assert.equal(x[0x335], 0, "same language: no international flag");
  // DP has no Rotom/Shaymin/Giratina tracking.
  x = freshDex();
  const before = x.slice();
  reg(x, "DP", 479, { form: 3 });
  assert.ok(diffs(x, before).every(([, end]) => end <= 0x104), "only the seen/caught/gender bits change");
  assert.equal(u32le(x, 0x31c), 0xffffffff);
  // Genderless counts as male; a seen species' second gender is only touched when it differs from the first.
  x = freshDex();
  reg(x, "Pt", 81, { gender: null });
  assert.deepEqual([bit1(x, 0x84, 81), bit1(x, 0xc4, 81)], [0, 0]);
});

/* ---------- copy selection (§6, §19.2.5) ---------- */

test("DP/Pt copy selection follows SaveData_LoadCheck", () => {
  for (const id of ["platinum-en", "diamond-en"]) {
    const L = G4.LAYOUTS[G4.detect(sav(id)).layout];
    const status = (img) => { const d = G4.detect(img); return d && [d.status, G4.open(img, d).copies]; };
    // Fixture: A = counters 2 (current), B = counters 1.
    assert.deepEqual(status(sav(id)), ["OK", { general: 0, storage: 0 }]);
    // (a) partition A erased: B alone, both blocks in one partition -> OK.
    let img = sav(id); img.fill(0xff, 0, PART);
    assert.deepEqual(status(img), ["OK", { general: 1, storage: 1 }]);
    // (b) a normal save after a full save: newer general in B (same saveCounter, blockCounter + 1), storage in A.
    img = sav(id); setFooter(img, L, 1, 0, { saveCounter: 2, blockCounter: 3 });
    assert.deepEqual(status(img), ["OK", { general: 1, storage: 0 }]);
    // ... edits land in those copies (in place) or in the other ones with both counters advanced (newSave).
    for (const strategy of ["inPlace", "newSave"]) {
      const s = G4.open(img, G4.detect(img), { writeStrategy: strategy });
      s.takeFromBox(0, 9); s.registerDex(327, { gender: "F", lang: "en" });
      const out = s.serialize(), re = G4.open(out, G4.detect(out));
      assert.deepEqual([re.loadStatus, re.copies], ["OK", strategy === "inPlace" ? { general: 1, storage: 0 } : { general: 0, storage: 1 }], strategy);
      assert.equal(re.box(0)[9], null);
      assert.ok(re.pokedex().caught.includes(327));
      if (strategy === "newSave") {
        const gEnd = L.generalSize, sEnd = PART + L.storageStart + L.storageSize;
        assert.deepEqual([u32le(out, gEnd - 0x14), u32le(out, gEnd - 0x10), u32le(out, sEnd - 0x14), u32le(out, sEnd - 0x10)], [3, 4, 3, 3]);
      }
    }
    // (c) newest general does not link to the newest storage -> CORRUPT (read-only).
    img = sav(id); setFooter(img, L, 0, 0, { saveCounter: 5, blockCounter: 5 });
    let s = G4.open(img, G4.detect(img));
    assert.deepEqual([s.loadStatus, s.copies], ["CORRUPT", { general: 1, storage: 0 }]);
    assert.ok(s.readOnly);
    assert.throws(() => s.takeFromBox(0, 9), /corrupted/);
    assert.throws(() => s.registerDex(25), FormatError);
    assert.deepEqual(s.serialize(), img);
    // (d) bad CRC in the newest general: both storage copies valid -> CORRUPT with the matching storage;
    //     only the storage beside the surviving general -> OK.
    img = sav(id); img[0x200] ^= 1;
    assert.deepEqual(status(img), ["CORRUPT", { general: 1, storage: 1 }]);
    img[L.storageStart + 0x10] ^= 1;
    assert.deepEqual(status(img), ["OK", { general: 1, storage: 1 }]);
    // (e) counter wrap: 0 is newer than 0xFFFFFFFF.
    img = sav(id);
    for (const kind of [0, 1]) { setFooter(img, L, 0, kind, { saveCounter: 0, blockCounter: 0 }); setFooter(img, L, 1, kind, { saveCounter: 0xffffffff, blockCounter: 0xffffffff }); }
    assert.deepEqual(status(img), ["OK", { general: 0, storage: 0 }]);
    for (const kind of [0, 1]) { setFooter(img, L, 0, kind, { saveCounter: 0xffffffff, blockCounter: 0xffffffff }); setFooter(img, L, 1, kind, { saveCounter: 0, blockCounter: 0 }); }
    assert.deepEqual(status(img), ["OK", { general: 1, storage: 1 }]);
    // Only storage copies valid -> ERROR: open refuses with a player-facing message.
    img = sav(id); img[0x200] ^= 1; img[PART + 0x200] ^= 1;
    assert.equal(G4.detect(img).status, "ERROR");
    assert.throws(() => G4.open(img, G4.detect(img)), /damaged/);
  }
});

test("HGSS copy selection follows Save_GetSaveFilesStatus", () => {
  const L = G4.LAYOUTS.HGSS;
  const status = (img) => { const d = G4.detect(img); return [d.status, d.status.endsWith("FAIL") && d.status !== "SLOT_FAIL" ? null : G4.open(img, d).copies]; };
  assert.deepEqual(status(sav("heartgold-en")), ["IS_GOOD", { general: 0, storage: 0 }]);
  let img = sav("heartgold-en"); img.fill(0xff, 0, PART);
  assert.deepEqual(status(img), ["IS_GOOD", { general: 1, storage: 1 }]);
  // (f) the newer main's sub has another count: the older pair loads with the "corrupted" message.
  img = sav("heartgold-en"); setFooter(img, L, 0, 1, { count: 7 });
  assert.deepEqual(status(img), ["SLOT_FAIL", { general: 1, storage: 1 }]);
  assert.ok(G4.open(img, G4.detect(img)).readOnly);
  setFooter(img, L, 1, 1, { count: 9 });
  assert.equal(G4.detect(img).status, "TOTAL_FAIL");
  assert.throws(() => G4.open(img, G4.detect(img)), FormatError);
  // (d) bad CRC in the newest main with both subs valid -> SLOT_FAIL (1/2 row).
  img = sav("heartgold-en"); img[0x200] ^= 1;
  assert.deepEqual(status(img), ["SLOT_FAIL", { general: 1, storage: 1 }]);
  // One main and one sub in different partitions -> TOTAL_FAIL.
  img = sav("heartgold-en"); img[PART + 0x200] ^= 1; img[L.storageStart + 0x10] ^= 1;
  assert.equal(G4.detect(img).status, "TOTAL_FAIL");
  // Korean saves validate against the Korean signature only.
  img = sav("heartgold-ko");
  assert.equal(G4.open(img, G4.detect(img)).signature, G4.SIGNATURE_KO);
  setU32le(img, L.generalSize - 8, G4.SIGNATURE);   // partition A general now carries the INT signature
  const d = G4.detect(img);
  assert.deepEqual([d.status, G4.open(img, d).copies], ["SLOT_FAIL", { general: 1, storage: 1 }]);
});

/* ---------- Bad Eggs and raw-zero slots (§10.4) ---------- */

test("Bad Eggs are shown and locked; raw-zero empties are free and get repaired in boxes we write", () => {
  const img = sav("platinum-en"), L = G4.LAYOUTS.Pt;
  img[slotOffset(L, 0, 0, 0) + 0x87] ^= 0x55;            // corrupt the egg in box 1 slot 1
  img.fill(0, slotOffset(L, 0, 0, 1), slotOffset(L, 0, 0, 3));   // two raw-zero slots
  img.fill(0, slotOffset(L, 0, 2, 0), slotOffset(L, 0, 2, 1));   // and one in box 3
  fixCrc(img, L, 0, 1);
  const s = G4.open(img, G4.detect(img));
  assert.match(s.warnings.join("\n"), /Bad Egg\) in box 1 slot 1/);
  assert.match(s.warnings.join("\n"), /3 empty box slot/);
  const bad = s.box(0)[0];
  assert.deepEqual([bad.view.checksumOk, bad.view.isEgg], [false, true]);
  assert.equal(s.box(0)[1], null);
  assert.throws(() => s.takeFromBox(0, 0), /Bad Egg/);
  const rec = fromHex(recordHex("pk4-turtwig-shelly"));
  assert.throws(() => s.putInBox(rec, { format: "pk4" }, 0, 0), /not empty/);
  assert.deepEqual(s.putInBox(rec, { format: "pk4" }, 0, 1), { box: 0, index: 1, notes: [] });
  const out = s.serialize();
  assert.deepEqual(out.subarray(slotOffset(L, 0, 0, 2), slotOffset(L, 0, 0, 3)), P.emptyRecord(), "repaired");
  assert.deepEqual(out.subarray(slotOffset(L, 0, 2, 0), slotOffset(L, 0, 2, 1)), new Uint8Array(0x88), "box 3 untouched");
  assert.ok(crcOk(out, L, 0, 1));
});

/* ---------- the Platinum PC port (§17.1) ---------- */

/** A save.bin in the port's computed layout, built from a DS Platinum save: zero-filled like libntr, with the
    trainer, party, Pokédex and PC moved to the port's offsets and footers of the port's block sizes. */
function toPort(ds) {
  const DS = G4.LAYOUTS.Pt, PO = G4.LAYOUTS.PtPort, out = new Uint8Array(0x80000);
  for (const part of [0, 1]) {
    const g = part * PART, dsS = g + DS.storageStart, poS = g + PO.storageStart;
    const copy = (from, to, len) => out.set(ds.subarray(from, from + len), to);
    copy(g + DS.trainer, g + PO.trainer, 0x26);                    // TrainerInfo, coins, play time
    copy(g + DS.party - 4, g + PO.party - 4, 8 + 6 * 0xec);        // capacity, count, six Pokémon
    setU32le(out, g + PO.party - 4, 6);                            // the game sets capacity 6 (PKHeX's skeleton leaves 0)
    copy(g + DS.dex, g + PO.dex, 0x324);
    copy(dsS, poS, 4);
    copy(dsS + DS.boxes, poS + PO.boxes, 18 * 0xff0);
    copy(dsS + DS.names, poS + PO.names, 18 * 40 + 19);           // names, wallpapers, unlocked bits
    for (const [kind, start, size, dsEnd] of [[0, g, PO.generalSize, g + DS.generalSize], [1, poS, PO.storageSize, dsS + DS.storageSize]]) {
      const end = start + size;
      setU32le(out, end - 0x14, u32le(ds, dsEnd - 0x14)); setU32le(out, end - 0x10, u32le(ds, dsEnd - 0x10));
      setU32le(out, end - 0x0c, size); setU32le(out, end - 8, G4.SIGNATURE); out[end - 4] = kind;
      setU16le(out, end - 2, crc16ccitt(out, start, size - 0x14));
    }
  }
  return out;
}

test("Platinum PC port: detected by its block sizes, read and written in its own layout", () => {
  const ds = sav("platinum-en"), port = toPort(ds);
  const d = G4.detect(port);
  assert.deepEqual([d.layout, d.port, d.game, d.lang, d.status], ["PtPort", true, "Pt", "en", "OK"]);
  const s = G4.open(port, d), ref = openFixture("platinum-en");
  assert.equal(s.readOnly, null);
  assert.match(s.warnings.join(), /PC port/);
  assert.deepEqual([s.trainer, s.pokedex(), s.boxName(3), s.currentBox], [ref.trainer, ref.pokedex(), ref.boxName(3), ref.currentBox]);
  assert.deepEqual(s.party().map((e) => toHex(e.record)), ref.party().map((e) => toHex(e.record)));
  for (let b = 0; b < 18; b++) assert.deepEqual(s.box(b).map((e) => e && toHex(e.record)), ref.box(b).map((e) => e && toHex(e.record)));
  assert.deepEqual(s.serialize(), port);
  PT_OPS(s); PT_OPS(ref);
  const out = s.serialize();
  const L = G4.LAYOUTS.PtPort;
  for (const kind of [0, 1]) assert.ok(crcOk(out, L, 0, kind));
  assert.equal(G4.detect(out).layout, "PtPort", "still the port layout");
  assert.equal(u32le(out, G4.LAYOUTS.Pt.generalSize - 0x0c), 0, "no DS footer written");
  const re = G4.open(out, G4.detect(out)), refOut = ref.serialize(), reDS = G4.open(refOut, G4.detect(refOut));
  assert.deepEqual(re.party().map((e) => toHex(e.record)), reDS.party().map((e) => toHex(e.record)));
  for (let b = 0; b < 18; b++) assert.deepEqual(re.box(b).map((e) => e && toHex(e.record)), reDS.box(b).map((e) => e && toHex(e.record)));
  // The DS image is never taken for the port layout.
  assert.equal(G4.detect(ds).layout, "Pt");
});

test("Platinum PC port: a layout that does not check out on the file opens read-only", () => {
  const port = toPort(sav("platinum-en")), L = G4.LAYOUTS.PtPort;
  setU32le(port, L.dex, 0);
  fixCrc(port, L, 0, 0);
  const s = G4.open(port, G4.detect(port));
  assert.match(s.readOnly, /do not match the expected layout/);
  assert.throws(() => s.takeFromBox(0, 9), FormatError);
});

test("save.bin files through container.js: short port files and DS saves named save.bin", () => {
  const port = toPort(sav("platinum-en"));
  let end = port.length; while (end > 0 && port[end - 1] === 0) end--;
  const file = port.slice(0, end);
  const [cand] = unwrap(file, "save.bin");
  assert.equal(cand.info.padByte, 0);
  const d = G4.detect(cand.image);
  assert.equal(d.layout, "PtPort");
  const s = G4.open(cand.image, d, { container: cand.info });
  s.takeFromBox(0, 9);
  const back = rebuild(s.serialize(), cand.info);
  assert.equal(back.length, file.length, "length kept");
  assert.equal(G4.detect(unwrap(back, "save.bin")[0].image).layout, "PtPort");
  // A DS save truncated and named save.bin stays a DS-layout save (never re-laid out), with a warning.
  const ds = sav("platinum-en");
  let e2 = ds.length; while (e2 > 0 && ds[e2 - 1] === 0xff) e2--;
  const [c2] = unwrap(ds.slice(0, e2), "save.bin");
  const d2 = G4.detect(c2.image);
  assert.equal(d2.layout, "Pt");
  assert.match(G4.open(c2.image, d2, { container: c2.info }).warnings.join(), /port cannot read/);
});

/* ---------- robustness ---------- */

test("detection does not misfire on other generations, random, zero or 0xFF images, and never throws", () => {
  const others = readdirSync(new URL("saves/", FIX)).filter((f) => f.endsWith(".sav") && !FIXTURES.some((x) => f === `${x.id}.sav`));
  assert.ok(others.length >= 10);
  for (const f of others) assert.equal(G4.detect(new Uint8Array(readFileSync(new URL(`saves/${f}`, FIX)))), null, f);
  assert.equal(G4.detect(new Uint8Array(0x80000)), null);
  assert.equal(G4.detect(new Uint8Array(0x80000).fill(0xff)), null);
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) >>> 24;
  for (let k = 0; k < 4; k++) assert.equal(G4.detect(new Uint8Array(0x80000).map(rnd)), null);
  for (const bad of [undefined, null, "x", new Uint8Array(0), new Uint8Array(0x20000), new Uint8Array(0x8007a), sav("platinum-en").subarray(0, 0x7ffff)]) {
    assert.equal(G4.detect(bad), null);
  }
  assert.throws(() => G4.open(new Uint8Array(0x80000).map(rnd)), FormatError);
  assert.throws(() => G4.open(new Uint8Array(100)), FormatError);
  assert.throws(() => G4.open(sav("black-en")), FormatError);
  // Damaged Gen 4 images: footers or random bytes inside blocks never make detect/open throw anything but FormatError.
  for (const f of FIXTURES) {
    for (let k = 0; k < 6; k++) {
      const img = sav(f.id);
      for (let j = 0; j < 40; j++) img[(rnd() << 11 | rnd() << 3 | (rnd() & 7)) & 0x7ffff] = rnd();
      let d;
      assert.doesNotThrow(() => { d = G4.detect(img); });
      if (d) try { const s = G4.open(img, d); s.party(); for (let b = 0; b < 18; b++) s.box(b); } catch (e) { assert.ok(e instanceof FormatError, e.stack); }
    }
  }
});
