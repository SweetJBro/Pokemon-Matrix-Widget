/* Byte helpers shared by every codec. No dependencies; runs in the browser and in Node.

   Everything works on Uint8Array. Reads past the end throw (a RangeError from DataView), so a
   truncated save fails loudly instead of producing garbage. */

export function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export const u8 = (b, o) => b[o];
export const u16le = (b, o) => view(b).getUint16(o, true);
export const u16be = (b, o) => view(b).getUint16(o, false);
export const u32le = (b, o) => view(b).getUint32(o, true);
export const u32be = (b, o) => view(b).getUint32(o, false);
/** Big-endian 24-bit (Gen 1/2 experience). */
export const u24be = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

export function setU8(b, o, v) { b[o] = v & 0xff; }
export function setU16le(b, o, v) { view(b).setUint16(o, v & 0xffff, true); }
export function setU16be(b, o, v) { view(b).setUint16(o, v & 0xffff, false); }
export function setU32le(b, o, v) { view(b).setUint32(o, v >>> 0, true); }
export function setU32be(b, o, v) { view(b).setUint32(o, v >>> 0, false); }
export function setU24be(b, o, v) { b[o] = (v >>> 16) & 0xff; b[o + 1] = (v >>> 8) & 0xff; b[o + 2] = v & 0xff; }

/** Copy of a range (never a view into the original buffer). */
export function slice(b, o, len) { return b.slice(o, o + len); }

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor (Gen 4/5 saves). */
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1);
    t[i] = c & 0xffff;
  }
  return t;
})();
export function crc16ccitt(b, o = 0, len = b.length - o, init = 0xffff) {
  let crc = init;
  for (let i = o; i < o + len; i++) crc = ((crc << 8) ^ CRC16_TABLE[((crc >>> 8) ^ b[i]) & 0xff]) & 0xffff;
  return crc;
}

/** Sum of little-endian u16 words, truncated to 16 bits (Gen 3-5 Pokémon checksums). */
export function sum16le(b, o, len) {
  let s = 0;
  for (let i = o; i < o + len; i += 2) s = (s + b[i] + (b[i + 1] << 8)) & 0xffff;
  return s;
}

/** Bit flag helpers over a byte array (little-endian bit order within each byte). */
export function getFlag(b, o, bit) { return (b[o + (bit >> 3)] >> (bit & 7)) & 1; }
export function setFlag(b, o, bit, on = true) {
  const i = o + (bit >> 3), m = 1 << (bit & 7);
  b[i] = on ? (b[i] | m) : (b[i] & ~m);
}

export function toBase64(b) {
  if (typeof Buffer !== "undefined") return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(s) {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(b, o = 0, len = b.length - o) {
  return Array.from(b.subarray(o, o + len), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Error with a message that is safe to show to players. */
export class FormatError extends Error {
  constructor(message, detail) { super(message); this.name = "FormatError"; this.detail = detail; }
}

/** SHA-1 (FIPS 180-4) -> 20-byte Uint8Array, synchronously. The Nintendo Switch Online container
    stores the SHA-1 of its payload, and WebCrypto's digest() is async only; saves are small, so a
    plain loop is fast enough and keeps export synchronous. */
export function sha1(bytes) {
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const block = (dv, o) => {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + i * 4, false);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? ((b & c) | (~b & d)) + 0x5a827999
        : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1
        : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc
        : (b ^ c ^ d) + 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  };
  const n = bytes.length, full = n - (n % 64);
  for (let o = 0; o < full; o += 64) block(view(bytes), o);
  // Tail: the last partial block, 0x80, zero padding, and the bit length as a big-endian u64.
  const tail = new Uint8Array(n - full < 56 ? 64 : 128);
  tail.set(bytes.subarray(full));
  tail[n - full] = 0x80;
  const tv = view(tail);
  tv.setUint32(tail.length - 8, Math.floor(n / 0x20000000), false);
  tv.setUint32(tail.length - 4, (n * 8) >>> 0, false);
  for (let o = 0; o < tail.length; o += 64) block(tv, o);
  const out = new Uint8Array(20), ov = view(out);
  [h0, h1, h2, h3, h4].forEach((h, i) => ov.setUint32(i * 4, h >>> 0, false));
  return out;
}
