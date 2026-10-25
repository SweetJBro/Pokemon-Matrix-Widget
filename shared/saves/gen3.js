/* Gen 3 saves: Ruby, Sapphire, Emerald, FireRed, LeafGreen (docs/research/format-gen3.md).

   The 128 KiB flash holds two save slots of 14 sectors (0x1000 bytes: 0xF80 of data, a footer with
   section id, checksum, signature 0x08012025 and save counter). Each slot is one complete save, its
   sections rotated to spread flash wear: id 0 is SaveBlock2 (trainer, Pokédex), ids 1-4 SaveBlock1
   (party, bag, flags, the two extra Pokédex "seen" copies), ids 5-13 the PC. Sectors 28-31 (Hall of
   Fame, Trainer Hill / Trainer Tower, Recorded Battle) belong to neither slot and are never touched.

   Reading follows the game exactly (§3.5): a slot counts only when all 14 sections have a valid
   signature and a checksum over that game's section size; of two good slots the larger counter c
   wins (0 beats 0xFFFFFFFF), and the game then loads slot c % 2. Writing follows PKHeX's in-place
   strategy (§3.6): only the sectors whose data we changed are rewritten, in the slot the game
   loads, keeping their position, id, signature and counter; their padding is zeroed and their
   checksum recomputed over the game's size. The other slot, the extra sectors and every byte we
   did not mean to change stay as they were. The older slot therefore still holds Pokémon that were
   just taken out; that cannot be helped at the file level (§13.12) and the server's clone check
   handles it.

   Guards (§12): saves the game would not load as we read them (a damaged slot, a slot order the
   game reads differently from tools, an unrecognised layout, a 64 KiB half image) open read-only.
   The party is only edited by removing a Pokémon, never while Emerald's Battle Frontier or the
   Ruby/Sapphire Battle Tower has a challenge saved (both keep indices into the party), and never
   for a Pokémon holding mail. Pokémon only go into empty PC slots. The Pokédex is updated only when
   its three "seen" copies agree, as the games compare them (RS/E even erase a disagreeing bit).

   PC ports: 64-bit builds of the NTx86 pokeemerald-sdl2pc port wrote SaveBlock1 in their own memory
   layout, which moves everything after SaveBlock1 0xC70 (flags, vars, the second seen copy) and
   shrinks the last SaveBlock1 section (§2.3, ports-and-emulators.md §3.4). Their sign is an
   all-zero tail where a real Emerald save keeps the Union Room phrases (SaveBlock1 0x3C88). Tool-made
   saves (PKHeX) also leave it zero, so a consistent, non-empty Pokédex at the GBA offsets clears the
   suspicion. Otherwise the save opens restricted: box edits and party removals (all inside the PC
   sections or below 0xC70) work, the Pokédex is left alone, and serialize() refuses any change to
   SaveBlock1 at or beyond 0xC70. Switch FireRed/LeafGreen files are plain 0x20000 images; the
   container module only notes the file name. */
import { u16le, u32le, setU16le, setU32le, getFlag, setFlag, FormatError } from "../bytes.js";
import * as pk3 from "../pkm/pk3.js";
import { decrypt3, checksum3 } from "../pkm/crypt.js";
import * as D from "../data/index.js";
import * as text from "../text/gen3.js";

export const GEN = 3;
export const FORMAT = "pk3";

const FULL = 0x20000, HALF = 0x10000, SECTOR = 0x1000, SLOT_SECTORS = 14;
const ID = 0xff4, SUM = 0xff6, SIGN = 0xff8, COUNTER = 0xffc, SIGNATURE = 0x08012025;
const F80 = 0xf80;
const sizes = (sb2, last1) => [sb2, F80, F80, F80, last1, F80, F80, F80, F80, F80, F80, F80, F80, 0x7d0];
/** Bytes of each section the game checksums and loads (§3.3); E's are the largest, PKHeX uses 0xF80 everywhere. */
const SIZES = { RS: sizes(0x890, 0xc40), FRLG: sizes(0xf24, 0xee8), E: sizes(0xf2c, 0xf08) };
const SB2_MAX = 0xf2c;

/** SaveBlock1 offsets (§6). key: where SaveBlock2 keeps the XOR key for money (RS has none). */
const LAYOUT = {
  RS: { party: 0x234, money: 0x490, key: null, seen1: 0x938, seen2: 0x3a8c },
  E: { party: 0x234, money: 0x490, key: 0xac, seen1: 0x988, seen2: 0x3b24 },
  FRLG: { party: 0x034, money: 0x290, key: 0xf20, seen1: 0x5f8, seen2: 0x3a18 },
};
const DEX_OWNED = 0x28, DEX_SEEN = 0x5c, DEX_UNOWN_PID = 0x1c, DEX_SPINDA_PID = 0x20, DEX_BITS = 386;
const BOXES = 14, SLOTS = 30, MON = 80, PARTY_MON = 100;
const PC_BOXES = 4, PC_NAMES = 0x8344, BOX_NAME = 9;
const E_FRONTIER_STATUS = 0xca8;          // SaveBlock2 frontier.challengeStatus
const RS_TOWER_STATUS = 0x556;            // SaveBlock2 battleTower.var_4AE[2], one per level mode
const RS_TOWER_PENDING = [1, 2, 4, 5];    // states the lobby resolves with battleTower.selectedPartyMons
const E_UNION_ROOM = [0x3c88, 0x3d5a];    // SaveBlock1 registeredTexts: set at new game, zero in old 64-bit port saves
const PORT_SAFE_SB1 = 0xc70;              // SaveBlock1 bytes below this sit at the GBA offsets in every port
const VERSIONS = { RS: { 1: "S", 2: "R" }, FRLG: { 4: "FR", 5: "LG" } };

const fail = (code, message) => { throw new FormatError(message, { code }); };
/** A copy that never aliases the caller's memory (new Uint8Array(arrayBuffer) would be a view). */
const plainCopy = (b) => (b instanceof ArrayBuffer ? new Uint8Array(b.slice(0)) : new Uint8Array(b));

/** Sum the u32 words of the section, then fold the high half into the low half (§3.4). */
export function sectionChecksum(b, o, size) {
  let sum = 0;
  for (let i = 0; i < size; i += 4) sum = (sum + (b[o + i] | (b[o + i + 1] << 8) | (b[o + i + 2] << 16) | (b[o + i + 3] << 24))) >>> 0;
  return ((sum >>> 16) + sum) & 0xffff;
}

/* ---------- slots (§3.5) ---------- */

/** One slot as GetSaveValidStatus sees it: every signed sector with an id < 14 and a good checksum
    marks its id valid; the slot counter is that of the last valid sector in physical order. */
function readSlot(img, slot, size) {
  const sectors = new Array(SLOT_SECTORS).fill(-1);
  let signed = false, valid = 0, counter = 0;
  for (let i = 0; i < SLOT_SECTORS; i++) {
    const phys = slot * SLOT_SECTORS + i, o = phys * SECTOR;
    if (u32le(img, o + SIGN) !== SIGNATURE) continue;
    signed = true;
    const id = u16le(img, o + ID);
    if (id >= SLOT_SECTORS || sectionChecksum(img, o, size[id]) !== u16le(img, o + SUM)) continue;
    valid |= 1 << id;
    counter = u32le(img, o + COUNTER);
    sectors[id] = phys;
  }
  return { slot, status: !signed ? "empty" : valid === 0x3fff ? "ok" : "error", counter, sectors };
}

/** -> { status: "ok" | "error" | "empty" | "corrupt", counter, load (slot index the game copies), slots }. */
function classify(img, game) {
  const a = readSlot(img, 0, SIZES[game]), b = readSlot(img, 1, SIZES[game]);
  const slots = [a, b];
  if (a.status === "ok" && b.status === "ok") {
    const wrap = (a.counter === 0xffffffff && b.counter === 0) || (b.counter === 0xffffffff && a.counter === 0);
    const c = wrap ? 0 : Math.max(a.counter, b.counter);
    return { status: "ok", counter: c, load: c % 2, slots };
  }
  if (a.status === "ok" || b.status === "ok") {
    const good = a.status === "ok" ? a : b, other = good === a ? b : a;
    return { status: other.status === "error" ? "error" : "ok", counter: good.counter, load: good.counter % 2, slots };
  }
  return { status: a.status === "empty" && b.status === "empty" ? "empty" : "corrupt", slots };
}

/** The slot we read: the one the game loads, or the complete one when that is not complete
    (only tool-made saves get there, and they open read-only). */
function slotToRead(cls) {
  const s = cls.slots[cls.load];
  return s.status === "ok" ? s : cls.slots.find((x) => x.status === "ok");
}

/** SaveBlock2, SaveBlock1 and the PC as the game assembles them from a slot's sections. */
function assemble(img, slot, game) {
  const size = SIZES[game];
  const part = (from, to) => {
    let len = 0;
    for (let id = from; id <= to; id++) len += size[id];
    const out = new Uint8Array(len);
    for (let id = from, at = 0; id <= to; at += size[id], id++) {
      const p = slot.sectors[id];
      if (p >= 0) out.set(img.subarray(p * SECTOR, p * SECTOR + size[id]), at);
    }
    return out;
  };
  return { sb2: part(0, 0), sb1: part(1, 4), pc: part(5, 13) };
}

/* ---------- detection (§4) ---------- */

/** PKHeX's rule on SaveBlock2 0xAC (§4.1): FRLG keeps 1 there, RS 0 (or a Battle Tower name),
    Emerald its random XOR key; Emerald's SaveBlock2 is the only one with data beyond 0x890. */
function ruleGame(img, slot) {
  const p = slot.sectors[0];
  if (p < 0) return null;
  const o = p * SECTOR, key = u32le(img, o + 0xac);
  if (key === 1) return "FRLG";
  if (key === 0) return "RS";
  let tail = false;
  for (let i = 0x890; i < SB2_MAX && !tail; i++) tail = img[o + i] !== 0;
  if (key === 0xffffffff || key === 0x00010001) return tail ? "FRLG|E" : "FRLG";   // PKHeX's "dummy flag" repair cases
  return tail ? "E" : "RS";
}

/** 2: 1-6 Pokémon that all decrypt with good checksums and real species; 1: an empty party; 0: no. */
function partyFit(sb1, off) {
  const count = sb1[off];
  if (count > 6) return 0;
  for (let i = 0; i < count; i++) {
    const rec = sb1.subarray(off + 4 + i * PARTY_MON, off + 4 + (i + 1) * PARTY_MON);
    const p = decrypt3(rec);
    if (p[0x13] & 1) continue;                                    // a Bad Egg still is a party member
    if (checksum3(p) !== u16le(p, 0x1c) || !D.gen3ToNational(u16le(p, 0x20))) return 0;
  }
  return count ? 2 : 1;
}

const money = (b, game) => {
  const L = LAYOUT[game];
  return (u32le(b.sb1, L.money) ^ (L.key == null ? 0 : u32le(b.sb2, L.key))) >>> 0;
};

/** Everything detection and open need to know about reading the image as `game`. */
function evaluate(img, game) {
  const cls = classify(img, game);
  if (cls.status !== "ok" && cls.status !== "error") return { game, cls, score: -1 };
  const slot = slotToRead(cls);
  const blocks = assemble(img, slot, game);
  const rule = ruleGame(img, slot);
  const ruleScore = rule === game ? 4 : rule === "FRLG|E" && game !== "RS" ? 2 : 0;
  const party = partyFit(blocks.sb1, LAYOUT[game].party);
  const moneyOk = money(blocks, game) <= 999999;
  // FRLG runs Emerald's national-dex unlock at new game and never reads it back (§4.1).
  const frlgMark = game === "FRLG" && blocks.sb2[0x1a] === 0xda && u16le(blocks.sb1, 0x1078) === 0x0302 && (blocks.sb1[0xfe7] & 1);
  const score = ruleScore + party + (moneyOk ? 1 : 0) + (frlgMark ? 0.5 : 0);
  return { game, cls, slot, blocks, rule, party, moneyOk, conflict: ruleScore < 4 || party === 0 || !moneyOk, score };
}

/** A 64 KiB image (an emulator set to 64 KiB flash) is the first half of the chip; the rest reads as erased. */
function fullImage(b) {
  if (b.length === FULL) return b;
  const out = new Uint8Array(FULL).fill(0xff);
  out.set(b);
  return out;
}

function hasSignature(img) {
  for (let s = 0; s < 2 * SLOT_SECTORS; s++) if (u32le(img, s * SECTOR + SIGN) === SIGNATURE) return true;
  return false;
}

/** Japanese games leave bytes 6-7 of the 8-byte player name at 0 (5 characters + terminator); the others
    fill the buffer from 0xFF (§4.3). Western languages are not stored: use the language byte of the
    player's own Pokémon (eggs carry Japanese until they hatch). */
function saveLang(blocks, game) {
  const { sb2, sb1, pc } = blocks;
  if (u16le(sb2, 6) === 0) return "ja";
  const name = text.decode(sb2.subarray(0, 8), "en"), tid = u16le(sb2, 0x0a), sid = u16le(sb2, 0x0c);
  const counts = {};
  const look = (rec) => {
    if (u32le(rec, 4) !== ((sid << 16 | tid) >>> 0)) return;
    const p = decrypt3(rec);
    if (checksum3(p) !== u16le(p, 0x1c) || (u32le(p, 0x48) >>> 30) & 1 || !u16le(p, 0x20)) return;
    const lang = D.langFromId(p[0x12]);
    if (!lang || lang === "ja" || !text.LANGS.includes(lang) || text.decode(p.subarray(0x14, 0x1b), lang) !== name) return;
    counts[lang] = (counts[lang] || 0) + 1;
  };
  const off = LAYOUT[game].party, count = Math.min(6, sb1[off]);
  for (let i = 0; i < count; i++) look(sb1.subarray(off + 4 + i * PARTY_MON, off + 4 + i * PARTY_MON + MON));
  for (let g = 0; g < BOXES * SLOTS; g++) look(pc.subarray(PC_BOXES + g * MON, PC_BOXES + (g + 1) * MON));
  const best = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
  return best ? best[0] : "en";
}

/** detect(image) -> { game: "RS" | "E" | "FRLG", lang, confidence } | null. Never throws. */
export function detect(image) {
  try {
    const b = image instanceof Uint8Array ? image : new Uint8Array(image);
    if (b.length !== FULL && b.length !== HALF) return null;
    const img = fullImage(b);
    if (!hasSignature(img)) return null;
    const best = ["E", "FRLG", "RS"].map((g) => evaluate(img, g)).sort((x, y) => y.score - x.score)[0];
    if (best.score < 0) return null;
    const lang = saveLang(best.blocks, best.game);
    const confidence = best.conflict ? 0.4 : best.party === 2 ? 0.95 : 0.9;
    return { gen: GEN, game: best.game, lang, confidence };
  } catch {
    return null;
  }
}

/* ---------- the save ---------- */

const decodeName = (bytes, lang) => text.decode(bytes, text.LANGS.includes(lang) ? lang : "en");

class Gen3Save {
  constructor(image, detection) {
    const original = plainCopy(image);
    if (original.length !== FULL && original.length !== HALF)
      fail("gen3-size", "A Game Boy Advance Pokémon save is 128 KiB; this file has a different size.");
    const img = fullImage(original);
    const det = detection || detect(original);
    if (!det) fail("gen3-unrecognised", "This is not a Pokémon Ruby, Sapphire, Emerald, FireRed or LeafGreen save.");
    const game = pk3.gameFamily(det.game);
    if (!game) fail("gen3-game", `"${det.game}" is not a Generation 3 game.`);
    const ev = evaluate(img, game);
    if (ev.score < 0) {
      if (ev.cls.status === "empty") fail("gen3-empty", "This save file holds no saved game yet. Start the game, save once, and upload it again.");
      fail("gen3-corrupt", "Both copies of the game in this save are damaged, so the game would erase it as corrupted.");
    }
    this.gen = GEN; this.format = FORMAT; this.game = game;
    this.gameName = D.gameCodeName(3, game);
    this.warnings = [];
    this._original = original; this._img = img; this._ev = ev; this._loaded = ev.slot;
    this._blocks = ev.blocks;
    this._pristine = { sb2: plainCopy(ev.blocks.sb2), sb1: plainCopy(ev.blocks.sb1), pc: plainCopy(ev.blocks.pc) };
    this.lang = det.lang && (det.lang === "ja" || text.LANGS.includes(det.lang)) ? det.lang : saveLang(ev.blocks, game);
    this.readOnly = null;
    const readOnly = (msg) => { this.readOnly ??= msg; this.warnings.push(msg); };

    if (det.readOnly) readOnly(det.readOnly);
    if (original.length === HALF) readOnly("This save is only 64 KiB: the emulator was set to 64 KiB flash, but Pokémon uses 128 KiB. It can be read but not changed. Set the save type to Flash 128K (1M), load the game, save once, and upload the new file.");
    const { cls } = ev;
    if (cls.status === "error") {
      const other = cls.slots.find((s) => s.status === "error");
      readOnly(other.counter > cls.counter
        ? "The newest copy of the game in this save is damaged, so the game will load the previous save instead (and say \"The save file is corrupted\"). That previous save is shown here. Play, save once in the game, and upload the new file before changing anything."
        : "The backup copy of the game in this save is damaged (the game would say \"The save file is corrupted\"). It can be read but not changed. Save once in the game and upload the new file.");
    } else if (ev.slot.slot !== cls.load || ev.slot.counter !== cls.counter) {
      readOnly("This save was changed by a tool in a way the game reads differently (its newest copy is not the one the game loads). The copy the game loads is shown; save once in the game and upload the new file before changing anything.");
    }
    if (ev.conflict) readOnly(`This does not look like a normal ${this.gameName} save (the game checks disagree), so it is read-only. If it comes from a ROM hack or a PC port with its own save format, it cannot be used here.`);

    this.restricted = null;
    if (game === "E" && this._zeroRange(this._blocks.sb1, ...E_UNION_ROOM) && !this._dexGbaLayout()) {
      this.restricted = "This save may come from a 64-bit build of the pokeemerald PC port (pokeemerald-sdl2pc), which stores part of the save in its own layout. Boxes can be changed, but the Pokédex is left alone. pokeemerald-native converts such saves to the normal format.";
      this.warnings.push(this.restricted);
    }

    const { sb2 } = this._blocks;
    this.trainer = {
      name: decodeName(sb2.subarray(0, 8), this.lang), gender: sb2[8] ? "F" : "M",
      tid: u16le(sb2, 0x0a), sid: u16le(sb2, 0x0c), money: money(this._blocks, game),
      playTime: { h: u16le(sb2, 0x0e), m: sb2[0x10], s: sb2[0x11] },
    };
    this.boxCount = BOXES; this.boxCapacity = SLOTS;
    this.version = this._guessVersion();
    this.versionName = this.version ? D.gameCodeName(3, this.version) : null;
  }

  get currentBox() { return this._blocks.pc[0] < BOXES ? this._blocks.pc[0] : 0; }

  /** Ruby vs Sapphire and FireRed vs LeafGreen are not in the save (§4.2): the origin game most of the
      player's own Pokémon have is a guess for the UI to confirm with setVersion(). */
  _guessVersion() {
    if (this.game === "E") return "E";
    const names = VERSIONS[this.game], count = {};
    for (const { view } of this._allMons()) {
      if (view.isEgg || view.ot.tid !== this.trainer.tid || view.ot.sid !== this.trainer.sid || view.ot.name !== this.trainer.name) continue;
      const code = view.game;
      if (Object.values(names).includes(code)) count[code] = (count[code] || 0) + 1;
    }
    const [a, b] = Object.entries(count).sort((x, y) => y[1] - x[1]);
    return a && (!b || a[1] > b[1]) ? a[0] : null;
  }

  /** Confirms Ruby/Sapphire or FireRed/LeafGreen (it decides Deoxys's form). */
  setVersion(code) {
    if (pk3.gameFamily(code) !== this.game) throw new FormatError(`"${code}" is not a version of ${this.gameName}.`, { code: "gen3-version" });
    this.version = code === this.game ? null : code;
    this.versionName = this.version ? D.gameCodeName(3, this.version) : null;
  }

  get meta() { return { format: FORMAT, lang: this.lang, game: this.version ?? this.game }; }

  _entry(rec) {
    const meta = this.meta;
    return { record: plainCopy(rec.subarray(0, MON)), meta, view: pk3.toView(pk3.parse(rec, meta), meta) };
  }

  *_allMons() {
    for (const p of this.party()) yield p;
    for (let b = 0; b < BOXES; b++) for (const m of this.box(b)) if (m) yield m;
  }

  /* --- party --- */

  get _partyOff() { return LAYOUT[this.game].party; }
  get _partyCount() { return Math.min(6, this._blocks.sb1[this._partyOff]); }
  _partyAt(i) { const o = this._partyOff + 4 + i * PARTY_MON; return this._blocks.sb1.subarray(o, o + PARTY_MON); }

  party() {
    const out = [];
    for (let i = 0; i < this._partyCount; i++) out.push(this._entry(this._partyAt(i)));
    return out;
  }

  takeFromParty(index) {
    this._writable();
    const count = this._partyCount;
    if (!Number.isInteger(index) || index < 0 || index >= count) fail("gen3-party-index", `There is no Pokémon in party slot ${index + 1}.`);
    const { sb2, sb1 } = this._blocks;
    if (this.game === "E" && sb2[E_FRONTIER_STATUS] !== 0)
      fail("gen3-frontier", "This save was made in the middle of a Battle Frontier challenge, which keeps track of your party. Finish or end the challenge in the game, save, and upload again (Pokémon in the boxes can be moved any time).");
    if (this.game === "RS" && [sb2[RS_TOWER_STATUS], sb2[RS_TOWER_STATUS + 1]].some((s) => RS_TOWER_PENDING.includes(s)))
      fail("gen3-tower", "This save has a Battle Tower challenge that is not finished yet, and the tower keeps track of your party. Visit the Battle Tower lobby in the game, save, and upload again (Pokémon in the boxes can be moved any time).");
    const rec = this._partyAt(index);
    const f = pk3.parse(rec, this.meta);
    if (f.party.mail !== 0xff || pk3.isMail(f.growth.heldItem))
      fail("gen3-mail", "This Pokémon is holding Mail. Take the Mail in the game first (the PC does not accept Pokémon holding Mail either).");
    this._checkTakeable(rec);
    const able = (i) => {
      const g = pk3.parse(this._partyAt(i), this.meta);
      return !g.misc.isEgg && !g.flags.badEgg && g.derived.checksumOk && g.party.hp > 0;
    };
    let others = 0;
    for (let i = 0; i < count; i++) if (i !== index && able(i)) others++;
    if (!others) fail("gen3-last", "You can't take this Pokémon: it would leave no Pokémon in your party that can battle.");
    const out = { record: plainCopy(rec.subarray(0, MON)), meta: this.meta };
    // Shift the later members down and blank the last used slot the way the game does (ZeroMonData:
    // all zero except the mail byte 0xFF), then lower the count (§6, §12).
    const base = this._partyOff + 4;
    sb1.copyWithin(base + index * PARTY_MON, base + (index + 1) * PARTY_MON, base + count * PARTY_MON);
    const last = base + (count - 1) * PARTY_MON;
    sb1.fill(0, last, last + PARTY_MON);
    sb1[last + 0x55] = 0xff;
    sb1[this._partyOff] = count - 1;
    return out;
  }

  /* --- boxes --- */

  _slotOff(box, index) {
    if (!Number.isInteger(box) || box < 0 || box >= BOXES) fail("gen3-box", `There is no box ${box + 1}.`);
    if (!Number.isInteger(index) || index < 0 || index >= SLOTS) fail("gen3-slot", `There is no slot ${index + 1} in a box.`);
    return PC_BOXES + (box * SLOTS + index) * MON;
  }
  _slot(box, index) { const o = this._slotOff(box, index); return this._blocks.pc.subarray(o, o + MON); }

  /** Empty as the game sees it: species 0 behind a good checksum and no Bad Egg flag (§7). */
  static isEmpty(rec) {
    if (rec.every((x) => x === 0)) return true;
    const p = decrypt3(rec);
    return !(p[0x13] & 1) && checksum3(p) === u16le(p, 0x1c) && u16le(p, 0x20) === 0;
  }

  box(i) {
    const out = [];
    for (let s = 0; s < SLOTS; s++) {
      const rec = this._slot(i, s);
      out.push(Gen3Save.isEmpty(rec) ? null : this._entry(rec));
    }
    return out;
  }

  boxName(i) {
    if (!Number.isInteger(i) || i < 0 || i >= BOXES) fail("gen3-box", `There is no box ${i + 1}.`);
    return decodeName(this._blocks.pc.subarray(PC_NAMES + i * BOX_NAME, PC_NAMES + (i + 1) * BOX_NAME), this.lang);
  }

  _checkTakeable(rec) {
    const v = pk3.validate(rec.subarray(0, MON), this.meta);
    if (!v.ok) fail("gen3-damaged", `This Pokémon's data is damaged or not from a Generation 3 game, so it can't be moved: ${v.errors[0]}`);
  }

  takeFromBox(box, index) {
    this._writable();
    const rec = this._slot(box, index);
    if (Gen3Save.isEmpty(rec)) fail("gen3-empty-slot", `Box ${box + 1}, slot ${index + 1} is empty.`);
    this._checkTakeable(rec);
    const out = { record: plainCopy(rec), meta: this.meta };
    rec.fill(0);
    return out;
  }

  putInBox(record, meta = {}, box, index) {
    this._writable();
    if (meta.format && meta.format !== FORMAT)
      fail("gen3-format", `This Pokémon is stored as ${meta.format}; it has to be converted to the Generation 3 format first.`);
    const rec = plainCopy(record);
    if (rec.length !== MON) fail("gen3-record", `A Generation 3 Pokémon record is 80 bytes, not ${rec.length}.`);
    const v = pk3.validate(rec, { ...meta, game: this.game });
    if (!v.ok) fail("gen3-invalid", `This Pokémon can't go into the save: ${v.errors[0]}`);
    const item = pk3.parse(rec, meta).growth.heldItem;
    if (pk3.isMail(item)) fail("gen3-mail", "Pokémon holding Mail can't be stored in the PC. Take the Mail off first.");
    if (item > pk3.MAX_ITEM_BY_GAME[this.game])
      fail("gen3-item", `Its held item (${D.itemName(3, item)}) does not exist in ${this.gameName}. Take the item off first.`);
    const at = this._freeSlot(box, index);
    this._slot(at.box, at.index).set(rec);
    return at;
  }

  /** The requested slot, or the first empty one: in the given box, else from the current box on, as the game's "send to PC" does. */
  _freeSlot(box, index) {
    if (box != null && index != null) {
      if (!Gen3Save.isEmpty(this._slot(box, index))) fail("gen3-occupied", `Box ${box + 1}, slot ${index + 1} is not empty.`);
      return { box, index };
    }
    const order = box != null ? [box] : Array.from({ length: BOXES }, (_, k) => (this.currentBox + k) % BOXES);
    for (const b of order) for (let s = 0; s < SLOTS; s++) if (Gen3Save.isEmpty(this._slot(b, s))) return { box: b, index: s };
    return fail("gen3-full", box != null ? `Box ${box + 1} is full.` : "All boxes in the PC are full.");
  }

  /* --- Pokédex (§11) --- */

  _zeroRange(b, from, to) {
    for (let i = from; i < to; i++) if (b[i]) return false;
    return true;
  }

  /** The three seen copies (SaveBlock2, SaveBlock1 #1 and #2) agree on bits 0-385. */
  _dexMirrorsAgree() {
    const { sb2, sb1 } = this._blocks, L = LAYOUT[this.game];
    for (let bit = 0; bit < DEX_BITS; bit++) {
      const s = getFlag(sb2, DEX_SEEN, bit);
      if (getFlag(sb1, L.seen1, bit) !== s || getFlag(sb1, L.seen2, bit) !== s) return false;
    }
    return true;
  }

  _dexGbaLayout() {
    return this._dexMirrorsAgree() && !this._zeroRange(this._blocks.sb2, DEX_SEEN, DEX_SEEN + 49);
  }

  /** Marks a species seen (all three copies) and caught, as the game does for a Pokémon received in a
      trade; the first Unown or Spinda caught also stores its PID (opts.pid) for the Pokédex picture.
      -> true, or false (with a warning) when the Pokédex is left alone. */
  registerDex(species, opts = {}) {
    this._writable();
    if (!Number.isInteger(species) || species < 1 || species > D.MAX_SPECIES[3]) fail("gen3-dex", `Species ${species} is not in the Generation 3 Pokédex.`);
    if (this.restricted) return false;
    if (!this._dexMirrorsAgree()) {
      const msg = "The Pokédex was not updated: its copies in this save disagree (the game itself would erase such entries), which points at a ROM hack or an unusual save layout.";
      if (!this.warnings.includes(msg)) this.warnings.push(msg);
      return false;
    }
    const { sb2, sb1 } = this._blocks, L = LAYOUT[this.game], bit = species - 1;
    const caught = getFlag(sb2, DEX_OWNED, bit);
    for (const [b, o] of [[sb2, DEX_SEEN], [sb1, L.seen1], [sb1, L.seen2], [sb2, DEX_OWNED]]) setFlag(b, o, bit);
    if (!caught && opts.pid != null && (species === 201 || species === 327))
      setU32le(sb2, species === 201 ? DEX_UNOWN_PID : DEX_SPINDA_PID, opts.pid);
    return true;
  }

  /** Pokédex flags -> { seen: [national...], caught: [...] }; a species counts as seen only when all
      three copies say so, as the games read it. */
  pokedex() {
    const { sb2, sb1 } = this._blocks, L = LAYOUT[this.game], seen = [], caught = [];
    for (let bit = 0; bit < DEX_BITS; bit++) {
      const s = getFlag(sb2, DEX_SEEN, bit) && getFlag(sb1, L.seen1, bit) && getFlag(sb1, L.seen2, bit);
      if (s) seen.push(bit + 1);
      if (s && getFlag(sb2, DEX_OWNED, bit)) caught.push(bit + 1);
    }
    return { seen, caught };
  }

  /* --- writing (§3.6) --- */

  _writable() {
    if (this.readOnly) throw new FormatError(this.readOnly, { code: "gen3-read-only" });
  }

  /** The image with every changed section written back in place into the slot the game loads. */
  serialize() {
    if (this.readOnly) return plainCopy(this._original);
    const out = plainCopy(this._img), size = SIZES[this.game], { sectors } = this._loaded;
    const { sb2, sb1, pc } = this._blocks, was = this._pristine;
    if (this.restricted) {
      for (let i = PORT_SAFE_SB1; i < sb1.length; i++) if (sb1[i] !== was.sb1[i])
        fail("gen3-port-guard", "Refusing to write: this save may use the PC port's own layout there.");
    }
    const sections = [[sb2, was.sb2, 0, 0], ...[1, 2, 3, 4].map((id) => [sb1, was.sb1, id, (id - 1) * F80]),
      ...[5, 6, 7, 8, 9, 10, 11, 12, 13].map((id) => [pc, was.pc, id, (id - 5) * F80])];
    for (const [now, before, id, at] of sections) {
      let same = true;
      for (let i = at; i < at + size[id] && same; i++) same = now[i] === before[i];
      if (same) continue;
      const o = sectors[id] * SECTOR;
      out.fill(0, o, o + ID);
      out.set(now.subarray(at, at + size[id]), o);
      setU16le(out, o + SUM, sectionChecksum(out, o, size[id]));
    }
    // Self-check: the game must still load the same slot with the same counter, and see our data.
    const cls = classify(out, this.game);
    if (cls.status !== "ok" || cls.load !== this._loaded.slot || cls.counter !== this._ev.cls.counter)
      fail("gen3-self-check", "Internal error: the changed save would not load in the game, so nothing was written.");
    const back = assemble(out, slotToRead(cls), this.game);
    if (!["sb2", "sb1", "pc"].every((k) => back[k].every((x, i) => x === this._blocks[k][i])))
      fail("gen3-self-check", "Internal error: the changed save did not read back as written, so nothing was written.");
    return out;
  }
}

/** open(image, detection?) -> SaveFile (docs/ARCHITECTURE.md). detection.readOnly (a message) forces read-only. */
export function open(image, detection) {
  return new Gen3Save(image, detection);
}
