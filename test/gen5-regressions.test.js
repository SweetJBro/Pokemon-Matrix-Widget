/* Regression tests from the adversarial review of shared/saves/gen5.js and shared/pkm/pk5.js:
   copy selection after interrupted in-game saves (format-gen5.md §5.5 "Saving"), a Black/White
   copy whose footer magic is damaged, header flags the game would misread, the party index
   contract, and PKHeX's reading of a spread of generated Pokémon (test/fixtures/stage2-gen5/).
   No dotnet needed. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hex, u16le, u32le, setU16le, setU32le, crc16ccitt, FormatError } from "../shared/bytes.js";
import * as pk5 from "../shared/pkm/pk5.js";
import * as gen5 from "../shared/saves/gen5.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readSave = (id) => new Uint8Array(fs.readFileSync(path.join(dir, "saves", id + ".sav")));
const fromHex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));
const layoutOf = (id) => gen5.LAYOUTS[id.startsWith("black2") ? "B2W2" : "BW"];

/** A completed save: the backup copy equals the main copy. */
function completed(id) {
  const img = readSave(id), L = layoutOf(id);
  img.copyWithin(L.copySize, 0, L.copySize);
  return img;
}
const footerValid = (img, L, base) => u32le(img, base + L.footer + 4) === L.footer + 0x10 && u32le(img, base + L.footer + 8) === gen5.MAGIC &&
  u16le(img, base + L.footer + 0xe) === crc16ccitt(img, base + L.table, L.crcsSize);
function assertCopyValid(img, L, base) {
  L.blocks.forEach(({ off, size }, i) => {
    const crc = crc16ccitt(img, base + off, size);
    assert.equal(u16le(img, base + off + size + 2), crc, `copy ${base ? "backup" : "main"} block ${i} footer CRC`);
    assert.equal(u16le(img, base + L.table + 2 * i), crc, `copy ${base ? "backup" : "main"} block ${i} table entry`);
  });
  assert.ok(footerValid(img, L, base), `copy ${base ? "backup" : "main"} footer`);
}

/** The flash after the game's first save following a load that preferred the main copy, cut off after
    `steps` writes (§5.5 "Saving"): pass 0 writes the changed block to main and the CRC table and
    footer (first 15 bytes, then the last one) to the backup; pass 1 does the reverse. */
function interruptedSave(img, L, blockId, edit, steps) {
  const mem = img.slice(0, L.copySize);
  const { off, size } = L.blocks[blockId];
  edit(mem, off);
  setU16le(mem, off + size, u16le(mem, off + size) + 1);
  const crc = crc16ccitt(mem, off, size);
  setU16le(mem, off + size + 2, crc);
  setU16le(mem, L.table + 2 * blockId, crc);
  setU32le(mem, L.footer, u32le(mem, L.footer) + 1);
  setU16le(mem, L.footer + 0xe, crc16ccitt(mem, L.table, L.crcsSize));
  const out = img.slice();
  const writes = [];
  for (const [blockCopy, tableCopy] of [[0, L.copySize], [L.copySize, 0]]) {
    writes.push(() => out.set(mem.subarray(off, off + size + 4), blockCopy + off));
    writes.push(() => out.set(mem.subarray(L.table, L.table + L.crcsSize), tableCopy + L.table));
    writes.push(() => out.set(mem.subarray(L.footer, L.footer + 15), tableCopy + L.footer));
    writes.push(() => { out[tableCopy + L.footer + 15] = mem[L.footer + 15]; });
  }
  writes.slice(0, steps).forEach((w) => w());
  return out;
}

for (const id of ["black-en", "black2-en"]) {
  test(`gen5 ${id}: every point of an interrupted in-game save reads as the game reads it, and our write stays loadable`, () => {
    const L = layoutOf(id), base = completed(id);
    const slot0 = hex(gen5.open(base).box(0)[0].record);
    const target = gen5.open(base).box(1).findIndex(Boolean);
    assert.ok(target >= 0);
    for (let steps = 0; steps <= 8; steps++) {
      const img = interruptedSave(base, L, 1, (mem, off) => mem.set(pk5.emptyRecord(), off), steps);
      // The game takes the newer footer's table, then each block from a copy that matches it. Once
      // the backup's footer is complete (step 4) its table is the newer one and box 1's new data is
      // only in main: the game uses main's block. Before that the old data is still current.
      const newer = steps >= 4 || (steps === 3 && footerValid(img, L, L.copySize));
      const save = gen5.open(img);
      assert.equal(save.box(0)[0] && hex(save.box(0)[0].record), newer ? null : slot0, `step ${steps}: box 1 slot 1`);
      save.takeFromBox(1, target);
      const out = save.serialize();
      assertCopyValid(out, L, 0);
      assertCopyValid(out, L, L.copySize);
      assert.equal(hex(out.subarray(0, L.copySize)), hex(out.subarray(L.copySize, 2 * L.copySize)), `step ${steps}: copies equal`);
      assert.equal(hex(out.subarray(2 * L.copySize)), hex(img.subarray(2 * L.copySize)), `step ${steps}: nothing past the copies changes`);
      const re = gen5.open(out);
      assert.equal(re.box(0)[0] && hex(re.box(0)[0].record), newer ? null : slot0, `step ${steps}: reopened`);
      assert.equal(re.box(1)[target], null, `step ${steps}: our edit`);
    }
  });
}

test("gen5: a newer Black/White copy whose footer magic is damaged is not used (the game rejects it)", () => {
  const L = gen5.LAYOUTS.BW, img = completed("black-en");
  const kept = hex(gen5.open(img).box(0)[0].record);
  // Main copy: box 1 slot 1 cleared, every CRC right, counter ahead of the backup, magic damaged.
  const { off, size } = L.blocks[1];
  img.set(pk5.emptyRecord(), off);
  const crc = crc16ccitt(img, off, size);
  setU16le(img, off + size + 2, crc); setU16le(img, L.table + 2, crc);
  setU32le(img, L.footer, u32le(img, L.footer) + 1);
  setU32le(img, L.footer + 8, gen5.MAGIC ^ 1);
  setU16le(img, L.footer + 0xe, crc16ccitt(img, L.table, L.crcsSize));
  const save = gen5.open(img);
  assert.equal(hex(save.box(0)[0].record), kept, "the backup copy's box 1, as the game loads it");
  assert.deepEqual(save.warnings.filter((w) => /footer's size or magic/.test(w)), []);
  save.takeFromBox(0, 4);
  const out = save.serialize();
  for (const b of [0, L.copySize]) { assertCopyValid(out, L, b); assert.equal(u32le(out, b + L.footer + 8), gen5.MAGIC); }
  assert.equal(hex(gen5.open(out).box(0)[0].record), kept);
});

test("gen5: a Black/White save whose two copies agree on an unexpected magic still opens (lenient), and keeps it", () => {
  const L = gen5.LAYOUTS.BW, img = completed("black-en");
  for (const b of [0, L.copySize]) setU32le(img, b + L.footer + 8, 0x12345678);
  const save = gen5.open(img);
  assert.match(save.warnings.join(), /footer's size or magic/);
  save.takeFromBox(0, 4);
  const out = save.serialize();
  for (const b of [0, L.copySize]) assert.equal(u32le(out, b + L.footer + 8), 0x12345678);
  assert.equal(gen5.open(out).box(0)[4], null);
});

test("pk5/gen5: records with the header's decryption flags set are refused (the game would read them scrambled)", () => {
  const rec = fromHex(fs.readFileSync(path.join(dir, "records", "pk5-oshawott-shell.hex"), "utf8").trim());
  for (const flag of [1, 2, 3]) {
    const r = rec.slice();
    setU16le(r, 4, flag);                         // the header is not covered by the checksum
    assert.equal(pk5.parse(r).checksumOk, true);
    const v = pk5.validate(r);
    assert.equal(v.ok, false);
    assert.match(v.errors.join(), /decryption flags/);
    const save = gen5.open(readSave("black2-en"));
    assert.throws(() => save.putInBox(r, { format: "pk5", lang: "en", game: "B2" }), (e) => e instanceof FormatError && e.detail.code === "bad-egg");
    // and one already in a box cannot be taken
    const L = gen5.LAYOUTS.B2W2, img = readSave("black2-en"), o = L.blocks[1].off + 136 * 29;
    img.set(r, o);
    const crc = crc16ccitt(img, L.blocks[1].off, L.blocks[1].size);
    setU16le(img, L.blocks[1].off + L.blocks[1].size + 2, crc); setU16le(img, L.table + 2, crc);
    setU16le(img, L.footer + 0xe, crc16ccitt(img, L.table, L.crcsSize));
    assert.throws(() => gen5.open(img).takeFromBox(0, 29), /cannot read/);
  }
});

test("gen5: party()[i] is the Pokémon takeFromParty(i) takes, even with an empty slot inside the count", () => {
  const L = gen5.LAYOUTS.BW, img = readSave("black-en"), P = L.blocks[26];
  const before = gen5.open(img).party().map((e) => hex(e.record));
  img.set(pk5.emptyPartySlot(), P.off + 8);       // slot 1 emptied, count still 3
  const crc = crc16ccitt(img, P.off, P.size);
  setU16le(img, P.off + P.size + 2, crc); setU16le(img, L.table + 2 * 26, crc);
  setU16le(img, L.footer + 0xe, crc16ccitt(img, L.table, L.crcsSize));
  const save = gen5.open(img);
  const party = save.party();
  assert.equal(party.length, 3);
  assert.equal(party[0].view.species, 0);
  assert.deepEqual(party.slice(1).map((e) => hex(e.record)), before.slice(1));
  assert.throws(() => save.takeFromParty(0), /empty/);
  assert.equal(hex(save.takeFromParty(2).record), before[2]);
});

/* ---------- PKHeX's reading of generated Pokémon (all four games, all seven languages) ---------- */

// Generated with the PKHeX oracle by the Gen 5 fuzz run (docs: test/fixtures/README.md). Until that file is
// committed the comparison is skipped rather than failing the whole file.
const VECTORS = path.join(dir, "stage2-gen5", "pk5-vectors.json");
const vectors = fs.existsSync(VECTORS) ? JSON.parse(fs.readFileSync(VECTORS, "utf8")) : null;
const RIBBON_ORDER = vectors?.ribbonOrder;

test("pk5: PKHeX's reading of generated records (every game and language) matches ours; build(parse(r)) is exact", { skip: !vectors && "test/fixtures/stage2-gen5/pk5-vectors.json not generated yet" }, () => {
  assert.ok(vectors.mons.length >= 100);
  const ours = (() => {   // our ribbon names in bit order, to compare with PKHeX's property names
    const f = pk5.parse(pk5.emptyRecord()), names = [];
    for (const [w, bits] of [[0, 28], [1, 32], [2, 20]]) for (let b = 0; b < bits; b++) {
      const rib = [0, 0, 0, 0]; rib[w] = (1 << b) >>> 0;
      names.push(pk5.toView({ ...f, species: 25, ribbons: rib }).ribbons[0]);
    }
    return new Map(names.map((n, i) => [n, RIBBON_ORDER[i]]));
  })();
  for (const m of vectors.mons) {
    const meta = { format: "pk5", lang: m.saveLang, game: m.saveGame };
    const stored = fromHex(m.storedHex), rec = stored.subarray(0, 136);
    const where = `${m.where} #${m.species}`;
    assert.equal(hex(pk5.build(pk5.parse(stored, meta), meta)), m.storedHex, where + " lossless");
    const f = pk5.parse(stored, meta), v = pk5.toView(f, meta);
    assert.deepEqual([v.species, v.form, v.isEgg, v.level, v.exp], [m.species, m.form, m.isEgg, m.level, m.exp], where);
    assert.deepEqual([v.nickname, v.isNicknamed, v.ot.name, v.ot.tid, v.ot.sid, v.ot.gender], [m.nickname, m.isNicknamed, m.ot.name, m.ot.tid, m.ot.sid, ["M", "F"][m.ot.gender]], where);
    assert.deepEqual(v.moves.map((x) => [x.id, x.pp, x.ppUps]), m.moves.filter((x) => x[0]), where);
    assert.deepEqual([v.ivs, v.evs], [m.ivs, m.evs], where);
    assert.deepEqual([v.natureId, v.abilityId, v.heldItemId, v.gender, v.shiny, v.pid], [m.nature, m.ability, m.heldItem, ["M", "F", null][m.gender], m.isShiny, m.pid], where);
    if (m.met.version >= 20) assert.equal(v.abilityNum, m.abilityNumber, where);
    assert.deepEqual([v.met.location, v.met.level, v.met.date, v.ballId, v.extra.originGame], [m.met.location, m.met.level, m.met.date, m.met.ball, m.met.version], where);
    assert.deepEqual(v.extra.egg ? [v.extra.egg.location, v.extra.egg.date] : [0, null], [m.egg.location, m.egg.date], where);
    assert.deepEqual([v.friendship, v.lang, v.pokerus ?? { strain: 0, days: 0 }, v.markings, v.extra.fateful], [m.friendship, m.languageCode, m.pokerus, m.markingsRaw, m.fatefulEncounter], where);
    assert.deepEqual([v.extra.hiddenAbility, v.extra.nsPokemon, v.extra.pokeStarFame, v.extra.encounterType], [m.extra.hiddenAbility, m.extra.nSparkle, m.extra.pokeStarFame, m.extra.groundTile], where);
    assert.deepEqual(v.extra.contest, m.contest, where);
    assert.deepEqual(v.ribbons.map((n) => ours.get(n) ?? n).sort(), [...m.ribbons].sort(), where);
    assert.equal(v.checksumOk, true, where);
    if (m.partyStats && !m.isEgg) {
      const ps = m.partyStats;
      assert.deepEqual(v.stats, { hp: ps.hpMax, atk: ps.atk, def: ps.def, spa: ps.spa, spd: ps.spd, spe: ps.spe }, where);
      assert.deepEqual([f.party.level, f.party.hp], [ps.level, ps.hpCurrent], where);
      assert.deepEqual(pk5.toView(pk5.parse(rec, meta), meta).stats, v.stats, where + " computed stats");
    }
  }
});
