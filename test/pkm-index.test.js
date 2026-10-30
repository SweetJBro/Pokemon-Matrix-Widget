import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkRecord, identity, codecFor, FORMATS } from "../shared/pkm/index.js";
import { openSave } from "../shared/saves/index.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const rec = (n) => Uint8Array.from(fs.readFileSync(path.join(dir, "records", n + ".hex"), "utf8").trim().match(/../g), (x) => parseInt(x, 16));

test("every boxed fixture Pokémon passes the strict gate", async () => {
  let n = 0;
  for (const f of fs.readdirSync(path.join(dir, "saves")).filter((x) => x.endsWith(".sav"))) {
    const save = await openSave(new Uint8Array(fs.readFileSync(path.join(dir, "saves", f))), f);
    for (let b = 0; b < save.boxCount; b++) {
      for (const slot of save.box(b)) {
        if (!slot) continue;
        const r = checkRecord(slot.record, slot.meta);
        assert.ok(r.ok, `${f} box ${b} ${slot.view.speciesName}: ${r.errors.join("; ")}`);
        n++;
      }
    }
  }
  assert.ok(n > 500, `checked ${n}`);
});

test("the gate refuses wrong sizes, empty slots, unknown meta and relabelled formats", () => {
  const turtwig = rec("pk4-turtwig-shelly");
  assert.equal(checkRecord(turtwig, { format: "pk4", lang: "en" }).ok, true);
  assert.match(checkRecord(turtwig, { format: "pk5", lang: "en" }).errors.join(), /Poké Transfer/);
  assert.equal(checkRecord(turtwig.subarray(0, 100), { format: "pk4", lang: "en" }).ok, false);
  assert.equal(checkRecord(rec("pk5-empty"), { format: "pk5", lang: "en" }).ok, false);
  assert.equal(checkRecord(turtwig, { format: "pk9", lang: "en" }).ok, false);
  assert.equal(checkRecord(turtwig, { format: "pk4", lang: "xx" }).ok, false);
  assert.equal(checkRecord("nope", { format: "pk4", lang: "en" }).ok, false);
  const ja = rec("pk1-ja-pikachu");
  assert.equal(checkRecord(ja, { format: "pk1", lang: "ja" }).ok, true);
  assert.equal(checkRecord(ja, { format: "pk1", lang: "en" }).ok, false, "a Japanese Gen 1 record is shorter");
  assert.throws(() => codecFor("pk0"));
  assert.deepEqual(FORMATS, ["pk1", "pk2", "pk3", "pk4", "pk5"]);
});

test("identity survives evolution and separates families", () => {
  const a = { gen: 3, species: 280, pid: 0x1234, ot: { tid: 1, sid: 2, name: "MAY" } };
  assert.equal(identity(a), identity({ ...a, species: 282 }), "Ralts and Gardevoir");
  assert.notEqual(identity(a), identity({ ...a, species: 25 }));
  const g = { gen: 1, species: 25, dvs: { atk: 1, def: 2, spe: 3, spc: 4 }, ot: { tid: 9, name: "RED" } };
  assert.equal(identity(g), identity({ ...g, gen: 2, species: 26 }), "Time Capsule keeps DVs and OT");
});
