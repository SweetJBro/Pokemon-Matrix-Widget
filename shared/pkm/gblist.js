/* Gen 1 / Gen 2 packed Pokémon lists and the helpers pk1/pk2 and saves/gen1/gen2 share.
   docs/research/format-gen1-gen2.md §4.5 (lists), §10 (names), §3.4 (language).

   Every party and PC box in both generations is one packed list:
     u8 count, u8 species[capacity + 1] (species[count] = 0xFF), struct[capacity],
     OT name[capacity][NL], nickname[capacity][NL]     (NL = 11, Japanese 6)
   Only entries 0..count-1 mean anything; the game leaves stale bytes after them. A list never
   has holes: removing shifts the later entries down, and the game only ever appends.

   A record (docs/ARCHITECTURE.md) is one entry rearranged: the box struct, then the OT name and
   the nickname, and in Gen 2 the species-list byte first (0xFD marks an Egg only there). */
import * as text1 from "../text/gen1.js";
import * as text2 from "../text/gen2.js";
import { isDefaultName } from "./names.js";

export const TERMINATOR = 0xff;   // end of a species list
export const EGG = 0xfd;          // Gen 2 species-list marker for an Egg
export const NAME_END = 0x50;     // text terminator and padding

/** Name field length: 6 bytes in Japanese games, 11 elsewhere (Korean Gold/Silver too). */
export const nameLength = (lang) => (lang === "ja" ? 6 : 11);
/** Pokémon cross only within a group: Japanese, Korean, Western (en/fr/de/it/es). */
export const langGroup = (lang) => (lang === "ja" || lang === "ko" ? lang : "west");

/** Byte layout of a list with `capacity` entries of `structSize` bytes and names of `nameLen` bytes. */
export function listLayout(capacity, structSize, nameLen) {
  const structs = 2 + capacity, ots = structs + capacity * structSize, nicks = ots + capacity * nameLen;
  return { capacity, structSize, nameLen, structs, ots, nicks, size: nicks + capacity * nameLen };
}

/** True when the header is one the games would accept: count <= capacity and the 0xFF after the last entry. */
export function headerOk(img, off, L, validSpecies = () => true) {
  const n = img[off];
  if (n > L.capacity || img[off + 1 + n] !== TERMINATOR) return false;
  for (let i = 0; i < n; i++) if (!validSpecies(img[off + 1 + i])) return false;
  return true;
}

export function readEntry(img, off, L, i) {
  const s = off + L.structs + i * L.structSize, o = off + L.ots + i * L.nameLen, k = off + L.nicks + i * L.nameLen;
  return {
    listByte: img[off + 1 + i],
    struct: img.slice(s, s + L.structSize),
    ot: img.slice(o, o + L.nameLen),
    nick: img.slice(k, k + L.nameLen),
  };
}

/** Writes entry i; a struct shorter than the list's (a box struct into a party list) is zero-extended. */
export function writeEntry(img, off, L, i, e) {
  img[off + 1 + i] = e.listByte;
  const s = off + L.structs + i * L.structSize;
  img.fill(0, s, s + L.structSize);
  img.set(e.struct.subarray(0, L.structSize), s);
  img.set(e.ot, off + L.ots + i * L.nameLen);
  img.set(e.nick, off + L.nicks + i * L.nameLen);
}

function clearEntry(img, off, L, i) {
  const s = off + L.structs + i * L.structSize;
  img.fill(0, s, s + L.structSize);
  img.fill(0, off + L.ots + i * L.nameLen, off + L.ots + (i + 1) * L.nameLen);
  img.fill(0, off + L.nicks + i * L.nameLen, off + L.nicks + (i + 1) * L.nameLen);
}

/** The game's removal: entries after i (and the species terminator) move down one place. The
    vacated last entry is zeroed instead of left as a stale duplicate, so results are deterministic. */
export function removeAt(img, off, L, i) {
  const n = img[off];
  for (let j = i; j < n - 1; j++) writeEntry(img, off, L, j, readEntry(img, off, L, j + 1));
  img[off + 1 + n - 1] = TERMINATOR;
  img[off] = n - 1;
  clearEntry(img, off, L, n - 1);
}

/** The game's insertion: append at index count. Returns the index. */
export function append(img, off, L, e) {
  const n = img[off];
  writeEntry(img, off, L, n, e);
  img[off + 1 + n + 1] = TERMINATOR;
  img[off] = n + 1;
  return n;
}

/** A clean empty list: count 0, every species byte 0xFF, everything else zero. */
export function clearList(img, off, L) {
  img.fill(0, off, off + L.size);
  img.fill(TERMINATOR, off + 1, off + 2 + L.capacity);
}

export function copyList(img, from, to, L) { img.copyWithin(to, from, from + L.size); }

/** Entry -> record bytes: [list byte (Gen 2)] + box struct + OT name + nickname. */
export function entryToRecord(e, gen, boxStructSize) {
  const lead = gen === 2 ? 1 : 0, nl = e.ot.length;
  const r = new Uint8Array(lead + boxStructSize + 2 * nl);
  if (lead) r[0] = e.listByte;
  r.set(e.struct.subarray(0, boxStructSize), lead);
  r.set(e.ot, lead + boxStructSize);
  r.set(e.nick, lead + boxStructSize + nl);
  return r;
}

/** Record bytes -> entry (the Gen 1 list byte is the struct's species byte). */
export function recordToEntry(record, gen, boxStructSize, nl) {
  const lead = gen === 2 ? 1 : 0;
  const struct = record.slice(lead, lead + boxStructSize);
  return {
    listByte: gen === 2 ? record[0] : struct[0],
    struct,
    ot: record.slice(lead + boxStructSize, lead + boxStructSize + nl),
    nick: record.slice(lead + boxStructSize + nl, lead + boxStructSize + 2 * nl),
  };
}

/* ---------- names ---------- */

const codec = (gen) => (gen === 1 ? text1 : text2);

/** Name field -> string. Unknown codes become U+FFFD. */
export const decodeName = (gen, bytes, lang) => codec(gen).decode(bytes, lang);

/** String -> name field of `len` bytes. Returns `raw` itself when it already decodes to `str`, so a
    parse/build round trip keeps every byte (including leftovers after the terminator). */
export function encodeName(gen, str, lang, len, raw) {
  const prev = raw && raw.length === len ? Uint8Array.from(raw) : null;
  if (prev && codec(gen).decode(prev, lang) === str) return prev;
  return codec(gen).encode(str ?? "", lang, len, prev ? { original: prev } : {});
}

/** Problems with a stored name field, for validate(): no terminator, empty, unknown codes. */
export function nameProblems(gen, bytes, lang, what) {
  const out = [];
  if (!bytes.includes(NAME_END)) out.push(`${what} has no terminator`);
  const s = codec(gen).decode(bytes, lang);
  if (!s.length) out.push(`${what} is empty`);
  else if (s.includes("�")) out.push(`${what} contains characters this language cannot show`);
  return out;
}

/* ---------- language of a Western save ----------
   The layout only tells Japanese, Korean and Western apart (§3.4). For Western saves we vote:
   every un-nicknamed Pokémon whose name is the default name in a language counts for it (French
   and German names differ from English; Italian and Spanish Gen 1/2 use the English ones), and
   names that only decode in one character set (umlauts, ñ, ¿) break ties. English wins a tie. */
const WESTERN = ["en", "fr", "de", "it", "es"];

/** guessWesternLang(gen, nameFields, mons: [{ species, nick }]) -> "en" | "fr" | "de" | "it" | "es" */
export function guessWesternLang(gen, nameFields, mons) {
  const score = Object.fromEntries(WESTERN.map((l) => [l, 0]));
  for (const { species, nick } of mons) {
    for (const l of WESTERN) if (isDefaultName(codec(gen).decode(nick, l), species, gen, l)) score[l] += 2;
  }
  const fields = [...nameFields, ...mons.map((m) => m.nick)];
  for (const l of WESTERN) {
    for (const f of fields) if (codec(gen).decode(f, l).includes("�")) score[l] -= 1;
  }
  const used = new Set(fields.flatMap((f) => [...f.subarray(0, Math.max(0, f.indexOf(NAME_END)))]));
  // Character-set hints when the names alone do not decide: umlauts point to German, ñ ¿ ¡ to Spanish.
  if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5].some((c) => used.has(c))) score.de += 0.5;
  if ([0xd2, 0xe4, 0xe5].some((c) => used.has(c))) score.es += 0.25;
  let best = "en";
  for (const l of WESTERN) if (score[l] > score[best]) best = l;
  return best;
}
