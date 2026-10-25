# Generation 1 and 2 save and Pokémon formats (Red, Blue, Yellow, Gold, Silver, Crystal)

Status: research notes for the Gen 1/Gen 2 save parser and writer in `pokemon-matrix-widget`.
Researched 2026-10-24. Every non-obvious fact cites a source tag from §1. **UNVERIFIED** marks anything that is not confirmed by game code (pret) or by two independent sources.

How the offsets were obtained: pret's disassemblies rebuild the original ROMs byte for byte, and each repo publishes a `symbols` branch with the linker's `.sym` file. Every SRAM symbol (`sXxx`) has a `bank:address`, and the file offset in a raw `.sav` is `bank × 0x2000 + (address − 0xA000)`. Save routines copy WRAM blocks into SRAM one-to-one, so each WRAM symbol inside a saved block also maps to a file offset. All international offsets below come from that mapping and were then checked against PKHeX and Bulbapedia. Japanese and Korean offsets come from PKHeX only, because pret has no Japanese or Korean disassembly, so they are marked as single-source. Finally, synthetic saves built from these notes (§13) loaded correctly in PKHeX.Core 24.7.27 for all seven layouts.

Licensing note: PKHeX (GPLv3) was **read only**, and it was used as an external test oracle (a NuGet package in a throwaway harness outside this repo). Nothing from it is copied here. pret repositories have **no license file**, so we treat them as reference material: do not vendor pret files. Factual tables, such as offsets and byte-to-character maps, are restated here in our own form. The pseudo-code in these notes was written for them and can be reimplemented under our MIT license.

Conventions: all offsets are hex **file offsets** into the raw SRAM image (the `.sav` without any emulator header or footer). "INT" means the international layout (English, French, German, Italian, Spanish). Multi-byte numbers are **big-endian** unless a row says otherwise. Gen 2 checksums are the main exception: they are stored little-endian.

---

## 0. Key facts

| | Gen 1 INT (R/B/Y) | Gen 1 JP (R/G/B/Y) | GS INT | Crystal INT | GS JP | Crystal JP | GS KOR |
|---|---|---|---|---|---|---|---|
| SRAM size | 0x8000 | 0x8000 | 0x8000 | 0x8000 | 0x8000 | 0x10000 (64 KiB; also accept 0x8000) | 0x8000 |
| Name field length (incl. 0x50 terminator) | 11 | 6 | 11 | 11 | 6 | 6 | 11 (2-byte Hangul) |
| Party list @ | 0x2F2C | 0x2ED5 | 0x288A | 0x2865 | 0x283E | 0x281A | 0x28CC |
| Current-box list @ | 0x30C0 | 0x302D | 0x2D6C | 0x2D10 | 0x2D10 | 0x2D10 | 0x2DAE |
| Boxes × slots | 12 × 20 | 8 × 30 | 14 × 20 | 14 × 20 | 9 × 30 | 9 × 30 | 14 × 20 |
| Box list bytes / stride | 0x462 / 0x462 | 0x566 / 0x566 | 0x44E / 0x450 | 0x44E / 0x450 | 0x548 / 0x54A | 0x548 / 0x54A | 0x44E / 0x450 |
| Main checksum | 8-bit, `~sum(0x2598..0x3522)` @0x3523 | `~sum(0x2598..0x3593)` @0x3594 | 16-bit LE sum(0x2009..0x2D68) @0x2D69 | sum(0x2009..0x2B82) @0x2D0D | sum(0x2009..0x2C8B) @0x2D0D | sum(0x2009..0x2AE2) @0x2D0D | sum(0x2009..0x2DAA) @0x2DAB |
| Backup copy | none | none | split into 5 pieces, sum @0x7E6D | contiguous 0x1209..0x1D82, sum @0x1F0D | contiguous 0x7209.., sum @0x7F0D | contiguous 0x7209.., sum @0x7F0D | odd 5-range sum @0x7E6B |
| Box checksums | per bank + per box (written, never checked) | same (positions UNVERIFIED) | none | none | none | none | none |
| Which current-box copy is authoritative | bank-1 copy @0x30C0 | bank-1 copy | the box's own slot in bank 2/3 | slot in bank 2/3 | slot (PKHeX) | slot (PKHeX) | slot (PKHeX) |
| Pokémon struct (box / party) | 33 / 44 bytes | same | 32 / 48 | 32 / 48 | 32 / 48 | 32 / 48 | 32 / 48 |
| Species byte | internal index (table, §9.1) | same | National Dex (1–251), list marker 0xFD = Egg | same | same | same | same |
| Encryption / shuffling / per-mon checksum | none | none | none | none | none | none | none |

Red and Blue cannot be told apart from a save; neither can Gold and Silver. Their SRAM symbol tables are identical, and no version byte exists (§3.3).

---

## 1. Sources

| Tag | Source | Used for |
|---|---|---|
| [red-sym] | https://raw.githubusercontent.com/pret/pokered/symbols/pokered.sym (also `pokeblue.sym`), symbols branch @ bd77855a9f | exact SRAM/WRAM addresses for R/B |
| [yel-sym] | https://raw.githubusercontent.com/pret/pokeyellow/symbols/pokeyellow.sym @ 2c9d118c3f | Yellow addresses |
| [gs-sym] | https://raw.githubusercontent.com/pret/pokegold/symbols/pokegold.sym (also `pokesilver.sym`) @ 4b57c3aa31 | Gold/Silver addresses |
| [c-sym] | https://raw.githubusercontent.com/pret/pokecrystal/symbols/pokecrystal.sym (also `pokecrystal11.sym`) @ 3b13ca4fa7 | Crystal addresses |
| [red-sram] | pret/pokered `ram/sram.asm` (master @ a536711) | Gen 1 SRAM sections |
| [red-wram] | pret/pokered `ram/wram.asm` | Gen 1 saved WRAM blocks |
| [red-save] | pret/pokered `engine/menus/save.asm` | Gen 1 load/save/checksum/box switch code |
| [red-macros] | pret/pokered `macros/ram.asm`, `constants/pokemon_data_constants.asm`, `constants/text_constants.asm`, `constants/ram_constants.asm`, `constants/battle_constants.asm`, `constants/type_constants.asm` | struct layouts, constants |
| [red-charmap] | https://raw.githubusercontent.com/pret/pokered/master/constants/charmap.asm (the file lives in `constants/`, not at the repo root) | Gen 1 EN and JP text tables |
| [red-dex] | pret/pokered `constants/pokemon_constants.asm`, `constants/pokedex_constants.asm`, `data/pokemon/dex_order.asm` | internal-to-Dex table |
| [red-addmon] | pret/pokered `engine/pokemon/add_mon.asm`, `engine/menus/main_menu.asm` | box/party move semantics, save-exists check |
| [yel-src] | pret/pokeyellow @ 4cda94c: `scripts/OaksLab.asm`, `engine/pikachu/pikachu_status.asm`, `engine/pokemon/add_mon.asm`, `engine/items/item_effects.asm`, `data/pokemon/base_stats/*.asm`, `constants/item_constants.asm` | Yellow specifics |
| [gs-sram] / [c-sram] | pret/pokegold @ fc702b6 and pret/pokecrystal @ 5c877ef `ram/sram.asm` | Gen 2 SRAM sections |
| [gs-save] / [c-save] | pret/pokegold and pret/pokecrystal `engine/menus/save.asm` | Gen 2 primary/backup logic, checksums, box copy |
| [c-macros] | pret/pokecrystal `macros/ram.asm`, `constants/pokemon_data_constants.asm`, `constants/text_constants.asm`, `constants/item_data_constants.asm`, `constants/misc_constants.asm`, `constants/ram_constants.asm` | Gen 2 structs and constants |
| [c-move] | pret/pokecrystal `engine/pokemon/move_mon.asm` | removal shifting, stat calculation, trade receive |
| [c-mail] | pret/pokecrystal `engine/pokemon/mail.asm`, `data/items/mail_items.asm` | mail backup/restore |
| [c-link] | pret/pokecrystal `engine/link/link.asm`, `engine/link/time_capsule.asm`, `data/items/catch_rate_items.asm` | Time Capsule Gen1↔Gen2 conversion |
| [c-dv] | pret/pokecrystal `engine/gfx/load_pics.asm` (GetUnownLetter), `engine/gfx/color.asm` (CheckShininess), `engine/pokemon/mon_stats.asm` (GetGender), `engine/pokemon/caught_data.asm`, `engine/pokedex/unown_dex.asm`, `home/game_time.asm`, `engine/events/daycare.asm` | DV-derived fields, caught data, Unown dex, egg fields |
| [c-charmap] | https://raw.githubusercontent.com/pret/pokecrystal/master/constants/charmap.asm | Gen 2 EN and JP text tables |
| [pkhex] | kwsch/PKHeX master @ a9ff306570 (read only): `PKHeX.Core/Saves/SAV1.cs`, `SAV2.cs`, `Saves/Substructures/Gen12/SAV1Offsets.cs`, `SAV2Offsets.cs`, `Saves/Util/SaveUtil.cs`, `PKM/PK1.cs`, `PK2.cs`, `PKM/Shared/GBPKM.cs`, `GBPKML.cs`, `PokeList1.cs`, `PokeList2.cs`, `PKM/Util/Conversion/SpeciesConverter.cs`, `ItemConverter.cs`, `PKM/Util/PokeCrypto.cs`, `Saves/Substructures/Mail/Mail2.cs`, `PKM/Strings/StringConverter1.cs`, `StringConverter2.cs`, `StringConverter2KOR.cs`, `Saves/Util/Recognition/SaveHandlerFooterRTC.cs`, `SaveHandlerNSO.cs` | JP/KOR offsets, detection heuristics, container handling, cross-checks |
| [bulba-s1] / [bulba-s2] | Bulbapedia "Save data structure (Generation I/II)" (`?action=raw`) | cross-check, checksum ranges, GS backup pieces |
| [bulba-p1] / [bulba-p2] | Bulbapedia "Pokémon data structure (Generation I/II)" | cross-check, caught-data example |
| [bulba-ce2] | Bulbapedia "Character encoding (Generation II)" | cross-language compatibility, European tables |
| [pokeapi] | https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_game_indices.csv and `item_game_indices.csv` | machine-readable index tables (third check of the species table) |
| [bgb-rtc] | https://bgb.bircd.org/rtcsave.html | MBC3 RTC footer (44/48 bytes) |
| [mgba] | mgba-emu/mgba `include/mgba/internal/gb/mbc.h` (`struct GBMBCRTCSaveBuffer`) | mGBA uses the same 48-byte RTC footer |
| [ports] | README files of `sp00nznet/pokemon-crystal`, `sp00nznet/pokemon-gold`, `GB-Recomp/pokered`; `bryanthaboi/gen1recomp` `docs/architecture.md` and `src/core/SaveData.lua` header | PC-port save formats |
| [oracle] | Our synthetic saves (§13) loaded with PKHeX.Core 24.7.27 (NuGet, net8.0) in a scratch harness | independent validation of these notes |

---

## 2. Containers: what users will upload

The payload is always the raw cartridge SRAM image. Wrappers seen in practice:

| Container | Shape | Handling |
|---|---|---|
| Raw `.sav` / `.srm` (most emulators, flash-cart dumps, GB Operator) | exactly 0x8000 (Gen 1, Gen 2 INT/KOR, GS JP) or 0x10000 (JP Crystal, because the Japanese cart has 64 KiB of SRAM for the Mobile Adapter features; [c-sram] places mobile data in banks 4–7; [pkhex] accepts 0x8000 and 0x10000 for every Gen 2 layout) | parse directly |
| Raw + RTC footer (Gen 2 carts use MBC3 with a clock; [red-pokered Makefile] shows R/B as MBC3+RAM+BATTERY without a timer, Yellow as MBC5, GSC as MBC3+TIMER+RAM+BATTERY, all with 32 KiB SRAM `-r 3`) | 0x8000 + 48 bytes (BGB, VBA-M, mGBA, SameBoy) or + 44 bytes (older VBA) | split off `size & 0x3F` bytes as the footer and keep them **verbatim**. Footer layout ([bgb-rtc], [mgba]): ten u32 LE values (current sec, min, hour, days, days-high, then the same five latched), followed by a UNIX timestamp, u64 LE in the 48-byte form or u32 in the 44-byte form. [pkhex] accepts footer sizes 0x0C–0x30 (even) plus 0x07 (FlashGBX). |
| Separate `.rtc` sidecar | gb-recompiled PC ports write `PM_CRYSTAL.sav` (raw SRAM) plus `PM_CRYSTAL.rtc`, a 48-byte BGB-compatible sidecar ([ports]); Gambatte also writes a separate `.rtc` (format UNVERIFIED) | we only need the `.sav`. Never touch the `.rtc`. |
| Nintendo Switch Online GB save | starts with ASCII `SRAM`; header = magic(4) + u32 + SHA-1 of ROM as 40 ASCII hex chars @0x08 + u32 build-string length @0x30 + build string @0x34 + u8 hasRTC + (0x20 RTC bytes if set) + SHA-1 of the SRAM payload as 40 lowercase ASCII hex chars; then the raw SRAM ([pkhex] SaveHandlerNSO) | strip the header. After editing, **recompute the SHA-1 of the payload** and write it back as lowercase hex, or NSO rejects the file. Total size = SRAM + 0x68…0xA0. |
| 3DS Virtual Console `sav.dat` | raw SRAM image ([pkhex] treats `sav*.dat` names as VC) | parse directly. VC Japanese Crystal size is UNVERIFIED: accept 0x8000 or 0x10000. |
| gb-recompiled static recompilations (Pokémon Red `GB-Recomp/pokered` → `pokered.sav`; Gold/Crystal ports by sp00nznet) | raw cartridge RAM written by the runtime ([ports]) | identical to emulator saves. This is why the save-file approach covers these ports. |
| Gen1Recomp / "G1R Deluxe" (LÖVE2D re-implementation) | **not** SRAM: a Lua-table text save in the LÖVE save dir (`src/core/SaveData.lua`, "Lua-serialized save") ([ports]) | out of scope for this parser. It needs its own adapter (see the PC-ports research). Whether it can import or export `.sav` is UNVERIFIED. |

Output rule: re-emit the same container. That means the same SRAM size, the same footer bytes, and the same NSO header with a fresh hash.

---

## 3. Detecting the game

### 3.1 Algorithm (checksum-first, then structure)

Run every candidate against the SRAM image (after stripping containers). Accept a candidate only if its checksum validates and its list headers are sane.

1. **Gen 1 INT**: `s[0x3523] == (~Σ s[0x2598..0x3522]) & 0xFF`; party header valid at 0x2F2C (count ≤ 6 and `s[0x2F2C+1+count] == 0xFF`); current-box header valid at 0x30C0 (count ≤ 20); and a 0x50 byte appears within `s[0x2598..0x25A2]`. The game itself checks that last condition before offering CONTINUE ([red-addmon] `CheckForPlayerNameInSRAM` scans NAME_LENGTH = 11 bytes).
2. **Gen 1 JP**: `s[0x3594] == ~Σ s[0x2598..0x3593]`; party at 0x2ED5 (≤ 6); box at 0x302D (≤ 30); 0x50 within `s[0x2598..0x259D]`.
3. **Crystal INT**: u16le @0x2D0D == Σ 0x2009..0x2B82, **or** the backup u16le @0x1F0D == Σ 0x1209..0x1D82; check bytes `s[0x2008]==0x63` and `s[0x2D0F]==0x7F` (backup: `s[0x1208]==0x63`, `s[0x1F0F]==0x7F`); party at 0x2865 (≤ 6); box at 0x2D10 (≤ 20).
4. **GS INT**: u16le @0x2D69 == Σ 0x2009..0x2D68 (or the backup at 0x7E6D, §5.3); `s[0x2008]==0x63`, `s[0x2D6B]==0x7F`; party at 0x288A; box at 0x2D6C.
5. **GS JP**: u16le @0x2D0D == Σ 0x2009..0x2C8B (or @0x7F0D == Σ 0x7209..0x7E8B); party at 0x283E; box at 0x2D10 (≤ 30).
6. **Crystal JP**: u16le @0x2D0D == Σ 0x2009..0x2AE2 (or @0x7F0D == Σ 0x7209..0x7CE2); party at 0x281A; box at 0x2D10 (≤ 30).
7. **GS KOR**: u16le @0x2DAB == Σ 0x2009..0x2DAA; party at 0x28CC; box at 0x2DAE.

[pkhex] SaveUtil detects these layouts with only the two list-header checks, in this order: G1 JP, G1 INT; then GS INT, C INT, GS JP, C JP, GS KOR. Adding checksums removes false positives. An 8-bit Gen 1 checksum alone collides about 1 time in 256, so always combine it with the list checks. If more than one candidate passes, prefer one whose check bytes also match (Gen 2), then flag the result for user confirmation.

The Gen 2 check bytes (0x63 = `SAVE_CHECK_VALUE_1` = 99, 0x7F = `SAVE_CHECK_VALUE_2` = 127, from [c-macros] `misc_constants.asm`) are what the game tests to decide whether a save exists at all ([gs-save] `CheckPrimarySaveFile`, `CheckBackupSaveFile`). Their location in the JP builds is UNVERIFIED. The JP layouts presumably have them too, but no source gives the offsets. Inference only: in both INT layouts check value 1 sits at 0x2008 and check value 2 sits immediately before `sBox` (GS 0x2D6B/0x2D6C, Crystal 0x2D0F/0x2D10). The JP checksum is at 0x2D0D and the JP `sBox` at 0x2D10, so the JP primary check bytes are most likely at 0x2008 and 0x2D0F, and the backup ones at 0x7208 and 0x7F0F. **UNVERIFIED**: use them only as a confidence boost, never as a hard requirement.

### 3.2 Yellow vs Red/Blue

Same layout ([red-sym] and [yel-sym] give identical SRAM symbols). Heuristic ([pkhex] `SAV1.IsYellow`):
- `wPlayerStarter` @0x29C3 (JP 0x29B9) == 0x54 (internal Pikachu) → Yellow. In R/B it is 0x99 Bulbasaur, 0xB0 Charmander or 0xB1 Squirtle (internal IDs).
- If the starter byte is 0 (a save from before Oak's lab), Yellow when `wPikachuHappiness` @0x271C (JP 0x2712) ≠ 0. Yellow sets it to 90 at new game (pokeyellow `engine/movie/oak_speech/init_player_data.asm`). In R/B the same file offset lies inside a 128-byte gap that the game never uses (`ds 128` after `wDestinationWarpID`), so it stays 0.

### 3.3 Red vs Blue, Gold vs Silver

There is no version byte. [red-sym] and the Blue symbols are identical in SRAM, and so are [gs-sym] and `pokesilver.sym` (verified by diffing). The saved WRAM symbols are identical too. Crystal 1.0 (`pokecrystal.sym`) and 1.1 (`pokecrystal11.sym`) also have identical SRAM symbols, and their WRAM differs only in `wPokedexStatus`, which is not saved. All Crystal revisions (and the AU build, which links the same source) therefore share one layout. [pkhex] reports "RB" and "GS". Ask the user, or store "RB"/"GS". In Gen 2 the origin game is not recorded in Pokémon anyway; only Crystal writes met data.

### 3.4 Language

Only the JP/INT/KOR split is detectable structurally. French, German, Italian and Spanish share the English layout ([pkhex] has no other branches). The language matters for text decoding (§10), so infer it from the bytes in names (German umlauts are 0xC0–0xC5) and confirm with the user.

---

## 4. Generation 1 (Red, Blue, Yellow)

### 4.1 Bank map (INT; [red-sram] + [red-sym])

| Bank | File range | Contents |
|---|---|---|
| 0 | 0x0000–0x1FFF | 3 sprite decompression buffers (0x0000, 0x0188, 0x0310; 0x188 each), unused 0x100, **Hall of Fame** 0x0598–0x1857 (50 teams × 6 × 16 bytes = 0x12C0), unused |
| 1 | 0x2000–0x3FFF | 0x2000–0x2597 unused. **Checksummed game data 0x2598–0x3522**, checksum byte 0x3523 |
| 2 | 0x4000–0x5FFF | boxes 1–6 (0x462 each) @0x4000, 0x4462, 0x48C4, 0x4D26, 0x5188, 0x55EA; all-boxes checksum @0x5A4C; 6 per-box checksums @0x5A4D–0x5A52 |
| 3 | 0x6000–0x7FFF | boxes 7–12 @0x6000, 0x6462, 0x68C4, 0x6D26, 0x7188, 0x75EA; all-boxes checksum @0x7A4C; per-box @0x7A4D–0x7A52 |

The bank-1 game data blocks, in save order ([red-sram]; sizes from [red-sym]):

| Block | INT offset | INT size | JP offset | JP size | WRAM (R/B) |
|---|---|---|---|---|---|
| Player name | 0x2598 | 0x0B | 0x2598 | 0x06 | wPlayerName |
| Main data | 0x25A3 | 0x789 | 0x259E | 0x737 (derived) | wMainDataStart (D2F7) |
| Sprite data | 0x2D2C | 0x200 | 0x2CD5 (derived) | 0x200 | wSpriteDataStart (C100) |
| Party data | 0x2F2C | 0x194 | 0x2ED5 | 0x158 | wPartyDataStart (D163) |
| Current box data | 0x30C0 | 0x462 | 0x302D | 0x566 | wBoxDataStart (DA80) |
| Tileset/animation byte | 0x3522 | 1 | 0x3593 | 1 | hTileAnimations |
| **Checksum** | 0x3523 | 1 | 0x3594 | 1 | — |

The JP rows come from [pkhex] SAV1Offsets.JPN (party 0x2ED5, current box 0x302D, checksum 0x3594). The "derived" sizes follow from the 6-byte names (main data ends at the derived daycare end 0x2CD5, and 0x2CD5 + 0x200 = 0x2ED5 = party, which is consistent). JP is single-source.

Gen 1 JP boxes ([pkhex] `GetBoxRawDataOffset`: boxes 0–3 in bank 2, 4–7 in bank 3, list size 0x566): 0x4000, 0x4566, 0x4ACC, 0x5032 | 0x6000, 0x6566, 0x6ACC, 0x7032. [oracle] confirmed that a Pokémon written at 0x6000 shows up as box 5. The positions of the JP bank checksums are **UNVERIFIED**. By analogy with INT they would sit immediately after the 4 boxes (0x5598 / 0x7598, then 4 per-box bytes), but no source states this. The game never reads them (§4.3), so do not write them for JP until a real JP save confirms the location.

### 4.2 Bank-1 field offsets ([red-sym]/[yel-sym] mapped to the file; INT values match [pkhex] SAV1Offsets.INT exactly)

| Field | INT | JP ([pkhex]) | Size | Notes |
|---|---|---|---|---|
| Player name | 0x2598 | 0x2598 | 11 / 6 | text, 0x50 terminated; max 7 chars INT, 5 JP |
| Pokédex owned (caught) | 0x25A3 | 0x259E | 19 | bit (dex−1), LSB first |
| Pokédex seen | 0x25B6 | 0x25B1 | 19 | same |
| Bag item list | 0x25C9 | 0x25C4 | 1 + 20×2 + 1 | count, (item, qty) pairs, 0xFF terminator |
| Money | 0x25F3 | 0x25EE | 3 | **BCD**, big-endian (e.g. 01 23 45 = ¥12345) |
| Rival name | 0x25F6 | 0x25F1 | 11 / 6 | |
| Options | 0x2601 | 0x25F7 | 1 | bit7 animations off, bit6 battle style Set, bits 4–5 sound (Yellow only, `SOUND_MASK` %110000), text delay in bits 0–2 for R/B (`TEXT_DELAY_MASK` %111) but bits 0–3 for Yellow (`TEXT_DELAY_MASK` %001111) ([red-macros]/pokeyellow `constants/ram_constants.asm`) |
| Badges | 0x2602 | 0x25F8 | 1 | bit per badge |
| Player (trainer) ID | 0x2605 | 0x25FB | 2 | big-endian |
| Pikachu friendship (Yellow) | 0x271C | 0x2712 | 1 | `wPikachuHappiness` |
| Pikachu mood (Yellow) | 0x271D | 0x2713 (derived) | 1 | `wPikachuMood` |
| Surfing-minigame high score (Yellow) | 0x2741 | 0x2737 | 2 | **little-endian BCD** (low byte first). Confirmed: pokeyellow `ram/wram.asm` declares `wSurfingMinigameHiScore:: dw ; little-endian BCD`, and `engine/minigame/surfing_pikachu.asm` `DidPlayerGetAHighScore` compares byte +1 first (the more significant byte). [pkhex] agrees. |
| Printer brightness (Yellow) | 0x2744 | 0x273A | 1 | |
| PC item list | 0x27E6 | 0x27DC | 1 + 50×2 + 1 | |
| **Current box number** | 0x284C | 0x2842 | 1 | bits 0–6 = box index 0–11 (0–7 JP); **bit 7 = "has changed boxes"** ([red-macros] `BIT_HAS_CHANGED_BOXES` = 7, `BOX_NUM_MASK` = 0x7F) |
| Hall of Fame team count | 0x284E | 0x2844 | 1 | |
| Coins | 0x2850 | 0x2846 | 2 | BCD |
| Missable-object flags | 0x2852 | 0x2848 | 32 | 256 flags (`flag_array $100`); current pret calls it `wToggleableObjectFlags` |
| Game progress (event work) | 0x289C | 0x2892 | 0x100 | 0xC8 bytes of per-map script indices (`wGameProgressFlags`..`wGameProgressFlagsEnd`) followed by 0x38 unused bytes (`ds 56`); [pkhex] treats all 0x100 as event work |
| Rival's starter | 0x29C1 | 0x29B7 (derived) | 1 | internal species |
| Player's starter | 0x29C3 | 0x29B9 | 1 | internal species (Yellow detection) |
| Event flags | 0x29F3 | 0x29E9 | 320 | |
| Play time | 0x2CED | 0x2CA0 | 5 | hours(1), maxed flag(1), minutes(1), seconds(1), frames(1) |
| Day Care in use | 0x2CF4 | 0x2CA7 | 1 | 0/1 |
| Day Care nickname, OT, mon | 0x2CF5 / 0x2D00 / 0x2D0B | 0x2CA8 / 0x2CAE / 0x2CB4 (derived) | 11 / 11 / 33 | **nickname, OT, then box struct** (different order from lists) |

### 4.3 Checksums (Gen 1)

Algorithm ([red-save] `CalcCheckSum`): 8-bit sum of the bytes, then bitwise NOT.
`cs = (~(Σ bytes) ) & 0xFF`. Equivalently, start at 0xFF and subtract each byte.

| Checksum | Range (inclusive) | Stored at | Verified by the game? |
|---|---|---|---|
| Main | 0x2598–0x3522 (INT) / 0x2598–0x3593 (JP) | 0x3523 / 0x3594 | **Yes.** `LoadMainData`, `LoadCurrentBoxData` and `LoadPartyAndDexData` all recompute it. On mismatch the game shows "The file data is destroyed!" and there is no CONTINUE. |
| Bank 2 all boxes | 0x4000–0x5A4B | 0x5A4C | **No.** Written only by `CopyBoxToOrFromSRAM` and `EmptySRAMBoxesInBank`. A grep of both pret/pokered and pret/pokeyellow finds no read. |
| Bank 2 per box *i* (0–5) | 0x4000 + i×0x462, length 0x462 | 0x5A4D + i | No |
| Bank 3 all boxes | 0x6000–0x7A4B | 0x7A4C | No |
| Bank 3 per box | 0x6000 + i×0x462 | 0x7A4D + i | No |

[pkhex] only recomputes the main checksum. **Our writer should still recompute the bank and box checksums for INT**: it is cheap, keeps the file pristine, and protects against tools that check them. Whether Pokémon Stadium checks them is UNVERIFIED.

The main checksum covers the player name, main data (Pokédex, money, ID, current-box byte…), sprite data, **party** and the **current box**. It does not cover banks 2/3.

### 4.4 Current-box mechanics (critical)

From [red-save]:
- The current box lives in WRAM (`wBoxDataStart`) and is saved to **bank 1 @0x30C0**. `SaveGameData` writes only bank 1. It never writes the current box's slot in bank 2/3.
- On load, `LoadCurrentBoxData` copies 0x30C0 → WRAM. **The bank-1 copy is authoritative for the current box.** In a save written by the game, the bank-2/3 slot of the current box reads as an **empty list**: `count = 0`, `species[0] = 0xFF`, followed by stale bytes (the box as it was when the player switched to it). If bit 7 of 0x284C is clear, the slot is uninitialised instead. Never read the current box from its slot. The PC's box-count display does the same: `GetMonCountsForAllBoxes` reads every count from SRAM, then overwrites the current box's count from WRAM.
- On "Change Box" (`ChangeBox`, `CopyBoxToOrFromSRAM`), in order: (1) if bit 7 is clear, `EmptyAllSRAMBoxes` (see below); (2) copy WRAM (0x462 bytes) → the old box's slot, mark the WRAM copy empty, and recompute the checksums of the old slot's bank; (3) set `wCurrentBoxNum = new | 0x80`; (4) copy the new box's slot → WRAM, **mark that slot empty** (`count=0, species[0]=0xFF`), and recompute the checksums of its bank; (5) perform a full save (`SaveGameData`, bank 1 only).
- **Gotcha: the first-time wipe.** If bit 7 of `wCurrentBoxNum` is clear, the first box change calls `EmptyAllSRAMBoxes`, which writes `count=0, 0xFF` (only those 2 bytes) to all 12 slots, so anything there is lost, and then recomputes both banks' checksums. A new game never changed boxes, so banks 2/3 hold uninitialised bytes, typically 0x00 or 0xFF (the game's "clear save" option, `ClearAllSRAMBanks`, fills all four banks with 0xFF). While bit 7 is clear the current box index is always 0, because only `ChangeBox` writes it. Therefore:
  - When reading: if bit 7 is clear, treat every non-current box as empty. [pkhex] does the same and calls it `BoxesInitialized`.
  - When writing into a non-current box: first initialise all 12 slots as empty lists (except the slot of the current box, which is regenerated anyway), then write, **set bit 7**, and recompute the bank checksums and the main checksum. [pkhex] sets `BoxesInitialized` automatically when any non-current box has content.
- Recommended writer behaviour: when the current box changes, write it to 0x30C0 and also mirror it into its own bank slot, as [pkhex] does. The mirror is harmless and keeps every copy consistent.

### 4.5 Pokémon lists (party and boxes, both generations)

One format serves every party and box ([red-wram] / [c-macros] `box` macro; [pkhex] PokeList1/2):

```
u8   count                           (number of Pokémon)
u8   species[capacity + 1]           species[count] = 0xFF terminator; bytes after it are stale/ignored
T    mons[capacity]                  T = party struct (44/48) or box struct (33/32)
u8   ot_names[capacity][NL]          NL = 11 INT, 6 JP
u8   nicknames[capacity][NL]
(Gen 2 boxes only: 2 padding bytes after the list; the game writes FF 00 into them on erase, [gs-save] EraseBoxes)
```

| List | Gen 1 INT | Gen 1 JP | Gen 2 INT/KOR | Gen 2 JP |
|---|---|---|---|---|
| Party (cap 6) | 1+7+6×44+6×11+6×11 = **0x194** | 1+7+264+36+36 = **0x158** | 1+7+6×48+66+66 = **0x1AC** | 1+7+288+36+36 = **0x170** |
| Box | cap 20: 1+21+20×33+220+220 = **0x462** | cap 30: 1+31+990+180+180 = **0x566** | cap 20: 1+21+640+220+220 = **0x44E** (+2 pad) | cap 30: 1+31+960+180+180 = **0x548** (+2 pad) |

Party lists always hold **party structs**, and box lists hold **box structs**. The Gen 2 egg marker is covered in §5.8.

**Removal** (the game's algorithm, [c-move] `RemoveMonFromPartyOrBox`; Gen 1 is equivalent): with `n = count` and index `i`:
1. `count = n − 1`.
2. Shift `species[i+1 ..= n]` (including the 0xFF terminator) down one place.
3. Shift `ot_names[i+1 .. n−1]`, `mons[i+1 .. n−1]` and `nicknames[i+1 .. n−1]` down one place. The game leaves the now-unused last slot stale; we should zero it (or fill it with 0xFF / 0x50) for determinism.
4. Gen 2 party only: shift party mail `i+1 .. n−1` down one place. The game itself shifts only the primary `sPartyMail` (0x0600); the backup (0x071A) is overwritten from the primary at the next save (`BackupPartyMonMail`, called at the end of `_SaveGameData`). Because the game copies backup → primary on load, **a writer must shift both copies** (§5.6).

(The game's shift actually copies everything up to the end of the capacity, so the last slot ends up as a duplicate of the one before it. If the removed index is the last slot of the capacity, it skips the shift and writes 0xFF into the first byte of that slot's OT name. Only the result for slots `0 .. count−1` matters.)

**Insertion**: the game only appends. Write at index `n`, set `species[n] = marker`, `species[n+1] = 0xFF`, and `count = n + 1`. When inserting into a party, write a full party struct with recomputed stats. When inserting into a box, write a box struct, plus (Gen 1) the box-level byte = level.

### 4.6 Yellow specifics

- Starter Pikachu: Oak gives it with **catch rate byte 0xA3** (`LIGHT_BALL_GSC`), so it holds a Light Ball when it reaches Gen 2 ([yel-src] `scripts/OaksLab.asm`; [pkhex] PK1 treats 0xA3 on Pikachu as legitimate).
- Every Kadabra created by `_AddPartyMon` (catches, gifts, in-game trades) or by `SendNewMonToBox` gets **catch rate 0x60** (`TWISTEDSPOON_GSC`) ([yel-src] `engine/pokemon/add_mon.asm`, `engine/items/item_effects.asm`). Yellow has no Kadabra in-game trade (`data/events/trades.asm`); `in_game_trades.asm` only mentions Kadabra in its trade-evolution check. Evolution does not touch the byte, so an Abra that evolves keeps Abra's catch rate (UNVERIFIED by a code read of the evolution routine).
- Yellow changed two base catch rates: Dragonair 27 and Dragonite 9 (R/B: both 45) ([yel-src] base_stats, diffed against pokered). A legality checker must accept the R/B and the Y values.
- "The" starter Pikachu is identified dynamically: species is Pikachu, OT ID == player ID, and the first 5 bytes of the OT name equal the player name ([yel-src] `IsThisMonStarterPikachu`). There is no flag in the struct. Its friendship and mood live in the **save** (0x271C/0x271D), not in the Pokémon. Consequences:
  - Moving the starter out through our Home loses the friendship value unless we capture it as metadata.
  - Any Pikachu with the player's OT name and ID that is withdrawn into that same Yellow save is treated as the starter.

### 4.7 Gen 1 checklist: what to update after modifying party, boxes or Pokédex

1. Rewrite the list(s): count, species list plus 0xFF terminator, structs, OT names, nicknames (§4.5).
2. Party structs: level @0x21 and stats @0x22–0x2B consistent with EXP, DVs and stat exp (§7.4). Current HP ≤ max HP. Box struct: box level @0x03 = level.
3. Set Pokédex **owned and seen** bits for the species' Dex number (both arrays are inside main data). A trade sets them.
4. Non-current box written: initialise slots if needed, set bit 7 @0x284C, recompute the per-box and bank checksums (INT).
5. Current box written: write bank 1 @0x30C0 (authoritative) and mirror it into its slot.
6. Recompute the main checksum @0x3523 **last**.
7. Do not leave the party empty. The game refuses to deposit your last Pokémon, and an empty party after the starter breaks game logic.

---

## 5. Generation 2 (Gold, Silver, Crystal)

### 5.1 SRAM map, international ([gs-sram], [c-sram], [gs-sym], [c-sym])

| Region | GS INT | Crystal INT | Notes |
|---|---|---|---|
| Scratch / decompression | 0x0000–0x05FF | 0x0000–0x05FF | ignore |
| Party mail (6 × 0x2F) | 0x0600 | 0x0600 | `sPartyMail` |
| Party mail **backup** | 0x071A | 0x071A | `sPartyMailBackup` |
| Mailbox count + 10 × 0x2F | 0x0834 / 0x0835 | same | |
| Mailbox backup | 0x0A0B / 0x0A0C | same | |
| Mystery Gift block | 0x0BE2–0x0C2F | same | item @0x0BE2, unlocked @0x0BE3 (0xFF = locked, [pkhex]), backup item @0x0BE4, partner count/IDs @0x0BE5/0x0BE6, decorations received @0x0BF0, timer @0x0BFA, partner name @0x0BFE, trainer @0x0C0A. 0x0BE5 doubles as the backup of "unlocked": `BackupMysteryGift` copies 0x0BE2→0x0BE4 and 0x0BE3→0x0BE5 on save, and `RestoreMysteryGift` copies them back on load ([c-save]-adjacent `engine/link/mystery_gift.asm`) |
| RTC status flags | 0x0C60 | 0x0C60 | `sRTCStatusFlags`: bit7 `RTC_RESET`, bit6 days>255, bit5 days>139 ([c-macros] ram_constants) |
| Lucky number day / ID | 0x0C68 / 0x0C69 | same | |
| **Backup game data** | split, see §5.3 | **0x1200** options (8), 0x1208 check 0x63, **0x1209–0x1D82** game data, 0x1F0D checksum (u16le), 0x1F0F check 0x7F | |
| Options | 0x2000 (8 bytes) | 0x2000 | outside the checksum |
| Check value 1 (0x63) | 0x2008 | 0x2008 | |
| **Primary game data** | **0x2009–0x2D68** (0xD60 bytes) | **0x2009–0x2B82** (0xB7A) | `sPlayerData`, `sCurMapData`, `sPokemonData` |
| Primary checksum (u16 **LE**) | **0x2D69** | **0x2D0D** | Crystal has 0x18A unused bytes between the data end and the checksum |
| Check value 2 (0x7F) | 0x2D6B | 0x2D0F | |
| **Current box mirror `sBox`** | 0x2D6C (0x44E bytes) | 0x2D10 | **not covered by any checksum** |
| Link battle stats (wins/losses/draws u16 each, then 5 records) | 0x31BA (records @0x31C0) | 0x3260 (records @0x3266) | Crystal has 2 padding bytes after `sBox` plus `ds $100` before this |
| Hall of Fame (30 × 0x62) | 0x321A–0x3D95 | 0x32C0–0x3E3B | |
| GS backup piece 2 | **0x3D96–0x3F3F** | — | |
| Crystal: GS Ball flag / `sCrystalData` / GS Ball backup | — | 0x3E3C / **0x3E3D** (7 bytes: player gender + mobile profile) / 0x3E44 | gender = bit 0 of 0x3E3D (1 = female). [pkhex] also mirrors it into the player palette @0x206A. |
| Crystal Battle Tower | — | 0x3E45– | |
| Boxes 1–7 (stride 0x450) | 0x4000, 0x4450, 0x48A0, 0x4CF0, 0x5140, 0x5590, 0x59E0 | same | list 0x44E + 2 pad |
| Boxes 8–14 | 0x6000, 0x6450, 0x68A0, 0x6CF0, 0x7140, 0x7590, 0x79E0 | same | box 14 ends at 0x7E2D |
| GS backup options / check1 / map data / checksum / check2 | 0x7E30 / 0x7E38 / 0x7E39–0x7E6C / **0x7E6D** / 0x7E6F | — | |

### 5.2 Primary vs backup: what the game does on load ([gs-save]/[c-save] `TryLoadSaveFile`, `TryLoadSaveData`)

1. Title screen: if the primary check bytes (0x2008 == 0x63 and 0x2D6B/0x2D0F == 0x7F) are present, a save "exists" and options come from 0x2000. Otherwise the game tries the backup check bytes. If both are missing, the game behaves as if there is no save.
2. CONTINUE: compute the primary checksum. **If it matches**, load the primary data, load the current box from its bank slot (step 3), restore party mail **and the PC mailbox** from their backup copies (`RestorePartyMonMail` copies 0x071A→0x0600 (6 × 0x2F) and 0x0A0B→0x0834 (1 + 10 × 0x2F)), restore the Mystery Gift item and unlocked byte (0x0BE4/0x0BE5 → 0x0BE2/0x0BE3), in Crystal also restore the GS Ball flag (0x3E44 → 0x3E3C), and then **rewrite the backup from the primary**. **If it fails**, verify the backup checksum. If that matches, load from the backup and rewrite the primary. If both fail, show "The save file is corrupted" and refuse to continue.
3. `LoadBox` copies box `wCurBox` from **its slot in bank 2/3 into `sBox`**. The save routine (`_SaveGameData`) calls `SaveBox`, which copies `sBox` back into that slot, then writes the primary and backup copies and their checksums.

Consequences for the writer:
- The **bank-2/3 slot is authoritative for every box, including the current one**. `sBox` is a working mirror that is overwritten on load. [pkhex] reads all boxes from banks 2/3 and adds: "Stadium ignores [the CurrentBox segment] and will de-synchronize it… When exporting… re-synchronize."
- Always write a box change to its **slot**. If it is the current box, write `sBox` as well.
- Write **both** game-data copies and **both** checksums. Writing only the primary would also work (a valid primary wins and refreshes the backup), but then a later corruption of the primary would fall back to stale data.
- Party mail and mailbox: on load the game copies **backup → primary**, so the backups (0x071A, 0x0A0B) are the copies that matter. Write both. On save, `BackupPartyMonMail` copies primary → backup for both areas.

### 5.3 Checksums and the backup layout

Algorithm ([gs-save] `Checksum`): a 16-bit wrapping sum of the bytes, **stored little-endian** (low byte first). There is no inversion.

**Crystal INT**: primary Σ 0x2009..0x2B82 → u16le @0x2D0D. Backup = a byte-identical copy of 0x2009..0x2B82 placed at 0x1209..0x1D82 (offset −0xE00), Σ → u16le @0x1F0D. Options are copied to 0x1200..0x1207 and are not checksummed. Check bytes are at 0x1208 and 0x1F0F.

**GS INT**: primary Σ 0x2009..0x2D68 → u16le @0x2D69. The backup is **split into 5 pieces** ([gs-sram] "Backup Save 1/2/3"; [gs-save] SaveBackupPlayerData; matches [bulba-s2]):

| Primary range | Size | Backup at | Piece |
|---|---|---|---|
| 0x2009–0x222E | 0x226 | **0x15C7–0x17EC** | wPlayerData1 |
| 0x222F–0x23D8 | 0x1AA | **0x3D96–0x3F3F** | wPlayerData2 |
| 0x23D9–0x2855 | 0x47D | **0x0C6B–0x10E7** | wPlayerData3 |
| 0x2856–0x2889 | 0x34 | **0x7E39–0x7E6C** | wCurMapData |
| 0x288A–0x2D68 | 0x4DF | **0x10E8–0x15C6** | wPokemonData |

Backup checksum = Σ over the five backup pieces, mod 0x10000, stored u16le @0x7E6D. Backup options go to 0x7E30..0x7E37, check bytes to 0x7E38 and 0x7E6F. Because the pieces are copies, the backup checksum equals the primary checksum when the data agree.

> **Discrepancy:** [pkhex] (master @ a9ff306570, `SAV2.GetFinalData`) copies piece 2 to **0x3D69**. pret's linked symbol `sBackupPlayerData2` = 01:BD96 → **0x3D96**, and [bulba-s2] also says 0x3D96. 0x3D69 lies inside the Hall of Fame (0x321A–0x3D95), so PKHeX overwrites the last 0x2D HoF bytes and leaves the real piece stale. We believe **0x3D96**: pret's build is byte-exact, and [gs-save] addresses SRAM through these symbols. Do not copy PKHeX's offset.

**GS JP** ([pkhex], [bulba-s2]): primary Σ 0x2009..0x2C8B → u16le @0x2D0D. The backup is contiguous: 0xC83 bytes copied to 0x7209..0x7E8B, Σ → @0x7F0D. Single source for the exact pieces.

**Crystal JP** ([pkhex], [bulba-s2]): primary Σ 0x2009..0x2AE2 (0xADA bytes) → @0x2D0D; backup copy 0x7209.., Σ 0x7209..0x7CE2 → @0x7F0D. [bulba-s2] says the JP Crystal backup "partition" spans 0x7209..0x7D3A while only 0xADA bytes are checksummed. That would mean the last 0x58 bytes of JP game data are not checksummed. This is **UNVERIFIED**, but harmless if we copy the full 0xB32 bytes. Copying only 0xADA bytes also matches [pkhex].

**GS KOR** ([pkhex] only): primary Σ 0x2009..0x2DAA → u16le @0x2DAB. Checksum 2 @0x7E6B = Σ of the backup ranges 0x106B–0x1532, 0x1534–0x1A11, 0x1A13–0x1C37, 0x3DD8–0x3F78, 0x7E39–0x7E69 (end-exclusive in PKHeX: 0x1533, 0x1A12, 0x1C38, 0x3F79, 0x7E6A). PKHeX does **not** write Korean backup data. It only recomputes checksum 2 over whatever is there. **UNVERIFIED.** Treat Korean as read-only at first. Warning sign: the five ranges total 0xD9D bytes (0x4C8 + 0x4DE + 0x225 + 0x1A1 + 0x31), but the primary range 0x2009..0x2DAA is 0xDA2 bytes. Unlike GS INT, where the five pieces add up exactly to the primary, checksum 2 here cannot be a sum over a byte-identical copy of the primary. Either the Korean backup is laid out differently or PKHeX's ranges are off by one at the gaps (it skips the single bytes 0x1533 and 0x1A12). Do not write Korean saves until a real save resolves this.

### 5.4 Field offsets (primary copy; from [gs-sym]/[c-sym], cross-checked against [pkhex] SAV2Offsets)

Backup offset of any field: Crystal INT = primary − 0xE00. GS INT = use the piece table in §5.3 (for example Pokédex caught 0x2A4C → 0x12AA). JP = primary + 0x5200.

| Field | GS INT | Crystal INT | GS JP ([pkhex]) | Crystal JP ([pkhex]) | GS KOR ([pkhex]) | Size / format |
|---|---|---|---|---|---|---|
| Options | 0x2000 | 0x2000 | 0x2000 | 0x2000 | 0x2000 | 8 bytes. Byte 0 (`wOptions`): bit7 battle scene off, bit6 Set style, **bit5 stereo**, **bit4 no-text-scroll** (`SaveOptions` clears it in the primary copy), bits 0–2 text delay (1/3/5; other values are reset on load by `CheckTextDelay`). Byte 1: save-file-exists flag; byte 2: textbox frame (bits 0–2); byte 3: textbox flags; byte 4: printer brightness; byte 5: `wOptions2` (menu account); bytes 6–7 unused ([c-macros] `ram/wram.asm`, `constants/ram_constants.asm`) |
| Player ID | 0x2009 | 0x2009 | 0x2009 | 0x2009 | 0x2009 | u16 BE |
| Player name | 0x200B | 0x200B | 0x200B | 0x200B | 0x200B | 11 / 6 / 11 |
| Mom's name | 0x2016 | 0x2016 | 0x2011 ([bulba-s2]) | 0x2011 | — | |
| Rival name | 0x2021 | 0x2021 | 0x2017 | 0x2017 | 0x2021 | |
| Red's / Green's name | 0x202C / 0x2037 | same | — | — | — | |
| Saved-at-least-once flag | 0x2042 | 0x2042 | — | — | — | `wSavedAtLeastOnce` (see the DST discrepancy in §14) |
| RTC start day/h/m/s | 0x2044–0x2047 | same | — | — | — | `wStartDay`… |
| wRTC snapshot | 0x2048 (4) | 0x2048 | — | — | — | |
| DST flag | 0x2050 (bit 7) | 0x2050 | — | — | — | `wDST` |
| Game-time cap flag | 0x2052 | 0x2051 | 0x2033 (derived) | 0x2033 if [pkhex] is right, 0x2034 if [bulba-s2] is right (UNVERIFIED) | 0x204C (derived) | the byte just before the hours in every INT layout |
| Play time | 0x2053 | **0x2052** | 0x2034 | 0x2034 ([pkhex]; [bulba-s2] says 0x2035, UNVERIFIED) | 0x204D | **hours u16 BE**, minutes u8, seconds u8, frames u8. Caps at 999:59:59 ([c-dv] `home/game_time.asm`) |
| Player palette | 0x206B | 0x206A | 0x204C | 0x204C | 0x2065 | 0 boy / 1 girl |
| Secret ID (Crystal, mobile only) | — | 0x23D8 | — | — | — | u16. Not used by Pokémon. |
| Money | 0x23DB | 0x23DC | 0x23BC | 0x23BE | 0x23D3 | 3 bytes **binary** big-endian (not BCD) |
| Mom's money | +3 | +3 | | | | 3 bytes |
| Coins | 0x23E2 | 0x23E3 | Money+7 | Money+7 | Money+7 | u16 BE |
| Johto / Kanto badges | 0x23E4 / 0x23E5 | 0x23E5 / 0x23E6 | 0x23C5 | 0x23C7 | 0x23DC | bit per badge |
| TM/HM pocket | 0x23E6 | 0x23E7 | 0x23C7 | 0x23C9 | 0x23DE | 50 + 7 quantities |
| Items / Key / Balls / PC items | 0x241F / 0x2449 / 0x2464 / 0x247E | 0x2420 / 0x244A / 0x2465 / 0x247F | 0x2400 / 0x242A / 0x2445 / 0x245F | 0x2402 / 0x242C / 0x2447 / 0x2461 | 0x2417 / 0x2441 / 0x245C / 0x2476 | count, pairs, 0xFF (key items: IDs only) |
| Event flags | 0x261F | 0x2600 | 0x2600 | 0x25E2 | 0x25F7 | 2000 flags. [pkhex] uses CurrentBoxIndex − 0x105 for GS and − 0x100 for C. |
| **Current box index** | **0x2724** | **0x2700** | 0x2705 | 0x26E2 | 0x26FC | u8, 0–13 (0–8 JP). Out-of-range values are reset to 0 ([gs-save] GetBoxAddress). No "initialised" bit in Gen 2. |
| **Box names** | 0x2727 | 0x2703 | 0x2708 | 0x26E5 | 0x26FF | 14 × 9 bytes (8 chars + 0x50). KOR: 17 bytes each ([pkhex]) |
| Blue Card points (C) | — | 0x27D9 | — | 0x278E | — | |
| Map group / number / Y / X | 0x2868 / 0x2869 / 0x286A / 0x286B | 0x2843 / 0x2844 / 0x2845 / 0x2846 | | | | |
| **Party list** | **0x288A** | **0x2865** | 0x283E | 0x281A | 0x28CC | §4.5 (0x1AC INT, 0x170 JP) |
| **Pokédex caught** | **0x2A4C** | **0x2A27** | 0x29CE | 0x29AA | 0x2A8E | 32 bytes, bit (dex−1), LSB first |
| **Pokédex seen** | **0x2A6C** | **0x2A47** | 0x29EE | 0x29CA | 0x2AAE | 32 bytes |
| Unown Dex (letters, in order seen) | 0x2A8C | 0x2A67 | seen+0x20 | seen+0x20 | seen+0x20 | 26 bytes, values 1–26, 0 = empty |
| Unlocked Unown groups | 0x2AA6 | 0x2A81 | seen+0x3A | | | bits 0–3: A–K, L–R, S–W, X–Z ([pkhex]) |
| First Unown seen | 0x2AA7 | 0x2A82 | seen+0x3B | | | letter 1–26, picks the Pokédex sprite |
| Day Care | 0x2AA8 | 0x2A83 | seen+0x3C | | | §5.8 |
| Roaming mons (3 × 7) | 0x2B82 | 0x2B5D | | | | |
| `sBox` current-box mirror | 0x2D6C | 0x2D10 | 0x2D10 | 0x2D10 | 0x2DAE | |

GS `wPokemonData` (0x288A–0x2D68) ends with **449 bytes (0x2BA8–0x2D68)** of link-session scratch after the Magikarp record. pokegold `ram/wram.asm` says "This union spans 451 bytes", but `wPokemonDataEnd` sits inside the union's last member (DF01), while `wLinkReceivedPartyEnd` is at DF02. So only 449 of the 451 bytes (`wLinkReceivedPartyData` DD40 → DF01) are saved and checksummed ([gs-sym]). Copy them verbatim. Crystal's `wPokemonData` ends right after the Magikarp record name (0x2B78 + 11 = 0x2B83) and has no such scratch.

Gen 2 JP boxes ([pkhex]; [oracle] confirmed that box 9 is in bank 3): 0x4000, 0x454A, 0x4A94, 0x4FDE, 0x5528, 0x5A72 | 0x6000, 0x654A, 0x6A94.

### 5.5 Boxes (Gen 2)

- 14 boxes × 20 slots (INT/KOR) or 9 × 30 (JP). Lists as in §4.5, followed by 2 padding bytes.
- **No box checksums exist** in Gen 2.
- An empty box is `count = 0, species[0] = 0xFF`. When the game erases boxes (on the first save of a new file, [gs-save] `ErasePreviousSave` → `EraseBoxes`), it zero-fills the rest and writes `FF 00` into the 2 padding bytes. All 14 slots are therefore valid after the first save.
- Pokémon holding Mail cannot be in a box. The game refuses to deposit them, so strip mail or refuse the request.
- Box names: default "BOX1"…"BOX14" (any 0x50-terminated string of up to 8 chars).

### 5.6 Mail ([c-sram] `mailmsg` macro, [c-macros] `MAIL_STRUCT_LENGTH` = 0x2F, `MAIL_STRUCT_LENGTH_JP` = 0x2A; [pkhex] Mail2: KOR 0x4F)

INT mail struct (0x2F): line 1 (16 chars) @0x00, line break byte @0x10 (0x4E `<NEXT>`), line 2 (16) @0x11, author field @0x21–0x2A, author ID u16 @0x2B, species @0x2D (the mail-picture species), mail item @0x2E. The JP struct has no nationality field and a 5-char author (0x2A bytes total).
- The 10-byte author field is defined differently per game. pret's Crystal `mailmsg` macro splits it into author name (8 = `PLAYER_NAME_LENGTH`) @0x21 plus "nationality" (2) @0x29. pret's (English) Gold/Silver macro has a 10-byte author (`NAME_LENGTH − 1`) and no nationality field. [pkhex] uses the Crystal split for all INT saves. Both English games build mail the same way (`ComposeMailMessage` copies `NAME_LENGTH − 1` = 10 bytes of `wPlayerName`), so in English mail bytes 0x29–0x2A are just player-name padding.
- Crystal reads the nationality pair to choose a font and a link conversion: `'E'` (0x84) followed by `'F'`, `'G'`, `'I'` or `'S'` selects French/German/Italian/Spanish; anything else is English (pokecrystal `engine/pokemon/european_mail.asm` `ParseMailLanguage`; `ConvertEnglishMailToFrenchGerman` and similar routines are called from `engine/link/link.asm`). Which European builds write those letters is UNVERIFIED. Keep all 0x2F bytes opaque.
- Party mail slot *i* belongs to party slot *i*, for 6 slots @0x0600 + i×0x2F, and is used only when that Pokémon holds a mail item: 0x9E FLOWER_MAIL, 0xB5 SURF_MAIL, 0xB6 LITEBLUEMAIL, 0xB7 PORTRAITMAIL, 0xB8 LOVELY_MAIL, 0xB9 EON_MAIL, 0xBA MORPH_MAIL, 0xBB BLUESKY_MAIL, 0xBC MUSIC_MAIL, 0xBD MIRAGE_MAIL ([c-mail] `mail_items.asm`).
- **Backup @0x071A + i×0x2F is restored over the primary on every load** ([c-mail] `RestorePartyMonMail`, which also restores the mailbox from 0x0A0B). Write both copies, and shift both when party order changes. (In-game, `RemoveMonFromPartyOrBox` shifts only the primary, and `BackupPartyMonMail` re-syncs the backup at save time.)
- Store mail as raw bytes alongside the Pokémon in Home. Time Capsule trades refuse Pokémon holding mail ([c-link] `CheckTimeCapsuleCompatibility`). The mail text encoding has language quirks: [pkhex] has special handling for English GS mail (`Mail2.EnglishGS`), and Crystal's link code converts European mail character sets (see above). Details beyond that are UNVERIFIED, so keep the bytes opaque.

### 5.7 Pokédex and Unown Dex (Gen 2)

- Set caught and seen bit `(dex−1)` in the 32-byte arrays. The game does not register eggs; registration happens at hatch ([c-move] `AddTempmonToParty` skips `SetSeenAndCaughtMon` when the species is EGG; [pkhex] `SetDex` skips eggs too).
- **Unown**: when receiving one, compute its letter (§7.3) and append it to the Unown Dex if it is absent (first 0 slot, [c-dv] `UpdateUnownDex`). If First Unown Seen == 0, set it to the letter ([c-move] lines after `UpdateUnownDex`). [pkhex] warns that caught-Unown without Unown-Dex entries can crash the Pokédex view; PKHeX fills all 26 when it sets Unown caught. We should do the minimal correct update instead.

### 5.8 Eggs and the Day Care

- An egg is marked **only** by the list species byte **0xFD** (`EGG`, [c-macros] pokemon_constants). The struct's species byte holds the real species. Valid in party and boxes ([pkhex] PokeList2 `SlotEgg = 0xFD`).
- Egg struct fields as created by the Day Care ([c-dv] `daycare.asm`): level = 5 (`EGG_LEVEL`); **friendship byte = remaining egg cycles** (initialised to the species' base "step cycles to hatch", e.g. Togepi 10, Cyndaquil 20); Pokérus 0; caught data 0; nickname "EGG" (`EGG@`), JP タマゴ; OT = player.
- Day Care block (INT GS @0x2AA8, C @0x2A83, 0x3C past Pokédex seen in all layouts): Day-Care-Man flags u8 (bit7 active, bit6 egg ready, bit5 compatible, bit0 mon 1 present); mon 1 = nickname(11) + OT(11) + box struct(32); Day-Care-Lady flags u8 (bit0 present); steps-to-egg u8; "mother or non-Ditto" u8; mon 2 = nickname + OT + box struct; egg = nickname + OT + box struct ([c-sram] wram; [pkhex] `GetRawDaycareSlotOffset`). Order: **nickname, OT, data**. Read-only for the widget.

### 5.9 Crystal-only and other areas we leave alone

Crystal-only areas: `sCrystalData` (gender at 0x3E3D), the GS Ball flags at 0x3E3C/0x3E44, the Battle Tower state at 0x3E45+, and in JP the mobile banks 4–7 (gender at 0x8000, GS Ball at 0xA000/0xA083, Mobile Adapter cable color at 0xE800 with complement at 0x9000). Mystery Gift exists in both GS and Crystal at the same offsets. We read player gender (Crystal) for display and leave everything else untouched.

### 5.10 Gen 2 checklist: what to update after modifying party, boxes or Pokédex

1. Lists: count, species list (0xFD for eggs) plus 0xFF, structs, OT names, nicknames.
2. Party structs: level @0x1F and stats @0x24–0x2F consistent; current HP ≤ max. Box structs keep level @0x1F.
3. Party mail: write, shift or clear entries in both 0x0600 and 0x071A. Never put a mail holder in a box.
4. Pokédex caught+seen (not for eggs). Unown Dex and First Unown Seen for Unown.
5. Box changes: write the **slot in bank 2/3**. If `box == current box index`, copy the same bytes to `sBox`.
6. Recompute the primary checksum. Copy the game data to the backup location(s), recompute the backup checksum, and keep check bytes 0x63/0x7F in both copies.
7. Preserve every byte outside the regions we edit, including RTC fields, `sRTCStatusFlags` and the emulator footer.

---

## 6. The Pokémon structures

No encryption, no block shuffling, no per-Pokémon checksum, no PID. Gen 1/2 have no nature, ability, ball, Secret ID, language byte, ribbons or markings. Gen 1 and Gen 2 have no gender field and no shininess field: both are derived from DVs (§7). Multi-byte values are big-endian.

### 6.1 Gen 1 struct ([red-macros] `box_struct`/`party_struct`; [pkhex] PK1; [bulba-p1])

| Off | Size | Field | Notes |
|---|---|---|---|
| 0x00 | 1 | species | **internal index** (§9.1) |
| 0x01 | 2 | current HP | persists in boxes (Gen 1 does not heal on deposit) |
| 0x03 | 1 | box level | written = party level on deposit; the PC shows it |
| 0x04 | 1 | status | bits 0–2 sleep turns, bit3 PSN (0x08), bit4 BRN (0x10), bit5 FRZ (0x20), bit6 PAR (0x40) ([red-macros] battle_constants) |
| 0x05 | 1 | type 1 | Gen 1 type IDs: NORMAL 00, FIGHTING 01, FLYING 02, POISON 03, GROUND 04, ROCK 05, (BIRD 06 unused), BUG 07, GHOST 08, FIRE 14, WATER 15, GRASS 16, ELECTRIC 17, PSYCHIC 18, ICE 19, DRAGON 1A |
| 0x06 | 1 | type 2 | = type 1 for single-type species. **Must equal the species' base types**, or a Time Capsule trade is rejected as "abnormal" (Magnemite and Magneton are exempt) ([c-link] `ValidateOTTrademon`) |
| 0x07 | 1 | catch rate / Gen 2 held item | §8 |
| 0x08 | 4 | moves 1–4 | move IDs 1–165 (0xA5 STRUGGLE max), 0 = empty |
| 0x0C | 2 | OT ID | |
| 0x0E | 3 | EXP | 24-bit BE |
| 0x11 | 2×5 | stat exp HP, Atk, Def, Spd, Spc | u16 each, 0–65535 |
| 0x1B | 2 | DVs | byte 0 = Atk<<4 \| Def, byte 1 = Spd<<4 \| Spc |
| 0x1D | 4 | PP 1–4 | bits 7–6 PP Ups used, bits 5–0 current PP |
| *(box struct ends at 0x21 = 33 bytes)* | | | |
| 0x21 | 1 | level | |
| 0x22 | 2×5 | max HP, Atk, Def, Spd, Spc | recomputed by the game on withdraw ([red-addmon] `_MoveMon`) |

On withdraw (box or Day Care → party), Gen 1 `_MoveMon` derives the party level **from EXP** (`CalcLevelFromExperience`), not from the box-level byte, and recomputes all five stats with stat exp. It copies current HP and status verbatim. EXP is therefore the authoritative level source, and the box-level byte is only what the PC shows.

### 6.2 Gen 2 struct ([c-macros] `box_struct`/`party_struct`; [pkhex] PK2; [bulba-p2])

| Off | Size | Field | Notes |
|---|---|---|---|
| 0x00 | 1 | species | National Dex 1–251 (the list byte is 0xFD for eggs) |
| 0x01 | 1 | held item | Gen 2 item index |
| 0x02 | 4 | moves | 1–251 (0xFB BEAT_UP max) |
| 0x06 | 2 | OT ID | |
| 0x08 | 3 | EXP | |
| 0x0B | 2×5 | stat exp HP, Atk, Def, Spd, **Spc** | Special stat exp is used for both SpA and SpD |
| 0x15 | 2 | DVs | as in Gen 1 |
| 0x17 | 4 | PP | as in Gen 1 |
| 0x1B | 1 | friendship / egg cycles | traded-in Pokémon get 70 (`BASE_HAPPINESS`) ([c-move] `AddTempmonToParty`) |
| 0x1C | 1 | Pokérus | high nibble = strain, low nibble = days remaining (cured: strain ≠ 0, days = 0) |
| 0x1D | 2 | caught data (Crystal) | byte 0x1D: bits 7–6 time of day (1 morning, 2 day, 3 night; stored as `wTimeOfDay + 1`), bits 5–0 met level (1 = hatched). Byte 0x1E: bit 7 OT gender (1 = female), bits 6–0 location (landmark ID; 0x7E = gift, 0x7F = event). GS writes 00 00 (named `Unused1/2` in [gs-save] macros) and keeps whatever it receives. Example: day, level 5, female OT, New Bark Town = `85 81` ([bulba-p2]; [c-dv] caught_data.asm) |
| 0x1F | 1 | level | |
| *(box struct ends at 0x20 = 32 bytes)* | | | |
| 0x20 | 1 | status | same bits as Gen 1 |
| 0x21 | 1 | unused | |
| 0x22 | 2 | current HP | |
| 0x24 | 2×6 | max HP, Atk, Def, Spd, SpA, SpD | |

On withdraw (box → party), Gen 2 `SendGetMonIntoFromBox` also recomputes the level from EXP (`CalcLevel`, which overwrites 0x1F) and recomputes the stats. It then **heals**: status = 0 and current HP = max HP, or HP = 0 for an egg. On deposit it restores every move's PP to the maximum, keeping the PP-Up bits (`RestorePPOfDepositedPokemon`) ([c-move]).

---

## 7. Derived fields

### 7.1 DVs and HP DV
`atk = dv0 >> 4`, `def = dv0 & 15`, `spd = dv1 >> 4`, `spc = dv1 & 15`.
`hp = ((atk & 1) << 3) | ((def & 1) << 2) | ((spd & 1) << 1) | (spc & 1)` ([c-move] `CalcMonStatC`).

### 7.2 Shiny and gender (Gen 2 rules; apply them to Gen 1 Pokémon viewed in Gen 2)
- **Shiny** iff `def == 10 && spd == 10 && spc == 10 && (atk & 2) != 0`, i.e. atk ∈ {2,3,6,7,10,11,14,15} ([c-dv] color.asm `SHINY_ATK_MASK = %0010`, `SHINY_*_DV = 10`).
- **Gender**: `x = (atk << 4) | spd` (but see the last bullet). Base ratio values: F0 = 0 (always male), F12.5 = 31, F25 = 63, F50 = 127, F75 = 191, F100 = 254 (always female), 255 = genderless ([c-macros] `percent` = ×255/100). Female iff `x ≤ ratio`, male otherwise ([c-dv] `GetGender`).
- Because every ratio has low nibble F, the speed DV never matters in practice. The rule is equivalent to "female iff atk ≤ (ratio >> 4)", which is how [pkhex] states it.

### 7.3 Unown letter ([c-dv] `GetUnownLetter`)
`v = ((atk & 6) << 5) | ((def & 6) << 3) | ((spd & 6) << 1) | ((spc & 6) >> 1)`. The letter is `floor(v / 10) + 1` (1 = A … 26 = Z). [pkhex] Form = `floor(v/10)`, 0-based. [oracle]: DVs 0x5BE7 → v = 159 → letter 16 = P; PKHeX reports form 15.

### 7.4 Stats, EXP, PP (Gen 1 and Gen 2 share the formula; [c-move] `CalcMonStatC`)
- `e = floor(ceil_sqrt_capped(statExp) / 4)`, where `ceil_sqrt_capped(x)` = the smallest n with n² ≥ x, capped at 255.
- `stat = floor(((base + dv) × 2 + e) × level / 100) + 5`. For HP use `+ level + 10` instead of `+ 5`. Cap at 999.
- Gen 2 SpA and SpD both use the Special DV and Special stat exp with their own base stats. Gen 1 "Special" uses the Gen 1 base Special (on Gen2→Gen1 transfer the game uses its `KantoMonSpecials` table, [c-link]).
- EXP for level n by growth rate ([red-macros] `data/growth_rates.asm`, `a/b·n³ + c·n² + d·n − e`): Medium Fast n³; Slightly Fast ¾n³+10n²−30 (unused); Slightly Slow ¾n³+20n²−70 (unused); Medium Slow 6/5·n³ − 15n² + 100n − 140; Fast 4/5·n³; Slow 5/4·n³. Base growth rates are in `data/pokemon/base_stats/*.asm`.
- Max PP = base PP + ups × min(7, floor(base / 5)) ([pkhex] GBPKM).
- Hidden Power (Gen 2) is derived from DVs; see [pkhex] `HiddenPower.GetTypeGB` for the rule (not needed for storage).

---

## 8. The catch-rate byte and Gen1↔Gen2 conversion (Time Capsule semantics)

What happens in the real Time Capsule ([c-link] `Link_ConvertPartyStruct1to2`, `Link_PrepPartyData_Gen1`, `TimeCapsule_ReplaceTeruSama`, `CheckTimeCapsuleCompatibility`):

**Gen 1 → Gen 2**
- species: internal → National Dex.
- HP and status copied. The box-level byte is dropped.
- held item = catch-rate byte, **except** these values, which are invalid items in Gen 2 and get replaced: 0x19 → 0x92 Leftovers; 0x2D → 0x53 Bitter Berry; 0x32 → 0xAE Gold Berry; 0x5A, 0x64, 0x78, 0x87, 0xBE, 0xC3, 0xDC, 0xFA, 0xFF → 0xAD Berry ([c-link] `catch_rate_items.asm`; [pkhex] ItemConverter agrees). Other catch rates become whatever item has that index. For example Mewtwo's 3 becomes item 0x03 (BRIGHTPOWDER per [c-macros] item constants).
- moves, OT ID, EXP, stat exp, DVs and PP copied verbatim (25 bytes). Level copied. Max HP/Atk/Def/Spd copied. SpA and SpD recomputed.
- On arrival via trade: friendship = 70, Pokérus = 0, and caught data = 0 (no Crystal met data) (`Link_ConvertPartyStruct1to2`).
- Every link trade (Gen 2 ↔ Gen 2 too) is refused as "abnormal" if the received Pokémon's level is above 100, or if its list species byte differs from its struct species byte (eggs excepted). The base-type check described in §6.1 applies only to Time Capsule trades ([c-link] `engine/link/time_capsule.asm` `ValidateOTTrademon`). Our writer should enforce the same invariants.

**Gen 2 → Gen 1**: only allowed if species < 152, every move ≤ 165, the Pokémon holds no mail, and it is not an egg (0xFD fails the species test).
- species: National → internal. HP and status copied. Box level = 0.
- types from Gen 2 base data, with Magnemite/Magneton forced to Electric/Electric. Gen 1 and Gen 2 share type IDs for the Gen 1 types; Steel 0x09 and Dark 0x1B are Gen 2 only.
- catch-rate byte = held item (raw copy, together with moves through PP: 26 bytes).
- level and stats copied; Special recomputed from the Kanto special base stat.
- Friendship, Pokérus and caught data are lost.

**Rule for Home:** store the original struct bytes losslessly. Apply these conversions only when injecting into a save of the other generation, and record the conversion so the original bytes are still available.

---

## 9. Index tables

### 9.1 Gen 1 internal species → National Dex

Built from [red-dex] (`dex_order.asm` + `pokedex_constants.asm`) and verified identical to [pkhex] `Table1InternalToNational` and to [pokeapi] `pokemon_game_indices.csv` (version_id 1 = Red). Row = high nibble; 0 = MissingNo./invalid (reject). Indices above 0xBE are invalid.

```
      0   1   2   3   4   5   6   7   8   9   A   B   C   D   E   F
0x00:   0 112 115  32  35  21 100  34  80   2 103 108 102  88  94  29
0x10:  31 104 111 131  59 151 130  90  72  92 123 120   9 127 114   0
0x20:   0  58  95  22  16  79  64  75 113  67 122 106 107  24  47  54
0x30:  96  76   0 126   0 125  82 109   0  56  86  50 128   0   0   0
0x40:  83  48 149   0   0   0  84  60 124 146 144 145 132  52  98   0
0x50:   0   0  37  38  25  26   0   0 147 148 140 141 116 117   0   0
0x60:  27  28 138 139  39  40 133 136 135 134  66  41  23  46  61  62
0x70:  13  14  15   0  85  57  51  49  87   0   0  10  11  12  68   0
0x80:  55  97  42 150 143 129   0   0  89   0  99  91   0 101  36 110
0x90:  53 105   0  93  63  65  17  18 121   1   3  73   0 118 119   0
0xA0:   0   0   0  77  78  19  20  33  30  74 137 142   0  81   0   0
0xB0:   4   7   5   8   6   0   0   0   0  43  44  45  69  70  71
```
Spot checks: 0x54 = Pikachu (25), 0x99 = Bulbasaur, 0xB0 = Charmander, 0xB1 = Squirtle, 0x15 = Mew, 0x83 = Mewtwo.

### 9.2 Other indices
- **Gen 2 species** = National Dex 1–251; 0xFD = Egg (list marker only); 0xFF = list terminator; 0xFC unused ([c-macros] pokemon_constants).
- **Moves**: shared numbering. Gen 1 uses 1–165, Gen 2 uses 1–251. Sources: `constants/move_constants.asm` in pokered and pokecrystal.
- **Items**: Gen 1 and Gen 2 item indices **differ** from each other and from later generations. Machine-readable sources: https://raw.githubusercontent.com/pret/pokered/master/constants/item_constants.asm, https://raw.githubusercontent.com/pret/pokecrystal/master/constants/item_constants.asm, and [pokeapi] `item_game_indices.csv` (generation_id 1 and 2). PKHeX maps Gen 2 to Gen 4 items in ItemConverter (read only).
- **Base data** (types, catch rate, growth rate, Gen 2 gender ratio and egg cycles): `data/pokemon/base_stats/<name>.asm` in pokered, pokeyellow and pokecrystal.
- **Gen 2 locations** for caught data: `constants/landmark_constants.asm` in pokecrystal.
- Recommended: generate our own JSON tables once from these files (and PokeAPI CSVs) with a dev script, commit the JSON, and do not vendor pret sources.

---

## 10. Text encoding

- Terminator **0x50** (`@`). Fixed-length fields: NAME_LENGTH = 11 (10 chars + terminator) INT; 6 (5 + terminator) JP. Player and rival names hold at most 7 chars INT and 5 JP. Box names (Gen 2): 9 bytes. Mail lines: 16. ([red-macros]/[c-macros] text_constants.)
- When writing names, fill the rest of the field after the text with 0x50. [pkhex] does this, and its "is nicknamed" test compares the whole field against the species name padded with 0x50.
- A nickname is "not nicknamed" if it equals the species name in the game's language, padded with 0x50 ([bulba-s2]). Gen 1/2 have no nickname flag.
- **0x5D** = control code `<TRAINER>`, used as the OT name of Gen 1 in-game trades (`dname "<TRAINER>"` in [red-addmon]-adjacent `engine/events/in_game_trades.asm`). Render it as "TRAINER" in the viewer's language.
- 0x7F = space (JP: full-width space). 0x4E = line break inside mail.

Tables:
- **English Gen 1**: [red-charmap]. A–Z 0x80–0x99, `( ) : ; [ ]` 0x9A–0x9F, a–z 0xA0–0xB9, é 0xBA, contractions 0xBB–0xBF ('d 'l 's 't 'v), ' 0xE0, PK 0xE1, MN 0xE2, - 0xE3, 'r 0xE4, 'm 0xE5, ? 0xE6, ! 0xE7, . 0xE8, ▷▶▼ 0xEC–0xEE, ♂ 0xEF, ¥ 0xF0, × 0xF1, decimal point 0xF2, / 0xF3, , 0xF4, ♀ 0xF5, 0–9 0xF6–0xFF.
- **English Gen 2** ([c-charmap]) is the same for user-enterable characters, but rearranged elsewhere: Ä Ö Ü ä ö ü 0xC0–0xC5, contractions 0xD0–0xD6, ← 0xDF, & 0xE9, é 0xEA, → 0xEB. Bytes users can type in names keep the same code points across Gen 1/2 of one language ([bulba-ce2]).
- **French/German** and **Italian/Spanish** Gen 2 tables differ from English in the 0xBA–0xDF range (accented letters, ß, ç, ¿ ¡, ligature positions). [bulba-ce2] has per-language tables ("French and German", "Italian and Spanish"). German names may contain ÄÖÜäöü (0xC0–0xC5), which is how [pkhex] detects German. Build our tables from [bulba-ce2] + [c-charmap]; do not copy [pkhex]'s tables.
- **Japanese** (Gen 1 and 2): the JP section of [red-charmap] / [c-charmap]. Katakana ア 0x80…, hiragana あ 0xB1…, dakuten forms 0x05–0x48, ー 0xE3, digits 0xF6–0xFF. **Ambiguity:** the font has one glyph for へ/ヘ (0xCD), り/リ (0xD8), べ/ベ (0x3D) and ぺ/ペ (0x47). pret maps them to hiragana, [pkhex]'s Gen 2 table shows katakana for some. The encoder must accept both scripts, and the decoder should pick by context (katakana if the neighbours are katakana).
- **Korean** (GS only): a separate 2-byte Hangul encoding ([pkhex] StringConverter2KOR; Bulbapedia "Korean character encoding (Generation II)"). It uses the INT field sizes (11-byte names hold at most 5 Hangul characters), and Korean box names are 17 bytes. Defer.

---

## 11. Region and language compatibility (what we can support)

| Combination | In-game behaviour | Our support |
|---|---|---|
| Western ↔ Western (EN/FR/DE/IT/ES), Gen 1 ↔ Gen 2 | trades work; names keep their bytes ([bulba-ce2]) | full |
| Korean GS ↔ Western | trades work; Hangul shows garbled in Western games ([bulba-ce2]) | read Korean saves later. Moving Korean Pokémon into Western saves needs name policy. |
| Japanese ↔ Western/Korean | **corrupts both saves** in-game ([bulba-ce2]) because name lengths differ | JP saves are supported (layouts are known). Moving JP Pokémon into Western saves, or the reverse, needs explicit conversion: re-encode or replace the nickname and OT name, and resize to 6/11-byte fields. Make this a deliberate, flagged operation. Poké Transporter similarly treats JP and international VC as separate. |

Priority recommendation: (1) Gen 1 INT + GS INT + Crystal INT, read/write; (2) Gen 1 JP + GS/C JP, read/write, after one real-save check of the UNVERIFIED items; (3) GS KOR read-only.

---

## 12. Gotchas (collected)

1. **Gen 1 first box change wipes all PC boxes** unless bit 7 of 0x284C is set (§4.4).
2. **Gen 1 current box truth is bank 1 (0x30C0); Gen 2 current box truth is the bank-2/3 slot**, and Gen 2 `sBox` is overwritten on load (§4.4, §5.2). These are opposite rules.
3. Gen 2 has a backup copy of all game data. GS's backup is split into 5 pieces, and PKHeX has a wrong offset for one of them (§5.3).
4. Gen 2 party **mail backup overwrites the primary on load** (§5.6).
5. Gen 1 types and catch rate are stored per Pokémon: keep types equal to the base types; preserve the catch rate (it is the Gen 2 item). Yellow overrides: Pikachu 0xA3, Kadabra 0x60. Yellow base catch rates differ for Dragonair and Dragonite.
6. Gen 2 eggs are signalled only by 0xFD in the species list; friendship = egg cycles; don't register them in the Pokédex.
7. Unown letter, shininess and gender all come from DVs. Changing DVs changes all three. Unown also needs the Unown Dex update.
8. Box structs lack stats and level is a separate byte (Gen 1 box-level byte; Gen 2 level @0x1F). On withdraw, both games recompute the level **from EXP** and recompute the stats (Gen 2 also restores full HP and clears status), so any stats we show for boxed Pokémon must be computed by us, and EXP must agree with the level byte (§6.1, §6.2).
9. Gen 1 money is BCD; Gen 2 money is binary. Gen 2 play-time hours are 16-bit BE; Gen 1 hours are 8-bit with a "maxed" flag.
10. Gen 2 checksums are little-endian; every other multi-byte value is big-endian.
11. RTC: never modify the RTC footer, the `.rtc` sidecar, `sRTCStatusFlags` (0x0C60 INT; [pkhex] only: GS JP 0x1000, Crystal JP 0x0C80, GS KOR 0x1060) or `wStartDay..wRTC` (0x2044–0x204B INT). A lost footer only produces the in-game clock-reset prompt.
12. "Traded" status is decided mainly by OT ID ≠ player ID (Gen 1 EXP and obedience compare `wPlayerID` only, [red-save]-adjacent `engine/battle/experience.asm`, `core.asm`; Gen 2 `effect_commands.asm`). Some event checks also compare the OT name ([c-move]-adjacent `search_owned.asm` CheckOwnMon). Pokémon from other users boost EXP and may disobey without badges. Our Home never changes OT.
13. Trade evolutions (Kadabra, Machoke, Graveler, Haunter; Gen 2 also Onix and Scyther with a Metal Coat, etc.) happen only during a real link trade. Moving a Pokémon through Home does not evolve it.
14. The Gen 2 checksum also covers 449 bytes of link scratch in GS (0x2BA8–0x2D68). Copy, never clear.
15. Gen 1 Hall of Fame (bank 0) and Gen 2 HoF are never touched by us.
16. JP Crystal saves may be 64 KiB. Preserve the size.
17. Gen 2 Pokémon holding mail cannot be put into boxes and cannot cross into Gen 1.
18. [bulba-s1] says the save-exists check looks for 0x50 within 0x2598–0x259B; pret scans 11 bytes. Write a properly terminated name and either rule is satisfied.

---

## 13. Test vectors and validation strategy

### 13.1 Synthetic saves (no real game saves needed)

A throwaway generator built from these notes produced one save per layout. Each holds a party, the current box, a box in bank 2 and a box in bank 3, Pokédex bits, and Gen 2 eggs, Unown, a shiny and Crystal caught data. All seven layouts (plus a Crystal file with a 48-byte RTC footer) **loaded in PKHeX.Core 24.7.27 with checksums valid and every field decoded as intended** ([oracle]):
- Version and language detection: R/B INT, Yellow INT (starter 0x54, friendship 90), RB JP, GS INT, C INT, GS JP, C JP (0x10000 bytes).
- Box placement: Gen 1 INT box 2 and box 7; Gen 1 JP box 5 at 0x6000; Gen 2 INT box 14 at 0x79E0; Gen 2 JP box 9 at 0x6A94.
- Crystal: player gender read from 0x3E3D; Cyndaquil met data decoded as level 5, location 1, day, female OT; egg flag from 0xFD; Unown form 15 (P); shiny Gyarados (DVs AA AA); stats as computed below.

How to build one (pseudo-code, written for these notes):
```
gen1(INT): buf = zeros(0x8000)
  buf[0x2598..] = encode("ASH") + 0x50 fill (11 bytes)
  buf[0x2605..0x2607] = u16be(TID)
  writeList(buf, 0x2F2C, cap=6,  party structs 44B, NL=11)
  writeList(buf, 0x30C0, cap=20, box structs 33B,  NL=11)
  buf[0x284C] = 0x80 | currentBox
  set Pokédex bits at 0x25A3 (owned) and 0x25B6 (seen)
  for bank in {2,3}: write 6 lists at bank*0x2000 + i*0x462 (empty: count 0, 0xFF ...)
                     buf[bank*0x2000+0x1A4C] = ~sum(bank*0x2000 .. +0x1A4B)
                     buf[bank*0x2000+0x1A4D+i] = ~sum(box i)
  buf[0x3523] = ~sum(buf[0x2598..0x3522])          // LAST
crystal(INT): buf = zeros(0x8000); buf[0x2008]=0x63; buf[0x2D0F]=0x7F
  TID @0x2009, name @0x200B, party list @0x2865, dex @0x2A27/0x2A47, curBox @0x2700, names @0x2703
  write 14 boxes at 0x4000+i*0x450 (i<7) / 0x6000+(i-7)*0x450, pad = FF 00; copy box[cur] to 0x2D10
  u16le @0x2D0D = sum(0x2009..0x2B82)
  copy 0x2000..0x2007 -> 0x1200; buf[0x1208]=0x63; copy 0x2009..0x2B82 -> 0x1209; u16le @0x1F0D = sum(0x1209..0x1D82); buf[0x1F0F]=0x7F
```

### 13.2 Worked struct vectors (computed from §6–§7, confirmed by [oracle])

Gen 1 party Pikachu: internal 0x54, level 5, Medium Fast (EXP 125), DVs `A9 8C` (Atk 10, Def 9, Spd 8, Spc 12 → HP DV 4), stat exp 0, Thundershock (0x54) 30 PP, Growl (0x2D) 40 PP, OT ID 12345, R/B catch rate 190. Expected stats 18/11/8/14/11. Bytes (44):
```
54 00 12 05 00 17 17 be 54 2d 00 00 30 39 00 00 7d 00 00 00 00 00 00 00 00 00 00 a9 8c 1e 28 00 00 05 00 12 00 0b 00 08 00 0e 00 0b
```
(The Yellow starter has byte 0x07 = `a3`.)

Gen 1 box Bulbasaur (internal 0x99), level 10, Medium Slow (EXP 560), DVs FF FF, Tackle/Growl, current HP 32. Box struct (33 bytes):
```
99 00 20 0a 00 16 03 2d 21 2d 00 00 30 39 00 02 30 00 00 00 00 00 00 00 00 00 00 ff ff 23 28 00 00
```

Gen 2 Crystal party Cyndaquil, level 5 (Medium Slow, EXP 135), DVs `A9 8C`, Tackle (33)/Leer (43), OT ID 54321, friendship 70, caught `85 81`. Stats 19/11/10/12/12/11. Bytes (48):
```
9b 00 21 2b 00 00 d4 31 00 00 87 00 00 00 00 00 00 00 00 00 00 a9 8c 23 1e 00 00 46 00 85 81 05 00 00 00 13 00 13 00 0b 00 0a 00 0c 00 0c 00 0b
```
Gen 2 Togepi egg (list marker 0xFD): friendship byte = 10 (egg cycles); bytes 0x1B–0x1F = `0a 00 00 00 05`.

Checksum and list-header sanity vectors:
- An initialised empty Gen 1 INT box written as count 0 + 21 × 0xFF + 0x00 fill has per-box checksum **0x14** (~(21×255) & 0xFF).
- Gen 1 empty party with count 0: bytes at 0x2F2C = `00 ff`.

### 13.3 Recommended automated tests
1. **Round trip**: parse → serialize with no changes → byte-identical (including container header/footer). Run this on every synthetic file and on any community sample saves we obtain.
2. **Checksum unit tests**: known small buffers (for example all zero → Gen 1 0xFF, Gen 2 0x0000; a buffer of 0x01 bytes of length L → Gen 1 `~L & 0xFF`, Gen 2 `L & 0xFFFF`).
3. **Insert/remove invariants**: after any operation, `species[count] == 0xFF`, every species ≤ max (or 0xFD in Gen 2 lists), stats consistent, mail shifted, checksums valid, backup == primary (Gen 2), and the slot equals `sBox` for the current box (Gen 2).
4. **Gen 1 first-box-change** test: a save with bit 7 clear plus a deposit into box 5 must come out with bit 7 set and all slots initialised.
5. **External oracle (dev only, not shipped)**: a small .NET harness using the PKHeX.Core NuGet package (24.7.27 targets net8.0; newer builds need net10) loads our outputs and asserts `ChecksumsValid`, species, levels and stats. Running a GPL tool as a test oracle does not affect our MIT code, but keep it out of the repo or in a clearly separate dev-tools folder.
6. **Game-in-the-loop (strongest, optional, local only)**: boot the real game in a headless emulator with the user's own ROM, inject our `.sav`, script the inputs to CONTINUE, and then read WRAM at pret symbol addresses (e.g. `wPartyCount` = D163 for Red, `wPartyCount` = DCD7 for Crystal) to prove the game accepted the save. Never commit ROMs.

---

## 14. Discrepancies between sources

| Topic | Sources disagree | We believe | Why |
|---|---|---|---|
| GS backup of wPlayerData2 | [pkhex] 0x3D69 vs pret symbol + [bulba-s2] 0x3D96 | **0x3D96** | pret builds the exact ROM; 0x3D69 overlaps the Hall of Fame |
| Gen 2 DST byte | [pkhex] and [bulba-s2] say 0x2042 | pret: 0x2042 = `wSavedAtLeastOnce`; DST = bit 7 of **0x2050** (`wDST`, used by `engine/rtc/timeset.asm`) | code reference |
| Crystal play-time offset | [bulba-s2] 0x2053 | **0x2052** (hours u16 BE), cap flag 0x2051 | [c-sym] and [pkhex] agree |
| Gen 2 play-time format | [bulba-s2] "4 one-byte values" | hours are **u16 BE** | [c-dv] `home/game_time.asm` reads two bytes, high byte first |
| Gen 2 "Trainer ID at 0x2008, 3 bytes" | [bulba-s2] | 0x2008 = check value 0x63; ID = u16 @0x2009 | [c-sram] |
| Catch-rate → item replacement list | [bulba-p1] lists 0x7F (Card Key) and omits 0x87, 0xC3, 0xDC, 0xFA | 0x19, 0x2D, 0x32, 0x5A, 0x64, 0x78, **0x87**, 0xBE, **0xC3, 0xDC, 0xFA**, 0xFF | [c-link] table (ITEM_87 = 0x87; CARD_KEY = 0x7F is not in it); [pkhex] agrees |
| Gen 1 status bit table | [bulba-p1] labels "bit 3 = 0x04 asleep" | bits 0–2 = sleep counter, PSN bit 3 (0x08), BRN 4, FRZ 5, PAR 6 | [red-macros] battle_constants |
| Save-exists name check | [bulba-s1] 0x2598–0x259B | first 11 bytes | [red-addmon] `CheckForPlayerNameInSRAM` |
| `OtherCurrentBox` 0x284C (INT) | defined in [pkhex] SAV2Offsets | unused by PKHeX; in GS/C INT it is not a box field | grep shows no use |
| Gen 1 box checksums | [bulba-s1] presents them as validation | the game writes but **never reads** them | grep of both pret repos |

---

## 15. UNVERIFIED items (need one real save each)

1. Gen 1 JP bank-checksum offsets (predicted 0x5598/0x7598 + 4 per-box bytes).
2. Gen 2 JP and KOR check-value positions (JP inferred as 0x2008/0x2D0F and 0x7208/0x7F0F, §3.1); JP derived offsets for mom's name, game-time cap and others; JP play-time offset (0x2034 per PKHeX vs 0x2035 per Bulbapedia for Crystal JP); JP Crystal checksum coverage (0xADA vs 0xB32 bytes).
3. GS KOR backup layout and checksum ranges (PKHeX only; the ranges do not add up to the primary's size, §5.3).
4. Whether Pokémon Stadium 1/2 read the Gen 1 box checksums or the Gen 2 `sBox`.
5. Gen 1 JP Pikachu-mood and rival-starter offsets (derived). (Surfing-score endianness is now resolved: little-endian BCD, see §4.2.)
6. 3DS VC JP Crystal file size; Gambatte `.rtc` layout.
7. Gen1Recomp import/export of cartridge `.sav`.
8. Mail text encoding quirks for English GS and Italian/Spanish.

---

## 16. Verification notes (adversarial review, 2026-10-24)

An independent reviewer re-derived every number in this document from primary sources and did not rely on the original research. Sources were fetched fresh into a scratch directory outside the repo:
- Shallow clones of pret/pokered @ 171e2c2, pret/pokeyellow @ 9327549, pret/pokegold @ fc702b6 and pret/pokecrystal @ 5c877ef.
- The current `symbols` branches: pokered/pokeblue @ bd77855a9f, pokeyellow @ bc8070c731 (newer than the 2c9d118c3f cited in §1; the reviewer confirmed that no SRAM or saved-WRAM symbol differs), pokegold/pokesilver @ 4b57c3aa31, and pokecrystal/pokecrystal11 @ 3b13ca4fa7. Each symbols branch was confirmed to post-date the last `ram/wram.asm` commit on master.
- PKHeX master @ a9ff306570 (read only).
- Bulbapedia, read through the web.archive.org copy because the live site returns 403.
- The PokeAPI CSVs, the BGB RTC page and mGBA's `mbc.h`.

The reviewer used throwaway scripts only and copied nothing into the repo.

### 16.1 What was checked, and how

| Area | Method | Result |
|---|---|---|
| Gen 1 SRAM bank map, box addresses, bank/per-box checksum locations | `ram/sram.asm` sections, compared with `.sym` SRAM symbols (bank × 0x2000 + addr − 0xA000) | all correct |
| Gen 1 bank-1 field offsets (INT, R/B and Yellow) | Script mapping every WRAM symbol inside `wMainData`/`wSpriteData`/`wPartyData`/`wBoxData` to its file offset, for both `pokered.sym` and `pokeyellow.sym` (Yellow's WRAM is shifted by 1, but the file offsets come out identical) | all 26 fields correct |
| Gen 1 JP offsets | Compared against PKHeX `SAV1Offsets.JPN`; checked the derived values for internal consistency (main data end 0x2CA7 + 0x2E = 0x2CD5; + 0x200 = party 0x2ED5; + 0x158 = box 0x302D; + 0x566 = 0x3593) | consistent; still single-source |
| Gen 1 checksums | `CalcCheckSum`, `LoadMainData`/`LoadCurrentBoxData`/`LoadPartyAndDexData`, `CopyBoxToOrFromSRAM`, `EmptySRAMBoxesInBank`, `CalcIndividualBoxCheckSums`; grep of full pokered and pokeyellow for reads of the box checksums | correct. The only other references are in a Yellow debug menu, which writes them (and has a BUG comment) |
| Gen 1 / Gen 2 struct layouts | `box_struct`/`party_struct` macros in pokered and pokecrystal (and pokegold: bytes 0x1D/0x1E are `Unused1/2`) | correct |
| List sizes and box strides | Recomputed from the capacity/struct/name constants and compared with PKHeX's `SIZE_BOX_LIST` formulas and `.sym` box symbols (e.g. `sBox1End` 0x444E, `sBox2` 0x4450) | all correct, including JP strides 0x566 and 0x54A |
| Gen 2 SRAM map (GS and Crystal INT) | Every `s*` symbol in `pokegold.sym` and `pokecrystal.sym` converted to file offsets | all correct |
| Gen 2 primary/backup ranges | Script built a random 32 KiB image, copied the five GS pieces using the §5.3 table, and checked that the table equals the ranges derived from the `.sym` symbols (`wPlayerData1..3`, `wCurMapData`, `wPokemonData` and the `sBackup*` placement), that the backup sum equals the primary sum, and that no piece overlaps the HoF, `sBox` or the stack. Did the same for Crystal (offset 0xE00) | correct. PKHeX's 0x3D69 overlaps the last 0x2D bytes of the HoF (confirmed in PKHeX `SAV2.GetFinalData`) |
| Gen 2 load/save logic | `TryLoadSaveFile`, `TryLoadSaveData`, `CheckPrimary/BackupSaveFile`, `_SaveGameData`, `SaveBackupChecksum`, `VerifyBackupChecksum`, `GetBoxAddress`, `SaveBoxAddress`, `LoadBoxAddress`, `EraseBoxes`, `Checksum` (GS and Crystal; `EraseBoxes` and `Checksum` are byte-identical in both) | correct apart from the omissions fixed below |
| Gen 2 field offsets (INT) | Same WRAM→file script for 60+ symbols in GS and Crystal | all correct |
| Gen 2 JP/KOR columns | Compared field by field with PKHeX `SAV2Offsets` (and `EventFlag = CurrentBoxIndex − 0x105/0x100`, `Daycare = seen + 0x3C`) | match PKHeX; remain single-source |
| Detection | PKHeX `SaveUtil.IsG1*/IsG2*` order and list checks; `SAVE_CHECK_VALUE_1/2` = 99/127 | correct (PKHeX accepts party count ≤ 20/30, which is looser than our ≤ 6) |
| Containers | PKHeX `SaveHandlerFooterRTC` (footer = size & 0x3F; 0x0C–0x30 even, or 0x07) and `SaveHandlerNSO` (header layout, lowercase SHA-1, size delta 0x68–0xA0); BGB page and mGBA `GBMBCRTCSaveBuffer` (10 × u32 + u64); pret Makefiles (`-m MBC3+RAM+BATTERY` R/B, `MBC5+RAM+BATTERY` Y, `MBC3+TIMER+RAM+BATTERY` GSC, all `-r 3`) | correct |
| Gen 1 index table §9.1 | Script rebuilt the internal→Dex table from pokered `pokemon_constants.asm` + `pokedex_constants.asm` and diffed it against the doc's 191 entries, then against PokeAPI `pokemon_game_indices.csv` version 1 | 0 mismatches; 151 distinct species; highest index 0xBE |
| Charmaps | pokered and pokecrystal `constants/charmap.asm` | every EN code point cited is correct; JP special codes (0xCD, 0xD8, 0x3D, 0x47 shared) correct |
| DV-derived values | `CalcMonStatC`/`CalcStat` (HP DV, `GetSquareRoot` table semantics, ×level/100, +5 / +level+10, cap 999), `GetGender` + `percent` macro (31/63/127/191/254), `CheckShininess` constants, `GetUnownLetter` bit packing and the divisor `$ff / NUM_UNOWN + 1` = 10, `ComputeMaxPP` (min(7, base/5)), `growth_rates.asm` | all correct |
| Worked vectors §13.2 | A script encoded Pikachu, Bulbasaur and Cyndaquil from the §6/§7 rules and pret base stats and moves, then compared them with the doc's hex | all three byte-identical; caught data `85 81`, empty-box checksum 0x14 and Unown DVs 5BE7 → v=159 → P confirmed |
| Time Capsule | `Link_ConvertPartyStruct1to2`, `.ConvertPartyStruct2to1`, `CheckTimeCapsuleCompatibility`, `ValidateOTTrademon`, `TimeCapsule_CatchRateItems` (item IDs resolved: LEFTOVERS 0x92, BITTER_BERRY 0x53, GOLD_BERRY 0xAE, BERRY 0xAD, BRIGHTPOWDER 0x03) | correct (25-byte and 26-byte copies, box level 0, Magnemite/Magneton, `KantoMonSpecials`) |
| Eggs / Day Care / Unown Dex / caught data | `daycare.asm` egg init, `AddTempmonToParty`, `UpdateUnownDex`, `SetCaughtData`/`SetGiftMonCaughtData` (gift 0x7E, event 0x7F, `CAUGHT_EGG_LEVEL` 1), Day Care flag bits | correct |
| Yellow specifics | `OaksLab.asm` (`LIGHT_BALL_GSC` 0xA3), `add_mon.asm`/`item_effects.asm` (`TWISTEDSPOON_GSC` 0x60), base-stat diff of all 151 species (only Dragonair 27 and Dragonite 9 differ), `IsThisMonStarterPikachu` (5-byte name compare) | correct except the in-game-trade claim (fixed) |
| Mail | pokegold and pokecrystal `mailmsg` macros, `MAIL_STRUCT_LENGTH(_JP)`, `mail_items.asm` + item IDs, `BackupPartyMonMail`/`RestorePartyMonMail`, `RemoveMonFromPartyOrBox` | sizes and IDs correct; GS/Crystal field split and mailbox restore fixed |
| Cited URLs | HTTP check of every raw URL in §1/§9.2; the PC-port repos exist and their READMEs match §2 | all resolve |

### 16.2 Changes made (old → new, with source)

1. **§4.4 Gen 1 change-box semantics.** Old: "marks the source as empty", and the current box's slot is "stale (whatever was there when the player last switched away)". New: the game marks the **new** box's slot empty (`count 0, species[0] 0xFF`, stale bytes after that) and empties the WRAM copy when writing the old box back. The current box's slot therefore reads as an empty list in game-written saves. Also added the step order, the 0xFF fill from `ClearAllSRAMBanks`, the rule that the current index is 0 while bit 7 is clear, and the `GetMonCountsForAllBoxes` behaviour. Source: pokered `engine/menus/save.asm` `CopyBoxToOrFromSRAM` (after `pop hl`, the routine writes 0 then 0xFF through the *source* pointer, which on the second call is the new box's SRAM slot).
2. **§4.5 removal, step 4.** Old: the game shifts mail "in both mail copies". New: the game shifts only `sPartyMail`, the backup is re-synced by `BackupPartyMonMail` at save time, and a writer must still shift both. Also described the game's whole-capacity shift and its last-slot special case. Source: pokecrystal `engine/pokemon/move_mon.asm` `RemoveMonFromPartyOrBox`; `engine/pokemon/mail.asm`.
3. **§4.6 Yellow Kadabra.** Old: Kadabra "received in the in-game trade" gets 0x60, citing `in_game_trades.asm`. New: Yellow has no Kadabra trade; the rule applies to every `_AddPartyMon`/`SendNewMonToBox` path. Source: pokeyellow `data/events/trades.asm`, `engine/pokemon/add_mon.asm`.
4. **§4.2 Options (Gen 1).** Old: "bits 0–2 text delay". New: R/B use bits 0–2, Yellow uses bits 0–3 (`TEXT_DELAY_MASK` %001111), and bits 4–5 hold sound in Yellow only. Source: pokered and pokeyellow `constants/ram_constants.asm`.
5. **§4.2 Surfing score.** Old: "BCD; PKHeX reads it little-endian (UNVERIFIED)". New: little-endian BCD, confirmed. Source: pokeyellow `ram/wram.asm` comment and `engine/minigame/surfing_pikachu.asm` `DidPlayerGetAHighScore`. §15 item 5 updated.
6. **§4.2 Missable-object flags / game progress.** Old: size "—" and "0x100". New: 32 bytes (pret now names it `wToggleableObjectFlags`), and 0xC8 named bytes + 0x38 unused. Source: pokered `ram/wram.asm`, `.sym`.
7. **§5.4 Gen 2 Options byte 0.** Old: "bits 4–5 sound". New: bit 5 stereo, bit 4 no-text-scroll (cleared by `SaveOptions`), plus bytes 3 and 5–7 described. Source: pokecrystal `constants/ram_constants.asm`, `ram/wram.asm`, `engine/menus/save.asm`.
8. **§5.4 GS link scratch.** Old: "451 bytes". New: 449 saved and checksummed bytes, 0x2BA8–0x2D68. The pret comment's 451-byte union extends 2 bytes past `wPokemonDataEnd` (DF01 vs `wLinkReceivedPartyEnd` DF02). Gotcha 14 updated. Source: `pokegold.sym`, pokegold `ram/wram.asm`.
9. **§5.6 mail struct.** Old: one INT layout with "author name (8) @0x21, nationality @0x29" for all INT games. New: Crystal's macro splits the field as 8 + 2, Gold/Silver's macro uses a 10-byte author with no nationality, both English games copy 10 bytes of `wPlayerName`, and Crystal reads 'E'+F/G/I/S to choose European mail handling. Source: pokegold and pokecrystal `macros/ram.asm` `mailmsg`; pokecrystal `engine/pokemon/mon_menu.asm` `ComposeMailMessage`, `engine/pokemon/european_mail.asm`.
10. **§5.2 / §5.6 load-time restores.** Added: `RestorePartyMonMail` also restores the PC mailbox from 0x0A0B; Mystery Gift restores both item and unlocked (0x0BE4/0x0BE5 → 0x0BE2/0x0BE3); Crystal restores the GS Ball flag (0x3E44 → 0x3E3C). Source: pokecrystal `engine/pokemon/mail.asm`, `engine/link/mystery_gift.asm`, `mobile/mobile_41.asm`, `engine/menus/save.asm`.
11. **§5.1 Mystery Gift row / link-battle row.** Noted that 0x0BE5 doubles as the unlocked backup. Made the link-battle row precise (stats at 0x31BA/0x3260, records at +6). Source: as above, `.sym`.
12. **§5.3 KOR.** Added the warning that PKHeX's five Korean ranges sum to 0xD9D bytes, not the primary's 0xDA2. Source: arithmetic on PKHeX `SAV2.GetKoreanChecksum`.
13. **§3.1 JP check bytes.** Added the inferred positions (0x2008/0x2D0F, 0x7208/0x7F0F), clearly marked UNVERIFIED, with the reasoning.
14. **§3.2 / §3.3.** Added why the Yellow-friendship heuristic is safe on R/B (unused `ds 128` gap), and that Crystal 1.0/1.1/AU share one layout (symbol diff).
15. **§5.4 Crystal JP game-time cap cell.** Replaced the ambiguous "0x2033/0x2034" with an explicit PKHeX-vs-Bulbapedia statement, marked UNVERIFIED.
16. **§6.1 / §6.2 / gotcha 8 (gap).** Added the withdraw semantics: level recomputed from EXP in both generations; Gen 2 heals HP and status on withdraw and restores PP on deposit; Gen 1 keeps HP and status. Source: pokered `engine/pokemon/add_mon.asm` `_MoveMon`; pokecrystal `engine/pokemon/move_mon.asm` `SendGetMonIntoFromBox`, `RestorePPOfDepositedPokemon`.
17. **§8 (gap).** Added the general link-trade validity rules (level ≤ 100; list species = struct species unless egg). Source: pokecrystal `engine/link/time_capsule.asm` `ValidateOTTrademon`.
18. **Gotcha 11 (gap).** Added the JP/KOR `sRTCStatusFlags` offsets from PKHeX (single source).

### 16.3 Confirmed but still uncertain

- Everything in the JP and KOR columns is PKHeX-only (no pret disassembly exists for those builds; pret has no Japanese or Korean Gen 1/2 repo). Bulbapedia agrees with PKHeX on the JP checksum ranges but may itself derive from PKHeX.
- JP Crystal play time (0x2034 vs 0x2035) and the 0xADA-vs-0xB32 JP Crystal backup coverage: not resolvable without a real save.
- Gen 1 JP bank-checksum positions, and whether Pokémon Stadium reads them: still UNVERIFIED (the cartridge game never reads them).
- KOR backup layout: the size mismatch in §5.3 means PKHeX's model may be wrong; keep Korean read-only.
- The `[oracle]` claims (PKHeX.Core 24.7.27 loading the synthetic saves) were not re-run in this review.
- Which European builds write the mail nationality letters is unknown; mail bytes must stay opaque.
