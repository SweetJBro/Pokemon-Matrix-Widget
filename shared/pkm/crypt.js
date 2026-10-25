/* Encryption and substructure shuffling of Gen 3-5 Pokémon records.

   Gen 3 (format-gen3.md §8.4): the 48 bytes at 0x20 are four 12-byte substructures
   (Growth, Attacks, EVs/condition, Misc) stored in the order PID % 24 picks, each u32 XORed
   with PID ^ OTID. The u16 at 0x1C is the sum of the decrypted 48 bytes as u16 words.

   Gen 4/5 (format-gen4.md §12.2): the 128 bytes at 0x08 are four 32-byte blocks (A, B, C, D)
   stored in the order ((PID >> 13) & 31) % 24 picks; every u16 is XORed with the high half of
   an LCRNG (x * 0x41C64E6D + 0x6073) seeded with the checksum at 0x06. The party extension
   (0x88..) uses the same LCRNG seeded with the PID.

   The decrypt and encrypt functions return new arrays. "Plain" means decrypted AND unshuffled
   (canonical order G A E M / A B C D), which is what PKHeX calls decrypted. */
import { u16le, u32le, setU16le, setU32le, sum16le } from "../bytes.js";

/* Position of each canonical substructure, for each of the 24 orders. Row k lists the canonical
   index (0 = G/A, 1 = A/B, 2 = E/C, 3 = M/D) stored at positions 0..3. Gen 3 and Gen 4/5 use the
   same permutation table. */
const ORDERS = [
  "0123", "0132", "0213", "0231", "0312", "0321",
  "1023", "1032", "1203", "1230", "1302", "1320",
  "2013", "2031", "2103", "2130", "2301", "2310",
  "3012", "3021", "3102", "3120", "3201", "3210",
].map((s) => [...s].map(Number));

export const shuffleOrder3 = (pid) => (pid >>> 0) % 24;
export const shuffleOrder45 = (pid) => ((pid >>> 13) & 31) % 24;

/** Rearranges four blocks of `size` bytes starting at `off`. toCanonical: stored -> canonical. */
function shuffle(src, off, size, order, toCanonical) {
  const out = src.slice();
  const row = ORDERS[order];
  for (let pos = 0; pos < 4; pos++) {
    const canon = row[pos];
    const from = off + (toCanonical ? pos : canon) * size;
    const to = off + (toCanonical ? canon : pos) * size;
    out.set(src.subarray(from, from + size), to);
  }
  return out;
}

/* ---------- Gen 3 ---------- */

function xor3(b) {
  const key = (u32le(b, 0) ^ u32le(b, 4)) >>> 0;
  for (let o = 0x20; o < 0x50; o += 4) setU32le(b, o, (u32le(b, o) ^ key) >>> 0);
}

/** Stored (encrypted, shuffled) 80/100-byte record -> plain copy. Party bytes past 0x50 are not encrypted. */
export function decrypt3(stored) {
  const b = stored.slice();
  xor3(b);
  return shuffle(b, 0x20, 12, shuffleOrder3(u32le(b, 0)), true);
}

/** Plain record -> stored form. Recomputes the checksum at 0x1C first. */
export function encrypt3(plain) {
  const b = plain.slice();
  setU16le(b, 0x1c, sum16le(b, 0x20, 48));
  const s = shuffle(b, 0x20, 12, shuffleOrder3(u32le(b, 0)), false);
  xor3(s);
  return s;
}

export const checksum3 = (plain) => sum16le(plain, 0x20, 48);

/* ---------- Gen 4 / Gen 5 ---------- */

function lcrngXor(b, start, end, seed) {
  let s = seed >>> 0;
  for (let o = start; o < end; o += 2) {
    s = (Math.imul(s, 0x41c64e6d) + 0x6073) >>> 0;
    setU16le(b, o, u16le(b, o) ^ (s >>> 16));
  }
}

/** Stored 136/220/236-byte record -> plain copy (party extension decrypted too). */
export function decrypt45(stored) {
  const b = stored.slice();
  lcrngXor(b, 0x08, 0x88, u16le(b, 0x06));
  if (b.length > 0x88) lcrngXor(b, 0x88, b.length, u32le(b, 0));
  return shuffle(b, 0x08, 32, shuffleOrder45(u32le(b, 0)), true);
}

/** Plain record -> stored form. Recomputes the checksum at 0x06 first. */
export function encrypt45(plain) {
  const b = plain.slice();
  setU16le(b, 0x06, sum16le(b, 0x08, 128));
  const s = shuffle(b, 0x08, 32, shuffleOrder45(u32le(b, 0)), false);
  lcrngXor(s, 0x08, 0x88, u16le(s, 0x06));
  if (s.length > 0x88) lcrngXor(s, 0x88, s.length, u32le(s, 0));
  return s;
}

export const checksum45 = (plain) => sum16le(plain, 0x08, 128);
