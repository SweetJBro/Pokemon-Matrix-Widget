/* RetroArch RZIP: the optional "SaveRAM Compression" wrapper around .srm files
   (docs/research/ports-and-emulators.md §2.6 and §3.2 step 0).

   Layout: "#RZIPv", a version byte (1 = deflate, 2 = zstd), "#", u32 LE uncompressed chunk size,
   u64 LE total uncompressed size; then chunks, each a u32 LE compressed length followed by one
   zlib stream (v1, window bits 15, which is what DecompressionStream("deflate") reads) or one
   Zstandard frame (v2, RFC 8878; RetroArch's own encoder or libzstd).

   Decompression is async in browsers, so this is a pre-pass the UI awaits before the synchronous
   unwrap(). We never write RZIP back: RetroArch reads every SRAM file through its RZIP reader,
   which passes uncompressed data through, so the download is always the plain .srm.

   Current RetroArch writes v2 whenever it was built with zstd. v2 is decoded with fzstd (MIT,
   vendored unmodified in web/vendor/fzstd), loaded on first use only. The browser serves shared/
   at /shared/ and web/ at /, and Node sees the repository layout, so both relative locations are
   tried. Callers can pass their own decoder ({ zstd: frame => bytes }) or turn v2 off
   ({ zstd: false }); if no decoder loads, v2 is refused with instructions. */
import { FormatError, u32le } from "../bytes.js";

const MAGIC = [0x23, 0x52, 0x5a, 0x49, 0x50, 0x76];   // "#RZIPv"
const HEADER = 20;
const MAX_TOTAL = 16 << 20;                           // far above any battery save

export const RZIP_ZSTD_MESSAGE =
  "This RetroArch save is compressed with zstd, which the widget could not decompress here. In RetroArch, turn " +
  "off Settings → Saving → SaveRAM Compression, load the game, save in-game once, then upload the .srm again.";

const FZSTD = ["../../vendor/fzstd/index.mjs", "../../web/vendor/fzstd/index.mjs"];
let fzstd = null;
/** The vendored decoder's decompress(), or null when it cannot be loaded here. A success is cached;
    a failure is not, so a dropped connection in the widget does not disable v2 until a reload. */
function loadZstd() {
  fzstd ||= (async () => {
    for (const rel of FZSTD) {
      try {
        const m = await import(new URL(rel, import.meta.url).href);
        if (typeof m.decompress === "function") return m.decompress;
      } catch { /* try the next layout */ }
    }
    fzstd = null;
    return null;
  })();
  return fzstd;
}

/** True when bytes start with an RZIP header of a known version (RetroArch's own test). */
export function isRzip(b) {
  if (b.length < HEADER || b[7] !== 0x23 || (b[6] !== 1 && b[6] !== 2)) return false;
  return MAGIC.every((c, i) => b[i] === c);
}

const damaged = (why) => new FormatError(
  "This compressed RetroArch save is damaged or incomplete (" + why + "). Copy the .srm again, or turn off " +
  "SaveRAM Compression in RetroArch, save in-game once and upload the new file.", { code: "rzip-damaged" });

async function inflate(chunk) {
  if (typeof DecompressionStream === "undefined") {
    throw new FormatError("This browser cannot decompress RetroArch saves. Turn off SaveRAM Compression in RetroArch " +
      "(Settings → Saving), save in-game once, and upload the new .srm.", { code: "rzip-unsupported" });
  }
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  writer.write(chunk).catch(() => {});                 // errors surface on the reader
  writer.close().catch(() => {});
  const reader = ds.readable.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** maybeDecompress(bytes, { zstd } = {}) -> { bytes, layers }.
    Uncompressed input comes back as is with layers = []. RZIP input comes back inflated with
    layers = [{ kind: "rzip", version, chunkSize, totalSize }], which unwrap() takes as
    { layers } so the export can say it is now uncompressed. */
export async function maybeDecompress(bytes, { zstd } = {}) {
  const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes)
    : bytes.constructor === Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!isRzip(b)) return { bytes: b, layers: [] };
  const version = b[6], chunkSize = u32le(b, 8);
  const total = u32le(b, 12) + u32le(b, 16) * 0x100000000;
  if (!chunkSize || !total) throw damaged("empty header");
  if (total > MAX_TOTAL) {
    throw new FormatError("This RetroArch file unpacks to " + total + " bytes, far more than any battery save. " +
      "Is it a save state? Upload the .srm from RetroArch's saves folder instead.", { code: "save-state" });
  }
  if (version === 2) {
    if (zstd === undefined) zstd = await loadZstd();
    if (typeof zstd !== "function") throw new FormatError(RZIP_ZSTD_MESSAGE, { code: "rzip-zstd" });
  }

  const out = new Uint8Array(total);
  let o = 0, p = HEADER;
  while (o < total) {
    if (p + 4 > b.length) throw damaged("it ends early");
    const n = u32le(b, p); p += 4;
    if (!n || p + n > b.length) throw damaged("bad chunk length");
    let data;
    try { data = version === 1 ? await inflate(b.subarray(p, p + n)) : zstd(b.subarray(p, p + n)); }
    catch (e) { if (e instanceof FormatError) throw e; throw damaged("a chunk does not decompress"); }
    p += n;
    if (!data.length || o + data.length > total) throw damaged("sizes do not add up");
    out.set(data, o); o += data.length;
  }
  return { bytes: out, layers: [{ kind: "rzip", version, chunkSize, totalSize: total }] };
}
