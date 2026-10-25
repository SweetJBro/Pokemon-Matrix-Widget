/* Gen 1 saves: Red, Green, Blue, Yellow; international and Japanese layouts.
   docs/research/format-gen1-gen2.md §3 (detection), §4 (layout, checksums, current box), §12.

   The image is the 32 KiB cartridge SRAM (container.js strips emulator trailers first). Bank 1
   holds the checksummed game data: player, Pokédex, party, and the CURRENT box at 0x30C0, which is
   authoritative. Banks 2/3 hold one slot per box; the game never writes the current box's slot on
   save, so in a game-written file it reads as an empty list with stale bytes, and it is never
   read. Until bit 7 of the current-box byte is set (the first "Change Box"), the bank slots are
   uninitialised and every other box is empty.

   Write-back, as the game does it plus PKHeX's harmless mirror:
   - party, current box, Pokédex and the current-box byte live in bank 1: rewrite them and the
     main checksum (0x3523, JP 0x3594; ~sum, 8 bits), which the game verifies on load;
   - a change to the current box is mirrored into its slot once the slots are initialised;
   - a write into another box first initialises all slots when bit 7 is clear (the game's
     EmptyAllSRAMBoxes), sets bit 7, then rewrites the slot and, for the international layout, the
     bank checksums the game writes but never reads (JP positions are unverified: left alone).
   Records are box structs; the party's level becomes the box-level byte on the way out, as the
   game's deposit does. Nothing is written until serialize(); an untouched save serializes to the
   original bytes. */
import { FormatError, u16be, getFlag, setFlag } from "../bytes.js";
import * as D from "../data/index.js";
import * as pk1 from "../pkm/pk1.js";
import * as L from "../pkm/gblist.js";

const SIZE = 0x8000;
const BANK1 = 0x2598;   // start of the main checksummed block (player name)

const INT = {
  id: "int", nameLen: 11, boxes: 12, cap: 20, owned: 0x25a3, seen: 0x25b6, money: 0x25f3, rival: 0x25f6,
  tid: 0x2605, pikachu: 0x271c, curBox: 0x284c, starter: 0x29c3, playTime: 0x2ced, party: 0x2f2c,
  current: 0x30c0, checksum: 0x3523, bankChecksums: true,
  slot: (i) => (i < 6 ? 0x4000 + i * 0x462 : 0x6000 + (i - 6) * 0x462),
};
const JP = {
  id: "jp", nameLen: 6, boxes: 8, cap: 30, owned: 0x259e, seen: 0x25b1, money: 0x25ee, rival: 0x25f1,
  tid: 0x25fb, pikachu: 0x2712, curBox: 0x2842, starter: 0x29b9, playTime: 0x2ca0, party: 0x2ed5,
  current: 0x302d, checksum: 0x3594, bankChecksums: false,
  slot: (i) => (i < 4 ? 0x4000 + i * 0x566 : 0x6000 + (i - 4) * 0x566),
};
/* mstan's PokemonYellowRecomp "Extended" adds Pokédex #152-251, which "changes the save layout and
   checksum" (ports-and-emulators.md §1.2). No sample exists; the probe assumes both 19-byte dex
   arrays grew to 32 bytes and everything after them moved by 26 (UNVERIFIED), and only serves to
   refuse such a file with a clear message instead of misreading it. */
const EXT_SHIFT = 26;
const EXTENDED_MESSAGE =
  "This looks like a save from the Pokémon Yellow Recomp \"Extended\" build, which adds Pokémon 152-251 and " +
  "changes the save layout. Only saves from the Stock build (identical to the cartridge) can be used here.";

const listOf = (lay, party) => L.listLayout(party ? 6 : lay.cap, party ? pk1.PARTY_STRUCT_SIZE : pk1.STRUCT_SIZE, lay.nameLen);
const isMon = (b) => D.gen1ToNational(b) !== 0;
const mainChecksum = (img, end) => { let s = 0; for (let i = BANK1; i < end; i++) s += img[i]; return ~s & 0xff; };
const bcd = (img, o, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 100 + (img[o + i] >> 4) * 10 + (img[o + i] & 15); return v; };

function layoutValid(img, lay, shift = 0) {
  if (img[lay.checksum + shift] !== mainChecksum(img, lay.checksum + shift)) return false;
  if (!L.headerOk(img, lay.party + shift, listOf(lay, true), isMon)) return false;
  if (!L.headerOk(img, lay.current + shift, listOf(lay, false), isMon)) return false;
  return img.subarray(BANK1, BANK1 + lay.nameLen).includes(L.NAME_END);
}

/** Western language from the names in bank 1 (§3.4: only a guess; the UI should confirm it). */
function guessLang(img, lay) {
  const names = [img.subarray(BANK1, BANK1 + lay.nameLen), img.subarray(lay.rival, lay.rival + lay.nameLen)];
  const mons = [];
  for (const [off, party] of [[lay.party, true], [lay.current, false]]) {
    const LL = listOf(lay, party);
    for (let i = 0; i < img[off]; i++) {
      const e = L.readEntry(img, off, LL, i);
      mons.push({ species: D.gen1ToNational(e.struct[0]), nick: e.nick });
      names.push(e.ot);
    }
  }
  return L.guessWesternLang(1, names, mons);
}

/** -> { game: "RB" | "Y", lang, confidence, layout: "int" | "jp" } | null. Never throws. */
export function detect(image) {
  try {
    if (!(image instanceof Uint8Array) || image.length !== SIZE) return null;
    const hits = [INT, JP].filter((lay) => layoutValid(image, lay));
    if (!hits.length) {
      if (layoutValid(image, INT, EXT_SHIFT)) return { game: "Y", lang: "en", confidence: 0.3, layout: "yellow-extended" };
      return null;
    }
    const lay = hits[0];
    const starter = image[lay.starter];
    const yellow = starter === 0x54 || (starter === 0 && image[lay.pikachu] !== 0);
    const boxByte = image[lay.curBox] & 0x7f;
    return {
      game: yellow ? "Y" : "RB",
      lang: lay === JP ? "ja" : guessLang(image, lay),
      confidence: hits.length === 1 && boxByte < lay.boxes ? 0.9 : 0.6,
      layout: lay.id,
    };
  } catch {
    return null;
  }
}

/** -> SaveFile (docs/ARCHITECTURE.md). The detection's lang may be overridden within its layout
    (Western saves: "en" | "fr" | "de" | "it" | "es"). */
export function open(image, detection = detect(image)) {
  if (!(image instanceof Uint8Array) || image.length !== SIZE) throw new FormatError("A Red, Blue or Yellow save is 32 KiB.");
  if (!detection) throw new FormatError("This file is not a Pokémon Red, Blue or Yellow save.");
  if (detection.layout === "yellow-extended") throw new FormatError(EXTENDED_MESSAGE, { code: "yellow-extended" });
  const lay = detection.layout === "jp" || detection.lang === "ja" ? JP : INT;
  const lang = lay === JP ? "ja" : (detection.lang && detection.lang !== "ja" && detection.lang !== "ko" ? detection.lang : "en");
  const game = detection.game === "Y" ? "Y" : "RB";
  const img = new Uint8Array(image);   // a copy even for a Node Buffer, whose slice() would share memory
  const meta = { format: pk1.FORMAT, lang, game };
  const PARTY = listOf(lay, true), BOX = listOf(lay, false);
  const warnings = [];
  const dirty = { main: false, banks: new Set() };
  const bankOf = (off) => (off >> 13);

  const initialised = () => (img[lay.curBox] & 0x80) !== 0;
  const current = () => img[lay.curBox] & 0x7f;
  let readOnly = null;
  const refuseWrites = (why) => { readOnly ||= `${why}, so it can be viewed but not changed.`; warnings.push(`${why}.`); };
  if (img[lay.checksum] !== mainChecksum(img, lay.checksum)) refuseWrites("This save's checksum is wrong (the game would say the file data is destroyed)");
  if (current() >= lay.boxes) refuseWrites(`This save's current-box number (${current() + 1}) is out of range`);

  /** Offset of box i's list, or null for an uninitialised slot (an empty box). */
  const boxOffset = (i) => (i === current() ? lay.current : initialised() ? lay.slot(i) : null);
  // A box is damaged when its header is not one detect() would accept for the current box (species
  // bytes included): otherwise Change Box could load it into bank 1 and the file would stop loading.
  const damaged = new Set();
  for (let i = 0; i < lay.boxes; i++) {
    const off = boxOffset(i);
    if (off != null && !L.headerOk(img, off, BOX, isMon)) { damaged.add(i); warnings.push(`Box ${i + 1} is damaged and is shown as empty.`); }
  }
  if (!L.headerOk(img, lay.party, PARTY)) throw new FormatError("The party data in this save is damaged.");
  if (damaged.has(current())) refuseWrites("The current box in this save is damaged");

  const fail = (msg) => { throw new FormatError(msg); };
  const checkBox = (i) => { if (!(Number.isInteger(i) && i >= 0 && i < lay.boxes)) fail(`There is no box ${Number(i) + 1} in this game.`); };
  const boxCount = (i) => { const off = boxOffset(i); return off == null || damaged.has(i) ? 0 : img[off]; };

  function partyRecord(i) {
    const e = L.readEntry(img, lay.party, PARTY, i);
    const s = e.struct;
    const box = { ...e, struct: s.slice(0, pk1.STRUCT_SIZE) };
    box.struct[3] = s[0x21];   // the deposit copies the party level into the box-level byte
    const stats = { hp: u16be(s, 0x22), atk: u16be(s, 0x24), def: u16be(s, 0x26), spe: u16be(s, 0x28), spa: u16be(s, 0x2a), spd: u16be(s, 0x2a) };
    return { record: L.entryToRecord(box, 1, pk1.STRUCT_SIZE), party: { level: s[0x21], stats }, listByte: e.listByte };
  }
  const slotOf = (record, party, listByte) => {
    const view = pk1.toView(pk1.parse(record, meta), meta, party);
    if (listByte != null && listByte !== record[0]) view.warnings.push("Its list entry does not match its species.");
    return { record, meta: { ...meta }, view };
  };

  function touch(off) {
    const bank = bankOf(off);
    if (bank === 1) dirty.main = true; else dirty.banks.add(bank);
  }
  /** After the current box changed: mirror it into its own slot (once the slots are in use). */
  function mirrorCurrent() {
    touch(lay.current);
    if (!initialised()) return;
    L.copyList(img, lay.current, lay.slot(current()), BOX);
    touch(lay.slot(current()));
  }
  /** The game's first-box-change wipe, done once before any other box is written. */
  function initialiseSlots() {
    if (initialised()) return;
    for (let i = 0; i < lay.boxes; i++) { L.clearList(img, lay.slot(i), BOX); touch(lay.slot(i)); damaged.delete(i); }
    img[lay.curBox] |= 0x80;
    mirrorCurrent();
  }
  const writable = () => { if (readOnly) fail(readOnly); };

  const save = {
    gen: 1, game, gameName: D.gameCodeName(1, game), format: pk1.FORMAT, lang,
    trainer: {
      name: L.decodeName(1, img.subarray(BANK1, BANK1 + lay.nameLen), lang),
      gender: null,
      tid: u16be(img, lay.tid), sid: null,
      money: bcd(img, lay.money, 3),
      playTime: { h: img[lay.playTime], m: img[lay.playTime + 2], s: img[lay.playTime + 3] },
    },
    boxCount: lay.boxes, boxCapacity: lay.cap,
    get currentBox() { return current() < lay.boxes ? current() : 0; },
    get readOnly() { return readOnly; },
    warnings,

    party() {
      const out = [];
      for (let i = 0; i < img[lay.party]; i++) { const p = partyRecord(i); out.push(slotOf(p.record, p.party, p.listByte)); }
      return out;
    },

    box(i) {
      checkBox(i);
      const out = new Array(lay.cap).fill(null);
      const off = boxOffset(i);
      for (let k = 0; k < boxCount(i); k++) {
        const e = L.readEntry(img, off, BOX, k);
        out[k] = slotOf(L.entryToRecord(e, 1, pk1.STRUCT_SIZE), null, e.listByte);
      }
      return out;
    },

    /** Gen 1 stores no box names; these are the labels PKHeX uses. */
    boxName(i) { checkBox(i); return lay === JP ? `ボックス${i + 1}` : `Box ${i + 1}`; },

    takeFromParty(index) {
      writable();
      const n = img[lay.party];
      if (!(Number.isInteger(index) && index >= 0 && index < n)) fail(`There is no Pokémon in party slot ${Number(index) + 1}.`);
      if (n <= 1) fail("You can't take your last Pokémon out of the party.");
      const { record } = partyRecord(index);
      L.removeAt(img, lay.party, PARTY, index);
      touch(lay.party);
      return { record, meta: { ...meta } };
    },

    takeFromBox(b, index) {
      writable();
      checkBox(b);
      if (!(Number.isInteger(index) && index >= 0 && index < boxCount(b))) fail(`Box ${b + 1} has no Pokémon in slot ${Number(index) + 1}.`);
      const off = boxOffset(b);
      const record = L.entryToRecord(L.readEntry(img, off, BOX, index), 1, pk1.STRUCT_SIZE);
      L.removeAt(img, off, BOX, index);
      if (b === current()) mirrorCurrent(); else touch(off);
      return { record, meta: { ...meta } };
    },

    /** Appends a record to a box (the first box with room when `box` is omitted). Lists are packed, so
        `index` may name any free slot and the Pokémon lands in the next free one; the returned index
        says where. A taken slot, a full box or an invalid record is refused. */
    putInBox(record, recMeta, b, index) {
      writable();
      // pk1 and pk2 records have the same sizes (55 / 45 bytes), so a record without its format is refused.
      if (!recMeta?.format) fail("This Pokémon record does not say which format it is in, so it can't be stored.");
      if (recMeta.format !== pk1.FORMAT) fail(`This save holds Generation 1 Pokémon; a ${recMeta.format} record must be converted first.`);
      const rlang = recMeta?.lang || "en";
      if (L.langGroup(rlang) !== L.langGroup(lang)) fail("Pokémon from Japanese and non-Japanese games can't be mixed without converting them first.");
      const v = pk1.validate(record, { ...meta, lang });
      if (!v.ok) fail(`This Pokémon can't be stored: ${v.errors[0]}`);
      if (b == null) {
        b = [...Array(lay.boxes).keys()].find((i) => !damaged.has(i) && boxCount(i) < lay.cap);
        if (b == null) fail("Every box is full.");
      }
      checkBox(b);
      if (damaged.has(b)) fail(`Box ${b + 1} is damaged; choose another box.`);
      const n = boxCount(b);
      if (n >= lay.cap) fail(`Box ${b + 1} is full.`);
      if (index != null && !(Number.isInteger(index) && index >= 0 && index < lay.cap)) fail(`There is no slot ${Number(index) + 1} in a box.`);
      if (index != null && index < n) fail(`Box ${b + 1} slot ${index + 1} is taken.`);
      if (b !== current()) initialiseSlots();
      const at = L.append(img, boxOffset(b), BOX, L.recordToEntry(record, 1, pk1.STRUCT_SIZE, lay.nameLen));
      if (b === current()) mirrorCurrent(); else touch(boxOffset(b));
      return { box: b, index: at };
    },

    /** Marks a species seen and owned (both bit arrays live in bank 1). Forms and the rest do not exist in Gen 1. */
    registerDex(species, opts = {}) {
      writable();
      if (opts.isEgg || !(species >= 1 && species <= D.MAX_SPECIES[1])) return;
      setFlag(img, lay.owned, species - 1);
      setFlag(img, lay.seen, species - 1);
      dirty.main = true;
    },

    /** { seen: [species], caught: [species] } (extra, not in the contract). */
    pokedex() {
      const seen = [], caught = [];
      for (let s = 1; s <= D.MAX_SPECIES[1]; s++) {
        if (getFlag(img, lay.seen, s - 1)) seen.push(s);
        if (getFlag(img, lay.owned, s - 1)) caught.push(s);
      }
      return { seen, caught };
    },

    /** The PC's "Change Box" (extra): saves the current box into its slot, loads the new one into bank 1. */
    setCurrentBox(b) {
      writable();
      checkBox(b);
      if (b === current()) return;
      if (damaged.has(b)) fail(`Box ${b + 1} is damaged; choose another box.`);
      initialiseSlots();
      L.copyList(img, lay.current, lay.slot(current()), BOX);
      touch(lay.slot(current()));
      img[lay.curBox] = 0x80 | b;
      L.copyList(img, lay.slot(b), lay.current, BOX);
      touch(lay.current);
    },

    serialize() {
      if (lay.bankChecksums) {
        for (const bank of dirty.banks) {
          const base = bank * 0x2000;
          let all = 0;
          for (let i = base; i < base + 0x1a4c; i++) all += img[i];
          img[base + 0x1a4c] = ~all & 0xff;
          for (let k = 0; k < 6; k++) {
            let s = 0;
            const o = base + k * 0x462;
            for (let i = o; i < o + 0x462; i++) s += img[i];
            img[base + 0x1a4d + k] = ~s & 0xff;
          }
        }
      }
      if (dirty.main) img[lay.checksum] = mainChecksum(img, lay.checksum);
      return img.slice();
    },
  };
  return save;
}
