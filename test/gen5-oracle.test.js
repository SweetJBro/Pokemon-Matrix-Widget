/* Differential check of shared/saves/gen5.js writes against PKHeX (tools/pkhex-oracle). Runs only
   when the oracle has been built (dotnet + bin/Release); skipped otherwise, so `npm test` never
   needs .NET. Every save our code writes must load in PKHeX with all checksums valid ("SAV: 70/70"
   for BW, 74/74 for B2W2) and show exactly the Pokémon, Pokédex and trainer we read back. */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { hex, u32le, setU32le, crc16ccitt, setU16le } from "../shared/bytes.js";
import * as pk5 from "../shared/pkm/pk5.js";
import * as gen5 from "../shared/saves/gen5.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dll = path.join(root, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
let skip = !fs.existsSync(dll) && "PKHeX oracle not built";
if (!skip) { try { execFileSync("dotnet", ["--version"], { stdio: "ignore" }); } catch { skip = "dotnet not installed"; } }
const oracle = (...args) => JSON.parse(execFileSync("dotnet", [dll, ...args], { cwd: root, maxBuffer: 64 << 20 }).toString());
const tmp = skip ? null : fs.mkdtempSync(path.join(os.tmpdir(), "gen5-oracle-"));
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
const fromHex = (s) => Uint8Array.from(s.trim().match(/../g), (x) => parseInt(x, 16));
const readSave = (id) => new Uint8Array(fs.readFileSync(path.join(root, "test/fixtures/saves", id + ".sav")));
const record = (name) => fromHex(fs.readFileSync(path.join(root, "test/fixtures/records", name + ".hex"), "utf8"));

/** Dump our output with PKHeX and compare with what our own reader sees. */
function check(name, bytes, blocks) {
  const file = path.join(tmp, name + ".sav");
  fs.writeFileSync(file, bytes);
  const d = oracle("dump", file);
  assert.equal(d.checksumsValid, true, `${name}: ${d.checksumInfo}`);
  assert.equal(d.checksumInfo, `SAV: ${blocks + 1}/${blocks + 1}`);
  const s = gen5.open(bytes);
  assert.deepEqual(d.party.map((m) => m.recordHex), s.party().map((e) => hex(e.record)), name + " party");
  const ours = [];
  for (let b = 0; b < 24; b++) s.box(b).forEach((e, i) => { if (e) ours.push([b, i, hex(e.record)]); });
  assert.deepEqual(d.boxes.map((m) => [m.box, m.slot, m.recordHex]), ours, name + " boxes");
  assert.deepEqual(d.pokedex, s.pokedex(), name + " dex");
  assert.equal(d.trainer.name, s.trainer.name);
  assert.equal(d.trainer.money, s.trainer.money);
  return d;
}

for (const [id, blocks, other] of [["black-en", 69, "pk5-oshawott-shell"], ["black2-en", 73, "pk5-snivy-hidden-ability"], ["black-ja", 69, "pk5-basculin-blue-it"]]) {
  test(`oracle: ${id} after take/put/registerDex loads in PKHeX with valid checksums`, { skip }, () => {
    const save = gen5.open(readSave(id));
    const boxed = save.box(0).findIndex(Boolean);
    const t = save.takeFromBox(0, boxed);
    const p = save.takeFromParty(1);
    save.putInBox(record(other), { format: "pk5", lang: "en", game: "B" }, 5, 7);
    save.putInBox(p.record, p.meta);
    save.putInBox(t.record, t.meta, 23, 0);
    save.registerDex(327, { pid: 0x01020304, lang: "en" });
    save.registerDex(585, { form: 3, gender: "F", lang: "en" });
    const d = check(id + "-ops", save.serialize(), blocks);
    assert.ok(d.pokedex.caught.includes(327) && d.pokedex.caught.includes(585));
    assert.equal(d.boxes.find((m) => m.box === 23 && m.slot === 0).recordHex, hex(t.record));
    assert.equal(d.partyCount, 2);
  });
}

test("oracle: an edit on a save whose backup copy is newer reaches PKHeX (which reads only main)", { skip }, () => {
  const L = gen5.LAYOUTS.BW, img = readSave("black-en");
  img.copyWithin(L.copySize, 0, L.copySize);
  img.set(pk5.emptyRecord(), L.copySize + L.blocks[1].off);             // backup: box 1 slot 0 empty
  const fix = (base, i) => {
    const { off, size } = L.blocks[i], crc = crc16ccitt(img, base + off, size);
    setU16le(img, base + off + size + 2, crc); setU16le(img, base + L.table + 2 * i, crc);
    setU16le(img, base + L.footer + 0xe, crc16ccitt(img, base + L.table, L.crcsSize));
  };
  fix(L.copySize, 1);
  setU32le(img, L.copySize + L.footer, u32le(img, L.footer) + 1);
  fix(L.copySize, 1);
  const save = gen5.open(img);
  save.takeFromBox(0, 4);
  const d = check("backup-newer", save.serialize(), 69);
  assert.ok(!d.boxes.some((m) => m.box === 0 && (m.slot === 0 || m.slot === 4)));
});

test("oracle: PKHeX parses records we rebuilt (rename, PP restore) with valid checksums", { skip }, () => {
  for (const name of ["pk5-oshawott-shell", "pk5-ja-tepig", "pk5-purrloin-nsparkle", "pk5-larvesta-egg"]) {
    const f = pk5.parse(record(name));
    const rec = pk5.build(pk5.restorePP({ ...f, nickname: f.isEgg ? f.nickname : "Renamed", pp: [0, 0, 0, 0] }));
    const r = oracle("pkm", "pk5", hex(rec)).pkm;
    assert.equal(r.checksumValid, true, name);
    if (!f.isEgg) assert.equal(r.nickname, "Renamed");
    assert.deepEqual(r.moves.map((m) => m.pp), pk5.toView(pk5.parse(rec)).moves.map((m) => m.pp).concat([0, 0, 0, 0]).slice(0, 4));
    assert.equal(r.extra.nSparkle, f.nsPokemon);
  }
});

/* Saves PKHeX builds on the fly for games and cases the committed fixtures lack: White 2 in Korean
   with a fused Kyurem, a mail holder, Therian/Resolute/Genesect forms and a Poké Transfer Shellos;
   White in French with Deoxys and Unown ?. */
const SPECS = {
  "w2-ko": {
    game: "W2", lang: "ko", currentBox: 3,
    trainer: { name: "명", tid: 4321, sid: 8765, gender: 1, money: 999999, playTime: { h: 999, m: 59, s: 59 } },
    party: [
      { species: 646, form: 2, level: 60, moves: [558, 225, 337, 85] },
      { species: 327, level: 30, moves: [33], heldItem: 137 },
      { species: 648, level: 50, moves: [547] },
    ],
    boxes: [
      { box: 3, slot: 0, species: 641, form: 1, level: 50, moves: [16] },
      { box: 3, slot: 1, species: 647, form: 1, level: 50, moves: [548] },
      { box: 3, slot: 2, species: 351, level: 30, moves: [33], language: "ja", otName: "ユウ", tid: 1, sid: 2 },
      { box: 3, slot: 4, species: 649, form: 2, heldItem: 117, level: 50, moves: [33] },
      { box: 3, slot: 5, species: 422, form: 1, level: 20, moves: [33], metVersion: "D", metLocation: 30001 },
      { box: 20, slot: 29, species: 133, level: 10, shiny: true, gender: "F", moves: [33] },
    ],
  },
  "w-fr": {
    game: "W", lang: "fr", currentBox: 23,
    trainer: { name: "Ludvina", tid: 1, sid: 0, gender: 1, money: 0, playTime: { h: 0, m: 1, s: 2 } },
    party: [{ species: 29, level: 5, moves: [33], nickname: "Nidoran♀" }, { species: 32, level: 5, moves: [33] }],
    boxes: [
      { box: 23, slot: 0, species: 201, form: 27, level: 5, moves: [237] },
      { box: 0, slot: 0, species: 386, form: 3, level: 5, moves: [33], metVersion: "E", metLocation: 30001, language: "de" },
    ],
  },
};

for (const [id, spec] of Object.entries(SPECS)) {
  test(`oracle: PKHeX-built ${id} reads the same here, refuses the unsafe moves and stays valid after edits`, { skip }, () => {
    const specFile = path.join(tmp, id + ".json"), file = path.join(tmp, id + ".sav");
    fs.writeFileSync(specFile, JSON.stringify(spec));
    assert.equal(oracle("build", specFile, file).ok, true);
    const img = new Uint8Array(fs.readFileSync(file)), d = oracle("dump", file);
    const det = gen5.detect(img);
    assert.deepEqual([det.game, det.lang], [spec.game, spec.lang]);
    const save = gen5.open(img, det);
    assert.equal(save.currentBox, d.currentBox);
    assert.deepEqual({ ...save.trainer, gender: ["M", "F"].indexOf(save.trainer.gender) }, d.trainer);
    for (const m of [...d.party, ...d.boxes]) {
      const e = m.box === undefined ? save.party()[m.slot] : save.box(m.box)[m.slot];
      assert.equal(hex(e.record), m.recordHex);
      assert.deepEqual([e.view.species, e.view.form, e.view.nickname, e.view.lang, e.view.abilityId, e.view.heldItemId],
        [m.species, m.form, m.nickname, m.languageCode, m.ability, m.heldItem], `${id} ${m.box}:${m.slot}`);
      assert.ok(pk5.validate(e.record, e.meta).ok);
    }
    assert.deepEqual(save.pokedex(), d.pokedex);
    if (id === "w2-ko") {
      assert.throws(() => save.takeFromParty(0), /Fused Kyurem/);
      assert.throws(() => save.takeFromParty(1), /mail/);
      const therian = save.takeFromBox(3, 0);
      assert.throws(() => gen5.open(readSave("black-en")).putInBox(therian.record, therian.meta), /Black 2 and White 2/);
      save.putInBox(therian.record, therian.meta);
    } else {
      const deoxys = save.takeFromBox(0, 0);
      save.putInBox(deoxys.record, deoxys.meta, 22, 29);
    }
    save.registerDex(25, { pid: 0x1234, lang: spec.lang });
    check(id + "-edited", save.serialize(), spec.game === "W2" ? 73 : 69);
  });
}
