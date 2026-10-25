/* Save-file containers: everything between "the file the player dropped" and "the cartridge image
   the generation parsers read". Spec: docs/research/ports-and-emulators.md §2 and §3.2, plus the
   container sections of format-gen1-gen2.md §2, format-gen3.md §2, format-gen4.md §2/§17 and
   format-gen5.md §2.

   Nearly every emulator, dumper and PC port stores the bytes the cartridge's SRAM or flash holds.
   What varies is the wrapper: an RTC block after the image (Gen 2 MBC3 carts, Gen 3 R/S/E in
   mGBA), DeSmuME's .dsv footer, an Action Replay DS or No$GBA header, the Switch Online "SRAM"
   header, RetroArch's optional RZIP compression (rzip.js), a 0xFF tail from an emulator that
   guessed the chip size wrong, or a short zero-filled file (the Platinum PC port's save.bin).

   unwrap() returns every plausible reading of a file, best guess first, because size alone cannot
   tell a 64 KiB Japanese Crystal save from a Gen 3 save made with a 64 KiB flash setting. The
   generation detectors choose (shared/saves/index.js). Nothing here identifies a game beyond its
   family (gb / gba / nds). rebuild() turns the (edited) image back into the file the player had so
   they can overwrite it in place ("same"), or into the bare image for another program ("plain").
   Bytes we do not interpret (RTC blocks, header fields, footers) go back verbatim. The only
   rewrites are the ones a container needs to stay valid: the NSO payload SHA-1, the No$GBA sizes
   and RLE data, and the DSV size fields when a short image grows.

   Both are synchronous so openSave/exportSave can be too. Only maybeDecompress (RZIP) is async. */
import { FormatError, u32le, setU32le, sha1, hex, concat } from "../bytes.js";
import { isRzip, maybeDecompress, RZIP_ZSTD_MESSAGE } from "./rzip.js";

export { maybeDecompress };

/** Every cartridge image size we accept: GB 32 KiB, JP Crystal / GBA half 64 KiB, GBA 128 KiB, DS 512 KiB. */
export const IMAGE_SIZES = [0x8000, 0x10000, 0x20000, 0x80000];
const GB = 0x8000, GB_JP = 0x10000, GBA_HALF = 0x10000, GBA = 0x20000, NDS = 0x80000;
const DSV_FOOTER = 0x7a, ARDS_HEADER = 0xa4, MAX_NOCASH = 0x4000000;   // No$GBA/DeSmuME cap: 512 Mbit
const KiB = (n) => (n % 1024 ? (n / 1024).toFixed(1) : n / 1024) + " KiB";

/* ---------- small helpers ---------- */

const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
/* A plain Uint8Array over the same memory. Node's Buffer is a Uint8Array whose slice() returns a
   view, so without this a prefix "copy" could alias (and a fix-up write could change) the caller's file. */
function plain(x) {
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (!ArrayBuffer.isView(x)) throw new TypeError("expected bytes (Uint8Array or ArrayBuffer)");
  return x.constructor === Uint8Array ? x : new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
}
function at(b, o, s) {
  if (o < 0 || o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}
function bytesAt(b, o, list) {
  if (o < 0 || o + list.length > b.length) return false;
  return list.every((x, i) => b[o + i] === x);
}
function uniform(b, from, to, v) {
  for (let i = from; i < to; i++) if (b[i] !== v) return false;
  return true;
}
const baseName = (f) => String(f || "").split(/[\\/]/).pop();

/** Hints from the file name. Never decisive: they only add candidates, notes, a read-only flag or the
    wording of an error. */
export function nameHints(filename) {
  const base = baseName(filename);
  return {
    saveBin: /^save(?:\s*\(\d+\)|[ _-]\d+)?\.bin$/i.test(base),    // Platinum PC port (libntr), incl. "save (1).bin"
    bin: /\.bin$/i.test(base),                                       // any .bin: a renamed save.bin, most likely
    virtualConsole: /^sav.*\.dat/i.test(base),                       // 3DS VC via Checkpoint (PKHeX's rule)
    switchFrlg: /^(?:FireRed|LeafGreen)_.*\.sav/i.test(base),        // Switch FR/LG release (PKHeX's rule)
    yellowExtended: /yellow[\s_.-]*extended/i.test(base),            // mstan PokemonYellowRecomp "Extended" (read-only)
  };
}

/* ---------- refusals ---------- */

const refuse = (code, message) => { throw new FormatError(message, { code }); };

const SAVE_STATE_MESSAGE =
  "This is a save state (a snapshot of the emulator), not the game's own save. Load the game, save from the " +
  "in-game menu, close the emulator, and upload the battery save instead: usually a .sav file next to the ROM, " +
  "a .srm file in RetroArch's saves folder, or a .dsv file for DeSmuME.";
const LUA_MESSAGE =
  "This is a G1R Deluxe or gen2recomp save (save.lua), not a cartridge save. In the app, use Export save, upload " +
  "the exported .sav here, then bring the changed file back with Import save.";
const ROM_MESSAGE =
  "This is a game ROM, not a save file. Upload the save the emulator keeps next to it (usually the same name " +
  "ending in .sav, or .srm in RetroArch's saves folder).";
const YELLOW_EXTENDED_MESSAGE =
  "This looks like a save from the Pokémon Yellow Recomp \"Extended\" build, which adds Pokémon 152-251 and " +
  "changes the save layout. Only the Stock build's saves (identical to the cartridge) can be used here.";
/* The name is the only hint (ports-and-emulators §3.1: names never decide), so a file named like an
   Extended save is not refused: detection fails on the changed layout and explainUnrecognised says
   why. If a detector accepts it anyway, it stays read-only. The gbrecompiled runtime names saves
   <output_prefix>.sav and the build's exe is Pokemon_Yellow_Extended.exe, so the save is presumably
   Pokemon_Yellow_Extended.sav (inferred, no sample). */
const YELLOW_EXTENDED_READONLY = YELLOW_EXTENDED_MESSAGE + " If this is a Stock save, rename the file so the name " +
  "does not say \"Extended\" and upload it again.";

const STATE_EXT = /\.(?:ss\d|st\d|state\d*|state\.auto|sgm|ds\d|dst|ml\d|mln|s\d|sn\d|gqs|oesavestate|pfrstate)$/i;
const ROM_EXT = /\.(?:gb|gbc|sgb|gba|agb|nds|srl|dsi|3ds|cia)$/i;
const NINTENDO_LOGO_GB = [0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b];   // cartridge header @0x104
const NINTENDO_LOGO_AGB = [0x24, 0xff, 0xae, 0x51, 0x69, 0x9a, 0xa2, 0x21];  // GBA @0x04, NDS @0xC0

/** G1R/gen2recomp write `return { ... }` (SaveSerializer.lua); allow a BOM, blanks and -- comments. */
function looksLikeLua(b) {
  const end = Math.min(b.length, 4096);
  for (let i = 0; i < end; i++) if (b[i] === 0) return false;
  let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
  for (;;) {
    while (i < end && (b[i] === 0x20 || (b[i] >= 0x09 && b[i] <= 0x0d))) i++;
    if (b[i] === 0x2d && b[i + 1] === 0x2d) { while (i < end && b[i] !== 0x0a) i++; continue; }
    break;
  }
  const next = b[i + 6];
  return at(b, i, "return") && (next === undefined || next === 0x7b || next === 0x20 || (next >= 0x09 && next <= 0x0d));
}

const ARCHIVE_MESSAGE = "This is an archive (zip, 7z or rar). Extract the save file from it and upload that.";

/** Files that are recognisably not battery saves, checked before any size rule. Only magics of 6+
    bytes (or text, or the 8-byte logo at its fixed offset) count here: no save starts with them. */
function checkRefusals(b) {
  if (!b.length) refuse("empty", "The file is empty. Copy the save again (close the game or emulator first).");
  // Only reached when the caller skipped the async maybeDecompress() pre-pass.
  if (isRzip(b)) {
    refuse("rzip", "This RetroArch save is compressed (SaveRAM Compression) and was not unpacked. Reload the page and " +
      "try again. If that does not help: " + RZIP_ZSTD_MESSAGE.slice(RZIP_ZSTD_MESSAGE.indexOf("In RetroArch")));
  }
  // State magics of RetroArch (RASTATE) and DeSmuME. Written from memory of those emulators' state
  // code, UNVERIFIED here; harmless if wrong, since no save image starts with them.
  if (at(b, 0, "RASTATE") || at(b, 0, "DeSmuME SState")) refuse("save-state", SAVE_STATE_MESSAGE);
  if (bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    refuse("save-state", "This is a PNG image. mGBA stores its save states as PNG files, so this is probably a save state. " + SAVE_STATE_MESSAGE);
  }
  if (bytesAt(b, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || at(b, 0, "Rar!\x1a\x07")) refuse("archive", ARCHIVE_MESSAGE);
  if (looksLikeLua(b)) refuse("lua-save", LUA_MESSAGE);
  if (bytesAt(b, 0x104, NINTENDO_LOGO_GB) || bytesAt(b, 0x04, NINTENDO_LOGO_AGB) || bytesAt(b, 0xc0, NINTENDO_LOGO_AGB)) {
    refuse("rom", ROM_MESSAGE);
  }
}

function refuseUnknownSize(b, base) {
  // 3-4 byte magics are trusted only here, when no save shape fits the size: a real save can begin
  // with them by chance (Gen 1/2 SRAM opens with sprite buffers), a gzip or zip file almost never has
  // a save's exact size. melonDS states start with "MELN" (from memory, UNVERIFIED).
  if (at(b, 0, "MELN")) refuse("save-state", SAVE_STATE_MESSAGE);
  if (bytesAt(b, 0, [0x1f, 0x8b, 0x08])) {
    refuse("compressed", "This file is gzip-compressed. VisualBoyAdvance and VBA-M save states (.sgm) look like this, " +
      "and so do .gz archives. Upload the battery save (.sav) itself.");
  }
  if (bytesAt(b, 0, [0x50, 0x4b, 0x03, 0x04])) refuse("archive", ARCHIVE_MESSAGE);
  if (STATE_EXT.test(base) || at(b, b.length - 4, "BESS")) refuse("save-state", SAVE_STATE_MESSAGE);
  if (ROM_EXT.test(base)) refuse("rom", ROM_MESSAGE);
  refuse("unknown-size",
    `This file is ${b.length.toLocaleString("en-US")} bytes (${KiB(b.length)}), which is not the size of any Pokémon ` +
    "save we know. A battery save is 32 KiB (Game Boy, Game Boy Color), 128 KiB (Game Boy Advance) or 512 KiB (DS), " +
    "sometimes with a little clock data or an emulator header added. Make sure this is the game's save " +
    "(.sav, .srm, .dsv or sav.dat), not a save state, ROM or screenshot.");
}

/* ---------- trailers (RTC blocks after the image) ---------- */

const TRAILERS = {
  gb: {
    48: ["gb-rtc-48", "48-byte clock (RTC) block in BGB format (BGB, VBA-M, mGBA, SameBoy, Gearboy, FlashGBX)"],
    44: ["gb-rtc-44", "44-byte clock (RTC) block from older VisualBoyAdvance"],
    13: ["gb-rtc-sameboy", "13-byte clock (RTC) block from older SameBoy"],
    9: ["gb-rtc-sameboy", "9-byte clock (RTC) block from older SameBoy"],
  },
  gba: {
    16: ["gba-rtc-16", "16-byte clock (RTC) record (mGBA, FlashGBX)"],
    7: ["gba-rtc-7", "7-byte clock (RTC) block from older FlashGBX"],
  },
};
function trailerInfo(family, n) {
  const t = TRAILERS[family][n];
  return t ? { size: n, type: t[0], label: t[1] } : { size: n, type: "unknown", label: `${n} bytes of unknown data` };
}

/* ---------- No$GBA RLE (method 1) ----------
   Control byte c: 0 = end; 1..0x7F = copy the next c bytes; 0x80 = value byte, then u16 LE count,
   fill; 0x81..0xFF = value byte repeated c - 0x80 times. The end marker counts in the packed size
   (DeSmuME's importer reads exactly that many bytes and expects the 0 inside them). We also accept
   a stream that reaches the unpacked size without the marker. */

/** nocashDecode(packed, unpackedSize) -> Uint8Array(unpackedSize); FormatError when it does not fit. */
export function nocashDecode(packed, unpackedSize) {
  if (!Number.isInteger(unpackedSize) || unpackedSize < 0 || unpackedSize > MAX_NOCASH) throw new RangeError("nocashDecode: bad size");
  packed = plain(packed);
  const out = new Uint8Array(unpackedSize), n = packed.length;
  let o = 0, p = 0;
  const bad = () => new FormatError("This No$GBA save is damaged (its compressed data does not unpack). " +
    "Set No$GBA to write raw saves, save in-game once and upload the new file.", { code: "nocash-damaged" });
  while (p < n) {
    const c = packed[p++];
    if (c === 0) break;
    let count;
    if (c < 0x80) {
      count = c;
      if (p + count > n || o + count > unpackedSize) throw bad();
      out.set(packed.subarray(p, p + count), o); p += count;
    } else if (c === 0x80) {
      if (p + 3 > n) throw bad();
      count = packed[p + 1] | (packed[p + 2] << 8);
      if (!count || o + count > unpackedSize) throw bad();
      out.fill(packed[p], o, o + count); p += 3;
    } else {
      count = c - 0x80;
      if (p >= n || o + count > unpackedSize) throw bad();
      out.fill(packed[p++], o, o + count);
    }
    o += count;
  }
  if (o !== unpackedSize) throw bad();
  return out;
}

/** Runs of 3+ become fills (0x81..0xFF, or 0x80 + u16 for longer runs), the rest literal blocks
    of up to 0x7F bytes, then 0x00. Output is at most n + ceil(n / 127) + 2 bytes. */
export function nocashEncode(image) {
  image = plain(image);
  const n = image.length, out = new Uint8Array(n + Math.ceil(n / 0x7f) + 2);
  let o = 0, i = 0, lit = 0;
  const flush = (end) => {
    while (lit < end) {
      const k = Math.min(0x7f, end - lit);
      out[o++] = k; out.set(image.subarray(lit, lit + k), o); o += k; lit += k;
    }
  };
  while (i < n) {
    let j = i + 1;
    while (j < n && image[j] === image[i] && j - i < 0xffff) j++;
    const run = j - i;
    if (run >= 3) {
      flush(i);
      if (run <= 0x7f) { out[o++] = 0x80 + run; out[o++] = image[i]; }
      else { out[o++] = 0x80; out[o++] = image[i]; out[o++] = run & 0xff; out[o++] = run >> 8; }
      lit = j;
    }
    i = j;
  }
  flush(n);
  out[o++] = 0;
  return out.slice(0, o);
}

/* ---------- unwrap ---------- */

/**
 * unwrap(bytes, filename = "", { layers = [] } = {}) -> [{ image, info }], best guess first.
 * Throws FormatError (with detail.code) for files that are recognisably not battery saves and for
 * sizes no rule explains. `layers` is what maybeDecompress returned, so rebuild knows the file was
 * compressed. Candidate images may share memory with each other: copy the one you keep before
 * mutating it (the generation open() functions work on a copy anyway).
 *
 * ContainerInfo:
 *   kind          "raw" | "trailer" | "padded" | "short" | "window" | "dsv" | "ards" | "nso" | "nocash"
 *   family        "gb" | "gba" | "nds": which detectors to try
 *   label         short description of the container for the export UI
 *   layers        outer layers, outermost first ([{ kind: "rzip", version, chunkSize, totalSize }])
 *   prefix        bytes before the image (header), kept verbatim apart from documented fix-ups
 *   suffix        bytes after the image (RTC block, DSV footer, 0xFF tail), kept verbatim
 *   imageLength   bytes of real image in the file; < canonicalSize when the file was short
 *   canonicalSize image.length: 0x8000 | 0x10000 | 0x20000 | 0x80000
 *   short         imageLength < canonicalSize; the rest of image is padByte
 *   padByte       fill used for a short image (0x00 libntr save.bin, 0xFF otherwise), else null
 *   fileLength    length of the file as given to unwrap (after decompression)
 *   filename      base name of the uploaded file
 *   nameHints     { saveBin, bin, virtualConsole, switchFrlg, yellowExtended }
 *   readOnly      null, or a user-facing reason why the save must not be written
 *   notes         user-facing strings for the UI
 *   trailer       { size, type, label } for kind "trailer"
 *   nso           { hashOffset, hasRtc, build, hashOk }
 *   nocash        { method, packed (method 1: the original packed bytes) }
 *   dsv           { written, padSize, type, addrSize, memSize } (the footer's u32s)
 */
export function unwrap(bytes, filename = "", { layers = [] } = {}) {
  const b = plain(bytes);
  const base = baseName(filename), hints = nameHints(base);
  checkRefusals(b);
  const ctx = { b, base, hints, layers };
  const special = unwrapNso(ctx) || unwrapNocash(ctx) || unwrapDsv(ctx);
  if (special) return [special];

  const L = b.length, out = [];
  const add = (c) => { if (c) out.push(c); };
  if (hints.saveBin && L >= 0x400 && L < NDS) add(shortNds(ctx, 0x00));
  if (L === NDS + ARDS_HEADER) {
    add(make(ctx, { kind: "ards", family: "nds", start: ARDS_HEADER, length: NDS, label: "Action Replay DS save (header kept)",
      notes: ["Action Replay DS header (164 bytes) kept unchanged."] }));
  }
  if (IMAGE_SIZES.includes(L)) {
    if (L === GB) add(make(ctx, { kind: "raw", family: "gb", start: 0, length: GB, label: "32 KiB battery save" }));
    if (L === 0x10000) { add(gbaHalf(ctx, null)); add(gbJp(ctx, null)); }
    if (L === GBA) add(make(ctx, { kind: "raw", family: "gba", start: 0, length: GBA, label: "128 KiB battery save" }));
    if (L === NDS) add(make(ctx, { kind: "raw", family: "nds", start: 0, length: NDS, label: "512 KiB DS save" }));
  }
  for (const B of [GB, 0x10000, GBA]) {
    if (L <= B || L >= B + 0x100) continue;
    const n = L - B;
    if (B === GB) add(make(ctx, trailerFields("gb", GB, n, "32 KiB")));
    else if (B === GBA) add(make(ctx, trailerFields("gba", GBA, n, "128 KiB")));
    else {
      // 64 KiB + n: JP Crystal with a GB RTC block, or a 64 KiB-flash Gen 3 save with a GBA one.
      const gbFirst = !!TRAILERS.gb[n] || !TRAILERS.gba[n];
      const pair = [gbaHalf(ctx, n), gbJp(ctx, n)];
      if (gbFirst) pair.reverse();
      pair.forEach(add);
    }
  }
  if (L > NDS && L <= 2 * NDS) {
    for (const v of [0xff, 0x00]) {
      if (!uniform(b, NDS, L, v)) continue;
      add(make(ctx, { kind: "padded", family: "nds", start: 0, length: NDS, label: "DS save with extra padding (kept)",
        notes: [`The file is ${L - NDS} bytes longer than a DS save; the extra bytes (all 0x${v.toString(16).padStart(2, "0").toUpperCase()}) are kept.`] }));
      break;
    }
  }
  if (!out.length && L >= 0x400 && L < NDS) {
    // A short DS image: libntr's save.bin ends wherever the game last wrote (often a block
    // footer), so any .bin name counts; otherwise the erased-looking tail decides the pad byte.
    const tail = b.subarray(Math.max(0, L - 0x1000));
    if (hints.bin || uniform(tail, 0, tail.length, 0x00)) add(shortNds(ctx, 0x00));
    else if (uniform(tail, 0, tail.length, 0xff)) add(shortNds(ctx, 0xff));
  }
  if (L > NDS && L <= NDS + 0x400) {
    // Unknown NDS container: try every split of the extra bytes into header + footer.
    const shared = b.slice();
    for (let p = 0; p <= L - NDS; p++) {
      if ((p === 0 && out.some((c) => c.info.kind === "padded")) || (p === ARDS_HEADER && L === NDS + ARDS_HEADER)) continue;
      add(make(ctx, { kind: "window", family: "nds", start: p, length: NDS, shared, label: "DS save inside an unknown container (extra bytes kept)",
        notes: [`Unknown container: ${p} bytes before and ${L - NDS - p} bytes after the DS save are kept unchanged.`] }));
    }
  }
  if (!out.length) refuseUnknownSize(b, base);
  return out;
}

/** Build one candidate. `length` real image bytes start at `start`; the image is padded with
    `padByte` up to `canonicalSize` (default: `length`). */
function make(ctx, f) {
  const { b, base, hints, layers } = ctx;
  const canonicalSize = f.canonicalSize || f.length, isShort = f.length < canonicalSize;
  let image;
  if (f.image) image = f.image;
  else if (!isShort && f.shared) image = f.shared.subarray(f.start, f.start + f.length);
  else {
    image = new Uint8Array(canonicalSize);
    if (isShort) image.fill(f.padByte);
    image.set(b.subarray(f.start, f.start + f.length));
  }
  const notes = [...(f.notes || [])];
  let readOnly = f.readOnly || null;
  if (hints.yellowExtended && f.family === "gb") { readOnly ||= YELLOW_EXTENDED_READONLY; notes.push(YELLOW_EXTENDED_READONLY); }
  if (hints.virtualConsole && f.family === "gb") notes.push("3DS Virtual Console save (sav.dat): restore it with Checkpoint.");
  if (hints.switchFrlg && f.family === "gba") notes.push("The file name looks like the Nintendo Switch FireRed/LeafGreen release.");
  let label = f.label;
  for (const l of layers) {
    if (l.kind !== "rzip") continue;
    notes.push("RetroArch compressed this save. The download is uncompressed, which RetroArch reads as well, " +
      "even with SaveRAM Compression turned on.");
    label += ", uncompressed (was RetroArch-compressed)";
  }
  const info = {
    kind: f.kind, family: f.family, label, layers: layers.map((l) => ({ ...l })),
    prefix: f.prefix || b.slice(0, f.start), suffix: f.suffix || b.slice(f.start + f.length),
    imageLength: f.length, canonicalSize, short: isShort, padByte: isShort ? f.padByte : null,
    fileLength: b.length, filename: base, nameHints: { ...hints }, readOnly, notes,
  };
  for (const k of ["trailer", "nso", "nocash", "dsv"]) if (f[k]) info[k] = f[k];
  return { image, info };
}

function trailerFields(family, B, n, size) {
  const trailer = trailerInfo(family, n);
  const notes = [trailer.type === "unknown"
    ? `${n} bytes of unknown data follow the save; they are kept unchanged.`
    : `The ${trailer.label} after the save is kept unchanged.`];
  return { kind: "trailer", family, start: 0, length: B, trailer, notes, label: `${size} battery save + ${n}-byte trailer (kept)` };
}

/* 64 KiB as Game Boy: Japanese Crystal's SRAM (the cart has 64 KiB for the Mobile Adapter). */
function gbJp(ctx, n) {
  if (n == null) return make(ctx, { kind: "raw", family: "gb", start: 0, length: GB_JP, label: "64 KiB Game Boy save (Japanese Crystal)" });
  const f = trailerFields("gb", GB_JP, n, "64 KiB");
  return make(ctx, { ...f, label: f.label + " (Japanese Crystal)" });
}

/* 64 KiB as GBA: an emulator set to 64 KiB flash kept only half of the 128 KiB chip. Padded to
   128 KiB with 0xFF (erased flash), so slot B reads as empty; read-only (format-gen3.md §2.1). */
const GBA_HALF_MESSAGE = "This Game Boy Advance save is only 64 KiB: the emulator was set to 64 KiB flash, but Pokémon " +
  "uses 128 KiB. Set the save type to Flash 128K (1M) in the emulator, load the game and save in-game, then upload again.";
function gbaHalf(ctx, n) {
  const f = n == null
    ? { kind: "raw", family: "gba", start: 0, length: GBA_HALF, label: "64 KiB Game Boy Advance save (half of the flash)", notes: [] }
    : trailerFields("gba", GBA_HALF, n, "64 KiB");
  return make(ctx, { ...f, canonicalSize: GBA, padByte: 0xff, readOnly: GBA_HALF_MESSAGE, notes: [...f.notes, GBA_HALF_MESSAGE] });
}

function shortNds(ctx, padByte) {
  const L = ctx.b.length, libntr = padByte === 0x00;
  return make(ctx, {
    kind: "short", family: "nds", start: 0, length: L, canonicalSize: NDS, padByte,
    label: libntr ? "Platinum PC port save.bin (zero-filled, length kept)" : `short DS save (${KiB(L)}, length kept)`,
    notes: [`The file holds only the first ${L.toLocaleString("en-US")} bytes of a DS save` +
      (libntr ? " (the Platinum PC port writes save.bin this way)" : "") +
      ". The download keeps that length unless the changes reach past it."],
  });
}

/* Switch Online GB/GBC: "SRAM", u32, ROM SHA-1 as 40 hex chars @0x08, u32 build-string length
   @0x30, the build string, u8 hasRTC (+0x20 RTC bytes), the payload's SHA-1 as 40 lowercase hex
   chars, then the SRAM. PKHeX only accepts files 0x68..0xA0 bytes longer than the SRAM (a guess at
   the usual build-string lengths); we follow the structure instead, which is the stronger test: the
   payload hash must be 40 hex digits and exactly 32 or 64 KiB must follow it. */
function unwrapNso(ctx) {
  const { b } = ctx;
  if (b.length < 0x5d + GB || !at(b, 0, "SRAM")) return null;
  const buildLength = u32le(b, 0x30);
  if (buildLength >= 0x100) return null;
  let p = 0x34 + buildLength;
  const hasRtc = b[p] !== 0;
  p += 1 + (hasRtc ? 0x20 : 0);
  const hashOffset = p;
  p += 40;
  const length = b.length - p;
  if (length !== GB && length !== GB_JP) return null;
  const stored = String.fromCharCode(...b.subarray(hashOffset, hashOffset + 40));
  if (!/^[0-9a-fA-F]{40}$/.test(stored)) return null;
  const hashOk = stored.toLowerCase() === hex(sha1(b.subarray(p)));
  const build = String.fromCharCode(...b.subarray(0x34, 0x34 + buildLength));
  const notes = ["Nintendo Switch Online save: the header is kept and its checksum is updated on download."];
  if (!hashOk) notes.push("The checksum in the Switch Online header did not match this save; the download carries a corrected one.");
  return make(ctx, { kind: "nso", family: "gb", start: p, length, label: "Nintendo Switch Online save (header re-signed)",
    nso: { hashOffset, hasRtc, build, hashOk }, notes });
}

/* No$GBA (GBA and DS): "NocashGbaBackupMediaSavDataFile", 0x1A, fields we keep verbatim, "SRAM" at
   0x40, u32 method at 0x44. Method 0: u32 size, data at 0x4C. Method 1: u32 packed size, u32
   unpacked size, RLE data at 0x50 (ports-and-emulators.md §2.5; DeSmuME's importer). */
function unwrapNocash(ctx) {
  const { b } = ctx;
  if (b.length < 0x4c || !at(b, 0, "NocashGbaBackupMediaSavDataFile") || b[0x1f] !== 0x1a || !at(b, 0x40, "SRAM")) return null;
  const method = u32le(b, 0x44);
  const damaged = () => refuse("nocash-damaged", "This No$GBA save is damaged or cut short. Set No$GBA to write raw saves, " +
    "save in-game once and upload the new file.");
  if (method !== 0 && method !== 1) {
    refuse("nocash-method", `This No$GBA save uses a storage method (${method}) the widget does not know. ` +
      "Set No$GBA to write raw saves, save in-game once and upload the new file.");
  }
  if (method === 1 && b.length < 0x50) damaged();
  const off = method === 0 ? 0x4c : 0x50, packedLength = u32le(b, 0x48);
  const length = method === 0 ? packedLength : u32le(b, 0x4c);
  if (![GBA_HALF, GBA, NDS].includes(length)) {   // checked before anything is allocated
    refuse("nocash-size", `This No$GBA save holds ${length.toLocaleString("en-US")} bytes, which is not a Pokémon ` +
      "Game Boy Advance (128 KiB) or DS (512 KiB) save. Check that the right game's save was uploaded.");
  }
  if (off + packedLength > b.length) damaged();
  let image, packed = null;
  if (method === 1) {
    packed = b.slice(off, off + packedLength);
    image = nocashDecode(packed, length);
  }
  const family = length === NDS ? "nds" : "gba";
  const notes = [method === 0 ? "No$GBA save: the No$GBA header is kept."
    : "No$GBA compressed save: the download is compressed again the same way. If No$GBA does not accept it, " +
      "download the plain .sav and set No$GBA to raw saves (re-compression is not yet verified against No$GBA)."];
  const f = { kind: "nocash", family, start: off, length, prefix: b.slice(0, off), suffix: b.slice(off + packedLength),
    label: method === 0 ? "No$GBA save (header kept)" : "No$GBA compressed save (re-compressed)", nocash: { method, packed }, notes };
  if (image) f.image = image;
  if (length === GBA_HALF) {   // the 64 KiB-flash case, padded like gbaHalf()
    const padded = new Uint8Array(GBA).fill(0xff);
    padded.set(image || b.subarray(off, off + length));
    return make(ctx, { ...f, image: padded, canonicalSize: GBA, padByte: 0xff, readOnly: GBA_HALF_MESSAGE, notes: [...notes, GBA_HALF_MESSAGE] });
  }
  return make(ctx, f);
}

/* DeSmuME .dsv: image + 122-byte footer: 82 bytes of text, six u32 LE (bytes written, padded size,
   save type, address size, memory size, version = 0), "|-DESMUME SAVE-|" (format-gen5.md §2).
   DeSmuME grows the data part as the game writes, so it can be short of 512 KiB (padded with 0xFF). */
function unwrapDsv(ctx) {
  const { b } = ctx, L = b.length;
  if (L < DSV_FOOTER || !at(b, L - 16, "|-DESMUME SAVE-|") || u32le(b, L - 20) !== 0) return null;
  const dataLength = L - DSV_FOOTER;
  if (!dataLength) refuse("empty", "This DeSmuME save is empty: the game has not saved yet. Save in-game first, then upload the .dsv.");
  const f = L - DSV_FOOTER;
  const dsv = { written: u32le(b, f + 82), padSize: u32le(b, f + 86), type: u32le(b, f + 90), addrSize: u32le(b, f + 94), memSize: u32le(b, f + 98) };
  const notes = ["DeSmuME .dsv: the 122-byte DeSmuME footer is kept."];
  const length = Math.min(dataLength, NDS);
  if (dataLength > NDS) notes.push(`The .dsv holds ${dataLength - NDS} bytes more than a DS save; they are kept.`);
  if (dataLength < NDS) notes.push(`The .dsv holds only the first ${dataLength.toLocaleString("en-US")} bytes of the DS save; the download keeps that length unless the changes reach past it.`);
  return make(ctx, { kind: "dsv", family: "nds", start: 0, length, canonicalSize: NDS, padByte: 0xff, dsv, notes,
    label: "DeSmuME .dsv (footer kept)" });
}

/* ---------- rebuild ---------- */

/**
 * rebuild(image, info, mode = "same") -> Uint8Array, the file to download.
 * "same":  the uploaded container, byte for byte, around the new image. A short image is trimmed
 *          back to its original length when the padding is untouched, else written in full.
 *          Fix-ups: NSO payload SHA-1; No$GBA sizes (method 1 re-encodes only when the image
 *          changed); DSV size fields when a short image grows. An RZIP layer is dropped (plain .srm).
 * "plain": the bare canonical-size image (an untouched short pad becomes 0xFF, erased flash), for
 *          moving a save to another emulator or port.
 */
export function rebuild(image, info, mode = "same") {
  if (!(image instanceof Uint8Array) || image.length !== info.canonicalSize) {
    throw new RangeError(`rebuild: image must be ${info.canonicalSize} bytes, got ${image && image.length}`);
  }
  image = plain(image);
  const padUntouched = info.short && uniform(image, info.imageLength, image.length, info.padByte);
  if (mode === "plain") {
    const out = image.slice();
    if (padUntouched && info.padByte !== 0xff) out.fill(0xff, info.imageLength);
    return out;
  }
  if (mode !== "same") throw new TypeError(`rebuild: mode must be "same" or "plain", got ${mode}`);
  const body = padUntouched ? image.subarray(0, info.imageLength) : image;
  const grew = info.short && !padUntouched;
  switch (info.kind) {
    case "nso": {
      const prefix = info.prefix.slice();
      prefix.set(ascii(hex(sha1(body))), info.nso.hashOffset);
      return concat(prefix, body, info.suffix);
    }
    case "nocash": {
      const prefix = info.prefix.slice();
      if (info.nocash.method === 0) {
        setU32le(prefix, 0x48, body.length);
        return concat(prefix, body, info.suffix);
      }
      let packed = info.nocash.packed;
      if (!packedEquals(packed, body)) packed = nocashEncode(body);
      setU32le(prefix, 0x48, packed.length);
      setU32le(prefix, 0x4c, body.length);
      return concat(prefix, packed, info.suffix);
    }
    case "dsv": {
      const suffix = info.suffix.slice();
      if (grew) {
        // What DeSmuME itself writes when the data grows to 512 KiB (mc.cpp ensure()): written,
        // padded and memory size all equal the new length, and the type becomes the save_types
        // index of that size, 6 = "FLASH 4Mbit". The address size (3 for every flash) stays.
        const f = suffix.length - DSV_FOOTER;
        for (const o of [82, 86, 98]) setU32le(suffix, f + o, body.length);
        setU32le(suffix, f + 90, 6);
      }
      return concat(info.prefix, body, suffix);
    }
    default:
      return concat(info.prefix, body, info.suffix);
  }
}

function packedEquals(packed, body) {
  try {
    const old = nocashDecode(packed, body.length);
    for (let i = 0; i < body.length; i++) if (old[i] !== body[i]) return false;
    return true;
  } catch { return false; }
}

/* ---------- after detection fails ---------- */

/** A user-facing explanation for openSave when no generation detector accepted any candidate. */
export function explainUnrecognised(candidates) {
  const blank = candidates.length > 0 && candidates.every(({ image, info }) =>
    uniform(image, 0, info.imageLength, 0xff) || uniform(image, 0, info.imageLength, 0x00));
  if (blank) {
    return "This save is blank: the game has never saved into it. Start the game, save from the in-game menu, " +
      "close the game or emulator, then upload the file again.";
  }
  if (candidates.some((c) => c.info.nameHints.yellowExtended && c.info.family === "gb")) return YELLOW_EXTENDED_MESSAGE;
  const families = [...new Set(candidates.map((c) => c.info.family))];
  if (!families.length) return "This file is not a Pokémon save the widget recognises.";
  const names = { gb: "Game Boy", gba: "Game Boy Advance", nds: "DS" };
  return `This looks like a ${families.map((f) => names[f]).join(" or ")} save, but not one from a Pokémon game the ` +
    "widget supports. It may be from a ROM hack or a port with its own save layout (for example " +
    "pokeemerald-expansion builds, Heart & Soul, Polished Crystal or Yellow Recomp \"Extended\"), from a Japanese or " +
    "Korean release that is not supported, or damaged. Try the original file again with the game closed.";
}
