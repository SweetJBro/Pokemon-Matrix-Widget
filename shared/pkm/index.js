/* One door to the five record codecs, for code that holds a record and its meta but should not
   care which generation it is: the server checking deposits, Home listings, the UI's cards.

   checkRecord() is the strict gate: exact size for the format and language (codecs also accept
   party-sized input for convenience; Home only stores box records), a passing validate(), and
   no empty slot. identity() names the individual Pokémon independently of its bytes, so the
   server can recognise the same Pokémon coming back after it was withdrawn or traded away. */
import { FormatError, hex } from "../bytes.js";
import * as pk1 from "./pk1.js";
import * as pk2 from "./pk2.js";
import * as pk3 from "./pk3.js";
import * as pk4 from "./pk4.js";
import * as pk5 from "./pk5.js";
import { evolvesFrom, gameCodes } from "../data/index.js";

export const CODECS = Object.freeze({ pk1, pk2, pk3, pk4, pk5 });
export const FORMATS = Object.freeze(Object.keys(CODECS));
const LANGS = new Set(["ja", "en", "fr", "de", "it", "es", "ko"]);

export function codecFor(format) {
  const c = CODECS[format];
  if (!c) throw new FormatError(`Unknown record format "${format}".`, { code: "format" });
  return c;
}

/** record + meta -> { fields, view }. Throws FormatError when the bytes cannot be parsed at all. */
export function readRecord(record, meta) {
  const c = codecFor(meta.format);
  const fields = c.parse(record, meta);
  return { fields, view: c.toView(fields, meta) };
}

/** Strict check for records that will be stored: -> { ok, errors, warnings, view }. Never throws. */
export function checkRecord(record, meta) {
  const errors = [];
  if (!meta || !CODECS[meta.format]) return { ok: false, errors: [`Unknown record format "${meta?.format}".`], warnings: [], view: null };
  if (!LANGS.has(meta.lang)) return { ok: false, errors: [`Unknown language "${meta.lang}".`], warnings: [], view: null };
  const c = CODECS[meta.format];
  if (!(record instanceof Uint8Array)) return { ok: false, errors: ["Record must be bytes."], warnings: [], view: null };
  const size = c.recordSize(meta.lang);
  if (record.length !== size) errors.push(`A ${meta.format} record in this language is ${size} bytes, not ${record.length}.`);
  let v = { ok: false, errors: [], warnings: [] }, view = null;
  if (!errors.length) {
    try { v = c.validate(record, meta); } catch (e) { v = { ok: false, errors: [e.message], warnings: [] }; }
    if (v.ok) {
      try { view = readRecord(record, meta).view; } catch (e) { errors.push(e.message); }
      if (view && !(view.species > 0)) errors.push("This slot is empty.");
      else if (view) errors.push(...originProblems(view));
    }
  }
  const all = [...errors, ...(v.errors || [])];
  return { ok: all.length === 0 && v.ok !== false, errors: all, warnings: v.warnings || [], view };
}

const originGen = (code) => [3, 4, 5].find((g) => gameCodes(g).includes(code)) ?? 0;
const PAL_PARK = 55, POKE_TRANSFER = 30001;

/** PK4 and PK5 records have the same size and encryption, so a record in the wrong format still
    parses. The only ways in are Pal Park (Gen 3 -> 4) and Poké Transfer (Gen 3/4 -> 5), which set the
    met location; a record from an older game without that mark is in the wrong format. */
function originProblems(view) {
  if (view.isEgg || !view.met) return [];
  const from = originGen(view.met.game);
  if (view.gen === 5 && (from === 3 || from === 4) && view.met.location !== POKE_TRANSFER)
    return ["This looks like a Generation 4 record labelled as Generation 5 (it never went through Poké Transfer)."];
  if (view.gen === 4 && from === 3 && view.met.location !== PAL_PARK)
    return ["This looks like a Generation 3 record labelled as Generation 4 (it never went through Pal Park)."];
  if (view.gen === 4 && from === 5) return ["Generation 5 Pokémon cannot be Generation 4 records."];
  return [];
}

/** A name for one individual Pokémon that survives evolution, levelling, moves and held items:
    the root of its evolution family plus Gen 3-5 PID + OT, or Gen 1/2 DVs + OT (Gen 1/2 have no
    PID; the Time Capsule keeps DVs and OT). Gen 1/2 identities can collide (DVs are 16 bits), so
    this is a hint for "seen before" warnings, never a reason to refuse a deposit. */
export function identity(view) {
  let root = view.species;
  for (let i = 0; i < 3 && evolvesFrom(root); i++) root = evolvesFrom(root);
  const ot = `${view.ot.tid}:${view.ot.sid ?? ""}:${view.ot.name}`;
  if (view.gen <= 2) {
    const d = view.dvs || {};
    return `gb|${root}|${d.atk},${d.def},${d.spe},${d.spc}|${ot}`;
  }
  return `pid|${root}|${(view.pid >>> 0).toString(16)}|${ot}`;
}

export { hex as recordHex };
