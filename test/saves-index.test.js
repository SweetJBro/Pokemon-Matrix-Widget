/* shared/saves/index.js: every fixture through openSave/exportSave, inside the emulator wrappers
   players actually upload, with a real edit in between (take a Pokémon out of a box, export,
   reopen: it is gone, and the wrapper is still the original one). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { openSave, exportSave, moduleForFormat } from "../shared/saves/index.js";
import { concat, setU32le, FormatError, hex } from "../shared/bytes.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "saves");
const FIXTURES = fs.readdirSync(dir).filter((n) => n.endsWith(".sav"));
const load = (n) => new Uint8Array(fs.readFileSync(path.join(dir, n)));
const asc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

const rtc48 = () => Uint8Array.from({ length: 48 }, (_, i) => (i * 7 + 3) & 0xff);
const gbaRtc = () => Uint8Array.from({ length: 16 }, (_, i) => (i * 11 + 1) & 0xff);
function dsv(data) {
  const f = new Uint8Array(0x7a);
  f.set(asc("|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:"));
  [data.length, data.length, 6, 3, data.length, 0].forEach((v, i) => setU32le(f, 82 + i * 4, v));
  f.set(asc("|-DESMUME SAVE-|"), 106);
  return concat(data, f);
}
function nso(image) {
  const build = "1.0.0-test";
  const len = new Uint8Array(4); setU32le(len, 0, build.length);
  const sha = (b) => asc(crypto.createHash("sha1").update(b).digest("hex"));
  return concat(asc("SRAM"), new Uint8Array([3, 0, 0, 0]), sha(asc("rom")), len, asc(build), new Uint8Array([0]), sha(image), image);
}

/** The wrappers each family is uploaded in, as [label, wrap(image)]. */
function wrappers(image) {
  const list = [["raw", (b) => b]];
  if (image.length <= 0x10000) list.push(["rtc trailer", (b) => concat(b, rtc48())]);
  if (image.length === 0x8000) list.push(["NSO", nso]);
  if (image.length === 0x20000) list.push(["GBA rtc", (b) => concat(b, gbaRtc())]);
  if (image.length === 0x80000) list.push(["DeSmuME .dsv", dsv]);
  return list;
}

/** First occupied box slot, as [box, index]. */
function firstBoxed(save) {
  for (let b = 0; b < save.boxCount; b++) {
    const slots = save.box(b);
    const i = slots.findIndex(Boolean);
    if (i >= 0) return [b, i];
  }
  return null;
}

for (const name of FIXTURES) {
  test(`${name}: opens and exports unchanged in every wrapper`, async () => {
    const image = load(name);
    for (const [label, wrapFn] of wrappers(image)) {
      const file = wrapFn(image);
      const save = await openSave(file, name);
      assert.equal(hex(exportSave(save)), hex(file), `${label}: export is byte-identical`);
      assert.equal(exportSave(save, "plain").length, image.length, `${label}: plain export is the bare image`);
      assert.ok(save.trainer && save.party().length > 0, `${label}: has a trainer and party`);
    }
  });

  test(`${name}: taking a Pokémon survives export and reopen`, async () => {
    const image = load(name);
    for (const [label, wrapFn] of wrappers(image)) {
      const file = wrapFn(image);
      const save = await openSave(file, name);
      if (save.readOnly) {
        const at = firstBoxed(save);
        assert.throws(() => save.takeFromBox(...at), FormatError, `${label}: read-only save refuses writes`);
        continue;
      }
      const [b, i] = firstBoxed(save);
      const before = save.box(b).filter(Boolean).length;
      const { record, meta } = save.takeFromBox(b, i);
      assert.ok(record.length > 0 && meta.format === `pk${save.gen}`, `${label}: record and meta`);
      const out = exportSave(save);
      assert.equal(out.length, file.length, `${label}: same file size`);
      assert.equal(hex(out.subarray(out.length - 16)), hex(file.subarray(file.length - 16)), `${label}: wrapper tail kept`);
      const again = await openSave(out, name);
      assert.equal(again.box(b).filter(Boolean).length, before - 1, `${label}: Pokémon is gone after reopening`);
      const put = again.putInBox(record, meta, b);
      assert.equal(hex(again.box(put.box)[put.index].record), hex(record), `${label}: and can be put back`);
    }
  });
}

test("blank, random and truncated files are refused with a player-facing message", async () => {
  for (const [label, bytes] of [["empty", new Uint8Array(0)], ["blank 32K", new Uint8Array(0x8000).fill(0xff)],
    ["random 128K", crypto.randomBytes(0x20000)], ["half a DS save", load("platinum-en.sav").subarray(0, 0x1234)]]) {
    await assert.rejects(openSave(new Uint8Array(bytes), "x.sav"), (e) => e instanceof FormatError && e.message.length > 20, label);
  }
});

test("moduleForFormat maps every record format", () => {
  for (const g of [1, 2, 3, 4, 5]) assert.equal(typeof moduleForFormat(`pk${g}`).detect, "function");
  assert.equal(moduleForFormat("pk9"), null);
});
