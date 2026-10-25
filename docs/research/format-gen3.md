# Generation 3 save and Pokémon data formats (Ruby, Sapphire, Emerald, FireRed, LeafGreen)

Status: research notes for implementation. Last researched 2026-10-24.
Scope: the GBA main-series games R/S/E/FR/LG in all retail languages (Japanese, English, French, German, Italian, Spanish), their emulator saves, the 2026 Nintendo Switch release of FireRed/LeafGreen, decomp-based native PC ports and static recompilations. Pokémon Colosseum/XD and Pokémon Box Ruby & Sapphire (GameCube memory cards) are out of scope.

Confidence legend:

- **[pret]** read directly in the pret decompilation source, which reproduces the game's behaviour.
- **[PKHeX]** read in PKHeX source (GPLv3, read only, nothing copied).
- **[Bulba]** Bulbapedia wiki page.
- **[verified]** checked by compiling pret's own functions natively in a throwaway harness outside this repo and running them on synthetic data (see section 14).
- **UNVERIFIED** means not confirmed by a primary source or by running code.

Licensing note: pret repositories carry **no license** (`license: null` from the GitHub API), PKHeX is **GPLv3**, and Bulbapedia text is CC BY-NC-SA. Our MIT code must be written from the facts below (offsets, sizes, algorithms) without pasting code or tables from any of them. Numeric test vectors that we generated ourselves are fine to commit.

---

## 1. Quick reference card

| Item | Value |
|---|---|
| Raw save size | 0x20000 (128 KiB, a 1 Mbit flash image). An emulator RTC footer may follow it (see 2.2) |
| Sector size | 0x1000. Data area 0xF80 (3968) bytes, then a 128-byte footer |
| Footer (per sector) | 0xFF4 u16 section id, 0xFF6 u16 checksum, 0xFF8 u32 signature `0x08012025` (bytes `25 20 01 08`), 0xFFC u32 save counter |
| Save slots | Slot A = sectors 0–13 (file 0x00000–0x0DFFF), slot B = sectors 14–27 (0x0E000–0x1BFFF) |
| Other sectors | 28–29 Hall of Fame. 30–31: Emerald Trainer Hill / Recorded Battle, FRLG Trainer Tower (e-Reader), RS unused |
| Endianness | Little-endian everywhere |
| Sector checksum | Sum of the first `size` bytes as u32 LE words into a u32 (wrapping), then `(sum >> 16) + sum`, truncated to u16 |
| Active slot | `c` = the larger counter of the two fully valid slots (with a wrap rule). The game loads **slot `c % 2`** |
| Box Pokémon | 80 bytes. Party Pokémon: 100 bytes = 80 + 20 bytes of status/level/stats |
| PK3 crypto key | `PID ^ OTID` (both u32), XORed over the 48 bytes at 0x20–0x4F, 4 bytes at a time |
| Substructure order | `PID % 24` selects the n-th lexicographic permutation of (Growth, Attacks, EVs, Misc) |
| PK3 checksum | u16 sum of the 24 decrypted u16 words at 0x20–0x4F, stored at 0x1C |
| Text | Proprietary 8-bit charset, terminator 0xFF. Nickname 10 bytes, OT name 7 bytes |
| Species | Internal index 1–251 = National Dex. 277–411 are the Hoenn species in a different order (table in section 9). 252–276 are dummy "old Unown" slots. 412 = Egg |

---

## 2. File container and normalisation (before parsing)

### 2.1 Accepted shapes

| Source | Shape | Notes / source |
|---|---|---|
| Real cartridge dump, most emulators (VBA-M, mGBA without RTC, Delta, etc.) | exactly 0x20000 bytes | The 1 Mbit flash chip image [pret `include/save.h`, `SECTORS_COUNT 32`] |
| mGBA with an RTC game (R/S/E) | 0x20000 + **16-byte** RTC footer = 0x20010 bytes | Footer layout: `u8 time[7]` (BCD: year, month, day, weekday, hour, minute, second), `u8 control`, `u64 lastLatch` (LE). It is written at offset `size & ~0xFF` [mGBA `src/gba/savedata.c` `GBASavedataRTCWrite`/`GBASavedataRTCRead`, `include/mgba/internal/gba/savedata.h` `struct GBASavedataRTCBuffer`]. Windows Explorer shows this file as "129 KB". Some users report PKHeX rejecting it, but the current PKHeX footer handler (next row) accepts a 16-byte footer, so those reports probably concern older versions (**UNVERIFIED**) |
| Other emulators / dumpers with RTC footers | 0x20000 + small footer | PKHeX accepts any footer of 0x0C–0x30 bytes with an even length, plus a 7-byte footer from FlashGBX ≥ 2.0 [PKHeX `SaveHandlerFooterRTC.cs`]. Treat footer bytes as opaque and **preserve them verbatim** on write-back |
| Misconfigured emulator (64 KiB flash) | 0x10000 bytes | Only slot A can be present. PKHeX's `SAV3.GetActiveSlot` has a 0x10000 branch that returns slot 0, but its auto-detection `SaveUtil.IsG3` accepts only exactly 0x20000 bytes, so whether PKHeX opens such a file at all is **UNVERIFIED**. Recommendation: read-only, warn the user |
| RetroArch with "SaveFile Compression" on | RZIP container | 20-byte header: `"#RZIPv"`, a version byte (1 = deflate, 2 = zstd), `"#"`, u32 LE chunk size, u64 LE total size. Then chunks of `u32 LE compressedSize` + data. Version 1 chunks are zlib streams with window bits 15, so the browser's `DecompressionStream('deflate')` works on them. Version 2 (zstd) needs a library [RetroArch `libretro-common/streams/rzip_stream.c`, `trans_stream_zlib.c`]. Detect it, decompress, and either re-compress on output or tell the user to turn compression off |
| Nintendo Switch FireRed/LeafGreen (released 2026-02-27, standalone eShop titles, not NSO) | community reports: `FireRed_e.sav` / `LeafGreen_e.sav` inside a homebrew save-manager backup | PKHeX treats a Gen-3 save whose file name starts with `FireRed_` or `LeafGreen_` and contains `.sav` as the Switch release (`IsVirtualConsole`), using the normal SAV3 parser. PKHeX's Gen-3 detection only accepts exactly 0x20000 bytes, so the file is a raw flash image [PKHeX `SAV3.cs`, commit `c037829b29` "Initial gen3 virtual console checks", 2026-02-27]. A user reported that swapping an emulator save in under the Switch file name works [projectpokemon.org forum, anecdotal]. Supporting evidence from the game code: pret pokefirered now decompiles the Switch ROM as `firered_switch` / `leafgreen_switch` (`GAME_REVISION=10`, codename "Sloop"). In that revision `TryWriteSector`/`HandleReplaceSector` hand the same fully built 0x1000-byte `SaveSector` buffer (same footer, checksum and rotation) to emulator syscalls (`swi 0x48` write, `swi 0x56` replace, `swi 0x4C` flush to file) instead of programming flash, and `include/global.h` has no revision-dependent fields, so the sector contents are byte-identical to a cartridge save [pret FR `src/save.c` `#if REVISION >= 0xA`, `src/sloopsvc.c`, `Makefile`]. **UNVERIFIED**: how the Switch emulator lays those sectors out in its file (no sample inspected), and the file-name suffixes used for other languages |
| Decomp native PC ports (pokeemerald SDL2 ports) | `pokeemerald.sav`, 131072 bytes, a raw dump of the emulated flash array `FLASH_BASE[131072]` | NTx86/pokeemerald-sdl2pc writes it to the working directory. The alanb2305/pokeemerald-native fork uses `%APPDATA%\pokeemerald`, `~/.local/share/pokeemerald` or `~/Library/Application Support/pokeemerald` [each repo's README.md, `src/platform/sdl2.c`, `src/platform/system.c`]. pokefirered-native also uses a 128 KiB `.sav` [xinpw8/pokefirered-native `src/host_flash.c`]. Layout caveat in 2.3 |
| Static recompilation (mstan/EmeraldRecomp on the gbarecomp runtime) | the runtime models the cartridge flash chip and RTC, and the original game code runs unchanged | The format of the data inside should therefore match the cartridge. The file name and container are **UNVERIFIED** (the README does not document them) [EmeraldRecomp README] |

Detection order: (1) RZIP magic → decompress. (2) Length is 0x20000 + n with 0 ≤ n < 0x40 → split off the n footer bytes, none when n = 0 (PKHeX takes the footer length as `size & 0x3F`). (3) Length is 0x10000 → half save, read-only. (4) Anything else → not Gen 3. Then require at least one sector in slot A or slot B with signature `0x08012025` at sector offset 0xFF8.

### 2.2 RTC (R/S/E only)

- The real-time clock is cartridge hardware. FireRed and LeafGreen carts have no RTC.
- Inside the save, SaveBlock2 holds `localTimeOffset` (struct Time at **0x98**) and `lastBerryTreeUpdate` (**0xA0**). Struct Time is `s16 days, s8 hours, s8 minutes, s8 seconds`, padded to 8 bytes by agbcc [pret E `include/global.h`, PKHeX `RTC3.Size = 8`]. In-game time = (RTC time) − `localTimeOffset` [pret E `src/rtc.c` `RtcCalcLocalTime`].
- We never need to touch these. Preserve the emulator RTC footer bytes as they are.

### 2.3 PC-port layout caveat (important)

The native ports compile pret's C code for x86/ARM. The GBA layout depends on a compiler rule: agbcc (and pret's `modern` GBA build, which passes `-mabi=apcs-gnu`) rounds the size and alignment of **every non-packed struct/union up to a multiple of 4** (GCC's 32-bit `STRUCTURE_SIZE_BOUNDARY` on the old ARM APCS ABI). Upstream pret does **not** annotate this (its `struct Time` has no attribute and is 5 bytes of fields padded to 8 only by that rule). Verified 2026-10-24: compiling upstream pokeemerald headers with clang for ARM gives `sizeof(SaveBlock2) = 0xF08`, `sizeof(SaveBlock1) = 0x3C40` with natural AAPCS layout, and exactly 0xF2C / 0x3D88 (and every `/*0x..*/` offset comment) once every non-packed struct is forced to 4-byte alignment (section 17). The PC port therefore adds `ALIGNED(4)` to `struct Time` and other structs itself so that x86/ARM64 compilers reproduce the GBA offsets [alanb2305/pokeemerald-native `include/global.h`]. That the APCS default is 32 for pret's `modern` flags is from GCC's ARM backend behaviour and is **UNVERIFIED** by an actual `modern` build here.

On **64-bit** builds, SaveBlock1 contains pointers: each object-event template's script and the Enigma Berry's two description lines. pokeemerald-native now converts these to the 32-bit GBA layout when saving (`SaveBlock1ToSaved`/`SaveBlock1FromSaved`), so its saves work in either direction with the GBA. Older 64-bit builds saved SaveBlock1 as it sits in memory, with only 10 secret bases [pokeemerald-native `src/save.c`, `IsOld64BitSaveBlock1`]. In such "old 64-bit" saves:

- Party, money, bag and seen-copy-#1 (all below SB1 0xA30/0xC70) are at the GBA offsets.
- Flags, vars and seen-copy-#2 are **shifted**.
- pokeemerald-native detects such saves by looking at the tail of the last SaveBlock1 sector, which is all zero there. In a GBA-layout save that region always holds data, such as the Union Room phrases written at new game (E SB1 `registeredTexts` at 0x3C88).

Other ports (pokefirered-native, pokeemerald-expansion-native) are **UNVERIFIED**. Expansion-based builds are ROM-hack engines with different Pokémon bitfields, so reject them (see 13.15). Mitigation is in section 12 (mirror-consistency guard).

---

## 3. Flash layout, checksums, slot selection, write-back

### 3.1 Sector map

| Physical sector | File offset | Contents |
|---|---|---|
| 0–13 | 0x00000–0x0DFFF | Save slot A (14 logical sections, rotated) |
| 14–27 | 0x0E000–0x1BFFF | Save slot B |
| 28, 29 | 0x1C000, 0x1D000 | Hall of Fame (2 × 0xF80 data bytes). The checksum is stored at **0xFF4** (in the "id" field) and the signature at 0xFF8 [pret E `src/save.c` `HandleWriteSectorNBytes`, `TryLoadSaveSector`] |
| 30 | 0x1E000 | E: Trainer Hill, FRLG: Trainer Tower 1, RS: unused [pret E/FR `include/save.h`, RS `src/save.c` comment] |
| 31 | 0x1F000 | E: Recorded Battle, FRLG: Trainer Tower 2, RS: unused |

Emerald (Trainer Hill / Recorded Battle) and FRLG (Trainer Tower) sectors 30 and 31 start with the u32 sentinel `0xB39D`, followed by 0xFFC bytes of payload (sector bytes 4–0xFFF); they have no checksum, id, signature or counter footer (`TryWriteSpecialSaveSector`) [pret E and FR `src/save.c`]. RS only touches 30–31 from unreferenced code and when erasing them on `SAVE_OVERWRITE_DIFFERENT_FILE`. The HoF sectors 28–29 have counter 0 and the checksum in the id field (see table). **Never modify sectors 28–31**: copy them through byte for byte.

### 3.2 Sector footer

Struct `SaveSector` [pret E `include/save.h`]:

| Offset | Size | Field |
|---|---|---|
| 0x000 | 0xF80 | data. Only the first `size` bytes are meaningful (table 3.3). The rest is zero when the game writes it |
| 0xF80 | 0x74 | unused (zero when written by the game) |
| 0xFF4 | u16 | section id 0–13 |
| 0xFF6 | u16 | checksum of `data[0:size]` |
| 0xFF8 | u32 | signature `0x08012025` |
| 0xFFC | u32 | save counter (same value in all 14 sectors of a slot) |

When the game writes a sector it **zeroes the whole 0x1000 buffer first**, then copies `size` bytes and fills the footer [pret E `src/save.c` `HandleWriteSector`].

### 3.3 Section ids and per-game data sizes (used for the checksum)

Each logical section `id` is a chunk of one of three RAM structures. Chunk `k` of a structure covers bytes `[k*0xF80, min(sizeof, (k+1)*0xF80))` [pret E/FR/RS `src/save.c` `SAVEBLOCK_CHUNK`].

| id | Structure (pret name) | RS size | FRLG size | E size |
|---|---|---|---|---|
| 0 | SaveBlock2 ("small", trainer/dex/options) | **0x890** (2192) | **0xF24** (3876) | **0xF2C** (3884) |
| 1 | SaveBlock1 bytes 0x0000–0x0F7F | 0xF80 | 0xF80 | 0xF80 |
| 2 | SaveBlock1 bytes 0x0F80–0x1EFF | 0xF80 | 0xF80 | 0xF80 |
| 3 | SaveBlock1 bytes 0x1F00–0x2E7F | 0xF80 | 0xF80 | 0xF80 |
| 4 | SaveBlock1 bytes 0x2E80–end | **0xC40** (3136) | **0xEE8** (3816) | **0xF08** (3848) |
| 5–12 | PokemonStorage bytes `(id-5)*0xF80 …` | 0xF80 | 0xF80 | 0xF80 |
| 13 | PokemonStorage bytes 0x7C00–0x83CF | 0x7D0 (2000) | 0x7D0 | 0x7D0 |
| — | sizeof(SaveBlock2) / sizeof(SaveBlock1) / sizeof(PokemonStorage) | 0x890 / 0x3AC0 / 0x83D0 | 0xF24 / 0x3D68 / 0x83D0 | 0xF2C / 0x3D88 / 0x83D0 |

Sources: struct definitions with offset comments in pret E/FR `include/global.h` ("sizeof=0xF2C", "size: 0xF24", "sizeof: 0x3D88", "size: 0x3D68"), pret RS `include/global.h` (dexSeen3 ends at 0x3AC0), and PKHeX `SAV3E/SAV3FRLG/SAV3RS` constructors (`SmallBuffer[..0x890|0xF24|0xF2C]`, `LargeBuffer[..0x3AC0|0x3D68|0x3D88]`). They agree.

Disagreement: Bulbapedia lists section 0 as 3884 bytes and section 4 as 3848 bytes for every game. Those are **Emerald's** values only. Use the per-game table above.

### 3.4 Checksum algorithm

```
sum = 0 (u32)
for i in 0 .. floor(size/4)-1: sum = (sum + u32le(data, 4*i)) mod 2^32
checksum = ((sum >> 16) + sum) & 0xFFFF
```

[pret E `src/save.c` `CalculateChecksum`; PKHeX `Checksums.CheckSum32`; Bulba]. **[verified]** test vector in section 14.

Gotcha: PKHeX always checksums the full 0xF80 bytes (`SetSlotChecksums`). That gives the same result only because game-written padding is zero. The game uses `size`. The `paddingNonZero` synthetic save in 14.3 loads fine in pret's logic, but PKHeX would flag it. **Implementation: validate with `size`. On write, zero the padding** (the game does the same), so both tools agree.

### 3.5 Slot validity and which slot is current (exact game behaviour)

Per slot, the game reads the 14 physical sectors of that slot [pret E/FR/RS `src/save.c` `GetSaveValidStatus`]:

1. If no sector has the signature, the slot is **EMPTY**.
2. If some sector has the signature: for each signed sector whose checksum over `size[id]` matches, mark bit `id` valid and remember its `counter` (the variable is overwritten each time, so the slot's counter is the counter of the **last valid sector in physical order**; in a genuine save all 14 are equal). The slot is **OK** only if all 14 bits are set. Otherwise it is **ERROR**. The game never range-checks the footer id: an id ≥ 14 indexes past the 14-entry size table (undefined read). Such a slot can never become OK anyway (14 physical sectors cannot cover ids 0–13 if one of them has another id, and a matching checksum would set a bit above 0x3FFF), so our reader must treat a signed sector with id ≥ 14 as invalid without computing its checksum.
3. Both OK: `c = max(counterA, counterB)` (unsigned), except the wrap case: if one counter is 0xFFFFFFFF and the other is 0, pick 0. Status OK.
4. Exactly one OK: `c` = that slot's counter. Status is ERROR if the other slot is ERROR, OK if the other is EMPTY.
5. Neither OK: EMPTY if both are empty, else CORRUPT.
6. **Load: the 14 sectors of slot index `c % 2`** are copied into RAM by id. Only sectors with a correct signature and checksum are copied [pret `CopySaveSlotData`]. The physical index of the id-0 sector becomes `gLastWrittenSector` (the rotation base).

What the player sees [pret E `src/main_menu.c`, `src/strings.c`]:

- ERROR: "The save file is corrupted. The previous save file will be loaded."
- CORRUPT: "The save file has been erased due to corruption or damage." (new game only)

So a modified save must leave **every slot that has any signature with all 14 sectors valid**.

**[verified]** by running pret's `GetSaveValidStatus` and `CopySaveSlotData` on synthetic saves (14.3):

- Equal counters load slot `c % 2`. With counter 7 on both slots the game loads B, with 8 it loads A.
- Slot A counter 5 with slot B counter 4 loads **slot B** (the *older* data!), because 5 % 2 = 1. A writer must therefore keep "the slot with the max counter sits at index `max % 2`".

Disagreements:

- Bulbapedia: "only the last section's index is used; if A is bigger it is newest, otherwise B (including ties)". Ties actually load `c % 2`, so for even counters A wins.
- PKHeX `SAV3BlockDetection.CompareFooters` picks the larger counter and slot A on ties. It also picks by counter, not parity. It reads the counter of each slot's id-0 sector only, and treats a counter of 0xFFFFFFFF as "uninitialised" (the other slot wins unless it holds 0xFFFFFFFE). Before comparing, PKHeX only checks that each slot has all 14 footer ids; it checks neither signatures nor checksums (`SAV3.IsAllMainSectorsPresent`).

All three agree on genuine saves, where the newest slot always has parity == counter. They disagree only on tool-made saves. We follow pret: compute `c` as above, use slot `c % 2`, and **refuse writes if that slot is not the one holding counter `c`** (a non-genuine save).

Rotation: on each full save the game increments `gLastWrittenSector` (mod 14) and `gSaveCounter`. It writes id `i` to physical sector `((i + gLastWrittenSector) % 14) + 14 * (gSaveCounter % 2)` [pret `HandleWriteSector`]. The first save after a fresh flash lands in slot B, physical order 13, 0, 1, …, 12 [verified; matches Bulba]. Rotation never matters to a reader: always index sectors by footer id.

New game does not reset the counter. `NewGameInitData` keeps `gSaveCounter`, and overwriting a different file erases sectors 28–31 [pret E `src/new_game.c`, `src/save.c` `SAVE_OVERWRITE_DIFFERENT_FILE`].

Link saves (`SAVE_LINK`, used by link activities and the Emerald Battle Frontier) rewrite only sections 0–4 **in place in the current slot with the same counter and rotation**, in all three games. RS's `SAVE_EREADER` (Mossdeep e-Reader trainer) rewrites only section 0 in place, and Emerald's `WriteSaveBlock2`/`WriteSaveBlock1Sector` pair does the same for ids 0–4 [pret E `src/save.c` `HandleSavingData` case `SAVE_LINK`; FR `src/save.c` (`WriteSaveSectorOrSlot(i, …)` for i = 0–4); RS `src/save.c` `Save_WriteDataInternal`]. Sections in one slot can therefore have different "ages" while sharing one counter. This is normal.

### 3.6 Write-back strategy (what we must update)

Pipeline:

1. Parse the active slot into three contiguous buffers: SB2 (id 0), SB1 (ids 1–4 concatenated) and Storage (ids 5–13 concatenated).
2. Modify the buffers.
3. Re-split them into sectors.

**Recommended (A), the PKHeX default:** rewrite **only the active slot, in place**:

- Keep each sector's physical position, id, signature and counter.
- Zero sector bytes `[size, 0xFF4)` (data padding plus the unused footer area), copy the new `data[0:size]`, and recompute the u16 checksum stored at sector offset **0xFF6** over `size` bytes. Leave 0xFF4 (id), 0xFF8 (signature) and 0xFFC (counter) as they were.
- Recompute every sector that changed. Recomputing all 14 is simpler and harmless.
- Leave the other slot, sectors 28–31 and any emulator footer untouched [PKHeX `SAV3.GetFinalData` → `WriteSectors(ActiveSlot)`, `SetChecksums` → `SetSlotChecksums(ActiveSlot)`].

**Alternative (B), emulate a real save:**

- Write all 14 sections into the *other* slot with `counter + 1` and rotation base `(oldBase + 1) % 14`.
- This needs a parity-consistent source.
- The previous state stays as the game's fallback backup. That is a safety net, but it also contains any Pokémon that were just deposited (see 13.12).

PKHeX also has `WriteBothSaveSlots` (both slots identical, same counter). It removes the backup.

Nothing else needs recomputing. There is no whole-file checksum, no hash and no MAC. The PK3 checksum (8.5) must be correct for each modified Pokémon. Pokédex mirrors must stay consistent (section 11).

---

## 4. Game detection

The save never stores the game version (R vs S, FR vs LG) or the language. Infer them.

### 4.1 RS vs E vs FRLG (from the SB2 / section-0 buffer of the slot chosen in 3.5)

Primary rule, from PKHeX `SaveUtil.GetVersionG3SAV`:

1. `u32le(SB2[0xAC]) == 1` → **FRLG**. In FRLG, 0xAC is `unkFlag1 = TRUE` and 0xAD is `unkFlag2 = FALSE`, set at new game and never changed [pret FR `include/global.h`, `src/new_game.c`]. PKHeX models these as two u16 at 0xAC and 0xAE (minor naming disagreement). Both give bytes `01 00 00 00` because the padding is zero.
2. `== 0` → **RS** (RS has its Battle Tower record here; 0 means no streak).
3. Otherwise: if any byte of `SB2[0x890 .. 0xF2C)` is non-zero → **Emerald** (Emerald's encryption key is at 0xAC; RS's SaveBlock2 ends at 0x890). Else → RS. In a genuine Emerald save this tail is never all zero: `NewGameInitData` → `ClearFrontierRecord` zeroes the frontier block and then sets `frontier.opponentNames[0][0]` and `[1][0]` (SB2 **0xEE1** and **0xEE9**) to 0xFF [pret E `src/new_game.c`; offsets computed]. Caveat: Emerald's new game sets `encryptionKey = 0`, and a fresh random key is only installed on the next map load (`MoveSaveBlocks_ResetHeap`, called from the overworld map-load paths), so a key of exactly 0 or 1 is possible in principle (probability ~2⁻³²) and would hit rule 1 or 2; the confirmation checks below catch it (the party-fit check in particular, since checksum fit alone cannot always separate E from FRLG).

Edge case: PKHeX detects FRLG saves whose `SB2[0xAC..0xB3]` are all 0xFF (a tool-induced overflow corruption; `IsCorruptPokedexFF` tests the u64 at 0xAC) and calls `FixDummyFlags` in the `SAV3FRLG` constructor. Read literally, that code writes u16 1 at 0xAC and, because its `DummyFlagFalse` setter is inverted (`value ? 0 : 1`), u16 **1** at 0xAE, i.e. bytes `01 00 01 00`, which would no longer pass rule 1 (**UNVERIFIED** whether that is intended; not tested with PKHeX). Note also that PKHeX's own `GetVersionG3SAV` classifies an all-FF 0xAC as Emerald (rule 3), so the repair only runs when the FRLG class is chosen some other way. For us: treat `u32 ∈ {0xFFFFFFFF, 0x00010001}` at 0xAC as "FRLG candidate" and decide with the party-fit and money-fit checks below (checksum fit cannot separate FRLG from E, see below).

Confirmation checks (recommended, our own addition):

- **Checksum fit.** Recompute the checksums of id 0 and id 4 with each game's sizes. A genuine RS save fits all three size sets (its padding is zero). FRLG fits FRLG and E sizes: E's extra bytes beyond FRLG's sizes are zero padding in a FRLG save. E normally fits only E, because Frontier data and `waldaPhrase` fill the tail. The detected game must fit.
- **Party fit.** At the game's party offset (RS/E SB1 0x234, FRLG 0x034), the count must be ≤ 6. The first `count` slots must decrypt with valid PK3 checksums and species 1–411 (or be marked bad eggs).
- **Money fit.** RS: `u32le(SB1[0x490]) ≤ 999999`. E: `u32le(SB1[0x490]) ^ key(SB2[0xAC]) ≤ 999999`. FRLG: `u32le(SB1[0x290]) ^ key(SB2[0xF20]) ≤ 999999` [pret E/FR `src/load_save.c` (XOR keys), PKHeX `SAV3E/FRLG.Money`].
- Extra FRLG signal: FRLG calls `EnableNationalPokedex_RSE()` at new game. Every FRLG save therefore has `SB2[0x1A] == 0xDA`, var 0x403C = 0x0302 (u16 at SB1 **0x1078**) and flag 0x838 set (SB1 **0xFE7** bit 0), even though FRLG never reads them; the call comes after `InitEventData`, and nothing clears them later [pret FR `src/event_data.c`, `src/new_game.c`; locations computed from the FRLG bases in section 6].

If the checks conflict, show "unrecognised Gen-3 save" and stay read-only.

### 4.2 Ruby vs Sapphire, FireRed vs LeafGreen

- Not stored anywhere in the save. **UNVERIFIED** whether any flag reliably distinguishes them. Some version-exclusive story flags exist, but we did not map them.
- Heuristic: the most common `metGame` among party and box Pokémon whose OTID equals the save's TID/SID and whose OT name equals the player name (Pokémon the player caught or hatched get `metGame = gGameVersion` [pret `CreateBoxMon`]). Version values: 1 Sapphire, 2 Ruby, 3 Emerald, 4 FireRed, 5 LeafGreen, 15 Colosseum/XD [pret E `include/constants/global.h`].
- Switch release: the file name prefix `FireRed_` / `LeafGreen_` [PKHeX].
- Always let the user confirm. It matters for Deoxys's form (13.9) and for display.

### 4.3 Japanese vs international, and language

- Layout: all retail languages of a given game share **one** layout. pokeruby builds English and German from the same structs with no language `#if` in `include/global.h`. PKHeX uses the same offsets for Japanese saves and only switches the string table and name lengths.
- Japanese detection [PKHeX `SAV3` ctor]: `u16le(SB2[0x06]) == 0`. Japanese games allow 5-character player names (+0xFF) and never touch bytes 6–7. International games fill the 8-byte buffer from a 0xFF-initialised naming buffer [pret E `src/naming_screen.c` memsets with EOS and copies `maxChars+1`].
- Western language (EN/FR/DE/IT/ES) is not stored. Infer it from the `language` byte (8.2) of the player's own non-egg Pokémon (they get `gGameLanguage` [pret `CreateBoxMon`]). Eggs always carry language 1 (Japanese) until they hatch.
- Korean: there is no Korean Gen-3 release (language id 6 is unused [pret E `include/constants/global.h`]).
- Japanese saves are supportable. Use the Japanese charset for the player name, box names and Pokémon whose language byte is 1.

### 4.4 Distinguishing Gen 3 from other generations

The size 0x20000 (Gen 1 and Gen 2 saves are smaller, Gen 4/5 are 0x80000 or larger) plus valid sector signatures and ids. Size alone is not enough: Pokémon Stadium / Stadium 2 saves are also exactly 0x20000 bytes, and Japanese Gen 2 saves are exactly 0x10000 bytes, the same as the misconfigured half Gen-3 image [PKHeX `SaveUtil` `SIZE_G1STAD`, `SIZE_G2STAD`, `SIZE_G2RAW_J`]. Always require the 0x08012025 signatures. PKHeX's `IsG3` requires one slot with all 14 ids present; it looks at the footer ids only, not at signatures or checksums [PKHeX `SaveUtil.IsG3`, `SAV3.IsAllMainSectorsPresent`].

---

## 5. SaveBlock2 (section 0): trainer info

Offsets are relative to the start of SB2 (= start of the id-0 sector). The common prefix applies to all three games [pret E/FR/RS `include/global.h`; PKHeX `SaveBlock3Small{RS,E,FRLG}.cs`; Bulba].

| Offset | Size | Field |
|---|---|---|
| 0x00 | 8 | player name: 7 chars + 0xFF (Japanese: 5 + 0xFF, bytes 6–7 = 0x00) |
| 0x08 | u8 | player gender (0 male, 1 female) |
| 0x09 | u8 | specialSaveWarpFlags |
| 0x0A | u32 | trainer id: low 16 bits = public TID, high 16 = SID |
| 0x0E | u16 | play time hours |
| 0x10 | u8 | minutes |
| 0x11 | u8 | seconds |
| 0x12 | u8 | frames (vblanks, 0–59) |
| 0x13 | u8 | button mode. pret: 0 Normal (FRLG "Help"), 1 LR, 2 L=A. **Disagreement:** Bulbapedia says 1/2/3. pret constants `OPTIONS_BUTTON_MODE_*` are 0/1/2, and pret is authoritative |
| 0x14 | u16 | bitfield: bits 0–2 text speed (0 slow, 1 mid, 2 fast), bits 3–7 window frame, bit 8 stereo, bit 9 battle style "set", bit 10 battle scene off, bit 11 region map zoom |
| 0x18 | 0x78 | **Pokédex struct** (section 11) |
| 0x90 | 8 | filler |
| 0x98 | 8 | localTimeOffset (RTC; RS/E) |
| 0xA0 | 8 | lastBerryTreeUpdate (RS/E) |

Game-specific tail:

| | RS | Emerald | FRLG |
|---|---|---|---|
| 0xA8 | `BattleTowerData` starts (to 0x890) | u32 `gcnLinkFlags` (read by Colosseum/XD) | u32 `gcnLinkFlags` |
| 0xAC | inside the BT player record (name chars or 0) | **u32 encryptionKey** | u8 unkFlag1 = 1, u8 unkFlag2 = 0 at 0xAD |
| other | — | 0xB0 apprentice, 0x1EC berry crush (berry powder u32 at **0x1F4**, XOR key), 0x21C ranking hall, **0x64C BattleFrontier** to 0xF2C (`challengeStatus` u8 at **0xCA8**, `selectedPartyMons` u16[4] at **0xCAA**) | 0xB0 battle tower, 0x898 mapView, 0xA98 link records, 0xAF0 berry crush (berry powder u32 at **0xAF8**, XOR key), 0xB00 pokeJump, 0xB10 berryPick, **0xF20 u32 encryptionKey** |

The encryption key ("security key") XORs money (u32), coins (low 16 bits), bag quantities (low 16 bits; not PC items), game stats and berry powder in E and FRLG. RS does not encrypt any of these. A new key is generated on map loads (`MoveSaveBlocks_ResetHeap`), so the key changes between saves [pret E/FR `src/load_save.c`, E `src/overworld.c`].

Disagreement: Bulbapedia puts FRLG's security key at 0x0AF8 and mentions "a copy at 0x01F4 in Emerald and 0x0F20 in FRLG". Per pret, 0xAF8 (FRLG) and 0x1F4 (E) are the **XOR-encrypted Berry Powder** fields. They equal the key only while powder = 0, which explains the "copy". The key itself is at E 0xAC and FRLG 0xF20.

For us: we only *read* name, gender, TID/SID and play time, and optionally money for display. We never need to re-key anything.

---

## 6. SaveBlock1 (sections 1–4): per-game offsets we care about

SB1 offset `X` lives in section id `1 + floor(X / 0xF80)` at local offset `X % 0xF80`.

| Field | RS | Emerald | FRLG | Source |
|---|---|---|---|---|
| playerPartyCount (u8 + 3 pad) | 0x234 | 0x234 | 0x034 | pret global.h, PKHeX `SaveBlock3Large*`, Bulba |
| playerParty[6] × 100 bytes | 0x238–0x48F | 0x238–0x48F | 0x038–0x28F | same |
| money u32 | 0x490 (plain) | 0x490 (^key) | 0x290 (^key) | same |
| coins u16 | 0x494 | 0x494 (^key lo16) | 0x294 (^key lo16) | same |
| Pokédex seen copy #1 (52 bytes) | 0x938 (`dexSeen2`) | 0x988 (`seen1`) | 0x5F8 (`seen1`) | same |
| event flags base | 0x1220 | 0x1270 | 0x0EE0 | pret; PKHeX `EventFlag` |
| vars base (var 0x4000 + i at base + 2i) | 0x1340 | 0x139C | 0x1000 | same |
| mail[16] × 36 bytes (0–5 party mail, 6–15 PC mailbox) | 0x2B4C | 0x2BE0 | 0x2CD0 | pret global.h, `src/mail_data.c` |
| daycare | 0x2F9C | 0x3030 | 0x2F80 | pret, PKHeX |
| Pokédex seen copy #2 (52 bytes) | 0x3A8C (`dexSeen3`) | 0x3B24 (`seen2`) | 0x3A18 (`seen2`) | pret, PKHeX `SeenOffset3`, Bulba (as section-4 offsets 0xC0C/0xCA4/0xB98) |
| sizeof | 0x3AC0 | 0x3D88 | 0x3D68 | pret |

The party is a **packed list**. `count` slots are used in order. The game compacts it, and empty slots are produced by `ZeroMonData`: 80 zero bytes, status/level/stats 0, and **mail byte 0x55 = 0xFF** [pret E `src/pokemon_storage_system.c` `CompactPartySlots`, `src/pokemon.c` `ZeroMonData`]. Disagreement: Bulbapedia says unused party slots are all 0x00. pret shows mail = 0xFF, and PKHeX also writes 0xFF for party, 0x00 for box (`SetPartyValues`).

On load the game copies SB1's party straight into `gPlayerParty`. Stats are **not** recomputed on load [pret E `src/load_save.c` `LoadPlayerParty`].

Emerald Battle Frontier: while a challenge is saved mid-way, `frontier.selectedPartyMons` (SB2 0xCAA, 1-based indices into SB1's party) is in use. SB1's party holds the full team that is restored afterwards [pret E `src/frontier_util.c` `SaveSelectedParty`, `RestoreHeldItems`]. **Do not modify or reorder the party if `SB2[0xCA8] != 0`.** The RS Battle Tower has similar per-party state at SB2 0xA8+ (`selectedPartyMons` inside `BattleTowerData`). **UNVERIFIED** whether editing the party mid-streak breaks it. Recommendation: box-only edits (section 12).

---

## 7. PC storage (sections 5–13), identical in all games

`struct PokemonStorage` [pret E `include/pokemon_storage_system.h`; Bulba; PKHeX `SAV3.GetBoxOffset`]:

| Offset | Size | Field |
|---|---|---|
| 0x0000 | u8 (+3 pad) | currentBox, 0–13 (the box last viewed) |
| 0x0004 | 14 × 30 × 80 = 0x8340 | boxes. Pokémon (box b, slot s) at `4 + (b*30 + s) * 80` |
| 0x8344 | 14 × 9 | box names (8 chars + 0xFF each) |
| 0x83C2 | 14 | box wallpaper ids |
| 0x83D0 | — | end |

Slots run left to right, top to bottom (5 rows × 6 columns).

**Fixed slots, not a packed list.** An empty slot is 80 zero bytes. Removing a Pokémon = zero its 80 bytes. Nothing shifts, and no count needs updating. Insertion = write into any empty slot. "Empty" means species reads as 0 after decryption: an all-zero record decrypts to species 0 with checksum 0 = valid. A record with a bad checksum reads as a **Bad Egg** (occupied) [pret `GetBoxMonData`]. The game's own "send to PC" picks the first empty slot starting from the current box [pret `CopyMonToPC`], but any empty slot is legal.

Eight box slots straddle a sector boundary. Always reassemble the 9 sections into one 0x83D0 buffer before reading or writing (computed from the layout):

All indices in this table are **0-based** (global index `g = b*30 + s`, box index `b` 0–13, slot index `s` 0–29); the in-game box/position is `b+1` / `s+1`.

| Storage offset of boundary | Section ids | Straddling slot: global `g` (box `b`, slot `s`) | In-game | Bytes in lower section |
|---|---|---|---|---|
| 0x0F80 | 5 / 6 | 49 (b 1, s 19) | Box 2, pos 20 | 44 |
| 0x1F00 | 6 / 7 | 99 (b 3, s 9) | Box 4, pos 10 | 12 |
| 0x2E80 | 7 / 8 | 148 (b 4, s 28) | Box 5, pos 29 | 60 |
| 0x3E00 | 8 / 9 | 198 (b 6, s 18) | Box 7, pos 19 | 28 |
| 0x4D80 | 9 / 10 | 247 (b 8, s 7) | Box 9, pos 8 | 76 |
| 0x5D00 | 10 / 11 | 297 (b 9, s 27) | Box 10, pos 28 | 44 |
| 0x6C80 | 11 / 12 | 347 (b 11, s 17) | Box 12, pos 18 | 12 |
| 0x7C00 | 12 / 13 | 396 (b 13, s 6) | Box 14, pos 7 | 60 |

Box names and wallpapers sit in section 13 at local 0x744 and 0x7C2.

---

## 8. Pokémon data structure (PK3)

### 8.1 Layout (80-byte box record, 100-byte party record)

[pret E `include/pokemon.h` `struct BoxPokemon`, `struct Pokemon`; PKHeX `PK3.cs`; Bulba]. **[verified]** `sizeof(BoxPokemon) = 80`, `sizeof(Pokemon) = 100`, checksum @ 28, secure @ 32, status @ 80, level @ 84, mail @ 85, hp @ 86 with the native oracle.

| Offset | Size | Field | Notes |
|---|---|---|---|
| 0x00 | u32 | personality (PID) | never encrypted |
| 0x04 | u32 | OT id: low 16 = TID, high 16 = SID | never encrypted |
| 0x08 | 10 | nickname | Gen-3 charset. No terminator if all 10 are used. Bytes after the 0xFF are "trash" (whatever the game's buffer held); **preserve the raw bytes** |
| 0x12 | u8 | language | 1 JPN, 2 ENG, 3 FRA, 4 ITA, 5 GER, 6 unused (Korean placeholder), 7 SPA |
| 0x13 | u8 | flags | bit 0 isBadEgg, bit 1 hasSpecies, bit 2 isEgg ("use egg name"), bit 3 blockBoxRS (Pokémon Box R&S refuses to deposit), bits 4–7 unused |
| 0x14 | 7 | OT name | charset per language byte |
| 0x1B | u8 | markings | bit 0 ●, bit 1 ■, bit 2 ▲, bit 3 ♥ [Bulba]. PKHeX swaps bits 1/2 internally to match Gen 4+ ordering |
| 0x1C | u16 | checksum | 8.5 |
| 0x1E | u16 | unknown / padding | pret `unknown`, PKHeX `Sanity`. Preserve |
| 0x20 | 48 | 4 encrypted, shuffled 12-byte substructures | 8.3–8.4 |
| 0x50 | u32 | status (party only) | bits 0–2 sleep turns, 3 poison, 4 burn, 5 freeze, 6 paralysis, 7 toxic, 8–11 toxic counter [pret E `include/constants/battle.h`] |
| 0x54 | u8 | level (party) | derived from exp |
| 0x55 | u8 | mail id (party) | index 0–5 into SB1 `mail[]`, 0xFF = none |
| 0x56 | u16 | current HP | |
| 0x58 | u16 | max HP | |
| 0x5A | u16 | Attack | |
| 0x5C | u16 | Defense | |
| 0x5E | u16 | **Speed** | |
| 0x60 | u16 | Sp. Atk | |
| 0x62 | u16 | Sp. Def | |

The party extension (0x50–0x63) is not encrypted and not covered by the checksum. Box records omit it. The game rebuilds it on withdraw (`BoxMonToMon` → status 0, HP 0, mail 0xFF, `CalculateMonStats`, which sets HP = max because old HP and old max are both 0) [pret `src/pokemon.c`].

### 8.2 Header flags and the two egg flags

- `hasSpecies` is set by the game whenever `species != 0` [pret `SetBoxMonData` case `MON_DATA_SPECIES`]. PKHeX's "slot occupied" test: `(byte[0x13] & 0xFB) == 2`, which ignores the egg bit [PKHeX `EntityDetection.IsPresentGBA`].
- There are **two** egg flags: header bit 2 (controls the "EGG" name display) and substructure-M IV word bit 30 (the real egg flag). `SetMonData(MON_DATA_IS_EGG)` sets both [pret `SetBoxMonData`]. Keep them equal.
- Bad Egg: any encrypted-field access decrypts and recomputes the checksum. On mismatch the game **sets isBadEgg, header isEgg and substructure isEgg** and the Pokémon becomes a "Bad EGG" [pret `GetBoxMonData`, `SetBoxMonData`]. A record with `isBadEgg = 1` also reads as species EGG even with a good checksum. Never import Bad Eggs. Never produce one: always recompute the checksum.
- Language: in Western games, language 1 makes the nickname and OT render with the Japanese charset. The nickname is cut to its first 5 characters (`GetBoxMonData` `MON_DATA_NICKNAME` wraps at most 5 bytes in `FC 15` … `FC 16`); the OT name is wrapped the same way by `ConvertInternationalString` in the summary screen but not truncated [pret E `src/pokemon.c`, `src/pokemon_summary_screen.c`, `src/string_util.c`]. Japanese games ignore the language byte and always use the JP charset (names show truncated to 5 characters) [pret; Bulba].

### 8.3 Substructures (canonical contents)

[pret E `include/pokemon.h` `PokemonSubstruct0..3`; Bulba substructures; PKHeX `PK3` blocks A–D]. Offsets are within each 12-byte block.

**G, Growth (type 0)**

| + | Size | Field |
|---|---|---|
| 0 | u16 | species (**internal index**, section 9) |
| 2 | u16 | held item (Gen-3 item index) |
| 4 | u32 | experience |
| 8 | u8 | PP bonuses: 2 bits per move (bits 0–1 move 1 … bits 6–7 move 4) |
| 9 | u8 | friendship. **For eggs: remaining egg cycles** [pret `src/daycare.c` `CreateEgg`] |
| 10 | u16 | unused filler |

**A, Attacks (type 1):** +0, +2, +4, +6 are u16 moves 1–4 (1–354). +8 … +11 are u8 current PP 1–4.

**E, EVs and condition (type 2):** u8 each at +0 HP EV, +1 Atk, +2 Def, +3 **Speed**, +4 SpA, +5 SpD, +6 Cool, +7 Beauty, +8 Cute, +9 Smart, +10 Tough, +11 Sheen ("feel").

**M, Misc (type 3)**

| + | Size | Field |
|---|---|---|
| 0 | u8 | Pokérus: low nibble = days left (0–4), high nibble = strain. Strain ≠ 0 with days = 0 means cured |
| 1 | u8 | met location (`MAPSEC_*` id, section 9.5) |
| 2 | u16 | origins: bits 0–6 met level (0 = hatched), bits 7–10 game of origin, bits 11–14 ball (Gen-3 item id 1–12), bit 15 OT gender (1 = female) |
| 4 | u32 | bits 0–4 HP IV, 5–9 Atk, 10–14 Def, **15–19 Speed**, 20–24 SpA, 25–29 SpD, bit 30 isEgg, bit 31 abilityNum (0 = first ability, 1 = second) |
| 8 | u32 | ribbons and obedience: bits 0–2 Cool rank (0–4), 3–5 Beauty, 6–8 Cute, 9–11 Smart, 12–14 Tough, 15 Champion, 16 Winning, 17 Victory, 18 Artist, 19 Effort, 20 Marine/"Battle Champion", 21 Land/"Regional Champion", 22 Sky/"National Champion", 23 Country, 24 National, 25 Earth, 26 World, 27–30 unused, **31 `modernFatefulEncounter`** |

The EV, IV and party-stat order is HP, Atk, Def, **Spe**, SpA, SpD. Showdown uses hp/atk/def/spa/spd/spe. Map explicitly.

Bit 31 of the ribbon word: in FRLG and E it gates **Mew/Deoxys obedience and tradeability**. In RS it does nothing (and is accidentally cleared when an egg hatches). In Gen 4+ it shows as "fateful encounter" [pret comment in `include/pokemon.h`; Bulba]. Preserve it.

### 8.4 Encryption and shuffling

- Key `k = PID ^ OTID` (u32). XOR each u32 word at 0x20, 0x24, …, 0x4C with `k` [pret `EncryptBoxMon` (applies `^personality` then `^otId`); Bulba].
- Order: block type at position `p` (0–3) comes from `PID % 24`. The table equals the **n-th lexicographic permutation of G,A,E,M** (n = PID % 24), so it can be generated instead of hard-coded. **[verified]** against pret's `GetSubstruct` macro table and Bulbapedia:

| n | order | n | order | n | order | n | order |
|---|---|---|---|---|---|---|---|
| 0 | GAEM | 6 | AGEM | 12 | EGAM | 18 | MGAE |
| 1 | GAME | 7 | AGME | 13 | EGMA | 19 | MGEA |
| 2 | GEAM | 8 | AEGM | 14 | EAGM | 20 | MAGE |
| 3 | GEMA | 9 | AEMG | 15 | EAMG | 21 | MAEG |
| 4 | GMAE | 10 | AMGE | 16 | EMGA | 22 | MEGA |
| 5 | GMEA | 11 | AMEG | 17 | EMAG | 23 | MEAG |

"GAME" means G at 0x20, A at 0x2C, M at 0x38, E at 0x44.

- Decode: XOR all 12 words, then read block type t from position `order.indexOf(t)`. Encode: place the blocks, compute the checksum over the plaintext, then XOR. The XOR is position-independent, so the order of XOR and shuffle does not matter as long as the checksum is computed on plaintext.
- Changing the PID or OTID changes both the key and (for the PID) the order. Re-encrypt from plaintext.

### 8.5 Checksum

`checksum = (Σ u16le(plain, 0x20 + 2i), i = 0..23) & 0xFFFF`, stored at 0x1C [pret `CalculateBoxMonChecksum`; PKHeX `Checksums.Add16`]. The sum is order-independent, so the shuffle does not affect it. **[verified]**

### 8.6 Derived values (not stored)

[pret E `src/pokemon.c`, `include/pokemon.h`, `include/constants/pokemon.h`]

- **Nature** = `PID % 25`: 0 Hardy, 1 Lonely, 2 Brave, 3 Adamant, 4 Naughty, 5 Bold, 6 Docile, 7 Relaxed, 8 Impish, 9 Lax, 10 Timid, 11 Hasty, 12 Serious, 13 Jolly, 14 Naive, 15 Modest, 16 Mild, 17 Quiet, 18 Bashful, 19 Rash, 20 Calm, 21 Gentle, 22 Sassy, 23 Careful, 24 Quirky. Raised stat = `floor(n/5)`, lowered = `n % 5` over (Atk, Def, Spe, SpA, SpD). They cancel when equal. The stat is multiplied by 110/100 or 90/100 with integer division.
- **Gender**: the species' `genderRatio` g. g = 0 → always male, 254 → always female, 255 → genderless. Otherwise **female iff g > (PID & 0xFF)** [pret `GetBoxMonGender`]. g comes from species data; Showdown's gender ratios translate to 0x1F/0x3F/0x7F/0xBF/0xFE.
- **Shiny** iff `(TID ^ SID ^ (PID >> 16) ^ (PID & 0xFFFF)) < 8` [pret `GET_SHINY_VALUE`, `SHINY_ODDS 8`].
- **Ability** = species abilities[abilityNum]. The game creates the bit as `PID & 1` only if the species has a second ability [pret `CreateBoxMon`]. `GetAbilityBySpecies` has no fallback: abilityNum = 1 with an empty slot 2 returns ABILITY_NONE. For Showdown, fall back to slot 1 when slot 2 is empty.
- **Unown letter** = `(((PID>>24)&3)<<6 | ((PID>>16)&3)<<4 | ((PID>>8)&3)<<2 | (PID&3)) % 28`: 0–25 A–Z, 26 "!", 27 "?" [pret `GET_UNOWN_LETTER`]. Internal ids 413–439 are sprite-only "Unown B…?" slots and are never stored in a Pokémon.
- **Spinda spots**: derived from the 4 PID bytes. Cosmetic; only the PID must be preserved.
- **Wurmple**: evolves to Silcoon if `(PID >> 16) % 10 ≤ 4`, else Cascoon [pret `GetEvolutionTargetSpecies` `EVO_LEVEL_SILCOON/CASCOON`].
- **Level** = the largest L ≤ 100 with `expTable[growth][L] ≤ exp` (exp 0 → level 0, since table[1] = 1). Growth tables are in pret `src/data/pokemon/experience_tables.h`: Medium Fast n³, Erratic, Fluctuating, Medium Slow `6n³/5 − 15n² + 100n − 140`, Fast `4n³/5`, Slow `5n³/4`. Levels 0 and 1 are hard-coded 0 and 1 in every table. The growth rate per species is in pret `src/data/pokemon/species_info.h`.
- **Stats**: HP = `floor((2B + IV + floor(EV/4)) * L / 100) + L + 10` (Shedinja: 1). Others: `floor((floor((2B + IV + floor(EV/4)) * L / 100) + 5) * natureNum / 100)` [pret `CalculateMonStats`, `CALC_STAT`]. Base stats must be **Gen-3** values (Showdown's `mods/gen3` data or pret species info).
- **Deoxys**: the form is not stored. It is a property of the cartridge: RS Normal, FR Attack, LG Defense, E Speed. Emerald computes displayed stats on the fly (`GetDeoxysStat`). Party stat bytes are written with the host ROM's base-stat table.
- **Max PP** = `basePP + floor(basePP * 20 * ppUps / 100)` = `basePP + floor(basePP * ppUps / 5)`, with `ppUps = (ppBonuses >> (2*slot)) & 3` [pret E `src/pokemon.c` `CalculatePPWithBonus`]. Every Gen-3 base PP is 1 or a multiple of 5, so this equals `basePP + floor(basePP/5) * ppUps` in practice, but implement the exact form. Base PP from Gen-3 move data (Showdown `mods/gen3` or pret `gBattleMoves`).
- Hidden Power type/power is computed from IVs (Showdown does this).

### 8.7 Eggs (game behaviour)

Daycare eggs are created with:

- level-5 exp
- Poké Ball, met level 0
- language **1 (Japanese)**, nickname `タマゴ` in the JP charset = bytes `60 6F 8B FF …`
- friendship = species egg cycles
- both egg flags set
- Emerald hot-springs egg: met location 0xFD

[pret E `src/daycare.c` `CreateEgg`, `SetInitialEggData`]

On hatch the game **rebuilds the Pokémon from scratch** with `CreateMon(species, level 5, PID = egg's PID, OT = the hatching player)` and copies back only the moves, the six IVs, `metGame`, markings, Pokérus and (FRLG/E only) the fateful-encounter bit. Then: language → the hatching game's language, friendship 120, nickname → species name, ball Poké Ball, met level 0, met location = current map section, Pokédex seen and caught registered [pret E `src/egg_hatch.c` `CreateHatchedMon`, `AddHatchedMonToParty`; FR `src/daycare.c`; RS `src/egg_hatch.c`, where the fateful bit is *not* copied]. Consequences:

- **OT id, OT name and OT gender change** to the player who hatches the egg (a traded egg becomes "owned" by the receiver).
- Held item, EVs, contest stats, ribbons (other than the fateful bit) and PP Ups are reset to fresh-`CreateMon` values.
- The ability bit is re-derived as `PID & 1` (only if the species has two abilities), which equals what the egg had if it was game-made.

Implications: an egg's language byte says nothing about its origin. Battles must reject eggs. An egg's identity tuple (section 12) is not stable across hatching.

### 8.8 Mail

Only party Pokémon can carry mail data. The 36-byte `struct Mail` lives in SB1 `mail[id]`, with id = the Pokémon's byte 0x55 (0–5). Layout (computed): 0x00 u16 easy-chat words[9], 0x12 author name[8], 0x1A trainer id[4], 0x1E u16 species, 0x20 u16 itemId, 0x22 2 bytes padding. `species` is not always a species id: for Unown it is **30000 + letter** (`SpeciesToMailSpecies`, `UNOWN_OFFSET 30000`) [pret E `src/mail_data.c`]. Party mail is `mail[0..5]`; the PC mailbox is `mail[6..15]`. Taking the mail sets `mail[id].itemId = 0` and the Pokémon's mail byte to 0xFF [pret E `src/mail_data.c`]. The PC UI refuses to store a Pokémon holding mail (`ItemIsMail` checks in `src/pokemon_storage_system.c`). Mail items are 121–132 [PKHeX `SAV3.IsMail`, pret `FIRST_MAIL_INDEX`].

---

## 9. Index tables

### 9.1 Species (internal → National)

Machine-readable source: join `#define SPECIES_<NAME> <n>` in pret `include/constants/species.h` with the position of `NATIONAL_DEX_<NAME>` in the enum in `include/constants/pokedex.h` (`NATIONAL_DEX_NONE = 0`). This is exactly how pret builds `sSpeciesToNationalPokedexNum` (`SPECIES_TO_NATIONAL` macro in `src/pokemon.c`). We generated the table below this way and checked that pokeemerald and pokefirered produce identical tables. pokeruby has the same species numbering.

URLs:

- https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/species.h
- https://raw.githubusercontent.com/pret/pokeemerald/master/include/constants/pokedex.h

Rules:

- 0: none.
- 1–251: national = internal [verified].
- 252–276: `OLD_UNOWN_B…Z`, dummy, **invalid**. pret maps them past 386.
- 277–411: the table below.
- 412: Egg (a sprite/placeholder; real eggs keep their true species with the egg flag set).
- 413–439: Unown letter sprites, never stored.
- Anything > 411 in a save means a ROM hack or corruption: reject.

National Dex number for internal index `277 + i` (i = 0…134):

```
  252, 253, 254, 255, 256, 257, 258, 259, 260, 261, 262, 263, 264, 265, 266,
  267, 268, 269, 270, 271, 272, 273, 274, 275, 290, 291, 292, 276, 277, 285,
  286, 327, 278, 279, 283, 284, 320, 321, 300, 301, 352, 343, 344, 299, 324,
  302, 339, 340, 370, 341, 342, 349, 350, 318, 319, 328, 329, 330, 296, 297,
  309, 310, 322, 323, 363, 364, 365, 331, 332, 361, 362, 337, 338, 298, 325,
  326, 311, 312, 303, 307, 308, 333, 334, 360, 355, 356, 315, 287, 288, 289,
  316, 317, 357, 293, 294, 295, 366, 367, 368, 359, 353, 354, 336, 335, 369,
  304, 305, 306, 351, 313, 314, 345, 346, 347, 348, 280, 281, 282, 371, 372,
  373, 374, 375, 376, 377, 378, 379, 382, 383, 384, 380, 381, 385, 386, 358,
```

Examples: 277 Treecko → 252, 283 Mudkip → 258, 308 Spinda → 327, 410 Deoxys → 386, 411 Chimecho → 358. The table is a bijection onto 252–386.

Disagreement: Bulbapedia's index-number page intro says Gen-1/2 species and "several" Gen-3 species are in National order, with Chimecho the only exception. Its own per-entry list (277 → 252, 308 → 327, 411 → 358) matches the table above, which is far from National order. The list is right and the intro is misleading.

### 9.2 Items

- Gen-3 indices: RS 0–346 valid (pret RS defines 347–348 as unknown placeholders, `ITEMS_COUNT 349`), FRLG up to 374, E up to 376 [PKHeX `Legal.MaxItemID_3_*`; pret `include/constants/items.h` per repo].
- It is **one numbering** for all five games: ids 0–348 name the same items in RS, FRLG and E; FRLG adds the Kanto key items 349–374 (Oak's Parcel … Sapphire), which Emerald also has at the same ids, and Emerald alone adds 375 Magma Emblem and 376 Old Sea Map [compared programmatically across the three pret `items.h`, 2026-10-24].
- Inside that range, 67 ids are unnamed placeholders in all three repos (`ITEM_034`-style or `ITEM_UNUSED_BERRY_*`): **52–62, 72, 82, 87–92, 99–102, 105, 112–120, 176–178, 226–253, 267, 347–348**. Treat them as invalid held items, like ids above the game's maximum.
- Gen-3 item numbers **differ from Gen 4+**: Leftovers 200 → 234, Oran Berry 139 → 155, and some items do not exist later [PKHeX `ItemConverter.Item3to4`, read only].
- For Showdown and later-gen conversions, build our own name-keyed table from the pret constant names (e.g. `ITEM_LEFTOVERS`) normalised to Showdown ids, plus a small override list.
- Balls in the origins field are item ids 1 Master, 2 Ultra, 3 Great, 4 Poké, 5 Safari, 6 Net, 7 Dive, 8 Nest, 9 Repeat, 10 Timer, 11 Luxury, 12 Premier [pret `FIRST_BALL..LAST_BALL`; Bulba].

### 9.3 Moves

1–354 (`MOVE_PSYCHO_BOOST = 354`, `MOVES_COUNT 355`) [pret E `include/constants/moves.h`]. They use the same numbering as later generations. Map by name to Showdown ids.

### 9.4 Abilities

Not stored as an id, only abilityNum. Ability ids 1–77 [PKHeX `MaxAbilityID_3`]. Use Showdown `mods/gen3` species ability lists (Gen-3 abilities differ from later gens).

### 9.5 Met locations

- u8 `MAPSEC_*` ids. Emerald: 0x00–0x56 Hoenn (0x10 = Route 101), 0x57 `MAPSEC_DYNAMIC`, 0x58–0xC4 Kanto/Sevii (`KANTO_MAPSEC_START = MAPSEC_PALLET_TOWN` = 0x58, `KANTO_MAPSEC_END = MAPSEC_SPECIAL_AREA` = 0xC4), 0xC5–0xD4 Emerald-only sections (Aqua Hideout … Trainer Hill, incl. 0xD3 Navel Rock), 0xD5 `MAPSEC_NONE` [counted from the ordered list in pret E `src/data/region_map/region_map_sections.json`, 213 entries]. FRLG's list (pret FR, same file name, 197 entries) has the **same ids 0x00–0xC4** (only some constant names differ, e.g. `MAPSEC_NAVEL_ROCK` vs E `MAPSEC_NAVEL_ROCK_FRLG` at 0xAE; FRLG gives 0xC4 the display name "CELADON DEPT." where E says "SPECIAL AREA"), and ends there, so FRLG's `MAPSEC_NONE` is 0xC5. RS's list (pret RS `src/data/region_map/region_map_sections.json`) has only 0x00–0x57 (88 entries, same ids; 0x3A is "Battle Tower" where E has "Battle Frontier"), so no Kanto sections; treat ids a game does not know as "unknown location" for display.
- Specials: **0xFD** `METLOC_SPECIAL_EGG`, **0xFE** `METLOC_IN_GAME_TRADE`, **0xFF** `METLOC_FATEFUL_ENCOUNTER` (event).
- Sources: pret E `src/data/region_map/region_map_sections.constants.json.txt` and `src/data/region_map/region_map_sections.json` (ordered list with display names; FRLG has its own copy in pokefirered).

### 9.6 Game of origin

1 S, 2 R, 3 E, 4 FR, 5 LG, 15 Colosseum/XD [pret E `include/constants/global.h`].

---

## 10. Text encoding

Machine-readable sources: pret `charmap.txt`, Western section plus a `@ Hiragana`, `@ Katakana`, `@ Japanese punctuation` section in the same file.

- https://raw.githubusercontent.com/pret/pokeemerald/master/charmap.txt
- https://raw.githubusercontent.com/pret/pokefirered/master/charmap.txt
- https://raw.githubusercontent.com/pret/pokeruby/master/charmap.txt

Generate our own decode tables from these at build time, or hand-write them. Bulbapedia "Character encoding (Generation III)" documents the regional and game differences.

Western set (name-relevant subset) [pret E `charmap.txt`]:

| Bytes | Characters |
|---|---|
| 0x00 | space |
| 0x01–0x2B | accented letters, in order: À Á Â Ç È É Ê Ë Ì — Î Ï Ò Ó Ô Œ Ù Ú Û Ñ ß à á — ç è é ê ë ì — î ï ò ó ô œ ù ú û ñ º ª. The three "—" are codes **0x0A, 0x18 and 0x1F**, which pret's charmap does not define (no Í/í here: those are 0x5A/0x6F) |
| 0x2C | superscript "er" glyph (`SUPER_ER`, non-name) |
| 0x34 | "Lv" glyph (`LV`, non-name) |
| 0x2D | & |
| 0x2E | + |
| 0x35 | = |
| 0x36 | ; |
| 0x51 | ¿ |
| 0x52 | ¡ |
| 0x53–0x54 | PK MN glyphs |
| 0x55–0x59 | "POKéBLOCK" glyphs (non-name) |
| 0x5A | Í |
| 0x5B | % |
| 0x5C | ( |
| 0x5D | ) |
| 0x68 | â |
| 0x6F | í |
| 0x77, 0x79–0x7C, 0x84–0x86, 0xA0 | non-name glyphs: spacer, ↑ ↓ ← → arrows, superscript "e", `<`, `>`, superscript "re" |
| 0xA1–0xAA | 0–9 |
| 0xAB | ! |
| 0xAC | ? |
| 0xAD | . |
| 0xAE | - |
| 0xAF | · |
| 0xB0 | … |
| 0xB1 / 0xB2 | opening / closing double quote |
| 0xB3 / 0xB4 | ‘ / ’ (0xB4 doubles as apostrophe) |
| 0xB5 | ♂ |
| 0xB6 | ♀ |
| 0xB7 | ¥ |
| 0xB8 | , |
| 0xB9 | × |
| 0xBA | / |
| 0xBB–0xD4 | A–Z |
| 0xD5–0xEE | a–z |
| 0xEF | ▶ |
| 0xF0 | : |
| 0xF1–0xF6 | Ä Ö Ü ä ö ü |
| 0xF7–0xF9 | escape bytes that take a following argument byte: 0xF7 dynamic char, 0xF8 keypad icon, 0xF9 extra symbol [pret E `include/constants/characters.h` `CHAR_DYNAMIC`/`CHAR_KEYPAD_ICON`/`CHAR_EXTRA_SYMBOL`]. Never valid in names |
| 0xFA–0xFE | control codes: 0xFA prompt-scroll, 0xFB prompt-clear, 0xFC extended control code (takes arguments, e.g. `FC 15` = switch to JP font, `FC 16` = back to Latin), 0xFD placeholder (`FD 01` = player name …), 0xFE newline [same file] |
| 0xFF | terminator (EOS) |

Japanese set. Kana and the punctuation 0x00/0xAB–0xAE/0xB0 are in pret's charmap (`@ Hiragana`, `@ Katakana`, `@ Japanese punctuation`); the remaining rows are from PKHeX's Japanese table (`StringConverter3.G3_JP`, read only) and are **[PKHeX]**, not confirmed in pret:

| Bytes | Characters |
|---|---|
| 0x00 | ideographic space |
| 0x01–0x50 | hiragana (あ … っ, pret order) |
| 0x51–0xA0 | katakana (ア … ッ, pret order) |
| 0xA1–0xAA | full-width ０–９ [PKHeX] |
| 0xAB | ！ |
| 0xAC | ？ |
| 0xAD | 。 |
| 0xAE | ー |
| 0xAF | ・ (pret puts `·` here in every charmap) |
| 0xB0 | ⋯ (pret JP section; Western section: …) |
| 0xB1–0xB4 | 『 』 「 」 [PKHeX] |
| 0xB5, 0xB6 | ♂ ♀ [PKHeX] |
| 0xB7 | 円 [PKHeX] |
| 0xB8 | ． [PKHeX] |
| 0xB9, 0xBA | × ／ [PKHeX] |
| 0xBB–0xD4 | full-width Ａ–Ｚ [PKHeX] |
| 0xD5–0xEE | full-width ａ–ｚ [PKHeX] |
| 0xEF | ▶ [PKHeX] |
| 0xF0 | ： [PKHeX] |
| 0xFF | terminator |

0xB8 is "．" in Japanese but "," in Western. 0xF1–0xF6: PKHeX's own Japanese table decodes them as Ä Ö Ü ä ö ü (and 0xF7–0xFB as ↑ ↓ ← → ＋), but Pokémon HOME's Japanese map rejects every byte 0xF1–0xFE (`StringConverter3.GetHOMEChar`), so never **write** them into a Japanese-language name.

Western codes that pret's charmap leaves undefined (0x0A, 0x18, 0x1F, 0x2F–0x33, 0x37–0x50, …) still have glyphs in the international font: PKHeX's Western table maps them to the leftover Japanese kana glyphs (e.g. 0x0A こ, 0x18 ね, 0x1F ま). Decode them for display if present, but never produce them. 0xB7 is the currency glyph: pret names it `¥`, PKHeX's Western table decodes it as `$`.

Regional differences [Bulba; PKHeX `StringConverter3.GetQuoteLeft/Right`]: 0xB1/0xB2 render as “ ” (EN/IT/ES), „ “ (DE) or « » (FR). Decode quotes using the Pokémon's language byte. 0x34, 0x57–0x59 and 0x64 are non-name glyphs that vary by language.

Lengths: player and OT name 7 characters (JP 5), nickname 10 (JP 5), box name 8. Field sizes: player name 8 bytes (SB2 0x00), box name 9 bytes, PK3 nickname 10 bytes, PK3 OT name **7** bytes. Fixed-length fields: terminator 0xFF if shorter than the field. A full-length nickname (10) and a full-length OT name (7, copied from the first 7 bytes of the 8-byte player name by `CreateBoxMon`) have **no terminator** inside the PK3 [pret E `GetBoxMonData` `MON_DATA_NICKNAME`/`MON_DATA_OT_NAME` copy 10/7 bytes and append EOS themselves].

Padding after the terminator: Bulbapedia says the remainder is 0x00. The naming screen pads with 0xFF (memset EOS) [pret E `src/naming_screen.c`]. PKHeX notes INT player names are FF-filled. Truth: it depends on the code path. **Preserve the raw bytes** and compare names by decoded text.

---

## 11. Pokédex registration (so a received Pokémon is "caught")

Pokédex struct at SB2 0x18 [pret E/FR/RS `include/global.h` `struct Pokedex`]:

| SB2 offset | Field |
|---|---|
| 0x18 | order |
| 0x19 | mode (RSE: 1 = national view) |
| 0x1A | RSE `nationalMagic` (0xDA = national dex unlocked). FRLG: `unused`, always 0xDA |
| 0x1B | RSE `unknown2`. FRLG `nationalMagic` (0xB9 = national unlocked) |
| 0x1C | u32 unownPersonality (PID of the first Unown registered) |
| 0x20 | u32 spindaPersonality |
| 0x24 | u32 unknown3 |
| 0x28 | owned[52] |
| 0x5C | seen[52] |

Bit for National Dex number N: `byte[(N-1) >> 3]`, bit `(N-1) & 7` (LSB first) [pret `GetSetPokedexFlag`; Bulba]. 52 bytes are allocated (`ceil(412/8)`) and 386 bits are used. Bulbapedia's "49 bytes" is the used length.

Three copies of **seen** must agree: SB2 `seen` (0x5C), SB1 seen copy #1 and seen copy #2 (offsets in section 6). **owned** has one copy.

- RS/E: if the copies disagree when queried, the game **clears** the bit in all copies (and for "caught", also clears owned) [pret E `src/pokedex.c`, RS `src/pokedex.c`].
- FRLG: a mismatch just reads as not seen or not caught ("Anticheat" comments) [pret FR `src/pokedex_screen.c` `DexScreen_GetSetPokedexFlag`].

What the game does for a received non-egg Pokémon [pret E `src/trade.c` `UpdatePokedexForReceivedMon`; FR `src/trade_scene.c`]: set seen in all three copies, set owned, and **if it was not already caught** and the species is Unown or Spinda, store its PID at SB2 0x1C or 0x20 (`HandleSetPokedexFlag`). PKHeX does the same but records the Unown/Spinda PID only when not already *seen* [PKHeX `SAV3.SetDex`].

National Dex unlock (we never need to set it; listed for completeness and verified against PKHeX + Bulba + pret):

| | RS | E | FRLG |
|---|---|---|---|
| magic | SB2 0x1A = 0xDA (and mode 0x19 = 1) | same | SB2 0x1B = 0xB9 |
| flag `FLAG_SYS_NATIONAL_DEX` | 0x836 | 0x896 | 0x840 |
| var `VAR_NATIONAL_DEX` | 0x4046 = 0x0302 | 0x4046 = 0x0302 | 0x404E = 0x6258 |

The games check all three [pret `src/event_data.c` `IsNationalPokedexEnabled`]. Flag byte = flags base + (flag >> 3), bit (flag & 7). Var = vars base + 2 × (var − 0x4000).

Registering a non-regional species in RS/E before the national dex is harmless. It shows up once the national dex is unlocked.

---

## 12. Recommended operations for the widget

**Read:**

1. Normalise the container (section 2).
2. Classify the slots (3.5) and pick the active slot by the game's rule. If the newest slot is ERROR, warn: "the game would load the previous save; play and save once, then re-upload".
3. Detect the game (4.1).
4. Assemble SB2, SB1 and Storage.
5. Read the trainer info, the party (`count` entries of 100 bytes) and the 420 box slots.
6. For each record: decrypt, verify the checksum, check species 1–411 excluding 252–276, and treat `isBadEgg` as bad.
7. Store the **80-byte box record, encrypted exactly as it sits in the PC** (the `pk3` record format of `docs/ARCHITECTURE.md`; for a party Pokémon, its first 80 bytes, which are the same encrypted box struct), together with derived fields for display and battles. The 20-byte party extension is not part of the record (ARCHITECTURE.md: party-only data is dropped; the game rebuilds it on withdrawal, 8.1). Decrypting, editing and re-encrypting is lossless (8.4), so the encrypted form loses nothing.

**Deposit (save → Home):**

- **Boxes only (recommended):** zero the 80-byte slot.
- From the party, if supported at all:
  - Refuse if E `SB2[0xCA8] != 0`.
  - Refuse if it would leave no non-egg Pokémon with HP > 0. The game's own PC refuses to take your last usable Pokémon (`CountPartyAliveNonEggMonsExcept`).
  - If byte 0x55 ≠ 0xFF, store the 36-byte mail and set `mail[id].itemId = 0`.
  - Shift the later party entries down, put a `ZeroMonData`-style record in slot 5 (mail 0xFF), and decrement the count.

**Withdraw (Home → save):**

- **Into an empty box slot only (recommended):**
  1. Strip or refuse mail items. Mail-holders can't live in the PC.
  2. Check the item id exists in the target game: RS ≤ 346, FRLG ≤ 374, E ≤ 376, and not one of the placeholder ids listed in 9.2. (The numbering itself never differs between Gen-3 games, only the maximum; a FRLG key item such as 349–374 cannot be held in RS.) Unknown item → move it to the Home "bag" or strip it.
  3. Encrypt from canonical plaintext with a recomputed checksum.
  4. Set `hasSpecies`, clear `isBadEgg`, keep both egg flags consistent.
  5. Register the Pokédex (section 11) unless it is an egg.
- Party injection would need correct level and stats from Gen-3 base data and the host game's Deoxys form, HP = max, status 0 and mail handling. Avoid it.

**Commit:** recompute the affected sector checksums and write back as described in 3.6 (in place on the active slot). Re-parse the output and assert it round-trips. Diff the output against the input and assert that only the expected byte ranges changed: the target slot records, the dex bytes and the footer checksums.

**Guards:**

- **Mirror-consistency guard.** Before writing seen bits, check that `SB2.seen`, seen copy #1 and seen copy #2 are bitwise equal over bits 0–385. If not (an old 64-bit PC-port layout, a ROM hack, a misdetected game), skip the Pokédex update and warn.
- **Emerald PC-port heuristic.** If SB1 0x3C88–0x3D59 (Union Room phrases) is all zero, treat the save as read-only.
- Refuse to write if the active slot is not parity-consistent (3.5), if any ERROR slot exists, or if the save is a 0x10000 half image.

**Identity / clone detection (server side):** for a non-egg, `(PID, OTID, IV word with bit 30 masked off, origins word, raw OT name bytes)` identifies a Gen-3 Pokémon well. Nothing in the game changes these fields after creation (Gen 3 has no way to change the ability bit, and trades copy the whole 80-byte record). **Eggs are the exception:** hatching rebuilds the record (8.7), replacing OTID, OT name, OT gender (origins bit 15), ball and met level, so for eggs key on `(PID, the six IVs)` and re-key after hatching. Use the identity to detect the same Pokémon being deposited twice, which happens if a user restores an older copy of their save. The save itself cannot prevent that: users can always keep a copy of the file.

---

## 13. Gotchas

1. Per-game section sizes matter for checksums (3.3). Validating or writing an Emerald save with FRLG or RS sizes breaks section 0 or 4 (Frontier data, Walda phrase, Trainer Hill), and the game falls back to the old slot.
2. The active slot is `max counter % 2`, not "the slot with the larger counter" (3.5). Keep parity consistent.
3. Every signed slot must be fully valid, or the player sees "save file is corrupted".
4. PC slots can span two sectors (7). Always reassemble.
5. The party is packed and has a count. Boxes are fixed slots with no count. Empty party slots have mail byte 0xFF.
6. The party stat block is trusted on load and not recomputed. Never write garbage there.
7. Two egg flags. Eggs are language 1 with `タマゴ`. Friendship is egg cycles.
8. Bad Egg = checksum mismatch or the isBadEgg flag. The game makes the flags sticky on first access.
9. Deoxys's form depends on the game the Pokémon is currently in. Mew and Deoxys need ribbon bit 31 to obey in FRLG/E.
10. Unown's letter, Spinda's spots, gender, nature, shininess and Wurmple's evolution all derive from the PID (and OTID). Never re-roll the PID.
11. Text: language-dependent charset, quotes vary by language, trash bytes after the terminator. JP games truncate to 5 characters.
12. The backup slot still contains deposited Pokémon after an in-place edit (recovery → duplication). This is unavoidable at the file level; handle it with server-side clone detection.
13. Emerald's mid-challenge Frontier state ties the party to `selectedPartyMons`. Avoid party edits.
14. Encrypted money, coins, bag counts and berry powder (E/FRLG) use a key that changes between saves. Read only.
15. ROM hacks and expansion engines reuse the container but change the Pokémon layout and species ids. Reject species > 411, 252–276, impossible items, or failing detection checks.
16. Emulator RTC footers and RZIP compression must be round-tripped.
17. Trade evolutions (Kadabra, Machoke, Graveler, Haunter, Onix + Metal Coat, etc.) do not happen through Home transfers. That is a product decision.
18. Traded Pokémon (OT ≠ save owner) get boosted EXP and badge-gated obedience in-game. This is expected; never rewrite OT on trade.
19. Bulbapedia's section table, button-mode values, party padding claim and tie rule are wrong or Emerald-only (section 15).

---

## 14. Test vectors and synthetic-save testing

All vectors below were produced by compiling pret's own `GetSubstruct`, `CalculateBoxMonChecksum`, `EncryptBoxMon`, `CalculateChecksum`, `GetSaveValidStatus` and `CopySaveSlotData` (extracted verbatim from pokeemerald) into a throwaway native harness in a scratch directory outside the repo. A scratch JS re-implementation written from this document reproduced every vector (decrypt, checksum and re-encrypt all match). **Do not commit pret code.** Commit only the numbers.

### 14.1 PK3 vectors

All three use OTID 0xBEEF1234 (TID 4660, SID 48879), species internal 283 (Mudkip), exp 135 (level 5 on the Medium Slow table) and nickname "MUDKIP" (`C7 CF BE C5 C3 CA FF 00 00 00`). The non-egg vectors hold item 200 (Leftovers). Other fields:

- language 2 (EN), OT "SAM" (`CD BB C7 FF 00 00 00`), markings 0x05
- PP bonuses 0x1B, friendship 70
- moves 33 and 45 with PP 35 and 40
- EVs 1 2 3 4 5 6, cool 7, sheen 8, Pokérus 0x21
- met location 16 (Route 101), met level 5, game 3 (Emerald), ball 4 (Poké), OT gender female
- IVs 31/1/2/3/4/5 (HP/Atk/Def/Spe/SpA/SpD), abilityNum 1
- cool ribbon rank 4, champion ribbon, fateful bit

"PLAIN" is the decrypted record in **stored (shuffled) order**. "CIPHER" is what sits in the save.

Vector 1: PID 0xDEADBEEF, PID % 24 = 23 (MEAG), checksum 0x4930.

```
PLAIN  EFBEADDE3412EFBEC7CFBEC5C3CAFF0000000202CDBBC7FF0000000530490000211085A13F88418A0480008001020304050607000000000821002D0000000000232800001B01C800870000001B460000
CIPHER EFBEADDE3412EFBEC7CFBEC5C3CAFF0000000202CDBBC7FF0000000530490000FABCC7C1E42403EADF2C42E0DAAE4164DEAA4560DBAC4268FAAC6F60DBAC4260F8844260C0AD8A605CAC4260C0EA4260
```

Vector 2: PID 0xF6825A5A (= 4135737946), PID % 24 = 10 (AMGE), checksum 0x4930. It is **shiny**: 0xF682 ^ 0x5A5A ^ 0x1234 ^ 0xBEEF = 3 < 8. Nature = 4135737946 % 25 = **21 = Gentle**.

```
PLAIN  5A5A82F63412EFBEC7CFBEC5C3CAFF0000000202CDBBC7FF000000053049000021002D000000000023280000211085A13F88418A048000801B01C800870000001B460000010203040506070000000008
CIPHER 5A5A82F63412EFBEC7CFBEC5C3CAFF0000000202CDBBC7FF00000005304900004F4840486E486D484D606D484F58E8E951C02CC26AC86DC87549A548E9486D48750E6D486F4A6E4C6B4E6A486E486D40
```

(Both strings are exactly 160 hex digits. Re-verified 2026-10-24: decrypting this CIPHER with the algorithm in 8.4 gives this PLAIN, and re-encrypting gives the CIPHER back.)

Vector 3 (egg): PID 0x9F3A6C25, PID % 24 = 5 (GMEA), checksum 0x4663. Differences from vector 1: language 1, nickname `60 6F 8B FF`, flags byte 0x06, no item, friendship 20, met location 0, met level 0, both egg bits set.

```
PLAIN  256C3A9F3412EFBE606F8BFF0000000000000106CDBBC7FF00000005634600001B010000870000001B140000210080A13F8841CA0480008001020304050607000000000821002D000000000023280000
CIPHER 256C3A9F3412EFBE606F8BFF0000000000000106CDBBC7FF00000005634600000A7FD521967ED5210A6AD521307E55802EF694EB15FED5A1107CD6251478D221117ED529307EF821117ED5213256D521
```

Hand-check of vector 1's M block (`21 10 85A1 3F88418A 04800080`): origins 0xA185 gives met level 5, game 3, ball 4, OT female. IV word 0x8A41883F gives HP 31 … SpD 5, egg 0, ability 1. Ribbons 0x80008004 gives cool 4, champion, fateful.

### 14.2 Sector checksum vector

For a 0xF80-byte buffer where `byte[i] = (i*7 + 3) & 0xFF`: checksum over 0xF80 = **0x1FF0**, over 0x890 = **0xBCB2**, over 0x7D0 = **0x6B1A** [verified]. Re-computed independently on 2026-10-24 (Python, from 3.4), together with the other per-game sizes of table 3.3: 0xF2C → **0xC9CA**, 0xF24 → **0x5C7A**, 0xC40 → **0x7008**, 0xEE8 → **0x05FD**, 0xF08 → **0xBE42**. Every size in table 3.3 is a multiple of 4, so `floor(size/4)` never drops bytes.

### 14.3 Synthetic save construction and the slot-selection matrix

Build 0x20000 bytes filled with 0xFF (erased flash = "EMPTY"). For each slot to populate:

1. Write 14 sectors. For id i, use physical index `(i + base) % 14`.
2. Zero the sector, copy the logical block's first `size[i]` bytes and set the footer (id, checksum over `size`, signature, counter).
3. Put recognisable markers in SB2: name byte 0, TID at 0x0A. Put the party count at SB1 0x234 for E.

Expected results from pret's own logic with Emerald sizes [verified]:

| Case | Setup | Status | Counter chosen | Slot loaded |
|---|---|---|---|---|
| first | B: ctr 1 base 1, A erased | OK | 1 | B |
| normal | B: ctr 5, A: ctr 6 | OK | 6 | A |
| tieOdd | A and B: ctr 7 | OK | 7 | **B** |
| tieEven | A and B: ctr 8 | OK | 8 | **A** |
| parityMismatch | A: ctr 5, B: ctr 4 | OK | 5 | **B (older data!)** |
| newestCorrupt | normal + flip one data byte in A's id-0 sector | ERROR (0xFF) | 5 | B |
| wrap | B: ctr 0xFFFFFFFF, A: ctr 0 | OK | 0 | A |
| paddingNonZero | normal + non-zero byte in A's id-0 padding at 0xF30 | OK (PKHeX would flag it) | 6 | A |

### 14.4 Unit and property tests to write (no real game saves needed)

- Order table = lexicographic permutation (assert all 24 entries match 8.4).
- For random PID/OTID/plaintext: `encrypt(decrypt(x)) == x`, and the checksum after re-encode is correct. Flipping any single bit in 0x20–0x4F of the ciphertext makes the checksum fail (Bad Egg detection).
- Species map: bijection 277–411 ↔ 252–386. Identity for 1–251. 252–276 and > 411 rejected.
- Save builder → parser round trip for RS/FRLG/E sizes, every rotation base 0–13 and both slot parities.
- Detection: build RS/FRLG/E fixtures with the distinguishing bytes (FRLG `SB2[0xAC] = 01`, E random key plus non-zero tail, RS zero tail) and assert the result. Assert that "conflicting" fixtures give read-only.
- Edits: deposit from box slot #49 and #396 (sector-straddling), then assert that only those 80 bytes, plus the two sectors' checksum words, changed. Withdraw into an empty slot, re-parse and assert decrypted equality plus three equal seen copies and owned set.
- Footer and RZIP: append a 16-byte mGBA footer and assert it is preserved byte-exact. Round-trip RZIP v1.
- Text: decode/encode round trip for every Western code in charmap and the JP kana ranges, and the language-specific quote mapping.
- Optional manual or CI check for developers who own ROMs: open the output in mGBA and confirm there is no "corrupted" message and the Pokémon appears. Also open it in PKHeX GUI. Both are manual; we cannot ship ROMs.

---

## 15. Source disagreements (summary)

| Topic | Claim A | Claim B | We believe |
|---|---|---|---|
| Section 0 / 4 checksum sizes | Bulba: 3884 / 3848 for all games | pret + PKHeX: RS 0x890/0xC40, FRLG 0xF24/0xEE8, E 0xF2C/0xF08 | pret/PKHeX (Bulba lists Emerald only) |
| Tie / slot choice | Bulba: ties → B | PKHeX: ties → A, choose by larger counter | pret: slot = `maxCounter % 2` [verified] |
| Checksum length | game: `size` per id | PKHeX: always 0xF80 | game. Equal only when padding is zero; zero it on write |
| FRLG security key offset | Bulba: 0x0AF8 (plus a "copy" at 0xF20) | pret: `encryptionKey` at 0xF20; 0xAF8 is berry powder ^ key | pret |
| E "copy" of key at 0x1F4 | Bulba | pret: berry powder ^ key | pret |
| FRLG 0xAC game code | Bulba: u32 = 1 | pret: u8 0xAC = 1, u8 0xAD = 0; PKHeX: u16 0xAC = 1, u16 0xAE = 0 | Same bytes; use the u32 == 1 test |
| Unused party slots | Bulba: all 0x00 | pret `ZeroMonData`: mail byte = 0xFF | pret |
| String padding | Bulba: 0x00 after terminator | pret naming screen / PKHeX: 0xFF fill | Both happen; preserve raw bytes |
| Button-mode values | Bulba: 1/2/3 | pret: 0/1/2 | pret |
| Species index order | Bulba intro: mostly National order | Bulba list + pret: Hoenn species scrambled | pret / list |
| Pokédex byte count | Bulba: 49 | pret: 52 allocated | Both right (49 used, 52 reserved) |

---

## 16. Open questions / UNVERIFIED

- The Switch FRLG save file name pattern per language, and whether any header or footer exists. PKHeX's size check implies none, but no sample was inspected. (The sector *contents* are settled: pret's `firered_switch` build hands the emulator the same 0x1000-byte sectors as the cartridge code, see 2.1.)
- The PKHeX `FixDummyFlags` result for all-0xFF FRLG saves (4.1), read from code but not run.
- The EmeraldRecomp save file name and container. pokefirered-native and other 64-bit ports may have non-GBA SaveBlock1 layouts.
- R vs S and FR vs LG: no reliable save-only marker found. We rely on met-game heuristics and user confirmation.
- Whether editing the party mid RS Battle Tower streak or mid FRLG Trainer Tower causes problems. Policy: box-only edits avoid it.
- ~~Exact Gen-3 max-PP rounding~~ resolved in 8.6 (`CalculatePPWithBonus`).
- The RTC footer formats of emulators other than mGBA (VBA-M, My Boy!, RetroArch cores other than mGBA). Policy: preserve unknown footers verbatim.
- Japanese saves: layout parity is inferred from PKHeX behaviour and pokeruby's language-agnostic structs. No JP sample was tested.

---

## Sources

pret (no license; read only):

- pokeemerald: `include/save.h`, `src/save.c`, `include/global.h`, `include/pokemon.h`, `src/pokemon.c`, `include/pokemon_storage_system.h`, `src/pokemon_storage_system.c`, `src/load_save.c`, `src/new_game.c`, `src/pokedex.c`, `src/event_data.c`, `src/daycare.c`, `src/egg_hatch.c`, `src/trade.c`, `src/mail_data.c`, `src/main_menu.c`, `src/strings.c`, `src/rtc.c`, `src/overworld.c`, `src/frontier_util.c`, `src/naming_screen.c`, `include/constants/{species,pokedex,items,moves,global,pokemon,battle,flags,vars,battle_frontier}.h`, `src/data/pokemon/experience_tables.h`, `src/data/region_map/region_map_sections.constants.json.txt`, `charmap.txt`. Base: https://github.com/pret/pokeemerald/blob/master/
- pokefirered: `include/global.h`, `include/save.h`, `src/save.c`, `src/new_game.c`, `src/event_data.c`, `src/load_save.c`, `src/pokedex_screen.c`, `src/trade_scene.c`, `include/constants/{species,pokedex,items,flags,vars}.h`, `charmap.txt`. Base: https://github.com/pret/pokefirered/blob/master/
- pokeruby: `include/global.h`, `src/save.c`, `src/pokedex.c`, `src/event_data.c`, `include/constants/{species,items,flags,vars}.h`, `charmap.txt`. Base: https://github.com/pret/pokeruby/blob/master/

PKHeX (GPLv3; read only), base https://github.com/kwsch/PKHeX/blob/master/PKHeX.Core/:

- `Saves/SAV3.cs`, `SAV3E.cs`, `SAV3RS.cs`, `SAV3FRLG.cs`
- `Saves/Blocks/Gen3/SaveBlock3{Small,Large}{RS,E,FRLG}.cs`
- `Saves/Substructures/Gen3/SAV3BlockDetection.cs`, `RTC3.cs`
- `Saves/Util/SaveUtil.cs`, `Saves/Util/Checksums.cs`, `Saves/Util/Recognition/SaveHandlerFooterRTC.cs`
- `PKM/PK3.cs`, `PKM/Shared/G3PKM.cs`, `PKM/Util/PokeCrypto.cs`, `PKM/Util/EntityDetection.cs`, `PKM/Strings/StringConverter3.cs`, `PKM/Util/Conversion/ItemConverter.cs`
- `Legality/Legal.cs`
- commit https://github.com/kwsch/PKHeX/commit/c037829b29

Bulbapedia (CC BY-NC-SA; facts only):

- https://bulbapedia.bulbagarden.net/wiki/Save_data_structure_(Generation_III)
- https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon_data_structure_(Generation_III)
- https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon_data_substructures_(Generation_III)
- https://bulbapedia.bulbagarden.net/wiki/Character_encoding_(Generation_III)
- https://bulbapedia.bulbagarden.net/wiki/List_of_Pok%C3%A9mon_by_index_number_in_Generation_III

Emulators, containers, ports:

- mGBA `src/gba/savedata.c`, `include/mgba/internal/gba/savedata.h`: https://github.com/mgba-emu/mgba
- RetroArch `libretro-common/streams/rzip_stream.c`, `trans_stream_zlib.c`: https://github.com/libretro/RetroArch
- https://github.com/NTx86/pokeemerald-sdl2pc
- https://github.com/alanb2305/pokeemerald-native (`README.md`, `src/save.c`, `src/platform/sdl2.c`, `src/platform/system.c`, `include/global.h`)
- https://github.com/xinpw8/pokefirered-native (`src/host_flash.c`)
- https://github.com/mstan/EmeraldRecomp (README)

Switch FRLG release:

- https://www.videogameschronicle.com/news/pokemon-firered-and-leafgreen-coming-to-nintendo-switch-next-week-but-not-as-part-of-nso
- https://projectpokemon.org/home/profile/148848-hydration6555/ (forum report on `FireRed_e.sav` / `LeafGreen_e.sav`, anecdotal)
- https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon_HOME (HOME transfer from the Switch release)

---

## 17. Verification notes (adversarial check, 2026-10-24)

An independent pass re-derived every number in this document from primary sources instead of trusting the earlier write-up. Everything was fetched fresh into a scratch directory outside the repo (nothing below was committed; no pret or PKHeX code was copied into this file).

### 17.1 Sources and method

- **pret** (sparse clones of `include/` plus individual `src/` files via raw.githubusercontent.com): pokeemerald `731ad5bf` (2026-10-01), pokefirered `ce6406d8` (2026-10-20), pokeruby `5784633c` (2026-09-28).
- **PKHeX** master (head `a9ff306570`, 2026-10-22), read only: `SAV3.cs`, `SAV3{E,RS,FRLG}.cs`, `Blocks/Gen3/SaveBlock3Small*.cs`, `SAV3BlockDetection.cs`, `RTC3.cs`, `SaveUtil.cs`, `SaveHandlerFooterRTC.cs`, `PK3.cs`, `G3PKM.cs`, `EntityDetection.cs`, `StringConverter3.cs`.
- **Others:** mGBA `src/gba/savedata.c` + `savedata.h`; RetroArch `rzip_stream.c` + `trans_stream_zlib.c`; alanb2305/pokeemerald-native (`vanilla` branch) `README.md`, `include/global.h`, `src/save.c`; Bulbapedia "Save data structure (Generation III)" wikitext (`action=raw`).
- **Struct offsets were recomputed by compiler, not by hand.** The pret headers were compiled with `clang --target=armv4t-none-eabi` against a copy of each repo's `include/` in which every non-packed `struct`/`union` definition was given `__attribute__((aligned(4)))`, which emulates agbcc's 32-bit structure-size boundary (2.3). `offsetof`/`sizeof` values were read back from the generated assembly and compared with (a) this document and (b) every `/*0x…*/` offset comment in pret. Results: SB2 0xF2C / 0xF24 / 0x890, SB1 0x3D88 / 0x3D68 / 0x3AC0, PokemonStorage 0x83D0 in all three, BoxPokemon 80, Pokemon 100, Pokedex 0x78, Time 8, Mail 36, every SaveBlock1/SaveBlock2/BattleFrontier member offset equal to its pret comment except two **pret comment typos** (do not trust these comments): pokefirered `global.h` `dewfordTrends` is at 0x2F58, not the commented 0x2F54; pokefirered `pokemon_storage_system.h` `boxes` is at 0x0004, not the commented 0x0001. Without the alignment rule clang gives SB2 0xF08 and SB1 0x3C40, which shows the rule is essential.
- **Throwaway scripts written from this document's text** (not from pret code): a PK3 decoder/encoder (all three vectors in 14.1), a generator of the 24 substructure orders (compared with the numbers in pret's `GetSubstruct` table and with this document's table), a sector-checksum calculator (14.2), a synthetic-save builder plus a re-implementation of the slot rules read in pret `GetSaveValidStatus`/`CopySaveSlotData` (all eight rows of 14.3 reproduce, including which slot's data gets loaded), and a species-table generator joining `species.h` with the `pokedex.h` enum (identical for pokeemerald and pokefirered and identical to 9.1; pokeruby species numbering 0–412 identical).

### 17.2 Checked and correct (no change needed)

Sector size and footer (`SECTOR_DATA_SIZE 3968`, 116 unused bytes, id 0xFF4, checksum 0xFF6, signature 0x08012025 at 0xFF8, counter 0xFFC); all per-game chunk sizes in 3.3; the checksum algorithm; slot status rules including the 0xFFFFFFFF/0 wrap special case (identical code in all three games); rotation formula and first-save placement; HoF sectors (checksum in the id field); special-sector sentinel 0xB39D; SB2 prefix offsets 0x00–0xA0 and the Pokédex sub-struct; Emerald 0xAC key / 0x1F4 berry powder / 0x64C frontier / 0xCA8 / 0xCAA; FRLG 0xAC/0xAD flags, 0xB0, 0x898, 0xA98, 0xAF0, 0xAF8, 0xB00, 0xB10, 0xF20; every SB1 offset in the section 6 table for all three games; PC storage layout and section-13 local offsets 0x744/0x7C2; the eight straddling slots and their byte splits; the full PK3 layout, header bitfield, substructure contents and every bitfield position (origins, IV word, ribbon word); key = PID ^ OTID over 0x20–0x4F; checksum = u16 sum of 24 words; the shuffle table (it is the lexicographic permutation table); nature, gender (`PERCENT_FEMALE` → 31/63/127/191), shiny, ability, Unown letter, Wurmple, level and stat formulas; `ZeroMonData` (mail 0xFF), `BoxMonToMon`, `CompactPartySlots`, `LoadPlayerParty`; Bad-Egg flag behaviour; `hasSpecies` and the two egg flags; egg creation (`タマゴ` = 60 6F 8B, language 1, METLOC 0xFD for the hot-springs egg); Pokédex mirror rules (RS/E clear, FRLG "anticheat" read-only), trade registration and Unown/Spinda PID rule; national-dex magic, flags (0x836/0x896/0x840) and vars; species table (bijection 277–411 → 252–386, 252–276 → 387–411); item maxima, balls 1–12, mail 121–132, Leftovers 200, Oran 139; moves 1–354; abilities 1–77; METLOC 0xFD/0xFE/0xFF; game/language ids; the Western charmap rows; PKHeX quote mapping per language; RZIP header layout and zlib window bits; mGBA 16-byte RTC footer; PKHeX footer tolerance (0x0C–0x30 even, or 7); PKHeX in-place write of the active slot with 0xF80-byte checksums; PKHeX Japanese test (`u16 SB2[6] == 0`) and `FireRed_`/`LeafGreen_` + `.sav` name test; commit `c037829b29` (2026-02-27, "Initial gen3 virtual console checks"); the pokeemerald-native save paths and `IsOld64BitSaveBlock1` logic; every Bulbapedia claim the document attributes to Bulbapedia (3884/3848 for all games, ties → B, button mode 1/2/3, security key at 0x0AF8 with "copies" at 0x01F4/0x0F20, 0x00 padding, seen copies at section-4 offsets 0x0C0C/0x0CA4/0x0B98).

### 17.3 Changes made (old → new, with source)

1. **14.1 vector 2 nature:** "Nature 3 = Adamant" → **21 = Gentle**. 0xF6825A5A = 4135737946 and 4135737946 mod 25 = 21. (Arithmetic; the vector bytes themselves were right.)
2. **14.1 vector 2 CIPHER line** was 161 hex digits (an extra `0` in `…FF00000002002CDBBC7FF…`) → replaced with the 160-digit string that decrypts to the PLAIN line and re-encrypts back; removed the "careful copying" note.
3. **3.6 checksum position:** "recompute the u16 checksum at 0xFFC-8 = 0xFF6" (0xFFC − 8 is 0xFF4, the id field) → "stored at sector offset 0xFF6"; zero range made explicit as `[size, 0xFF4)` [pret `struct SaveSector`].
4. **7 straddle table** mixed a 1-based box with a 0-based slot ("#49 (box 2, slot 19)") → all-0-based columns plus an in-game 1-based column (recomputed).
5. **2.3** "Upstream pret already marks some structs ALIGNED(4) (for example struct Time)" → false: upstream `struct Time` has no attribute; the padding comes from agbcc's struct-size rule, and it is the native port that adds `ALIGNED(4)` [pret E `include/global.h`; pokeemerald-native `include/global.h`; compiler experiment in 17.1].
6. **8.7 hatching:** "language → game language, friendship 120, nickname → species name, met data set" → hatching **rebuilds** the record via `CreateMon` with the hatcher as OT, copying back only moves, IVs, metGame, markings, Pokérus and (FRLG/E) the fateful bit [pret E `src/egg_hatch.c`, FR `src/daycare.c`, RS `src/egg_hatch.c`].
7. **12 identity tuple:** "All of these are immutable after creation" → not true for eggs (OTID, OT name, OT gender, ball, met level change on hatch); egg bit masked out of the IV word; separate egg key [same sources].
8. **12 Read step 7:** "store the raw 80-byte decrypted canonical record (plus the party extension …)" contradicted the `pk3` record contract in `docs/ARCHITECTURE.md` (encrypted exactly as in the PC, no party data) → aligned with ARCHITECTURE.md.
9. **8.6 max PP:** "`basePP + floor(basePP/5) * ppUps` (UNVERIFIED rounding)" → exact `basePP + floor(basePP*20*ppUps/100)` [pret E `CalculatePPWithBonus`]; all Gen-3 base PPs are 1 or multiples of 5 (counted in pret `src/data/battle_moves.h`), so the two agree in practice. Open question in 16 marked resolved.
10. **3.5 link saves:** "Emerald link and Battle Frontier saves (SAVE_LINK) rewrite only sections 0–4 in place" → true for **all three** games; RS `SAVE_EREADER` rewrites id 0 only [pret FR/RS `src/save.c`].
11. **3.5 counter semantics:** "remember counter" → the counter of the last valid sector in physical order; added handling for footer ids ≥ 14 (the game does not range-check them) [pret `GetSaveValidStatus`].
12. **4.1 FF-corruption edge case:** "PKHeX … rewriting 0xAC = 1, 0xAE = 0" → PKHeX's `FixDummyFlags` as written stores 1 at 0xAE (inverted setter), and PKHeX's own detector would classify an all-FF save as Emerald; recommendation changed to decide by party/money fit [PKHeX `SaveBlock3SmallFRLG.cs`, `SAV3.cs`, `SaveUtil.cs`].
13. **2.1 half image:** "PKHeX reads slot 0 only" → PKHeX `IsG3` accepts only 0x20000 bytes, so whether it opens a 0x10000 file is UNVERIFIED [PKHeX `SaveUtil.IsG3`].
14. **2.1 detection order:** footer length `0 ≤ n ≤ 0x40` → `0 ≤ n < 0x40` (PKHeX takes `size & 0x3F`) [PKHeX `SaveHandlerFooterRTC`].
15. **10 Western table:** gaps were drawn as `·`, the same glyph as code 0xAF → explicit gap codes 0x0A/0x18/0x1F; added the non-name glyph rows (0x2C, 0x34, 0x55–0x59, 0x77, 0x79–0x7C, 0x84–0x86, 0xA0), the 0xF7–0xF9 escape bytes and named control codes [pret E `charmap.txt`, `include/constants/characters.h`]. **Japanese table** rebuilt with per-row provenance; rows not in pret's charmap marked [PKHeX]; "0xF1–0xF6 are invalid in Japanese" → only HOME's Japanese map rejects 0xF1–0xFE, PKHeX's table decodes them [PKHeX `StringConverter3`].
16. **8.2 language:** "nickname and OT … limited to 5 characters" → only the nickname is cut to 5; the OT is wrapped in JP control codes but not truncated [pret E `GetBoxMonData`, `ConvertInternationalString`].
17. **12 withdraw step 2:** "some ids differ per game" → item numbering is identical across RS/FRLG/E (only the maximum differs); placeholder ids listed in 9.2 [compared across the three `items.h`].
18. **3.1 special sectors:** the sentinel rule applies to FRLG's Trainer Tower too; payload layout (bytes 4–0xFFF) and HoF counter 0 added [pret FR/E `src/save.c`].

### 17.4 Gaps filled

Switch FRLG evidence from pret's `firered_switch`/`leafgreen_switch` build (2.1); the agbcc struct-alignment rule and its consequence for PC ports (2.3); Emerald tail always non-zero via `opponentNames` 0xFF at SB2 0xEE1/0xEE9 and the key-0 caveat (4.1); FRLG var 0x403C / flag 0x838 byte locations (4.1); Stadium and JP Gen-2 size collisions (4.4); PKHeX `CompareFooters` 0xFFFFFFFF rule and its lack of signature/checksum checks (3.5); mail field offsets, 2-byte tail padding and the Unown 30000+letter species encoding (8.8); per-field byte sizes and missing terminators for 7-character OT names (10); met-location ranges for E, FRLG (same ids up to 0xC4) and RS (0x00–0x57) (9.5); unused item ids and the shared item numbering (9.2); extra sector-checksum vectors for every per-game size (14.2).

### 17.5 Still uncertain (UNVERIFIED)

- Japanese cartridges: there is no Japanese decompilation, so the shared-layout claim (4.3), the JP-only charset rows marked [PKHeX], and "Japanese games ignore the language byte" rest on PKHeX behaviour and Bulbapedia.
- That GCC with pret's `modern` flags (`-mabi=apcs-gnu`) keeps the 4-byte struct rule; not confirmed by an actual build (only matters for people building pret themselves, not for reading retail saves).
- Switch FRLG: the on-disk container written by the Switch emulator, and file names for other languages. EmeraldRecomp container. pokefirered-native and other 64-bit ports' layouts; the "old 64-bit" field shifts were not recomputed.
- PKHeX `FixDummyFlags` behaviour in practice (read from code, not run).
- Pokérus nibble meaning, marking-bit glyph order, the language-dependent glyphs at 0x34/0x57–0x59/0x64, and "Bulbapedia's intro on index order": from Bulbapedia/PKHeX, not visible in pret data.
- Whether editing the party during an RS Battle Tower streak or FRLG Trainer Tower run breaks anything (policy: box-only edits).
