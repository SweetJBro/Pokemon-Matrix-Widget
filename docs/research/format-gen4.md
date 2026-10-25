# Generation 4 save & Pokémon data format (DP / Pt / HGSS)

Status: research deliverable, written 2026-10-24. Covers Diamond, Pearl, Platinum, HeartGold, SoulSilver
(international, Japanese, Korean), as emulator saves (raw `.sav` and wrappers) and as the Platinum PC port's `save.bin`.

License note: everything below is described in our own words and tables. PKHeX (GPLv3) was read only to confirm
offsets; no PKHeX code is reproduced. The pret decompilations are the primary source for algorithms (they show what the
game itself does). The reference implementation that produced the test vectors (§19) was written from scratch for this
research and lives outside the repo.

All multi-byte values are **little-endian** unless stated. "general" = small block (pret: `SAVE_BLOCK_ID_NORMAL`,
id 0), "storage" = big block (pret: `SAVE_BLOCK_ID_BOXES`, id 1).

---

## 0. Sources (cited by tag)

| Tag | URL / file |
|---|---|
| [pt-save] | https://github.com/pret/pokeplatinum/blob/main/src/savedata.c , `include/savedata.h`, `include/constants/savedata/savedata.h`, `include/constants/savedata/save_table.h`, `src/savedata/save_table.c` |
| [pt-mon] | pret/pokeplatinum `include/struct_defs/pokemon.h`, `src/pokemon.c` (crypto at `Pokemon_EncryptData`/`BoxPokemon_GetDataBlock`, ~L4817–4990) |
| [pt-math] | pret/pokeplatinum `src/math_util.c` (`EncodeData`, `LCRNG_NextFrom`, `CalcCRC16Checksum`), `include/math_util.h` (`LCRNG_MULTIPLIER 1103515245`, `LCRNG_INCREMENT 24691`) |
| [pt-box] | pret/pokeplatinum `include/pc_boxes.h`, `src/pc_boxes.c` |
| [pt-party] | pret/pokeplatinum `include/party.h`, `src/party.c` |
| [pt-trainer] | pret/pokeplatinum `include/trainer_info.h`, `src/trainer_info.c`, `include/save_player.h` |
| [pt-dex] | pret/pokeplatinum `include/pokedex.h`, `src/pokedex.c`, `src/pokedex_language.c` |
| [pt-char] | https://raw.githubusercontent.com/pret/pokeplatinum/main/tools/msgenc/charmap.txt , `include/constants/charcode.h` |
| [pt-const] | pret/pokeplatinum `generated/species.txt`, `generated/items.txt`, `generated/moves.txt`, `generated/abilities.txt`, `include/constants/forms.h`, `include/constants/versions.h`, `res/pokemon/<species>/data.json` |
| [hg-save] | https://github.com/pret/pokeheartgold/blob/master/src/save.c , `include/save.h` |
| [hg-box] | pret/pokeheartgold `include/pokemon_storage_system.h` |
| [hg-mon] | pret/pokeheartgold `include/pokemon_types_def.h`, `src/pokemon.c` (ball handling ~L833, ~L1298) |
| [hg-dex] | pret/pokeheartgold `include/pokedex.h`, `src/pokedex.c`, `src/unk_02091278.c` (`LanguageToDexFlag`) |
| [hg-misc] | pret/pokeheartgold `include/player_data.h`, `src/party.c`, `include/pokewalker.h`, `include/constants/balls.h`, `include/constants/items.h`, `tools/msgenc/charmap.txt` |
| [dp-save] | https://github.com/pret/pokediamond/blob/master/arm9/src/save.c , `include/pokedex.h`, `arm9/src/pokedex.c`, `arm9/src/player_data.c`, `charmap.txt` |
| [pkhex-sav] | https://github.com/kwsch/PKHeX `PKHeX.Core/Saves/SAV4.cs`, `SAV4DP.cs`, `SAV4Pt.cs`, `SAV4HGSS.cs`, `SAV4Sinnoh.cs`, `Saves/Substructures/Gen4/SAV4BlockDetection.cs`, `Saves/Blocks/BlockInfo4.cs`, `Saves/Util/SaveUtil.cs`, `Saves/Util/Checksums.cs`, `Saves/Util/Recognition/SaveHandlerDeSmuME.cs`, `SaveHandlerARDS.cs` (GPLv3, read only) |
| [pkhex-pk4] | PKHeX `PKHeX.Core/PKM/PK4.cs`, `PKM/Shared/G4PKM.cs`, `PKM/Util/PokeCrypto.cs`, `PKM/Strings/StringConverter4.cs`, `StringConverter4Util.cs`, `Saves/Substructures/PokeDex/Zukan4.cs`, `Game/Locations/Locations.cs`, `PKM/Enums/GroundTileType.cs`, `Legality/Legal.cs` |
| [bulba-sav] | Bulbapedia "Save data structure (Generation IV)" (read via https://web.archive.org/web/2024/https://bulbapedia.bulbagarden.net/wiki/Save_data_structure_(Generation_IV) because the live site serves a bot challenge) |
| [bulba-pk4] | Bulbapedia "Pokémon data structure (Generation IV)" (same Wayback route) |
| [pp-dp] | https://projectpokemon.org/home/docs/gen-4/dp-save-structure-r74/ |
| [pp-hgss] | https://projectpokemon.org/home/docs/gen-4/hgss-save-structure-r76/ |
| [ntr] | https://github.com/cybervisi0n/libntr (MIT) `include/nitro/math/crc.h` (`MATH_CRC16_CCITT_POLY 0x1021`, `MATH_CRC16_CCITT_INIT 0xffff`), `libraries/math/src/crc.c`, `include/nitro/card/backup.h` |
| [port] | https://github.com/cybervisi0n/pokeplatinum (branch `pc_port`), README; GBAtemp thread https://gbatemp.net/threads/pokemon-platinum-pc-port-gets-a-surprise-release.682001/ |

---

## 1. TL;DR implementation checklist

1. Unwrap the container (§2) to a 512 KiB (0x80000) flash image. Missing tail bytes → treat as 0xFF (0x00 for the
   Platinum PC port; either value fails footer validation, so the choice only matters when re-padding on export).
2. Detect the game by checking the footers at the known offsets in **both** 256 KiB partitions (§3, §5, §8). The
   Platinum PC port uses **different block sizes** (§17.1), so its sizes must be in the candidate list too.
3. Pick the current general and storage copies **with the game's own algorithm** (§6). DP/Pt choose them
   separately (linked by a shared counter); HGSS chooses **one partition** for both.
4. Parse: trainer (§9), party (§11), boxes (§10), Pokédex (§15). Decrypt each 136-byte box record or 236-byte party
   record (§12.2).
5. To write: modify the current copies in place, re-encrypt each changed PK4 (fresh checksum), write canonical
   *encrypted empty* records into vacated slots (never raw zeros; see §10.4), update the party count if the party
   changed, and on HGSS OR the changed boxes into the box-modified bitmask (storage+0x12004). Then recompute the
   CRC16 of each changed block. Leave counters, the other partition, and the extra blocks alone (§7).
6. Re-wrap into the original container, keeping the original length, header and footer.

---

## 2. Containers (emulators and PC port)

| Source | Layout | Notes |
|---|---|---|
| Raw dump / melonDS / most emulators / flashcarts | exactly 0x80000 bytes (4 Mbit flash) | HGSS also probes `CARD_BACKUP_TYPE_FLASH_4MBITS(_EX)` [hg-save `SaveDetectFlash`]. A cart that was never saved is all 0xFF. |
| DeSmuME `.dsv` | 0x80000 data + 0x7A-byte trailer that ends with ASCII `\|-DESMUME SAVE-\|` | Total 0x8007A [pkhex-sav SaveHandlerDeSmuME]. Keep the trailer byte for byte. |
| Action Replay DS `.duc` | 0xA4-byte header + 0x80000 data | Total 0x800A4 [pkhex-sav SaveHandlerARDS]. |
| Platinum PC port `save.bin` | same partition offsets (0 / 0x40000) and footer format, but **different block sizes and in-block offsets** (native x86-64 struct alignment), **variable length and zero-filled** | See §17. Pad virtually to 0x80000 when parsing. Preserve the original length when writing (extend only if needed). Not byte-compatible with DS saves. |
| Other emulators (no$gba, DraStic, …) | UNVERIFIED here; see `docs/research/ports-emulators` | Fall back to "find a 0x80000 window whose footers validate". |

On a new cartridge every byte is 0xFF. The **first** save goes to the **second** partition (0x40000), because the game
writes to `!blockOffsets[block]` and `blockOffsets` starts at 0 [pt-save `SaveDataState_InitBlock`; pp-dp].
After a single in-game save, partition A can still be all 0xFF. Detection must therefore try both partitions.

---

## 3. Flash layout per game

The 512 KiB image is two 256 KiB partitions (A at 0x00000, B at 0x40000). Each holds one copy of the general block,
one copy of the storage block, and "extra" blocks. (pret: `PRIMARY_SECTOR_START 0`, `BACKUP_SECTOR_START 64` sectors of
0x1000 [pt-save]; HGSS `GetChunkOffsetFromCurrentSaveSlot`: slot 0 → 0, slot 1 → 0x40000 [hg-save].)

| Game | General block (rel. to partition) | General size | Storage block | Storage size | Footer size | Source |
|---|---|---|---|---|---|---|
| DP | 0x00000–0x0C0FF | 0xC100 | 0x0C100–0x1E2DF | 0x121E0 | 0x14 | [pkhex-sav SAV4DP], [bulba-sav], [pp-dp] |
| Pt | 0x00000–0x0CF2B | 0xCF2C | 0x0CF2C–0x1F10F | 0x121E4 | 0x14 | [pkhex-sav SAV4Pt], [bulba-sav] |
| HGSS | 0x00000–0x0F627 | 0xF628 | 0x0F700–0x21A0F | 0x12310 | 0x10 | [pkhex-sav SAV4HGSS], [pp-hgss] |

HGSS storage starts at 0xF700 because HGSS rounds the next block up to a multiple of 0x100 (gap 0xD8)
[hg-save `SaveData_InitSlotSpecs`].

Absolute footer positions (partition A / B):

| Game | General footer | Storage footer | CRC length, general | CRC length, storage |
|---|---|---|---|---|
| DP | 0x0C0EC / 0x4C0EC | 0x1E2CC / 0x5E2CC | 0xC0EC | 0x121CC |
| Pt | 0x0CF18 / 0x4CF18 | 0x1F0FC / 0x5F0FC | 0xCF18 | 0x121D0 |
| HGSS | 0x0F618 / 0x4F618 | 0x21A00 / 0x61A00 | 0xF618 | 0x12300 |

Cross-check from first principles: Platinum `sizeof(PCBoxes)` = 4 + 18·30·136 + 18·40 + 18 + 1 = 0x121C7, padded to 0x121C8.
Platinum's `SaveTableEntry_BodySize` adds `4 - size%4` (always 1–4 bytes) and then 4 more, giving 0x121D0. Adding the
0x14 footer gives **0x121E4** ✓. DP's `SaveArray_sizeof` adds only `4 - size%4`, giving 0x121CC + 0x14 = **0x121E0** ✓
[dp-save]. For HGSS, `sizeof(PCStorage)` = 0x122FC. `GetSaveChunkSizePlusCRC` rounds it up to a multiple of 4 and adds
4, giving 0x12300; plus the 0x10 footer gives **0x12310** ✓ [hg-save, hg-box].

The extra blocks hold the Hall of Fame, the Battle Hall and battle videos. **Never touch them**: they have their own
footers and selection rules.

| Game | Extra blocks (offset in partition, size) | Source |
|---|---|---|
| DP | HoF 0x20000 (0x2AC0) | [pkhex-sav SAV4DP] |
| Pt | HoF 0x20000 (0x2AC0), Battle Hall 0x23000 (0xBB0), videos 0x24000/0x26000/0x28000/0x2A000 (0x1D60 each) | [pkhex-sav SAV4Pt] |
| HGSS | HoF 0x23000, Battle Hall 0x26000, videos 0x27000/0x29000/0x2B000/0x2D000 (same sizes) | [pkhex-sav SAV4HGSS] |

Preserve every byte outside the blocks you modify.

---

## 4. Checksum algorithm (block CRC)

- **CRC-16/CCITT-FALSE** (also called CRC-16/IBM-3740): poly 0x1021, init 0xFFFF, MSB-first (not reflected), no final
  XOR. The check value for ASCII `123456789` is **0x29B1**. Sources: the game calls NitroSDK
  `MATH_CalcCRC16CCITT` [pt-math]; libntr defines poly 0x1021 and init 0xFFFF and updates MSB-first with
  `r = (r<<8) ^ T[((r>>8) ^ byte) & 0xFF]` [ntr]. PKHeX's byte-wise `CRC16_CCITT` gives identical results; this was
  verified with a test harness on "123456789" and on 1000 pseudo-random bytes.
- **Range:** from the first byte of the block up to, but not including, the footer, i.e. `size - 0x14` bytes (DP/Pt)
  or `size - 0x10` bytes (HGSS) [pt-save `SaveData_CalculateFooterChecksum`; hg-save `SaveArray_CalcCRC16MinusFooter`].
- The CRC is stored as a u16 in the **last 2 bytes** of the block.

Reference (our own code):

```js
function crc16ccittFalse(bytes, start, end) {
  let crc = 0xFFFF;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}
```

Some save sub-tables (pret Pt `SaveData_SetChecksum`/`SaveData_Checksum`, HGSS `SaveSubstruct_UpdateCRC`/
`SaveSubstruct_AssertCRC`) carry their own CRC16 in the spare bytes at the end of the table entry: the CRC covers
`bodySize - 4` bytes and is stored as the u16 right after them. A grep of every caller (verification, §22) gives:

- **Pt:** TV broadcast, Mystery Gift, Rankings, Wi-Fi history, unlocked easy-chat words, link-contest records and the
  e-mail table (`SAVE_TABLE_ENTRY_EMAIL`), 7 tables in all. (An earlier version of this doc said "only TV broadcast
  and Mystery Gift"; that was wrong.) The read-side check (`SaveData_Checksum`) only fires a debug `GF_ASSERT`, and
  no caller uses its return value.
- **HGSS:** `SAVE_EASY_CHAT` (30), `SAVE_MYSTERY_GIFT` (27), `SAVE_RANKINGS` (24), `SAVE_WIFI_HISTORY` (26),
  `SAVE_UNK_31`, plus an assert-only read of `SAVE_UNK_23`. Every call passes a constant ID, and no caller uses the
  assert's return value.

**None of party (Pt entry 2 / HGSS 2), Pokédex (Pt 7 / HGSS 6) or PC boxes (Pt 37 / HGSS 41) uses it**, so our edits
never need a sub-table CRC. PKHeX doesn't update these CRCs either. DP's `SaveArray_sizeof` adds no spare CRC word at
all.

---

## 5. Block footers

### 5.1 DP / Pt footer (0x14 bytes, at block end − 0x14) [pt-save `SaveBlockFooter`]

| Off | Size | pret name | Meaning |
|---|---|---|---|
| +0x00 | u32 | `saveCounter` | "Global" counter. It is incremented only on a **full save** (general and storage both written) and written into both blocks. It links a general copy to its storage copy. Project Pokémon calls it "Storage Block Save Count" [pp-dp]; Bulbapedia says "used to connect a small block with a big block" [bulba-sav]. |
| +0x04 | u32 | `blockCounter` | Per-block counter. On **every** save the game increments the RAM copies of *both* blocks' counters (`SaveDataState_Init`), but only the blocks actually written store the new value. So the storage copy's value jumps by the number of saves since the last full save. [pp-dp] calls it "General Block Save Count" for the general block. |
| +0x08 | u32 | `size` | Must equal the full block size, including the footer (0xC100 / 0x121E0 for DP, etc.). |
| +0x0C | u32 | `signature` | 0x20060623 (`SECTOR_SIGNATURE`) for JP/INT; **0x20070903 for Korean** (PKHeX `MAGIC_KOREAN`; UNVERIFIED by decomp, since pret builds only US). |
| +0x10 | u8 | `saveBlockID` | 0 = general, 1 = storage. |
| +0x11 | u8 | (padding) | Ignore. Not covered by the CRC. |
| +0x12 | u16 | `checksum` | CRC16 over `[block, block+size-0x14)`. |

Validity test used by the game [pt-save `SaveBlockFooter_Validate`; dp-save `sub_020228E0` is identical]:
`size == expected && signature == SIG && blockID == expected && crc == computed`.

Worked example from [bulba-sav] (DP, real data). Small block 1: `D1 01 00 00 | 42 04 00 00 | 00 C1 00 00 | 23 06 06 20 | 00 00 | 7E 7A`.
Big block 2: `D1 01 00 00 | F2 02 00 00 | E0 21 01 00 | 23 06 06 20 | 01 00 | F6 8A`. They are linked by
saveCounter 0x1D1.

### 5.2 HGSS footer (0x10 bytes, at block end − 0x10) [hg-save `SaveChunkFooter`]

| Off | Size | Field | Meaning |
|---|---|---|---|
| +0x00 | u32 | `count` | Global save counter, incremented on **every** save. Both blocks of one save carry the same value. |
| +0x04 | u32 | `size` | Full block size including footer (0xF628 / 0x12310). |
| +0x08 | u32 | `magic` | 0x20060623 (`SAVE_CHUNK_MAGIC`); Korean 0x20070903 per PKHeX (UNVERIFIED). |
| +0x0C | u16 | `slot` | 0 = general, 1 = storage. |
| +0x0E | u16 | `crc` | CRC16 over `[block, block+size-0x10)`. |

Uniform trick: in **both** footer formats, `size` is at end − 0x0C, `magic` at end − 0x08, the block id at end − 0x04
(DP/Pt u8 + pad, HGSS u16), and the CRC at end − 0x02. PKHeX detection relies on this [pkhex-sav SaveUtil
`IsValidGeneralFooter2`].

PKHeX disagreement: PKHeX's `SAV4.GetActiveBlock` reads two u32s at end − 0x14 and end − 0x10 for **all three** games.
For HGSS, end − 0x14 is the last data word before the footer, not a footer field. A Project Pokémon forum post noticed
this ("general block save count always 0 in HGSS"). PKHeX still gets the right answer because it falls back to the
second word (`count`). **Use the pret semantics above.**

---

## 6. Choosing the current copy (exactly what the game does)

### 6.1 Counter comparison (all games)

`cmp(a, b)` handles wraparound only for the pair (0xFFFFFFFF, 0) [pt-save `SaveCheckInfo_CompareCounters`;
hg-save `SaveCounterCompare`; dp-save `sub_020229B8`]:

```
if a == 0xFFFFFFFF and b == 0 -> -1 ; if a == 0 and b == 0xFFFFFFFF -> +1
else sign(a - b) (unsigned)
```

### 6.2 DP and Pt [pt-save `SaveData_LoadCheck`, `SaveCheckInfo_CompareSectors`; dp-save `sub_02022AD8` is the same]

For each block kind (general, storage) separately, build `info[A]` and `info[B]` = {valid, saveCounter, blockCounter}.
Then:

```
compareSectors(i0, i1):
  if i0.valid && i1.valid:
     g = cmp(i0.saveCounter, i1.saveCounter); b = cmp(i0.blockCounter, i1.blockCounter)
     cur = (g>0) ? A : (g<0) ? B : (b>0) ? A : (b<0) ? B : A ; stale = other
     return VALID(2)
  if only one valid: cur = that one, stale = none -> PARTIAL(1)
  else -> INVALID(0)
```

| general result | storage result | Outcome |
|---|---|---|
| INVALID | INVALID | EMPTY (no save) |
| either INVALID | | ERROR (save unusable; the game starts as if new, flag `NORMAL_LOAD_ERROR`) |
| VALID | VALID | if `gen[cur].saveCounter == sto[cur].saveCounter` → **OK** (use gen cur, sto cur); else **CORRUPT** (use gen *stale* + sto cur; shows "previous save loaded") |
| PARTIAL | VALID | if `gen[cur].sc == sto[cur].sc` → CORRUPT (gen cur, sto cur); elif `gen[cur].sc == sto[stale].sc` → CORRUPT (gen cur, sto stale); else ERROR |
| VALID | PARTIAL | if `gen[cur].sc == sto[cur].sc` → **OK**; else CORRUPT (gen stale + sto cur) |
| PARTIAL | PARTIAL | if both cur are in the same partition → **OK**; else CORRUPT |

Consequences for us:

- After exactly one in-game save, only partition B is valid (PARTIAL/PARTIAL, same partition) → OK.
- **Invalidating the backup general block turns a normal load into CORRUPT** (row PARTIAL/VALID). Never "clean up"
  the other partition.
- The current general and current storage **may live in different partitions** [pp-dp].
- `LOAD_RESULT_OK` clears `fullSaveRequired`. CORRUPT leaves it set, so the next in-game save rewrites both blocks
  [pt-save `SaveData_Init`].

### 6.3 HGSS [hg-save `Save_GetSaveFilesStatus`, `SaveSlotCheckCompare`]

HGSS validates general ("main") and storage ("sub") in each partition. It picks the **newer general** by `count` and
then loads **both blocks from that one partition** (`lastGoodSector`) [hg-save `Save_LoadDynamicRegion`].

| main good copies | sub good copies | Rule |
|---|---|---|
| 0 | 0 | NOT_EXIST |
| 0 or sub 0 | | TOTAL_FAIL |
| 2 | 2 | if `main[newer].count == sub[newer].count` → IS_GOOD (partition = newer); elif `main[older].count == sub[older].count` → SLOT_FAIL (partition = older; "corrupted" message); else TOTAL_FAIL |
| 1 | 2 | if `main[newer].count == sub[newer].count` → SLOT_FAIL; else TOTAL_FAIL |
| 2 | 1 | if counts match in newer → IS_GOOD; elif older exists and matches → SLOT_FAIL; else TOTAL_FAIL |
| 1 | 1 | if same partition → IS_GOOD (that partition); else TOTAL_FAIL |

An invalid block's `count` is treated as 0.

---

## 7. How the games write, and what that means for our writer

### 7.1 DP/Pt [pt-save `SaveDataState_Init/Main/End`]

- Each save writes to the **other** partition for each block it writes, then flips that block's `blockOffsets`.
- **Normal save** (`fullSaveRequired == FALSE`): only the general block is written. All `blockCounters[]` are
  incremented in RAM, but only the general's is written. `saveCounter` is **unchanged**, so the new general still
  links to the old storage.
- **Full save** (`fullSaveRequired == TRUE`, set by e.g. storing a Pokémon in a box via `PCBoxes_TryStoreBoxMon*`, at
  boot after a non-OK load, and on a new game): `saveCounter++`, then general and storage are both written to their
  opposite partitions.
- Write order per block: body, then footer bytes +8..+0xF (secondary footer), then the whole footer. A power cut
  mid-save therefore leaves an invalid footer.

### 7.2 HGSS [hg-save `Save_WriteManInit`, `HandleWriteSaveAsync_*`, `Save_WritePCBoxes`, `Save_CalcPCBoxModifiedFlags`]

- Every save does `count++` and writes **both** blocks to the partition opposite `lastGoodSector`.
- The general block is always written in full.
- The storage block is written **partially**: only boxes whose bit is set in
  `flags = PCStorage.boxModifiedFlag (live) | saveData->boxModifiedFlags (flags that were in the loaded/previous save)`.
  All boxes are written if either `sectorCleanFlag[0..1]` is still set. Both flags start at 1 at boot. A load clears
  them only for partitions it validated: 2/2 IS_GOOD clears both, 1/1 IS_GOOD clears only the good partition, and the
  2/1 IS_GOOD and SLOT_FAIL paths clear none. Each successful save then clears the flag of the partition it wrote. The
  rest of the storage block (0x12000..0x122FF: current box, flags, names, wallpapers) is always written. Box *n*
  occupies bytes `n*0x1000 .. n*0x1000+0xFFF` of the storage block.
- Safety net [hg-save `HandleWriteSaveAsync_PCBoxes`]: if the flag union is 0, the game compares a CRC of the 18
  box pages with the CRC it took at load (`pcStorageLastCRC`). If they differ, it writes all boxes. This does not cover
  our edits when *some* flag is set, so it is no substitute for OR-ing the bits.
- The footer CRC is computed from RAM, which holds all 18 boxes, so the flash copy is only consistent if the boxes it
  skipped already match RAM. The design relies on "boxes changed in the last two saves" being rewritten.
- The stored `boxModifiedFlag` (storage+0x12004, u32, bit *n* = box *n*, all = 0x3FFFF) holds the boxes changed in the
  session that produced that copy. After writing, the game resets the live flags.
- PKHeX forces `boxModifiedFlag = 0x3FFFF` on export for this reason [pkhex-sav SAV4HGSS `GetFinalData`].
- If ≥ 6 boxes are flagged, the game shows its "saving a lot of data" message (`Save_NumModifiedPCBoxesIsMany`). This
  is harmless.

### 7.3 Recommended write strategy

**Strategy A (default; what PKHeX does): edit the current copies in place.**

1. Run §6 and require OK (DP/Pt) or IS_GOOD (HGSS). Otherwise refuse and show the user the reason.
2. Apply changes to the current general and/or current storage copy.
3. HGSS only: `storage[0x12004] |= changedBoxMask` (OR it in; never clear existing bits). Setting 0x3FFFF is also
   safe.
4. Recompute the CRC of each modified block. **Do not** change counters, size, magic or id. Do not touch the other
   partition or the extra blocks.

Result: the game loads exactly the same partitions as before, and checksums pass. The next in-game save goes to the
other partition. On DP/Pt either both blocks are written (full save) or only the general (which links to our edited
storage via the unchanged `saveCounter`). On HGSS the flagged boxes are rewritten.

**Strategy B (game-like, keeps the pre-edit save as the fallback copy):**

- DP/Pt: write the edited general to the general's *inactive* partition and the edited storage to the storage's
  *inactive* partition. Set both footers' `saveCounter = old + 1` and `blockCounter = old + 1`, where "old" is that
  block's current copy. **Always write both blocks, even if only one changed.** A new general with `saveCounter + 1`
  next to an un-rewritten storage fails the link check and loads as CORRUPT (§6.2).
- HGSS: write both edited blocks, in full, into the inactive partition with `count = old + 1`, and OR the changed
  boxes into storage+0x12004. The next in-game save goes back to the old partition.
- If B produces a bad block, the game falls back to the pre-edit data with a "corrupted" message instead of failing.

Either way, a user can always restore their own pre-deposit save file from disk. **Duplication cannot be prevented at
the save-file level.** The server must treat saves as untrusted and fingerprint deposited Pokémon (for example PID +
OT ID + IVs + checksum) to detect re-deposits.

### 7.4 Everything that must be updated after an edit

| Change | Must update |
|---|---|
| Any box slot | PK4 checksum + encryption (§12.2), `flags@0x04 = 0`; storage CRC; HGSS box-modified bit |
| Vacated box slot | Canonical encrypted-empty record (§10.4) |
| Party member added/removed | PK4 (236-byte, with recomputed party stats and the party block encrypted with the PID), party count u32, packing of the remaining members (HGSS also shifts the aprijuice bytes, §11); general CRC |
| Pokédex registration | Dex bits (§15); general CRC |
| Nothing else | No global hash and no signature beyond the footer. RTC and owner data are not touched. |

**Close the emulator before importing.** An emulator holding the save in RAM overwrites the file on its next flush.

---

## 8. Game, version and language identification

1. For each game `G` ∈ {DP, Pt, HGSS} and each partition `p` ∈ {0, 0x40000}, check the general footer at
   `p + gSize`: `u32@(end-0xC) == gSize`, `u32@(end-8)` ∈ {0x20060623, 0x20070903}, id == 0, and the CRC is valid. Do
   the same for storage (id 1, `sStart`, `sSize`).
   - Matching general sizes 0xC100 / 0xCF2C / 0xF628 identify DP / Pt / HGSS unambiguously. Also try the Platinum
     PC port's 0xCF40 (storage at 0xCF40, size 0x121EC; §17.1). A port save is identified by these sizes, not by
     its file length.
   - Accept a game if at least one partition validates. PKHeX checks only partition B, size and magic; that suffices in
     practice because the first save lands in B, but checking both is more robust.
2. The same 512 KiB size is used by Gen 5. A Gen 5 save simply fails all Gen 4 footer checks (see `format-gen5`).
3. **Version:** trainer `gameCode` byte at `Trainer+0x1C` [pt-trainer].
   - HGSS: 7 = HeartGold, 8 = SoulSilver (PKHeX derives `Version` from this byte [pkhex-sav SAV4HGSS]).
   - Pt: 12 (`TrainerInfo_Init` sets `GAME_VERSION` [pt-trainer]).
   - **DP: 0.** `PlayerProfile_Init` does not set it [dp-save `player_data.c`], and PKHeX calls the byte
     "Unused by D/P". Diamond and Pearl **cannot be distinguished from the save layout**. Heuristic: the origin-game
     byte (0x5F) of party/box Pokémon whose OT name, TID and SID match the trainer (10 = Diamond, 11 = Pearl).
     Otherwise ask the user. The layouts are identical, so this only affects labels and the "origin game" written into
     new Pokémon.
4. **Language:** `Trainer+0x19`: 1 JPN, 2 ENG, 3 FRE, 4 ITA, 5 GER, 7 SPA, 8 KOR [pt-const `versions.h`].
5. Gen 4 version IDs (PK4 byte 0x5F): 1 Sapphire, 2 Ruby, 3 Emerald, 4 FireRed, 5 LeafGreen, 7 HeartGold,
   8 SoulSilver, 10 Diamond, 11 Pearl, 12 Platinum, 15 Colosseum/XD [pt-const `versions.h`].

---

## 9. General block: trainer and other offsets

Offsets are relative to the start of the current general block.

| Field | DP | Pt | HGSS | Type / notes |
|---|---|---|---|---|
| Adventure started | 0x34 | 0x34 | 0x34 | **s64** seconds (pret `GameTime.startTimestamp` at SystemData+0x10+0x24; the DS compiler aligns 64-bit members to 4). PKHeX reads only the low u32 [pkhex-sav SAV4 `SecondsToStart`; pp-hgss] |
| HoF / champion time | 0x3C | 0x3C | 0x3C | s64 seconds (`firstCompletionTimestamp`); PKHeX reads the low u32 |
| `PlayerSave` start (Options u16 + 2 pad) | 0x60 | 0x64 | 0x60 | [pt-trainer `save_player.h`] |
| **Trainer name** (`Trainer1`) | 0x64 | 0x68 | 0x64 | u16[8]: 7 chars + 0xFFFF (JP max 5 chars) |
| TID | 0x74 | 0x78 | 0x74 | u16 (low half of u32 `id`) |
| SID | 0x76 | 0x7A | 0x76 | u16 (high half) |
| Money | 0x78 | 0x7C | 0x78 | u32, max 999999 |
| Gender | 0x7C | 0x80 | 0x7C | u8, 0 male / 1 female |
| Language | 0x7D | 0x81 | 0x7D | u8 (§8) |
| Badges | 0x7E | 0x82 | 0x7E | u8 bitfield (HGSS: Johto) |
| Avatar / union-room sprite | 0x7F | 0x83 | 0x7F | u8 |
| gameCode (version) | 0x80 (=0) | 0x84 (=12) | 0x80 (7/8) | u8 |
| Flags | 0x81 | 0x85 | 0x81 | bit0 game cleared, bit1 national dex |
| Kanto badges | — | — | 0x83 | u8 (HGSS `kantoBadges` [hg-misc `player_data.h`]) |
| Coins | 0x84 | 0x88 | 0x84 | u16 |
| Play time h / m / s | 0x86 / 0x88 / 0x89 | 0x8A / 0x8C / 0x8D | 0x86 / 0x88 / 0x89 | u16, u8, u8 |
| Party capacity | 0x90 | 0x98 | 0x90 | int (=6) [pt-party `Party.capacity`] |
| **Party count** | 0x94 | 0x9C | 0x94 | int (u32). PKHeX reads only the low byte. |
| **Party Pokémon[6]** | 0x98 | 0xA0 | 0x98 | 6 × 0xEC bytes |
| HGSS aprijuice bytes[6][5] | — | — | 0x620 | follows party [hg-misc `Party.extra`] |
| **Pokédex** | 0x12DC | 0x1328 | 0x12B8 | §15 [pkhex-sav] |
| Daycare (2 × 0xEC: BoxPokemon 0x88 + daycare mail 0x60 + u32 `steps`, which PKHeX calls EXP) | 0x141C | 0x1654 | 0x15FC | [pkhex-sav; pt `struct_defs/daycare.h`] |
| Mail (Mail4 records) | 0x4BEC | 0x4E80 | 0x3FA8 | [pkhex-sav SAV4 `GetMailOffset`] |
| Rival name | 0x25A8 | 0x27E8 | 0x22D4 | u16[8] |
| Map / X / Y | 0x1238 / 0x1240 / 0x1244 | 0x1280 / 0x1288 / 0x128C | 0x1234 / 0x123C / 0x1240 | u16 |
| Pokéwalker struct (HGSS) | — | — | struct at **0xE5DC**; its `BoxPokemon` at 0xE5E0 (= PKHeX `WalkerPair`) | pret `POKEWALKER` (0x134 bytes): u16, u16, BoxPokemon at +4, …, steps u32 +0x128, watts +0x12C, course bits +0x130 [hg-misc `pokewalker.h`]. PKHeX's steps offset 0xE704 = 0xE5DC + 0x128, which confirms the start. Its "no Pokémon" state is **raw all-zero bytes** (`Pokewalker_ClearBoxMon`), not the encrypted-empty record. |

Verified independently: the Pt trainer, party-count and party offsets match [bulba-sav]. The DP and HGSS values
match [pp-dp] and [pp-hgss]. In verification (§22) the whole Pt save table was recomputed from struct sizes:
`SaveTableEntry_BodySize` = `size + (4 - size%4) + 4`, entries packed in table order. It reproduces general = 0xCF2C,
storage = 0x121E4, PlayerSave 0x64, party 0x98, Pokédex 0x1328, daycare 0x1654, mailbox 0x4E80, Poffin case 0x52E8,
records 0x61B0, Chatot 0x64EC, gift ribbons 0x7F10 and Mystery Gift 0xB4C0, all equal to PKHeX. For DP the same rule
without the extra +4 is consistent with PKHeX's DP Poketch 0x114C, event work 0xD9C and daycare 0x141C. HGSS
(`((size+3)&~3)+4`) is consistent with Pokédex 0x12B8 → daycare 0x15FC. TrainerInfo layout: name[8] u16, id u32, money u32, gender, language, badges, appearance,
gameCode, flag bits, then padding to 0x20 [pt-trainer]. HGSS adds `dummy` at +0x1E and `kantoBadges` at +0x1F
[hg-misc].

Pokémon in daycare, GTS and Pokéwalker are **not** in the boxes. Do not offer them for deposit in v1.

---

## 10. Storage block: PC boxes

### 10.1 Layout

| | DP / Pt (`PCBoxes` [pt-box]) | HGSS (`PokemonStorageSystem` [hg-box]) |
|---|---|---|
| Current box | +0x00 u32 | +0x12000 u32 |
| Box *b*, slot *s* (0-based) | +0x04 + b·0xFF0 + s·0x88 | b·0x1000 + s·0x88 |
| Per-box padding | none (boxes packed) | 0x10 zero bytes after each box (+0xFF0..+0xFFF) |
| Box-modified flags | — | +0x12004 u32 (bit *b*) |
| Box names | +0x11EE4, 18 × 40 bytes (u16[20]; 8 chars + 0xFFFF used) | +0x12008, 18 × 40 bytes |
| Wallpapers | +0x121B4, 18 × u8 | +0x122D8, 18 × u8 |
| Unlocked-wallpaper bits | +0x121C6 u8 | +0x122EA u8 |
| End padding | to 0x121CC / 0x121D0, then footer | 0x122EB..0x122FF filler, then 0x12300 footer |

That gives 18 boxes × 30 slots × 136 bytes. Slots are **fixed positions**, not a packed list: removing a Pokémon never
shifts the others. Stored wallpaper bytes: 0–15 = the 16 default wallpapers in every game. In Pt the 8 unlockable ones
are stored as 0x18–0x1F (`PCBoxes_SetWallpaper` adds 8 to logical IDs 16–23). In HGSS the 8 bonus ones are stored as
0x20–0x27 (`BONUS_WALLPAPER_MIN 32` [hg `constants/box_wallpaper.h`]). PKHeX's `AdjustWallpaper` (+0x08 / +0x10 for
its logical values ≥ 0x10) is the same mapping. Box names default to "BOX 1".. in the game language (§13).

### 10.2 Current box

The current box is the box index 0–17 that the PC opens on. When a box fills, the game advances to the next box with
space (`PCBoxes_TryStoreBoxMon` loops from the current box). We never need to change it.

### 10.3 What the game does when storing into a box

`PCBoxes_TryStoreBoxMonInBox` / `TryStoreBoxMonAt` [pt-box]:

- calls `BoxPokemon_RestorePP` (refills PP to the maximum for the PP-Up count);
- forces **Shaymin to Land form** (`BoxPokemon_SetShayminForm(…, LAND)`);
- treats a slot as empty if `species == NONE`;
- sets `fullSaveRequired`.

HGSS differs [hg `src/pokemon_storage_system.c` `PCStorage_PlaceMon*`]. Its store routines restore PP and set the
box-modified bit, and they do **not** touch Shaymin's form (UNVERIFIED whether the PC UI overlay does). PKHeX also zeroes
walking mood for boxed Pokémon (`SAV4HGSS.SetPKM` sets 0x87 = 0). That is PKHeX's choice, not something the HGSS store
routine does, but it is harmless. Mirror the union of these when injecting into a box: refill PP, Shaymin form 0, and
mood 0 on HGSS.

### 10.4 Empty slots: must be *encrypted zeros*

`BoxPokemon_Init` zeroes all 136 bytes and then **encrypts** the 128 data bytes with seed = checksum = 0 [pt-mon]. A
raw all-zero slot is therefore **not a valid empty slot**. On read, `BoxPokemon_GetValue` decrypts it with seed 0,
which yields the bare keystream. The keystream's word sum is 0xBDDA, not 0, so `checksumFailed` gets set [pt-mon
~L736–755]. The game's own behaviour on such a slot is then inconsistent:

- The decrypted species word is the first keystream word, which is **0x0000** for seed 0. So
  `MON_DATA_SPECIES_EXISTS` reports the slot empty. Most PC code uses that test: counting, the first-empty search, and
  the box UI (`src/pc_boxes.c`, `applications/pc_boxes/*`).
- `MON_DATA_SPECIES` returns `SPECIES_EGG` when `checksumFailed` is set [pt-mon ~L824]. So
  `PCBoxes_TryStoreBoxMonInBox`, which tests that value, treats the slot as occupied (a **Bad Egg**), and debug builds
  hit a `GF_ASSERT`.
- `checksumFailed` (flags bit 2) is set in RAM and stays set, so the next save writes it back.

Never write raw zeros. Always write this canonical empty record (generated by our reference implementation and
re-derived independently in verification; bytes 0–7 are zero):

```
0000: 00 00 00 00 00 00 00 00 00 00 7e e9 71 52 b0 31
0010: 42 8e cc e2 c5 af db 67 33 fc 2c ef 5e fc c5 ca
0020: d6 eb 3d 99 bc 7a a7 cb d6 5d 78 91 a6 27 8d 61
0030: 92 16 b8 cf 5d 37 80 30 7c 40 fb 48 13 32 e7 fe
0040: a3 df 69 3d 9e 63 29 1d 8d ea 96 62 68 92 97 a3
0050: 49 1c 03 6e aa 31 89 aa c5 d3 ea c3 d9 82 c6 e0
0060: 5c 94 3b 4e 5f 5a 28 24 b3 fb e1 bf 8e 7b 7f 00
0070: c4 40 48 c8 d1 bf b6 38 3b 90 23 fb 23 7d 34 be
0080: 00 da 6a 70 c5 df 84 ba
```

The first keystream words from seed 0 are 0x0000, 0xE97E, 0x5271, 0x31B0, ….

**Parser rule:** a slot is empty if its decrypted species is 0 (this matches the game's `MON_DATA_SPECIES_EXISTS`). A
decrypted species ≠ 0 with a checksum mismatch is a Bad Egg: show it as such and never deposit it. A slot with
species 0 **and** a checksum mismatch, typically raw zeros left by a buggy tool, counts as free for `putInBox`. When
we write into it we overwrite all 136 bytes. If we leave it alone, either replace it with the canonical empty record
on `serialize()` (a harmless repair; on HGSS it counts as a box change, so OR the box bit) or at least add a warning.

---

## 11. Party

- `Party { int capacity; int currentCount; Pokemon mons[6]; }` [pt-party]. HGSS appends
  `PartyExtra { u8 aprijuiceModifiers[6][5]; }` [hg-misc].
- The party is a **packed list**. Removal shifts `mons[i+1..count-1]` down one slot and re-initialises the last slot
  with `Pokemon_Init` (zeros, then the 128 box bytes encrypted with seed 0 and the 100 party bytes encrypted with
  seed = PID = 0). It then decrements `currentCount` [pt-party `Party_RemovePokemonBySlotIndex`].
- HGSS shifts `aprijuiceModifiers` the same way and zeroes the vacated entry [hg-misc `Party_RemoveMon`].
- Add: write to `mons[count]`, then `count++` (HGSS also zeroes that aprijuice entry).
- Empty party slots follow the same rule as §10.4: the 136-byte part is encrypted zeros, and the 100-byte party part is
  zeros XORed with the seed-0 keystream.
- **Recommendation:** withdraw into PC boxes only, so we never compute party stats or mail/capsule data. If depositing
  from the party is allowed, keep at least one non-egg Pokémon in it.

---

## 12. PK4: Gen 4 Pokémon structure

Size: **136 bytes** (0x88) boxed ("BoxPokemon"), **236 bytes** (0xEC) in the party (box part + 100-byte battle-stats
part) [pt-mon; pkhex-pk4 `SIZE_4STORED/SIZE_4PARTY`]. The same layout is used by DP, Pt and HGSS. Fields marked Pt/HGSS
are simply unused (0) in DP-origin data.

### 12.1 Field map (decrypted, unshuffled: block A at 0x08, B at 0x28, C at 0x48, D at 0x68)

| Off | Size | Field | Notes |
|---|---|---|---|
| 0x00 | u32 | PID (personality) | Never encrypted. Shuffle key and party-crypt seed. |
| 0x04 | u16 | RAM flags | bit0 `partyDecrypted`, bit1 `boxDecrypted`, bit2 `checksumFailed` (Bad Egg). **Must be 0 in saves** (if bit0/1 is set the game assumes the data is already decrypted). [pt-mon; bulba-pk4] |
| 0x06 | u16 | Checksum | 16-bit sum of the 64 u16 words at 0x08..0x87 (decrypted). Also the encryption seed. |
| **Block A** | | | |
| 0x08 | u16 | Species | National Dex number 1–493 (§14) |
| 0x0A | u16 | Held item | Item ID (§14) |
| 0x0C | u16 | OT TID | |
| 0x0E | u16 | OT SID | |
| 0x10 | u32 | EXP | Level is derived from EXP + species growth rate (§12.4) |
| 0x14 | u8 | Friendship | For **eggs: remaining egg cycles** |
| 0x15 | u8 | Ability | Ability ID (1–123); slot = PID bit 0 (§12.4) |
| 0x16 | u8 | Markings | bit0 ● circle, 1 ▲, 2 ■, 3 ♥, 4 ★, 5 ◆ |
| 0x17 | u8 | Origin language | 1 JPN … 8 KOR (§8) |
| 0x18–0x1D | u8 ×6 | EVs | HP, Atk, Def, **Spe**, SpA, SpD (order!) |
| 0x1E–0x23 | u8 ×6 | Contest | Cool, Beauty, Cute, Smart, Tough, Sheen |
| 0x24 | u32 | Sinnoh ribbons set 1 | §12.6 |
| **Block B** | | | |
| 0x28 | u16 ×4 | Moves | Move IDs 0–467 |
| 0x30 | u8 ×4 | Current PP | |
| 0x34 | u8 ×4 | PP Ups | 0–3 |
| 0x38 | u32 | IVs / flags | bits 0–4 HP, 5–9 Atk, 10–14 Def, 15–19 **Spe**, 20–24 SpA, 25–29 SpD, **bit30 isEgg**, **bit31 isNicknamed** |
| 0x3C | u32 | Hoenn (GBA) ribbons | §12.6 |
| 0x40 | u8 | Fateful / gender / form | bit0 fateful encounter; bits1–2 gender (0 M, 1 F, 2 genderless); **bits3–7 form** (§12.7) |
| 0x41 | u8 | HGSS Shiny Leaves | bits0–4 leaves A–E, bit5 crown [hg-mon `HGSS_shinyLeaves:6`; bulba-pk4]. Bits 6–7 unused. |
| 0x42 | u16 | unused | |
| 0x44 | u16 | Egg location (Pt/HGSS) | §12.8 |
| 0x46 | u16 | Met location (Pt/HGSS) | §12.8 |
| **Block C** | | | |
| 0x48 | u16 ×11 | Nickname | 10 chars + 0xFFFF (JP 5). Holds the species name in the origin language when not nicknamed. |
| 0x5E | u8 | unused | |
| 0x5F | u8 | Origin game | §8 |
| 0x60 | u64 | Sinnoh ribbons set 2 | bits 0–19 used (§12.6) |
| **Block D** | | | |
| 0x68 | u16 ×8 | OT name | 7 chars + 0xFFFF (JP 5) |
| 0x78 | u8 ×3 | Egg date | year−2000, month, day (0 if never an egg) |
| 0x7B | u8 ×3 | Met / hatch date | year−2000, month, day |
| 0x7E | u16 | Egg location (DP field) | §12.8 |
| 0x80 | u16 | Met location (DP field) | §12.8 |
| 0x82 | u8 | Pokérus | high nibble strain, low nibble days left (0 with strain≠0 = cured) |
| 0x83 | u8 | Ball (DP/Pt field) | Ball ID 1–16 (§12.9) |
| 0x84 | u8 | Met level / OT gender | bits0–6 met level (0 for hatched), bit7 OT female |
| 0x85 | u8 | Encounter type / ground tile | §12.10 |
| 0x86 | u8 | HGSS ball | Ball ID 1–24; DPPt leave 0 (§12.9) |
| 0x87 | s8 | HGSS walking mood | 0 when boxed |
| **Party-only (encrypted with PID, not shuffled)** | | | |
| 0x88 | u32 | Status | bits0–2 sleep turns, 3 poison, 4 burn, 5 freeze, 6 paralysis, 7 toxic [bulba-pk4] |
| 0x8C | u8 | Level | Must agree with EXP |
| 0x8D | u8 | Ball-capsule index | 0 = none |
| 0x8E | u16 | Current HP | ≤ max HP |
| 0x90–0x9A | u16 ×6 | Max HP, Atk, Def, **Spe**, SpA, SpD | §12.4 |
| 0x9C | 0x38 | Mail | Mail struct; empty = `Mail_Reset` state: mailType 0xFF, name filled with 0xFFFF, etc. [pt `src/mail.c`] |
| 0xD4 | 0x18 | Ball-capsule seal coordinates | zeros = none |

Sources: [pt-mon] struct comments (block-relative offsets: A 0x00–0x1F, B, C, D), [hg-mon] for 0x41/0x86/0x87,
[pkhex-pk4 PK4] for absolute offsets, [bulba-pk4] (consistent).

### 12.2 Encryption and shuffling (exact)

Constants: LCRNG `x' = x · 0x41C64E6D + 0x6073 (mod 2^32)`. The XOR word is `x' >> 16`, i.e. the RNG is advanced
**before** each use [pt-math `LCRNG_NextFrom`, `EncodeData`].

- **Box part (0x08..0x87):** seed = checksum (u16 @0x06). For i = 0..63: `word[i] ^= next()`. XOR is its own inverse.
- **Party part (0x88..0xEB):** a fresh stream with seed = **PID**, 50 words. Not shuffled.
- **Shuffle:** `sv = ((PID & 0x3E000) >> 13) % 24`, i.e. `((PID >> 13) & 31) % 24`. pret's switch maps 24–31 to the
  same layouts as 0–7 [pt-mon `BoxPokemon_GetDataBlock`].
- The XOR stream runs over the **stored (shuffled) order**. To decrypt: XOR the 128 bytes in place, then unshuffle. To
  encrypt: shuffle, then XOR. PKHeX does the same (`Encrypt45`: shuffle then crypt; `Decrypt45`: crypt then shuffle)
  [pkhex-pk4 PokeCrypto].
- **Checksum** = `sum(u16 words 0x08..0x87) & 0xFFFF`. The sum is order-independent, so shuffled or unshuffled gives the
  same result. Compute it *before* encrypting and store it at 0x06. The game recomputes it on every write
  (`BoxPokemon_ExitDecryptionContext`) and checks it on every read (§10.4).

Shuffle table. `Order` = which block sits in stored positions 0,1,2,3. `Pos(ABCD)` = stored position of A,B,C,D
written as letters; pret's tuple is this column, Bulbapedia calls it "Inverse". It was generated from pret's tuples
and matches [bulba-pk4] row for row.

| sv | Order | Pos(ABCD) | sv | Order | Pos(ABCD) | sv | Order | Pos(ABCD) |
|---|---|---|---|---|---|---|---|---|
| 0 | ABCD | ABCD | 8 | BCAD | CABD | 16 | CDAB | CDAB |
| 1 | ABDC | ABDC | 9 | BCDA | DABC | 17 | CDBA | DCAB |
| 2 | ACBD | ACBD | 10 | BDAC | CADB | 18 | DABC | BCDA |
| 3 | ACDB | ADBC | 11 | BDCA | DACB | 19 | DACB | BDCA |
| 4 | ADBC | ACDB | 12 | CABD | BCAD | 20 | DBAC | CBDA |
| 5 | ADCB | ADCB | 13 | CADB | BDAC | 21 | DBCA | DBCA |
| 6 | BACD | BACD | 14 | CBAD | CBAD | 22 | DCAB | CDBA |
| 7 | BADC | BADC | 15 | CBDA | DBAC | 23 | DCBA | DCBA |

Machine form (stored position of A,B,C,D; index = sv):
`[[0,1,2,3],[0,1,3,2],[0,2,1,3],[0,3,1,2],[0,2,3,1],[0,3,2,1],[1,0,2,3],[1,0,3,2],[2,0,1,3],[3,0,1,2],[2,0,3,1],[3,0,2,1],[1,2,0,3],[1,3,0,2],[2,1,0,3],[3,1,0,2],[2,3,0,1],[3,2,0,1],[1,2,3,0],[1,3,2,0],[2,1,3,0],[3,1,2,0],[2,3,1,0],[3,2,1,0]]`

Verification done: decrypted sample `.pk4` files from PKHeX's test folder (used locally only; GPL data, do not commit)
satisfy `checksum == stored`, and encrypt/decrypt round-trips. The LCRNG and constants match pret. There was no
independent *encrypted* sample, so see §19 for the remaining validation step.

### 12.3 Derived properties

| Property | Formula | Source |
|---|---|---|
| Shiny | `(TID ^ SID ^ (PID>>16) ^ (PID & 0xFFFF)) < 8` | [pt-mon `Pokemon_InlineIsPersonalityShiny`] |
| Nature | `PID % 25` | [pkhex-pk4 G4PKM] |
| Gender | species ratio 0 → always male, 254 → always female, 255 → genderless; else **female if `ratio > (PID & 0xFF)`**. The stored bits 0x40.1–2 must agree. | [pt-mon `SpeciesData_GetGenderOf`] |
| Ability slot | `PID & 1` selects ability 1/2 if the species (in its current form) has two; the **ability ID** is stored at 0x15 | [pt-mon `BoxPokemon_CalcAbility` ~L4746] |
| Unown letter | **= form field** (0x40 bits 3–7). Not recomputed from PID in Gen 4. | [hg-mon `GetBoxMonUnownLetter`; pt-mon `BoxPokemon_GetForm`] |
| Spinda spots | from PID | — |

### 12.4 Level, stats, PP

- Level: the largest L in 1..100 with `expTable[growth][L] <= EXP` (pret `SpeciesData_GetLevelAt` returns the first L
  with `table[L] > EXP`, minus 1, so any EXP above the level-100 value gives level 100). The growth rate comes from
  species data (`exp_rate` in pret `res/pokemon/<name>/data.json` [pt-const]). The standard curves are Fast `4n³/5`,
  Medium-Fast `n³`, Medium-Slow `6n³/5 − 15n² + 100n − 140`, Slow `5n³/4`, plus Erratic and Fluctuating (piecewise).
  **Use the game's own table** rather than the formulas: https://raw.githubusercontent.com/pret/pokeplatinum/main/res/pokemon/.shared/exp_tables.csv
  (CSV columns `level,medium_fast,erratic,fluctuating,medium_slow,fast,slow,unused_6,unused_7`; rows 0–100). Rows 0
  and 1 are **0 for every curve** (this resolves the earlier level-1 question). Row 2 is 8/15/4/9/6/10.
- Stats [pt-mon `Pokemon_CalcLevelAndStats`]. **B = the base stats of the Pokémon's current form**
  (`SpeciesData_LoadForm`). Deoxys, Wormadam, Giratina, Shaymin and Rotom forms have their own stats:
  - HP = `(2·B + IV + EV/4) · L / 100 + L + 10`, with integer division; **Shedinja HP = 1**.
  - Other stats = `(2·B + IV + EV/4) · L / 100 + 5`, then the nature modifier `×110/100` or `×90/100` with integer
    truncation [pt-mon `Pokemon_GetNatureStatValue`].
- Max PP = `basePP + floor(basePP · ppUps / 5)`. The game refills PP when storing in a box (§10.3).
- Arceus: the battle type comes from the held Plate whenever ability = Multitype [pt-mon ~L1221]. Keep form = plate type
  (§12.7).

### 12.5 Eggs

- isEgg = bit 30 of 0x38; friendship holds the remaining egg cycles.
- Nickname = the localized "EGG" string; met/egg data are set per hatching rules.
- PKHeX's handler update for traded eggs (`UpdateHandler`): if a received egg doesn't belong to the trainer, it rewrites
  the met location to 2002 (link trade) with today's date [pkhex-pk4 G4PKM]. Simplest is to **not allow eggs in
  trades / Home in v1**, or to mimic this.

### 12.6 Ribbon bits [pkhex-pk4 PK4; consistent with pt-mon comments]

- **0x24 (set 1)**
  - byte 0x24: b0 Sinnoh Champ, b1 Ability, b2 Great Ability, b3 Double Ability, b4 Multi Ability, b5 Pair Ability,
    b6 World Ability, b7 Alert.
  - byte 0x25: b0 Shock, b1 Downcast, b2 Careless, b3 Relax, b4 Snooze, b5 Smile, b6 Gorgeous, b7 Royal.
  - byte 0x26: b0 Gorgeous Royal, b1 Footprint, b2 Record, b3 Event (History), b4 Legend, b5 World Champion (Red),
    b6 Birthday (Green), b7 Special (Blue).
  - byte 0x27: b0 Souvenir (Festival), b1 Wishing (Carnival), b2 Classic, b3 Premier, b4–7 unused.
- **0x3C (Hoenn)**
  - byte 0x3C: Cool / Super / Hyper / Master (b0–3), Beauty ×4 (b4–7).
  - byte 0x3D: Cute ×4, Smart ×4.
  - byte 0x3E: Tough ×4 (b0–3), b4 Champion, b5 Winning, b6 Victory, b7 Artist.
  - byte 0x3F: b0 Effort, b1 Marine (Battle Champion), b2 Land (Regional Champion), b3 Sky (National Champion),
    b4 Country, b5 National, b6 Earth, b7 World.
- **0x60 (set 2, Sinnoh contest)**
  - byte 0x60: Cool / Great / Ultra / Master (b0–3), Beauty ×4 (b4–7).
  - byte 0x61: Cute ×4, Smart ×4.
  - byte 0x62: Tough ×4 (b0–3), b4–7 unused.
  - bytes 0x63–0x67 unused.

### 12.7 Forms (0x40 bits 3–7) [pt-const `forms.h`; bulba-pk4]

| Species | Values |
|---|---|
| Unown (201) | 0–25 = A–Z, 26 = !, 27 = ? |
| Castform (351) | 0–3, battle only (store 0) |
| Deoxys (386) | 0 Normal, 1 Attack, 2 Defense, 3 Speed |
| Burmy (412) / Wormadam (413) | 0 Plant, 1 Sandy, 2 Trash |
| Cherrim (421) | 0 Overcast, 1 Sunshine (battle only) |
| Shellos (422) / Gastrodon (423) | 0 West, 1 East |
| Rotom (479) | 0 Normal, 1 Heat, 2 Wash, 3 Frost, 4 Fan, 5 Mow (displayed only in Pt/HGSS; per [bulba-pk4] Rotom keeps its form among DPPt) |
| Giratina (487) | 0 Altered, 1 Origin. Pt/HGSS force Origin iff holding the Griseous Orb (`BoxPokemon_SetGiratinaForm` [pt-mon]) |
| Shaymin (492) | 0 Land, 1 Sky. Reverts to Land when stored in the PC (§10.3), at night (20:00–03:59) via `Party_SetShayminForm`, or when frozen |
| Arceus (493) | 0 Normal, 1 Fighting, 2 Flying, 3 Poison, 4 Ground, 5 Rock, 6 Bug, 7 Ghost, 8 Steel, 9 ???, 10 Fire, 11 Water, 12 Grass, 13 Electric, 14 Psychic, 15 Ice, 16 Dragon, 17 Dark. Must match the held Plate (`BoxPokemon_SetArceusForm`) |
| Pichu (172), HGSS | 0 normal, 1 Spiky-eared (cannot go to DPPt) |

### 12.8 Met / egg locations (two copies)

The game writes a location like this [pt-mon ~L1721–1741]:

- if `value == 0` or the location exists in DP: DP field = value **and** Pt/HGSS field = value;
- else: DP field = **3002 (Faraway Place, `FATEFUL_ENCOUNTER_LOCATION`)** and Pt/HGSS field = value.

"Exists in DP" is exactly `1..111 ∪ 2000..2010 ∪ 3000..3076` [pt `src/unk_02017038.c` `sub_0201708C`]. Anything else
(112–1999, 2011–2999, ≥ 3077) gets the 3002 fallback.

On read: if `DP field == 3002 && PtHGSS field != 0`, use the Pt/HGSS field; otherwise use the DP field [pt-mon ~L1159].

DP-origin Pokémon leave 0x44/0x46 = 0. PKHeX's rules give the same results for game-written data
[pkhex-pk4 G4PKM `MetLocation`/`EggLocation`], but they are not identical. PKHeX's *getter* returns the Pt/HGSS
field whenever it is non-zero, regardless of the DP field. Its *setter* treats `> 111 && < 2000` and
`> 2010 && < 3000` as Pt/HGSS-only, and so does not apply the 3002 fallback to values ≥ 3077. **Write with the pret
rule.**

Notable IDs [pkhex-pk4 Locations; PKHeX `text_hgss_00000_en.txt`]: 55 Pal Park (the Gen 3 → 4 transfer location),
2000 Day-Care couple, 2002 Link trade, 3001 Pokémon Ranger, 3002 Faraway Place, 233 Pokéwalker, 126–232 HGSS
Johto/Kanto, 0–111 DP Sinnoh, 112–125 Pt additions.

### 12.9 Balls

Ball IDs 1 Master, 2 Ultra, 3 Great, 4 Poké, 5 Safari, 6 Net, 7 Dive, 8 Nest, 9 Repeat, 10 Timer, 11 Luxury, 12 Premier,
13 Dusk, 14 Heal, 15 Quick, 16 Cherish; HGSS adds 17 Fast, 18 Level, 19 Lure, 20 Heavy, 21 Love, 22 Friend, 23 Moon,
24 Sport (25 Park defined but unused) [hg-misc `balls.h`]. For 1–16 the ball ID equals the item ID.

HGSS write [hg-mon ~L1298]:
- Master..Cherish items: both fields = ID;
- Fast..Sport items (492–499): HGSS field = item − 475, DP field = 4 (Poké Ball).
- Any other value (including Park Ball item 500) writes nothing; it only fires a `GF_ASSERT` when the value is 0.

HGSS read: uses the HGSS field **only if origin game ∈ {7, 8} and the field ≠ 0**, else the DP field [hg-mon ~L833].
PKHeX displays `max(HGSS field, DP field)`. Write Apricorn balls only for HGSS-origin Pokémon.

### 12.10 Encounter type / ground tile (0x85)

PKHeX `GroundTileType`:
- 0 None, 1 Sand, 2 Grass, 3 Puddle, 4 Rock, 5 Cave, 6 Snow, 7 Water, 8 Ice, 9 Building, 10 Marsh, 11 Bridge,
  12 = DP catch-all (starter, fossil, gift);
- Pt: 12–16 Elite Four rooms, 17 Distortion sideways, 18–22 Battle Tower/Factory/Arcade/Castle/Hall, 23 Distortion,
  24 = Pt/HGSS catch-all.

[bulba-pk4] uses the same values with different labels: 0x0 Pal Park/egg/event, 0x2 grass, 0x4 Dialga/Palkia event,
0x5 cave, 0x7 water, 0x9 building, 0xA Great Marsh, 0xC DP starter/fossil/gift, 0x18 Pt/HGSS starter/fossil/gift. They
agree.

---

## 13. Text encoding

- Each character is a 16-bit code from one global table shared by all Gen 4 languages. **Terminator 0xFFFF**
  (`CHAR_EOS`); 0x0000 = `CHAR_NONE` [pt-char `charcode.h`]. PKHeX also stops at 0x0000 when reading
  [pkhex-pk4 StringConverter4].
- **Machine-readable table:** https://raw.githubusercontent.com/pret/pokeplatinum/main/tools/msgenc/charmap.txt
  - Format: lines of `HHHH=<char>` or `HHHH={COMMAND}`, `//` comments, 2903 lines.
  - Same file in HGSS: https://raw.githubusercontent.com/pret/pokeheartgold/master/tools/msgenc/charmap.txt (lacks
    0x0600/0x0602/0x0603 command aliases).
  - DP: https://raw.githubusercontent.com/pret/pokediamond/master/charmap.txt
- Code ranges in the table:
  - 0x0001–0x00DF and 0x00E1–0x0120: full-width Japanese (0x0001 full-width space, kana, full-width alphanumerics and
    punctuation, 0x00EE/0x00EF full-width ♂/♀; pret writes these two as ㊚/㊛ U+329A/U+329B, PKHeX as ♂/♀). 0x00E0 is
    unassigned.
  - 0x0121–0x01EA: half-width Latin. 0x0121–0x012A '0'–'9', **0x012B–0x0144 'A'–'Z'**, 0x0145–0x015E 'a'–'z',
    0x015F–0x01A2 accented letters and Œœ/Şş, 0x01A3–0x01DD ordinals, superscripts, punctuation and symbols,
    **0x01BB ♂, 0x01BC ♀ (half-width)**, **0x01DE space**, 0x01DF–0x01EA misc (0x01E8 °, 0x01E9 _, 0x01EA ＿).
    pret leaves 0x01E3–0x01E7 unassigned.
  - **Korean Hangul, 0x0400/0x0401–0x0D65.** Common gaps: 0x0D2F–0x0D30 and 0x0D52–0x0D60. 0x0D31–0x0D51 are jamo
    (pret uses conjoining U+11xx, PKHeX compatibility U+31xx; same letters). **Disagreement at the start:** pret maps
    0x0400–0x040E to 가…갗 and leaves 0x040F unassigned. PKHeX `TableKOR` leaves 0x0400 empty and maps 0x0401–0x040F
    to 가…갗. From 0x0410 (같) on, both agree. PKHeX's version is contiguous in KS X 1001 order (pret's has a hole
    between 갗 and 같), and PKHeX was built against retail Korean games, so **prefer PKHeX for 0x0400–0x040F**.
    UNVERIFIED without a Korean save; pret builds no Korean ROM.
  - Line/page control codes: 0xE000 `\n`, 0x25BC `\r`, 0x25BD `\f`. Never in names.
- **Parsing gotcha:** the charmap contains *duplicate keys*. Command aliases (`0100={STRVAR_1}`, `0400={STRVAR_4}`,
  `0600={STRVAR_6}`, …) come after the glyph entries (`0100=○`, `0400=가`). Keep the **first** mapping for name
  decoding.
- **Glyph-mapping disagreement:** pret maps codes to semantic Unicode (for example 0x01BB → U+2642 ♂). A
  code-by-code diff of 0x0001–0x01EC against PKHeX `TableINT` (§22) finds **71 differing codes**:
  - 46 symbol codes (0x010B–0x0111, 0x0176, 0x0196, 0x01A5–0x01A7, 0x01AF, 0x01C6–0x01DD except 0x01D0/0x01D2,
    0x01DF–0x01E7, 0x01EB–0x01EC) go to PKHeX's stand-ins for *Gen 5 in-game code points* (U+2460–U+248F ①…⒏), and
    0x01BB/0x01BC go to U+246D/U+246E. That is what Gen 4 → 5 transfer needs [pkhex-pk4 StringConverter4Util].
  - The other 23 are look-alike glyph choices: 0x00EE/0x00EF (above), 0x00E5 ⋯/…, 0x00F1 －/ー, 0x00F2 ⊗/×, 0x00F3 ⊘/÷, 0x00FA–0x00FE outline
    vs filled suits/star, 0x0105, 0x0107–0x010A, 0x0112 ¥/円, 0x011F, 0x01B0, 0x01B3 ’/', 0x01B7/0x01B8 《》/«».
  - 0x00F5 is 'ｚ' in pret, a duplicate of 0x00DF and so a placeholder; PKHeX has '～'.
  **Recommendation:** store the raw u16 code arrays in Home alongside a display string. Re-emit the raw codes when
  writing back to Gen 4. Use pret's map only for display, and a dedicated Gen 4 → 5 table for conversion (see
  `format-gen5`).
- **Max lengths** (buffer / visible):
  - OT and trainer: u16[8] / 7 (Japanese 5).
  - Nickname: u16[11] / 10 (Japanese 5).
  - Box name: u16[20] / 8 [pt-const `string.h` `BOX_NAME_LEN 8`].
  - Rival: u16[8].
  - Bytes after the terminator are "trash" the game ignores. Write 0xFFFF then zeros (PKHeX `ClearZero`); PKHeX
    legality checks may inspect trash, but the game does not.
- Korean D/P/Pt: a not-nicknamed Nidoran uses **full-width** gender symbols, while every other Gen 4/5 case uses
  half-width [pkhex-pk4 G4PKM `CheckKoreanNidoranDPPt`].

---

## 14. Index mappings (machine-readable sources)

- **Species:** internal index == **National Dex number** (1–493). 0 = none, 494 = `SPECIES_EGG`, 495 = `SPECIES_BAD_EGG`
  (internal only; a stored egg has its real species plus isEgg).
  - https://raw.githubusercontent.com/pret/pokeplatinum/main/generated/species.txt (496 lines; line *n* (0-based) =
    index *n*).
  - Per-species base stats, gender ratio, abilities, growth rate, learnsets:
    `https://raw.githubusercontent.com/pret/pokeplatinum/main/res/pokemon/<name>/data.json`. `<name>` is the
    lower-case constant name without the prefix (`nidoran_f`, `mr_mime`, `ho_oh`, `porygon_z`, `farfetchd`; also
    `egg`, `bad_egg`, `none`), so derive it from `species.txt` rather than display names. The values are symbolic:
    `gender_ratio` is e.g. `GENDER_RATIO_FEMALE_50`, with numbers in
    https://raw.githubusercontent.com/pret/pokeplatinum/main/generated/gender_ratios.txt (MALE_ONLY 0, 12.5% 31,
    25% 63, 50% 127, 75% 191, 87.5% 223, FEMALE_ONLY 254, NO_GENDER 255). `exp_rate` is e.g. `EXP_RATE_MEDIUM_FAST`
    (order in `generated/exp_rates.txt`; table in §12.4).
- **Moves:** 1–467, the same in all Gen 4 games. https://raw.githubusercontent.com/pret/pokeplatinum/main/generated/moves.txt
  (469 lines: line 0 `MOVE_NONE`, last line a `MAX_MOVES` sentinel; drop it).
- **Abilities:** 1–123. https://raw.githubusercontent.com/pret/pokeplatinum/main/generated/abilities.txt (124 lines,
  line 0 `ABILITY_NONE`).
- **Items:**
  - Pt https://raw.githubusercontent.com/pret/pokeplatinum/main/generated/items.txt (0–467; 469 lines, the last a
    `MAX_ITEMS` sentinel).
  - HGSS https://raw.githubusercontent.com/pret/pokeheartgold/master/include/constants/items.h (0–536; Apricorn balls
    Fast..Sport 492–499 and Park Ball 500, Jade Orb 532, Lock Capsule 533, Red/Blue Orb 534/535, Enigma Stone 536).
  - **Max valid held-item ID:** DP 464, Pt 467, HGSS 536 [pkhex-pk4 Legal]. Mail items are 137–148 (Grass..Brick).
- Gen 4 item IDs are **not** Gen 3 item IDs. Gen 3 → 4 conversion needs a remap (see `format-gen3`). Gen 4 and Gen 5
  share the same item numbering for 0–536 (UNVERIFIED here; see `format-gen5`).

---

## 15. Pokédex (seen/caught and extras)

Pokédex base offsets in the general block: DP 0x12DC, Pt 0x1328, HGSS 0x12B8 [pkhex-sav]. Only the current general copy
needs updating. There is one copy per partition, as part of the block.

### 15.1 Common prefix (all three) [pt-dex; dp-save `pokedex.h`; hg-dex]

| Dex off | Size | Field |
|---|---|---|
| 0x000 | u32 | magic 0xBEEFCAFE (checked only by debug asserts; keep it) |
| 0x004 | 0x40 | caught bits: bit `(species-1)`, byte `(species-1)>>3`, bit `(species-1)&7` |
| 0x044 | 0x40 | seen bits (same indexing) |
| 0x084 | 0x40 | "first-seen gender" bits (0 = male or genderless, 1 = female) |
| 0x0C4 | 0x40 | "second gender" bits |
| 0x104 | u32 | Spinda PID (set when Spinda is first seen) |
| 0x108 | u8 | Shellos form order (2-form scheme) |
| 0x109 | u8 | Gastrodon form order |
| 0x10A | u8 | Burmy form order (3-form scheme) |
| 0x10B | u8 | Wormadam form order |
| 0x10C | u8[28] | Unown letters in **seen** order, 0xFF = empty |

- **Deoxys forms:** four 4-bit slots in the **top byte of caught word 15** (dex 0x043: low nibble = slot 0, high nibble
  = slot 1) and of **seen word 15** (0x083: slots 2, 3). 0xF = empty. Species bits only reach index 492, so these bits
  are free [pt-dex `WriteBit_Deoxys`].
- **2-form scheme:** bit0 = first form seen, bit1 = second. The first sighting writes the form into both bits; if
  bit0 == bit1, one form has been seen. Initialised to 0xFF.
- **3-form scheme:** three 2-bit slots, 3 = empty. Initialised to 0xFF [pt-dex].
- In the 2-form, 3-form and Rotom schemes the game counts forms (`NumFormsSeen_*`) as **0 whenever the species' seen
  bit is clear**, whatever the bytes hold. That is why the form update must run *before* the seen bit is set
  (§15.3 order): on a first sighting it writes the first slot, and for the 2-form scheme both bits.

### 15.2 Game-specific tail

| | DP (size 0x13C) | Pt (size 0x324) | HGSS (size 0x340) |
|---|---|---|---|
| Unown caught order | — | — | 0x128 u8[28] |
| Language flags | 0x129 u8[14], one byte per "meister" species in the order 23, 25, 54, 77, 120, 129, 202, 214, 215, 216, 228, 278, 287, 315 | 0x128 + **species** (u8[496]) | 0x144 + **species** (u8[496]) |
| Form/lang/dex flags | 0x128 genders-unlocked, 0x137 foreign-entries, 0x138 Sinnoh dex, 0x139 National dex | 0x318 canDetectForms, 0x319 canDetectLanguages, 0x31A dex obtained, 0x31B national | 0x334, 0x335 international, 0x336 dex enabled, 0x337 national |
| Rotom form order | — | 0x31C u32: 6 × 3-bit, 7 = empty | 0x338 |
| Shaymin / Giratina order | — | 0x320 / 0x321 (2-form) | 0x33C / 0x33D |
| Pichu order (3-form) | — | — | 0x33E. Slot value 0 = male, 1 = female, 2 = Spiky-eared |

Offsets come from the pret struct definitions and agree with PKHeX's `Zukan4`. PKHeX computes the language base as
`0x108 + (HGSS ? 0x3C : 0x20)`, and the form base 2 as language base + 0x1F4.

**Language bit index** (pret `PokedexLanguage_LanguageToIndex` [pt-dex] and HGSS `LanguageToDexFlag` [hg-dex]):
JPN → 0, ENG → 1, FRE → 2, **GER → 3, ITA → 4**, SPA → 5. Korean is not tracked (the lookup fails and nothing is set).

**Disagreement:** PKHeX `Zukan4.GetGen4LanguageBitIndex` maps Spanish (7) and Korean (8) to bit 0 (the Japanese bit),
because its switch maps `lang-1 > 5` to 0. **We follow pret: Spanish = bit 5, Korean = none.** UNVERIFIED for
Korean-region ROMs, which pret does not build.

### 15.3 Registering a received Pokémon (do what `Pokedex_Capture` does) [pt-dex; hg-dex `Pokedex_SetMonCaughtFlag`]

Skip eggs and species outside 1..493.

1. If not seen yet: if Spinda, set the Spinda PID. Set *both* gender bit arrays to the Pokémon's gender (genderless
   counts as male, bit 0).
2. Else if the first-seen gender bit ≠ gender: set the second-gender bit to gender.
3. Update form tracking:
   - Unown: append the letter to the seen list if absent; HGSS also appends to the caught list.
   - Burmy/Wormadam: append to the 3-form scheme.
   - Shellos/Gastrodon/Shaymin/Giratina: 2-form scheme.
   - Deoxys: nibble slots.
   - Rotom: 3-bit slots.
   - HGSS Pichu: 3-form scheme with the gender-based value.
4. Set the language bit (Pt/HGSS: byte `base+species`; DP only for the 14 meister species).
5. HGSS: if the language ≠ the game's language, set `enabledInternational` (0x335).
6. Set the caught bit, then the seen bit.

---

## 16. Withdrawing into a specific game: compatibility sanitising

| Issue | DP | Pt | HGSS | Source / rationale |
|---|---|---|---|---|
| Held item > max (464 / 467 / 536) | strip | strip | strip | [pkhex-pk4 Legal] |
| Mail items (137–148) in a **box** | strip or refuse | same | same | The PC requires removing mail first, and box records have no mail storage |
| Giratina-Origin / Griseous Orb | form 0, strip orb (item 112) | ok (form follows orb) | ok | [pt-mon] |
| Shaymin-Sky | form 0 | form 0 when boxed | form 0 when boxed | §10.3 |
| Rotom forms | keep (DP shows normal) | ok | ok | [bulba-pk4] |
| Spiky-eared Pichu (form 1) | refuse | refuse | ok | HGSS blocks this trade in-game. PKHeX `StripPtHGSSContent` zeroes forms for species without DP forms. |
| Arceus | form must match plate | same | same | [pt-mon] |
| Apricorn ball | DP field 4 + HGSS field set only if HGSS origin | same | same | §12.9 |
| Walking mood 0x87 | 0 | 0 | 0 when boxed | [pkhex-sav SAV4HGSS] |
| Shiny leaves 0x41 | keep (ignored) | keep | shown | |
| Gen 3-origin Pokémon | must already be converted to PK4 (Pal Park rules, location 55) | | | see `format-gen3` |
| Gen 5-origin Pokémon | **not representable in-game** (no backward transfer). Moves/abilities beyond Gen 4, hidden abilities, Gen 5 balls/items/species are invalid; refuse in v1. | | | |

---

## 17. Platinum PC port (cybervisi0n/pokeplatinum, "pc_port")

- Native 64-bit Windows/Linux (and Switch homebrew) port built from the pret decomp plus **libntr**, an MIT
  replacement for NitroSDK. Reported release 2026-05-26 [port GBAtemp]. The repo was created 2026-06-13 and pushed
  2026-10-10 (GitHub API). It is **US Platinum only**, and the prebuilt binaries need the user's CPUE ROM [port
  README].
- **Save file:** `save.bin` in the working directory, implemented in libntr `include/nitro/card/backup.h` [ntr]:
  - `CARDi_ReadBackup`: if the file is missing, it is created **zero-filled** with length `src + len` of that first
    read. Reads use `fseek(src)` + `fread`. A read past EOF fills nothing: the destination buffer keeps whatever it
    held, which is not necessarily zero.
  - `CARDi_WriteBackup` / `WriteAndVerifyBackup`: `fseek(dst)` + `fwrite`. The file grows as needed, and the OS
    zero-fills any gap.
  - The partition bases (0x0 / 0x40000), the sector size, the footer format, the signature (0x20060623), the CRC and
    the selection logic are the DS ones. The port's `savedata.c` differs from pret only in pointer-width casts
    [port `src/savedata.c` diff].
  - **But the block sizes and every in-block offset are computed from `sizeof()` at run time**
    (`SaveTableEntry_BodySize`). The port is a native 64-bit GCC build with **no struct packing** except `Pokemon`,
    which is `__packed__` to keep 0xEC [port `include/struct_defs/pokemon.h`; no `pack`/`aligned` flags in its
    `meson.build` or cross files]. On x86-64, `s64`/`u64` are 8-byte aligned, where the DS compiler used 4. That
    changes every struct holding one (`SystemData` via `GameTime`, `BoxPokemon` via `ribbonsDS2`, and so `PCBoxes` and
    `Daycare`), and everything after them. See §17.1. **A DS/emulator Platinum save is not byte-compatible with
    `save.bin`, in either direction.** This matches the early release note quoted by GBAtemp that the save "is
    currently not compatible with emulators". The current README is silent on it.
- Differences from an emulator `.sav`:
  1. Never-written areas are **0x00, not 0xFF**.
  2. The file **may be shorter than 0x80000**, for example ending after the last region written.
  3. Different general/storage block sizes and offsets (§17.1).
  4. The port is built with `GAME_LANGUAGE=LANGUAGE_ENGLISH` and `GAME_VERSION=VERSION_PLATINUM`, so trainer
     language is 2 and new Pokémon are ENG, even when the user swaps in other-language text NARCs (a README feature).
- The `BoxPokemon` record itself is byte-identical (0x88; PID/flags/checksum, then 4 × 32-byte blocks at +8), and so
  is the 0xEC party `Pokemon`. Only its position in the blocks changes. The same PK4 codec works for both.
- Handling:
  - Parse with a virtual 0x80000 view padded with 0x00 (all-zero footers are invalid, which the selection logic
    tolerates). Detect the port by its block sizes (§17.1, §8), not by file length.
  - Write back preserving the original length unless a modified block extends past it.
  - **Port ↔ emulator conversion is not a padding job.** It would mean re-laying-out every save-table entry. Out of
    scope: refuse it, and move Pokémon between the two only via Home.
  - **Still needs one real `save.bin` sample** to confirm §17.1 before we claim support.

### 17.1 Platinum PC port layout (computed, UNVERIFIED against a real file)

Method (§22): every save-table entry's size was measured by compiling the port's own headers (commit 35067868,
2026-10-10, with libntr / libntrsystem / libntrdwc / libntrwifi headers) for x86-64 Linux. Those sizes were run
through the game's `SavePageInfo_Init` / `SaveBlockInfo_Init` arithmetic. A control build of the same headers for
i386, which aligns 64-bit members to 4 like the DS compiler, reproduces every retail Pt value (0xCF2C, 0x121E4,
Pokédex 0x1328, daycare 0x1654, mailbox 0x4E80, rival 0x27E8, …). The Win64 build should match Linux (LLP64:
`u32` = `unsigned long` = 4 bytes, `long long` 8-aligned), and so should the Switch (AArch64) build; neither was
measured, so both are UNVERIFIED.

| Item | DS Platinum | PC port (x86-64) |
|---|---|---|
| General block (per partition) | 0x00000–0x0CF2B (0xCF2C), footer 0x0CF18, CRC length 0xCF18 | **0x00000–0x0CF3F (0xCF40), footer 0x0CF2C, CRC length 0xCF2C** |
| Storage block | 0x0CF2C–0x1F10F (0x121E4), footer 0x1F0FC, CRC length 0x121D0 | **0x0CF40–0x1F12B (0x121EC), footer 0x1F118, CRC length 0x121D8** |
| Adventure start / HoF time (s64) | 0x34 / 0x3C | 0x38 / 0x40 |
| `PlayerSave` / trainer name | 0x64 / 0x68 | 0x70 / 0x74 (all §9 trainer fields +0x0C: TID 0x84, SID 0x86, money 0x88, gender 0x8C, language 0x8D, gameCode 0x90, coins 0x94, play time 0x96/0x98/0x99) |
| Party capacity / count / mons | 0x98 / 0x9C / 0xA0 | 0xA4 / 0xA8 / 0xAC (stride 0xEC) |
| Map / X / Y | 0x1280 / 0x1288 / 0x128C | 0x128C / 0x1294 / 0x1298 |
| Pokédex (internal layout unchanged) | 0x1328 | 0x1334 |
| Daycare | 0x1654, 2 × 0xEC | 0x1660, 2 × **0xF0** |
| Rival name / mailbox | 0x27E8 / 0x4E80 | 0x27FC / 0x4E94 |
| Storage: current box | +0x00 u32 | +0x00 u32, then 4 padding bytes |
| Storage: box *b* slot *s* | +0x04 + b·0xFF0 + s·0x88 | **+0x08** + b·0xFF0 + s·0x88 |
| Storage: names / wallpapers / unlocked bits | +0x11EE4 / +0x121B4 / +0x121C6 | +0x11EE8 / +0x121B8 / +0x121CA |

Partition B is the same plus 0x40000. Selection (§6.2) and write strategy (§7.1, §7.3) are unchanged. Robust detection
that needs no size table: footers are self-describing. Scan candidate general sizes G (multiples of 4, 0xC000..0x10000)
for `u32@(p+G-0xC) == G`, signature at `p+G-8`, id 0 at `p+G-4` and a valid CRC. Then do the same for storage at
`p+G` (HGSS: at `p + roundup(G, 0x100)`). Use this only as a fallback that flags a save as "unknown layout": field
offsets inside the blocks still have to come from a known table.
- No HGSS or DP PC ports or static recompilations were found as of 2026-10 (web search). If one appears and is built
  on libntr, expect the same `save.bin` behaviour.

---

## 18. Japanese and Korean versions

- **Layout:** PKHeX uses the same block sizes and offsets for every language. It recognises JP and KR saves by the
  footer size field alone, so if Japanese or Korean sizes differed it could not open them; this is strong evidence
  the layouts are identical.
- **Signature:** JP/INT use 0x20060623 (a BCD date, "2006-06-23"). Korean uses 0x20070903 per PKHeX. **Preserve the
  input's signature** when writing: the game rejects a footer whose signature differs from its own (§5.1), so a
  Korean save does not load in a US ROM.
- **Text:** one shared table (§13); Hangul codes 0x0400–0x0D65 (pret and PKHeX disagree by one code for
  0x0400–0x040F, §13). Japanese names are at most 5 characters (buffers
  unchanged). Japanese uses full-width ♂/♀ (0x00EE/0x00EF); others use half-width.
- **Pokédex:** Korean-language Pokémon set no language bit in the international games [pt-dex]. UNVERIFIED for Korean
  ROMs.
- **HGSS Pokéwalker:** the set of courses unlockable per region differs. PKHeX lists masks JPN 0x07FFFFFF,
  KOR 0x037FFFFF, INT 0x027FFFFF; we don't touch them.
- **Supportability:** parse and write all three regions. Mark Korean as "best effort" until tested with a real save.

---

## 19. Test vectors and validation without real saves

### 19.1 Known-answer tests

| Test | Expected |
|---|---|
| CRC16-CCITT-FALSE("123456789") | 0x29B1 |
| LCRNG from seed 0, first four `x>>16` | 0x0000, 0xE97E, 0x5271, 0x31B0 |
| Canonical empty box record | §10.4 hex |
| Word sum of the seed-0 keystream (64 words), i.e. a raw-zero slot's computed checksum | 0xBDDA (≠ 0, so Bad Egg) |
| Canonical empty party record bytes 0x88..0x8F | `00 00 7e e9 71 52 b0 31` (the seed-0 keystream again, since PID = 0) |
| Shuffle `sv` for PID 0x12345678 | 2 (ACBD) |

Synthetic PK4 regression vector. It was generated by our own reference implementation from first principles, so it
guards against regressions but is **not** an independent oracle. In verification (§22) a second implementation, written
separately from pret `EncodeData`/`BoxPokemon_GetDataBlock`, reproduced the checksum, ENCRYPTED from PLAIN, and PLAIN
from ENCRYPTED byte for byte. Every field decodes as listed below (species 25, EXP 1000, IV word 0x3FFFFFFF, byte 0x40 =
2 female, met 26/10/24, locations 16/16, ball 4, met level 5, tile 2). That makes it two independent implementations
from one source, still not a retail oracle.

- Pikachu, PID 0x12345678, TID 12345, SID 54321, EXP 1000, friendship 70, ability 9, ENG.
- Moves ThunderShock/Growl with PP 30/40, IVs all 31, female.
- Nickname "PIKACHU", OT "JBRO", origin Pt (12), met 2026-10-24 at location 16 (Route 201) in both fields.
- Poké Ball, met level 5, grass (2).

Checksum **0xCDBD**.

```
PLAIN (unshuffled, checksum field filled)
0000: 78 56 34 12 00 00 bd cd 19 00 00 00 39 30 31 d4
0010: e8 03 00 00 46 09 00 02 00 00 00 00 00 00 00 00
0020: 00 00 00 00 00 00 00 00 54 00 2d 00 00 00 00 00
0030: 1e 28 00 00 00 00 00 00 ff ff ff 3f 00 00 00 00
0040: 02 00 00 00 00 00 10 00 3a 01 33 01 35 01 2b 01
0050: 2d 01 32 01 3f 01 ff ff 00 00 00 00 00 00 00 0c
0060: 00 00 00 00 00 00 00 00 34 01 2c 01 3c 01 39 01
0070: ff ff 00 00 00 00 00 00 00 00 00 1a 0a 18 00 00
0080: 10 00 00 04 05 02 00 00
ENCRYPTED (stored form)
0000: 78 56 34 12 00 00 bd cd 2c 5c 30 d1 5b ef 0c f4
0010: c5 a8 eb be d8 f0 56 88 dd 05 d2 2e 7f 04 27 96
0020: 06 88 ab 54 7b bf f9 90 7c 32 6c 7a 84 65 13 c4
0030: 90 0f f9 74 12 4a 97 b6 f3 9c d7 48 6a 69 59 c6
0040: f9 cb c8 62 17 7c 9a c4 99 c3 ff f3 1d d5 2b e1
0050: 1c 1f f1 3b e1 16 75 69 5f e6 06 de c6 5f 7e 06
0060: 4a e2 ea a7 f5 a9 48 3f af b8 a5 11 63 62 e3 6b
0070: 23 c4 2b ca 03 82 92 08 d4 b0 d3 e8 66 80 f9 b4
0080: e5 dd 7f 8d 78 ac e8 2c
```

**One-time independent validation (manual, not in CI):** write the encrypted record into a synthetic save (§19.2),
open it in PKHeX (as a user tool, not a dependency), and confirm it shows "PIKACHU / JBRO / Lv 10 / female / Pt".
Also confirm that the PKHeX-exported decrypted `.pk4` is byte-identical to PLAIN. Then load the same save in
melonDS/DeSmuME with a legally dumped ROM and confirm there is no "corrupted" message and no Bad Egg.

### 19.2 Building synthetic saves (fixtures we can commit; MIT)

1. `buf = new Uint8Array(0x80000).fill(0xFF)`.
2. General block for game G at partition B (0x40000):
   - zero the block body;
   - write trainer fields (§9): name in charmap codes + 0xFFFF, TID, SID, gender, language, gameCode (DP 0, Pt 12,
     HG 7);
   - party capacity 6, count *n*, *n* encrypted 236-byte records, then the canonical empty party records;
   - Pokédex init: magic 0xBEEFCAFE; Unown arrays 0xFF; form bytes 0xFF; Rotom 0xFFFFFFFF; Deoxys nibbles 0xF.
3. Footer: DP/Pt `saveCounter=1, blockCounter=1, size, 0x20060623, id 0, CRC`; HGSS `count=1, size, magic, slot 0,
   CRC`.
4. Storage block at partition B + sStart: current box 0, every slot = the canonical empty record, names "BOX 1".."BOX
   18" encoded (`B`=0x012C, `O`=0x0139, `X`=0x0142, space 0x01DE, digits 0x0121+d), wallpapers 0..15,0,1;
   footer id 1, same counters.
5. Variants for the selection logic (§6), each with its expected verdict:
   - (a) partition A all 0xFF → OK, B;
   - (b) both partitions valid, A newer by `blockCounter` only (normal save) with storage only in B → OK
     (gen A + sto B);
   - (c) newest general's `saveCounter` ≠ newest storage's → CORRUPT;
   - (d) bad CRC in the newest general. DP/Pt: with both storage copies valid → CORRUPT (row PARTIAL/VALID, loads
     the older general with the storage whose `saveCounter` matches it). With only the one storage copy that sits in the
     surviving general's partition → **OK** (PARTIAL/PARTIAL, same partition). HGSS: with both subs valid → SLOT_FAIL
     (row 1/2);
   - (e) the 0xFFFFFFFF ↔ 0 wrap;
   - (f) HGSS: newer main has a mismatched sub count → SLOT_FAIL / TOTAL_FAIL as tabled.
6. Round-trip tests:
   - parse → deposit (slot becomes the canonical empty record; storage CRC updated; HGSS flag bit set) → re-parse;
   - withdraw → re-parse;
   - assert all bytes outside the touched ranges are unchanged.
7. Container tests: the same image wrapped as `.dsv` (append a 0x7A trailer ending in `|-DESMUME SAVE-|`), `.duc`
   (prepend 0xA4 bytes), and PC-port style (truncate to the last non-zero byte, fill unwritten areas with 0x00). A
   real port fixture must also use the §17.1 block sizes and offsets. A truncated DS image only tests the container
   handling, and a correct parser must reject it as "not a port layout".
8. Property tests: random PIDs over all 32 values of `(PID>>13)&31` → encrypt/decrypt identity; checksum
   invariance under shuffle.

---

## 20. Gotchas (collected)

1. **Encrypted-empty slots:** writing raw zeros creates Bad Eggs (§10.4). The Pokéwalker slot is the one exception:
   its "no Pokémon" state *is* raw zeros (§9).
2. **Flags word @0x04 must be 0.** Bits 0–1 make the game skip decryption; bit 2 marks a Bad Egg.
3. **XOR stream order:** the stream is applied to the *shuffled* stored layout. Shuffle first, then XOR, when
   encrypting.
4. **The party part uses a separate stream seeded by the PID** and is not shuffled.
5. **DP/Pt link rule:** the current general and current storage must have equal `saveCounter`, but they may sit in
   different partitions. Never invalidate the backup general (that causes CORRUPT, §6.2).
6. **HGSS loads both blocks from one partition**, and its incremental box writes require OR-ing the touched boxes into
   storage+0x12004. Otherwise the next in-game save leaves a stale box in the other partition and its storage CRC
   fails.
7. **The HGSS storage has 0x10 bytes of padding per box** (stride 0x1000), and curBox/flags sit *after* the boxes.
   DP/Pt put curBox first (+0) and pack boxes at stride 0xFF0 from +4.
8. **The first save is in partition B**; partition A may be all 0xFF. In the PC port, all 0x00.
9. **The DP version byte is 0**: Diamond and Pearl are indistinguishable from the save layout.
10. **EV/IV/stat order is HP, Atk, Def, Spe, SpA, SpD**, not Showdown's HP/Atk/Def/SpA/SpD/Spe.
11. **Dual location fields** with Faraway Place (3002) as the DP fallback (§12.8).
12. **Dual ball fields** in HGSS, and the HGSS field is shown only for HGSS-origin Pokémon (§12.9).
13. **Forms that the game recomputes or reverts:** Shaymin (boxing, night, freeze), Giratina (orb), Arceus (plate).
    Castform/Cherrim are battle-only.
14. **Eggs:** friendship = cycles; traded eggs get their met data rewritten.
15. **Mail:** only party Pokémon carry mail data (0x9C). Box records cannot.
16. **The charmap has duplicate keys** (glyph vs command alias), and PKHeX's glyph mapping differs from pret's for
    symbols. Keep raw codes.
17. **The Korean signature differs.** Preserve it.
18. **Never touch** HoF / Battle Hall / video blocks, the RTC/system data, the daycare, GTS or Pokéwalker data.
19. **Close the emulator** before importing an edited save.
20. Party count is a 32-bit int (PKHeX reads 1 byte). Write the full u32.
21. **The Platinum PC port is a different layout** (general 0xCF40, storage 0x121EC with boxes at +8; §17.1). Don't
    treat `save.bin` as a padded DS save.

---

## 21. Open questions / UNVERIFIED items

- The Korean signature 0x20070903 for each of DP/Pt/HGSS (PKHeX only; pret has no KR build).
- ~~The complete list of HGSS sub-chunks with embedded CRCs~~ **Resolved** (§4): none covers party, storage or dex.
- PC port: the §17.1 layout is computed from the port's headers (x86-64 Linux), not observed. Confirm with one real
  `save.bin`, and confirm that Win64/Switch builds match Linux. DS ↔ port conversion is not supported.
- ~~The level-1 values of the EXP tables~~ **Resolved** (§12.4): 0 for every curve (pret `exp_tables.csv`).
- ~~The Pokéwalker struct start~~ **Resolved** (§9): 0xE5DC, BoxPokemon at 0xE5E0. Still open: whether a walking
  Pokémon is removed from its box. The setter is called only from an overlay that was not checked.
- Korean text codes 0x0400–0x040F: pret and PKHeX are off by one (§13). PKHeX is preferred; confirm with a Korean
  save.
- HGSS: whether the PC UI (outside the decompiled `PCStorage_*` helpers) forces Shaymin to Land form (§10.3).
- Container formats beyond `.dsv` and `.duc` (no$gba, DraStic, flashcart variants): see the ports/emulators doc.
- Encryption was validated against decrypted samples and pret code only. Run the one-time PKHeX/emulator check in
  §19.1 before release.

---

## 22. Verification notes (adversarial review, 2026-10-24)

Every claim below was re-checked against source files fetched for this review, not against memory.

Sources: pret/pokeplatinum `be36a9d` (2026-10-23), pret/pokeheartgold `6988158` (2026-10-19), pret/pokediamond
`b623abe` (2026-10-11), kwsch/PKHeX `a9ff306` (2026-10-21; GPL, read only), cybervisi0n/libntr `1555d91`, and
cybervisi0n/pokeplatinum `pc_port` `3506786` (2026-10-10). All were sparse-cloned into
`/tmp/claude-1000/pkres/verify-gen4/repos/`. The throwaway scripts live outside the repo.

### 22.1 Checked and found correct (no change)

- **Partition/footer layout (§3, §5):** pret `SaveBlockFooter` / HGSS `SaveChunkFooter` field order; Pt/DP
  `SaveData_CalculateFooterChecksum` and HGSS `SaveArray_CalcCRC16MinusFooter` ranges (size − 0x14 / − 0x10); all
  absolute footer positions and CRC lengths in §3 (recomputed); the HGSS 0x100 rounding (gap 0xD8); the PCBoxes and
  PCStorage size arithmetic (0x121C8 → 0x121E4; 0x122FC → 0x12310); the Pt/HGSS extra-block sectors (Pt
  `SAVE_PAGE_MAX` 32 → HoF 0x20000, Hall 0x23000, videos 0x24000…; HGSS `SAVE_PAGE_MAX` 35 → 0x23000, 0x26000,
  0x27000…).
- **CRC (§4):** the libntr `MATHi_CRC16InitTable` / `MATHi_CRC16Update` are MSB-first, poly 0x1021, init 0xFFFF. The
  doc's bitwise JS was re-implemented: "123456789" → 0x29B1, and on 5000 pseudo-random bytes it matches the table form.
  HGSS `GF_CalcCRC16` and DP `MATH_CalcCRC16CCITT` use the same CRC.
- **Load selection (§6):** `SaveCheckInfo_CompareCounters`, `SaveCheckInfo_CompareSectors`, `SaveData_LoadCheck`
  (every row of the DP/Pt table, including stale/cur choices); DP `sub_020229B8`/`sub_020229F0`/`sub_02022AD8`
  identical; HGSS `Save_GetSaveFilesStatus` (every row, including invalid count = 0).
- **Write behaviour (§7):** first save to partition B (`!blockOffsets`); RAM increment of all block counters; full vs
  normal save; write order body → footer +8..+0xF → whole footer; HGSS `count++`, opposite-partition write,
  partial box writes (`Save_CalcPCBoxModifiedFlags`, `Save_WriteNextPCBox`, `Save_WritePCFooter` writing
  0x12000..0x122FF), ≥ 6 boxes → "many" message, PKHeX `GetFinalData` forcing 0x3FFFF.
- **Trainer/party offsets (§9)** for all three games, the TrainerInfo/PlayerProfile layouts (gameCode +0x1C,
  language +0x19, HGSS `dummy` +0x1E / `kantoBadges` +0x1F), and Pt `TrainerInfo_Init` setting `GAME_VERSION` while DP
  `PlayerProfile_Init` doesn't. The only DP caller of `PlayerProfile_SetVersion` (asm `sub_02025CD8`) fills a
  temporary profile, not the save's. Also the PKHeX mail and map offsets.
- **Storage layouts (§10.1)** against pret `PCBoxes`, DP `PCStorage` and HGSS `PokemonStorageSystem` (offset
  comments + PKHeX); default wallpapers 0..15,0,1; Pt store behaviour (`BoxPokemon_RestorePP`, Shaymin Land,
  `SPECIES_NONE` test, `SaveData_SetFullSaveRequired`).
- **Party (§11):** Pt `Party_RemovePokemonBySlotIndex`; HGSS `Party_AddMon`/`Party_RemoveMon` aprijuice handling
  (`PERFORMANCE_MAX` 5, extra at 0x620).
- **PK4 (§12.1):** every offset recomputed from pret `struct_defs/pokemon.h` and HGSS `pokemon_types_def.h`: block
  A/B/C/D fields, IV bitfield, form bits, 0x41 shiny leaves, 0x86 HGSS ball, 0x87 mood, party 0x88–0xEB, Mail
  0x38 + BallCapsule 0x18.
- **Crypto (§12.2):** `EncodeData`/`LCRNG_NextFrom` (×0x41C64E6D + 0x6073, advance before use, XOR over stored
  order); seeds (checksum / PID); `Pokemon_GetDataChecksum`. The shuffle selector `(PID & 0x3E000) >> 13`, with cases
  24–31 equal to 0–7. **The shuffle table was regenerated from pret's 24 `DATA_BLOCK_SHUFFLE_CASE` tuples by script:
  every Order and Pos(ABCD) cell and the machine form match.** Encrypt/decrypt round-trips for all 32 selector
  values. The canonical empty record was regenerated from `BoxPokemon_Init` semantics and matches §10.4 byte for byte.
  The §19.1 vector was reproduced independently.
- **Derived properties and stats (§12.3, §12.4):** shiny, nature (`% NATURE_COUNT`), gender
  (`SpeciesData_GetGenderOf`), stat formulas incl. Shedinja and nature truncation, max PP (`MoveTable_CalcMaxPP`:
  `pp + pp·20·ups/100`), Arceus via Multitype + plate.
- **Ribbons (§12.6)** against PKHeX PK4 `RIB0..RIBB`; **forms (§12.7)** against pret `constants/forms.h`; Shaymin
  night rule (`Party_SetShayminForm`, 20:00–03:59).
- **Balls (§12.9)** against HGSS `pokemon.c` L833/L1298 and `constants/balls.h`; **ground tiles (§12.10)** against
  PKHeX `GroundTileType`.
- **Text (§13):** charmap line counts (Pt 2903, HGSS/DP 2900), duplicate keys (Pt 5: 0100, 0400, 0600, 0602, 0603;
  HGSS/DP 2), Latin ranges, ♂/♀ codes, control codes, `CHAR_EOS` 0xFFFF / `CHAR_NONE` 0, name lengths
  (`MON_NAME_LEN` 10, `TRAINER_NAME_LEN` 7, `BOX_NAME_LEN` 8).
- **Index lists (§14):** line counts and sentinels of `species.txt` (496), `moves.txt`, `items.txt`, `abilities.txt`;
  HGSS item constants; PKHeX max IDs (464/467/536, moves 467, abilities 123, balls 0x18).
- **Pokédex (§15):** pret Pt `Pokedex` struct (offsets recomputed, size 0x324, `MAX_SPECIES` 495 → languages u8[496]),
  DP struct (size 0x13C, meister list from `unk_02087A1C.c`) and HGSS struct (size 0x340,
  `ROUND_UP(493,4)` = 496 languages). Also `WriteBit_Deoxys` bit positions, the 2-form / 3-form / Rotom encodings and
  initial values, `Pokedex_Capture` / `Pokedex_SetMonCaughtFlag` step order, language index tables, PKHeX's
  `GetGen4LanguageBitIndex` disagreement and `Zukan4` bases.
- **Containers (§2):** PKHeX DeSmuME (0x7A footer, `|-DESMUME SAVE-|`) and ARDS (0xA4 header) handlers.

### 22.2 Changes made (old → new, with source)

| § | Old | New | Source |
|---|---|---|---|
| 4 | "In Platinum only the TV-broadcast and Mystery-Gift tables use [the per-table CRC]"; HGSS list UNVERIFIED | Pt: 7 tables (TV, Mystery Gift, Rankings, Wi-Fi history, easy-chat words, link-contest records, e-mail); HGSS: easy chat, Mystery Gift, rankings, Wi-Fi history, UNK_31 (+ assert on UNK_23); none is party/dex/boxes. Resolved. | grep of all `SaveData_SetChecksum`/`SaveData_Checksum` (pt) and `SaveSubstruct_*CRC` (hg) callers |
| 2, 17 | PC port: "same flash offsets … **offsets are identical** to a DS save"; port ↔ emulator = pad with 0xFF | Partitions, footer format and CRC are the same, but **block sizes and in-block offsets differ** (x86-64 alignment of s64/u64, no packing except `Pokemon`): general 0xCF40, storage 0x121EC with boxes at +8, trainer/party +0x0C, etc. (new §17.1). Conversion = re-layout, unsupported. | port headers compiled natively vs i386 control (§22.3); port `meson.build`, cross files, `pch/global_pch.h` |
| 8 | detection sizes DP/Pt/HGSS only | + PC port sizes | §17.1 |
| 5.1 | `blockCounter` "incremented on every save of that block" | RAM counters of both blocks increment on every save; only written blocks store them | pt `SaveDataState_Init` |
| 7.2 | sectorCleanFlag "set when the previous load was not a clean 2/2 IS_GOOD" | Exact rule: both start at 1; 2/2 IS_GOOD clears both, 1/1 clears one, 2/1 and SLOT_FAIL clear none; each save clears its partition. Added the `pcStorageLastCRC` fallback. | hg `SaveData_New`, `Save_GetSaveFilesStatus`, `Save_WriteManFinish`, `HandleWriteSaveAsync_PCBoxes` |
| 7.3 | Strategy B DP/Pt "write the edited general … and the edited storage" | Must write **both** blocks with `saveCounter+1`, even if one is unchanged | pt `SaveData_LoadCheck` link rule |
| 9 | Adventure/HoF times "u32" | s64 (`GameTime` timestamps); PKHeX reads the low u32 | pt `system_data.h` + layout probe |
| 9 | Daycare "last 4 bytes = EXP" | `steps` u32 (PKHeX calls it EXP); slot = BoxPokemon + 0x60 mail + steps | pt `struct_defs/daycare.h` |
| 9 | Pokéwalker struct at 0xE5E0 UNVERIFIED | struct at 0xE5DC, BoxPokemon at 0xE5E0 (= PKHeX `WalkerPair`); empty = raw zeros | hg `pokewalker.h`, `pokewalker.c`; PKHeX `OFS_WALKER` 0xE704 = +0x128 |
| 9 | (gap) | Pt save table recomputed end to end and DP/HGSS cross-checks noted | layout probe |
| 10.1 | "offset for special wallpapers (Pt +0x08, HGSS +0x10 for values ≥ 0x10)" | Stored bytes: Pt unlockables 0x18–0x1F, HGSS bonus 0x20–0x27 | pt `PCBoxes_SetWallpaper`, hg `constants/box_wallpaper.h` |
| 10.3 | "HGSS also zeroes walking mood" (read as game behaviour) | HGSS `PCStorage_PlaceMon*` only restore PP + set modified bit (no Shaymin/mood change); mood = 0 is PKHeX's | hg `pokemon_storage_system.c` |
| 10.4 | raw-zero slot → "`MON_DATA_SPECIES` returns `SPECIES_EGG`: a Bad Egg" | Nuanced: decrypted species = 0 (first seed-0 keystream word), so `SPECIES_EXISTS`-based code (UI, counts) sees empty, while `PCBoxes_TryStoreBoxMonInBox` (`MON_DATA_SPECIES`) sees a Bad Egg; `checksumFailed` is persisted. Parser rule extended. | pt `pokemon.c` L738–830, `pc_boxes.c` |
| 12.3 | ability "~L476" | `BoxPokemon_CalcAbility` ~L4746, form-aware | pt `pokemon.c` |
| 12.4 | level-1 EXP UNVERIFIED; formulas only | Use pret `exp_tables.csv` (rows 0/1 = 0); level loop semantics; base stats are per form (`SpeciesData_LoadForm`) | pt `res/pokemon/.shared/exp_tables.csv`, `SpeciesData_GetLevelAt` |
| 12.8 | "location exists in DP"; "PKHeX's rule set is equivalent" | Exact DP set 1–111 ∪ 2000–2010 ∪ 3000–3076; PKHeX getter/setter differ (equivalent only for game-written data) | pt `unk_02017038.c` `sub_0201708C`; PKHeX `G4PKM`, `Locations.cs` |
| 12.9 | (gap) | Park Ball / other values write nothing | hg `pokemon.c` L1298 |
| 13 | Hangul "0x0400–0x0D65 (gaps at 0x040F, …)" | pret/PKHeX off-by-one at 0x0400–0x040F (PKHeX: 0x0400 empty, 0x0401 = 가), prefer PKHeX; jamo representation note | diff of pret charmap vs PKHeX `TableKOR` |
| 13 | "PKHeX maps about 70 symbol codes (0x01AF, 0x01BB–0x01E7, 0x010B–0x0111, …) to … U+2460–U+2490" | Exact diff: 71 codes, 46 to Gen-5 stand-ins (U+2460–U+248F) + 0x01BB/BC → U+246D/E, 23 look-alike choices (listed) | diff of pret charmap vs PKHeX `TableINT` |
| 13 | Latin sub-ranges "0x015F–0x019E accented, 0x01A9–0x01DD punctuation" | 0x015F–0x01A2 letters, 0x01A3–0x01DD symbols, 0x01E3–0x01E7 unassigned in pret; ㊚/㊛ note | charmap |
| 14 | Apricorn balls "492–500" | Fast–Sport 492–499, Park 500; sentinel lines; data.json naming and symbolic values (gender ratio numbers) | hg `items.h`, pt `generated/*.txt` |
| 15.1 | (gap) | Form counts are gated by the seen bit, so order matters | pt `NumFormsSeen_*` |
| 19.1–19.2 | (d) "→ CORRUPT (DP/Pt)" | Verdict depends on storage copies (CORRUPT vs OK); new known answers (0xBDDA, empty party bytes); port fixture caveat | §6 tables |
| 21 | 4 UNVERIFIED items | 3 resolved, 2 new (Korean 0x040x, HGSS Shaymin UI) | above |

### 22.3 How the derived numbers were recomputed (throwaway scripts, not committed)

- `crypto.mjs` (Node) re-implements CRC (table and bitwise forms), the LCRNG, pret's shuffle tuples, encryption and
  checksum. It regenerates the shuffle table, the empty record, the 0xBDDA raw-zero checksum and the §19.1
  vector, and round-trips all 32 selector values.
- `layout.c` re-declares `GameTime`/`SystemData`/`BoxPokemon`/`PCBoxes` and compares 8-byte vs 4-byte alignment of
  64-bit members.
- `probe.c` / `probe2.c` include the **port's own headers** (generated-constant headers recreated from
  `generated/*.txt` by a small stand-in for metang, and empty stubs for text-bank headers that don't affect sizes).
  They print `sizeof` of all 38 save-table entries and replay `SaveTableEntry_BodySize` + block packing. The i386
  build reproduces every retail Pt number, which validates the method; the x86-64 build gives §17.1.
- The charmap analysis parses pret's charmap (first mapping wins) and PKHeX's `TableINT`/`TableKOR`, then diffs them
  code by code.

### 22.4 Still uncertain

- Korean signature 0x20070903 (PKHeX only), Korean text codes 0x0400–0x040F, and Korean dex language behaviour: all
  need a Korean save.
- PC port: §17.1 is computed, not observed; Win64/Switch layouts assumed equal to Linux; the extra blocks' sizes in
  the port were not computed (we never touch them).
- DP and HGSS general-block totals (0xC100, 0xF628) rest on PKHeX/Project Pokémon (empirical) plus the partial
  cross-checks in §9, not on a full struct-size recomputation like Pt's.
- Whether the HGSS PC UI forces Shaymin to Land form, and whether a Pokéwalker Pokémon is removed from its box.
- The DeSmuME `.dsv` trailer was checked only against PKHeX's handler (fixed 0x8007A total). Other DeSmuME save sizes
  are not covered.
