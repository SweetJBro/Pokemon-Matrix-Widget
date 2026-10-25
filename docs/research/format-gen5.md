# Generation 5 save and Pokémon formats (Black, White, Black 2, White 2)

Status: research notes for the Gen 5 save parser and writer in `pokemon-matrix-widget`.
Researched 2026-10-24; adversarially re-verified the same day against freshly fetched sources (§20 lists what was checked and every correction). Every non-obvious fact cites its source. **UNVERIFIED** marks anything not confirmed by two independent sources or by reading game code.

Licensing note: PKHeX (GPLv3), the `pokebw2` decompilation (GPLv3) and the Frigate port (GPLv3) were **read only**. These notes describe their offsets and algorithms in our own words and tables. Offsets, sizes and constants are facts about the game's data, not copied code. The pseudo-code here was written for these notes and can be reimplemented freely under our MIT license.

---

## 0. Key facts

| Item | BW (Black/White) | B2W2 (Black 2/White 2) |
|---|---|---|
| Raw save (flash chip image) | 0x80000 bytes (512 KiB, 4 Mbit flash) | same |
| Main copy | 0x00000 – 0x23F9B | 0x00000 – 0x25FA3 |
| Backup copy | 0x24000 – 0x47F9B (main + 0x24000) | 0x26000 – 0x4BFA3 (main + 0x26000) |
| Data blocks | 69 (indices 0–68) | 73 (indices 0–72) |
| CRC table (the "checksum block") | 0x23F00, 0x8C bytes (69 entries + 2 bytes padding) | 0x25F00, 0x94 bytes (73 entries + 2 bytes padding) |
| Save footer (0x10 bytes) | 0x23F8C | 0x25F94 |
| Footer CRC (CRC of the CRC table) | u16 @ 0x23F9A | u16 @ 0x25FA2 |
| Footer magic | 0x31053527 @ 0x23F94 | 0x31053527 @ 0x25F9C |
| Footer "size" field | 0x23F9C @ 0x23F90 (derived, see §5.4) | 0x25FA4 @ 0x25F98 |
| Checksum algorithm | CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. Check value for "123456789" is 0x29B1 | same |
| Party | block 26 @ 0x18E00: u32 capacity, u32 count, 6 × 220-byte PK5 starting at 0x18E08 | same |
| PC boxes | 24 boxes × 30 slots × 136 bytes. Box *b* is at 0x400 + 0x1000·*b*. 8/16/24 boxes unlocked | same |
| Box names, current box | block 0 @ 0x00000 | same |
| Trainer block | block 27 @ 0x19400 (0x68 bytes) | block 27 @ 0x19400 (0xB0 bytes) |
| Pokédex | block 55 @ 0x21600 (0x4D4) | block 54 @ 0x21400 (0x4DC) |
| PK5 encryption | identical to PK4: checksum-seeded LCG XOR, 4×32-byte block shuffle by PID bits 13–17 | same |
| Text | UTF-16LE, terminator 0xFFFF, game-specific glyphs at U+2460–U+2487 | same |
| Species field | National Dex number (1–649); there is no internal index table | same |
| Max IDs | items ≤ 632, moves ≤ 559, abilities ≤ 164, balls ≤ 25 | items ≤ 638, others the same |

Language variants (JPN, ENG, FRE, ITA, GER, SPA, KOR) share **one** layout. PKHeX has a single class per game pair with no language branching ([SAV5BW.cs], [SAV5B2W2.cs], [SaveUtil.cs]). Only text content and the language bytes differ (§13).

---

## 1. Sources

| Tag | Source | What it gave | Notes |
|---|---|---|---|
| [pokebw2] | https://github.com/fuddlesworth/pokebw2 (B2W2 decompilation, GPLv3, active Oct 2026). Files read: `src/gfl/backup_system.c`, `src/gfl/savedata.c`, `include/gfl/backup_system.h`, `src/system/save_table.c`, `src/system/save_control.c`, `include/save/save_control.h`, `src/ov331/save_outside.c`, `src/system/poke_tool.c`, `include/pml/poke_party.h`, `src/system/pokeparty.c`, `src/system/box_savedata.c`, `include/save/box.h`, `src/system/pokedex.c`, `include/save/pokedex.h`, `include/save/trainer_data_savedata.h`, `include/save/player_info.h`, `include/save/playtime.h`, `include/save/key_info.h`, `include/save/memory_link_savedata.h`, `include/save/key_data_savedata.h`, `src/ov332/wb_save_block.c`, `src/ov332/wb_save_convert.c`, `src/ov194/pokemontrade_save.c`, `src/system/pml_met_data.c`, `src/ov214/worldtrade_box.c`, `src/ov255/box2_seq.c`, `src/system/pml_item.c`, `include/save/dream_world.h` | Ground truth for the save system: block alignment, footers, CRC table, how a copy is chosen, encryption, PK5 bitfields, Pokédex registration, trade side effects | Builds the USA/Europe B2W2 ROMs byte for byte, per its README. `ov332/wb_save_block.c` holds B2W2's own table of **BW** block sizes, used by Memory Link to read BW saves. That table confirms the BW layout independently |
| [Frigate] | https://github.com/CallanCampos/Frigate (native PC/macOS port of B2W2 built on pokebw2, GPLv3). Files read: `port/README.md`, `port/hal/card/port_card.h`, `port/docs/game-changes.md` | The PC port's save is the same 512 KiB flash image as melonDS's `.sav`. Names, folders, and refusal rules | §14 |
| [pokeblack] | https://github.com/squiddonaut/pokeblack (English Black decompilation) | Too early to help: it has almost no C code and nothing about saves | Checked 2026-10-24 |
| [PKHeX] | https://github.com/kwsch/PKHeX (GPLv3), `master` as of 2026-10-24: `PKHeX.Core/Saves/SAV5.cs`, `SAV5BW.cs`, `SAV5B2W2.cs`, `Saves/Access/SaveBlockAccessor5BW.cs`, `SaveBlockAccessor5B2W2.cs`, `Saves/Blocks/BlockInfoNDS.cs`, `Saves/Util/Checksums.cs`, `Saves/Util/SaveUtil.cs`, `PKM/PK5.cs`, `PKM/PK4.cs`, `PKM/Util/PokeCrypto.cs`, `PKM/Strings/StringConverter5.cs`, `StringConverter345.cs`, `StringConverter4Util.cs`, `Saves/Substructures/Gen5/*.cs` (BoxLayout5, PlayerData5, Misc5, Daycare5, BattleBox5), `Saves/Substructures/PokeDex/Zukan5.cs`, `Saves/Util/Recognition/SaveHandler*.cs`, `Legality/Legal.cs`, `Game/Locations/Locations.cs` | Full block tables with checksum and mirror offsets, PK5 field map, ext-data footers, container handlers | Edits only the main copy; see §5.6 |
| [PP-BW] | Project Pokémon, "BW Save Structure" https://projectpokemon.org/home/docs/gen-5/bw-save-structure-r73/ | BW block table. Backup at 0x24000 | Has typos (§18) |
| [PP-B2W2] | Project Pokémon, "B2W2 Save Structure" https://projectpokemon.org/home/docs/gen-5/b2w2-save-structure-r72/ | B2W2 block table. Backup at 0x26000. Extra-content map, 3DS link area | Has typos (§18) |
| [PP-PK5] | Project Pokémon, "BW Pokémon structure" https://projectpokemon.org/home/docs/gen-5/bw-save-structure-r60/ | PK5 field list, Unicode glyph replacement table, trash-byte notes | Its "save file location" section is left over from Gen 4 (§18) |
| [Bulba-PK4] | Bulbapedia "Pokémon data structure (Generation IV)" (via the Wayback Machine, https://web.archive.org/web/2024/https://bulbapedia.bulbagarden.net/wiki/Pok%C3%A9mon_data_structure_(Generation_IV)) | Cross-check of the checksum, shuffle and PRNG | Bulbapedia blocks direct fetches. The Gen V pages ("Pokémon data structure (Generation V)", "Save data structure (Generation V)") **do not exist**: the archived page says "There is currently no text in this page" |
| [PokeAPI] | https://github.com/PokeAPI/pokeapi `data/v2/csv/*.csv` (BSD-3-Clause style license) | Machine-readable item game indices per generation, multilingual species names | Gen 5 item indices have duplicates (§10) |
| [Showdown] | https://github.com/smogon/pokemon-showdown `data/*.ts` and `data/mods/gen5/*.ts` (MIT) | Species, move, item and ability numbers, plus Gen 5 base stats | Item `num` equals the Gen 5 item index for every item checked (§10) |
| [DeSmuME] | https://github.com/TASEmulators/desmume `desmume/src/mc.cpp` (GPLv2, read only) | `.dsv` footer layout (§2) | Added during verification |

All local copies of these files are in `/tmp/claude-1000/pkres/gen5/` (outside the project).

---

## 2. Containers and file sizes (what users will upload)

The game data is always the 4 Mbit (0x80000-byte) flash image. Containers wrap it:

| Source | File | Layout | Handling |
|---|---|---|---|
| melonDS (desktop) | `<rom name>.sav` | Raw 0x80000 bytes, nothing before or after ([Frigate] `port_card.h`: melonDS 1.1 uses save type 6, a 524,288-byte flash, written as-is) | Use as-is. melonDS pads or truncates silently if it picked the wrong backup size ([Frigate] README). Accept a larger file whose bytes past 0x80000 are all 0xFF, and keep only the first 0x80000 |
| Frigate (B2W2 PC port) | `IREO.sav` (Black 2 US/EU) or `IRDO.sav` (White 2 US/EU) in `~/.local/share/Frigate` (Linux, or `$XDG_DATA_HOME/Frigate`), `~/Library/Application Support/Frigate` (macOS), `%APPDATA%\Frigate` (Windows) | Raw 0x80000 bytes, "byte for byte the chip as a cartridge dump or melonDS's .sav has it" ([Frigate] README "Saves") | Same as melonDS. Frigate refuses (never overwrites) any file that is not exactly 524,288 bytes, so downloads must be **exactly 0x80000 bytes** |
| DeSmuME | `.dsv` | Raw image + 0x7A-byte footer (122 bytes) ending in ASCII `\|-DESMUME SAVE-\|` ([PKHeX] `SaveHandlerDeSmuME.cs`). Footer layout ([DeSmuME] `mc.cpp`, `BackupDevice` footer writer/reader): 82-byte ASCII note `\|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:`, then six u32 LE: `size` (bytes actually written), `padSize` (length of the raw image before the footer), `type`, `addr_size`, `mem_size`, `version` (must be 0), then the 16-byte cookie. Counted from the end of the file: `padSize` = u32 @ end−0x24, `version` = u32 @ end−0x14 | Read `padSize`; require `padSize == 0x80000` and file size `== padSize + 0x7A` (PKHeX only recognises exactly 0x8007A bytes). Strip the footer to parse. Re-attach the original footer unchanged on download |
| DraStiC (Android) | `.dsv` | Believed to match DeSmuME's format. **UNVERIFIED** | Detect by content, not extension: DeSmuME cookie at the end → DeSmuME rules; exactly 0x80000 bytes with no cookie → raw |
| Action Replay DS / Max Drive | `.duc`, `.dss` | 0xA4-byte header + raw (total 0x800A4) ([PKHeX] `SaveHandlerARDS.cs`) | Strip the header. Re-attach it on download |
| Real cartridge dumps (GodMode9, Checkpoint/JKSM on 3DS, NDS dumpers, TWiLight Menu++/nds-bootstrap saves) | `.sav` | Raw 0x80000 | Use as-is |
| No$GBA | `.sav` with a "NocashGbaBackupMediaSavDataFile" header, possibly compressed | Not handled by PKHeX's handler list. **UNVERIFIED** | Reject with "export a raw .sav" |

ROM game codes (only used in emulator and port file names; **the save itself contains no game code**): IREO = Black 2 (US/EU), IRDO = White 2 (US/EU), confirmed by [Frigate]. IRBO and IRAO for Black and White (US/EU) are **UNVERIFIED**. The fourth letter changes by region: J = Japan, K = Korea, D/F/I/S = European language builds (**UNVERIFIED**).

---

## 3. Detecting the game

Neither the save nor its footer carries a game ID. Detection uses the layout:

1. Strip any container (§2). The remainder must be exactly 0x80000 bytes.
2. For each candidate layout `L` in {BW: `tableOfs=0x23F00, nBlocks=69, copySize=0x24000`; B2W2: `tableOfs=0x25F00, nBlocks=73, copySize=0x26000`}, check the footer of the main copy, and also of the backup copy at `+copySize`:
   - `crcsSize = nBlocks*2 + (nBlocks odd ? 2 : 0)`, which gives 0x8C for BW and 0x94 for B2W2.
   - `footer = tableOfs + crcsSize`, which gives 0x23F8C for BW and 0x25F94 for B2W2.
   - Valid when `u32@footer+4 == footer+0x10` (the size), `u32@footer+8 == 0x31053527` (the magic), and `u16@footer+0xE == CRC16(table bytes [tableOfs, tableOfs+crcsSize))`.
   - All offsets here are **relative to the copy's base** (0 for main, `copySize` for backup). The stored size is the copy-relative save size (0x23F9C / 0x25FA4) in **both** copies; never compare it with an absolute file offset such as 0x47F9C ([pokebw2] `SaveData_CheckFooter` compares `footer->size` with the constant `saveSize`).
3. PKHeX checks only the CRC: BW first (CRC of 0x23F00..0x23F8B against the u16 at 0x23F9A), then B2W2 (CRC of 0x25F00..0x25F93 against 0x25FA2) ([PKHeX] `SaveUtil.IsG5BW/IsG5B2W2`, `IsValidFooter5`). In a B2W2 save, the BW footer area 0x23F00..0x23F9B lies inside the Join Avenue block (0x23C00–0x252A7). A CRC-only check therefore matches by chance about once in 65,536 saves. **Also check the magic and the size**: this ends the ambiguity and costs nothing.
   - Recommended order (resolves the tension with the "log, don't hard-fail" advice for BW in §5.4): test **B2W2 first, strictly** (CRC + size + magic; every value is confirmed by the decomp). Only if B2W2 fails, test BW: require the CRC, and log a warning instead of rejecting if the BW size or magic differs from 0x23F9C / 0x31053527. A BW save cannot pass the strict B2W2 test by accident (0x25F00–0x25FA3 of a BW image is backup box-2 data, and size + magic + CRC would all have to match), while a B2W2 save can pass a CRC-only BW test by accident.
4. If only the backup copy's footer is valid, the save still loads in-game (§5.5). Detect the same way using `copySize + footer`.
5. If neither layout validates, reject the file. It may be Gen 4 (also 0x80000 bytes; PKHeX tells them apart by the Gen 4 footers at 0x40000+), a blank or erased chip (all 0xFF), or corrupted.

Telling sibling games apart: once the layout is known, the **version byte** at trainer block +0x1F (absolute **0x1941F**) is 20 = White, 21 = Black, 22 = White 2, 23 = Black 2 ([PKHeX] `GameVersion.cs`, `PlayerData5.Game`; [pokebw2] `PlayerInfo.version`, "The game version the player started on"). The byte records the game that **started** the save. A White 2 save loaded on a Black 2 cartridge still reports White 2 (community reports on projectpokemon.org forums; consistent with the field's meaning).

Language: trainer block +0x1E (absolute **0x1941E**). 1 JPN, 2 ENG, 3 FRE, 4 ITA, 5 GER, 7 SPA, 8 KOR ([PKHeX] `PlayerData5.Language`). The decomp calls this byte `region`, but its new-game initializer writes 2 in the USA/Europe build, which matches LANGUAGE_ENGLISH = 2. We follow PKHeX (§18).

Extra sanity checks (cheap, optional): the Pokédex magic 0xBEEFCAFE at the start of the dex block (B2W2: [pokebw2] `POKEDEX_MAGIC`; BW **UNVERIFIED** but expected); party capacity u32@0x18E00 == 6; party count u32@0x18E04 ≤ 6; box-main `trayCount` byte@0x003DD ∈ {8, 16, 24}.

---

## 4. Flash map (0x80000 bytes)

### 4.1 B2W2

| Range | Contents | Source |
|---|---|---|
| 0x00000–0x25FA3 | **Main copy** of the main save (73 blocks, CRC table, footer) | [pokebw2] `save_table.c`: `SAVE_MAIN_ADDR 0`, `SAVE_SIZE 0x26000` |
| 0x25FA4–0x25FFF | Unused padding (not covered by any CRC) | derived |
| 0x26000–0x4BFA3 | **Backup copy** (same layout) | `SAVE_BACKUP_ADDR 0x26000` |
| 0x4C000 | Extra save: battle video 0 (0x1A00) | `sv_extra_blk_data` |
| 0x4DA00, 0x4F400, 0x50E00 | Battle videos 1–3 (0x1A00 each) | same |
| 0x52800 | C-Gear skin (0x2800) | same |
| 0x55000 | Battle Test (0x800) | same |
| 0x55800 | Musical distribution (0x18000) | same |
| 0x6D800 | Pokédex skin (0x6800) | same |
| 0x74000 / 0x75800 | Hall of Fame main / backup (0x1800 each; the only extra save with a backup copy) | same |
| 0x77000 + 0x600·k, k = 0..7 | PokéStar Studios films (0x600 each) | same |
| 0x7A000, 0x7B400, 0x7C800 | PWT tournament downloads (0x1400 each) | same |
| 0x7DC00 | Extra save 20 (0x400 area, 0xC8-byte block; PKHeX calls it "KeyData") | same; [PKHeX] `SAV5B2W2.KeyDataOffset` |
| 0x7E000 / 0x7E400 | **Outside-the-save data**: Mystery Gift cards, two copies | [pokebw2] `save_outside.c` (`GIFTS_ADDR`, `GIFTS_BACKUP_ADDR`) |
| 0x7E800 | **Outside-the-save Key System data**: key info + Memory Link (KeySystemData, 0x214 bytes after a 12-byte header). Magic 0xA10F49AE. The whole outside area spans 0x7E000–0x7EAFF | same (`KEYS_ADDR`, `SAVE_OUTSIDE_MAGIC`) |
| 0x7F000– | "CRGF" area: Nintendo 3DS link (Pokémon Dream Radar) data | [PKHeX] `ExtUnkCRGF`; [PP-B2W2] |

Each extra save uses the same container format as the main save: one block, its 4-byte block footer, a 4-byte CRC table (1 entry + 2 bytes padding) at the next 0x100 boundary, then the 0x10 footer with the same magic. The extras load only when the trainer block's marker for that extra is 0xC21E ([pokebw2] `TrainerDataSave_IsMarkerSet`; [PKHeX] `PlayerData5.UpdateExtData`).

### 4.2 BW

| Range | Contents | Source |
|---|---|---|
| 0x00000–0x23F9B | **Main copy** (69 blocks, CRC table, footer) | [PKHeX], [PP-BW], [pokebw2] `wb_save_block.c` |
| 0x23F9C–0x23FFF | Padding | derived |
| 0x24000–0x47F9B | **Backup copy** | [PP-BW] "backup save starts at 0x24000"; [PKHeX] `SIZE_G5BW = 0x24000` |
| 0x4A000, 0x4C000, 0x4E000, 0x50000 | Battle videos (0x2000 areas) | [PKHeX] `SAV5BW` |
| 0x52000 | C-Gear skin | same |
| 0x55000 | Battle Test | same |
| 0x56000 | Musical download (0x20000) | same |
| 0x76000 | Pokédex skin | same |
| 0x7C800 / 0x7E000 | Hall of Fame main / backup | same |
| 0x7F800 / 0x7FC00 | "Link" data (0x400 each) | same. Purpose **UNVERIFIED** (possibly BW's outside-the-save gift copies) |

### 4.3 Rule for our writer

**Only ever write inside the two main-save copies** (BW 0x00000–0x23FFF and 0x24000–0x47FFF; B2W2 0x00000–0x25FFF and 0x26000–0x4BFFF). Preserve every other byte verbatim, including the padding inside the copies. Everything else is the Key System, Memory Link, Dream Radar, DLC, Hall of Fame, and Mystery Gift data, which users cannot recreate.

---

## 5. Save container mechanics (GFL backup system)

Primary source: [pokebw2] `src/gfl/savedata.c` and `src/gfl/backup_system.c`. BW uses the same system: its block sizes in [pokebw2] `wb_save_block.c` include the same 4-byte footers and 0x100 alignment, its table ends with 0x8C (CRC table) and 0x10 (footer), and PKHeX's BW table agrees offset for offset (checked programmatically, §6).

### 5.1 Block layout rule

- Block *i* has a data size `size_i`: the C struct's size rounded **up to a multiple of 4**.
- The block data is immediately followed by a 4-byte **block footer**:
  - `+size_i+0` u16 **block save counter**: incremented each time a save writes this block because its contents changed.
  - `+size_i+2` u16 **block CRC** = CRC16 over the `size_i` data bytes.
- The next block starts at the next 0x100 boundary after the footer: `next = off + size + 4`, rounded up to a multiple of 0x100 unless already aligned.
- After the last block come the **CRC table** (u16 per block, plus one u16 of padding when the block count is odd), then the **save footer** (0x10 bytes).
- Bytes between a block footer and the next 0x100 boundary are padding, not covered by any CRC. Preserve them.

### 5.2 CRC16

CRC-16/CCITT-FALSE: polynomial 0x1021, initial value 0xFFFF, MSB-first (no reflection), no final XOR. Check value: CRC("123456789") = 0x29B1. CRC of zero bytes = 0xFFFF.
Sources: [pokebw2] `MATHi_CRC16InitTable(&table, 0x1021)` plus `MATH_CalcCRC16CCITT`; [PKHeX] `Checksums.CRC16_CCITT` (init bytes 0xFF/0xFF). We confirmed that the table-free form in PKHeX equals a standard bitwise CCITT-FALSE on 1,000 random inputs.

```
crc = 0xFFFF
for each byte b: crc ^= b << 8; repeat 8: crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
```

The same CRC is used for block CRCs, the footer's CRC of the table, the outside-the-save headers, and the extra saves.

### 5.3 CRC table ("checksum block")

- BW: 0x23F00..0x23F8B. Entry *i* at 0x23F00 + 2*i* (i = 0..68). The pad u16 at 0x23F8A is included in the footer CRC.
- B2W2: 0x25F00..0x25F93. Entry *i* at 0x25F00 + 2*i* (i = 0..72). The pad u16 at 0x25F92.
- Entry *i* must equal the block CRC stored in block *i*'s footer. PKHeX calls this the "mirror" ([PKHeX] `BlockInfoNDS`: writes the CRC at both `ChecksumOffset` and `ChecksumMirror`).
- PKHeX lists the table as a 70th/74th "block" whose checksum is at 0x23F9A/0x25FA2. That checksum is the footer CRC (§5.4), stored at a different relative position from the ordinary block CRCs.

### 5.4 Save footer (0x10 bytes) — BW @0x23F8C, B2W2 @0x25F94

| Offset in footer | BW abs | B2W2 abs | Type | Meaning |
|---|---|---|---|---|
| +0x0 | 0x23F8C | 0x25F94 | u32 | **Global save counter**: incremented once per in-game save |
| +0x4 | 0x23F90 | 0x25F98 | u32 | Save size = table offset + table size + 0x10. **0x23F9C** for BW, **0x25FA4** for B2W2 (derived from [pokebw2] `SaveData_BuildTable`: `total = footerSize + blocksEnd + crcsSize`). The load rejects the footer if this differs |
| +0x8 | 0x23F94 | 0x25F9C | u32 | Magic **0x31053527** ([pokebw2] `SAVE_MAGIC`; [PKHeX] `WriteFooter51` writes the same value for BW and B2W2 extra saves) |
| +0xC | 0x23F98 | 0x25FA0 | u16 | Unknown. Preserve |
| +0xE | 0x23F9A | 0x25FA2 | u16 | CRC16 of the whole CRC table (`crcsSize` bytes, padding included) |

The BW size value 0x23F9C and the BW magic come from the shared system plus PKHeX's BW extra-save writer. Additional support for the size: B2W2's own table of BW block sizes ([pokebw2] `ov332/wb_save_block.c`, 71 entries) ends with a 0x8C entry (the CRC table) and a 0x10 entry (a footer of the same size as B2W2's), and the running sum of its entries is exactly 0x23F9C (recomputed during verification). The magic value itself appears in no BW-specific source. Neither has been checked against a real BW save (**UNVERIFIED but strongly implied**). The parser should log any mismatch instead of hard-failing until a real BW save confirms it.

When saving, the game writes the footer **last byte last** (the first 15 bytes, then byte 0xF), so a torn write leaves the footer invalid ([pokebw2] `SaveData_WriteFooterHead/LastByte`).

### 5.5 Which copy is current (the game's load algorithm, paraphrased from [pokebw2] `SaveData_LoadWithBackup`)

Footer check for a copy: result 0 = valid, 1 = size and magic OK but the table CRC is wrong, 2 = size or magic wrong.

1. Check both footers.
   - If neither is valid: if either result is 1, the game reports **corrupted** (BROKEN). Otherwise it treats the save as **no save** (new game).
   - If exactly one is valid, its CRC table and footer (`crcsSize + 0x10` bytes) are copied over the other copy's table and footer in memory, and the other copy's table and footer are marked for rewrite. Block data is not copied at this step.
2. Pick the **preferred copy**: main if main's footer is valid AND (main.count ≥ backup.count, OR backup is invalid, OR main.count == 0 and backup.count == 0xFFFFFFFF, a wrap-around). Otherwise backup.
3. Walk the blocks using the preferred copy's CRC table `T`. For each block *i*:
   - The block is usable from a copy if that copy's block-footer CRC == `T[i]` AND the CRC recomputed over that copy's data also equals it.
   - If neither copy is usable, the preferred table fails. Retry from step 3 with the other copy's table. If that fails too: **BROKEN** (the game's "save data is corrupted" path; it reinitializes the save).
   - If only main is usable, main's data is used and backup's block is marked for rewrite. If only backup is usable, backup's block (data + 4-byte block footer) is copied over main in memory and main is marked for rewrite.
   - If both are usable but their block counters differ, the copy whose table `T` is being used keeps its block: when that is the backup, backup's bytes are copied over main (main marked for rewrite); when it is main, backup is marked for rewrite. This is not an error. (With equal CRCs the two blocks are almost certainly identical anyway.)
   - After the walk, the table and footer of the copy whose table was used are copied into the in-memory image, the global count is taken from that footer, and the **other** copy's table and footer are marked for rewrite.
4. After a successful load, the next in-game save rewrites every marked block, so both copies converge.

Saving ([pokebw2] `SaveData_SaveStepSingle`, `SaveData_WriteBlock`, `SaveData_SwapBlockStatuses`):
- `count++`. Every block that the load marked, and every block whose memory image differs from the **main** copy on the card, has its block counter incremented; its CRC is recomputed when it is written.
- Each marked item carries the copy it must be written to. Pass 0 writes the marked blocks, then the CRC table, then the footer (first 15 bytes, then byte 0xF), each to the copy its mark names (unmarked table/footer default to main). Pass 1 swaps every mark (main ↔ backup) and writes the same items to the other copy. The marks are cleared after pass 1.
- Steady state (every save after the first one of a session): changed blocks, table and footer go to main in pass 0 and to backup in pass 1.
- **First save after a load**: the loader marked the non-preferred copy's table and footer (normally the backup's), so pass 0 writes the changed blocks to main but the table and footer to the **backup**, and pass 1 does the reverse. A save interrupted between the passes therefore leaves the backup with the higher footer count and main with the newer blocks; the next load prefers the backup's table and takes the changed blocks from main. So "backup newer than main" is a state real saves can be in, not a theoretical one.
- After a complete save both copies hold the same blocks, table and global count. Inter-block padding is never written by the game, so it may differ between copies; nothing checks it.

Other load gates ([pokebw2] `SaveControl_Create`, `SaveControl_OpenExtraBlock`):
- If trainer block +0x2C (`isIntroSave`) equals 1 (`TrainerDataSave_IsIntroSave(...) == TRUE`; the game only ever writes 0 or 1), the save is treated as **no save**.
- Extra saves are loaded only if their marker (trainer block +0x30 + 2·id) is 0xC21E **and** the extra save's own footer count equals the trainer block's counter for it (BW +0x44 + 4·id, B2W2 +0x5C + 4·id; `SaveData_LoadWithCount`). A mismatch flags only that extra as missing; the main save still loads. Never change these counters.

### 5.6 What our writer must do (complete checklist)

Reading:
1. Build the **effective image** with the algorithm in §5.5, per block. Never assume main is current. PKHeX reads only main ([PKHeX] `SAV5`: `Box = 0x400; Party = 0x18E00`, all accessors use the main copy), which is wrong in the rare case where the backup is newer or a main block is corrupt.

Writing (deposit, withdraw, trade):
1. Modify block data in the effective image: box trays, box main, party, Pokédex, and optionally records.
2. For each modified block *i*: compute `crc = CRC16(data)`. Write it to the block footer (`off+size+2`) **and** to table entry *i*. Increment the block counter u16 at `off+size` (wrapping at 0xFFFF) to mirror the game; this is optional for acceptance.
3. Increment the global save counter (footer +0x0) by 1. Optional, but it keeps the "newest copy wins" logic simple.
4. Recompute the footer CRC (CRC16 of the full CRC table, padding included) and store it at footer +0xE. Leave size, magic and +0xC unchanged.
5. Write the identical image `[0, copySize)` to **both** main (0x0) and backup (0x24000 BW / 0x26000 B2W2). Both copies are then valid, equal and of equal count, which is the same state a complete in-game save produces.
   - Why both: if only main were edited (PKHeX's approach) and the backup's footer count were ever **higher** than main's, the game would prefer backup's CRC table. Main's edited blocks would then fail that table, the backup's blocks would be used, and **our edit would be silently lost** (or, if the backup block is also stale against that table, the load fails as BROKEN). A backup-newer save arises naturally when the first in-game save of a session is interrupted between its two passes (§5.5 "Saving"). Mirroring removes this risk.
   - Do not "fix" this by only bumping main's count: a save in the backup-newer state also has main blocks that only the backup's table describes. Build the effective image first (step 1 of Reading), then mirror it.
6. Leave every byte outside the two copies untouched (§4.3).
7. Re-attach any container header or footer (§2). Output exactly the original container size: 0x80000 for raw.

Never write trainer +0x2C (`isIntroSave`). Note that PKHeX's `PlayerData5.LastSaved` **setter writes 0x2C** while its getter reads 0x28 ([PKHeX] `PlayerData5.cs`). The decomp shows 0x28 is `lastSaved` and 0x2C is `isIntroSave`, so writing through that setter would make the game treat the save as empty. Do not copy that behavior.

---

## 6. Block tables

The offsets below are PKHeX's ([PKHeX] `SaveBlockAccessor5BW/5B2W2`). We checked them programmatically:
- every block offset follows the §5.1 alignment rule from the previous block's size;
- every block CRC is at `off+size+2`;
- every table entry is at `tableOfs + 2·i`;
- each BW `size+4` equals the corresponding entry of B2W2's built-in BW size table in [pokebw2] `wb_save_block.c` (all 69 match; its last two entries are 0x8C, the CRC table, and 0x10, the footer).

Zero mismatches. B2W2 block identities come from [pokebw2] `include/save/save_control.h` (`SAVE_BLOCK_*`) and `save_table.c`.

### 6.1 BW (backup copy: add 0x24000 to every address)

| # | Offset | Data size | Block counter (u16) | Block CRC (u16) | CRC-table entry | PKHeX description |
|---|---|---|---|---|---|---|
| 0 | 0x00000 | 0x03E0 | 0x003E0 | 0x003E2 | 0x23F00 | Box Names |
| 1 | 0x00400 | 0x0FF0 | 0x013F0 | 0x013F2 | 0x23F02 | Box 1 |
| 2 | 0x01400 | 0x0FF0 | 0x023F0 | 0x023F2 | 0x23F04 | Box 2 |
| 3 | 0x02400 | 0x0FF0 | 0x033F0 | 0x033F2 | 0x23F06 | Box 3 |
| 4 | 0x03400 | 0x0FF0 | 0x043F0 | 0x043F2 | 0x23F08 | Box 4 |
| 5 | 0x04400 | 0x0FF0 | 0x053F0 | 0x053F2 | 0x23F0A | Box 5 |
| 6 | 0x05400 | 0x0FF0 | 0x063F0 | 0x063F2 | 0x23F0C | Box 6 |
| 7 | 0x06400 | 0x0FF0 | 0x073F0 | 0x073F2 | 0x23F0E | Box 7 |
| 8 | 0x07400 | 0x0FF0 | 0x083F0 | 0x083F2 | 0x23F10 | Box 8 |
| 9 | 0x08400 | 0x0FF0 | 0x093F0 | 0x093F2 | 0x23F12 | Box 9 |
| 10 | 0x09400 | 0x0FF0 | 0x0A3F0 | 0x0A3F2 | 0x23F14 | Box 10 |
| 11 | 0x0A400 | 0x0FF0 | 0x0B3F0 | 0x0B3F2 | 0x23F16 | Box 11 |
| 12 | 0x0B400 | 0x0FF0 | 0x0C3F0 | 0x0C3F2 | 0x23F18 | Box 12 |
| 13 | 0x0C400 | 0x0FF0 | 0x0D3F0 | 0x0D3F2 | 0x23F1A | Box 13 |
| 14 | 0x0D400 | 0x0FF0 | 0x0E3F0 | 0x0E3F2 | 0x23F1C | Box 14 |
| 15 | 0x0E400 | 0x0FF0 | 0x0F3F0 | 0x0F3F2 | 0x23F1E | Box 15 |
| 16 | 0x0F400 | 0x0FF0 | 0x103F0 | 0x103F2 | 0x23F20 | Box 16 |
| 17 | 0x10400 | 0x0FF0 | 0x113F0 | 0x113F2 | 0x23F22 | Box 17 |
| 18 | 0x11400 | 0x0FF0 | 0x123F0 | 0x123F2 | 0x23F24 | Box 18 |
| 19 | 0x12400 | 0x0FF0 | 0x133F0 | 0x133F2 | 0x23F26 | Box 19 |
| 20 | 0x13400 | 0x0FF0 | 0x143F0 | 0x143F2 | 0x23F28 | Box 20 |
| 21 | 0x14400 | 0x0FF0 | 0x153F0 | 0x153F2 | 0x23F2A | Box 21 |
| 22 | 0x15400 | 0x0FF0 | 0x163F0 | 0x163F2 | 0x23F2C | Box 22 |
| 23 | 0x16400 | 0x0FF0 | 0x173F0 | 0x173F2 | 0x23F2E | Box 23 |
| 24 | 0x17400 | 0x0FF0 | 0x183F0 | 0x183F2 | 0x23F30 | Box 24 |
| 25 | 0x18400 | 0x09C0 | 0x18DC0 | 0x18DC2 | 0x23F32 | Inventory |
| 26 | 0x18E00 | 0x0534 | 0x19334 | 0x19336 | 0x23F34 | Party Pokémon |
| 27 | 0x19400 | 0x0068 | 0x19468 | 0x1946A | 0x23F36 | Trainer Data |
| 28 | 0x19500 | 0x009C | 0x1959C | 0x1959E | 0x23F38 | Trainer Position |
| 29 | 0x19600 | 0x1338 | 0x1A938 | 0x1A93A | 0x23F3A | Unity Tower and survey stuff |
| 30 | 0x1AA00 | 0x07C4 | 0x1B1C4 | 0x1B1C6 | 0x23F3C | Pal Pad Player Data |
| 31 | 0x1B200 | 0x0D54 | 0x1BF54 | 0x1BF56 | 0x23F3E | Pal Pad Friend Data |
| 32 | 0x1C000 | 0x002C | 0x1C02C | 0x1C02E | 0x23F40 | Skin Info |
| 33 | 0x1C100 | 0x0658 | 0x1C758 | 0x1C75A | 0x23F42 | ??? Gym badge data |
| 34 | 0x1C800 | 0x0A94 | 0x1D294 | 0x1D296 | 0x23F44 | Mystery Gift |
| 35 | 0x1D300 | 0x01AC | 0x1D4AC | 0x1D4AE | 0x23F46 | Dream World Stuff (Catalog) |
| 36 | 0x1D500 | 0x03EC | 0x1D8EC | 0x1D8EE | 0x23F48 | Chatter |
| 37 | 0x1D900 | 0x005C | 0x1D95C | 0x1D95E | 0x23F4A | Adventure Info |
| 38 | 0x1DA00 | 0x01E0 | 0x1DBE0 | 0x1DBE2 | 0x23F4C | Trainer Card Records |
| 39 | 0x1DC00 | 0x00A8 | 0x1DCA8 | 0x1DCAA | 0x23F4E | ??? |
| 40 | 0x1DD00 | 0x0460 | 0x1E160 | 0x1E162 | 0x23F50 | Mail |
| 41 | 0x1E200 | 0x1400 | 0x1F600 | 0x1F602 | 0x23F52 | Overworld State |
| 42 | 0x1F700 | 0x02A4 | 0x1F9A4 | 0x1F9A6 | 0x23F54 | Musical |
| 43 | 0x1FA00 | 0x02DC | 0x1FCDC | 0x1FCDE | 0x23F56 | White Forest + Black City Data |
| 44 | 0x1FD00 | 0x034C | 0x2004C | 0x2004E | 0x23F58 | IR |
| 45 | 0x20100 | 0x03EC | 0x204EC | 0x204EE | 0x23F5A | EventWork |
| 46 | 0x20500 | 0x00F8 | 0x205F8 | 0x205FA | 0x23F5C | GTS |
| 47 | 0x20600 | 0x02FC | 0x208FC | 0x208FE | 0x23F5E | Regulation Tournament |
| 48 | 0x20900 | 0x0094 | 0x20994 | 0x20996 | 0x23F60 | Gimmick |
| 49 | 0x20A00 | 0x035C | 0x20D5C | 0x20D5E | 0x23F62 | Battle Box |
| 50 | 0x20E00 | 0x01CC | 0x20FCC | 0x20FCE | 0x23F64 | Daycare |
| 51 | 0x21000 | 0x0168 | 0x21168 | 0x2116A | 0x23F66 | Strength Boulder Status |
| 52 | 0x21200 | 0x00EC | 0x212EC | 0x212EE | 0x23F68 | Badge Flags, Money, Trainer Sayings |
| 53 | 0x21300 | 0x01B0 | 0x214B0 | 0x214B2 | 0x23F6A | Entralink (Level & Powers etc) |
| 54 | 0x21500 | 0x001C | 0x2151C | 0x2151E | 0x23F6C | ??? |
| 55 | 0x21600 | 0x04D4 | 0x21AD4 | 0x21AD6 | 0x23F6E | Pokedex |
| 56 | 0x21B00 | 0x0034 | 0x21B34 | 0x21B36 | 0x23F70 | Encount Swarm and other overworld info - 2C - swarm, 2D - repel steps, 2E repel type |
| 57 | 0x21C00 | 0x003C | 0x21C3C | 0x21C3E | 0x23F72 | Battle Subway Play Info |
| 58 | 0x21D00 | 0x01AC | 0x21EAC | 0x21EAE | 0x23F74 | Battle Subway Score Info |
| 59 | 0x21F00 | 0x0B90 | 0x22A90 | 0x22A92 | 0x23F76 | Battle Subway Wi-Fi Info |
| 60 | 0x22B00 | 0x009C | 0x22B9C | 0x22B9E | 0x23F78 | Online Records |
| 61 | 0x22C00 | 0x0850 | 0x23450 | 0x23452 | 0x23F7A | Entralink Forest pokémon data |
| 62 | 0x23500 | 0x0028 | 0x23528 | 0x2352A | 0x23F7C | ??? |
| 63 | 0x23600 | 0x0284 | 0x23884 | 0x23886 | 0x23F7E | Answered Questions |
| 64 | 0x23900 | 0x0010 | 0x23910 | 0x23912 | 0x23F80 | Unity Tower |
| 65 | 0x23A00 | 0x005C | 0x23A5C | 0x23A5E | 0x23F82 | Battle Institute |
| 66 | 0x23B00 | 0x016C | 0x23C6C | 0x23C6E | 0x23F84 | ??? |
| 67 | 0x23D00 | 0x0040 | 0x23D40 | 0x23D42 | 0x23F86 | ??? |
| 68 | 0x23E00 | 0x00FC | 0x23EFC | 0x23EFE | 0x23F88 | ??? |

CRC table 0x23F00–0x23F8B (pad u16 at 0x23F8A). Footer 0x23F8C–0x23F9B.

Correspondence with B2W2 (from PKHeX's names plus size matches; sizes compared programmatically):
- BW blocks **0–53 have the same index and identity** as in B2W2. Sizes are equal except 25 (bag, 0x9C0 vs 0x9EC), 27 (trainer, 0x68 vs 0xB0), 28 (position, 0x9C vs 0xA8), 32 (C-Gear/skin, 0x2C vs 0x94), 43 (White Forest/Black City, 0x2DC vs 0xE0, which in B2W2 also holds the fused dragon), 45 (event work, 0x3EC vs 0x4E0), 50 (Day Care, 0x1CC vs 0x1D4: no seed in BW), 51 (Strength boulders, 0x168 vs 0x1E0), 52 (Misc, 0xEC vs 0xF0), 53 (Entralink, 0x1B0 vs 0x1B4).
- BW 54 (0x1C, unnamed) has no B2W2 counterpart, so from there on BW is one index ahead: BW 55–61 = B2W2 54–60 (Pokédex, Encount, Subway play, Subway score, Subway Wi-Fi, online records, Entree Forest; equal sizes except the dex, 0x4D4 vs 0x4DC, and online records, 0x9C vs 0xAC).
- BW 62 (0x28) has no counterpart; BW 63 = B2W2 61 (survey, 0x284), BW 64 = B2W2 62 (Unity Tower floor, 0x10), BW 65 ≈ B2W2 63 (Battle Institute / trial house; **sizes differ**, 0x5C vs 0xA8, identity from PKHeX's name only), BW 66 = B2W2 64 (0x16C; the Memory Link copies 6 × 0x3C bytes from BW 66 +0, consistent with a six-Pokémon team record). BW 67 (0x40) and BW 68 (0xFC) are unidentified (**UNVERIFIED**).
- B2W2's Memory Link reads BW blocks 27 (player info at +4), 42 (musical: +0x252 show count, +0x256 total points, +0x258 props), 45 (event work: flags at +0x27C, vars 0x4000+ as u16 index from the block start), 52 (u32 at +4, bits 0–7) and 66 ([pokebw2] `wb_save_convert.c`).

### 6.2 B2W2 (backup copy: add 0x26000 to every address)

| # | Offset | Data size | Block counter (u16) | Block CRC (u16) | CRC-table entry | Decomp block ID | PKHeX description |
|---|---|---|---|---|---|---|---|
| 0 | 0x00000 | 0x03E0 | 0x003E0 | 0x003E2 | 0x25F00 | BOX_MAIN | Box Names |
| 1 | 0x00400 | 0x0FF0 | 0x013F0 | 0x013F2 | 0x25F02 | BOX_TRAY (box 1) | Box 1 |
| 2 | 0x01400 | 0x0FF0 | 0x023F0 | 0x023F2 | 0x25F04 | BOX_TRAY (box 2) | Box 2 |
| 3 | 0x02400 | 0x0FF0 | 0x033F0 | 0x033F2 | 0x25F06 | BOX_TRAY (box 3) | Box 3 |
| 4 | 0x03400 | 0x0FF0 | 0x043F0 | 0x043F2 | 0x25F08 | BOX_TRAY (box 4) | Box 4 |
| 5 | 0x04400 | 0x0FF0 | 0x053F0 | 0x053F2 | 0x25F0A | BOX_TRAY (box 5) | Box 5 |
| 6 | 0x05400 | 0x0FF0 | 0x063F0 | 0x063F2 | 0x25F0C | BOX_TRAY (box 6) | Box 6 |
| 7 | 0x06400 | 0x0FF0 | 0x073F0 | 0x073F2 | 0x25F0E | BOX_TRAY (box 7) | Box 7 |
| 8 | 0x07400 | 0x0FF0 | 0x083F0 | 0x083F2 | 0x25F10 | BOX_TRAY (box 8) | Box 8 |
| 9 | 0x08400 | 0x0FF0 | 0x093F0 | 0x093F2 | 0x25F12 | BOX_TRAY (box 9) | Box 9 |
| 10 | 0x09400 | 0x0FF0 | 0x0A3F0 | 0x0A3F2 | 0x25F14 | BOX_TRAY (box 10) | Box 10 |
| 11 | 0x0A400 | 0x0FF0 | 0x0B3F0 | 0x0B3F2 | 0x25F16 | BOX_TRAY (box 11) | Box 11 |
| 12 | 0x0B400 | 0x0FF0 | 0x0C3F0 | 0x0C3F2 | 0x25F18 | BOX_TRAY (box 12) | Box 12 |
| 13 | 0x0C400 | 0x0FF0 | 0x0D3F0 | 0x0D3F2 | 0x25F1A | BOX_TRAY (box 13) | Box 13 |
| 14 | 0x0D400 | 0x0FF0 | 0x0E3F0 | 0x0E3F2 | 0x25F1C | BOX_TRAY (box 14) | Box 14 |
| 15 | 0x0E400 | 0x0FF0 | 0x0F3F0 | 0x0F3F2 | 0x25F1E | BOX_TRAY (box 15) | Box 15 |
| 16 | 0x0F400 | 0x0FF0 | 0x103F0 | 0x103F2 | 0x25F20 | BOX_TRAY (box 16) | Box 16 |
| 17 | 0x10400 | 0x0FF0 | 0x113F0 | 0x113F2 | 0x25F22 | BOX_TRAY (box 17) | Box 17 |
| 18 | 0x11400 | 0x0FF0 | 0x123F0 | 0x123F2 | 0x25F24 | BOX_TRAY (box 18) | Box 18 |
| 19 | 0x12400 | 0x0FF0 | 0x133F0 | 0x133F2 | 0x25F26 | BOX_TRAY (box 19) | Box 19 |
| 20 | 0x13400 | 0x0FF0 | 0x143F0 | 0x143F2 | 0x25F28 | BOX_TRAY (box 20) | Box 20 |
| 21 | 0x14400 | 0x0FF0 | 0x153F0 | 0x153F2 | 0x25F2A | BOX_TRAY (box 21) | Box 21 |
| 22 | 0x15400 | 0x0FF0 | 0x163F0 | 0x163F2 | 0x25F2C | BOX_TRAY (box 22) | Box 22 |
| 23 | 0x16400 | 0x0FF0 | 0x173F0 | 0x173F2 | 0x25F2E | BOX_TRAY (box 23) | Box 23 |
| 24 | 0x17400 | 0x0FF0 | 0x183F0 | 0x183F2 | 0x25F30 | BOX_TRAY (box 24) | Box 24 |
| 25 | 0x18400 | 0x09EC | 0x18DEC | 0x18DEE | 0x25F32 | BAG | Inventory |
| 26 | 0x18E00 | 0x0534 | 0x19334 | 0x19336 | 0x25F34 | PARTY | Party Pokémon |
| 27 | 0x19400 | 0x00B0 | 0x194B0 | 0x194B2 | 0x25F36 | TRAINER_DATA | Trainer Data |
| 28 | 0x19500 | 0x00A8 | 0x195A8 | 0x195AA | 0x25F38 | PLAYER (position) | Trainer Position |
| 29 | 0x19600 | 0x1338 | 0x1A938 | 0x1A93A | 0x25F3A | UNITY_TOWER_SURVEY | Unity Tower and survey stuff |
| 30 | 0x1AA00 | 0x07C4 | 0x1B1C4 | 0x1B1C6 | 0x25F3C | WIFI_LIST | Pal Pad Player Data |
| 31 | 0x1B200 | 0x0D54 | 0x1BF54 | 0x1BF56 | 0x25F3E | PAL_PAD | Pal Pad Friend Data |
| 32 | 0x1C000 | 0x0094 | 0x1C094 | 0x1C096 | 0x25F40 | CGEAR | Options / Skin Info |
| 33 | 0x1C100 | 0x0658 | 0x1C758 | 0x1C75A | 0x25F42 | TIMESIG | Trainer Card |
| 34 | 0x1C800 | 0x0A94 | 0x1D294 | 0x1D296 | 0x25F44 | MYSTERY_GIFT | Mystery Gift |
| 35 | 0x1D300 | 0x01AC | 0x1D4AC | 0x1D4AE | 0x25F46 | DREAM_WORLD | Dream World Stuff (Catalog) |
| 36 | 0x1D500 | 0x03EC | 0x1D8EC | 0x1D8EE | 0x25F48 | CHATTER | Chatter |
| 37 | 0x1D900 | 0x005C | 0x1D95C | 0x1D95E | 0x25F4A | ADVENTURE | Adventure data |
| 38 | 0x1DA00 | 0x01E0 | 0x1DBE0 | 0x1DBE2 | 0x25F4C | RECORDS | Trainer Card Records |
| 39 | 0x1DC00 | 0x00A8 | 0x1DCA8 | 0x1DCAA | 0x25F4E | PMS (easy-chat words) | ??? |
| 40 | 0x1DD00 | 0x0460 | 0x1E160 | 0x1E162 | 0x25F50 | MAIL | Mail |
| 41 | 0x1E200 | 0x1400 | 0x1F600 | 0x1F602 | 0x25F52 | FIELD_ACTORS | Overworld State |
| 42 | 0x1F700 | 0x02A4 | 0x1F9A4 | 0x1F9A6 | 0x25F54 | MUSICAL | Musical |
| 43 | 0x1FA00 | 0x00E0 | 0x1FAE0 | 0x1FAE2 | 0x25F56 | RESH_ZEK | White Forest + Black City Data, Fused Reshiram/Zekrom Storage |
| 44 | 0x1FB00 | 0x034C | 0x1FE4C | 0x1FE4E | 0x25F58 | TRAINER_LOG | IR |
| 45 | 0x1FF00 | 0x04E0 | 0x203E0 | 0x203E2 | 0x25F5A | EVENT_WORK | EventWork |
| 46 | 0x20400 | 0x00F8 | 0x204F8 | 0x204FA | 0x25F5C | WORLDTRADE (GTS) | GTS |
| 47 | 0x20500 | 0x02FC | 0x207FC | 0x207FE | 0x25F5E | TOURNAMENT | Regulation Tournament |
| 48 | 0x20800 | 0x0094 | 0x20894 | 0x20896 | 0x25F60 | GIMMICK | Gimmick |
| 49 | 0x20900 | 0x035C | 0x20C5C | 0x20C5E | 0x25F62 | BATTLE_BOX | Battle Box |
| 50 | 0x20D00 | 0x01D4 | 0x20ED4 | 0x20ED6 | 0x25F64 | DAY_CARE | Daycare |
| 51 | 0x20F00 | 0x01E0 | 0x210E0 | 0x210E2 | 0x25F66 | STRENGTH_ROCKS | Strength Boulder Status |
| 52 | 0x21100 | 0x00F0 | 0x211F0 | 0x211F2 | 0x25F68 | TRAINER_GAME_INFO (money, badges) | Misc (Badge Flags, Money, Trainer Sayings) |
| 53 | 0x21200 | 0x01B4 | 0x213B4 | 0x213B6 | 0x25F6A | HIGH_LINK (Entralink) | Entralink (Level & Powers etc) |
| 54 | 0x21400 | 0x04DC | 0x218DC | 0x218DE | 0x25F6C | POKEDEX | Pokedex |
| 55 | 0x21900 | 0x0034 | 0x21934 | 0x21936 | 0x25F6E | ENCOUNT | Encount (Swarm and other overworld info - 2C - swarm, 2D - repel steps, 2E repel type) |
| 56 | 0x21A00 | 0x003C | 0x21A3C | 0x21A3E | 0x25F70 | BSUBWAY_PLAY | Battle Subway Play Info |
| 57 | 0x21B00 | 0x01AC | 0x21CAC | 0x21CAE | 0x25F72 | BSUBWAY_SCORE | Battle Subway Score Info |
| 58 | 0x21D00 | 0x0B90 | 0x22890 | 0x22892 | 0x25F74 | BSUBWAY_WIFI | Battle Subway Wi-Fi Info |
| 59 | 0x22900 | 0x00AC | 0x229AC | 0x229AE | 0x25F76 | RECORD | Online Records |
| 60 | 0x22A00 | 0x0850 | 0x23250 | 0x23252 | 0x25F78 | SYMBOL (Entree Forest) | Entralink Forest pokémon data |
| 61 | 0x23300 | 0x0284 | 0x23584 | 0x23586 | 0x25F7A | SURVEY | Answered Questions |
| 62 | 0x23600 | 0x0010 | 0x23610 | 0x23612 | 0x25F7C | UNITY_TOWER_FLOOR | Unity Tower |
| 63 | 0x23700 | 0x00A8 | 0x237A8 | 0x237AA | 0x25F7E | TRIAL_HOUSE | Battle Institute & PWT related data |
| 64 | 0x23800 | 0x016C | 0x2396C | 0x2396E | 0x25F80 | SAVE_BLOCK_40 (Hall of Fame team) | ??? |
| 65 | 0x23A00 | 0x0080 | 0x23A80 | 0x23A82 | 0x25F82 | TRADED_POKEMON | ??? |
| 66 | 0x23B00 | 0x00FC | 0x23BFC | 0x23BFE | 0x25F84 | SAVE_BLOCK_MISC (hollow/rival) | Hollow/Rival Block |
| 67 | 0x23C00 | 0x16A8 | 0x252A8 | 0x252AA | 0x25F86 | JOIN_AVENUE | Join Avenue Block |
| 68 | 0x25300 | 0x0498 | 0x25798 | 0x2579A | 0x25F88 | MEDAL_BOX | Medal |
| 69 | 0x25800 | 0x0060 | 0x25860 | 0x25862 | 0x25F8A | KEY_DATA | Key-related data |
| 70 | 0x25900 | 0x00FC | 0x259FC | 0x259FE | 0x25F8C | FUNFEST | Festa Missions |
| 71 | 0x25A00 | 0x03E4 | 0x25DE4 | 0x25DE6 | 0x25F8E | POKEWOOD (PokeStar Studios) | Pokestar Studios |
| 72 | 0x25E00 | 0x00F0 | 0x25EF0 | 0x25EF2 | 0x25F90 | DREAM_RADAR | ??? |

CRC table 0x25F00–0x25F93 (pad u16 at 0x25F92). Footer 0x25F94–0x25FA3.

---

## 7. Blocks the widget touches

All offsets are relative to the block start. Add the block offset from §6, plus the copy base when writing both copies.

### 7.1 Box main block (block 0 @0x00000, size 0x3E0; both games)

[pokebw2] `BoxMainSave`; [PKHeX] `BoxLayout5`.

| Off | Size | Field |
|---|---|---|
| 0x000 | u32 | Current (last opened) box, 0–23. PKHeX reads only the low byte |
| 0x004 | 24 × 0x28 | Box names: 20 UTF-16 code units per box, 0xFFFF-terminated. In-game limit 8 characters (**UNVERIFIED**; PKHeX allows more). Name *b* at 0x004 + 0x28·*b* |
| 0x3C4 | 24 × u8 | Wallpaper per box. Default is box index mod 16 |
| 0x3DC | u8 | Flags: extra wallpaper sets unlocked. Mask 0x01 = extra set 1, mask 0x02 = extra set 2 (bits 0 and 1; [pokebw2] `BoxSaveAccessor_CheckFlags(boxes, 1/2)` tests `flags & mask` directly, called with 1 and 2 in `box2_seq.c`) |
| 0x3DD | u8 | **Boxes unlocked** (`trayCount`): 8 at a new game, +8 when every open box is full, maximum 24 |
| 0x3DE | 2 | Padding |

The game asserts `box < trayCount` when inserting ([pokebw2] `BoxSaveAccessor_InsertPkmCore`). When we inject into box *b*, require `b < trayCount`, or raise `trayCount` to the next multiple of 8 above *b* (which is what the game does when boxes fill) and re-CRC block 0.

### 7.2 Box trays (blocks 1–24)

- Box *b* (0-based) at **0x00400 + 0x1000·b**: 30 consecutive 136-byte encrypted PK5s (30 × 0x88 = 0xFF0). Slot *s* at +0x88·*s*.
- Counter at +0xFF0, CRC at +0xFF2. Table entry at 0x23F02 + 2·*b* (BW) or 0x25F02 + 2·*b* (B2W2). 12 padding bytes up to +0x1000.
- Slots are **fixed positions**: there is no count and no packing. Removing = overwrite with the "empty slot" encoding (§8.7). No shifting.
- Each box tray is its own block. Changing one box re-CRCs only that block, and CRCs can be computed per box.
- The game restores full PP when it places a Pokémon in a box ([pokebw2] `PML_PkmPPRecover` in `BoxSaveAccessor_SetPkm/InsertPkmCore`). Mirror this on withdrawals. For each move slot with move ≠ 0: `PP = base + floor(base × 20 × ppUps / 100)`, with `ppUps` (0x34+i) clamped to 3 and `base` the move's Gen 5 base PP ([pokebw2] `waza_tool.c` `PML_MoveGetMaxPP`; base PP is in Showdown `moves.ts` `pp`, with `data/mods/gen5` overrides).

### 7.3 Party (block 26 @0x18E00, size 0x534; both games)

[pokebw2] `struct PokeParty`, `pokeparty.c`; [PKHeX] `SAV5.GetPartyOffset`.

| Off | Abs | Type | Field |
|---|---|---|---|
| 0x000 | 0x18E00 | s32 | Capacity (always 6) |
| 0x004 | 0x18E04 | s32 | **Count** (0–6). PKHeX reads only the low byte. Write a u32 |
| 0x008 + 0xDC·i | 0x18E08 + 220·i | 220 bytes | Party PK5 *i*: 136-byte box part + 84-byte party extension (§8.5) |
| 0x530 | 0x19330 | u8 | `slotExists` bitmask: bit *i* set by `PokeParty_AddPkm`, swapped on reorder, **not** cleared by `PokeParty_RemovePkm`. Purpose unknown |
| 0x531 | — | 3 | Padding |
| 0x534 / 0x536 | 0x19334 / 0x19336 | u16 / u16 | Block counter / CRC. Table entry 0x23F34 (BW) / 0x25F34 (B2W2) |

- The party is **packed**: slots 0..count−1 are used. The game's remove shifts later members down and clears the last slot with the empty-party encoding.
- Unused slots hold the empty encoding (both encrypted regions = keystream from seed 0, §8.7).
- Party Pokémon need valid level and stats in the extension. A box→party move recomputes them ([pokebw2] `boxPkmRegenToPartyPkm`).
- **Recommendation: deposit and withdraw only through PC boxes.** Read the party only for display and battle teams. This avoids stat computation, mail handling, `slotExists`, and the "must keep at least one battle-ready Pokémon" rule (the in-game PC enforces that rule with `Box2Main_BattlePokeCheck`).

### 7.4 Trainer data (block 27 @0x19400; BW 0x68 bytes, B2W2 0xB0 bytes)

[pokebw2] `TrainerDataSave`, `PlayerInfo`, `PlayTime`; [PKHeX] `PlayerData5`. Offsets 0x00–0x2F are shared by BW and B2W2: PKHeX uses one base class, and B2W2's Memory Link reads a BW save's `PlayerInfo` at BW block 27 +4 ([pokebw2] `wb_save_convert.c`), which independently confirms the BW layout of +0x04..+0x23. The B2W2 total checks out: 4 (config) + 0x20 (`PlayerInfo`) + 8 (`PlayTime`) + 4 (`isIntroSave` + pad) + 22×2 (markers) + 21×4 (counters) = 0xB0; BW: 0x30 + 9×2 (markers, padded to 0x44) + 9×4 = 0x68.

| Off | Abs | Type | Field |
|---|---|---|---|
| 0x00 | 0x19400 | 4 | Config (options) |
| 0x04 | 0x19404 | 16 | **OT name**: 8 UTF-16 units, 7 characters max (Western) + 0xFFFF |
| 0x14 | 0x19414 | u16 | **TID** |
| 0x16 | 0x19416 | u16 | **SID** (u32 at 0x14 = TID \| SID<<16) |
| 0x18 | 0x19418 | s32 | GameSpy/Game Sync profile ID |
| 0x1C | 0x1941C | u8 | Country |
| 0x1D | 0x1941D | u8 | Province/subregion |
| 0x1E | 0x1941E | u8 | **Game language** (PKHeX; decomp calls it `region`) |
| 0x1F | 0x1941F | u8 | **Version** 20 W / 21 B / 22 W2 / 23 B2 |
| 0x20 | 0x19420 | u8 | Union Room / Wi-Fi appearance (0–7 male, 8–15 female) |
| 0x21 | 0x19421 | u8 | **Gender**: 0 male, 1 female |
| 0x22 | — | 2 | Unknown |
| 0x24 | 0x19424 | u16 | Play time hours (caps at 999) |
| 0x26 | 0x19426 | u8 | Minutes |
| 0x27 | 0x19427 | u8 | Seconds |
| 0x28 | 0x19428 | u32 | Last-saved date and time bitfield: year−2000 (7 bits), month (4), day (5), hour (5), minute (6), from the low bit up |
| 0x2C | 0x1942C | u8 | **isIntroSave**. Must be 0 for a loadable save |
| 0x30 | 0x19430 | u16[] | Extra-save markers (0xC21E = present). 9 in BW, 22 in B2W2 |
| 0x44 / 0x5C | — | u32[] | Extra-save counters (BW at 0x44, 9 entries; B2W2 at 0x5C, 21 entries) |

**Money** is not in this block. It is the u32 at the start of the Misc block (block 52): BW **0x21200**, B2W2 **0x21100**. The badge byte follows at +4 ([PKHeX] `Misc5`).

### 7.5 Pokédex (BW block 55 @0x21600 size 0x4D4; B2W2 block 54 @0x21400 size 0x4DC)

[pokebw2] `struct PokeDexSave`, `pokedex.c`; [PKHeX] `Zukan5`. Bit lists are indexed by species−1, LSB-first within each byte.

| Off | Size | BW abs | B2W2 abs | Field |
|---|---|---|---|---|
| 0x000 | u32 | 0x21600 | 0x21400 | Magic 0xBEEFCAFE |
| 0x004 | u32 | 0x21604 | 0x21404 | Packed flags (§18 for the conflicting interpretations). Do not modify |
| 0x008 | 0x54 | 0x21608 | 0x21408 | **Caught** bits (672 bits ≥ 649 species) |
| 0x05C | 4 × 0x54 | 0x2165C | 0x2145C | **Seen** lists: [0] male/genderless, [1] female, [2] shiny male/genderless, [3] shiny female |
| 0x1AC | 4 × 0x54 | 0x217AC | 0x215AC | **Shown** lists (which sex/shiny variant the dex displays): exactly one bit set across the four lists per species |
| 0x2FC | 2 × F | 0x218FC | 0x216FC | **Seen forms**: normal list, then shiny list (F = 9 bytes BW, 11 bytes B2W2) |
| 0x2FC + 2F | 2 × F | 0x2190E | 0x21712 | **Shown forms**: normal, then shiny |
| 0x2FC + 4F | 0x1B0 | 0x21920 | 0x21728 | **Language** bits: 7 per species, species 1–493 only. Bit index = (species−1)·7 + L, where L = 0 JPN, 1 ENG, 2 FRE, 3 ITA, 4 GER, 5 SPA, 6 KOR |
| end − 4 | u32 | 0x21AD0 | 0x218D8 | Spinda personality: the PID of the first Spinda registered |

Form bit index = base(species) + form. Base indices are the running sum over this ordered list ([pokebw2] `pokemonFormList`; identical order in [PKHeX] `Zukan5BW/B2W2.GetFormIndex`):

| Species | Forms | Base bit |
|---|---|---|
| Unown 201 | 28 | 0 |
| Deoxys 386 | 4 | 28 |
| Shaymin 492 | 2 | 32 |
| Giratina 487 | 2 | 34 |
| Rotom 479 | 6 | 36 |
| Shellos 422 | 2 | 42 |
| Gastrodon 423 | 2 | 44 |
| Burmy 412 | 3 | 46 |
| Wormadam 413 | 3 | 49 |
| Castform 351 | 4 | 52 |
| Cherrim 421 | 2 | 56 |
| Deerling 585 | 4 | 58 |
| Sawsbuck 586 | 4 | 62 |
| Meloetta 648 | 2 | 66 |
| Darmanitan 555 | 2 | 68 |
| Basculin 550 | 2 | 70 |
| *(BW ends: 72 bits = 9 bytes)* | | |
| Kyurem 646 | 3 | 72 |
| Keldeo 647 | 2 | 75 |
| Thundurus 642 | 2 | 77 |
| Tornadus 641 | 2 | 79 |
| Landorus 645 | 2 | 81 |
| *(B2W2 ends: 83 bits, 11 bytes)* | | |

**Registering a received Pokémon (caught)**, paraphrasing [pokebw2] `addPkmToDex`, which the trade code calls:
1. Skip eggs, and species 0 or > 649.
2. Let `sex` = the gender **derived from the PID and the species/form gender ratio** (`PokeParty_GetSex` → `PML_UtilDerivePkmSex`, §8.6), not the stored bits; it equals the stored gender for any consistent PK5 (0 male, 1 female, 2 genderless; genderless is treated as male). `shiny` = §8.6.
3. If the species is not set in any of the four Seen lists (first sighting):
   - In all four Shown lists, clear the species bit, then set it in list `[sex==1 ? 1 : 0] + (shiny ? 2 : 0)`.
   - If the species has forms, clear all of its form bits in both Shown-forms lists, then set bit base + form (form ≥ count → 0) in the shiny or normal Shown-forms list.
4. Spinda: if the stored Spinda personality is 0, set it to this PID. PKHeX instead uses "if Spinda not yet seen"; the decomp is authoritative.
5. Set the Seen bit in list `[sex==1 ? 1 : 0] + (shiny ? 2 : 0)`.
6. Seen forms: set bit base + form in the normal or shiny list (form ≥ count → 0). Castform, Cherrim, Darmanitan and Meloetta set **all** their form bits instead.
7. Language bit: if species ≤ 493 and the PK5 language ∈ {1,2,3,4,5,7,8}, set bit (species−1)·7 + (lang ≥ 7 ? lang−2 : lang−1).
8. Set the Caught bit.
9. Re-CRC the dex block.

Note: PKHeX's `Zukan5.SetDex` sets the seen-form bit at the species' **base** index rather than base + form. That looks like a PKHeX bug; follow the decomp.

For a **BW** save use BW's form list (the first 16 entries above, F = 9 bytes): species after Basculin in the list (Kyurem, Keldeo, the genies) have no form bits in BW, so only their species bits are set. The procedure above is read from the B2W2 code; that BW registers identically is an inference from the identical struct layout and PKHeX's shared `Zukan5` code (**UNVERIFIED**: no BW decompilation covers it). PKHeX's language-bit index also skips Korean (its `GetLanguageIndex` rejects index 6); the decomp sets bit 6 for Korean, so follow the decomp.

### 7.6 Other places Pokémon live (read-only for the widget)

| Where | BW | B2W2 | Format | Notes |
|---|---|---|---|---|
| Battle Box (block 49) | 0x20A00 | 0x20900 | 6 × 136-byte PK5 at +0, name (0x28 bytes) at +0x330, flags u16 at +0x358 (bit0 locked for a Wi-Fi tournament, bit1 locked for a live tournament) | [pokebw2] `BattleBoxSave`; [PKHeX] `BattleBox5`. Locked boxes must not be touched |
| Day Care (block 50) | 0x20E00 | 0x20D00 | 2 × 0xE4-byte slots {u32 occupied, 220-byte party PK5 at slot+4, u32 steps/exp gained}; slot 1 at +0xE4; egg flag u32 at +0x1C8; B2W2 also has a u64 RNG seed at +0x1CC (the DS aligns u64 to 4, hence 0x1CC and the 0x1D4 block size) | [PKHeX] `Daycare5`; [pokebw2] `struct DayCareSave` (`include/save/box.h`); [Frigate] `game-changes.md` (`PORT_DS_ALIGN_64`: "the DS aligns them to 4") |
| Dream World (block 35) | 0x1D300 | 0x1D300 | One 220-byte PK5 at +0x08: the Pokémon "tucked in" to the Pokémon Global Link (it is **not** in the PC while there) | [pokebw2] `DreamWorldSave` |
| GTS (block 46) | 0x20500 | 0x20400 | Deposited GTS Pokémon state | [PKHeX] `GTS5`. Layout **UNVERIFIED** |
| Mail (block 40) | 0x1DD00 | 0x1DD00 | 20 × 0x38-byte mail | [PKHeX] `SAV5.GetMailOffset` |
| Fused Reshiram/Zekrom (block 43, B2W2) | — | 0x1FA00 | The dragon absorbed by a fused Kyurem: one 220-byte party PK5 at +0x04 (abs 0x1FA04), after a 4-byte `CityState` (White Forest / Black City state); block size 0xE0 = 4 + 0xDC | [PP-B2W2]; [pokebw2] `struct ReshZekSave` (`include/save/resh_zek.h`) |

---

## 8. PK5: the Pokémon structure

Box format 136 (0x88) bytes. Party format 220 (0xDC) bytes = box format + 84-byte extension. All multi-byte values are little-endian. The layout is identical to PK4 for encryption and almost identical for fields.
Sources: [pokebw2] `poke_party.h` (`BoxPkm`, `PartyPkm`, `PkmBlockA–D`) and `poke_tool.c`; [PKHeX] `PK5.cs`, `PokeCrypto.cs`; [PP-PK5]; [Bulba-PK4].

### 8.1 Header (never encrypted)

| Off | Type | Field |
|---|---|---|
| 0x00 | u32 | PID (personality value) |
| 0x04 | u16 | Runtime flags: bit0 "party data decrypted", bit1 "box data decrypted", bit2 **bad egg**, bits 3–15 unused. **Must be 0 in a stored PK5.** The game sets bit2 when the checksum fails, and it shows the Pokémon as a Bad Egg ([pokebw2] `PML_PkmDecryptCheck`) |
| 0x06 | u16 | Checksum = (sum of the 64 little-endian u16 words of the **decrypted, unshuffled** bytes 0x08–0x87) mod 0x10000 ([pokebw2] `PML_CryptoGenKey`) |

### 8.2 Encryption and shuffling

1. **Shuffle**: the 128 bytes at 0x08–0x87 are four 32-byte blocks A, B, C, D (logical order: A = 0x08, B = 0x28, C = 0x48, D = 0x68). Their **stored** order is permutation number `k = ((PID >> 13) & 0x1F) mod 24` among the 24 permutations of "ABCD" in **lexicographic order**:
   0 ABCD, 1 ABDC, 2 ACBD, 3 ACDB, 4 ADBC, 5 ADCB, 6 BACD, 7 BADC, 8 BCAD, 9 BCDA, 10 BDAC, 11 BDCA, 12 CABD, 13 CADB, 14 CBAD, 15 CBDA, 16 CDAB, 17 CDBA, 18 DABC, 19 DACB, 20 DBAC, 21 DBCA, 22 DCAB, 23 DCBA.
   The string names which block sits in stored positions 0..3. The decomp's 32-row offset table (rows 24–31 repeat rows 0–7) matches this rule; we checked all 24 rows programmatically against [pokebw2] `blockShufLUT`. Bulbapedia gives the same order ([Bulba-PK4]). The game never physically reorders the blocks; it reads each block at its shuffled offset (`PML_PkmGetParamBlockCore`). The writer must therefore place the blocks in this stored order.
2. **Encrypt** the 128 stored bytes by XOR with a keystream: `seed = checksum`, then for each u16 word: `seed = (seed * 0x41C64E6D + 0x6073) mod 2^32; word ^= seed >> 16`. The operation is its own inverse.
3. The **party extension** (0x88–0xDB, 42 words) is XORed with a **fresh** keystream seeded with the **PID** (same LCG).

Encoding order: fill the decrypted canonical struct → set header flags to 0 → compute the checksum → shuffle → XOR (box part with the checksum seed) → XOR the party part with the PID seed.
Decoding order: XOR the box part with the checksum seed → unshuffle → verify the checksum (a mismatch means the game shows a Bad Egg) → XOR the party part with the PID seed.

### 8.3 Block A (logical 0x08–0x27)

| Off | Type | Field |
|---|---|---|
| 0x08 | u16 | Species: **National Dex number** (0 = empty slot) |
| 0x0A | u16 | Held item (Gen 4+ item index) |
| 0x0C | u16 | OT TID |
| 0x0E | u16 | OT SID |
| 0x10 | u32 | Experience points. **Box level is derived from EXP** via the growth-rate table (`CalcLevelByExp`); there is no level field in box data |
| 0x14 | u8 | Friendship; **for eggs: remaining egg cycles** |
| 0x15 | u8 | Ability **ID** (not a slot). The game reads this byte directly |
| 0x16 | u8 | Markings: 0x01 ●, 0x02 ▲, 0x04 ■, 0x08 ♥, 0x10 ★, 0x20 ◆ |
| 0x17 | u8 | Language of origin: 1 JPN, 2 ENG, 3 FRE, 4 ITA, 5 GER, 7 SPA, 8 KOR. Japanese BW in-game trades store 0 ([PKHeX] `LanguageID` remark) |
| 0x18–0x1D | u8 × 6 | EVs: HP, Atk, Def, **Spe**, SpA, SpD (maximum 255 each, 510 total) |
| 0x1E–0x23 | u8 × 6 | Contest: Cool, Beauty, Cute, Smart, Tough, Sheen (Gen 3/4 leftovers) |
| 0x24–0x27 | u32 | Ribbon set "Sinnoh 1 + Unova" (§8.8) |

### 8.4 Block B (0x28–0x47), Block C (0x48–0x67), Block D (0x68–0x87)

| Off | Type | Field |
|---|---|---|
| 0x28–0x2F | u16 × 4 | Moves 1–4 (1–559) |
| 0x30–0x33 | u8 × 4 | Current PP |
| 0x34–0x37 | u8 × 4 | PP Ups (0–3) per move |
| 0x38 | u32 | IVs: HP bits 0–4, Atk 5–9, Def 10–14, **Spe 15–19**, SpA 20–24, SpD 25–29. Bit 30 **is egg**. Bit 31 **is nicknamed** |
| 0x3C–0x3F | u32 | Hoenn ribbons (§8.8) |
| 0x40 | u8 | bit0 fateful encounter. Bits 1–2 gender (stored value 0 male, 1 female, 2 genderless; bit1 = female, bit2 = genderless). Bits 3–7 **form** |
| 0x41 | u8 | **Nature** (0–24). Authoritative in Gen 5; it is not recomputed from the PID |
| 0x42 | u16 | bit0 **hidden ability** ("Dream World ability") flag. bit1 **N's Pokémon** flag (shows N's sparkle). Bits 2–15 unused (0x43 unused) |
| 0x44–0x47 | u32 | Unused (Platinum/HGSS met data in PK4; Poké Transfer clears it) |
| 0x48–0x5D | u16 × 11 | **Nickname** (§9) |
| 0x5E | u8 | Unused |
| 0x5F | u8 | Origin game: 1 S, 2 R, 3 E, 4 FR, 5 LG, 7 HG, 8 SS, 10 D, 11 P, 12 Pt, 15 Colosseum/XD, 20 W, 21 B, 22 W2, 23 B2 |
| 0x60–0x67 | u64 | Ribbons "Sinnoh 3/4" (contest ribbons; bits beyond 0x62 bit 3 unused) |
| 0x68–0x77 | u16 × 8 | **OT name** (§9) |
| 0x78–0x7A | u8 × 3 | Egg received date: year−2000, month, day (0 if not from an egg) |
| 0x7B–0x7D | u8 × 3 | Met / hatch date |
| 0x7E | u16 | Egg location (e.g. 60002 Day Care) |
| 0x80 | u16 | Met location (e.g. 30001 Poké Transfer, 30003 link trade) |
| 0x82 | u8 | Pokérus: high nibble strain, low nibble days remaining |
| 0x83 | u8 | Ball (1 Master … 16 Cherish, 17–24 Fast/Level/Lure/Heavy/Love/Friend/Moon/Sport, **25 Dream**). Gen 5 keeps HGSS Apricorn balls here directly; PK4 kept them at 0x86 |
| 0x84 | u8 | bits 0–6 met level. Bit 7 OT gender (1 = female) |
| 0x85 | u8 | Gen 4 encounter type. Unused by BW/B2W2, kept for transfers |
| 0x86 | u8 | Unused (Poké Transfer clears it) |
| 0x87 | u8 | **PokéStar fame** (B2W2 PokéStar Studios). PKHeX treats > 250 as "is a PokéStar" |

### 8.5 Party extension (0x88–0xDB, encrypted with the PID seed)

| Off | Type | Field |
|---|---|---|
| 0x88 | u32 | Status: bits 0–2 sleep turns, bit3 poison, bit4 burn, bit5 freeze, bit6 paralysis, bit7 toxic |
| 0x8C | u8 | Level |
| 0x8D | u8 | Unknown (Gen 4 seal capsule index; Poké Transfer zeroes it) |
| 0x8E | u16 | Current HP |
| 0x90 | u16 | Max HP |
| 0x92 | u16 | Attack |
| 0x94 | u16 | Defense |
| 0x96 | u16 | **Speed** |
| 0x98 | u16 | Sp. Atk |
| 0x9A | u16 | Sp. Def |
| 0x9C | 0x38 | Held mail (MailData) |
| 0xD4 | u32 × 2 | Unknown |

### 8.6 Derived values and invariants the game enforces

- **Gender is re-derived from the PID** whenever the game reads it. The game computes it from the species/form gender ratio and writes it back into bits 1–2, then fixes the checksum ([pokebw2] `PML_UtilDerivePkmSex`):
  - ratio 0 (male only) → male; 254 (female only) → female; 255 → genderless;
  - otherwise female if `(PID & 0xFF) < ratio`, else male.
  A PK5 whose stored gender disagrees with its PID silently changes gender in-game. Conversions must choose consistent PIDs.
  Threshold values in personal data:

  | Female share | Threshold |
  |---|---|
  | 12.5% | 31 |
  | 25% | 63 |
  | 50% | 127 |
  | 75% | 191 |

  This is the same 0–255 encoding as Gen 3, where pokeemerald defines `PERCENT_FEMALE(p) = min(254, p*255/100)` in `src/data/pokemon/species_info.h`. That Gen 5 personal data holds identical values is **UNVERIFIED but standard**.
  PokeAPI's `pokemon_species.csv` `gender_rate` (eighths female) maps as follows: −1 → 255, 0 → 0, 1 → 31, 2 → 63, 4 → 127, 6 → 191, 8 → 254.
- **Shiny**: `(TID ^ SID ^ (PID >> 16) ^ (PID & 0xFFFF)) < 8` ([pokebw2] `PML_UtilPIDIsRare`). The threshold doubles in Gen 6, which is why Poké Transporter may flip PID bit 31 ([PKHeX] `PK5.GetTransferPID`).
- **Ability slot**: Gen 5 picks slot 1/2 with PID bit 16 (Gen 3/4 used bit 0) ([pokebw2] `PID_ABILITY_BIT 0x10000`, `PID_ABILITY_BIT_OLD 1`). The game displays the ability ID at 0x15, but it **recomputes that byte on evolution/form change** (`setAbilityForForm`): hidden-ability flag set → hidden ability; otherwise, if the species has two abilities, slot 2 when the PID bit is set, where the bit is **bit 0 for origin game < 20 (Gen 3/4 transfers) and bit 16 for Gen 5 origins** (`getPkmAbilSlotNumber` uses the same rule). So a PK5 whose 0x15 disagrees with its PID silently changes ability when it evolves; conversions must keep 0x15 consistent with the PID bit for its origin.
- **Level**: box = from EXP; party = 0x8C, kept in sync by the game.
- **Nicknamed flag**: when the game sets a nickname it recomputes bit 31 by comparing with the species name in the game's language ([pokebw2] `PML_PkmIsNicknamed`).
- **Is-egg reads**: the game reports "egg" when bad-egg bit OR is-egg bit is set.

### 8.7 Empty slots

The game clears a slot by zeroing the struct, then "encrypting" it with checksum 0 and PID 0 ([pokebw2] `PML_PkmInit`, `PokeParty_ClearPkm`). An empty slot is therefore **not** all zeros:
- bytes 0x00–0x07 = 0;
- bytes 0x08–0x87 = the keystream for seed 0;
- for party slots, bytes 0x88–0xDB = the first 84 bytes of the same seed-0 keystream (a fresh PID-0 stream).

Detect emptiness after decryption by species == 0. Write empties with this exact encoding; a raw all-zero slot would decrypt to garbage. Test vectors are in §17.

### 8.8 Ribbons (bit = 1 means owned)

- 0x24: Sinnoh Champ, Ability, Great Ability, Double Ability, Multi Ability, Pair Ability, World Ability, Alert.
- 0x25: Shock, Downcast, Careless, Relax, Snooze, Smile, Gorgeous, Royal.
- 0x26: Gorgeous Royal, Footprint, Record, Event, Legend, World Champion, Birthday, Special.
- 0x27: Souvenir, Wishing, Classic, Premier (bits 4–7 unused).
- 0x3C–0x3F (Hoenn):
  - 0x3C/0x3D: Cool, Cool Super, Cool Hyper, Cool Master, then the same four for Beauty, Cute and Smart;
  - 0x3E: Tough ×4, Champion, Winning, Victory, Artist;
  - 0x3F: Effort, Battle Champion, Regional Champion, National Champion, Country, National, Earth, World.
- 0x60–0x62 (Sinnoh contest): Cool, Great, Ultra, Master, then the same four for Beauty, Cute, Smart and Tough (through 0x62 bit 3).

Sources: [PP-PK5], [PKHeX] `PK5` ribbon properties (consistent with each other).

---

## 9. Text encoding

- **UTF-16LE** code units, **terminator 0xFFFF** ([PKHeX] `StringConverter5.Terminator`). Readers should also stop at 0x0000.
- The game has **two** write paths into a PK5 name buffer, and they differ ([pokebw2] `poke_tool.c` `PML_PkmSetParamCore`):
  - Raw copy (`PKM_PARAM_NICKNAME_RAW`, `PKM_PARAM_OT_NAME_RAW`, used e.g. when a new Pokémon gets its species name): `wcharsncpy` (`src/system/str_tool.c`) copies up to and including the terminator and then **always** writes 0xFFFF into the last code unit (index n−1).
  - String-buffer copy (`PKM_PARAM_NICKNAME`, `PKM_PARAM_OT_NAME`, from a `StrBuf`, e.g. the naming screen): `GFL_StrBufStoreString` (`src/gfl/strbuf.c`) copies up to and including the terminator and stops; it writes 0xFFFF at n−1 **only** when the text fills the buffer. Units after the terminator keep whatever was there before.
  - Consequence: a game-created Pokémon usually ends with 0xFFFF at n−1 (left by the raw copy at creation), but a renamed one can keep leftovers of its previous name between its terminator and n−1 (for example `B O B FFFF C H U FFFF 0 0 FFFF` after renaming a PIKACHU to BOB, if the naming screen goes through `PKM_PARAM_NICKNAME`; inferred from the code, **UNVERIFIED** on hardware).
  - [PP-PK5] says "the last two bytes are always 0xFFFF, even if there already was a terminator before", but also lists **exceptions**: roaming Pokémon, starters, various gifts and in-game trades, "in which the OT name does not have the escape sequence".
  - Canonical layout when **we** must encode a fresh name (only if the user renames): `[chars][0xFFFF][0x0000 …][0xFFFF at index n−1]`, which is what the raw copy produces from a zeroed buffer; a full-length name has a single 0xFFFF at n−1. **Never reject or "repair" a PK5 because its last unit is not 0xFFFF or because of bytes after the terminator.**
- Buffers and limits:
  - Nickname: 11 units, maximum **10** characters (Western).
  - OT: 8 units, maximum **7** characters (Western).
  - Box name: 20 units.
  - Japanese and Korean in-game limits are **5** characters for nickname and OT (**UNVERIFIED**; PKHeX's generic constants allow 6 for an Asian OT).
- Gender symbols:
  - **Half-width** ♂/♀ (Western and Korean text) are stored as **0x246D / 0x246E**.
  - **Full-width** ♂/♀ (Japanese text) are U+2642 / U+2640.
  - PKHeX writes the half-width form unless the whole string is full-width, and always half-width for Korean ([PKHeX] `StringConverter5.SetString`, `StringConverter4Util.HGM/HGF`).
- Game glyphs at **U+2460–U+2487** (Unicode circled-number code points reused for Pokémon symbols). Display mapping, from [PP-PK5]:
  - 0x2467 → ×, 0x2468 → ÷, 0x246C → …, 0x246D → ♂, 0x246E → ♀;
  - 0x246F → ♠, 0x2470 → ♣, 0x2471 → ♥, 0x2472 → ♦, 0x2473 → ★;
  - 0x2474 → ◎, 0x2475 → ○, 0x2476 → □, 0x2477 → △, 0x2478 → ◇;
  - 0x2479 → ♪, 0x247A → ☀, 0x247B → ☁, 0x247D → ☂;
  - the rest (0x2460–0x2466, 0x2469–0x246B, 0x247E–0x2487) are Pokémon-only glyphs such as PK/MN and the balls, with no Unicode equivalent ([PP-PK5] "Pokémon exclusive characters"). 0x247C appears in neither of [PP-PK5]'s tables; treat it as Pokémon-only too (**UNVERIFIED**).
  - [PP-PK5] also lists ordinary code points that the game's font draws as Pokémon-specific glyphs: 0x0024 `$` (the Pokédollar sign), 0x21D2 ⇒, 0x21D4 ⇔, 0x2200 ∀, 0x2203 ∃, 0x2227 ∧, 0x2228 ∨, 0xFFE2 ￢. They round-trip unchanged; only the display differs.
  - When moving to Gen 6+, Transporter remaps this whole range to U+E081 + (c − 0x2460) and changes the apostrophe ' to ’ ([PKHeX] `StringConverter345`).
- [PP-PK5] says text produced in-game has no trash bytes (but see the `GFL_StrBufStoreString` note above). Poké Transfer keeps old trash bytes. A non-nicknamed Pokémon that evolves in a game of another language overwrites only part of the buffer ([PP-PK5]). **Store and re-emit the full raw 22- and 16-byte buffers**; never re-encode text unless the user renames.
- Machine-readable charmap: none is needed beyond the glyph table above, since it is plain UTF-16. For Gen 4→5 conversion (Poké Transfer), the Gen 4 charmap is a separate topic (see the Gen 4 notes).

---

## 10. ID spaces and machine-readable tables

| Kind | Gen 5 range | Notes / source |
|---|---|---|
| Species | 1–649, National Dex number stored directly | [PKHeX] `Legal.MaxSpeciesID_5 = 649`. No internal index mapping, unlike Gen 1–3 |
| Forms | 0–31 in 0x40 bits 3–7 | §11 |
| Moves | 1–559 | `MaxMoveID_5 = 559`. The IDs equal the global move IDs, which match Showdown `num` |
| Items | BW 1–632, B2W2 1–638 | `MaxItemID_5_BW/B2W2`. The IDs equal the Gen 4+ global item index. Mail items **137–148** (Greet … Bridge Mail M; [pokebw2] `MAIL_ITEM_IDS`; [PokeAPI]) |
| Abilities | 1–164 | `MaxAbilityID_5` |
| Balls | 1–25 (25 = Dream Ball) | `MaxBallID_5 = 0x19` |
| Natures | 0–24 (Hardy … Quirky) | |
| Origin game | §8.4 | |
| Met locations | 30001 Poké Transfer, 30002 in-game/NPC trade (also used by Spin Trade eggs), 30003 link trade, 60002 Day Care (egg location for bred eggs), 30010–30013 Poké Transfer special cases (Celebi / crown beasts) | [PKHeX] `Locations.cs`; same values in [pokebw2] `include/constants/met_locations.h` (also 30004–30009 Kanto/Johto/Hoenn/Sinnoh/Faraway/Unknown, 30014 Entralink, 30015 Dream Radar). The **link-trade** receive code sets met location 30003 and today's met date on a received egg ([pokebw2] `pokemontrade_save.c` → `PokeParty_SetupMetData(pkm, 6, …, 30003)`) |

Machine-readable sources, all MIT/BSD-compatible:

- **Species, moves, abilities, items, base stats for battles**: Showdown `data/pokedex.ts`, `data/moves.ts`, `data/abilities.ts`, `data/items.ts`, plus `data/mods/gen5/*.ts` for Gen 5 stat and ability overrides. Raw URLs follow the pattern `https://raw.githubusercontent.com/smogon/pokemon-showdown/master/data/pokedex.ts`. Showdown item `num` == Gen 5 item index for every item present in both Showdown (`gen ≤ 5`) and PokeAPI Gen 5 data. Original check: 241 held items. Re-check during verification: 248 items overlap and 247 agree; the one difference (Deep Sea Tooth: Showdown 226, PokeAPI 227) is PokeAPI's error, the same duplicate noted below.
- **Item game indices per generation**: PokeAPI `https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/item_game_indices.csv` (`generation_id = 5`, column `game_index`). Caveat: the Gen 5 rows contain **duplicate** `game_index` values (227, 356, 626, 628, 636), so use it as a cross-check, not as the source of truth.
- **Localized species names** (to recompute "is nicknamed" and to show names): PokeAPI `pokemon_species_names.csv` (`local_language_id` 1 ja-Hrkt, 3 ko, 5 fr, 6 de, 7 es, 8 it, 9 en).
- **Form metadata**: PokeAPI `pokemon_forms.csv`; Showdown `pokedex.ts` (`forme`, `baseSpecies`).

---

## 11. Forms

Forms are stored in 0x40 bits 3–7. Notes for storage and transfer between BW and B2W2:

| Species | Forms | Storage behaviour | Cross-game rule for us |
|---|---|---|---|
| Unown, Burmy, Wormadam, Shellos/Gastrodon, Rotom, Deoxys | Gen 3/4 forms | Kept | Fine |
| Giratina (0 Altered, 1 Origin) | Driven by the Griseous Orb | The game sets the form from the item | Keep the form consistent with the item |
| Shaymin (0 Land, 1 Sky) | | Link trade **reverts Sky → Land** and re-registers the dex ([pokebw2] `pokemontrade_save.c`) | On withdraw-after-trade set form 0 |
| Arceus | Plate → type form | | Form must match the plate |
| Castform, Cherrim | Battle-only | Stored as form 0 | Normalize to 0 |
| Deerling / Sawsbuck (0 Spring, 1 Summer, 2 Autumn, 3 Winter) | Season | The game may update the form to the current season (**UNVERIFIED** when). Lead: [pokebw2] `poke_party.h` declares `TransformVsPokePartyBySeason(gameData, party, season)`, a party-only routine, which suggests boxed Pokémon keep their stored form | Keep as stored |
| Basculin (0 Red-Striped, 1 Blue-Striped) | Fixed | Different abilities per form | Keep |
| Darmanitan (0 Standard, 1 Zen) | Battle-only (Zen Mode) | Stored as 0 | Normalize to 0 |
| Meloetta (0 Aria, 1 Pirouette) | Battle-only | Reverts after battle | Normalize to 0 |
| Genesect (0–4 by Drive) | Driven by the held Drive | | Form must match the item |
| Tornadus / Thundurus / Landorus (0 Incarnate, 1 Therian) | **B2W2 only** (Reveal Glass) | B2W2's GTS refuses "changed form" Pokémon ([pokebw2] `worldtrade_box.c` uses `hasPokemonChangedForm`: fused Kyurem, Therian, Keldeo-Resolute) | **Do not withdraw into BW** while form ≠ 0 |
| Keldeo (0 Ordinary, 1 Resolute) | **B2W2 only** (knows Secret Sword) | Same | Same |
| Kyurem (0, 1 White, 2 Black) | **B2W2 only** (DNA Splicers). The absorbed Reshiram/Zekrom stays in **that save's** block 43 (RESH_ZEK) | B2W2 forbids releasing a fused Kyurem ([pokebw2] `box2_seq.c`, message 7) and forbids depositing it in the GTS | **Refuse Home deposit of Kyurem with form ≠ 0**: the absorbed dragon would be stranded. Ask the user to unfuse first |

BW's personal and dex tables do not contain the B2W2-only forms: the dex has 9 form bytes instead of 11.

---

## 12. B2W2 Key System, Memory Link and other data we must not clobber

- **Key data block** (main save block 69 @0x25800, 0x60 bytes): the Black Tower / White Treehollow run, plus `KeyInfoSave` (keys unlocked and enabled; difficulty, city and chamber). Every value is XOR-obfuscated with a table and a seed ([pokebw2] `key_info.h`, `key_data_savedata.h`). It is inside the save and covered by the normal block CRC. We never modify it, and mirroring copies it unchanged.
- **Outside-the-save data** (0x7E000–0x7EAFF), which survives "delete save" and seeds a new game ([pokebw2] `save_outside.c`):
  - 0x7E000 and 0x7E400 hold two copies of the Mystery Gift cards.
  - 0x7E800 holds the Key System block: KeyInfo (0x38 bytes) + **Memory Link** data (0x1DC bytes: up to 3 linked BW players and the unlocked "memories").
  - Each copy has a 12-byte header: u32 magic 0xA10F49AE, u32 save counter, u16 CRC16 of the data, u16 size. The CRC is the same CCITT-FALSE (`getCRC16` → `MATH_CalcCRC16CCITT`). The stored size is not trusted: the loader overwrites it with the struct size before checking the CRC. The newer gift copy wins by counter, with the same 0 vs 0xFFFFFFFF wrap rule as the main save ([pokebw2] `SaveOutside_Load`).
  - Naming conflict: PKHeX calls 0x7E000/0x7E400 "Link1/Link2Data" and 0x7E800 "Key System?"; Project Pokémon calls 0x7E000–0x7EA1F "Memory Link Data". The decomp (code) is authoritative: gifts at 0x7E000/0x7E400, Key System + Memory Link at 0x7E800.
- **Dream Radar / 3DS link area** at 0x7F000+ ([PKHeX] `ExtUnkCRGF`; [PP-B2W2]).
- **DLC and extra saves** (§4.1), Hall of Fame (two copies), PWT downloads, PokéStar films, musicals, C-Gear and Pokédex skins.
- **The Memory Link reads BW saves**, so BW saves edited by us must stay valid. They will, if the main copies are correct. Its Wi-Fi path takes a whole 0x80000-byte BW image (after a 0x80-byte Game Sync header) and reads blocks 27/42/45/52/66 at the **main-copy** offsets of `wb_save_block.c`, with no CRC or footer check and no backup fallback ([pokebw2] `ov332/data_convert_flow.c` `WB_SAVE_HEADER_SIZE 0x80`, `wb_save_block.c`). One more reason to leave the main copy holding the current data (§5.6 step 5).

The rule is the same as §4.3: byte-preserving round trip of the whole file; only the two main-save copies are rewritten.

---

## 13. Japanese and Korean differences

| Aspect | International (ENG/FRE/ITA/GER/SPA) | Japanese | Korean |
|---|---|---|---|
| Save size and block layout | as above | **Same** (PKHeX has one layout per pair, no language branch) | **Same** |
| Text | UTF-16, half-width ♂♀ = 0x246D/0x246E | UTF-16 kana/kanji; full-width ♂♀ U+2642/U+2640 | UTF-16 Hangul; half-width gender glyphs |
| Name limits | Nickname 10, OT 7 | 5 / 5 (**UNVERIFIED**) | 5 / 5 (**UNVERIFIED**) |
| Language byte (trainer +0x1E, PK5 0x17) | 2, 3, 4, 5, 7 | 1 | 8 |
| Dex language bits | index 1–5 | index 0 | index 6 |
| Quirks | — | Japanese BW in-game trade Pokémon have PK5 language 0 ([PKHeX]) | Korean Gen 4 Nidoran names may contain full-width gender signs ([PKHeX] `CheckKoreanNidoranDPPt`) |
| PC port (Frigate) | USA/Europe B2W2 ROMs only | not supported by pokebw2/Frigate | not supported |

Supporting JPN and KOR saves needs no layout work. Text display needs CJK fonts, and our input validation must respect the shorter name limits. Cross-language trades are normal in-game, so we keep nicknames and OT names as raw buffers.

---

## 14. Emulators and PC ports

- **melonDS**: raw 512 KiB `.sav`. melonDS 1.1 knows IREO/IRDO as save type 6, a 524,288-byte flash ([Frigate] `port_card.h`). Older versions or wrong save-type guesses may pad with 0xFF or truncate.
- **DeSmuME**: `.dsv` with the 122-byte footer (§2). DeSmuME can also import and export raw `.sav`.
- **Frigate** (2026, B2W2 native port for Linux/macOS/Windows on the pokebw2 decomp):
  - The save file is **byte-identical** to the melonDS `.sav`. Frigate writes it whole via temp-file-and-rename, and refuses (never overwrites) a file of the wrong size ([Frigate] README "Saves").
  - Frigate keeps DS struct alignment for 64-bit fields (`PORT_DS_ALIGN_64`), precisely so the save blocks keep the DS layout ([Frigate] `docs/game-changes.md`, `include/types.h` row).
  - A save stores the console's RTC offset and MAC address. Frigate uses offset 0 (like melonDS), so a DS save that once had a clock change triggers the game's 24-hour daily-event penalty on first load ([Frigate] README).
  - Files: `IREO.sav` / `IRDO.sav` in `$XDG_DATA_HOME/Frigate`, `~/Library/Application Support/Frigate`, or `%APPDATA%\Frigate`.
- **pokebw2** (decomp, active, builds the USA/EU B2W2 ROMs) and **pokeblack** (early, English Black). No BW PC port exists as of 2026-10-24.
- **Implication**: a single raw-image parser serves emulators, cartridge dumps and the PC port. Container detection (§2) is the only per-platform code.

---

## 15. Procedures

### 15.1 Read a save
1. Strip the container and check for exactly 0x80000 bytes.
2. Detect BW or B2W2 (§3).
3. Build the effective image (§5.5). If the result is BROKEN, refuse with "this save is corrupted".
4. Parse the trainer block, box main block, 24 box trays (decrypt each slot; species == 0 means empty; verify the checksum, and treat failures as Bad Eggs that are never deposited), the party, and the dex.

### 15.2 Deposit into Home (PC box → server)
1. The user picks box *b*, slot *s*. Refuse if:
   - the slot is empty, or a bad egg;
   - it is Kyurem with form ≠ 0;
   - it holds a mail item (137–148): strip it with the user's consent, or refuse;
   - the Battle Box or Dream World holds it (those are not box slots anyway).
2. The `pk5` record is the slot's **136 stored bytes exactly as they sit in the PC (encrypted and shuffled)**, per `docs/ARCHITECTURE.md` ("136-byte box struct, encrypted exactly as stored in the PC"). Decrypt a copy only to validate and to build the view; the header flags (0x04) travel inside the record and should be 0. Because encryption is deterministic given PID and checksum (§8.2), encrypted ↔ decrypted is lossless either way.
3. Overwrite the slot with the empty encoding (§8.7), re-CRC that tray block, and apply §5.6 steps 2–7.

### 15.3 Withdraw from Home (server → PC box)
1. Target slot: a user-chosen empty slot with `b < trayCount`. Otherwise use the game's search: start at the current box, wrap within `trayCount`, and grow `trayCount` by 8 if all open boxes are full.
2. If the Pokémon came from a different trainer (a trade), mirror the in-game link-trade receive routine ([pokebw2] `pokemontrade_save.c`):
   - heal it (full HP and PP, clear status; for a box Pokémon only PP matters);
   - set friendship to **70** if it is not an egg;
   - for an egg: met location 30003 and met date = today (the game uses the DS RTC date; we use the user's local date);
   - Shaymin form 1 → 0;
   - **register it in the Pokédex** (§7.5);
   - optionally increment the trade-count record (**UNVERIFIED** record IDs: the decomp increments record 16, 12 or 36 depending on trade type).
3. Same-owner withdrawals are byte-exact: no changes besides the PP restore the game itself would do.
4. Target-game checks:
   - BW targets: species ≤ 649 always fine; items ≤ 632; no B2W2-only forms (§11); PokéStar fame may stay (BW ignores it, **UNVERIFIED**).
   - Gen 3/4 Pokémon need conversion following Poké Transfer rules ([PKHeX] `PK4.ConvertToPK5`): met location 30001 (or 30010–30013 for the event Celebi/crown beasts), friendship 70, nature byte = PID mod 25, ball = the PK4's effective ball (HGSS ball at PK4 0x86 if set, else 0x83) written to 0x83, met level = current level, HM moves removed (Defog kept over Whirlpool), PP restored, held mail cleared, held items not valid in BW removed, Arceus forced to form 0 and its plate removed, Shedinja forced genderless, byte 0x8D zeroed, bytes 0x44–0x47 and 0x86–0x87 cleared, names converted from the Gen 4 charmap. Poké Transfer also sets the met date to the transfer date (**UNVERIFIED**: PKHeX computes a date in this method but does not store it). This belongs in the cross-gen conversion doc.
5. Encrypt (§8.2), write the slot, re-CRC the tray (plus block 0 if `trayCount` changed, plus the dex block), and apply §5.6.

### 15.4 Trade (server-side)
Swap Home ownership only. The game-side effects happen at withdrawal (§15.3 step 2).

### 15.5 Battle
Use the decrypted PK5 to build a Showdown set:
- species and forme from National Dex number + form;
- moves by ID; ability ID (or the hidden-ability flag); item;
- nature; IVs and EVs (note the Spe/SpA/SpD order differs between EVs, IVs and party stats);
- level from EXP via the growth rate. Take each species' `growth_rate_id` from PokeAPI `pokemon_species.csv` and the per-level EXP from `experience.csv`. Showdown's `pokedex.ts` is not known to carry growth rates (**UNVERIFIED**);
- shiny (§8.6); gender (§8.6).

---

## 16. Gotchas (collected)

1. Empty slots are encrypted zeros, not zeros (§8.7).
2. Gender must match the PID's low byte, or the game rewrites it (§8.6).
3. Box level is not stored; compute it from EXP. The party level byte must agree with EXP.
4. The game restores PP when boxing and heals traded Pokémon. Mirror both so stored data looks game-made.
5. `trayCount` limits which boxes are usable (§7.1).
6. Writing only main can be undone by a newer backup. Always write both copies (§5.6).
7. Trainer +0x2C non-zero makes the save look like "no save" (§5.5). PKHeX's LastSaved setter writes there (§5.6).
8. Nicknames and OT names: keep raw buffers. The final code unit is usually, **not always**, 0xFFFF (in-game gifts, starters and trades can lack it, and renames can leave bytes after the terminator); never validate on it. Half-width ♂/♀ are 0x246D/0x246E (§9).
9. A fused Kyurem's absorbed dragon lives in the save, not in the PK5 (§11).
10. Mail items are normally not held by boxed Pokémon: the PC refuses to deposit them ([pokebw2] `box2_seq.c`), and a link trade received straight into a box moves the mail to the mailbox and clears the item, but only if the mailbox has a free slot ([pokebw2] `pokemontrade_save.c` `PoketradeSave_ApplyTradeResult`). So a boxed mail holder is rare but possible; handle it rather than assert.
11. Pokémon may be hidden in the Dream World block, the Battle Box, the Day Care or the GTS block (§7.6). Do not count them as missing or duplicated.
12. Japanese BW in-game trades have language 0 (§13).
13. Bad Eggs (checksum mismatch, or header bit 2) must never be deposited or "repaired".
14. The block counter is u16 and the global counter u32. Wrap-around is handled asymmetrically by the game (§5.5 step 2). Irrelevant in practice.
15. Detection must check the footer magic and size, not only the CRC (§3).
16. Extra saves are gated by trainer-block markers. Never set markers in synthetic saves unless the extra save's data is valid.
17. The CRC table's odd-count padding u16 is part of the footer CRC (§5.3).
18. B2W2 0x23F00–0x23F9B is Join Avenue data. BW-layout writes on a B2W2 save would corrupt it, so always detect first.
19. The DS RTC/MAC "console identity" in the save is a known cross-device issue ([Frigate]). The game's own logic handles it; we never touch it.

---

## 17. Test vectors and synthetic saves

Computed with an independent implementation written for this research, not derived from PKHeX code.

**CRC16 (CCITT-FALSE)**
- `"123456789"` → 0x29B1
- empty input → 0xFFFF
- 0x8C zero bytes → 0x2C2C

**Empty box slot (136 bytes)**
- bytes 0x00–0x17: `00000000 00000000 00007ee9 7152b031 428ecce2 c5afdb67`
- bytes 0x80–0x87: `00da6a70 c5df84ba`
- The first keystream word for seed 0 is 0x0000, which is why bytes 8–9 are 00 00.

**Empty party extension** (bytes 0x88–0xDB of an empty party slot): equals bytes 0x08–0x5B of the empty box slot. It starts `00007ee9 7152b031`.

**CRC16 of a box tray of 30 empty slots** (0xFF0 bytes): **0xEB33**. A freshly reset box block footer therefore stores CRC 0xEB33.

**Sample PK5**. Decrypted canonical 136 bytes, all zero except:
- PID u32@0 = 0x12345678;
- species u16@0x08 = 25;
- TID u16@0x0C = 12345, SID u16@0x0E = 54321;
- EXP u32@0x10 = 1000;
- friendship@0x14 = 70, ability@0x15 = 9, language@0x17 = 2;
- move1 u16@0x28 = 84, PP1@0x30 = 30;
- nature@0x41 = 3;
- nickname@0x48 = "PIKACHU" (UTF-16LE) + 0xFFFF at 0x56, zeros, 0xFFFF at 0x5C;
- origin@0x5F = 21.

Expected results:
- shuffle index ((0x12345678 >> 13) & 31) mod 24 = **2 → stored order ACBD**;
- checksum **0x2E26**;
- encrypted bytes 0x00–0x0F = `78563412 0000262e 9e656005 3acd4d65`;
- decrypting returns the original bytes, and the checksum verifies.

**Synthetic save builder** (for `node --test`; no real saves needed in CI):
1. Start from 0x80000 bytes of 0xFF, the erased-flash value. Choose the layout.
2. For each block *i*, write `size_i` bytes of content at the table offset. Zeros are fine except:
   - block 0: `trayCount = 8`, `currentBox = 0`, box names "Box 1" … "Box 24" (UTF-16, 0xFFFF-terminated);
   - box trays: 30 empty slots each;
   - party: capacity 6, count *n*, *n* encoded party PK5s (with stats), and the rest empty party slots;
   - trainer: name, TID/SID, version, language, gender; `isIntroSave = 0`; all markers 0;
   - Pokédex: magic 0xBEEFCAFE.
3. Write each block footer (counter 1, CRC), the CRC table (pad u16 = 0), and the footer: count 1, size 0x23F9C or 0x25FA4, magic 0x31053527, +0xC = 0, CRC.
4. Copy the main copy to the backup.
5. Run parser assertions against it:
   - detection;
   - trainer fields;
   - box and party contents round-trip;
   - deposit/withdraw changes only the expected blocks;
   - every block CRC validates;
   - the bytes outside the copies are unchanged (fill them with a random pattern first to prove it).

**Copy-selection tests**: build variants and assert which data the effective image uses.
- (a) both copies equal → main;
- (b) backup count = main + 1 with a different box 1 → backup's box 1;
- (c) main footer CRC broken → backup; the result is "BROKEN" only if both are broken;
- (d) one block corrupted in main only → that block comes from backup, the others from main;
- (e) footer magic wrong in both copies → "no save".

**Cross-oracle (dev-only, optional)**: load our output in PKHeX as a separate program (GPL tool, not linked or distributed) and check the checksum report shows "SAV: 70/70" (BW) or "74/74" (B2W2). Also check melonDS or Frigate show the injected Pokémon. The developer creates their own saves for this (new game → save after the intro); real saves are not committed to the repo.

**Text tests**: "Nidoran♂" (Western) encodes ♂ as 0x246D; the Japanese full-width "ニドラン♂" uses U+2642; a 10-character nickname has exactly one 0xFFFF at code unit 10.

---

## 18. Where sources disagree

| Topic | Disagreement | What we believe and why |
|---|---|---|
| BW trainer block checksum | [PP-BW] lists 0x19469 (odd address) | **0x1946A** = 0x19400 + 0x68 + 2. Matches PKHeX and the alignment rule; the Project Pokémon value is a typo |
| B2W2 Strength boulder checksum | [PP-B2W2] lists 0x201E2 | **0x210E2** (0x20F00 + 0x1E0 + 2), as PKHeX and the rule give |
| [PP-PK5] "Save File Location" | Says PC storage starts at 0x24400; daycare at 0x0141C/0x4141C; Pal Park at 0x0BA28 | Gen 4 leftovers. Main boxes start at **0x400**; 0x24400 is box 1 of the **BW backup copy**. Party first slot 0x18E08 is correct |
| Trainer +0x1E | Decomp names it `region` (PlayerInfo); PKHeX names it Language | **Language**: the decomp's new-game init writes 2 (`PlayerInfo_Init`: `info->region = 2`), which is LANGUAGE_ENGLISH (`include/constants/language.h`: `GAME_LANGUAGE LANGUAGE_ENGLISH`) in the USA/EU build, and PKHeX's language detection works on real saves. The decomp uses the same "region" name for the PK5 language byte 0x17 (`PKM_PARAM_REGION` reads `blockA->language`, and `addPkmToDex` feeds it to the dex language bits), so "region" there means language. The decomp's names come from the community "swan" symbol project and are guesses |
| Pokédex +0x04 bitfield | PKHeX: bit0 national unlocked, bits 1–10 "flags", bit11 national mode, bits 12–21 "initial species". Decomp: bit0 nationalObtained, bit1 habitat list, bits 2–9 `given`, bits 10–11 mode, bits 12–21 last species viewed | Decomp (code-derived). We never write it |
| Seen-form registration | PKHeX sets seen-form bit = base index; the game sets base + form | Decomp |
| Spinda personality | PKHeX: set if Spinda not seen; game: set if the stored value is 0 | Decomp |
| 0x7E000–0x7EAFF naming | PKHeX: "Link1/Link2 data, Key System?"; PP: "Memory Link Data"; decomp: Mystery Gift copies + Key System/Memory Link | Decomp |
| Which copy to read | PKHeX always reads main; the game prefers the higher footer count with per-block fallback | Game algorithm (§5.5) |
| PKHeX `PlayerData5.LastSaved` | The getter reads 0x28; the setter writes 0x2C | 0x28 is lastSaved; 0x2C is isIntroSave (decomp). Do not write 0x2C |

---

## 19. Open questions / UNVERIFIED items

1. BW footer size value 0x23F9C and BW use of magic 0x31053527 in the main footer. Derived from the shared engine plus PKHeX's BW extra-save writer. Confirm on a real BW save.
2. BW Pokédex magic 0xBEEFCAFE. Confirm on a real BW save.
3. Purpose of BW 0x7F800/0x7FC00 ("Link" data), and whether BW has the same outside-the-save gift area as B2W2.
4. Japanese and Korean in-game name length limits (5/5?).
5. Deerling/Sawsbuck: when the game rewrites the season form of stored Pokémon.
6. The party `slotExists` byte (0x19330): its purpose, and whether BW has it (BW party block size is also 0x534, so probably yes).
7. Trade-count record IDs to increment on withdraw-after-trade (decomp record 16/12/36 by trade type; names unknown).
8. No$GBA and DraStiC container specifics.
9. ROM game codes for BW (IRBO/IRAO) and regional variants. Only cosmetic (file names).
10. Whether BW tolerates PokéStar fame (0x87) or other B2W2-introduced values in withdrawn PK5s. Believed harmless.
11. Whether the naming screen writes nicknames through the `StrBuf` path (`GFL_StrBufStoreString`, leaves old units after the terminator) or the raw path (§9). Affects only what "game-made" names look like; we never re-encode names.
12. 0x247C (⑼): in neither of [PP-PK5]'s glyph tables.
13. Poké Transfer's met date (transfer date assumed; PKHeX computes but does not store it).
14. BW Pokédex registration: assumed identical to B2W2's `addPkmToDex` with BW's shorter form list (§7.5).
15. BW blocks 62, 67, 68 and the exact identity of BW 65 (§6.1).

---

## 20. Verification notes (adversarial review, 2026-10-24)

An independent pass re-fetched every primary source into `/tmp/claude-1000/pkres/verify-gen5/` (outside the project) and re-derived the numbers with throwaway scripts in `/tmp/claude-1000/pkres/verify-gen5/scripts/` (`cmp_blocks.py`, `wb_cmp.py`, `pp_cmp.py`, `pp_cmp2.py`, `vectors.mjs`, `synth.mjs`). Sources: PKHeX `master` (`SaveBlockAccessor5BW/B2W2.cs`, `BlockInfoNDS.cs`, `Checksums.cs`, `SaveUtil.cs`, `SAV5*.cs`, `PK4.cs`, `PK5.cs`, `PokeCrypto.cs`, `StringConverter5/345/4Util.cs`, `BoxLayout5`, `PlayerData5`, `Misc5`, `Daycare5`, `BattleBox5`, `Zukan5`, `SaveHandlerDeSmuME/ARDS`, `Legal.cs`, `Locations.cs`, `LanguageID.cs`, `EncounterTrade5BW/B2W2.cs`); pokebw2 `main` (`gfl/backup_system.c`, `gfl/savedata.c`, `gfl/strbuf.c`, `gfl/gf_standard.c`, `lib/nitro/src/math/math_crc.c`, `system/save_table.c`, `save_control.c`, `poke_tool.c`, `pokeparty.c`, `box_savedata.c`, `pokedex.c`, `pml_met_data.c`, `pml_item.c`, `waza_tool.c`, `str_tool.c`, `mystatus.c`, `trainer_data_savedata.c`, `resh_zek_savedata.c`, `ov194/pokemontrade_save.c`, `ov214/worldtrade_box.c`, `ov255/box2_seq.c`, `ov331/save_outside.c`, `ov332/wb_save_block.c`, `wb_save_convert.c`, `data_convert_flow.c`, and the headers they include); Project Pokémon r72/r73/r60 pages; Frigate `port/README.md`, `port_card.h`, `docs/game-changes.md`; DeSmuME `mc.cpp`; PokeAPI `items.csv`, `item_game_indices.csv`; Showdown `data/items.ts`.

### What was checked and found correct

- **Block tables (§6)**: all 69 BW and 73 B2W2 rows (offset, size, counter = off+size, CRC = off+size+2, table entry = tableOfs+2i) match PKHeX exactly; every offset follows the §5.1 rule from the previous block; the last block ends exactly at the CRC table (0x23F00 / 0x25F00). The BW layout also matches B2W2's own BW size table (`wb_save_block.c`, 71 entries, each = size+4, last two 0x8C and 0x10, running sum 0x23F9C). Project Pokémon's tables differ from PKHeX in exactly the two typos §18 lists (BW 0x19469, B2W2 0x201E2) and nowhere else.
- **CRC table / footer (§0, §5.3, §5.4)**: `crcsSize = n·2 (+2 if n odd)` = 0x8C / 0x94 ([pokebw2] `SaveData_Init`); footer = table + crcsSize = 0x23F8C / 0x25F94; size field = `footerSize + blocksEnd + crcsSize` = 0x23F9C / 0x25FA4 ([pokebw2] `SaveData_BuildTable`); footer struct {u32 count, u32 size, u32 magic, u16 unkC, u16 crc}; footer CRC covers the whole table including the pad u16; footer written first 15 bytes then the last byte; PKHeX's `IsValidFooter5` reads exactly `[mainSize−0x100, +infoLength)` and the u16 at the end.
- **CRC algorithm (§5.2)**: Nitro `MATHi_CRC16InitTable(0x1021)` + `MATH_CalcCRC16CCITT` (init 0xFFFF, MSB-first, no final XOR) = CRC-16/CCITT-FALSE. A bitwise version, the table version and PKHeX's nibble version agree on 2,000 random inputs. Vectors re-derived: "123456789" → 0x29B1, empty → 0xFFFF, 0x8C zero bytes → 0x2C2C (0x94 zero bytes → 0x5642), 30-empty-slot tray → 0xEB33.
- **Load algorithm (§5.5)**: ported `SaveData_LoadWithBackup` into `synth.mjs`, built synthetic BW and B2W2 saves purely from §5.1/§17, and ran the §17 copy-selection cases (a)–(e): all give the results the doc predicts, for both layouts. A sixth case confirmed §5.6's rationale: a main-only edit on a save whose backup footer count is higher is silently replaced by the backup's block.
- **PK5 (§8)**: every field offset matches the decomp structs (`BoxPkm`, `PartyPkm`, `PkmBlockA–D`) and PKHeX `PK5.cs`; party struct = 0xDC, `PokeParty` = 0x534 with `slotExists` at 0x530. Shuffle: the 24 lexicographic permutations reproduce all 32 rows of [pokebw2] `blockShufLUT` (rows 24–31 = 0–7) and PKHeX `BlockPosition`. LCG constants 0x41C64E6D / 0x6073, checksum = u16 sum, party extension keyed by PID, empty slot = zeroed struct encrypted with key 0 (`PML_PkmInit`, `PokeParty_ClearPkm`). Re-derived §17 vectors: empty-slot bytes, empty party extension, sample PK5 shuffle index 2 (ACBD), checksum 0x2E26, encrypted bytes `78563412 0000262e 9e656005 3acd4d65`, round trip through the decomp's LUT.
- **Other structs**: box main block (`BoxMainSave`, 0x3E0), Battle Box (0x35C), Day Care (0xE4 slots, 0x1CC/0x1D4), Dream World (PK5 at +8, 0x1AC), trainer block (0xB0 / 0x68 arithmetic), Pokédex (`PokeDexSave`, 0x4DC; BW 0x4D4 with F = 9; every absolute address in §7.5 recomputed), form-index table (all 21 bases recomputed from `pokemonFormList`), dex registration steps (`addPkmToDex`), language-bit formula, extra-save table and container (`sv_extra_blk_data`), outside-the-save layout (`save_outside.c`, `KeySystemData` 0x214 = 0x38 + 0x1DC with 3 Memory Link players), link-trade receive side effects, mail item IDs 137–148 (decomp list + PokeAPI), ID maxima (`Legal.cs`), met-location constants, language and version constants, DeSmuME footer length (82 + 24 + 16 = 0x7A), ARDS header 0xA4.

### Changes made (old → new, with source)

1. §2 DeSmuME row: "raw 0x80000 + 0x7A footer" → added the footer's field layout and the `padSize` check (u32 at end−0x24) ([DeSmuME] `mc.cpp`). DraStiC row: detect by content, not extension.
2. §3 step 2: added that footer offsets and the stored size are copy-relative (the backup footer also stores 0x23F9C / 0x25FA4) ([pokebw2] `SaveData_CheckFooter`). Added a B2W2-first detection order that reconciles §3's strict check with §5.4's "log, don't fail" advice for BW.
3. §5.5 step 1: "its CRC table and footer are copied ... and both are marked for rewrite" → only the other copy's table and footer are copied over and marked; block data is not copied.
4. §5.5 step 3: "If main is usable, its data is used" → when both copies are usable but their block counters differ, the copy whose table is in use wins, which can be the backup ([pokebw2] `SaveData_LoadWithBackup`: `dataFooter->count != mainFooter->count` → `BLOCK_STATUS_WRITE_MAIN` → backup bytes copied over main). Added the "only main usable → backup marked" case and the final table/footer copy.
5. §5.5 "Saving": "Pass 0 writes those blocks to main, then main's CRC table, then main's footer ... A save interrupted during pass 1 leaves main newer" → items are written to the copy their mark names; on the **first save after a load** the table and footer go to the non-preferred copy (normally the backup) in pass 0, so an interruption between passes leaves the backup's footer newer ([pokebw2] `SaveData_LoadWithBackup` sets `copies[copyIndex ^ 1]` on the table/footer entries; `SaveData_WriteBlock(sv, i, status, …)` uses the mark as the copy; `SaveData_SwapBlockStatuses`). "Both copies are identical" → identical blocks, table and count; inter-block padding is never written.
6. §5.5 load gates: "`isIntroSave` non-zero" → "equals 1"; extra saves also need their footer count to equal the trainer block's counter ([pokebw2] `SaveControl_OpenExtraBlock` → `SaveData_LoadWithCount`).
7. §5.6 "Why both": added that the backup-newer state arises from real interrupted saves, and that only bumping main's count is not a fix.
8. §6.1 BW/B2W2 correspondence: "BW blocks 43–68 are shifted ... From matching sizes: ... BW 65 to B2W2 63" → BW 0–53 keep their B2W2 index (ten differ in size, listed); the one-index shift starts at BW 54; BW 65 vs B2W2 63 sizes differ (0x5C vs 0xA8), so that match rests on PKHeX's name only (programmatic size comparison).
9. §7.1 box flags: "bits 1 and 2" → masks 0x01 and 0x02, i.e. bits 0 and 1 ([pokebw2] `BoxSaveAccessor_CheckFlags`, called with 1 and 2 in `box2_seq.c`).
10. §7.2: added the max-PP formula `base + floor(base·20·ppUps/100)` ([pokebw2] `waza_tool.c` `PML_MoveGetMaxPP`).
11. §7.4: added the size arithmetic and the Memory Link confirmation of BW `PlayerInfo` at block 27 +4.
12. §7.5 step 2: "sex = the stored gender" → sex derived from PID + gender ratio (`PokeParty_GetSex` → `PML_UtilDerivePkmSex`). Added BW form-list note and PKHeX's Korean language-bit gap.
13. §7.6: Fused-dragon row now gives the PK5 position (+0x04, abs 0x1FA04; `struct ReshZekSave` = 4-byte `CityState` + `PartyPkm` = 0xE0). Day Care row: slot size, slot 1 offset, DS 4-byte u64 alignment.
14. §8.6 ability: "the bit matters only for generation and legality" → the game rewrites 0x15 on evolution/form change from PID bit 16 (Gen 5 origin) or bit 0 (origin < 20) ([pokebw2] `setAbilityForForm`, `getPkmAbilSlotNumber`).
15. §9: "The game's copy routine always writes the terminator into the last code unit" → only the raw path (`wcharsncpy`) does; the `StrBuf` path (`GFL_StrBufStoreString`) writes it at n−1 only for full-length text and leaves later units untouched. Added [PP-PK5]'s own exceptions (gifts, starters, roamers, in-game trades lack the final 0xFFFF). Glyph list: removed 0x247C from the sourced Pokémon-only list (it is in neither [PP-PK5] table; kept as UNVERIFIED) and added [PP-PK5]'s Pokémon-specific glyphs at ordinary code points ($, ⇒, ⇔, ∀, ∃, ∧, ∨, ￢).
16. §10: "In-game trade code uses 30003 for traded eggs" → the **link-trade** code does (`pokemontrade_save.c`, `PokeParty_SetupMetData(pkm, 6, …, 30003)`); added the other decomp location constants. Showdown item check recount (248 overlap, one PokeAPI error).
17. §11 Deerling/Sawsbuck: added the `TransformVsPokePartyBySeason` lead (party-only).
18. §12: outside-the-save CRC and counter rules; Memory Link reads the BW **main** copy without CRC checks (`data_convert_flow.c`, `wb_save_block.c`).
19. §15.2 step 2: "Store the decrypted 136-byte PK5" → the record is the 136 stored (encrypted, shuffled) bytes, as `docs/ARCHITECTURE.md` defines `pk5`.
20. §15.3 Poké Transfer list: added met level = current level, PP restore, invalid-item removal, Arceus form/plate, Shedinja gender, 0x8D, Defog/Whirlpool rule; met date flagged UNVERIFIED ([PKHeX] `PK4.ConvertToPK5`).
21. §16 #8: "The final code unit is always 0xFFFF" → usually, not always; never validate on it. #10: mail holders in boxes are rare but possible.
22. §18 trainer +0x1E: added that the decomp also calls the PK5 language byte "region" (`PKM_PARAM_REGION` → `blockA->language`).
23. §19: added open items 11–15. §5.4: added the `wb_save_block.c` evidence for the BW size value.

### Still uncertain after this pass

- BW footer magic 0x31053527 (no BW-specific source contains it) and BW Pokédex magic 0xBEEFCAFE: need one real BW save. The size 0x23F9C is now supported by B2W2's BW table but still not observed.
- Whether in-game renames leave trash after the terminator (§9, §19 #11); the doc now tells implementers not to depend on either answer.
- BW-only behaviour inferred from B2W2 code (dex registration, footer, load algorithm). BW has no usable decompilation (`squiddonaut/pokeblack` has 3 C files as of 2026-10-24).
- Bulbapedia claims (§1 [Bulba-PK4], missing Gen V pages) were not re-checked; nothing in the byte layout depends on them.
- Frigate states `IREO`/`IRDO` are the US codes; "US/EU" in §2 relies on pokebw2's "USA/Europe" ROM note and is consistent with it, but the European-language letter codes remain UNVERIFIED.
