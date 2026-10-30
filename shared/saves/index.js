/* The one entry point for save files: bytes the player dropped in -> SaveFile, and back.

   openSave() undoes RetroArch compression, asks container.js for every way the file could be
   read (raw image, image + emulator trailer, DeSmuME footer, ...), and gives each candidate to the
   detectors of the generations its size allows. The first candidate a detector accepts wins;
   when none does, container.js explains what the file looks like.

   The SaveFile a generation module returns is wrapped so every save has the same surface:
   `readOnly` merges the container's reason (a 64 KiB GBA dump, Yellow "Extended") with the
   game's own (bad checksums, PC-port layouts), and the methods that change the save throw that
   reason instead of each generation guarding it differently. exportSave() serializes and puts the
   container back, byte for byte apart from the documented fix-ups. */
import { FormatError } from "../bytes.js";
import { unwrap, rebuild, maybeDecompress, explainUnrecognised } from "./container.js";
import * as gen1 from "./gen1.js";
import * as gen2 from "./gen2.js";
import * as gen3 from "./gen3.js";
import * as gen4 from "./gen4.js";
import * as gen5 from "./gen5.js";

const DETECTORS = { gb: [gen1, gen2], gba: [gen3], nds: [gen4, gen5] };
const BY_FORMAT = { pk1: gen1, pk2: gen2, pk3: gen3, pk4: gen4, pk5: gen5 };
const WRITES = ["takeFromParty", "takeFromBox", "putInBox", "registerDex", "setCurrentBox"];

/** Bytes (Uint8Array or ArrayBuffer) + file name -> SaveFile. Throws FormatError with a message for players. */
export async function openSave(bytes, filename = "") {
  const { bytes: plain, layers } = await maybeDecompress(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const candidates = unwrap(plain, filename, { layers });
  for (const cand of candidates) {
    for (const mod of DETECTORS[cand.info.family] || []) {
      let det = null;
      try { det = mod.detect(cand.image); } catch { det = null; }
      if (!det) continue;
      const opts = { container: cand.info };
      const inner = mod.open(cand.image, { ...det, container: cand.info, readOnly: det.readOnly || cand.info.readOnly || undefined }, opts);
      return wrap(inner, cand.info, filename);
    }
  }
  throw new FormatError(explainUnrecognised(candidates), { code: "unrecognised" });
}

/** SaveFile -> file bytes. mode "same" restores the original container; "plain" is a raw cartridge image. */
export function exportSave(save, mode = "same") {
  if (!save || !save.container) throw new TypeError("exportSave expects a SaveFile from openSave");
  return rebuild(save.serialize(), save.container, mode);
}

/** Which module handles a record format ("pk3" -> gen3), for callers that only have a record. */
export const moduleForFormat = (format) => BY_FORMAT[format] || null;

function wrap(inner, container, filename) {
  const reason = () => container.readOnly || inner.readOnly || null;
  const save = Object.create(inner);
  Object.defineProperties(save, {
    container: { value: container, enumerable: true },
    filename: { value: filename, enumerable: true },
    readOnly: { get: reason, enumerable: true },
    warnings: { value: [...new Set([...(container.notes || []), ...(inner.warnings || [])])], enumerable: true },
  });
  for (const name of WRITES) {
    if (typeof inner[name] !== "function") continue;
    save[name] = (...args) => {
      const why = reason();
      if (why) throw new FormatError(why, { code: "read-only" });
      return inner[name](...args);
    };
  }
  return save;
}
