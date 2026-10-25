/* Gen 3 saves written by shared/saves/gen3.js, read back by PKHeX through the dev-only oracle
   (tools/pkhex-oracle). Skipped unless the Release build of the oracle and dotnet are present, so
   `npm test` never needs .NET. The committed fixtures cover the same ground without PKHeX; this
   file adds PKHeX's own verdict (checksums valid, contents as intended) on saves we produced, and
   PKHeX-built saves in languages and versions the fixtures do not have. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as gen3 from "../shared/saves/gen3.js";
import { hex } from "../shared/bytes.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DLL = path.join(ROOT, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
const available = (() => {
  if (!fs.existsSync(DLL)) return false;
  try { execFileSync("dotnet", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const skip = available ? false : "PKHeX oracle not built (tools/pkhex-oracle) or dotnet missing";
const oracle = (...args) => JSON.parse(execFileSync("dotnet", [DLL, ...args], {
  cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20, env: { ...process.env, PKHEX_ORACLE_NOW: "2010-01-01" } }));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gen3-oracle-"));
const fromHex = (s) => Uint8Array.from(s.trim().match(/../g), (x) => parseInt(x, 16));
const fixture = (id) => new Uint8Array(fs.readFileSync(path.join(ROOT, "test/fixtures/saves", id + ".sav")));
const record = (name) => fromHex(fs.readFileSync(path.join(ROOT, "test/fixtures/records", name + ".hex"), "utf8"));

/** Our edits on a save, with the box/party/Pokédex state we expect PKHeX to read back. */
function edit(img) {
  const s = gen3.open(img);
  const model = new Map(), dex = s.pokedex();
  for (let b = 0; b < 14; b++) s.box(b).forEach((m, i) => { if (m) model.set(b * 30 + i, hex(m.record)); });
  const party = s.party().map((p) => hex(p.record));
  const takeAt = [...model.keys()][Math.min(1, model.size - 1)];
  const taken = s.takeFromBox(Math.floor(takeAt / 30), takeAt % 30);
  model.delete(takeAt);
  const p = s.takeFromParty(0);
  party.shift();
  // Two sector-straddling slots (box 5 position 29, box 9 position 8) and the first free slot.
  for (const [rec, b, i] of [[p.record, 4, 28], [taken.record, 8, 7], [record("pk3-mew-fateful"), null, null]]) {
    const at = b == null ? s.putInBox(rec, { format: "pk3" }) : s.putInBox(rec, { format: "pk3" }, b, i);
    model.set(at.box * 30 + at.index, hex(rec));
  }
  for (const sp of [151, 327, 386]) if (s.registerDex(sp, { pid: 0x01020304 })) {
    for (const k of ["seen", "caught"]) if (!dex[k].includes(sp)) dex[k].push(sp);
  }
  for (const k of ["seen", "caught"]) dex[k].sort((a, b) => a - b);
  return { out: s.serialize(), model, party, dex };
}

function checkWithPkhex(out, { model, party, dex }, file) {
  fs.writeFileSync(file, out);
  const d = oracle("dump", file);
  assert.equal(d.checksumsValid, true, d.checksumInfo);
  assert.deepEqual(d.boxes.map((e) => [e.box * 30 + e.slot, e.recordHex]), [...model.entries()].sort((a, b) => a[0] - b[0]));
  assert.deepEqual(d.party.map((e) => e.recordHex), party);
  assert.deepEqual(d.pokedex, dex);
  return d;
}

test("oracle: PKHeX reads our edits of every Gen 3 fixture with valid checksums", { skip }, () => {
  const dir = tmp();
  for (const id of ["emerald-en", "firered-en", "ruby-en", "ruby-ja"]) {
    const img = fixture(id), want = edit(img);
    const d = checkWithPkhex(want.out, want, path.join(dir, id + ".sav"));
    const before = oracle("dump", path.join(ROOT, "test/fixtures/saves", id + ".sav"));
    assert.deepEqual(d.trainer, before.trainer, id);
    assert.equal(hex(want.out.subarray(0xe000)), hex(img.subarray(0xe000)), id + ": only the active slot changes");
  }
});

/* Saves PKHeX builds in layouts the fixtures lack: LeafGreen (German), Sapphire (French), Emerald (Spanish,
   with Deoxys and Spinda), FireRed (Italian). Our reading must equal PKHeX's dump; then our edits again. */
const SPECS = [
  { game: "LG", lang: "de", trainer: { name: "LÖWE", tid: 4321, sid: 8765, gender: 1, money: 123456, playTime: { h: 1, m: 2, s: 3 } },
    party: [{ species: 1, level: 12, nickname: "BISASAM", moves: [33, 45] }, { species: 25, level: 30, heldItem: 202, moves: [84, 98] }],
    boxes: [{ box: 0, slot: 0, species: 386, level: 30, fatefulEncounter: true, moves: [43, 35] },
      { box: 3, slot: 9, species: 201, form: 17, level: 10, moves: [237] }, { box: 13, slot: 29, species: 133, nickname: "ÄÖÜß", moves: [33] }] },
  { game: "S", lang: "fr", trainer: { name: "ÉLÉA", tid: 1, sid: 2, gender: 1, money: 999999, playTime: { h: 9, m: 9, s: 9 } },
    party: [{ species: 258, level: 7, nickname: "GOBOU", moves: [33, 45] }, { species: 263, level: 5, isEgg: true, moves: [33] },
      { species: 280, level: 9, moves: [45, 93] }],
    boxes: [{ box: 1, slot: 19, species: 327, level: 20, moves: [33] }, { box: 9, slot: 27, species: 350, level: 40, moves: [57], language: "en", otName: "BOB", tid: 5, sid: 6 }] },
  { game: "E", lang: "es", gen3: { securityKey: "0x13572468", battlePoints: 3 },
    trainer: { name: "ÑOÑO", tid: 777, sid: 888, gender: 0, money: 5, playTime: { h: 0, m: 1, s: 2 } },
    party: [{ species: 386, level: 50, moves: [354, 94] }, { species: 384, level: 70, heldItem: 200, moves: [245] }],
    boxes: [{ box: 6, slot: 18, species: 151, level: 5, moves: [1] }, { box: 11, slot: 17, species: 360, isEgg: true, moves: [150] }] },
  { game: "FR", lang: "it", gen3: { securityKey: "0x2468ace0" },
    trainer: { name: "ROSSO", tid: 31337, sid: 4242, gender: 0, money: 3000, playTime: { h: 10, m: 20, s: 30 } },
    party: [{ species: 6, level: 36, nickname: "DRAGÒ", moves: [53, 17] }, { species: 143, level: 30, moves: [34] }],
    boxes: [{ box: 2, slot: 29, species: 150, level: 70, moves: [94] }] },
];

test("oracle: PKHeX-built saves in other languages and versions read the same, and our edits stay valid", { skip }, () => {
  const dir = tmp();
  SPECS.forEach((spec, k) => {
    const specFile = path.join(dir, `spec-${k}.json`), sav = path.join(dir, `built-${k}.sav`);
    fs.writeFileSync(specFile, JSON.stringify({ registerDex: true, currentBox: 0, ...spec }));
    const d = oracle("build", specFile, sav).save;
    const img = new Uint8Array(fs.readFileSync(sav));
    const det = gen3.detect(img);
    const where = `${spec.game}-${spec.lang}`;
    assert.equal(det.game, { LG: "FRLG", FR: "FRLG", S: "RS", E: "E" }[spec.game], where);
    assert.equal(det.lang, spec.lang, where);
    const s = gen3.open(img, det);
    assert.deepEqual(s.trainer, { ...d.trainer, gender: ["M", "F"][d.trainer.gender] }, where);
    assert.deepEqual(s.pokedex(), d.pokedex, where);
    // PKHeX gives Gen 3 Deoxys form 0; we give it the form of the cartridge it is in (format-gen3.md §8.6).
    const form = (v) => (v.species === 386 ? "cartridge" : v.form);
    for (const p of s.party()) if (p.view.species === 386) assert.equal(p.view.form, { LG: 2, FR: 1, S: 0, E: 3 }[spec.game], where + " Deoxys");
    assert.deepEqual(s.party().map((p) => [hex(p.record), p.view.nickname, form(p.view)]), d.party.map((p) => [p.recordHex, p.nickname, form(p)]), where);
    const ours = [];
    for (let b = 0; b < 14; b++) s.box(b).forEach((m, i) => { if (m) ours.push([b, i, hex(m.record), m.view.nickname, m.view.species]); });
    assert.deepEqual(ours, d.boxes.map((e) => [e.box, e.slot, e.recordHex, e.nickname, e.species]), where);
    const want = edit(img);
    checkWithPkhex(want.out, want, path.join(dir, `ours-${k}.sav`));
  });
});
