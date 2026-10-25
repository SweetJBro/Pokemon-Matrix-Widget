/* shared/saves/container.js, rzip.js and bytes.js sha1: every container wrapped around random
   images of each family must unwrap to the image and rebuild byte for byte; edits must touch only
   the edited byte plus the documented fix-ups; refusals must carry a specific message. All inputs
   are synthetic, built here from the layouts in docs/research/ports-and-emulators.md §2 (one RZIP
   v2 file was compressed by RetroArch's own zstd encoder from an image generated here). */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { sha1, hex, u32le, setU32le, concat, FormatError } from "../shared/bytes.js";
import { unwrap, rebuild, maybeDecompress, nocashEncode, nocashDecode, nameHints, explainUnrecognised, IMAGE_SIZES } from "../shared/saves/container.js";

/* ---------- builders ---------- */

let seed = 12345;
function rand(n) {   // deterministic xorshift, with runs mixed in so the RLE has work to do
  const b = new Uint8Array(n);
  for (let i = 0; i < n;) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const r = seed >>> 0;
    if ((r & 0xf) === 0) { const len = Math.min(n - i, (r >>> 8) & 0x3ff); b.fill(r >>> 24, i, i + len); i += len || 1; }
    else b[i++] = r >>> 24;
  }
  return b;
}
const asc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const sha1node = (b) => crypto.createHash("sha1").update(b).digest("hex");
const ndsImage = () => { const b = rand(0x80000); b.fill(0xff, 0x7c000); return b; };   // DS flash ends erased

function nso(image, { rtc = false, build = "1.0.0-test-build" } = {}) {
  const head = [asc("SRAM"), new Uint8Array([3, 0, 0, 0]), asc(sha1node(asc("rom")))];
  const len = new Uint8Array(4); setU32le(len, 0, build.length);
  head.push(len, asc(build), new Uint8Array([rtc ? 1 : 0]));
  if (rtc) head.push(rand(0x20));
  head.push(asc(sha1node(image)), image);
  return concat(...head);
}
function nocashHeader(method) {
  const h = new Uint8Array(0x50);
  h.set(asc("NocashGbaBackupMediaSavDataFile")); h[0x1f] = 0x1a;
  h.set(rand(0x20), 0x20); h.set(asc("SRAM"), 0x40); setU32le(h, 0x44, method);
  return h;
}
function nocash(image, method, encode = nocashEncode, tail = new Uint8Array(0)) {
  const h = nocashHeader(method);
  if (method === 0) { setU32le(h, 0x48, image.length); return concat(h.subarray(0, 0x4c), image, tail); }
  const packed = encode(image);
  setU32le(h, 0x48, packed.length); setU32le(h, 0x4c, image.length);
  return concat(h, packed, tail);
}
const DSV_TEXT = "|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:";
function dsv(data, { written = data.length, padSize = data.length, type = 6, memSize = data.length } = {}) {
  const f = new Uint8Array(0x7a);
  f.set(asc(DSV_TEXT));
  [written, padSize, type, 3, memSize, 0].forEach((v, i) => setU32le(f, 82 + i * 4, v));
  f.set(asc("|-DESMUME SAVE-|"), 106);
  return concat(data, f);
}
async function rzip(inner, { version = 1, chunkSize = 0x8000, compress } = {}) {
  const parts = [];
  for (let o = 0; o < inner.length; o += chunkSize) {
    const chunk = inner.subarray(o, o + chunkSize);
    const data = compress ? compress(chunk) : new Uint8Array(await new Response(new Blob([chunk]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    const n = new Uint8Array(4); setU32le(n, 0, data.length);
    parts.push(n, data);
  }
  const h = new Uint8Array(20);
  h.set(asc("#RZIPv")); h[6] = version; h[7] = 0x23;
  setU32le(h, 8, chunkSize); setU32le(h, 12, inner.length);
  return concat(h, ...parts);
}

/** The (first, or `which`-selected) candidate of this kind and family; asserts it exists. */
function pick(cands, kind, family, which = () => true) {
  const c = cands.find((x) => x.info.kind === kind && x.info.family === family && which(x));
  assert.ok(c, `no ${kind}/${family} candidate among ${cands.map((x) => x.info.kind + "/" + x.info.family).join(", ")}`);
  return c;
}
function diffs(a, b) {
  assert.equal(a.length, b.length);
  const out = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

/* ---------- sha1 ---------- */

test("sha1 matches the FIPS 180 vectors and node:crypto", () => {
  assert.equal(hex(sha1(new Uint8Array(0))), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
  assert.equal(hex(sha1(asc("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(hex(sha1(asc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))), "84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  assert.equal(hex(sha1(new Uint8Array(1000000).fill(0x61))), "34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  for (let n = 0; n <= 200; n++) { const b = rand(n); assert.equal(hex(sha1(b)), sha1node(b), `length ${n}`); }
  const big = rand(0x80000);
  assert.equal(hex(sha1(big)), sha1node(big));
  assert.equal(hex(sha1(big.subarray(3, 0x8003))), sha1node(big.subarray(3, 0x8003)), "works on a view with an offset");
});

/* ---------- round trips ---------- */

const gb = rand(0x8000), jp = rand(0x10000), gba = rand(0x20000), half = rand(0x10000), nds = ndsImage();
const CASES = [
  ["GB raw", gb, gb, "raw", "gb"],
  ["GB + 48-byte RTC", concat(gb, rand(48)), gb, "trailer", "gb"],
  ["GB + 44-byte RTC", concat(gb, rand(44)), gb, "trailer", "gb"],
  ["GB + 13-byte RTC", concat(gb, rand(13)), gb, "trailer", "gb"],
  ["GB + 9-byte RTC", concat(gb, rand(9)), gb, "trailer", "gb"],
  ["GB + 20 unknown bytes", concat(gb, rand(20)), gb, "trailer", "gb"],
  ["GB NSO", nso(gb), gb, "nso", "gb"],
  ["GB NSO with RTC", nso(gb, { rtc: true }), gb, "nso", "gb"],
  ["JP Crystal raw", jp, jp, "raw", "gb"],
  ["JP Crystal + 48", concat(jp, rand(48)), jp, "trailer", "gb"],
  ["JP Crystal NSO", nso(jp), jp, "nso", "gb"],
  ["GB NSO, 1-char build (outside PKHeX's size range)", nso(gb, { build: "x" }), gb, "nso", "gb"],
  ["GB NSO, 255-char build with RTC", nso(gb, { build: "b".repeat(255), rtc: true }), gb, "nso", "gb"],
  ["GBA raw", gba, gba, "raw", "gba"],
  ["GBA + 16 (mGBA)", concat(gba, rand(16)), gba, "trailer", "gba"],
  ["GBA + 7 (FlashGBX)", concat(gba, rand(7)), gba, "trailer", "gba"],
  ["GBA half", half, half, "raw", "gba"],
  ["GBA half + 16", concat(half, rand(16)), half, "trailer", "gba"],
  ["GBA No$GBA m0", nocash(gba, 0), gba, "nocash", "gba"],
  ["GBA No$GBA m1", nocash(gba, 1), gba, "nocash", "gba"],
  ["GBA half No$GBA m1", nocash(half, 1), half, "nocash", "gba"],
  ["NDS raw", nds, nds, "raw", "nds"],
  ["NDS DeSmuME", dsv(nds), nds, "dsv", "nds"],
  ["NDS DeSmuME short", dsv(nds.subarray(0, 0x40000), { type: 5 }), nds.subarray(0, 0x40000), "dsv", "nds"],
  ["NDS Action Replay", concat(rand(0xa4), nds), nds, "ards", "nds"],
  ["NDS No$GBA m0", nocash(nds, 0), nds, "nocash", "nds"],
  ["NDS No$GBA m1", nocash(nds, 1, nocashEncode, rand(5)), nds, "nocash", "nds"],
  ["NDS + 512 KiB of 0xFF", concat(nds, new Uint8Array(0x80000).fill(0xff)), nds, "padded", "nds"],
  ["NDS in unknown container", concat(rand(0x40), nds, rand(0x10)), nds, "window", "nds", (c) => c.info.prefix.length === 0x40],
];

for (const [name, file, image, kind, family, which] of CASES) {
  test(`round trip: ${name}`, () => {
    const c = pick(unwrap(file, "game.sav"), kind, family, which);
    assert.equal(c.info.imageLength, image.length);
    assert.ok(IMAGE_SIZES.includes(c.image.length));
    assert.equal(c.image.length, c.info.canonicalSize);
    assert.deepEqual(c.image.subarray(0, image.length), image);
    if (c.info.short) assert.ok(c.image.subarray(image.length).every((x) => x === c.info.padByte));
    assert.deepEqual(rebuild(c.image, c.info), file, "same container, byte for byte");
    const plain = rebuild(c.image, c.info, "plain");
    assert.ok(IMAGE_SIZES.includes(plain.length));
    assert.deepEqual(plain.subarray(0, image.length), image);
    assert.ok(plain.subarray(image.length).every((x) => x === 0xff), "plain pads with 0xFF");
    assert.ok(c.info.notes.every((n) => typeof n === "string") && typeof c.info.label === "string");
  });
}

test("a 0x6C123-byte zero-padded save.bin round-trips at its own length", () => {
  const img = rand(0x6c123); img.fill(0, 0x6c123 - 0x2000);
  const [c, ...rest] = unwrap(img, "C:\\Games\\pokeplatinum\\save.bin");
  assert.equal(rest.length, 0);
  assert.equal(c.info.kind, "short");
  assert.equal(c.info.padByte, 0x00);
  assert.equal(c.info.canonicalSize, 0x80000);
  assert.ok(c.info.nameHints.saveBin);
  assert.ok(c.image.subarray(0x6c123).every((x) => x === 0));
  assert.deepEqual(rebuild(c.image, c.info), img);

  const inside = c.image.slice(); inside[0x1234] ^= 0xff;
  const out1 = rebuild(inside, c.info);
  assert.equal(out1.length, 0x6c123, "edits inside keep the length");
  assert.deepEqual(diffs(out1, img), [0x1234]);

  const beyond = c.image.slice(); beyond[0x70000] = 0x42;
  const out2 = rebuild(beyond, c.info);
  assert.equal(out2.length, 0x80000, "edits past the end write the whole image");
  assert.deepEqual(out2.subarray(0, 0x6c123), img);
  assert.equal(out2[0x70000], 0x42);

  const plain = rebuild(c.image, c.info, "plain");
  assert.equal(plain.length, 0x80000);
  assert.ok(plain.subarray(0x6c123).every((x) => x === 0xff), "an untouched zero pad becomes erased flash");
  assert.equal(rebuild(beyond, c.info, "plain")[0x70000], 0x42);
});

test("a short file with an unknown name: zero tail -> 0x00 pad, 0xFF tail -> 0xFF pad", () => {
  const z = rand(0x50000); z.fill(0, 0x4f000);
  assert.equal(unwrap(z, "x.sav")[0].info.padByte, 0x00);
  const f = rand(0x50000); f.fill(0xff, 0x4f000);
  const [c] = unwrap(f, "x.sav");
  assert.equal(c.info.kind, "short");
  assert.equal(c.info.padByte, 0xff);
  assert.deepEqual(rebuild(c.image, c.info), f);
});

test("save.bin always gets a short DS candidate first, even at a GBA size", () => {
  const cands = unwrap(gba, "save.bin");
  assert.deepEqual(cands.map((c) => [c.info.kind, c.info.family]), [["short", "nds"], ["raw", "gba"]]);
  assert.equal(cands[0].info.imageLength, 0x20000);
  assert.deepEqual(rebuild(cands[0].image, cands[0].info), gba);
  assert.equal(unwrap(gba, "save (1).bin")[0].info.kind, "short", "browser download renames still count");
});

/* ---------- edits and fix-ups ---------- */

test("after one edit only that byte changes (plain containers)", () => {
  for (const [name, file, , kind, family, which] of CASES) {
    if (kind === "nso" || (kind === "nocash" && u32le(file, 0x44) === 1)) continue;
    const c = pick(unwrap(file), kind, family, which);
    const img = c.image.slice(); img[100] ^= 0x5a;
    const out = rebuild(img, c.info);
    const at = c.info.kind === "nocash" ? 0x4c + 100 : c.info.prefix.length + 100;
    assert.deepEqual(diffs(out, file), [at], name);
  }
});

test("NSO: the payload SHA-1 is recomputed after an edit", () => {
  for (const file of [nso(gb), nso(gb, { rtc: true }), nso(jp)]) {
    const [c] = unwrap(file);
    assert.equal(c.info.nso.hashOk, true);
    const img = c.image.slice(); img[0x2000] ^= 1;
    const out = rebuild(img, c.info);
    const h = c.info.nso.hashOffset;
    assert.equal(String.fromCharCode(...out.subarray(h, h + 40)), sha1node(img), "lowercase hex of the new payload");
    const changed = diffs(out, file);
    assert.ok(changed.includes(c.info.prefix.length + 0x2000));
    assert.ok(changed.every((i) => i === c.info.prefix.length + 0x2000 || (i >= h && i < h + 40)), "only the byte and the hash");
  }
});

test("NSO: a wrong stored hash is reported and corrected", () => {
  const file = nso(gb);
  const [c0] = unwrap(file);
  file.set(asc("0".repeat(40)), c0.info.nso.hashOffset);
  const [c] = unwrap(file);
  assert.equal(c.info.nso.hashOk, false);
  assert.ok(c.info.notes.some((n) => /did not match/.test(n)));
  const out = rebuild(c.image, c.info);
  assert.equal(String.fromCharCode(...out.subarray(c.info.nso.hashOffset, c.info.nso.hashOffset + 40)), sha1node(gb));
});

test("No$GBA RLE: encode/decode identity, run edge cases, worst-case bound", () => {
  const samples = [new Uint8Array(0), new Uint8Array([7]), new Uint8Array([1, 1]), new Uint8Array(3).fill(9), rand(5000),
    new Uint8Array(0x7f).fill(1), new Uint8Array(0x80).fill(2), new Uint8Array(0xffff).fill(3), new Uint8Array(0x10001).fill(4),
    concat(rand(300), new Uint8Array(0x200).fill(0xff), rand(2)), nds];
  for (const s of samples) {
    const p = nocashEncode(s);
    assert.equal(p[p.length - 1], 0, "ends with the 0x00 marker");
    assert.ok(p.length <= s.length + Math.ceil(s.length / 127) + 2);
    assert.deepEqual(nocashDecode(p, s.length), s);
  }
  // Hand-made stream with every control form: literal, short fill, long fill.
  const packed = new Uint8Array([2, 0xaa, 0xbb, 0x83, 0x11, 0x80, 0x22, 0x05, 0x01, 0]);
  assert.deepEqual(nocashDecode(packed, 2 + 3 + 0x105), concat(new Uint8Array([0xaa, 0xbb]), new Uint8Array(3).fill(0x11), new Uint8Array(0x105).fill(0x22)));
  assert.throws(() => nocashDecode(packed, 100), FormatError, "size mismatch is refused");
});

test("No$GBA method 1: a foreign encoding survives unchanged, an edit re-encodes", () => {
  const literalsOnly = (img) => {   // valid, but not what our encoder would produce
    const parts = [];
    for (let o = 0; o < img.length; o += 0x40) parts.push(new Uint8Array([Math.min(0x40, img.length - o)]), img.subarray(o, o + 0x40));
    return concat(...parts, new Uint8Array([0]));
  };
  const file = nocash(gba, 1, literalsOnly, rand(3));
  const [c] = unwrap(file);
  assert.equal(c.info.nocash.method, 1);
  assert.deepEqual(rebuild(c.image, c.info), file, "unchanged image keeps the original packed bytes");
  const img = c.image.slice(); img[0x1fff] ^= 0xff;
  const out = rebuild(img, c.info);
  assert.deepEqual(out.subarray(0, 0x48), file.subarray(0, 0x48), "header text and unknown fields kept");
  assert.equal(u32le(out, 0x4c), 0x20000);
  const packedLength = u32le(out, 0x48);
  assert.deepEqual(nocashDecode(out.subarray(0x50, 0x50 + packedLength), 0x20000), img);
  assert.deepEqual(out.subarray(0x50 + packedLength), file.subarray(file.length - 3), "bytes after the data kept");
  assert.ok(packedLength < u32le(file, 0x48), "our encoder is smaller than literals-only");
});

test("known-answer layouts, laid out by absolute offset rather than by the builders", () => {
  // DeSmuME readFooter: cookie in the last 16 bytes, version u32 at end-20, then it steps back 24 and
  // reads size, padSize, type, addr_size, mem_size from end-40 onwards (format-gen5 §2: padSize at end-0x24).
  const L = 0x80000 + 0x7a, d = new Uint8Array(L);
  d.set(nds.subarray(0, 0x80000));
  d.set(asc(DSV_TEXT), L - 122);
  [[40, 0x7f123], [36, 0x80000], [32, 6], [28, 3], [24, 0x80000], [20, 0]].forEach(([back, v]) => setU32le(d, L - back, v));
  d.set(asc("|-DESMUME SAVE-|"), L - 16);
  const [s] = unwrap(d);
  assert.equal(s.info.kind, "dsv");
  assert.deepEqual(s.info.dsv, { written: 0x7f123, padSize: 0x80000, type: 6, addrSize: 3, memSize: 0x80000 });
  d[L - 20] = 1;   // version != 0: DeSmuME treats the file as raw, so do we (here: a DS save in an unknown container)
  assert.ok(unwrap(d).every((c) => c.info.kind === "window"));

  // NSO with a 5-byte build string and no RTC: length u32 @0x30, build @0x34, hasRTC @0x39, payload
  // hash @0x3A..0x61 (lowercase hex), SRAM from 0x62.
  const n = new Uint8Array(0x62 + 0x8000);
  n.set(asc("SRAM")); setU32le(n, 0x30, 5); n.set(asc("1.2.3"), 0x34); n[0x39] = 0;
  n.set(asc(sha1node(gb)), 0x3a); n.set(gb, 0x62);
  const [c] = unwrap(n);
  assert.equal(c.info.kind, "nso");
  assert.deepEqual([c.info.prefix.length, c.info.nso.hashOffset, c.info.nso.hasRtc, c.info.nso.build, c.info.nso.hashOk], [0x62, 0x3a, false, "1.2.3", true]);
  assert.deepEqual(c.image, gb);
});

test("DeSmuME footer: fields parsed, sizes updated only when a short image grows", () => {
  const [c] = unwrap(dsv(nds, { written: 0x7ffff }));
  assert.deepEqual(c.info.dsv, { written: 0x7ffff, padSize: 0x80000, type: 6, addrSize: 3, memSize: 0x80000 });
  assert.equal(c.info.short, false);

  const shortFile = dsv(nds.subarray(0, 0x40000), { type: 5 });
  const [s] = unwrap(shortFile);
  assert.equal(s.info.short, true);
  assert.equal(s.info.padByte, 0xff);
  assert.equal(s.info.dsv.padSize, 0x40000);
  const img = s.image.slice(); img[0x50000] = 0;
  const out = rebuild(img, s.info);
  assert.equal(out.length, 0x80000 + 0x7a);
  assert.deepEqual(out.subarray(0, 0x80000), img);
  const f = 0x80000;
  assert.deepEqual([82, 86, 90, 94, 98, 102].map((o) => u32le(out, f + o)), [0x80000, 0x80000, 6, 3, 0x80000, 0]);
  assert.deepEqual(out.subarray(f, f + 82), asc(DSV_TEXT));
  assert.deepEqual(out.subarray(out.length - 16), asc("|-DESMUME SAVE-|"));
  const again = pick(unwrap(out), "dsv", "nds");
  assert.equal(again.info.short, false);
  assert.deepEqual(again.image, img);
});

/* ---------- ambiguity ---------- */

test("0x10000 and 0x10010 / 0x10030 give a GBA-half and a JP Crystal candidate", () => {
  const order = (file) => unwrap(file).map((c) => c.info.family);
  assert.deepEqual(order(half), ["gba", "gb"]);
  assert.deepEqual(order(concat(half, rand(16))), ["gba", "gb"], "16-byte trailer: GBA RTC first");
  assert.deepEqual(order(concat(half, rand(48))), ["gb", "gba"], "48-byte trailer: GB RTC first");
  const [a, b] = unwrap(concat(half, rand(16)));
  assert.equal(a.info.canonicalSize, 0x20000);
  assert.ok(a.info.readOnly && /64 KiB/.test(a.info.readOnly));
  assert.equal(a.info.trailer.type, "gba-rtc-16");
  assert.equal(b.info.canonicalSize, 0x10000);
  assert.equal(b.info.readOnly, null);
  assert.equal(b.info.trailer.type, "unknown");
  assert.notEqual(a.image.buffer, b.image.buffer, "independent images");
});

test("trailer kinds are named", () => {
  const t = (file) => unwrap(file)[0].info.trailer.type;
  assert.equal(t(concat(gb, rand(48))), "gb-rtc-48");
  assert.equal(t(concat(gb, rand(44))), "gb-rtc-44");
  assert.equal(t(concat(gba, rand(16))), "gba-rtc-16");
  assert.equal(t(concat(gba, rand(7))), "gba-rtc-7");
  assert.equal(t(concat(gba, rand(0x30))), "unknown");
});

test("Action Replay size also offers other windows; padded tail also offers windows", () => {
  const busyEnd = rand(0x80000); busyEnd[0x7ffff] = 0x12;   // last 0xA4 bytes are not one value
  const cands = unwrap(concat(rand(0xa4), busyEnd));
  assert.equal(cands[0].info.kind, "ards");
  assert.equal(cands.length, 1 + 0xa4, "every other split of the 0xA4 extra bytes");
  assert.ok(cands.slice(1).every((c) => c.info.kind === "window"));
  assert.deepEqual(cands.slice(1).map((c) => c.info.prefix.length), [...Array(0xa5).keys()].filter((p) => p !== 0xa4));
  // DS flash usually ends erased, so the same file shape also reads as "image + 0xFF tail".
  const erasedEnd = unwrap(concat(rand(0xa4), nds));
  assert.deepEqual(erasedEnd.slice(0, 2).map((c) => c.info.kind), ["ards", "padded"]);
  assert.equal(erasedEnd.length, 1 + 0xa4);
  const padded = unwrap(concat(nds, new Uint8Array(0x100).fill(0xff)));
  assert.equal(padded[0].info.kind, "padded");
  assert.equal(padded.length, 1 + 0x100);
  for (const c of [...cands.slice(0, 3), ...padded.slice(0, 3)]) {
    assert.deepEqual(rebuild(c.image, c.info), concat(c.info.prefix, c.image, c.info.suffix));
  }
});

test("file name hints", () => {
  assert.deepEqual(nameHints("/x/save.bin"), { saveBin: true, bin: true, virtualConsole: false, switchFrlg: false, yellowExtended: false });
  assert.deepEqual(nameHints("C:\\Users\\a\\Pokemon Red.sav"), { saveBin: false, bin: false, virtualConsole: false, switchFrlg: false, yellowExtended: false });
  assert.equal(nameHints("sav.dat").virtualConsole, true);
  assert.equal(nameHints("FireRed_e.sav").switchFrlg, true);
  assert.equal(nameHints("savefile.bin").saveBin, false);
  const [c] = unwrap(gb, "sav.dat");
  assert.ok(c.info.nameHints.virtualConsole && c.info.notes.some((n) => /Virtual Console/.test(n)));
  assert.ok(unwrap(gba, "LeafGreen_e.sav")[0].info.notes.some((n) => /Switch/.test(n)));
});

/* ---------- RetroArch RZIP ---------- */

test("RZIP v1: decompressed in the pre-pass, exported uncompressed", async () => {
  const inner = concat(gba, rand(16));
  const file = await rzip(inner);
  const { bytes, layers } = await maybeDecompress(file);
  assert.deepEqual(bytes, inner);
  assert.deepEqual(layers, [{ kind: "rzip", version: 1, chunkSize: 0x8000, totalSize: inner.length }]);
  const [c] = unwrap(bytes, "Pokemon Emerald.srm", { layers });
  assert.equal(c.info.kind, "trailer");
  assert.equal(c.info.layers[0].kind, "rzip");
  assert.ok(/uncompressed/.test(c.info.label) && c.info.notes.some((n) => /RetroArch reads/.test(n)));
  assert.deepEqual(rebuild(c.image, c.info), inner, "the download is the plain .srm");
  const plainInput = await maybeDecompress(gb);
  assert.equal(plainInput.bytes, gb);
  assert.deepEqual(plainInput.layers, []);
});

const zstdFrame = (params = {}) => (chunk) => new Uint8Array(zlib.zstdCompressSync(chunk, { params }));
const Z = zlib.constants;
const NEEDS_ZSTD = { skip: typeof zlib.zstdCompressSync !== "function" && "this Node has no node:zlib zstd encoder to build fixtures" };

test("RZIP v2 (zstd): real frames decode through the vendored fzstd", NEEDS_ZSTD, async () => {
  const inner = concat(gba, rand(16));
  for (const params of [{}, { [Z.ZSTD_c_compressionLevel]: 19, [Z.ZSTD_c_checksumFlag]: 1 }, { [Z.ZSTD_c_contentSizeFlag]: 0 }]) {
    const file = await rzip(inner, { version: 2, chunkSize: 131072, compress: zstdFrame(params) });
    assert.equal(file[6], 2);
    const { bytes, layers } = await maybeDecompress(file);
    assert.deepEqual(bytes, inner);
    assert.deepEqual(layers, [{ kind: "rzip", version: 2, chunkSize: 131072, totalSize: inner.length }]);
    const [c] = unwrap(bytes, "Pokemon Ruby.srm", { layers });
    assert.deepEqual(c.image, gba);
    assert.deepEqual(rebuild(c.image, c.info), inner, "exported uncompressed");
  }
  const big = await rzip(nds, { version: 2, compress: zstdFrame() });   // 16 chunks of 32 KiB
  assert.deepEqual((await maybeDecompress(big)).bytes, nds);
});

/* An RZIP v2 .srm written by RetroArch's own clean-room zstd encoder (libretro-common
   encodings/encoding_rzstd.c at RetroArch ae6b6ee, level 3, 131072-byte chunks; current RetroArch
   uses it whenever it was built with HAVE_RZSTD), around the 32 KiB image rzstdImage() rebuilds:
   one single-segment frame with its content size, one compressed block, Huffman literals. */
const RZSTD_SRM =
  "I1JaSVB2AiMAAAIAAIAAAAAAAAA8AwAAKLUv/WAAf5UZADpBWAwbEbBLtQHy/3/ytVGfsPSJQdVaK620VkoprRQVkgCRAJMAjJA7tpy0vWru3Ufa" +
  "ft3rxtCVs02b/DF/TjUu5zq9o7Xr7hjLxIxS0Tvql77Q+3RHD1EuJ0wrfyXO381+17raH6tbXcQ+dZUqc9vMG2vss1961RJlLsfFtLicrRNKR6bJ" +
  "3p1DtZZCyIscWyPWWi1VtVbC/0zZkvE/93TxctoaUbd0aJtqVWaH69ncW7WG64jWSwGP0FLOXqfmxavWyk3HdJQasTXfovQcU+3M3mcKVWtOhMqx" +
  "h7uuofK2bf+xtBpq3NxSY3bqvhguSufa2z9GTa6p5utyv1LrGNWrxa51r8b3qstXUsmJjd9Dm5ZymJZ20sxH6D65pcNe53Wp2siqvjGEslM7ynbl" +
  "KtH6/8SOnhon7Nbc0vG3o3vXpr4sOymniY4D/NZpNrYUJvTzg42XqbpFzt5qKyJn76HW29Ym99Z775vXK0vNlXKlyw1/n1WTF2v36tHyY8yN5eZi" +
  "tI983eLsfb2oVarWmHX7LUqvWPlSTq2Fnm2+Y7NDbtuZ8uTUW13mHHHhaqzW6rbTl99MMVfF1s9rqW9tRWRMrWl6ilgVP0useD/l22ULOaQSW6E+" +
  "cyk1tYguP8jHx6fnzhwfPD105tip44N+8pRDzjjihAPON950w8022mSDzTXWVEPNNNJEA80zzjTDzDLKJIPMMcYUQ8wwwgQDzC++9MLLLrrkgsst" +
  "ttRCyyyyxALLK660wsoqqqSCyimmlELKKKKEAsonnnTCySaaZILJJZZUQskkkkQCySOONMLIIookgsghhhRCyCCCBALIH370wcceeuSBxx121EHH" +
  "HHLEAccbbrTBxhpqpIHGGWaUQcYYYoQBxhdedMHFFlpkgcUVVlRBxRRSRAHFE040wcQSSiSBxBFGFEHEEEIEAcQPPuDp4Q4PO/jokAMON9ixoU5P" +
  "DTTMIAOdGObA8IILLbCwggopoHCCCSWQMIIIIYDwgQcdcLCBBhlgcIEFFVAwgQQRQPCAAw0wsIACCSBwgAEFEDCAAAEA8N4BBQD8D/DC/9e/3hfj" +
  "KwH8Bmg1CdxnPEgD";
function rzstdImage() {   // erased SRAM with low-entropy noise, a counter, a repeated record and a zero block
  const b = new Uint8Array(0x8000).fill(0xff);
  let x = 0x2545f491;
  for (let i = 0; i < 0x300; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = (x >>> 24) & 0x0f; }
  for (let i = 0x3000; i < 0x3400; i++) b[i] = i & 0xff;
  const rec = asc("PIKACHU\x50ASH\x50\x50\x50");
  for (let i = 0x3400; i < 0x4000; i += rec.length) b.set(rec.subarray(0, Math.min(rec.length, 0x4000 - i)), i);
  b.fill(0, 0x4000, 0x5000);
  return b;
}

test("RZIP v2 written by RetroArch's own zstd encoder decodes through the vendored fzstd", async () => {
  const file = new Uint8Array(Buffer.from(RZSTD_SRM, "base64"));
  assert.equal(file.length, 852);
  const inner = rzstdImage();
  assert.equal(sha1node(inner), "d86e15000635065369bc8f7199bfeb9076ff7ee2", "the generator still makes the encoded image");
  const { bytes, layers } = await maybeDecompress(file);
  assert.deepEqual(layers, [{ kind: "rzip", version: 2, chunkSize: 131072, totalSize: 0x8000 }]);
  assert.deepEqual(bytes, inner);
  const [c] = unwrap(bytes, "Pokemon Crystal.srm", { layers });
  assert.equal(c.info.kind, "raw");
  assert.deepEqual(rebuild(c.image, c.info), inner, "exported as the plain .srm");
});

test("RZIP v2 (zstd): refused with instructions when no decoder is available", NEEDS_ZSTD, async () => {
  const file = await rzip(gb, { version: 2, compress: zstdFrame() });
  await assert.rejects(maybeDecompress(file, { zstd: false }), (e) => e instanceof FormatError && e.detail.code === "rzip-zstd" && /SaveRAM Compression/.test(e.message));
  const stored = await rzip(gb, { version: 2, compress: (c) => c.slice() });   // not zstd at all
  await assert.rejects(maybeDecompress(stored), (e) => e.detail.code === "rzip-damaged");
  const { bytes } = await maybeDecompress(stored, { zstd: (b) => b.slice() });   // a caller-supplied decoder wins
  assert.deepEqual(bytes, gb);
  assert.throws(() => unwrap(file), (e) => e.detail.code === "rzip" && /SaveRAM Compression/.test(e.message), "unwrap without the pre-pass");
});

test("RZIP: damaged and still-compressed inputs", async () => {
  const file = await rzip(gb);
  await assert.rejects(maybeDecompress(file.subarray(0, file.length - 10)), (e) => e.detail.code === "rzip-damaged");
  const bad = file.slice(); bad[30] ^= 0xff;
  await assert.rejects(maybeDecompress(bad), (e) => e.detail.code === "rzip-damaged");
  assert.throws(() => unwrap(file), (e) => e instanceof FormatError && e.detail.code === "rzip");
});

/* ---------- refusals ---------- */

const refused = (code, re) => (e) => e instanceof FormatError && e.detail.code === code && re.test(e.message);

test("refusals: save states, Lua saves, archives, ROMs, odd sizes", () => {
  const big = (prefix) => concat(asc(prefix), rand(0x60000));
  assert.throws(() => unwrap(big("RASTATE\x01MEM ")), refused("save-state", /save state/));
  assert.throws(() => unwrap(concat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), rand(1000)), "x.ss1"), refused("save-state", /PNG/));
  assert.throws(() => unwrap(rand(0x5fe23), "Pokemon Red.state3"), refused("save-state", /in-game/));
  assert.throws(() => unwrap(asc("\ufeff-- G1R\nreturn {\n  version = 4,\n}\n".replace("\ufeff", "\xef\xbb\xbf")), "save.lua"), refused("lua-save", /Export save/));
  assert.throws(() => unwrap(asc("return{badges=8}"), "x"), refused("lua-save", /G1R Deluxe/));
  assert.throws(() => unwrap(concat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), rand(500))), refused("archive", /Extract/));
  const rom = rand(0x100000); rom.set([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b], 0x104);
  assert.throws(() => unwrap(rom, "pokered.gb"), refused("rom", /ROM/));
  assert.throws(() => unwrap(rand(12345), "weird.sav"), refused("unknown-size", /12,345 bytes/));
  assert.throws(() => unwrap(rand(0x300), "save.bin"), refused("unknown-size", /not the size/));
  assert.throws(() => unwrap(new Uint8Array(0)), refused("empty", /empty/));
  assert.throws(() => unwrap(concat(nds, rand(0x500))), refused("unknown-size", /not the size/));
  assert.throws(() => unwrap(concat(asc("MELN"), rand(0x400000))), refused("save-state", /save state/));
  assert.throws(() => unwrap(concat(new Uint8Array([0x1f, 0x8b, 0x08, 0]), rand(5000)), "Pokemon Red.sgm"), refused("compressed", /gzip/));
  assert.throws(() => unwrap(concat(asc("7z\xbc\xaf\x27\x1c"), rand(0x8000))), refused("archive", /7z/));
});

test("a save that merely starts with gzip, zip or MELN bytes is not refused", () => {
  // Gen 1/2 SRAM opens with sprite buffers, so any byte pattern can sit at offset 0; short magics
  // only count when no save shape explains the size.
  for (const magic of [[0x1f, 0x8b, 0x08], [0x50, 0x4b, 0x03, 0x04], [0x4d, 0x45, 0x4c, 0x4e]]) {
    for (const [base, extra] of [[gb, 0], [gb, 48], [gba, 0], [gba, 16], [nds, 0]]) {
      const file = concat(base, rand(extra)); file.set(magic);
      const [c] = unwrap(file, "Pokemon.sav");
      assert.deepEqual(rebuild(c.image, c.info), file);
    }
  }
});

test("a Yellow Recomp \"Extended\"-looking name makes the save read-only, not refused", () => {
  const [c] = unwrap(gb, "Pokemon_Yellow_Extended.sav");
  assert.equal(c.info.kind, "raw");
  assert.match(c.info.readOnly, /Extended.*Stock.*rename/s);
  assert.ok(c.info.notes.some((n) => /rename/.test(n)));
  assert.deepEqual(rebuild(c.image, c.info), gb);
  assert.match(explainUnrecognised(unwrap(gb, "pokemon yellow extended.sav")), /Yellow Recomp "Extended"/);
  assert.equal(unwrap(gb, "Pokemon Yellow.sav")[0].info.readOnly, null);
  // Only the Game Boy reading is affected: a 64 KiB file keeps its GBA-half reason, JP Crystal gets this one.
  const [h, j] = unwrap(half, "Yellow_Extended.sav");
  assert.match(h.info.readOnly, /64 KiB/);
  assert.match(j.info.readOnly, /Extended/);
  assert.match(explainUnrecognised([]), /not a Pokémon save/);
});

test("refusals: No$GBA with an unknown method or a non-Pokémon size", () => {
  const h = nocashHeader(2);
  assert.throws(() => unwrap(concat(h, rand(100))), refused("nocash-method", /raw saves/));
  assert.throws(() => unwrap(nocash(rand(0x2000), 0)), refused("nocash-size", /8,192 bytes/));
  const cut = nocash(gba, 0).subarray(0, 0x1000);
  assert.throws(() => unwrap(cut), refused("nocash-damaged", /damaged/));
});

test("explainUnrecognised: blank saves and the generic message", () => {
  assert.match(explainUnrecognised(unwrap(new Uint8Array(0x20000).fill(0xff))), /blank/);
  assert.match(explainUnrecognised(unwrap(rand(0x10000))), /Game Boy Advance or Game Boy save/);
});

test("rebuild checks its arguments", () => {
  const [c] = unwrap(gba);
  assert.throws(() => rebuild(new Uint8Array(10), c.info), RangeError);
  assert.throws(() => rebuild(c.image, c.info, "raw"), TypeError);
  const copy = c.image.slice();
  rebuild(c.image, c.info, "plain");
  assert.deepEqual(c.image, copy, "rebuild never mutates its input");
});

/* ---------- inputs from Node (Buffer) and other views ---------- */

test("Node Buffers and offset views are never aliased or mutated", () => {
  const file = nso(gb);
  const buf = Buffer.from(file);                       // Buffer.slice() would return a view
  const before = Buffer.from(buf);
  const [c] = unwrap(buf, "game.sav");
  const img = Buffer.from(c.image); img[5] ^= 1;       // edited image handed back as a Buffer
  const out = rebuild(img, c.info);
  assert.deepEqual(buf, before, "the uploaded bytes are untouched after an NSO re-sign");
  assert.equal(out.constructor, Uint8Array);
  assert.equal(String.fromCharCode(...out.subarray(c.info.nso.hashOffset, c.info.nso.hashOffset + 40)), sha1node(img));
  buf.fill(0);
  assert.deepEqual(rebuild(c.image, c.info), file, "prefix/suffix are copies, not views of the upload");
  const plain = rebuild(img, c.info, "plain");
  plain[0] ^= 0xff;
  assert.notEqual(img[0], plain[0], "plain export is a copy");

  const host = concat(rand(7), concat(gba, rand(16)), rand(9));
  const [v] = unwrap(host.subarray(7, 7 + 0x20010));
  assert.equal(v.info.kind, "trailer");
  assert.deepEqual(rebuild(v.image, v.info), host.subarray(7, 7 + 0x20010));
  assert.equal(unwrap(gba.buffer)[0].info.kind, "raw", "an ArrayBuffer is accepted");
  assert.throws(() => unwrap("not bytes"), TypeError);
});

test("a short file named *.bin is a libntr candidate even when its tail holds data", () => {
  const img = rand(0x5f12c);                           // ends in a block footer, not in zeros
  assert.throws(() => unwrap(img, "pokemon.sav"), refused("unknown-size", /389,420 bytes/));
  for (const name of ["platinum-backup.bin", "save.bin"]) {
    const [c, ...rest] = unwrap(img, name);
    assert.equal(rest.length, 0);
    assert.equal(c.info.kind, "short");
    assert.equal(c.info.padByte, 0x00);
    assert.deepEqual(rebuild(c.image, c.info), img);
  }
});

test("DeSmuME footer: growing a short image writes DeSmuME's own 512 KiB footer values", () => {
  for (const type of [0, 3, 5]) {                      // autodetect, EEPROM 512 kbit, FLASH 2 Mbit
    const [s] = unwrap(dsv(nds.subarray(0, 0x40000), { type, written: 0x3f000 }));
    assert.equal(s.info.dsv.type, type);
    assert.equal(s.info.dsv.written, 0x3f000);
    assert.deepEqual(rebuild(s.image, s.info).subarray(0x40000 + 82, 0x40000 + 106), dsv(new Uint8Array(0x40000), { type, written: 0x3f000 }).subarray(0x40000 + 82, 0x40000 + 106), "untouched pad: footer unchanged");
    const img = s.image.slice(); img[0x7ffff] = 0x00;
    const out = rebuild(img, s.info);
    assert.deepEqual([82, 86, 90, 94, 98, 102].map((o) => u32le(out, 0x80000 + o)), [0x80000, 0x80000, 6, 3, 0x80000, 0]);
  }
  const [tooLong] = unwrap(dsv(concat(nds, new Uint8Array(0x80000).fill(0xff))));
  assert.equal(tooLong.info.kind, "dsv");
  assert.equal(tooLong.info.suffix.length, 0x80000 + 0x7a, "data past 512 KiB stays with the footer");
  assert.deepEqual(tooLong.image, nds);
});

test("unwrap returns independent candidates and leaves its input alone", () => {
  const file = concat(half, rand(48));
  const copy = file.slice();
  const [a, b] = unwrap(file);
  a.image[0] ^= 0xff;
  assert.notEqual(a.image[0], b.image[0]);
  assert.deepEqual(file, copy);
});
