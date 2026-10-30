/* shared/pkm/files.js: exported .pk1-.pk5 files carry the record unchanged, and (when the PKHeX
   oracle is built) PKHeX opens every one of them as the same Pokémon. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { toFile } from "../shared/pkm/files.js";
import { encrypt3, encrypt45 } from "../shared/pkm/crypt.js";
import { openSave } from "../shared/saves/index.js";
import { hex } from "../shared/bytes.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DLL = path.join(root, "tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll");
const hasOracle = (() => { try { return fs.existsSync(DLL) && !!execFileSync("dotnet", ["--version"]); } catch { return false; } })();
const SAVES = ["red-en.sav", "red-ja.sav", "crystal-en.sav", "gold-ja.sav", "gold-ko.sav", "emerald-en.sav", "ruby-ja.sav", "platinum-en.sav", "heartgold-ko.sav", "black-en.sav", "black-ja.sav"];

async function samples() {
  const out = [];
  for (const f of SAVES) {
    const s = await openSave(new Uint8Array(fs.readFileSync(path.join(root, "test/fixtures/saves", f))), f);
    for (const e of [...s.party(), ...s.box(0)].filter(Boolean)) out.push({ f, ...e });
  }
  return out;
}

test("exported files carry the record unchanged and have readable names", async () => {
  for (const { f, record, meta, view } of await samples()) {
    const { bytes, filename } = toFile(record, meta);
    const where = `${f} ${view.speciesName}`;
    assert.ok(filename.endsWith("." + meta.format) && !/[\/\\:]/.test(filename), where + " " + filename);
    if (meta.format === "pk3") assert.equal(hex(encrypt3(bytes)), hex(record), where);
    else if (meta.format === "pk4" || meta.format === "pk5") assert.equal(hex(encrypt45(bytes)), hex(record), where);
    else {
      const nl = meta.lang === "ja" ? 6 : 11, gen = meta.format === "pk1" ? 1 : 2;
      const party = gen === 1 ? 44 : 48, box = gen === 1 ? 33 : 32;
      assert.equal(bytes.length, 3 + party + 2 * nl, where);
      assert.deepEqual([bytes[0], bytes[2]], [1, 0xff], where);
      const struct = bytes.subarray(3, 3 + box), names = bytes.subarray(3 + party);
      assert.equal(hex(struct), hex(record.subarray(gen === 1 ? 0 : 1, (gen === 1 ? 0 : 1) + box)), where + " box struct");
      assert.equal(hex(names), hex(record.subarray(record.length - 2 * nl)), where + " names");
      if (gen === 2) assert.equal(bytes[1], record[0], where + " list entry (0xFD for Eggs)");
    }
  }
});

test("PKHeX opens every exported file as the same Pokémon", { skip: !hasOracle && "PKHeX oracle not built" }, async () => {
  for (const { f, record, meta, view } of await samples()) {
    const { bytes } = toFile(record, meta);
    const args = [DLL, "pkm", meta.format, hex(bytes)];
    if (["pk3", "pk4", "pk5"].includes(meta.format)) args.push("--decrypted");
    const o = JSON.parse(execFileSync("dotnet", args).toString()).pkm;
    const where = `${f} ${view.speciesName}`;
    assert.equal(o.recordHex, hex(record), where);
    assert.deepEqual([o.species, o.level, o.isEgg], [view.species, view.level, view.isEgg], where);
  }
});
