/* Gen 2 saves: Gold, Silver, Crystal; international, Japanese and Korean layouts.
   docs/research/format-gen1-gen2.md §3 (detection), §5 (layout, backup, mail, Pokédex), §12.

   The image is the cartridge SRAM: 32 KiB, or 64 KiB for Japanese Crystal (mobile banks). The
   game data block (player, money, box names, current-box index, party, Pokédex) is stored twice:
   the primary copy at 0x2009 with a 16-bit sum stored little-endian, and a backup with its own sum
   (contiguous for Crystal and the Japanese games, five pieces for Gold/Silver; piece 2 sits at
   0x3D96 as pret's symbols say, not at PKHeX's 0x3D69). On load the game uses the primary when
   its sum is right, else the backup, and rewrites the other copy at the next save.

   PC boxes live in banks 2/3, one slot each, no checksums. Unlike Gen 1 the SLOT is authoritative
   for every box including the current one: `sBox` is a mirror that the game overwrites from the
   slot on load. Party mail (6 entries, primary 0x0600 and backup 0x071A) follows party order, and
   the game restores the backup over the primary on load, so both copies move together.

   Write-back: a box change rewrites its slot (and sBox for the current box); party, Pokédex and
   current-box changes rewrite the primary, its sum, the backup copy and the backup sum; the
   0x63/0x7F "save exists" bytes are kept. Korean saves are read-only: their backup layout is
   known only from PKHeX and does not add up (§5.3). Japanese mail offsets are unknown, so a party
   removal that would have to move Japanese mail is refused. An untouched save serializes to the
   original bytes. */
import { FormatError, u16be, u16le, u24be, setU16le, getFlag, setFlag } from "../bytes.js";
import * as D from "../data/index.js";
import * as pk2 from "../pkm/pk2.js";
import * as L from "../pkm/gblist.js";

const slotsInt = (i) => (i < 7 ? 0x4000 + i * 0x450 : 0x6000 + (i - 7) * 0x450);
const slotsJp = (i) => (i < 6 ? 0x4000 + i * 0x54a : 0x6000 + (i - 6) * 0x54a);

/* Offsets per layout (§5.1, §5.3, §5.4). data = [start, end) of the checksummed primary block;
   backup.pieces = [primary start, primary end, backup start]. JP/KOR are PKHeX-only (single source). */
const LAYOUTS = [
  { id: "gs-int", game: "GS", group: "west", nameLen: 11, boxNameLen: 9, boxes: 14, cap: 20, slot: slotsInt,
    data: [0x2009, 0x2d69], checksum: 0x2d69, checks: [0x2008, 0x2d6b],
    backup: { pieces: [[0x2009, 0x222f, 0x15c7], [0x222f, 0x23d9, 0x3d96], [0x23d9, 0x2856, 0x0c6b], [0x2856, 0x288a, 0x7e39], [0x288a, 0x2d69, 0x10e8]], checksum: 0x7e6d, checks: [0x7e38, 0x7e6f] },
    playTime: 0x2053, money: 0x23db, curBox: 0x2724, boxNames: 0x2727, party: 0x288a, caught: 0x2a4c, seen: 0x2a6c,
    sBox: 0x2d6c, mail: [0x0600, 0x071a], mailSize: 0x2f },
  { id: "c-int", game: "C", group: "west", nameLen: 11, boxNameLen: 9, boxes: 14, cap: 20, slot: slotsInt,
    data: [0x2009, 0x2b83], checksum: 0x2d0d, checks: [0x2008, 0x2d0f],
    backup: { pieces: [[0x2009, 0x2b83, 0x1209]], checksum: 0x1f0d, checks: [0x1208, 0x1f0f] },
    playTime: 0x2052, money: 0x23dc, curBox: 0x2700, boxNames: 0x2703, party: 0x2865, caught: 0x2a27, seen: 0x2a47,
    sBox: 0x2d10, mail: [0x0600, 0x071a], mailSize: 0x2f, gender: () => 0x3e3d },
  // Japanese check bytes are inferred (0x2008/0x2D0F, UNVERIFIED): a confidence hint only, never written.
  { id: "gs-jp", game: "GS", group: "ja", nameLen: 6, boxNameLen: 9, boxes: 9, cap: 30, slot: slotsJp,
    data: [0x2009, 0x2c8c], checksum: 0x2d0d, hintChecks: [0x2008, 0x2d0f],
    backup: { pieces: [[0x2009, 0x2c8c, 0x7209]], checksum: 0x7f0d },
    playTime: 0x2034, money: 0x23bc, curBox: 0x2705, boxNames: 0x2708, party: 0x283e, caught: 0x29ce, seen: 0x29ee,
    sBox: 0x2d10, mail: null },
  { id: "c-jp", game: "C", group: "ja", nameLen: 6, boxNameLen: 9, boxes: 9, cap: 30, slot: slotsJp,
    data: [0x2009, 0x2ae3], checksum: 0x2d0d, hintChecks: [0x2008, 0x2d0f],
    backup: { pieces: [[0x2009, 0x2ae3, 0x7209]], checksum: 0x7f0d },
    playTime: 0x2034, money: 0x23be, curBox: 0x26e2, boxNames: 0x26e5, party: 0x281a, caught: 0x29aa, seen: 0x29ca,
    sBox: 0x2d10, mail: null, gender: (img) => (img.length >= 0x10000 ? 0x8000 : 0x204c) },
  { id: "gs-ko", game: "GS", group: "ko", nameLen: 11, boxNameLen: 17, boxes: 14, cap: 20, slot: slotsInt,
    data: [0x2009, 0x2dab], checksum: 0x2dab, backup: null,
    playTime: 0x204d, money: 0x23d3, curBox: 0x26fc, boxNames: 0x26ff, party: 0x28cc, caught: 0x2a8e, seen: 0x2aae,
    sBox: 0x2dae, mail: null,
    readOnly: "Korean Gold and Silver saves can be read but not changed yet: their backup copy is not documented well " +
      "enough to write it safely." },
];
for (const lay of LAYOUTS) { lay.unownDex = lay.seen + 0x20; lay.firstUnown = lay.seen + 0x3b; }

const CHECK = [0x63, 0x7f];   // SAVE_CHECK_VALUE_1 / _2
const listOf = (lay, party) => L.listLayout(party ? 6 : lay.cap, party ? pk2.PARTY_STRUCT_SIZE : pk2.STRUCT_SIZE, lay.nameLen);
const isEntry = (b) => (b >= 1 && b <= D.MAX_SPECIES[2]) || b === L.EGG;
const sum16 = (img, from, to) => { let s = 0; for (let i = from; i < to; i++) s += img[i]; return s & 0xffff; };
const primaryOk = (img, lay) => u16le(img, lay.checksum) === sum16(img, lay.data[0], lay.data[1]);
function backupOk(img, lay) {
  if (!lay.backup) return false;
  const s = lay.backup.pieces.reduce((a, [from, to, at]) => a + sum16(img, at, at + to - from), 0) & 0xffff;
  return u16le(img, lay.backup.checksum) === s;
}
const hasChecks = (img, at) => !!at && img[at[0]] === CHECK[0] && img[at[1]] === CHECK[1];
/** Copies the backup pieces over the primary block (what the game loads when the primary is bad). */
function restorePrimary(img, lay) {
  for (const [from, to, at] of lay.backup.pieces) img.copyWithin(from, at, at + to - from);
  setU16le(img, lay.checksum, sum16(img, lay.data[0], lay.data[1]));
}

function score(img, lay) {
  const p = primaryOk(img, lay), b = backupOk(img, lay);
  if (!p && !b) return 0;
  const data = p ? img : new Uint8Array(img);
  if (!p) restorePrimary(data, lay);
  if (!L.headerOk(data, lay.party, listOf(lay, true), isEntry)) return 0;
  const cur = data[lay.curBox] < lay.boxes ? data[lay.curBox] : 0;
  const BOX = listOf(lay, false);
  if (!L.headerOk(data, lay.sBox, BOX, isEntry) && !L.headerOk(data, lay.slot(cur), BOX, isEntry)) return 0;
  let c = lay.group === "ko" ? 0.8 : 0.75;
  if (hasChecks(data, lay.checks)) c = 0.95;
  else if (hasChecks(data, lay.hintChecks)) c = 0.9;
  if (img.length === 0x10000 && lay.id !== "c-jp") c -= 0.2;
  if (!p) c -= 0.1;
  return c;
}

function guessLang(img, lay) {
  const mons = [], names = [img.subarray(0x200b, 0x200b + lay.nameLen)];
  const off = lay.slot(img[lay.curBox] < lay.boxes ? img[lay.curBox] : 0);
  for (const [o, party] of [[lay.party, true], [off, false]]) {
    const LL = listOf(lay, party);
    if (!L.headerOk(img, o, LL)) continue;
    for (let i = 0; i < img[o]; i++) {
      const e = L.readEntry(img, o, LL, i);
      if (e.listByte !== L.EGG) mons.push({ species: e.struct[0], nick: e.nick });
      names.push(e.ot);
    }
  }
  return L.guessWesternLang(2, names, mons);
}

/** -> { game: "GS" | "C", lang, confidence, layout } | null. Never throws. */
export function detect(image) {
  try {
    if (!(image instanceof Uint8Array) || (image.length !== 0x8000 && image.length !== 0x10000)) return null;
    let best = null, bestScore = 0;
    for (const lay of LAYOUTS) {
      const s = score(image, lay);
      if (s > bestScore) { best = lay; bestScore = s; }
    }
    if (!best) return null;
    let data = image;
    if (!primaryOk(image, best)) { data = new Uint8Array(image); restorePrimary(data, best); }
    const lang = best.group === "ja" ? "ja" : best.group === "ko" ? "ko" : guessLang(data, best);
    return { game: best.game, lang, confidence: Math.round(bestScore * 100) / 100, layout: best.id };
  } catch {
    return null;
  }
}

/** -> SaveFile (docs/ARCHITECTURE.md). A Western detection's lang may be overridden ("en" | "fr" | ...). */
export function open(image, detection = detect(image)) {
  if (!(image instanceof Uint8Array) || (image.length !== 0x8000 && image.length !== 0x10000)) throw new FormatError("A Gold, Silver or Crystal save is 32 KiB (64 KiB for Japanese Crystal).");
  if (!detection) throw new FormatError("This file is not a Pokémon Gold, Silver or Crystal save.");
  const lay = LAYOUTS.find((l) => l.id === detection.layout) ??
    LAYOUTS.find((l) => l.game === (detection.game === "C" ? "C" : "GS") && l.group === L.langGroup(detection.lang || "en"));
  if (!lay) throw new FormatError("Unknown Gold/Silver/Crystal layout.");
  const lang = lay.group === "west" ? (L.langGroup(detection.lang || "en") === "west" ? detection.lang || "en" : "en") : lay.group;
  const img = new Uint8Array(image);   // a copy even for a Node Buffer, whose slice() would share memory
  const meta = { format: pk2.FORMAT, lang, game: lay.game };
  const PARTY = listOf(lay, true), BOX = listOf(lay, false);
  const warnings = [];
  let readOnly = lay.readOnly ?? null;
  let dirty = false;   // primary game data changed

  const p = primaryOk(img, lay), b = backupOk(img, lay);
  if (!p && b) {
    restorePrimary(img, lay);
    dirty = true;
    warnings.push("The main copy of this save was damaged; the backup copy is used, as the game itself would.");
  } else if (!p) {
    readOnly ||= "This save's checksums are wrong, so the game would refuse to load it. It can be viewed but not changed.";
    warnings.push(readOnly);
  }
  if (lay.checks && !hasChecks(img, lay.checks)) warnings.push("This save lacks the marker bytes the game looks for; the game may act as if there is no save.");
  if (lay.readOnly) warnings.push(lay.readOnly);
  if (!L.headerOk(img, lay.party, PARTY)) throw new FormatError("The party data in this save is damaged.");

  const current = () => (img[lay.curBox] < lay.boxes ? img[lay.curBox] : 0);
  // Damaged = a header detect() would not accept (species bytes included), so a box made current
  // can never turn the file into one that no longer loads.
  const damaged = new Set();
  for (let i = 0; i < lay.boxes; i++) if (!L.headerOk(img, lay.slot(i), BOX, isEntry)) { damaged.add(i); warnings.push(`Box ${i + 1} is damaged and is shown as empty.`); }

  const fail = (msg) => { throw new FormatError(msg); };
  const writable = () => { if (readOnly) fail(readOnly); };
  const checkBox = (i) => { if (!(Number.isInteger(i) && i >= 0 && i < lay.boxes)) fail(`There is no box ${Number(i) + 1} in this game.`); };
  const boxCount = (i) => (damaged.has(i) ? 0 : img[lay.slot(i)]);
  const mirror = (i) => { if (i === current()) L.copyList(img, lay.slot(i), lay.sBox, BOX); };

  function partyRecord(i) {
    const e = L.readEntry(img, lay.party, PARTY, i), s = e.struct;
    const stats = { hp: u16be(s, 0x24), atk: u16be(s, 0x26), def: u16be(s, 0x28), spe: u16be(s, 0x2a), spa: u16be(s, 0x2c), spd: u16be(s, 0x2e) };
    return { record: L.entryToRecord(e, 2, pk2.STRUCT_SIZE), party: { level: s[0x1f], stats }, item: s[1] };
  }
  const slotOf = (record, party) => ({ record, meta: { ...meta }, view: pk2.toView(pk2.parse(record, meta), meta, party) });

  /** Moves party mail entries after `index` down one place in both copies (primary and backup). */
  function shiftMail(index, n) {
    const later = [...Array(n).keys()].filter((j) => j > index && pk2.isMail(partyRecord(j).item));
    if (!later.length) return;
    if (!lay.mail) fail("A Pokémon after this one holds Mail, and moving Mail is not supported for this game's language yet. Take the Mail first.");
    for (const base of lay.mail) {
      const at = (k) => base + k * lay.mailSize;
      img.copyWithin(at(index), at(index + 1), at(n));
      img.fill(0, at(n - 1), at(n));
    }
  }

  const genderAt = lay.gender?.(img);
  const save = {
    gen: 2, game: lay.game, gameName: D.gameCodeName(2, lay.game), format: pk2.FORMAT, lang,
    trainer: {
      name: L.decodeName(2, img.subarray(0x200b, 0x200b + lay.nameLen), lang),
      gender: genderAt == null ? null : img[genderAt] & 1,
      tid: u16be(img, 0x2009), sid: null,
      money: u24be(img, lay.money),
      playTime: { h: u16be(img, lay.playTime), m: img[lay.playTime + 2], s: img[lay.playTime + 3] },
    },
    boxCount: lay.boxes, boxCapacity: lay.cap,
    get currentBox() { return current(); },
    get readOnly() { return readOnly; },
    warnings,

    party() {
      const out = [];
      for (let i = 0; i < img[lay.party]; i++) { const r = partyRecord(i); out.push(slotOf(r.record, r.party)); }
      return out;
    },

    box(i) {
      checkBox(i);
      const out = new Array(lay.cap).fill(null);
      for (let k = 0; k < boxCount(i); k++) out[k] = slotOf(L.entryToRecord(L.readEntry(img, lay.slot(i), BOX, k), 2, pk2.STRUCT_SIZE));
      return out;
    },

    boxName(i) {
      checkBox(i);
      const o = lay.boxNames + i * lay.boxNameLen;
      return L.decodeName(2, img.subarray(o, o + lay.boxNameLen), lang);
    },

    takeFromParty(index) {
      writable();
      const n = img[lay.party];
      if (!(Number.isInteger(index) && index >= 0 && index < n)) fail(`There is no Pokémon in party slot ${Number(index) + 1}.`);
      const others = [...Array(n).keys()].filter((j) => j !== index && img[lay.party + 1 + j] !== L.EGG);
      if (!others.length) fail("You can't take your last Pokémon (other than Eggs) out of the party.");
      // Bill's PC also refuses when every other party member has fainted ("no more usable Pokémon").
      const hp = (j) => u16be(img, lay.party + PARTY.structs + j * PARTY.structSize + 0x22);
      if (!others.some((j) => hp(j) > 0)) fail("You can't take this Pokémon out: every other Pokémon in your party has fainted. Heal them at a Pokémon Center first.");
      const r = partyRecord(index);
      if (pk2.isMail(r.item)) fail("This Pokémon holds Mail. Take the Mail in the game first, then save and try again.");
      shiftMail(index, n);
      L.removeAt(img, lay.party, PARTY, index);
      dirty = true;
      return { record: r.record, meta: { ...meta } };
    },

    takeFromBox(bx, index) {
      writable();
      checkBox(bx);
      if (!(Number.isInteger(index) && index >= 0 && index < boxCount(bx))) fail(`Box ${bx + 1} has no Pokémon in slot ${Number(index) + 1}.`);
      const off = lay.slot(bx);
      const record = L.entryToRecord(L.readEntry(img, off, BOX, index), 2, pk2.STRUCT_SIZE);
      L.removeAt(img, off, BOX, index);
      mirror(bx);
      return { record, meta: { ...meta } };
    },

    /** Appends a record to a box (the first box with room when `box` is omitted). Lists are packed, so
        `index` may name any free slot and the Pokémon lands in the next free one; the returned index
        says where. A taken slot, a full box or an invalid record is refused. */
    putInBox(record, recMeta, bx, index) {
      writable();
      // pk1 and pk2 records have the same sizes (55 / 45 bytes), so a record without its format is refused.
      if (!recMeta?.format) fail("This Pokémon record does not say which format it is in, so it can't be stored.");
      if (recMeta.format !== pk2.FORMAT) fail(`This save holds Generation 2 Pokémon; a ${recMeta.format} record must be converted first.`);
      const rlang = recMeta?.lang || "en";
      if (L.langGroup(rlang) !== L.langGroup(lang)) {
        fail("Pokémon from Japanese, Korean and other games can't be mixed without converting them first.");
      }
      const v = pk2.validate(record, { ...meta, lang });
      if (!v.ok) fail(`This Pokémon can't be stored: ${v.errors[0]}`);
      if (pk2.isMail(record[2])) fail("A Pokémon holding Mail can't be put in a PC box.");
      if (bx == null) {
        bx = [...Array(lay.boxes).keys()].find((i) => !damaged.has(i) && boxCount(i) < lay.cap);
        if (bx == null) fail("Every box is full.");
      }
      checkBox(bx);
      if (damaged.has(bx)) fail(`Box ${bx + 1} is damaged; choose another box.`);
      const n = boxCount(bx);
      if (n >= lay.cap) fail(`Box ${bx + 1} is full.`);
      if (index != null && !(Number.isInteger(index) && index >= 0 && index < lay.cap)) fail(`There is no slot ${Number(index) + 1} in a box.`);
      if (index != null && index < n) fail(`Box ${bx + 1} slot ${index + 1} is taken.`);
      const at = L.append(img, lay.slot(bx), BOX, L.recordToEntry(record, 2, pk2.STRUCT_SIZE, lay.nameLen));
      mirror(bx);
      return { box: bx, index: at };
    },

    /** Marks a species seen and caught. Unown also adds its letter (opts.form, 0 = A) to the Unown
        Dex if missing, and becomes the "first Unown seen" when there is none (§5.7). Eggs are skipped. */
    registerDex(species, opts = {}) {
      writable();
      if (opts.isEgg || !(species >= 1 && species <= D.MAX_SPECIES[2])) return;
      setFlag(img, lay.caught, species - 1);
      setFlag(img, lay.seen, species - 1);
      if (species === 201) {
        const letter = ((opts.form ?? 0) % 26) + 1;
        const list = img.subarray(lay.unownDex, lay.unownDex + 26);
        if (!list.includes(letter)) { const free = list.indexOf(0); if (free >= 0) list[free] = letter; }
        if (!img[lay.firstUnown]) img[lay.firstUnown] = letter;
      }
      dirty = true;
    },

    /** { seen: [species], caught: [species] } (extra, not in the contract). */
    pokedex() {
      const seen = [], caught = [];
      for (let s = 1; s <= D.MAX_SPECIES[2]; s++) {
        if (getFlag(img, lay.seen, s - 1)) seen.push(s);
        if (getFlag(img, lay.caught, s - 1)) caught.push(s);
      }
      return { seen, caught };
    },

    /** Unown letters in the Unown Dex, in the order they were registered (0 = A; extra). */
    unownDex() { return [...img.subarray(lay.unownDex, lay.unownDex + 26)].filter((x) => x >= 1 && x <= 26).map((x) => x - 1); },

    /** Makes another box current (extra): sets the index and refreshes the sBox mirror from its slot. */
    setCurrentBox(bx) {
      writable();
      checkBox(bx);
      if (bx === current()) return;
      if (damaged.has(bx)) fail(`Box ${bx + 1} is damaged; choose another box.`);
      img[lay.curBox] = bx;
      mirror(bx);
      dirty = true;
    },

    serialize() {
      if (dirty && !lay.readOnly) {
        setU16le(img, lay.checksum, sum16(img, lay.data[0], lay.data[1]));
        if (lay.backup) {
          for (const [from, to, at] of lay.backup.pieces) img.copyWithin(at, from, to);
          const s = lay.backup.pieces.reduce((a, [from, to, at]) => a + sum16(img, at, at + to - from), 0) & 0xffff;
          setU16le(img, lay.backup.checksum, s);
          if (lay.backup.checks && hasChecks(img, lay.checks)) { img[lay.backup.checks[0]] = CHECK[0]; img[lay.backup.checks[1]] = CHECK[1]; }
        }
      }
      return img.slice();
    },
  };
  return save;
}
