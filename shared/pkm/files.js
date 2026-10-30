/* Pokémon files other tools open: .pk1 ... .pk5 as PKHeX reads them.

   Gen 3-5: the record decrypted and unshuffled (80 or 136 bytes), which PKHeX, PokeGen and most
   editors accept. Gen 1/2: a one-Pokémon list (count, species list ending 0xFF, the party struct,
   OT name, nickname), PKHeX's own .pk1/.pk2 layout; the party struct adds level and the stats the
   game would compute, because a box record has none. Gen 1 keeps the current HP the record has
   (a box Pokémon keeps the HP it was deposited with); Gen 2 has none stored and gets full HP.

     toFile(record, meta) -> { bytes, filename } */
import { calcStats } from "./stats.js";
import { decrypt3, decrypt45 } from "./crypt.js";
import * as pk1 from "./pk1.js";
import * as pk2 from "./pk2.js";
import * as D from "../data/index.js";
import { readRecord } from "./index.js";

const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const safe = (s) => String(s || "pokemon").replace(/[^\p{L}\p{N} ._-]+/gu, "").trim().slice(0, 40) || "pokemon";

export function toFile(record, meta) {
  const c = { pk1, pk2 }[meta.format];
  let bytes;
  if (meta.format === "pk3") bytes = decrypt3(record.subarray(0, 80));
  else if (meta.format === "pk4" || meta.format === "pk5") bytes = decrypt45(record.subarray(0, 136));
  else if (c) bytes = gbList(record, meta);
  else throw new TypeError("unknown format " + meta.format);
  const v = readRecord(record, meta).view;
  const name = v.isEgg ? "Egg" : v.isNicknamed ? `${v.nickname} (${v.speciesName})` : v.speciesName;
  return { bytes, filename: `${safe(name)}.${meta.format}` };
}

/** One-entry Gen 1/2 list: [1, species, 0xFF, party struct, OT, nickname]. */
function gbList(record, meta) {
  const gen = meta.format === "pk1" ? 1 : 2;
  const c = gen === 1 ? pk1 : pk2;
  const f = c.parse(record, meta);
  const boxSize = gen === 1 ? 33 : 32;
  const box = record.subarray(gen === 1 ? 0 : 1, (gen === 1 ? 0 : 1) + boxSize);
  const nl = meta.lang === "ja" ? 6 : 11;
  const names = record.subarray(record.length - 2 * nl);
  const level = c.levelFromExp(f.species, f.exp);
  const st = gen === 2 && f.isEgg ? null : calcStats(gen, f.species, 0, level, f.dvs, f.statExp);
  const party = gen === 1
    ? [...box, level, ...be16(st.hp), ...be16(st.atk), ...be16(st.def), ...be16(st.spe), ...be16(st.spa)]
    : [...box, 0, 0, ...be16(st?.hp ?? 0), ...be16(st?.hp ?? 0), ...be16(st?.atk ?? 0), ...be16(st?.def ?? 0), ...be16(st?.spe ?? 0), ...be16(st?.spa ?? 0), ...be16(st?.spd ?? 0)];
  const listSpecies = gen === 1 ? D.nationalToGen1(f.species) : (f.isEgg ? 0xfd : f.species);
  return Uint8Array.from([1, listSpecies, 0xff, ...party, ...names]);
}
