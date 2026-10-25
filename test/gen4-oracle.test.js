// Optional differential check of the Gen 4 writer against PKHeX (tools/pkhex-oracle, dev-only, GPL tool used
// as a test oracle). Skipped unless the oracle's Release build and `dotnet` are present. For each fixture it
// applies take/put/register operations with both write strategies, has PKHeX dump the result (checksums must be
// valid) and compares the contents with PKHeX's own `modify` of the same operations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as G4 from "../shared/saves/gen4.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DLL = join(ROOT, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
const available = existsSync(DLL) && spawnSync("dotnet", ["--version"], { encoding: "utf8" }).status === 0;
const skip = available ? false : "PKHeX oracle not built (tools/pkhex-oracle)";

function oracle(...args) {
  const r = spawnSync("dotnet", [DLL, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
  const out = JSON.parse(r.stdout);
  assert.notEqual(out.ok, false, `oracle ${args[0]}: ${out.error}`);
  return out;
}
const sav = (id) => new Uint8Array(readFileSync(join(ROOT, `test/fixtures/saves/${id}.sav`)));
const hexOf = (name) => readFileSync(join(ROOT, `test/fixtures/records/${name}.hex`), "utf8").trim();
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

const CASES = [
  { id: "platinum-en", box: [0, 9], party: 2, put: ["pk4-turtwig-shelly", 4, 29] },
  { id: "platinum-ja", box: [0, 4], party: 0, put: ["pk4-bibarel-hms", 2, 0] },
  { id: "diamond-en", box: [0, 4], party: 0, put: ["pk4-hgss-pikachu-fastball", 3, 7] },
  { id: "heartgold-en", box: [0, 9], party: 1, put: ["pk4-giratina-origin", 17, 0] },
  { id: "heartgold-ko", box: [0, 0], party: 1, put: ["pk4-riolu-egg", 5, 12] },
];
const REGISTER = 327;   // Spinda: not in any fixture's Pokédex

test("saves written by gen4.js load in PKHeX with valid checksums and PKHeX's own modify contents", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gen4-oracle-"));
  try {
    for (const c of CASES) {
      const ops = [
        { op: "deleteBox", box: c.box[0], slot: c.box[1] },
        { op: "deleteParty", slot: c.party },
        { op: "setBox", box: c.put[1], slot: c.put[2], format: "pk4", hex: hexOf(c.put[0]) },
      ];
      writeFileSync(join(dir, "ops.json"), JSON.stringify({ ops }));
      const ref = oracle("modify", `test/fixtures/saves/${c.id}.sav`, join(dir, "ref.sav"), join(dir, "ops.json")).save;
      assert.equal(ref.checksumsValid, true);
      for (const strategy of ["inPlace", "newSave"]) {
        const img = sav(c.id), s = G4.open(img, G4.detect(img), { writeStrategy: strategy });
        s.takeFromBox(...c.box);
        s.takeFromParty(c.party);
        s.putInBox(fromHex(hexOf(c.put[0])), { format: "pk4" }, c.put[1], c.put[2]);
        s.registerDex(REGISTER, { gender: "F", lang: "en", pid: 0x12345678 });
        const file = join(dir, `${c.id}-${strategy}.sav`);
        writeFileSync(file, s.serialize());
        const got = oracle("dump", file);
        const where = `${c.id} ${strategy}`;
        assert.equal(got.checksumsValid, true, `${where}: ${got.checksumInfo}`);
        assert.equal(got.saveType, ref.saveType, where);
        assert.deepEqual(got.trainer, ref.trainer, where);
        assert.deepEqual(got.party, ref.party, where);
        assert.deepEqual(got.boxes, ref.boxes, where);
        assert.deepEqual(got.boxNames, ref.boxNames, where);
        assert.deepEqual(got.pokedex.caught, [...ref.pokedex.caught, REGISTER].sort((a, b) => a - b), where);
        assert.deepEqual(got.pokedex.seen, [...ref.pokedex.seen, REGISTER].sort((a, b) => a - b), where);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PKHeX reads every untouched Gen 4 fixture the way gen4.js re-serializes it", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "gen4-oracle-"));
  try {
    for (const id of ["diamond-en", "platinum-en", "platinum-ja", "heartgold-en", "heartgold-ko"]) {
      const img = sav(id), s = G4.open(img, G4.detect(img));
      const file = join(dir, `${id}.sav`);
      writeFileSync(file, s.serialize());
      const got = oracle("dump", file), ex = JSON.parse(readFileSync(join(ROOT, `test/fixtures/saves/${id}.expected.json`)));
      delete got.file; delete ex.file;
      assert.deepEqual(got, ex, id);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
