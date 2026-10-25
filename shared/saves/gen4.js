/* Gen 4 saves: Diamond, Pearl, Platinum, HeartGold, SoulSilver, and the Platinum PC port's save.bin.

   Spec: docs/research/format-gen4.md (its §22 verification notes win where they disagree with the
   earlier sections). The 512 KiB flash image holds two 256 KiB partitions; each holds a general block
   (trainer, party, Pokédex, ...) and a storage block (the PC), each closed by a footer with counters,
   size, signature, block id and a CRC-16/CCITT over the block (§3-§5).

   Which copy is current is decided exactly as the games decide it (§6): DP/Pt pick general and storage
   separately and link them by the saveCounter (they may sit in different partitions), HGSS picks one
   partition for both. We only write when the game would load the save cleanly (OK / IS_GOOD); a save
   the game would report as corrupted opens read-only.

   Writing (§7.3). Default "inPlace" (strategy A, what PKHeX does): edit the current copies in place and
   recompute the CRC of each changed block; counters, the other partition and the extra blocks (Hall of
   Fame, Battle Hall, videos) are never touched, so the game loads exactly the copies it loaded before.
   Option "newSave" (strategy B, what the game itself does on a full save): write both blocks, edited,
   into the partitions the game would write next, with the counters advanced (DP/Pt: saveCounter and
   each block's blockCounter + 1, both blocks even if one is unchanged, or the link check fails; HGSS:
   count + 1, both blocks into the other partition), so the pre-edit save stays as the backup copy.
   HGSS rewrites only the boxes flagged at storage+0x12004 on its next save, so every box we change is
   OR-ed into that mask under either strategy (§7.2). Vacated box slots get the canonical encrypted
   empty record (raw zeros read as Bad Eggs, §10.4); a vacated party slot gets the empty party record
   the game writes and the party list closes up (HGSS also shifts its aprijuice bytes, §11).

   The Platinum PC port (§17) builds the same save code natively for x86-64, where 64-bit members are
   8-aligned, so its blocks are larger (general 0xCF40, storage 0x121EC) and every offset after a
   GameTime or BoxPokemon moves. It is recognised by those footer sizes, never by file name or length,
   and read and written in its own layout (§17.1, computed from the port's headers, not yet checked
   against a real save.bin). Writes are allowed only when the layout checks out on the file itself
   (Pokédex magic, party header, box records); a DS save is never written in the port layout or vice
   versa. Padding and short files are container.js's business. */
import { u16le, u32le, setU32le, setU16le, crc16ccitt, FormatError } from "../bytes.js";
import * as P from "../pkm/pk4.js";
import * as T from "../text/gen4.js";
import * as D from "../data/index.js";
import { gen3Gender } from "../pkm/stats.js";

export const GEN = 4;
export const IMAGE_SIZE = 0x80000;
const PARTITION = 0x40000;
export const SIGNATURE = 0x20060623, SIGNATURE_KO = 0x20070903;
export const BOX_COUNT = 18, BOX_CAPACITY = 30;
const SLOT = 0x88, PARTY_SLOT = 0xec, NAME = 40, DEX_MAGIC = 0xbeefcafe;

/* Offsets: general block (trainer name, party count, Pokédex) and storage block (current box, first slot, box stride,
   names, wallpapers; HGSS box-modified mask). Party capacity sits 4 bytes before the count, the six 0xEC-byte party
   structs right after it. §9, §10.1, §17.1. */
export const LAYOUTS = {
  DP: { key: "DP", family: "DP", footer: 0x14, generalSize: 0xc100, storageStart: 0xc100, storageSize: 0x121e0,
    trainer: 0x64, party: 0x94, dex: 0x12dc, curBox: 0x00, boxes: 0x04, stride: 0xff0, names: 0x11ee4, wallpapers: 0x121b4 },
  Pt: { key: "Pt", family: "Pt", footer: 0x14, generalSize: 0xcf2c, storageStart: 0xcf2c, storageSize: 0x121e4,
    trainer: 0x68, party: 0x9c, dex: 0x1328, curBox: 0x00, boxes: 0x04, stride: 0xff0, names: 0x11ee4, wallpapers: 0x121b4 },
  HGSS: { key: "HGSS", family: "HGSS", footer: 0x10, generalSize: 0xf628, storageStart: 0xf700, storageSize: 0x12310,
    trainer: 0x64, party: 0x94, dex: 0x12b8, aprijuice: 0x620, curBox: 0x12000, modified: 0x12004, boxes: 0x00, stride: 0x1000,
    names: 0x12008, wallpapers: 0x122d8 },
  PtPort: { key: "PtPort", family: "Pt", port: true, footer: 0x14, generalSize: 0xcf40, storageStart: 0xcf40, storageSize: 0x121ec,
    trainer: 0x74, party: 0xa8, dex: 0x1334, curBox: 0x00, boxes: 0x08, stride: 0xff0, names: 0x11ee8, wallpapers: 0x121b8 },
};

/* ---------- footers and copy selection (§5, §6) ---------- */

function readBlock(img, L, part, kind) {
  const start = part * PARTITION + (kind ? L.storageStart : 0), size = kind ? L.storageSize : L.generalSize, end = start + size;
  const sig = u32le(img, end - 8);
  const idOk = L.footer === 0x10 ? u16le(img, end - 4) === kind : img[end - 4] === kind;
  // Cheap header checks first: the container's window search calls detect() on many offsets.
  const valid = u32le(img, end - 0x0c) === size && idOk && (sig === SIGNATURE || sig === SIGNATURE_KO) &&
    crc16ccitt(img, start, size - L.footer) === u16le(img, end - 2);
  return L.footer === 0x10
    ? { part, start, size, end, valid, sig, count: u32le(img, end - 0x10) }
    : { part, start, size, end, valid, sig, saveCounter: u32le(img, end - 0x14), blockCounter: u32le(img, end - 0x10) };
}

/** Counter comparison of all three games: only the pair (0xFFFFFFFF, 0) wraps. */
function cmp(a, b) {
  if (a === 0xffffffff && b === 0) return -1;
  if (a === 0 && b === 0xffffffff) return 1;
  return a > b ? 1 : a < b ? -1 : 0;
}

/* DP/Pt SaveData_LoadCheck. g/s: [A, B] infos with `valid` already restricted to one signature. */
function loadCheckDPPt(g, s) {
  const sectors = (x) => {
    if (x[0].valid && x[1].valid) {
      const gc = cmp(x[0].saveCounter, x[1].saveCounter), bc = cmp(x[0].blockCounter, x[1].blockCounter);
      const cur = gc > 0 ? 0 : gc < 0 ? 1 : bc > 0 ? 0 : bc < 0 ? 1 : 0;
      return { n: 2, cur, stale: 1 - cur };
    }
    if (x[0].valid || x[1].valid) return { n: 1, cur: x[0].valid ? 0 : 1, stale: null };
    return { n: 0, cur: null, stale: null };
  };
  const n = sectors(g), b = sectors(s);
  const sc = (x, i) => x[i].saveCounter;
  const res = (status, gen, sto) => ({ status, gen, sto });
  if (!n.n && !b.n) return res("EMPTY", null, null);
  if (!n.n || !b.n) return res("ERROR", null, null);
  if (n.n === 2 && b.n === 2) return sc(g, n.cur) === sc(s, b.cur) ? res("OK", n.cur, b.cur) : res("CORRUPT", n.stale, b.cur);
  if (n.n === 1 && b.n === 2) {
    if (sc(g, n.cur) === sc(s, b.cur)) return res("CORRUPT", n.cur, b.cur);
    if (sc(g, n.cur) === sc(s, b.stale)) return res("CORRUPT", n.cur, b.stale);
    return res("ERROR", null, null);
  }
  if (n.n === 2 && b.n === 1) return sc(g, n.cur) === sc(s, b.cur) ? res("OK", n.cur, b.cur) : res("CORRUPT", n.stale, b.cur);
  return res(n.cur === b.cur ? "OK" : "CORRUPT", n.cur, b.cur);
}

/* HGSS Save_GetSaveFilesStatus: an invalid block counts as count 0; both blocks load from one partition. */
function loadCheckHGSS(m, s) {
  const count = (x, i) => (x[i].valid ? x[i].count : 0);
  const slots = (x) => {
    if (x[0].valid && x[1].valid) { const newer = cmp(x[0].count, x[1].count) < 0 ? 1 : 0; return { n: 2, newer, older: 1 - newer }; }
    if (x[0].valid || x[1].valid) return { n: 1, newer: x[0].valid ? 0 : 1, older: null };
    return { n: 0, newer: null, older: null };
  };
  const a = slots(m), b = slots(s);
  const res = (status, part) => ({ status, gen: part, sto: part });
  const match = (i) => count(m, i) === count(s, i);
  if (!a.n && !b.n) return res("NOT_EXIST", null);
  if (!a.n || !b.n) return res("TOTAL_FAIL", null);
  if (a.n === 2 && b.n === 2) return match(a.newer) ? res("IS_GOOD", a.newer) : match(a.older) ? res("SLOT_FAIL", a.older) : res("TOTAL_FAIL", null);
  if (a.n === 1 && b.n === 2) return match(a.newer) ? res("SLOT_FAIL", a.newer) : res("TOTAL_FAIL", null);
  if (a.n === 2 && b.n === 1) return match(a.newer) ? res("IS_GOOD", a.newer) : match(a.older) ? res("SLOT_FAIL", a.older) : res("TOTAL_FAIL", null);
  return a.newer === b.newer ? res("IS_GOOD", a.newer) : res("TOTAL_FAIL", null);
}

const RANK = { OK: 3, IS_GOOD: 3, CORRUPT: 2, SLOT_FAIL: 2, ERROR: 1, TOTAL_FAIL: 1, EMPTY: 0, NOT_EXIST: 0 };

/** Runs the game's selection for one layout. A game accepts only its own signature (INT/JP or Korean), so each is
    tried on its own and the better outcome wins. -> { status, gen, sto, signature, blocks, validBlocks } */
function select(img, L) {
  const raw = [0, 1].map((k) => [0, 1].map((p) => readBlock(img, L, p, k)));   // raw[kind][part]
  const validBlocks = raw.flat().filter((x) => x.valid).length;
  let best = null;
  for (const sig of [SIGNATURE, SIGNATURE_KO]) {
    const v = raw.map((pair) => pair.map((x) => ({ ...x, valid: x.valid && x.sig === sig })));
    const r = L.footer === 0x10 ? loadCheckHGSS(v[0], v[1]) : loadCheckDPPt(v[0], v[1]);
    const n = v.flat().filter((x) => x.valid).length;
    if (!best || RANK[r.status] > RANK[best.status] || (RANK[r.status] === RANK[best.status] && n > best.n)) best = { ...r, signature: sig, blocks: v, n };
  }
  return { ...best, validBlocks };
}

const usable = (status) => RANK[status] >= 2;
const clean = (status) => RANK[status] === 3;

/* ---------- detection ---------- */

const trainerAt = (L, sel) => sel.gen * PARTITION + L.trainer;

/** Diamond/Pearl (and HGSS saves whose version byte is unset) store no version: vote with the origin game of the
    trainer's own Pokémon (OT name, TID and SID match), party first, then the boxes (§8). */
function versionVote(img, L, sel, lang) {
  const t = trainerAt(L, sel), tid = u16le(img, t + 0x10), sid = u16le(img, t + 0x12);
  const name = T.decode(img.subarray(t, t + 16), lang);
  const votes = new Map();
  const consider = (stored) => {
    const f = P.parse(stored.slice(0, SLOT), { lang });
    if (f.checksumOk && f.species && !f.isEgg && f.tid === tid && f.sid === sid && f.otName === name) votes.set(f.version, (votes.get(f.version) || 0) + 1);
  };
  const pc = sel.gen * PARTITION + L.party, count = Math.min(6, u32le(img, pc));
  for (let i = 0; i < count; i++) consider(img.subarray(pc + 4 + i * PARTY_SLOT, pc + 4 + (i + 1) * PARTY_SLOT));
  if (!votes.size && sel.sto != null) {
    const base = sel.sto * PARTITION + L.storageStart + L.boxes;
    for (let b = 0; b < BOX_COUNT; b++) for (let s = 0; s < BOX_CAPACITY; s++) {
      const o = base + b * L.stride + s * SLOT;
      if (P.decryptedSpecies(img.subarray(o, o + SLOT))) consider(img.subarray(o, o + SLOT));
    }
  }
  return votes;
}

function gameOf(img, L, sel, lang) {
  if (L.family === "Pt") return "Pt";
  if (sel.gen == null) return L.family;
  const code = img[trainerAt(L, sel) + 0x1c];
  if (L.family === "HGSS" && (code === 7 || code === 8)) return code === 7 ? "HG" : "SS";
  const [x, y] = L.family === "DP" ? [10, 11] : [7, 8];
  const v = versionVote(img, L, sel, lang), nx = v.get(x) || 0, ny = v.get(y) || 0;
  const codes = L.family === "DP" ? ["D", "P"] : ["HG", "SS"];
  return nx > ny ? codes[0] : ny > nx ? codes[1] : L.family;
}

function langOf(img, L, sel) {
  const id = sel.gen == null ? 0 : img[trainerAt(L, sel) + 0x19];
  return D.langFromId(id) ?? (sel.signature === SIGNATURE_KO ? "ko" : null);
}

/** image (0x80000 bytes, unwrapped) -> { gen, game, lang, confidence, layout, status, port } | null. Never throws. */
export function detect(image) {
  try {
    if (!(image instanceof Uint8Array) || image.length !== IMAGE_SIZE) return null;
    let best = null;
    for (const L of Object.values(LAYOUTS)) {
      const sel = select(image, L);
      if (!sel.validBlocks) continue;
      const lang = usable(sel.status) ? langOf(image, L, sel) : null;
      let confidence = clean(sel.status) ? 0.98 : usable(sel.status) ? 0.8 : 0.5;
      if (usable(sel.status) && !lang) confidence -= 0.1;
      if (best && best.confidence >= confidence) continue;
      best = { gen: GEN, game: usable(sel.status) ? gameOf(image, L, sel, lang ?? "en") : L.family, lang: lang ?? (sel.signature === SIGNATURE_KO ? "ko" : "en"),
        confidence, layout: L.key, status: sel.status, port: !!L.port };
    }
    return best;
  } catch {
    return null;
  }
}

/* ---------- open ---------- */

const NAMES = { DP: "Diamond/Pearl", Pt: "Platinum", HGSS: "HeartGold/SoulSilver" };
const MSG = {
  empty: "This save file holds no saved game yet. Start the game, save once from the menu, close the emulator and upload the file again.",
  broken: "This save file is damaged: no copy of the save passes the game's own checks, so the game would not load it either.",
  corrupt: "The game would report this save as corrupted and load its backup copy instead. Load it in the game, save once from " +
    "the menu, close the emulator and upload the new file before moving Pokémon. Until then it is read-only.",
  port: "This save comes from the Pokémon Platinum PC port. Its layout was worked out from the port's source code but has not " +
    "been checked against a real save.bin yet: keep a copy of your original file.",
  portBad: "This looks like a Pokémon Platinum PC port save, but its contents do not match the expected layout, so it is read-only.",
  portName: "This file is named like the Platinum PC port's save.bin but holds a DS-layout save, which the port cannot read. " +
    "It is treated as an emulator save.",
  ko: "Korean Generation 4 saves are supported on a best-effort basis (not yet tested with a real Korean game): keep a copy of your original file.",
  dp: "Diamond and Pearl saves look the same; this one is shown as Diamond/Pearl.",
};

/** open(image, detection?, { writeStrategy: "inPlace" | "newSave", container }) -> SaveFile. `container` (or
    detection.container) is container.js's info for the file, used only for warnings. Throws FormatError when the game
    itself would not load the save. */
export function open(image, detection, opts = {}) {
  if (!(image instanceof Uint8Array) || image.length !== IMAGE_SIZE) throw new FormatError("A Generation 4 save is 512 KiB.");
  const det = detection?.layout && LAYOUTS[detection.layout] ? detection : detect(image);
  if (!det) throw new FormatError("This is not a Pokémon Diamond, Pearl, Platinum, HeartGold or SoulSilver save.");
  const L = LAYOUTS[det.layout];
  const orig = image.slice(), img = image.slice();
  const sel = select(img, L);
  if (!usable(sel.status)) throw new FormatError(RANK[sel.status] === 0 ? MSG.empty : MSG.broken, { code: sel.status });
  const warnings = [];
  let readOnly = null;
  const lock = (why) => { readOnly ||= why; if (!warnings.includes(why)) warnings.push(why); };
  if (!clean(sel.status)) lock(MSG.corrupt);
  const gBlk = sel.blocks[0][sel.gen], sBlk = sel.blocks[1][sel.sto];
  if (!gBlk.valid || !sBlk.valid) lock(MSG.corrupt);   // only reachable through the games' count-0 quirk
  const G = gBlk.start, S = sBlk.start;
  const lang = langOf(img, L, sel) ?? det.lang ?? "en";
  const game = det.game && P.gameFamily(det.game) === L.family ? det.game : gameOf(img, L, sel, lang);
  const meta = { format: P.FORMAT, lang, game };
  let strategy = opts.writeStrategy === "newSave" ? "newSave" : "inPlace";

  const t = G + L.trainer, pc = G + L.party;
  const partyCount = () => u32le(img, pc);
  const partyOff = (i) => pc + 4 + i * PARTY_SLOT;
  const slotOff = (b, s) => S + L.boxes + b * L.stride + s * SLOT;
  const dex = G + L.dex;
  const dirty = { general: false, boxes: new Set(), storage: false };

  if (lang === "ko" || sel.signature === SIGNATURE_KO) warnings.push(MSG.ko);
  if (L.family === "DP" && game === "DP") warnings.push(MSG.dp);
  const container = opts.container ?? det.container;
  if (container?.nameHints?.saveBin && !L.port) warnings.push(MSG.portName);
  if (u32le(img, S + L.curBox) >= BOX_COUNT) warnings.push("The current-box number is out of range; box 1 is shown as current.");
  if (partyCount() > 6) lock("The party data is damaged (more than six Pokémon), so this save is read-only.");
  if (u32le(img, dex) !== DEX_MAGIC) warnings.push("The Pokédex data does not start with its marker; Pokédex registration is disabled.");

  // Bad Eggs and raw-zero empties (§10.4): reported; raw zeros are repaired in boxes we write anyway.
  const badEggs = [], rawEmpty = [];
  let garbage = 0;
  for (let b = 0; b < BOX_COUNT; b++) for (let s = 0; s < BOX_CAPACITY; s++) {
    const r = img.subarray(slotOff(b, s), slotOff(b, s) + SLOT);
    if (P.checksumValid(r)) continue;
    if (P.decryptedSpecies(r)) { badEggs.push(`box ${b + 1} slot ${s + 1}`); garbage++; } else rawEmpty.push([b, s]);
  }
  if (badEggs.length) warnings.push(`Corrupted data (Bad Egg) in ${badEggs.join(", ")}; those slots cannot be moved.`);
  if (rawEmpty.length) warnings.push(`${rawEmpty.length} empty box slot(s) hold raw zeros instead of the game's empty record; boxes we change are repaired.`);
  if (L.port) {
    warnings.push(MSG.port);
    const count = partyCount();
    const partyOk = count >= 1 && count <= 6 && u32le(img, pc - 4) === 6 &&
      Array.from({ length: count }, (_, i) => P.checksumValid(img.subarray(partyOff(i), partyOff(i) + PARTY_SLOT))).every(Boolean);
    if (u32le(img, dex) !== DEX_MAGIC || !partyOk || garbage > 2) lock(MSG.portBad);
  }

  const assertWritable = () => { if (readOnly) throw new FormatError(readOnly); };
  const entry = (stored) => {
    const f = P.parse(stored, meta);
    return { record: stored.slice(0, SLOT), meta: { ...meta }, view: P.toView(f, meta) };
  };
  const checkBox = (b, s) => {
    if (!(Number.isInteger(b) && b >= 0 && b < BOX_COUNT)) throw new FormatError(`There is no box ${b + 1}; boxes are numbered 1-${BOX_COUNT}.`);
    if (s != null && !(Number.isInteger(s) && s >= 0 && s < BOX_CAPACITY)) throw new FormatError(`There is no slot ${s + 1}; a box has ${BOX_CAPACITY} slots.`);
  };
  const isFree = (b, s) => P.decryptedSpecies(img.subarray(slotOff(b, s), slotOff(b, s) + SLOT)) === 0;
  const label = (f) => (f.isNicknamed ? f.nickname : D.speciesName(f.species)) || "This Pokémon";

  const save = {
    gen: GEN, game, gameName: D.gameCodeName(4, game) ?? NAMES[L.family], format: P.FORMAT, lang,
    layout: L.key, port: !!L.port, loadStatus: sel.status, signature: sel.signature, warnings,
    copies: { general: sel.gen, storage: sel.sto },   // partitions (0 = A at 0, 1 = B at 0x40000) the game loads
    get readOnly() { return readOnly; },
    get writeStrategy() { return strategy; },
    set writeStrategy(v) { if (v !== "inPlace" && v !== "newSave") throw new FormatError(`Unknown write strategy "${v}".`); strategy = v; },
    trainer: {
      name: T.decode(img.subarray(t, t + 16), lang), gender: img[t + 0x18] ? "F" : "M",
      tid: u16le(img, t + 0x10), sid: u16le(img, t + 0x12), money: u32le(img, t + 0x14),
      playTime: { h: u16le(img, t + 0x22), m: img[t + 0x24], s: img[t + 0x25] },
      badges: img[t + 0x1a] | (L.family === "HGSS" ? img[t + 0x1f] << 8 : 0),
    },
    boxCount: BOX_COUNT, boxCapacity: BOX_CAPACITY,
    get currentBox() { const c = u32le(img, S + L.curBox); return c < BOX_COUNT ? c : 0; },

    party() {
      const n = Math.min(6, partyCount());
      return Array.from({ length: n }, (_, i) => entry(img.slice(partyOff(i), partyOff(i) + PARTY_SLOT)));
    },
    box(b) {
      checkBox(b);
      return Array.from({ length: BOX_CAPACITY }, (_, s) => {
        const r = img.slice(slotOff(b, s), slotOff(b, s) + SLOT);
        return P.decryptedSpecies(r) ? entry(r) : null;
      });
    },
    boxName(b) {
      checkBox(b);
      const o = S + L.names + b * NAME;
      return T.decode(img.subarray(o, o + NAME), lang);
    },
    /** -> { seen: [species], caught: [species] } (National Dex numbers). */
    pokedex() {
      const list = (o) => { const out = []; for (let sp = 1; sp <= D.MAX_SPECIES[4]; sp++) if ((img[o + ((sp - 1) >> 3)] >> ((sp - 1) & 7)) & 1) out.push(sp); return out; };
      return { seen: list(dex + 0x44), caught: list(dex + 0x04) };
    },

    takeFromParty(index) {
      assertWritable();
      const n = partyCount();
      if (!(Number.isInteger(index) && index >= 0 && index < n)) throw new FormatError(`There is no Pokémon in party slot ${index + 1}.`);
      const stored = img.slice(partyOff(index), partyOff(index) + PARTY_SLOT);
      const f = P.parse(stored, meta);
      if (!f.checksumOk) throw new FormatError("That party slot holds corrupted data (a Bad Egg) and cannot be moved.");
      const others = Array.from({ length: n }, (_, i) => i).filter((i) => i !== index).some((i) => {
        const g = P.parse(img.slice(partyOff(i), partyOff(i) + PARTY_SLOT), meta);
        return g.checksumOk && !g.isEgg;
      });
      if (!others) throw new FormatError("You have to keep at least one Pokémon that is not an Egg in your party.");
      if (f.heldItem >= 137 && f.heldItem <= 148) throw new FormatError(`${label(f)} is holding mail. Take the mail off in the game first; mail cannot be stored.`);
      for (let i = index; i < n - 1; i++) {
        img.copyWithin(partyOff(i), partyOff(i + 1), partyOff(i + 2));
        if (L.aprijuice) img.copyWithin(G + L.aprijuice + 5 * i, G + L.aprijuice + 5 * (i + 1), G + L.aprijuice + 5 * (i + 2));
      }
      img.set(P.emptyPartyRecord(), partyOff(n - 1));
      if (L.aprijuice) img.fill(0, G + L.aprijuice + 5 * (n - 1), G + L.aprijuice + 5 * n);
      setU32le(img, pc, n - 1);
      dirty.general = true;
      return { record: stored.slice(0, SLOT), meta: { ...meta } };
    },

    takeFromBox(b, s) {
      assertWritable();
      checkBox(b, s);
      if (s == null) throw new FormatError("Choose a box slot.");
      const o = slotOff(b, s), stored = img.slice(o, o + SLOT);
      if (!P.decryptedSpecies(stored)) throw new FormatError(`Box ${b + 1} slot ${s + 1} is empty.`);
      if (!P.checksumValid(stored)) throw new FormatError(`Box ${b + 1} slot ${s + 1} holds corrupted data (a Bad Egg) and cannot be moved.`);
      img.set(P.emptyRecord(), o);
      dirty.boxes.add(b);
      return { record: stored, meta: { ...meta } };
    },

    putInBox(record, recMeta, b, s) {
      assertWritable();
      if (recMeta?.format && recMeta.format !== P.FORMAT) throw new FormatError(`This Pokémon is stored as ${recMeta.format}; convert it to the Generation 4 format first.`);
      if (!(record instanceof Uint8Array) || (record.length !== SLOT && record.length !== PARTY_SLOT)) throw new FormatError("That is not a Generation 4 Pokémon record.");
      const { fields, notes } = P.prepareForBox(P.parse(record.slice(0, SLOT), recMeta ?? meta), game);
      let box = b, index = s;
      if (box != null) checkBox(box, index);
      if (box != null && index != null) {
        if (!isFree(box, index)) throw new FormatError(`Box ${box + 1} slot ${index + 1} is not empty.`);
      } else {
        const boxes = box != null ? [box] : Array.from({ length: BOX_COUNT }, (_, i) => i);
        found: for (const x of boxes) for (let y = 0; y < BOX_CAPACITY; y++) if (isFree(x, y)) { box = x; index = y; break found; }
        if (index == null) throw new FormatError(box != null ? `Box ${box + 1} is full.` : "All boxes are full.");
      }
      img.set(P.build(fields, recMeta ?? meta), slotOff(box, index));
      dirty.boxes.add(box);
      return { box, index, notes };
    },

    /** Marks a species seen and caught the way Pokedex_Capture / Pokedex_SetMonCaughtFlag do (§15.3). opts.pid sets
        Spinda's spot pattern on first sight and the gender when `gender` is omitted. -> true when registered. */
    registerDex(species, { form = 0, gender, lang: monLang, pid, isEgg = false } = {}) {
      assertWritable();
      if (isEgg || !(species >= 1 && species <= D.MAX_SPECIES[4])) return false;
      if (u32le(img, dex) !== DEX_MAGIC) throw new FormatError("This save's Pokédex data is damaged, so it cannot be updated.");
      // Without a gender, the PID decides; without either, only single-gender species have a known one.
      const fixed = { 0: "M", 254: "F" }[D.genderThreshold(species)] ?? null;
      registerDex(img, dex, L.family, species, {
        form, gender: gender !== undefined ? gender : pid != null ? gen3Gender(species, pid) : fixed,
        langByte: D.LANG_IDS[monLang ?? lang] ?? 0, gameLangByte: img[t + 0x19], pid,
      });
      dirty.general = true;
      return true;
    },

    /** -> the raw 512 KiB image with every checksum fixed. opts.strategy overrides the save's writeStrategy. */
    serialize({ strategy: how = strategy } = {}) {
      if (!dirty.general && !dirty.boxes.size) return orig.slice();
      for (const [x, y] of rawEmpty) {
        const r = img.subarray(slotOff(x, y), slotOff(x, y) + SLOT);
        if (dirty.boxes.has(x) && P.decryptedSpecies(r) === 0 && !P.checksumValid(r)) img.set(P.emptyRecord(), slotOff(x, y));
      }
      if (dirty.boxes.size) dirty.storage = true;
      const mask = [...dirty.boxes].reduce((m, x) => m | (1 << x), 0);
      if (L.modified && mask) setU32le(img, S + L.modified, (u32le(img, S + L.modified) | mask) >>> 0);
      const out = how === "newSave" ? writeNewSave(orig, img, L, sel) : writeInPlace(img, L, G, S, dirty);
      checkWritten(out, L, sel, how);
      return out;
    },
  };
  return save;
}

/* ---------- writing ---------- */

const fixCrc = (out, start, size, footer) => setU16le(out, start + size - 2, crc16ccitt(out, start, size - footer));

/* Strategy A: the current copies already hold the edits; refresh the CRC of each changed block. */
function writeInPlace(img, L, G, S, dirty) {
  const out = img.slice();
  if (dirty.general) fixCrc(out, G, L.generalSize, L.footer);
  if (dirty.storage) fixCrc(out, S, L.storageSize, L.footer);
  return out;
}

/* Strategy B: the edited current blocks go where the game's next save would put them, on top of the untouched
   original, with the counters the game would write. Both blocks are written even when only one changed. */
function writeNewSave(orig, img, L, sel) {
  const out = orig.slice();
  const g = sel.blocks[0][sel.gen], s = sel.blocks[1][sel.sto];
  const put = (blk, kind, part) => {
    const dst = part * PARTITION + (kind ? L.storageStart : 0);
    out.set(img.subarray(blk.start, blk.start + blk.size), dst);
    return dst;
  };
  const next = (v) => (v + 1) >>> 0;
  if (L.footer === 0x10) {
    const part = 1 - sel.gen, count = next(g.count);
    for (const [blk, kind] of [[g, 0], [s, 1]]) {
      const dst = put(blk, kind, part);
      setU32le(out, dst + blk.size - 0x10, count);
      fixCrc(out, dst, blk.size, L.footer);
    }
  } else {
    // The game writes its general block's saveCounter + 1. The two current copies carry the same value unless the
    // load took the PARTIAL/PARTIAL path, which does not check the link; then the newer value + 1 still beats both.
    const global = next(cmp(g.saveCounter, s.saveCounter) >= 0 ? g.saveCounter : s.saveCounter);
    for (const [blk, kind, part] of [[g, 0, 1 - sel.gen], [s, 1, 1 - sel.sto]]) {
      const dst = put(blk, kind, part);
      setU32le(out, dst + blk.size - 0x14, global);
      setU32le(out, dst + blk.size - 0x10, next(blk.blockCounter));
      fixCrc(out, dst, blk.size, L.footer);
    }
  }
  return out;
}

/* Safety net: run the game's selection on what we are about to hand back. It must load cleanly, with the same
   signature, exactly the copies we meant (the edited ones in place, or the freshly written ones for newSave);
   otherwise the player would get a "corrupted" message or lose the edit, so nothing is returned. */
function checkWritten(out, L, sel, how) {
  const after = select(out, L);
  const want = how === "newSave" ? { gen: 1 - sel.gen, sto: L.footer === 0x10 ? 1 - sel.gen : 1 - sel.sto } : { gen: sel.gen, sto: sel.sto };
  const ok = clean(after.status) && after.signature === sel.signature && after.gen === want.gen && after.sto === want.sto &&
    after.blocks[0][want.gen].valid && after.blocks[1][want.sto].valid;
  if (!ok) {
    throw new FormatError("The changed save did not pass a final check (the game would not load it cleanly), so it was not " +
      "written. Your original file is unchanged." + (how === "newSave" ? " Saving in place may still work." : ""));
  }
}

/* ---------- Pokédex (§15) ---------- */

const MEISTER = [23, 25, 54, 77, 120, 129, 202, 214, 215, 216, 228, 278, 287, 315];   // DP language entries
const DEX_LANGS = [1, 2, 3, 5, 4, 7];   // language bit order: JPN, ENG, FRE, GER, ITA, SPA (Korean has none)
const TAIL = {   // offsets inside the Pokédex block that differ per game
  DP: { lang: null, rotom: null, shaymin: null, giratina: null, pichu: null, unownCaught: null, intl: null },
  Pt: { lang: 0x128, rotom: 0x31c, shaymin: 0x320, giratina: 0x321, pichu: null, unownCaught: null, intl: null },
  HGSS: { lang: 0x144, rotom: 0x338, shaymin: 0x33c, giratina: 0x33d, pichu: 0x33e, unownCaught: 0x128, intl: 0x335 },
};

/* Bit i of a flag array, numbered from 1 like the games (species 1 = bit 0). */
const getBit1 = (img, o, n) => (img[o + ((n - 1) >> 3)] >> ((n - 1) & 7)) & 1;
function setBit1(img, o, n, v) {
  const i = o + ((n - 1) >> 3), m = 1 << ((n - 1) & 7);
  img[i] = v ? img[i] | m : img[i] & ~m;
}

/** The game's Pokédex update for one Pokémon (DP Pokedex_SetMonCaughtFlag, Pt Pokedex_Capture, HGSS
    Pokedex_SetMonCaughtFlag). gender 0 male, 1 female, 2 genderless (stored as male). Exported for tests. */
export function registerDex(img, dex, family, species, { form = 0, gender = null, langByte = 0, gameLangByte = 0, pid } = {}) {
  const tail = TAIL[family];
  const g = gender === "F" || gender === 1 ? 1 : gender === "M" || gender === 0 ? 0 : 2;
  const seen = (sp) => getBit1(img, dex + 0x44, sp) === 1;
  if (!seen(species)) {
    if (species === 327 && pid != null) setU32le(img, dex + 0x104, pid);
    setBit1(img, dex + 0xc4, species, g === 2 ? 0 : g);   // second gender
    setBit1(img, dex + 0x84, species, g === 2 ? 0 : g);   // first gender
  } else if (getBit1(img, dex + 0x84, species) !== g) {
    setBit1(img, dex + 0xc4, species, g === 2 ? 0 : g);
  }
  // Form tracking runs before the seen bit is set: the 2-form, 3-form and Rotom counts read 0 while it is clear.
  const appendList = (o) => {
    const list = img.subarray(o, o + 28);
    if (list.includes(form)) return;
    const free = list.indexOf(0xff);
    if (free >= 0) list[free] = form;
  };
  const twoForms = (o, value) => {
    const n = !seen(species) ? 0 : getBit1(img, o, 1) === getBit1(img, o, 2) ? 1 : 2;
    for (let i = 0; i < n; i++) if (getBit1(img, o, i + 1) === value) return;
    if (n < 2) { setBit1(img, o, n + 1, value); if (n === 0) setBit1(img, o, 2, value); }
  };
  const threeForms = (o, value) => {
    const slot = (i) => (img[o] >> (2 * i)) & 3;
    if (!seen(species)) { img[o] = (img[o] & ~3) | value; return; }
    let n = 0;
    while (n < 3 && slot(n) !== 3) n++;
    for (let i = 0; i < 3; i++) if (slot(i) === value) return;
    if (n < 3) img[o] = (img[o] & ~(3 << (2 * n))) | (value << (2 * n));
  };
  if (species === 201) {
    appendList(dex + 0x10c);
  } else if (species === 412 || species === 413) {
    threeForms(dex + (species === 412 ? 0x10a : 0x10b), form & 3);
  } else if (species === 422 || species === 423) {
    twoForms(dex + (species === 422 ? 0x108 : 0x109), form & 1);
  } else if (species === 386) {
    // Four 4-bit slots in the top bytes of caught word 15 (slots 0-1) and seen word 15 (slots 2-3); 0xF = empty.
    const at = (i) => dex + (i < 2 ? 0x43 : 0x83), shift = (i) => 4 * (i & 1);
    const get = (i) => (img[at(i)] >> shift(i)) & 15;
    let n = 0;
    while (n < 4 && get(n) !== 15) n++;
    if (![0, 1, 2, 3].some((i) => get(i) === form) && n < 4) img[at(n)] = (img[at(n)] & ~(15 << shift(n))) | ((form & 15) << shift(n));
  } else if ((species === 492 || species === 487) && tail.shaymin != null) {
    twoForms(dex + (species === 492 ? tail.shaymin : tail.giratina), form & 1);
  } else if (species === 479 && tail.rotom != null) {
    const o = dex + tail.rotom, word = () => u32le(img, o), slot = (i) => (word() >>> (3 * i)) & 7;
    let n = 0;
    if (seen(species)) while (n < 6 && slot(n) !== 7) n++;
    if (!(seen(species) && Array.from({ length: n }, (_, i) => slot(i)).includes(form)) && n < 6) {
      setU32le(img, o, ((word() & ~(7 << (3 * n))) | ((form & 7) << (3 * n))) >>> 0);
    }
  } else if (species === 172 && tail.pichu != null) {
    threeForms(dex + tail.pichu, form ? 2 : g === 0 ? 0 : 1);
  }
  if (species === 201 && tail.unownCaught != null) appendList(dex + tail.unownCaught);
  // Language: one bit per language, Korean none. DP keeps it only for 14 "meister" species.
  const bit = DEX_LANGS.indexOf(langByte);
  if (bit >= 0) {
    if (tail.lang != null) img[dex + tail.lang + species] |= 1 << bit;
    else if (MEISTER.includes(species)) img[dex + 0x129 + MEISTER.indexOf(species)] |= 1 << bit;
  }
  if (tail.intl != null && langByte !== gameLangByte) img[dex + tail.intl] = 1;
  setBit1(img, dex + 0x04, species, 1);
  setBit1(img, dex + 0x44, species, 1);
}
