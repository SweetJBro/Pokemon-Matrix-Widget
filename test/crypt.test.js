import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt3, encrypt3, decrypt45, encrypt45, checksum3, checksum45 } from "../shared/pkm/crypt.js";
import { hex, u16le } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fromHex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));

/** Every stored/decrypted pair PKHeX wrote into the save fixtures, by generation. */
function samples(gen) {
  const out = [];
  for (const f of fs.readdirSync(path.join(dir, "saves")).filter((n) => n.endsWith(".expected.json"))) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, "saves", f), "utf8"));
    if (d.generation !== gen) continue;
    for (const m of [...d.party, ...d.boxes]) out.push({ where: `${f} ${m.box ?? "party"}:${m.slot}`, m });
  }
  return out;
}

for (const gen of [3, 4, 5]) {
  test(`gen ${gen}: decrypt/encrypt match PKHeX for every fixture slot`, () => {
    const all = samples(gen);
    assert.ok(all.length > 50, "expected fixture coverage");
    const orders = new Set();
    for (const { where, m } of all) {
      const stored = fromHex(m.storedHex);
      const plain = gen === 3 ? decrypt3(stored) : decrypt45(stored);
      assert.equal(hex(plain), m.decryptedHex, where + " decrypt");
      const again = gen === 3 ? encrypt3(plain) : encrypt45(plain);
      assert.equal(hex(again), m.storedHex, where + " encrypt");
      const sum = gen === 3 ? checksum3(plain) : checksum45(plain);
      assert.equal(sum, u16le(plain, gen === 3 ? 0x1c : 0x06), where + " checksum");
      orders.add(m.shuffleOrder);
    }
    assert.equal(orders.size, 24, "all 24 substructure orders exercised");
  });
}
