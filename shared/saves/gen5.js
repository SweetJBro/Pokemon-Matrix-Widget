/* Gen 5 saves: Black, White, Black 2, White 2. docs/research/format-gen5.md (§3-§7, §15, §20).

   The 512 KiB flash holds two copies of the main save (BW at 0x0 and 0x24000, B2W2 at 0x0 and
   0x26000) followed by extra saves, Mystery Gift cards, the B2W2 Key System / Memory Link data and
   the Dream Radar area. Each copy is a run of blocks (69 in BW, 73 in B2W2), each followed by a
   u16 save counter and a CRC-16/CCITT of its data, then a table repeating every block CRC, then a
   16-byte footer (global save counter, copy size, magic 0x31053527, CRC of the table).
   No language or region variant changes the layout; the game is told apart by the footer
   position, and the version byte in the trainer block names the cartridge that started the save.
   melonDS, cartridge dumps, Frigate (the B2W2 PC port) and eidos (the Black PC port) all store this
   raw image; container.js has already removed any emulator header or footer.

   Reading follows the game's own loader (§5.5) rather than PKHeX, which always reads the main
   copy: the copy with the higher footer counter supplies the CRC table, and each block comes from
   whichever copy matches that table, so an interrupted save or a damaged block is read the way the
   game would read it. Writing (§5.6): edit that effective image, re-CRC each changed block (block
   footer and table entry), bump its block counter and the global counter as the game does, re-CRC
   the table, then write the same image to BOTH copies. Writing only main (PKHeX's way) can be
   undone by a newer backup. Nothing outside the two copies is ever written, and serialize() of an
   untouched save returns the original bytes.

   Deposits and withdrawals go through the PC boxes (30 fixed slots per box; an empty slot is the
   encrypted zero struct). The party can be read and a member taken (later members shift down, as
   the game does); records are never put into the party. */
import { u16le, u32le, setU16le, setU32le, crc16ccitt, getFlag, setFlag, FormatError } from "../bytes.js";
import * as pk5 from "../pkm/pk5.js";
import { decode } from "../text/gen5.js";
import * as D from "../data/index.js";

export const IMAGE_SIZE = 0x80000;
export const MAGIC = 0x31053527;
export const BOX_COUNT = 24, BOX_SLOTS = 30;

/* ---------- block tables (§6) ---------- */

const BOXES = Array(24).fill(0xff0);
const BW_SIZES = [0x3e0, ...BOXES, 0x9c0, 0x534, 0x68, 0x9c, 0x1338, 0x7c4, 0xd54, 0x2c, 0x658, 0xa94, 0x1ac, 0x3ec, 0x5c,
  0x1e0, 0xa8, 0x460, 0x1400, 0x2a4, 0x2dc, 0x34c, 0x3ec, 0xf8, 0x2fc, 0x94, 0x35c, 0x1cc, 0x168, 0xec, 0x1b0, 0x1c,
  0x4d4, 0x34, 0x3c, 0x1ac, 0xb90, 0x9c, 0x850, 0x28, 0x284, 0x10, 0x5c, 0x16c, 0x40, 0xfc];
const B2W2_SIZES = [0x3e0, ...BOXES, 0x9ec, 0x534, 0xb0, 0xa8, 0x1338, 0x7c4, 0xd54, 0x94, 0x658, 0xa94, 0x1ac, 0x3ec, 0x5c,
  0x1e0, 0xa8, 0x460, 0x1400, 0x2a4, 0xe0, 0x34c, 0x4e0, 0xf8, 0x2fc, 0x94, 0x35c, 0x1d4, 0x1e0, 0xf0, 0x1b4, 0x4dc,
  0x34, 0x3c, 0x1ac, 0xb90, 0xac, 0x850, 0x284, 0x10, 0xa8, 0x16c, 0x80, 0xfc, 0x16a8, 0x498, 0x60, 0xfc, 0x3e4, 0xf0];

/* Pokédex form lists (§7.5): species and form count in bit order; BW stops after Basculin. */
const FORM_LIST = [[201, 28], [386, 4], [492, 2], [487, 2], [479, 6], [422, 2], [423, 2], [412, 3], [413, 3], [351, 4],
  [421, 2], [585, 4], [586, 4], [648, 2], [555, 2], [550, 2], [646, 3], [647, 2], [642, 2], [641, 2], [645, 2]];
const ALL_FORM_BITS = new Set([351, 421, 555, 648]);   // Castform, Cherrim, Darmanitan, Meloetta: every form bit is set

/** Block offsets follow from the sizes: data, a 4-byte footer, then the next 0x100 boundary (§5.1). */
function layout(name, sizes, copySize, extra) {
  const blocks = [];
  let off = 0;
  for (const size of sizes) { blocks.push({ off, size }); off = (off + size + 4 + 0xff) & ~0xff; }
  const crcsSize = sizes.length * 2 + (sizes.length & 1 ? 2 : 0);
  const forms = [];
  let bit = 0;
  for (const [species, count] of FORM_LIST.slice(0, extra.formEntries)) { forms.push([species, { base: bit, count }]); bit += count; }
  return { name, blocks, copySize, table: off, crcsSize, footer: off + crcsSize, formMap: new Map(forms), formBytes: Math.ceil(bit / 8), ...extra };
}
const LAYOUTS = {
  BW: layout("BW", BW_SIZES, 0x24000, { versions: { 20: "W", 21: "B" }, dexBlock: 55, formEntries: 16, maxItem: pk5.MAX_ITEM_BW }),
  B2W2: layout("B2W2", B2W2_SIZES, 0x26000, { versions: { 22: "W2", 23: "B2" }, dexBlock: 54, formEntries: 21, maxItem: pk5.MAX_ITEM_B2W2 }),
};
export { LAYOUTS };
const BOX_MAIN = 0, PARTY = 26, TRAINER = 27, MISC = 52;
const boxBlock = (b) => 1 + b;

/* ---------- footers and the game's copy selection (§5.4, §5.5) ---------- */

function footerOf(img, L, base) {
  const f = base + L.footer;
  const size = u32le(img, f + 4), magic = u32le(img, f + 8);
  return {
    count: u32le(img, f), size, magic,
    sizeOk: size === L.footer + 0x10,     // copy-relative in both copies
    magicOk: magic === MAGIC,
    crcOk: u16le(img, f + 0xe) === crc16ccitt(img, base + L.table, L.crcsSize),
  };
}
/* The size and magic the game compares footers with. B2W2's are in the decompilation. BW's are
   inferred (§5.4, §19 #1): if neither copy carries them but a copy's table CRC is right, that copy's
   values are taken as BW's real ones (a warning says so). Either way both copies are then judged
   against the same values, as the game does, so one copy with a damaged magic is not trusted. */
function expectedFooter(L, st) {
  if (L.name === "BW" && !st.some((s) => s.sizeOk && s.magicOk)) {
    const s = st.find((x) => x.crcOk);
    if (s) return { size: s.size, magic: s.magic, lenient: true };
  }
  return { size: L.footer + 0x10, magic: MAGIC, lenient: false };
}

/** Share of blocks whose own footer CRC equals the table entry: ~1 for a real save, ~0 for noise. */
function tableAgreement(img, L, base) {
  let n = 0;
  L.blocks.forEach(({ off, size }, i) => { if (u16le(img, base + off + size + 2) === u16le(img, base + L.table + 2 * i)) n++; });
  return n / L.blocks.length;
}

/** The game's load (§5.5) -> { image (copySize bytes), table: copy whose CRC table was used (0 main,
    1 backup), fallback: the preferred table failed, fromBackup: [block ids], footers } | { error }. */
function effectiveImage(img, L) {
  const bases = [0, L.copySize];
  const st = bases.map((b) => footerOf(img, L, b));
  const exp = expectedFooter(L, st);
  // The game's footer check: 2 = size or magic wrong, 1 = table CRC wrong, 0 = valid.
  const result = st.map((s) => (s.size !== exp.size || s.magic !== exp.magic ? 2 : s.crcOk ? 0 : 1));
  const ok = result.map((x) => x === 0);
  if (!ok[0] && !ok[1]) return { error: result.includes(1) ? "broken" : "empty" };
  const prefer = ok[0] && (!ok[1] || st[0].count >= st[1].count || (st[0].count === 0 && st[1].count === 0xffffffff)) ? 0 : 1;
  // With one valid footer the game copies it over the other, so there is only one table to try.
  for (const t of ok[0] && ok[1] ? [prefer, 1 - prefer] : [prefer]) {
    const image = img.slice(0, L.copySize), fromBackup = [];
    const T = (i) => u16le(img, bases[t] + L.table + 2 * i);
    let failed = false;
    for (let i = 0; i < L.blocks.length && !failed; i++) {
      const { off, size } = L.blocks[i];
      const usable = bases.map((b) => u16le(img, b + off + size + 2) === T(i) && crc16ccitt(img, b + off, size) === T(i));
      if (!usable[0] && !usable[1]) { failed = true; break; }
      // Only one copy matches the table: that one. Both match but their block counters differ: the
      // copy whose table is in use keeps its block. (An interrupted first save leaves the backup's
      // table newer and the new blocks only in main: main's blocks are then the usable ones.)
      const useBackup = !usable[0] || (usable[1] && t === 1 && u16le(img, off + size) !== u16le(img, L.copySize + off + size));
      if (useBackup) { image.set(img.subarray(L.copySize + off, L.copySize + off + size + 4), off); fromBackup.push(i); }
    }
    if (failed) continue;
    image.set(img.subarray(bases[t] + L.table, bases[t] + L.footer + 0x10), L.table);
    return { image, table: t, fallback: t !== prefer, fromBackup, footers: st, lenient: exp.lenient };
  }
  return { error: "broken" };
}

/* ---------- detect ---------- */

/** -> { game, lang, confidence, layout, copy } | null. Never throws. */
export function detect(image) {
  try {
    if (!(image instanceof Uint8Array) || image.length !== IMAGE_SIZE) return null;
    for (const L of [LAYOUTS.B2W2, LAYOUTS.BW]) {
      const st = [0, L.copySize].map((b) => footerOf(image, L, b));
      const strict = st.map((s) => s.crcOk && s.sizeOk && s.magicOk);
      let copy = strict[0] ? 0 : strict[1] ? 1 : -1, confidence = copy === 0 ? 1 : 0.9;
      if (copy < 0 && L.name === "BW") {
        // CRC-only BW footer: accept when the block footers agree with the table, as in a real save.
        copy = st.findIndex((s, c) => s.crcOk && tableAgreement(image, L, c * L.copySize) > 0.9);
        confidence = 0.6;
      }
      if (copy < 0) {
        if (st.some((s) => s.sizeOk && s.magicOk)) return { game: L.name, lang: "en", confidence: 0.2, layout: L.name, broken: true };
        continue;
      }
      const t = copy * L.copySize + L.blocks[TRAINER].off;
      const version = L.versions[image[t + 0x1f]];
      const lang = D.langFromId(image[t + 0x1e]);
      if (!version) confidence -= 0.05;
      if (!lang) confidence -= 0.05;
      return { game: version ?? L.name, lang: lang ?? "en", confidence, layout: L.name, copy };
    }
    return null;
  } catch {
    return null;
  }
}

/* ---------- open ---------- */

const refuse = (code, message) => { throw new FormatError(message, { code }); };
const GAME_NAMES = { BW: "Black/White", B2W2: "Black 2/White 2" };

/** open(image, detection?) -> SaveFile. Works on a copy; throws FormatError with a player-facing message. */
export function open(image, detection) {
  const det = detection?.layout ? detection : detect(image);
  if (!det) refuse("not-gen5", "This is not a Pokémon Black, White, Black 2 or White 2 save.");
  const L = LAYOUTS[det.layout];
  const orig = new Uint8Array(image);         // a plain copy (Buffer.slice() would be a view)
  const eff = effectiveImage(orig, L);
  if (eff.error === "broken") {
    refuse("corrupted", `This ${GAME_NAMES[L.name]} save is corrupted: neither of its two copies passes the game's checksums, ` +
      "so the game would not load it either. Try an older copy of the file.");
  }
  if (eff.error) refuse("no-save", `This ${GAME_NAMES[L.name]} save file is empty (the game has not saved yet).`);
  const img = eff.image;                      // the working copy every read and edit uses
  const blk = (i) => L.blocks[i].off;
  const T = blk(TRAINER);
  if (img[T + 0x2c] === 1) refuse("no-save", "The game treats this save as empty (it was made before the end of the introduction). Save in the game once, then try again.");

  const warnings = [];
  if (eff.fallback) warnings.push("The newest copy of this save is damaged, so the game falls back to the other, older copy; this page shows that one too.");
  else if (eff.table === 1) warnings.push("The backup copy of this save is the newer one; the game reads it, and so do we. A changed save will have both copies in sync.");
  if (eff.fromBackup.length) warnings.push(`${eff.fromBackup.length} part(s) of the main copy failed their checksum and were read from the backup copy, as the game does.`);
  if (eff.lenient) warnings.push("The save footer's size or magic number differs from what we expect for Black/White; the checksums are fine, so it was read anyway.");
  const version = L.versions[img[T + 0x1f]];
  const lang = D.langFromId(img[T + 0x1e]) ?? det.lang ?? "en";
  if (!D.langFromId(img[T + 0x1e])) warnings.push(`Unknown game language byte ${img[T + 0x1e]}; text is read as ${lang}.`);
  const game = version ?? L.name;
  const meta = { format: pk5.FORMAT, lang, game };
  const dirty = new Set();
  const touch = (i) => dirty.add(i);

  const trayCount = () => img[blk(BOX_MAIN) + 0x3dd];
  const tc = trayCount();
  if (![8, 16, 24].includes(tc)) warnings.push(`The save says ${tc} boxes are unlocked (the game uses 8, 16 or 24).`);
  let currentBox = u32le(img, blk(BOX_MAIN));
  if (currentBox >= BOX_COUNT) { warnings.push(`Current box ${currentBox} is out of range; using box 1.`); currentBox = 0; }

  const trainer = {
    name: decode(img.subarray(T + 4, T + 0x14), lang),
    gender: img[T + 0x21] === 1 ? "F" : "M",
    tid: u16le(img, T + 0x14), sid: u16le(img, T + 0x16),
    money: u32le(img, blk(MISC)),
    playTime: { h: u16le(img, T + 0x24), m: img[T + 0x26], s: img[T + 0x27] },
  };

  /* ----- slots ----- */
  const slotOff = (b, i) => blk(boxBlock(b)) + i * pk5.RECORD_SIZE;
  const checkBox = (b, i) => {
    if (!(Number.isInteger(b) && b >= 0 && b < BOX_COUNT)) refuse("bad-box", `There is no box ${b + 1}.`);
    if (i !== undefined && !(Number.isInteger(i) && i >= 0 && i < BOX_SLOTS)) refuse("bad-slot", `Boxes have ${BOX_SLOTS} slots; there is no slot ${i + 1}.`);
  };
  const entry = (stored) => ({ record: pk5.boxPart(stored), meta: { ...meta }, view: pk5.toView(pk5.parse(stored, meta), meta) });
  const slotFree = (b, i) => pk5.isEmpty(img.subarray(slotOff(b, i), slotOff(b, i) + pk5.RECORD_SIZE));
  let rawZero = 0;
  for (let b = 0; b < BOX_COUNT; b++) for (let i = 0; i < BOX_SLOTS; i++) {
    const o = slotOff(b, i);
    if (img.subarray(o, o + pk5.RECORD_SIZE).every((x) => x === 0)) rawZero++;
  }
  if (rawZero) warnings.push(`${rawZero} box slot(s) hold raw zero bytes, which the game shows as Bad Eggs. They count as empty here.`);

  const partyCount = () => {
    const n = u32le(img, blk(PARTY) + 4);
    return n > 6 ? 6 : n;
  };
  if (u32le(img, blk(PARTY) + 4) > 6) warnings.push("The party count is above 6; only 6 are read.");
  const partyOff = (i) => blk(PARTY) + 8 + i * pk5.PARTY_SIZE;
  const partySlot = (i) => img.slice(partyOff(i), partyOff(i) + pk5.PARTY_SIZE);

  /* Refusals shared by taking and putting (§11, §15.2). */
  function refuseUnsafe(f, verb) {
    if (!f.checksumOk || f.flags & 4) refuse("bad-egg", "This is a Bad Egg (its data is damaged). It cannot be moved.");
    // Header bits 0-1 tell the game the data is already decrypted, so it would read the stored
    // (encrypted) bytes as they are: a scrambled Pokémon. The game never saves them set (§8.1).
    if (f.flags & 3) refuse("bad-egg", "This Pokémon's data is marked in a way the game cannot read (its header flags are set). It cannot be moved.");
    if (f.species === 646 && f.form !== 0) {
      refuse("fused-kyurem", `Fused Kyurem cannot be ${verb}: the Reshiram or Zekrom it absorbed is stored in its save. Separate them with the DNA Splicers first.`);
    }
    if (pk5.isMailItem(f.heldItem)) refuse("mail", `Pokémon holding mail cannot be ${verb}. Take the mail off in the game first.`);
  }

  function takeFromBox(b, i) {
    checkBox(b, i);
    const o = slotOff(b, i);
    const stored = img.slice(o, o + pk5.RECORD_SIZE);
    if (pk5.isEmpty(stored)) refuse("empty-slot", `Box ${b + 1} slot ${i + 1} is empty.`);
    refuseUnsafe(pk5.parse(stored, meta), "deposited");
    img.set(pk5.emptyRecord(), o);
    touch(boxBlock(b));
    return { record: stored, meta: { ...meta } };
  }

  function takeFromParty(i) {
    const n = partyCount();
    if (!(Number.isInteger(i) && i >= 0 && i < n)) refuse("bad-slot", `There is no Pokémon in party slot ${i + 1}.`);
    const f = pk5.parse(partySlot(i), meta);
    if (pk5.isEmpty(partySlot(i))) refuse("empty-slot", `Party slot ${i + 1} is empty.`);
    refuseUnsafe(f, "deposited");
    // The PC's rule: at least one Pokémon that can battle (not an Egg, not fainted) must stay.
    const ready = (j) => { const g = pk5.parse(partySlot(j), meta); return g.checksumOk && g.species && !g.isEgg && g.party.hp > 0; };
    if (!Array.from({ length: n }, (_, j) => j).some((j) => j !== i && ready(j))) {
      refuse("last-pokemon", "This is your last Pokémon that can battle; the game needs at least one in the party.");
    }
    // Moving to a box restores PP (the PC does this); the party extension is dropped.
    const { party, ...box } = f;
    const record = pk5.build(pk5.restorePP(box), meta);
    for (let j = i; j < n - 1; j++) img.copyWithin(partyOff(j), partyOff(j + 1), partyOff(j + 1) + pk5.PARTY_SIZE);
    img.set(pk5.emptyPartySlot(), partyOff(n - 1));
    setU32le(img, blk(PARTY) + 4, n - 1);
    touch(PARTY);
    return { record, meta: { ...meta } };
  }

  /* The game's search (§15.3): the current box first, wrapping through the unlocked boxes, then
     the next locked ones, which unlock in steps of 8 as boxes fill. */
  function freeSlot(box) {
    if (box !== undefined) {
      for (let i = 0; i < BOX_SLOTS; i++) if (slotFree(box, i)) return [box, i];
      refuse("box-full", `Box ${box + 1} is full.`);
    }
    const open = Math.min(BOX_COUNT, Math.max(8, trayCount()));
    const order = [];
    for (let k = 0; k < open; k++) order.push((currentBox % open + k) % open);
    for (let b = open; b < BOX_COUNT; b++) order.push(b);
    for (const b of order) for (let i = 0; i < BOX_SLOTS; i++) if (slotFree(b, i)) return [b, i];
    return refuse("boxes-full", "Every box in this save is full.");
  }

  function putInBox(record, m, box, index) {
    if (m?.format && m.format !== pk5.FORMAT) refuse("wrong-format", `This Pokémon is stored as ${m.format}; it has to be converted for Generation 5 first.`);
    if (!(record instanceof Uint8Array) || (record.length !== pk5.RECORD_SIZE && record.length !== pk5.PARTY_SIZE)) {
      refuse("bad-record", "This is not a Generation 5 Pokémon record.");
    }
    const rec = pk5.boxPart(record);
    const f = pk5.parse(rec, meta);
    refuseUnsafe(f, "put in this save");
    const v = pk5.validate(rec, meta);
    if (!v.ok) refuse("invalid", `This Pokémon cannot go into a ${GAME_NAMES[L.name]} save: ${v.errors.join(" ")}`);
    if (f.heldItem > L.maxItem) refuse("item", `Its held item does not exist in ${GAME_NAMES[L.name]}. Remove the item first.`);
    if (box !== undefined) checkBox(box, index);
    let b, i;
    if (box !== undefined && index !== undefined) {
      if (!slotFree(box, index)) refuse("slot-taken", `Box ${box + 1} slot ${index + 1} is not empty.`);
      [b, i] = [box, index];
    } else [b, i] = freeSlot(box);
    img.set(pk5.build(pk5.restorePP(f), meta), slotOff(b, i));
    touch(boxBlock(b));
    // The game only lets boxes below the unlocked count hold Pokémon (§7.1).
    if (b >= trayCount()) { img[blk(BOX_MAIN) + 0x3dd] = Math.min(BOX_COUNT, (Math.floor(b / 8) + 1) * 8); touch(BOX_MAIN); }
    return { box: b, index: i };
  }

  /* ----- Pokédex (§7.5) ----- */
  const DX = blk(L.dexBlock), dexSize = L.blocks[L.dexBlock].size, F = L.formBytes;
  const CAUGHT = DX + 0x08, SEEN = (k) => DX + 0x5c + k * 0x54, SHOWN = (k) => DX + 0x1ac + k * 0x54;
  const SEEN_FORMS = (shiny) => DX + 0x2fc + (shiny ? F : 0), SHOWN_FORMS = (shiny) => DX + 0x2fc + 2 * F + (shiny ? F : 0);
  const LANG_BITS = DX + 0x2fc + 4 * F, SPINDA = DX + dexSize - 4;

  /** registerDex(species, { form, gender, shiny, lang, pid }): seen + caught, as the game's addPkmToDex does. */
  function registerDex(species, { form = 0, gender = null, shiny = false, lang: monLang, pid } = {}) {
    if (!(species >= 1 && species <= D.MAX_SPECIES[5])) return false;
    const i = species - 1;
    // Sex comes from the PID and gender ratio when known; genderless counts as male.
    const sex = pid != null ? pk5.pidGender(species, pid >>> 0) : gender === "F" || gender === 1 ? 1 : 0;
    const list = (sex === 1 ? 1 : 0) + (shiny ? 2 : 0);
    const fm = L.formMap.get(species);
    const formBit = fm ? fm.base + (form < fm.count ? form : 0) : -1;
    if (![0, 1, 2, 3].some((k) => getFlag(img, SEEN(k), i))) {
      for (let k = 0; k < 4; k++) setFlag(img, SHOWN(k), i, k === list);
      if (fm) {
        for (const s of [false, true]) for (let j = 0; j < fm.count; j++) setFlag(img, SHOWN_FORMS(s), fm.base + j, false);
        setFlag(img, SHOWN_FORMS(shiny), formBit);
      }
    }
    if (species === 327 && pid != null && u32le(img, SPINDA) === 0) setU32le(img, SPINDA, pid);
    setFlag(img, SEEN(list), i);
    if (fm) {
      if (ALL_FORM_BITS.has(species)) for (let j = 0; j < fm.count; j++) setFlag(img, SEEN_FORMS(shiny), fm.base + j);
      else setFlag(img, SEEN_FORMS(shiny), formBit);
    }
    const id = D.LANG_IDS[monLang ?? lang] ?? 0;
    if (species <= 493 && [1, 2, 3, 4, 5, 7, 8].includes(id)) setFlag(img, LANG_BITS, i * 7 + (id >= 7 ? id - 2 : id - 1));
    setFlag(img, CAUGHT, i);
    touch(L.dexBlock);
    return true;
  }

  function pokedex() {
    const seen = [], caught = [];
    for (let s = 1; s <= D.MAX_SPECIES[5]; s++) {
      if ([0, 1, 2, 3].some((k) => getFlag(img, SEEN(k), s - 1))) seen.push(s);
      if (getFlag(img, CAUGHT, s - 1)) caught.push(s);
    }
    return { seen, caught };
  }

  /* ----- write-back (§5.6) ----- */
  function serialize() {
    if (!dirty.size) return orig.slice();
    const w = img.slice();
    for (const i of dirty) {
      const { off, size } = L.blocks[i];
      const crc = crc16ccitt(w, off, size);
      setU16le(w, off + size, u16le(w, off + size) + 1);        // block save counter (wraps at 0xFFFF)
      setU16le(w, off + size + 2, crc);
      setU16le(w, L.table + 2 * i, crc);
    }
    setU32le(w, L.footer, (u32le(w, L.footer) + 1) >>> 0);       // global save counter
    setU16le(w, L.footer + 0xe, crc16ccitt(w, L.table, L.crcsSize));
    const out = orig.slice();
    out.set(w, 0);
    out.set(w, L.copySize);
    return out;
  }

  return {
    gen: 5, game, gameName: D.gameCodeName(5, game) ?? GAME_NAMES[L.name], format: pk5.FORMAT, lang, layout: L.name,
    trainer, boxCount: BOX_COUNT, boxCapacity: BOX_SLOTS, currentBox,
    get boxesUnlocked() { return trayCount(); },
    get modified() { return dirty.size > 0; },
    // One entry per counted slot, so party()[i] is what takeFromParty(i) takes (an empty slot inside
    // the count, possible only in a damaged save, shows as species 0 and cannot be taken).
    party() { return Array.from({ length: partyCount() }, (_, i) => entry(partySlot(i))); },
    box(b) {
      checkBox(b);
      return Array.from({ length: BOX_SLOTS }, (_, i) => {
        const o = slotOff(b, i);
        const stored = img.slice(o, o + pk5.RECORD_SIZE);
        return pk5.isEmpty(stored) ? null : entry(stored);
      });
    },
    boxName(b) { checkBox(b); return decode(img.subarray(blk(BOX_MAIN) + 4 + 0x28 * b, blk(BOX_MAIN) + 4 + 0x28 * (b + 1)), lang); },
    takeFromParty, takeFromBox, putInBox, registerDex, pokedex, serialize,
    warnings,
  };
}
