/* Differential check of the Gen 1/2 writers against PKHeX (dev only). Runs only when the oracle in
   tools/pkhex-oracle is built and `dotnet` is on PATH; otherwise every test is skipped. Edits each
   writable fixture save with our code, writes it to a temp dir and asks PKHeX to read it back:
   checksums valid, and party, boxes, current box and Pokédex as our own reader sees them. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pk1 from "../shared/pkm/pk1.js";
import * as pk2 from "../shared/pkm/pk2.js";
import * as gen1 from "../shared/saves/gen1.js";
import * as gen2 from "../shared/saves/gen2.js";
import { hex } from "../shared/bytes.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DLL = path.join(ROOT, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
const available = fs.existsSync(DLL) && spawnSync("dotnet", ["--version"], { encoding: "utf8" }).status === 0;
const skip = available ? false : "pkhex-oracle is not built (dev-only)";
const oracle = (...args) => JSON.parse(execFileSync("dotnet", [DLL, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }));
const load = (id) => new Uint8Array(fs.readFileSync(path.join(ROOT, "test/fixtures/saves", id + ".sav")));
const record = (name) => Uint8Array.from(fs.readFileSync(path.join(ROOT, "test/fixtures/records", name + ".hex"), "utf8").trim().match(/../g), (x) => parseInt(x, 16));

const CASES = {
  "red-en": { M: gen1, put: ["pk1-pikachu-sparky", "en"], far: 8, dex: 149 },
  "yellow-en": { M: gen1, put: ["pk1-yellow-pikachu-lightball", "en"], far: 6, dex: 144 },
  "red-ja": { M: gen1, put: ["pk1-ja-pikachu", "ja"], far: 5, dex: 145 },
  "gold-en": { M: gen2, put: ["pk2-unown-q", "en"], far: 10, dex: 243 },
  "crystal-en": { M: gen2, put: ["pk2-togepi-egg", "en"], far: 12, dex: 244 },
  "gold-ja": { M: gen2, put: ["pk2-ja-chikorita", "ja"], far: 7, dex: 245 },
  "crystal-ja": { M: gen2, put: ["pk2-ja-chikorita", "ja"], far: 7, dex: 249 },
};

let dir;
const tmp = () => (dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "gen12-oracle-")));

for (const [id, c] of Object.entries(CASES)) {
  test(`oracle: PKHeX reads ${id} after our edits with valid checksums and the same contents`, { skip }, () => {
    const s = c.M.open(load(id));
    const fmt = c.M === gen1 ? "pk1" : "pk2";
    s.takeFromBox(0, 1);
    const p = s.takeFromParty(0);
    s.putInBox(p.record, p.meta, c.far);                           // a box in bank 3, not current
    s.putInBox(record(c.put[0]), { format: fmt, lang: c.put[1] }, 0); // the current box
    s.registerDex(c.dex);
    if (c.M === gen2) s.registerDex(201, { form: 5 });
    s.setCurrentBox(c.far);
    const file = path.join(tmp(), id + ".sav");
    fs.writeFileSync(file, s.serialize());
    const d = oracle("dump", file);
    assert.equal(d.checksumsValid, true, d.checksumInfo);
    const ours = c.M.open(new Uint8Array(fs.readFileSync(file)));
    assert.equal(d.currentBox, c.far);
    assert.equal(ours.currentBox, c.far);
    assert.deepEqual(d.party.map((m) => m.recordHex), ours.party().map((x) => hex(x.record)));
    const boxes = [];
    for (let b = 0; b < ours.boxCount; b++) ours.box(b).forEach((x, k) => { if (x) boxes.push(`${b}:${k}:${hex(x.record)}`); });
    assert.deepEqual(d.boxes.map((m) => `${m.box}:${m.slot}:${m.recordHex}`), boxes);
    assert.ok(d.pokedex.caught.includes(c.dex) && d.pokedex.seen.includes(c.dex));
    assert.deepEqual(d.pokedex, ours.pokedex());
    if (d.gb) assert.equal(d.gb.currentBoxCopyMatchesBank, true);
  });
}

test("oracle: records built from scratch parse in PKHeX as intended", { skip }, () => {
  const r1 = pk1.build({ species: 6, exp: 125000, moves: [53, 163, 17, 0], pp: [15, 20, 35, 0], ppUps: [3, 0, 0, 0], tid: 4242,
    dvs: { atk: 15, def: 10, spe: 10, spc: 10 }, statExp: { hp: 100, atk: 200, def: 300, spe: 400, spc: 500 }, otName: "RED", nickname: "CHARIZARD", hp: 150 }, { lang: "en" });
  const a = oracle("pkm", "pk1", hex(r1)).pkm;
  const v1 = pk1.toView(pk1.parse(r1, { lang: "en" }), { lang: "en" });
  assert.deepEqual([a.species, a.level, a.exp, a.isShiny, a.nickname, a.isNicknamed, a.extra.catchRate, a.extra.type1, a.extra.type2],
    [6, 50, 125000, true, "CHARIZARD", false, 45, 0x14, 0x02]);
  assert.equal(v1.level, a.level);
  assert.deepEqual(v1.moves.map((m) => [m.id, m.pp, m.ppUps]), a.moves.filter((m) => m.id).map((m) => [m.id, m.pp, m.ppUps]));
  const r2 = pk2.build({ isEgg: true, species: 175, exp: 125, level: 5, moves: [45, 204], pp: [40, 20], tid: 1, friendship: 10,
    dvs: { atk: 10, def: 10, spe: 10, spc: 10 }, otName: "GOLD", nickname: "EGG" }, { lang: "en" });
  const b = oracle("pkm", "pk2", hex(r2).slice(2), "--egg").pkm;
  assert.deepEqual([b.species, b.level, b.isEgg, b.isShiny, b.friendship, b.gender], [175, 5, true, true, 10, 0]);
  const v2 = pk2.toView(pk2.parse(r2, { lang: "en" }), { lang: "en" });
  assert.deepEqual([v2.isEgg, v2.shiny, v2.gender, v2.friendship], [true, true, "M", 10]);
});
