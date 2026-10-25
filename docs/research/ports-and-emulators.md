# PC ports, recompilations, native ports and emulator save-file variants (Gen 1-5)

Research date: 2026-10-24. Status: complete draft (sections 0-5). Scope: every way people play the
main-series Gen 1-5 games in October 2026, and what save file each one leaves on disk.

Conventions:

- **Verified (code)** means the save code was read in a clone or raw file. **Verified (docs)** means
  the project's own README or docs say it. **UNVERIFIED** means no first-hand source was found.
- Repository facts (created, last push, stars, licence) come from `api.github.com/repos/...` on
  2026-10-24. Stars are a rough maturity signal only.
- No GPL code is copied here. PKHeX (GPLv3), DeSmuME, melonDS, mGBA (MPL), VBA-M, SameBoy, Gearboy,
  Gambatte and RetroArch sources were read only to confirm sizes, offsets and algorithms. Everything
  below is described in our own words and tables.
- Scratch material (clones, raw files, API JSON) is in `/tmp/claude-1000/pkres/ports-emulators/`.

---

## 0. Summary

1. **Nearly everything writes a raw cartridge image.** Emulators, cartridge dumpers, the 3DS
   Virtual Console, the 2026 Switch FireRed/LeafGreen release, the gb-recompiled and gbarecomp
   static recompilations, and most decomp-based native ports store exactly the SRAM or flash bytes
   the cartridge would hold: 32 KiB (Gen 1/2), 128 KiB (Gen 3), 512 KiB (Gen 4/5). The variation is
   in the **wrapper**: an RTC trailer (Gen 2 and Gen 3 R/S/E), DeSmuME's 122-byte footer, an Action
   Replay or No$GBA header, RetroArch's optional RZIP compression, and the NSO `SRAM` header.
2. **The real compatibility risks are in a few native ports, not the emulators:**
   - **NTx86/pokeemerald-sdl2pc, 64-bit builds** (the default): SaveBlock1 is written as it sits in
     memory. Pointers are 8 bytes and there are only 10 secret bases instead of 20, so everything
     after SaveBlock1 offset 0xC70 is shifted. The party, money, bag and PC boxes are still at the
     GBA offsets. alanb2305/pokeemerald-native fixed this by converting to the GBA layout when it
     saves. Verified (code).
   - **cybervisi0n/pokeplatinum pc_port** (`save.bin`): the offsets are the DS offsets, but the
     file is zero-filled (not 0xFF) and can be shorter than 512 KiB. Verified (code, libntr).
   - **mstan/PokemonYellowRecomp "Extended"** and every ROM-hack engine port
     (pokeemerald-expansion-native, HeartSoulRecomp): a different save layout. Reject them.
   - **G1R Deluxe / gen2recomp** (LÖVE2D re-implementations): the native save is a Lua table
     (`save.lua`), not SRAM. They can import and export cartridge `.sav` files, and only those
     exported files can be used with the widget.
3. **RTC data is never needed by the parser.** It is opaque bytes that we must give back unchanged.
   Several recompilers and phone or iOS emulators keep it in a **separate `.rtc` file**, which the
   widget never sees. That is fine: the user replaces only the `.sav`.
4. **Two strict consumers limit what we can emit.** Frigate (B2W2) refuses any file that is not
   exactly 524,288 bytes, and gbarecomp refuses any file larger than the flash chip (so an mGBA
   file with its 16-byte RTC trailer is refused). The rule "export the same container you
   imported" keeps us safe. On top of that, the UI offers **"export raw image only"** for users who
   move a save to another program.
5. **Official status in October 2026:** Gen 1/2 exist officially only as the 3DS Virtual Console
   releases (the eShop closed in 2023, but the games can be re-downloaded). FireRed/LeafGreen came
   out as standalone Switch/Switch 2 eShop titles on 2026-02-27, with Pokémon HOME support
   announced for October 2026. No Gen 1/2 game is on Nintendo Switch Online. Ruby/Sapphire/Emerald,
   DPPt, HGSS, BW and B2W2 have no official re-release.

---

## 1. Ports, recompilations and official re-releases

"Format" uses these short labels:

| Label | Meaning |
|---|---|
| **RAW** | byte-identical to the cartridge SRAM/flash image, same size, no header or footer |
| **RAW+side** | RAW `.sav`, plus RTC or other data in a separate sidecar file the widget never touches |
| **RAW-var** | cartridge offsets, but the file length or fill byte differs from a dump |
| **LAYOUT≠** | written from natively compiled structs, so some offsets differ from the cartridge |
| **FOREIGN** | not an SRAM image at all (Lua, JSON, ...). Needs the port's own import/export |

### 1.1 Official re-releases

| Release | Games | Status 2026-10 | Save location | Format | Notes / sources |
|---|---|---|---|---|---|
| **3DS Virtual Console** | R/B/Y (2016), G/S (2017), Crystal (2018) | eShop closed March 2023. Games can still be re-downloaded and played | 3DS save data. Extracted with Checkpoint / JKSM / GodMode9 as `sav.dat` (Checkpoint backup folder) | **RAW**, 32 KiB | PKHeX treats files whose names start with `sav` and contain `.dat` as VC Gen 1/2 saves (`SAV1.cs`/`SAV2.cs` `IsVirtualConsole`). Japanese VC Crystal size is UNVERIFIED (0x8000 or 0x10000). Requires a modded 3DS to extract or restore |
| **Pokémon FireRed / LeafGreen for Nintendo Switch** | FR, LG (each language sold separately) | Released 2026-02-27 as standalone eShop titles for Switch and Switch 2, **not** NSO. No save states or rewind. Wireless Club battles. HOME support announced for October 2026 | Switch system save. Needs homebrew (JKSV / Checkpoint / DBI) on a modded console to extract | **RAW** 128 KiB (inferred) | VGC and ConsolePulse (checked 2026-08-21) for the release facts. PKHeX treats Gen-3 files named `FireRed_*.sav` / `LeafGreen_*.sav` as the Switch release and parses them with the normal SAV3 code, which only accepts exactly 0x20000 bytes (`SAV3.IsVirtualConsoleFileName`, PKHeX `a9ff306` 2026-10-21). No sample inspected: the internal layout is **UNVERIFIED**. HOME runs legality checks, so withdrawing into this save needs care (§3.4) |
| Nintendo Switch Online (GB / GBC / GBA apps) | none of Gen 1-5 | No Pokémon main-series title as of 2026-10 (ConsolePulse catalogue check 2026-08-21) | — | NSO GB container: `SRAM` magic header (see §2.6) | The container exists and PKHeX supports it (`SaveHandlerNSO.cs`), presumably for ROMs injected into the NSO apps with homebrew (UNVERIFIED why). Support it because it is cheap |
| Brilliant Diamond / Shining Pearl, Let's Go | — | Not Gen 1-5 save formats | — | — | Out of scope |

### 1.2 Game Boy / Game Boy Color: static recompilations (gb-recompiled family)

All of these run the original game code, translated to C, against a runtime that models the MBC
and its battery RAM. The `.sav` is the cartridge RAM written out byte for byte. The RTC (MBC3,
Gen 2) always goes to a separate `.rtc` file. Verified (code) in mstan/gbrecompiled
`runtime/src/gbrt.c` and `platform_sdl.cpp`, and in arcanite24's `test_persist` (an 8 KiB test cart
gives an 8192-byte `.sav` and a 40-byte `.rtc`).

| Project | Repo | Games | Status 2026-10 | Platforms | Save location | Format |
|---|---|---|---|---|---|---|
| GB Recompiled (upstream) + **Crystal Recompiled** port | github.com/arcanite24/gb-recompiled (MIT, 447★, release v0.1.0, created 2026-01, push 2026-09-10) | Crystal (exact Rev 1 ROM). Any GB/GBC ROM is "experimental" | Active. Crystal is the showcase port | Linux x64, macOS x64/arm64, Windows x64 (release archives) | The launcher always passes `--save-dir <cache>/user-data`. The cache is `~/.cache/crystal-recompiled` (or `$XDG_CACHE_HOME`), `%LOCALAPPDATA%\Crystal Recompiled`, or `~/Library/Application Support/Crystal Recompiled` (`ports/pokemon-crystal/scripts/first_run.py`, `PACKAGING.md`). File name UNVERIFIED (output prefix `pokemon_crystal`) | **RAW+side**: `.sav` = 32 KiB SRAM. `.rtc` = 40-byte struct (magic `GRTC`, version, u64 unix time, u64 cycle remainder, 5 live + 5 latched regs, latch state) |
| GB-Recomp fork + per-game repos + **pgbcomp** launcher | github.com/GB-Recomp/gb-recompiled. Per-game repos GB-Recomp/pokered, pokeblue, pokeyellow, pokegold, pokesilver, pokecrystal. GB-Recomp/pgbcomp (repos created 2026-05-10/11, last push 2026-05-15) | R, B, Y, G, S, C | Playable builds. Small (1-2★). Adds BGB-protocol link cable over TCP and a Mystery Gift mock | Desktop (SDL2/GLES2), Android | `<game>.sav` **next to the executable** ("Battery RAM saves to `pokered.sav` next to the …"). The `.rtc` and `.state1..10` files sit beside it | **RAW+side** |
| mstan dev fork + **PokemonRedAndBlueRecomp**, **PokemonYellowRecomp** | github.com/mstan/gbrecompiled, mstan/PokemonRedAndBlueRecomp (push 2026-07-23), mstan/PokemonYellowRecomp | R/B (one exe), Yellow **Stock** and **Extended** | R/B: "early working prototype, playable through the Elite Four", Windows x64 release. Yellow: source only | Windows (MSYS2), others by building | State dir = `$GBRECOMP_STATE_DIR`, else the folder of the `.AppImage`, else the folder holding the macOS `.app`, else the exe folder (`gb_host_paths.c`). File name = the save id, which defaults to the ROM header title (for example `POKEMON RED.sav`, UNVERIFIED exact string) | **RAW+side** for R/B and Yellow Stock. **Yellow Extended is LAYOUT≠**: it adds dex #152-251, which "changes the save layout/checksum" (README). Reject it |
| sp00nznet ports | github.com/sp00nznet/pokemon-gold, pokemon-silver, pokemon-crystal on sp00nznet/gb-recompiled (created 2026-05-27, push 2026-10-14) | G, S, C | "First boot complete". The README marks the save round trip of a full party and box as "user-test" (not yet confirmed) | Windows | Next to `rom.exe`: `PM_CRYSTAL.sav` + `PM_CRYSTAL.rtc`, `POKEMON_SLVAAXE.sav` + `.rtc` (named by ROM header title). Gold is presumably `POKEMON_GLDAAUE.sav` (UNVERIFIED) | **RAW+side**. The README calls the `.rtc` a "48-byte BGB-compatible sidecar" (this differs from upstream's 40-byte `GRTC`. Irrelevant to us) |
| Crystal Clear Static Recomp | github.com/CMApex/CrystalClearStaticRecomp | Crystal Clear (ROM hack) | Hobby dump | — | — | Out of scope (ROM hack) |
| "Pokemon Crystal Android" | github.com/BurgerBlaze/Pokemon-Crystal-native-Android-Port (0★, created 2026-08-14) | Crystal | "Vibe-coded" asm-to-C transpile. No save documentation | Android | UNVERIFIED | UNVERIFIED. Treat as unknown. If it yields a 32 KiB file, it parses like any other |

### 1.3 Game Boy / Game Boy Color: native and re-implemented ports

| Project | Repo | Games | Status | Platforms | Save location | Format |
|---|---|---|---|---|---|---|
| **suiCune** | github.com/DanZC/suiCune (fork of pokecrystal, 187★, created 2022, push 2026-10-21) | Crystal (English) rewritten as C99 on SDL2, with Mobile Adapter features restored | "In development, may be prone to crashes" | Windows (MSYS2/VS), Linux | `baserom.sav` beside the program (the README says to copy an original English save there under that name). Also writes `baserom.sav2` | **RAW** 32 KiB in `.sav` (`gb_get_save_size()`, verified in `tools/emu/peanut_sdl.c`). Any extra cartridge RAM goes to `.sav2`. No RTC file. README caveat: saves made by suiCune may misbehave in the original game (script pointers, time of day). The party/box layout is the pokecrystal SRAM layout (UNVERIFIED by sample) |
| **G1R Deluxe** ("Gen1Recomp") | github.com/bryanthaboi/gen1recomp (4,029★, created 2026-07-18, push 2026-10-24) | R/B/Y, G/S/C, FR/LG, R/S/E re-implemented in Lua on LÖVE2D. Data is decoded from the user's ROM | Very popular, active. The README warns that **`gen1recomp[.]com` is an impersonation/adware site** | Windows, macOS, Linux (AppImage x86_64/arm64, Flatpak), Android, iOS, Switch homebrew, handhelds | LÖVE save dir, identity `pokemon-love2d`: `%APPDATA%\LOVE\pokemon-love2d\`, `~/.local/share/love/pokemon-love2d/`, `~/Library/Application Support/LOVE/pokemon-love2d/` (macOS path inferred from LÖVE conventions). Portable mode: `portable.txt` next to the app | **FOREIGN**: `save.lua` / `save.lua.bak` (a deterministic Lua table, `SaveSerializer.lua`). Converts to and from cartridge saves via the launcher's Import/Export (`docs/save-conversion.md`): Gen 1 32,768 B English, Gen 2 32,768 B plus an optional RTC footer, Gen 3 128 KiB plus an optional footer. JP/KR refused. Exports land in `exports/<game>/`, imports are read from `imports/saves/<game>/`. **Conflict:** `docs/switch-transfer.md` still says "Gen 2 cart .sav not supported yet" |
| **gen2recomp** | github.com/UNDERdecoded/Gen2Recomped (fork of G1R, 416★, created 2026-08-08, push 2026-10-21) | G/S/C, plus FireRed/Emerald, Platinum/HGSS, Black/White in the same Lua engine | Active | Same as G1R, plus console builds | Same LÖVE identity `pokemon-love2d`. Gold/Silver use `gold/` and `silver/` subfolders. Switch: `exports/` folder for "battery saves" | **FOREIGN**. README: "Import a Save: bring in a `.sav`/`.dsv` from an emulator or cartridge (Gen 1-5)" and "Export a Save: write the active slot out for an emulator" |

For the two LÖVE projects, the widget tells the user to use the app's own **Export save**, run the
widget on that `.sav`, then **Import save**. We never parse `save.lua`.

### 1.4 GBA: static recompilation

| Project | Repo | Games | Status | Platforms | Save location | Format |
|---|---|---|---|---|---|---|
| **GBARecomp** framework + **EmeraldRecomp**, **FireRedLeafGreenRecomp**, **RubySapphireRecomp** | github.com/mstan/gbarecomp (beta, created 2026-05-25, push 2026-10-24). mstan/EmeraldRecomp (41★), mstan/FireRedLeafGreenRecomp, mstan/RubySapphireRecomp (all created 2026-06-22, pushed 2026-10-19..23) | E, FR, LG, R, S (USA ROMs only, SHA-1 gated) | "In-development previews", v0.0.x-v0.1.1. Emerald has cable netplay and initial Wireless Adapter/Union Room | Windows x64 zips. Android is a framework path | `[save]` path from the game config if one is set, else the **ROM's path with the extension replaced by `.sav`** (`runtime.cpp`, `launcher_seam.h`). The ROM path is chosen at first launch and cached next to the exe | **RAW** Flash1M, exactly 131,072 bytes. Written atomically (`.tmp` then rename). A shrinking write first keeps `<save>.prev-size.bak`. **On load, a file larger than the flash is refused** ("save file too large"), so an mGBA `.sav` with a 16-byte RTC trailer must be trimmed first. The RTC follows the host clock and is **not persisted**: no trailer is ever written (`gba_rtc.cpp`). Verified (code, gbarecomp `7bb70ec`) |
| **nativeplat** (GBA half) | github.com/sohamb117/gen4recomp (4★, created 2026-10-04, push 2026-10-15) | R, S, E (USA) built from pret, compiled to WebAssembly, then back to C with wasm2c | "All ten games boot in the packaged app" | macOS arm64/universal zip, Windows x64 zip | SDL pref path `SDL_GetPrefPath("nativeplat","nativeplat")`: on macOS `~/Library/Application Support/nativeplat/`. Windows/Linux presumably `%APPDATA%\nativeplat\nativeplat\` and `~/.local/share/nativeplat/nativeplat/` (UNVERIFIED nesting). Then `saves/<game>/<slot>.sav` (+ `.bak`). Portable: `userdata/` beside the app | **RAW** 128 KiB slots. On import it drops mGBA's 16-byte RTC record. Its exports are raw (`shell/README.md`). wasm32 has 4-byte pointers, so SaveBlock structs should keep the GBA layout (UNVERIFIED) |

### 1.5 GBA: native decomp ports (pret pokeemerald / pokefirered on SDL or consoles)

All of these keep an emulated `FLASH_BASE[131072]` array and dump it to a `.sav`. The data inside
is only cartridge-identical when the C structs have the GBA layout. That holds on 32-bit targets
(ARMv7 Android, 3DS, PS2, Windows x86, wasm32), but **not automatically on 64-bit builds**.

| Project | Repo | Games | Status | Platforms | Save location | Format |
|---|---|---|---|---|---|---|
| **pokeemerald-sdl2pc** (the original PC port) | github.com/NTx86/pokeemerald-sdl2pc, branch `pc_port` (43★, created 2023-12-30, push 2026-09-15). Kurausukun/pokeemerald `pc_port` is the same lineage | Emerald | Mature-ish hobby port | Windows, Linux | `pokeemerald.sav` in the **working directory** (`src/platform/sdl2.c`, `win32.c`) | 128 KiB. Load: reads `min(size, 128 KiB)` and pads with 0xFF. Save: writes 128 KiB in place (`r+b`, so a longer file keeps its tail). **64-bit build (Makefile default `IS64BIT ?= 1`) is LAYOUT≠**: `VER_64BIT` sets `SECRET_BASES_COUNT` to 10 instead of 20, and `ObjectEventTemplate` holds a native 8-byte script pointer. Everything after SaveBlock1 offset 0xC70 (flags, vars, game stats, the second seen-flag copy, ...) moves, and the SaveBlock1 size, and with it the last SB1 sector's checksum length, changes. The party (SB1 0x234), money, bag and PC storage (sectors 5-13) are unaffected. Verified (code) |
| **pokeemerald-native** | github.com/alanb2305/pokeemerald-native (branch `vanilla`, created 2026-10-04) | Emerald | Active small fork | Windows, Linux, macOS | `%APPDATA%\pokeemerald\`, `~/.local/share/pokeemerald/`, `~/Library/Application Support/pokeemerald/`. If the start folder already holds a legacy `pokeemerald.sav`, that one is used. `--save FILE` overrides | **RAW**: converts SaveBlock1 to and from the 32-bit GBA layout on save/load (`SaveBlock1ToSaved`/`SaveBlock1FromSaved`) and reads "old 64-bit" saves (`IsOld64BitSaveBlock1`). Verified (code), and agrees with format-gen3 §2.3 |
| pokeemerald-ps2 | github.com/dnllnoe/pokeemerald-ps2 (7★) | Emerald | Tested in PCSX2 only | PS2 (`pokeemerald32.elf`) and the desktop targets | `pokeemerald/` folder next to the ELF (for example `mass:/POKEEMERALD/pokeemerald/`) | 32-bit PS2 build, so presumably RAW (UNVERIFIED) |
| pokeemerald-multiplatform | github.com/gradenGnostic/pokeemerald-multiplatform (73★, push 2026-08-15) | Emerald, plus ROM-hack importing | Active Aug 2026 | Windows, Linux, Android (APK, `armeabi-v7a`) | Windows/Linux: `pokeemerald.sav` in the working directory. Android: `SDL_GetPrefPath("pokeemerald","pokeemerald")` = app-private internal storage (not reachable without root or the app's own export) | 128 KiB. Android is a 32-bit ABI, so RAW. Desktop 64-bit layout UNVERIFIED (no `SaveBlock1ToSaved`, 20 secret bases) |
| PokeEme (HD-2D) | github.com/brunocastro-trindade/PokeEme (created 2026-10-12) | Emerald (on Kurausukun's pc_port) | New | Linux (`pokeemerald64`), Switch homebrew | Switch: `sdmc:/switch/pokeemerald/`. Linux: working directory (UNVERIFIED) | The README says "same format as emulators (128 KB `.sav`)". The 64-bit Linux layout is UNVERIFIED (see the NTx86 row) |
| **Emerald 3DS** | github.com/ZallaxDev/pokeemerald-3Ds-dualscreen (repo moved/renamed. Web builder at emerald-3ds.com) | Emerald | Releases v0.x | Nintendo 3DS homebrew (`/3ds/emerald3ds/Emerald3DS.3dsx`) | `emerald3ds.sav` (the exact folder is UNVERIFIED, probably `/3ds/emerald3ds/`), plus `emerald3ds.clock` / `.clock.bak` | README: "GBA save format stays original". ARM32, so RAW |
| Emerald Dual Screen | github.com/psspssr/pokeemerald-3Ds-dualscreen-thor (v0.1.0-beta.4) | Emerald | Beta | Android (ARMv7 APK, AYN Thor) | App-private. **Settings → Saves & data → Import save / Export save** | RAW (the README says standard GBA/emulator `.sav` files are supported) |
| FireRed Dual Screen | github.com/venom13/pokefirered-dualscreen (v0.2.0, Sept 2026) | FireRed | Experimental | Android | `Android/data/com.pokefirered.dualscreen/files/pokefirered.sav` | **RAW**, "131,072 bytes". Import by copying an emulator save in under that name |
| **PokeRecomp** | github.com/sonsegajp/PokeRecomp (11★, push 2026-10-14) | FR, LG, E (R/S listed but not yet available). Online worlds | Releases (Windows zip) | Windows 10/11. Each game is a native DLL, described as "C calling convention, 32-bit" (`docs/GAME_DLL.md`) | `--data-dir` (default save `firered.sav` etc. in the data dir). `--save-file PATH` links any cartridge `.sav` | **RAW** 128 KiB (a 32-bit build keeps the GBA struct layout. Inferred, no sample). Its launcher only accepts complete, checksum-valid slots and shows 64 KiB saves read-only (`docs/LAUNCHER.md`) |
| pokefirered-native | github.com/xinpw8/pokefirered-native (Mar-Apr 2026) | FireRed | A research "rehost slice" (headless agent tooling), not a player release | Linux | `--save-path` | 128 KiB `.sav` (`src/host_flash.c`, per format-gen3) |
| pokeemerald-expansion-native | github.com/uehlbran/pokeemerald-expansion-native (Oct 2026, no releases) | pokeemerald-expansion (ROM-hack engine) | CI only | 32/64-bit desktop | — | **Not interchangeable**. The README says "No save interchange with the GBA, in either direction". Reject |
| HeartSoulRecomp | github.com/aabrole/HeartSoulRecomp (test build 0.4.0) | "Pokémon Heart & Soul", a GBA-engine fan remake of HGSS, **not** HGSS | Test build | Android (`Android/data/com.heartsoul.recomp/files/pokeemerald.sav`) | — | "Saves are not compatible with the GBA version or emulators." Out of scope. The file name `pokeemerald.sav` can fool name-based detection, and our Gen 3 detection will refuse it because the layout differs |
| pokeemerald-rs | github.com/LunchBox951/pokeemerald-rs | Emerald (Rust rewrite) | "Pre-alpha. The Rust workspace is not scaffolded yet" | — | — | Does not exist yet in any playable form |

### 1.6 Nintendo DS (Gen 4)

| Project | Repo | Games | Status | Platforms | Save location | Format |
|---|---|---|---|---|---|---|
| **Pokémon Platinum PC Port** | github.com/cybervisi0n/pokeplatinum, branch `pc_port` (130★, created 2026-06-13, push 2026-10-10). Uses github.com/cybervisi0n/libntr (MIT NitroSDK replacement, push 2026-10-09) | Platinum US (CPUE) only. Other languages by swapping message archives | "Should be playable start to finish, may crash". Prebuilt binaries | Windows, Linux (64-bit). Console homebrew is a long-term goal | `save.bin` in the **current working directory** (normally the folder of `main.exe`, where the ROM is extracted) | **RAW-var**: libntr `include/nitro/card/backup.h` with `SDK_PORT`. The first read creates the file, filled with **0x00**, at length `src+len` of that read. Writes `fseek`+`fwrite` and grow the file. The DS flash offsets are unchanged. Verified (code). See format-gen4 §17 |
| **ssrecomp** | github.com/ClickingMaster/ssrecomp (GPL-3, 111★, created 2026-10-14, push 2026-10-22). **Unmaintained**: the README now points to pokeheartgold-single-screen | SoulSilver US. ARM9 code statically recompiled to C++ from the pokeheartgold build. The DS hardware (cartridge, save memory, ARM7) comes from a vendored **melonDS 1.1** core | v0.3.x | Linux x86_64/aarch64, Windows, macOS (Apple Silicon), Android APK | Setup-built: `~/.local/share/ssrecomp`, `%LOCALAPPDATA%\ssrecomp`, `~/Library/Application Support/ssrecomp`. Dev `run.sh`: `soulsilver.sav` next to the script. `--save my.sav` overrides | **RAW** 512 KiB (the save memory is melonDS's). Android: app storage, deleted on uninstall |
| pokerecomp | github.com/LordPain11/pokerecomp (fork of ssrecomp, 2026-10-19) | SoulSilver **and HeartGold** | Fork | Same | `heartgold.sav` / `soulsilver.sav`, same folders | **RAW** 512 KiB |
| pokeheartgold-single-screen | github.com/ClickingMaster/pokeheartgold-single-screen (MIT frontend, 36★, created 2026-10-21) | HG/SS decomp with a `SINGLE_SCREEN` build, plus frontend | New. Setup programs for Windows and Linux | Windows, Linux | UNVERIFIED (probably like ssrecomp) | The single-screen changes are UI-only per its README, so presumably RAW (UNVERIFIED) |
| **pspoke** | github.com/IbrahimIrfan/pspoke (GPL-3, 22★, Sept 2026, beta) | Platinum, SoulSilver compiled natively for PSP | Beta | Sony PSP | `PSP/GAME/NativePlatinum/Platinum.native.sav`, `PSP/GAME/NativeSoulSilver/SoulSilver.native.sav` | **RAW**: "normal 512 KB DS saves. You can bring over a save from a DS emulator" |
| **nativeplat** (DS half) | github.com/sohamb117/gen4recomp | D, P, Pt (Rev 1), HG, SS (USA) via pret, wasm, wasm2c | Boots. Feature parity documented per game | macOS, Windows | `saves/<game>/<slot>.sav` in the SDL pref path (§1.4) | **RAW** 512 KiB. Imports must be exactly 512 KiB or a `.dsv` (footer stripped) |
| gen2recomp | §1.3 | Pt, HG, SS in Lua | — | — | — | **FOREIGN** |

No Diamond/Pearl-only PC port and no HGSS libntr port were found.

### 1.7 Nintendo DS (Gen 5)

| Project | Repo | Games | Status | Platforms | Save location | Format |
|---|---|---|---|---|---|---|
| **Frigate** | github.com/CallanCampos/Frigate (pokebw2 tree + `port/`, GPL-3, created 2026-10-17, push 2026-10-24) | Black 2 / White 2 (US) | WIP: on 2026-10-24 it reaches Aspertia City. **Battles are not yet playable**. Builds are made locally and never distributed | macOS (first), Windows, Linux | `--save-dir`, else `~/Library/Application Support/Frigate`, `$XDG_DATA_HOME/Frigate` or `~/.local/share/Frigate`, `%APPDATA%\Frigate`. Named by game code: `IREO.sav` (B2 US), `IRDO.sav` (W2 US) | **RAW**, exactly 524,288 bytes, "the same file as melonDS's `.sav` … byte for byte". **Refuses** any other size and never overwrites it (it names `.dsv` and 0xFF-padded files specifically). Written whole via temp file + rename. Verified (docs, `port/README.md` "Saves") |
| **eidos** | github.com/Project-Holon/eidos (MIT, 12★, created 2026-09-16, push 2026-10-24) on the `aletheia` Black decompilation | Black (US/EU) | "Field, battles, menus and saves in the opening hours". Not yet completable | Windows (installer/zip). macOS and Linux code paths exist | `%APPDATA%\eidos\saves\`, `$XDG_DATA_HOME/eidos/saves` or `~/.local/share/eidos/saves`, `~/Library/Application Support/eidos/saves`. `portable.txt` next to the exe gives `saves\` beside it. Main file `pokeblack.sav`. Extra slots `slots/save<N>.sav`, current slot in `slot.txt` | **RAW** 0x80000 (`sdk/plat_save.c`, `sdk/save_slots.c`, `tests/test_backup.c`: a blank chip reads 0xFF, a long file is truncated to the chip size, a short file is padded with 0xFF, writes are atomic). Verified (code) |
| Isshu | github.com/Goldoire/Isshu (2026-09-29) on `pokeblack` | Black (IRBO) | "Early development, not yet a playable full game" | Windows | — | n/a |
| nativeplat (BW half) | github.com/sohamb117/gen4recomp | Black, White (USA/EU) via the `ndsrec`/`armrec` static recompilers | Boots | macOS, Windows | §1.4 | **RAW** 512 KiB |
| gen2recomp | §1.3 | B, W in Lua | — | — | — | **FOREIGN** |

### 1.8 What is rumour or does not exist (as of 2026-10-24)

- No official Gen 1/2 release on Switch/NSO, and no official Gen 3-5 release except Switch FR/LG.
- No B2W2 port that can be played to the end (Frigate is mid-bring-up). No complete BW port (eidos
  covers the opening hours only).
- No native Ruby/Sapphire decomp PC port beyond nativeplat and the gbarecomp recompilation.
- `gen1recomp[.]com` is an impersonation site, not the project (both G1R and gen2recomp say so).
- pokeemerald-rs and BurgerBlaze's Crystal Android port have no usable output.

---

## 2. Emulators and their save formats

### 2.1 Base image sizes (what is inside every container)

| Games | Chip | Image size | Notes |
|---|---|---|---|
| R/B (MBC3, no RTC), Yellow (MBC5) | SRAM | 0x8000 (32 KiB) | Gen 1 never has an RTC, so any trailer on a Gen 1 file is foreign and kept verbatim |
| G/S/C INT/KOR, G/S JP (MBC3 + RTC) | SRAM | 0x8000 | RTC trailers are common |
| Crystal JP | SRAM | 0x10000 (64 KiB). Also accept 0x8000 | format-gen1-gen2 §0/§2 |
| R/S/E (Flash 1M + RTC), FR/LG (Flash 1M, no RTC) | Flash | 0x20000 (128 KiB) | 0x10000 = a misconfigured 64 KiB emulator, read-only (format-gen3 §2.1) |
| DPPt, HGSS, BW, B2W2 | SPI flash | 0x80000 (512 KiB) | Blank = 0xFF. HGSS/BW/B2W2 carts are "IR" carts in melonDS (`irversion = 2`), with the same 4 Mbit flash |

### 2.2 Game Boy RTC trailers (MBC3, Gen 2)

The trailer follows the SRAM image immediately (offset 0x8000, or 0x10000 for JP Crystal).
**We never interpret it. We store it and re-append it verbatim.** The layouts are listed only so
that size checks can name what they found.

| Size | Written by | Layout | Source |
|---|---|---|---|
| **48** | BGB (defines it), VBA-M, mGBA, SameBoy, FlashGBX (cartridge dumps), Gearboy | 10 × u32 LE: live seconds, minutes, hours, days-low, days-high (flags), then the same five latched values, then a **u64 LE** UNIX timestamp of the save time. Each register sits in the low byte of its dword. A dumper with no clock writes `FF FF FF 7F FF FF FF 7F` as the timestamp | bgb.bircd.org/rtcsave.html. mGBA `GBMBCRTCWrite`/`struct GBMBCRTCSaveBuffer` (`src/gb/mbc.c`, `mbc.h`). VBA-M `MBC3_RTC_DATA_SIZE = 10*sizeof(int)+8` (`gbMemory.h`). SameBoy `rtc_save_t.vba64` (`Core/gb.c`). FlashGBX `GetRTCBufferSize() = 0x30` (`Mapper.py`) |
| 48 (variant) | Gearboy | 11 × s32 + 4 padding bytes. The time is an s32 at offset 40, and the high 4 bytes are 0. Until 2038 this equals the BGB layout | Gearboy `MBC3MemoryRule::SaveRam`, `struct RTC_Registers` |
| **44** | old VisualBoyAdvance (2005 era), "vba32" | Same layout with a u32 timestamp | BGB page, SameBoy `rtc_save_t.vba32`. VBA-M and mGBA read it (VBA-M load tolerance `-4`, mGBA accepts `sizeof-4`) |
| 13 / 9 | very old SameBoy ("sameboy_legacy") | 5 register bytes + native `time_t` (8 or 4 bytes, host endianness), packed | SameBoy `rtc_save_t.sameboy_legacy`. Rare. Load-only in current SameBoy |
| *(none, sidecar)* | Gambatte (standalone), RetroArch (all GB cores), Delta (iOS), gb-recompiled ports, OpenEmu's Gambatte core | The `.sav` is pure SRAM. The RTC goes to a separate `.rtc` file | §2.3 |

PKHeX accepts any trailer whose length (`size & 0x3F`) is even and between 0x0C and 0x30, plus 7
bytes (FlashGBX), after a 0x8000, 0x10000 or 0x20000 image (`SaveHandlerFooterRTC.cs`). Our rule
(§3.2) is a superset of that.

### 2.3 Game Boy `.rtc` sidecars (never uploaded, listed for completeness)

| Writer | `.rtc` content | Source |
|---|---|---|
| RetroArch + Gambatte core | `RETRO_MEMORY_RTC` = Gambatte's `time_t` base time (8 bytes on 64-bit hosts, host byte order) | gambatte-libretro `cartridge_libretro.cpp` `rtcdata_size` |
| RetroArch + mGBA core | the 48-byte BGB block (`RETRO_MEMORY_RTC` points just past SRAM) | mGBA `src/platform/libretro/libretro.c` |
| RetroArch + SameBoy core | SameBoy's internal RTC section (size UNVERIFIED) | SameBoy `libretro.c` `GB_SECTION_SIZE(rtc)` |
| gambatte-speedrun (standalone) | 8-byte big-endian timestamp + 14 register bytes (22 bytes) | `gambatte-core` `cartridge.cpp` `saveSavedata` |
| original Gambatte (sinamas) | 4-byte big-endian base time (from memory, UNVERIFIED: the sinamas repo now holds only a README) | — |
| gb-recompiled (arcanite24 upstream, mstan fork) | 40-byte `GRTC` struct (u32 magic 0x47525443, u32 version, u64 time, u64 cycle remainder, 11 register/latch bytes) | `runtime/src/gbrt.c` |
| sp00nznet fork | "48-byte BGB-compatible" (README) | sp00nznet READMEs |

RetroArch names the sidecar by swapping the `.srm` extension for `.rtc` (`save.c`
`path_init_savefile_rtc`).

### 2.4 Game Boy Advance trailers

| Size | Written by | Layout | Source |
|---|---|---|---|
| **16** | mGBA (standalone, R/S/E only, because only those carts have the RTC GPIO), FlashGBX (from the version that matched mGBA 0.10) | `u8 time[7]` BCD (year, month, day, weekday, hour, minute, second), `u8 control`, `u64 LE` last-latch UNIX time. Written at `size & ~0xFF`, so a footer is always shorter than 0x100 | mGBA `GBASavedataRTCWrite` (`src/gba/savedata.c`). FlashGBX `LK_Device.py` (7 RTC bytes + status + `<Q` timestamp), `CHANGES.md` |
| **7** | old FlashGBX (before mGBA compatibility) | 7 raw RTC bytes | PKHeX `SaveHandlerFooterRTC` exception "lesserkuma/FlashGBX >v2.0" |
| none | VBA-M, VisualBoyAdvance, gpSP, mGBA **libretro**, Delta (VBA-M core), nativeplat, gbarecomp, decomp ports | — | VBA-M `CPUWriteBatteryFile` writes only `flashSaveMemory[g_flashSize]`. mGBA libretro has no GBA `RETRO_MEMORY_RTC`. gpSP libretro always reports **0x20000** save RAM, whatever the game |

### 2.5 Nintendo DS containers

| Container | Shape | Detect | Source |
|---|---|---|---|
| raw (melonDS standalone and libretro "melonDS DS", most flashcarts, Checkpoint/GodMode9/JKSM dumps, TWiLight/nds-bootstrap, nativeplat, Frigate, eidos, pspoke, ssrecomp) | 0x80000 | size | melonDS `SaveManager.cpp` writes the backup buffer as-is. melonDS DS `GetMemorySize(RETRO_MEMORY_SAVE_RAM) = SramLength()` |
| raw, over-long | 0x80000 + 0xFF padding (melonDS with a wrongly guessed size) | bytes past 0x80000 all 0xFF | format-gen5 §2, Frigate README |
| **DeSmuME `.dsv`** | image + **122-byte footer**: the 82-byte ASCII text `\|<--Snip above here to create a raw sav by excluding this DeSmuME savedata footer:`, then six u32 LE (bytes actually written, padded size, save type, address size, memory size, version = 0), then the 16-byte cookie `\|-DESMUME SAVE-\|` | ends with the cookie, u32 at `len-20` is 0 | DeSmuME `src/mc.cpp` (`DESMUME_BACKUP_FOOTER_TXT`, `kDesmumeSaveCookie`, `readFooter`). DeSmuME grows the data part to the next save-type size as the game writes, so for these games it is 0x80000 (PKHeX accepts only 0x8007A) |
| DraStic `.dsv` (Android) | reports **conflict**: some say a raw image, others the DeSmuME footer | cookie present or not | DeSmuME forum threads, ProjectPokémon guide. UNVERIFIED |
| **Action Replay DS / Max Drive `.duc` / `.dss`** | 0xA4-byte header + 0x80000 | exact size 0x800A4 | PKHeX `SaveHandlerARDS.cs` (no header validation) |
| **No$GBA** (also used for GBA saves) | header: ASCII `NocashGbaBackupMediaSavDataFile` (31 bytes), 0x1A at 0x1F, other fields 0x20-0x3F (meaning unknown, keep verbatim), ASCII `SRAM` at 0x40, u32 method at 0x44. Method 0: u32 size at 0x48, data at 0x4C. Method 1 (compressed. Reportedly the default before users switch No$GBA to "raw"): u32 packed size at 0x48, u32 unpacked size at 0x4C, data at 0x50 | magic | DeSmuME `mc.cpp` `readNoGbaSaveInfo`/`no_gba_unpackSAV` (read for the format only). mGBA forum: No$GBA's ini can switch to "raw" saves |
| No$GBA RLE (method 1) | a stream of control bytes `c`: `0` = end. `1..0x7F` = copy the next `c` bytes literally. `0x80` = one value byte, then a u16 LE count, then fill. `0x81..0xFF` = one value byte repeated `c-0x80` times | — | same |
| libntr `save.bin` (Platinum PC port) | DS offsets, **0x00-filled**, length = whatever has been read or written so far (≤ 0x80000) | file name `save.bin`, or a short file whose Gen 4 footers validate after padding | libntr `include/nitro/card/backup.h` |

### 2.6 Wrappers that can hold any generation

| Wrapper | Layout | Notes |
|---|---|---|
| **RetroArch RZIP** (`.srm` with "SaveRAM compression" on; off by default, `DEFAULT_SAVE_FILE_COMPRESSION false`) | 20-byte header: `#RZIPv`, a version byte (1 = deflate, 2 = zstd), `#`, u32 LE uncompressed chunk size (default 131072), u64 LE total uncompressed size. Then chunks of u32 LE compressed length + data | **Current RetroArch writes version 2 (zstd) whenever it was built with zstd** (`rzip_write_codec`, libretro-common `streams/rzip_stream.c`, RetroArch `ae6b6ee` 2026-10-24). RetroArch always reads SRAM through the RZIP reader, which also accepts uncompressed files (`save.c`: "this will automatically handle uncompressed data"). It truncates an over-long file to the core's size with a warning. **So we can always hand back an uncompressed `.srm`** |
| **NSO GB/GBC** | `SRAM` magic (4), u32 (=3?), ROM SHA-1 as 40 ASCII hex at 0x08, u32 build-string length at 0x30 (< 256), build string at 0x34, u8 hasRTC, optional 0x20 RTC bytes, the SHA-1 of the payload as 40 **lowercase** ASCII hex, then the raw SRAM. Total = SRAM + 0x68..0xA0 | Re-sign: recompute the SHA-1 of the payload and rewrite the 40 hex characters (PKHeX `SaveHandlerNSO.Finalize`). Needs a **synchronous SHA-1** in `shared/bytes.js` (WebCrypto is async) |
| EmulatorJS (browser) | the libretro core's save RAM, from its virtual FS (persisted in IndexedDB). "Export save file" gives `<game>.srm` or the core's own extension (`core.save`) | GB → Gambatte (raw SRAM, the RTC goes to a separate `.rtc` in its FS and is not exported), GBA → mGBA (0x20000), NDS → melonDS/DeSmuME cores |

### 2.7 Per-emulator summary

| Emulator | Systems | File / extension | Gen 2 | Gen 3 | Gen 4/5 | Default location |
|---|---|---|---|---|---|---|
| mGBA (standalone) | GB, GBA | `<rom>.sav` | 0x8030 | 0x20000 FR/LG, **0x20010** R/S/E | — | next to the ROM (Settings → Paths) |
| mGBA (libretro) | GB, GBA | `.srm` (+ `.rtc` for GB) | 0x8000 | 0x20000 | — | RetroArch `saves/mGBA/` |
| VBA-M | GB, GBA | `.sav` | 0x8030 | 0x20000 (0x10000 if misconfigured) | — | next to the ROM (configurable battery dir) |
| VisualBoyAdvance 1.7/1.8 | GB, GBA | `.sav` | **0x802C** | 0x10000 unless set to "Flash 128K" (classic Pokémon pitfall) | — | next to the ROM |
| No$GBA | GBA, NDS | `BATTERY\<rom>.SAV` | — | No$GBA header (§2.5) | No$GBA header | No$GBA folder |
| gpSP (libretro) | GBA | `.srm` | — | always 0x20000 | — | RetroArch |
| SameBoy | GB | `.sav` | 0x8030 (reads 44, 48, legacy) | — | — | next to the ROM |
| SameBoy (libretro) | GB | `.srm` + `.rtc` | 0x8000 | — | — | RetroArch |
| Gambatte / gambatte-speedrun | GB | `.sav` + `.rtc` | 0x8000 | — | — | save dir (UNVERIFIED default) |
| Gambatte (libretro) | GB | `.srm` + `.rtc` | 0x8000 | — | — | RetroArch `saves/Gambatte/` |
| BGB | GB | `.sav` | 0x8030 (format author) | — | — | next to the ROM (Windows/Wine) |
| Gearboy | GB | `.sav` | 0x8030 | — | — | next to the ROM or its save dir |
| Emulicious | GB | `.sav` | UNVERIFIED (assume a 48-byte BGB trailer or raw) | — | — | UNVERIFIED |
| melonDS (standalone) | NDS | `<rom>.sav` | — | — | 0x80000 | next to the ROM (Config → Paths) |
| melonDS DS (libretro) | NDS | `.srm` | — | — | 0x80000 | RetroArch `saves/melonDS DS/` |
| legacy melonDS libretro | NDS | `<game>.sav` in the RetroArch save dir (exposes no `RETRO_MEMORY_SAVE_RAM`) | — | — | 0x80000 | RetroArch save dir |
| DeSmuME (standalone) | NDS | `.dsv` | — | — | **0x8007A** | `Battery\` (Windows build). Can also import and export raw `.sav` |
| DraStic | NDS (Android) | `DraStic/backup/<rom>.dsv` | — | — | 0x80000 or 0x8007A (UNVERIFIED) | device internal storage |
| My Boy! / My OldBoy! | GBA / GB (Android) | `.sav` | UNVERIFIED | 0x20000 expected (UNVERIFIED RTC handling) | — | `MyBoy/save/` (ProjectPokémon), or a folder chosen in settings |
| John GBA / GBC, Pizza Boy GBA / GBC (Android) | GBA / GB | `.sav` | UNVERIFIED | UNVERIFIED | — | app-specific (UNVERIFIED) |
| Delta (iOS) | GB(C) Gambatte, GBA VBA-M, NDS melonDS | stored inside the app. Exported via the game's context menu | 0x8000 (+ separate `.rtc`) | 0x20000 | 0x80000 | export/import from the app (`GBCEmulatorBridge.mm`, `GBAEmulatorBridge.mm`, `MelonDSEmulatorBridge.mm`) |
| OpenEmu (macOS) | GB (Gambatte), GBA (mGBA), NDS (DeSmuME / melonDS) | `.sav` | 0x8000 (+ `.rtc`, by Gambatte's behaviour, UNVERIFIED) | likely 0x20010 for R/S/E with the mGBA core (UNVERIFIED) | `.dsv` or `.sav` by core (UNVERIFIED) | `~/Library/Application Support/OpenEmu/<Core>/Battery Saves/` (OpenEmu wiki, mGBA core) |
| RetroArch (any core) | all | `<content>.srm` (+ `<content>.rtc`) | per core | per core | per core | `saves/<Core name>/` (sort by core is on by default: `DEFAULT_SORT_SAVEFILES_ENABLE true`) |
| EmulatorJS | all | download from its menu | 0x8000 | 0x20000 | 0x80000 | browser IndexedDB |
| 3DS VC (Gen 1/2) | GB(C) | `sav.dat` (via Checkpoint) | 0x8000. Reports of files slightly above 32 KiB ("32.02 KB") suggest a small trailer (UNVERIFIED) | — | — | Checkpoint `/3ds/Checkpoint/saves/<title>/<backup>/`. When restoring, the anti-rollback **secure value** may need clearing (3dbrew "3DS Virtual Console") |
| Cartridge dumpers (FlashGBX/GBxCart, GB Operator, Joey Jr) | GB, GBA | `.sav` | 0x8000 or 0x8030 (optional RTC) | 0x20000 or 0x20010 | — | user-chosen |

---

## 3. Recommendations

### 3.1 Accepted input formats

Accept **any file name and extension**: `.sav`, `.srm`, `.dsv`, `.duc`, `.dss`, `.dat` (VC),
`.bin` (libntr), `.SAV` and whatever else users have. Detect by content and size only. Use the
file name only as a hint: `save.bin` means zero padding, `sav*.dat` means 3DS VC, and
`FireRed_*`/`LeafGreen_*` means the Switch release.

Accepted (read and write):

1. Raw images of 0x8000, 0x10000, 0x20000 and 0x80000 bytes.
2. A raw image plus a trailer of 1..0xFF bytes (GB/GBA RTC). Known sizes: GB 48, 44, 13, 9. GBA
   16, 7.
3. DeSmuME `.dsv` (cookie footer), Action Replay DS (0x800A4), the NSO `SRAM` header, No$GBA
   (methods 0 and 1).
4. RetroArch RZIP, version 1 (deflate) via `DecompressionStream('deflate')`. Version 2 (zstd)
   only if we vendor an MIT zstd decoder (for example `fzstd`, MIT, about 8 KB, as a plain ES
   module with no build step). Otherwise refuse with: *"Turn off Settings → Saving → SaveRAM
   Compression in RetroArch, load the game, save in-game once, then upload again."*
5. Short NDS images (libntr `save.bin`), padded virtually.
6. Over-long NDS images whose tail is all 0xFF.

Accepted read-only (with an explanation):

- Gen 3 half saves (0x10000 that are not JP Crystal).
- Gen 3 "old 64-bit" NTx86 layout, until the format-gen3 owner decides how far writes are safe
  (§3.4).

Refused with a specific message:

- Save states (`.ss0`, `.state`, `.oesavestate`, `.pfrstate`, mGBA `.ss1`, RetroArch `.state*`),
  detected by size or magic. Tell the user to save in-game and upload the battery save instead.
- LÖVE `save.lua` (starts with ASCII `return {` or similar text). Tell the user to use G1R or
  gen2recomp's **Export save**.
- ROM-hack engines (pokeemerald-expansion-native, HeartSoulRecomp, Yellow Extended,
  Polished Crystal and similar). These fail game detection. Name the likely cause in the error.
- Japanese and Korean variants only where the format docs say so.

### 3.2 Container-detection algorithm (`shared/saves/container.js`)

Design: detection returns **candidate interpretations**, and `openSave` lets the generation
detectors choose among them. A size alone cannot separate, for example, a 0x10000 JP Crystal save
from a 0x10000 Gen 3 half save, or a 0x10010 JP Crystal + 16-byte trailer from an mGBA 64 KiB
Emerald.

```js
// shared/saves/container.js  (pure, no dependencies; unwrap/wrap are synchronous so that
// openSave/exportSave in index.js keep their synchronous contract. Only the optional
// decompression pre-pass is async: the UI awaits it before calling openSave.)
export const IMAGE_SIZES = [0x8000, 0x10000, 0x20000, 0x80000];

// -> Array<{ image: Uint8Array, info: ContainerInfo }>, best guess first. Never throws for an
//    unknown shape: it returns [] and openSave reports "not a supported save".
export function unwrap(bytes, filename = "") { … }

// info + (possibly modified) image -> the file to download.
// mode "same" re-creates the uploaded container. mode "raw" emits the bare canonical image.
export function wrap(info, image, { mode = "same" } = {}) { … }

// Optional async pre-pass for compression layers (RZIP). Returns the inner bytes and a layer
// record, or null when the bytes are not compressed.
export async function decompressOuter(bytes) { … }
```

```text
ContainerInfo = {
  kind:       "raw" | "trailer" | "dsv" | "ards" | "nso" | "nocash" | "short" | "padded",
  layers:     [ { kind: "rzip", version, chunkSize } ]   // outer layers, outermost first
  prefix:     Uint8Array   // bytes before the image, kept verbatim except for fields we must fix
  suffix:     Uint8Array   // bytes after the image (RTC trailer, DSV footer, 0xFF tail), verbatim
  imageLength,             // bytes of real image present in the file
  canonicalSize,           // 0x8000 | 0x10000 | 0x20000 | 0x80000
  padByte,                 // for "short": 0x00 (libntr) or 0xFF
  family,                  // "gb" | "gba" | "nds" | null (null = ask every detector)
  notes: string[]          // user-facing, for example "mGBA RTC record (16 bytes) kept"
}
```

#### Unwrap, in this order (the first match that applies builds the candidates)

0. **Compression (async, before `openSave`).** If `bytes[0..5] == "#RZIPv"`, `bytes[6]` is 1
   or 2 and `bytes[7] == "#"`:
   1. Read the chunk size (u32 LE at 8) and the total size (u64 LE at 12; refuse anything over
      16 MiB).
   2. From offset 20, repeat: u32 LE `n`, then `n` bytes, which are one zlib stream (v1) or one
      zstd frame (v2). Inflate each chunk and concatenate.
   3. Check that the total length equals the header's total size.
   4. Record the layer, then run steps 1-6 on the inner bytes.
1. **NSO.** If `len >= 0x8000`, the file starts with `SRAM`, and `len - B` is in `[0x68, 0xA0]`
   for `B` in {0x8000, 0x10000}:
   1. `L = bytes[0x30]`. `p = 0x34 + L`. `hasRtc = bytes[p++] != 0`. If set, `p += 0x20`.
      `hashOff = p`. `p += 40`.
   2. `prefix = bytes[0..p)`, `image = bytes[p..]`, `family = "gb"`.
   3. Verify the stored hash against `sha1hex(image)`. On a mismatch, add a warning and continue.
2. **No$GBA.** If `len >= 0x50`, the file starts with `NocashGbaBackupMediaSavDataFile`,
   `bytes[0x1F] == 0x1A` and `bytes[0x40..0x44) == "SRAM"`:
   1. Read `method = u32@0x44`. Method 0: `size = u32@0x48`, `off = 0x4C`. Method 1:
      `packed = u32@0x48`, `unpacked = u32@0x4C`, `off = 0x50`, then RLE-decode.
   2. Refuse it if `unpacked` is not one of `IMAGE_SIZES` (or 0x10000 for GBA 64 KiB).
   3. `prefix = bytes[0..off)`. `suffix` = the bytes after the data.
3. **DeSmuME.** If `len >= 0x7A`, the last 16 bytes are `|-DESMUME SAVE-|` and `u32@(len-20) == 0`:
   1. `suffix = last 0x7A bytes`, `image = bytes[0..len-0x7A)`, `family = "nds"`.
   2. If the image is shorter than 0x80000, use kind "short" with `padByte = 0xFF`.
4. **Action Replay DS.** If `len == 0x800A4`: `prefix = 0xA4 bytes`, `family = "nds"`. Keep this
   candidate only if a Gen 4/5 detector accepts the window. Otherwise fall through.
5. **Raw / trailer** (on the bytes left after steps 1-4). Let `L` be their length:
   - `L` in `IMAGE_SIZES`: one candidate, kind "raw". If `L == 0x10000`, the family is open
     (detectors decide between JP Crystal and a Gen 3 half save).
   - `B < L < B + 0x100` for `B` in {0x8000, 0x10000, 0x20000}: kind "trailer",
     `suffix = bytes[B..L)`. Note the known sizes (GB 48/44/13/9, GBA 16/7). Any other size gets
     the note "unknown trailer, kept unchanged". At `B = 0x10000` both GB and GBA are possible.
   - `0x80000 < L <= 0x100000` and `bytes[0x80000..L)` are all 0xFF: kind "padded",
     `suffix` = the tail.
   - `0x400 <= L < 0x80000`, and the file name is `save.bin` or the file's last 4 KiB are all 0x00:
     kind "short", `padByte = 0x00`, `canonicalSize = 0x80000`. If the name is unknown and the
     tail is 0xFF, use `padByte = 0xFF`. A file named `save.bin` **always** also gets a "short"
     NDS candidate, even when its length happens to equal 0x8000 or 0x20000, because libntr's
     length depends only on how far the game has read and written.
6. **Fallback (NDS only).** If `0x80000 < L <= 0x80400` and nothing matched, try each prefix
   length `p` in `[0, L - 0x80000]` and take the first window `bytes[p..p+0x80000)` that a
   Gen 4/5 detector accepts. Keep `prefix` and `suffix` verbatim, with the note "unknown
   container".

Then `openSave` runs, for each candidate (virtually padded to `canonicalSize` when the kind is
"short"), every generation detector compatible with `family`, and keeps the candidate with the
highest confidence. A tie between JP Crystal and a Gen 3 half save is broken by checksums: both
cannot validate.

#### Wrap (export)

- **mode `"same"`** (default): `prefix ⊕ image' ⊕ suffix`, with only these fix-ups:
  - *NSO*: write `sha1hex(image')` (lowercase) at `hashOff`.
  - *No$GBA*: method 0 rewrites `u32@0x48`. Method 1 re-encodes the image with our RLE encoder:
    runs of 3 or more become fills (`0x81..0xFF`, or `0x80` + u16 for longer runs), the rest are
    literal blocks of at most 0x7F bytes, and a final `0x00` ends the stream. Then update the
    packed size. Whether No$GBA accepts our encoding is UNVERIFIED, so the UI also offers
    "raw".
  - *short*: if every byte of `image'` past the original `imageLength` still equals `padByte`,
    trim back to `imageLength`. Otherwise emit the full 0x80000. For a `.dsv`, also set the
    footer's "bytes written" and "padded size" u32s (footer offsets 82 and 86) to 0x80000.
  - *trailer / padded / dsv / ards*: the suffix and prefix stay byte for byte.
  - *RZIP layer*: emit **uncompressed** and add the note "RetroArch reads uncompressed saves even
    with compression on" (verified in `save.c`). Optionally re-compress v1 with
    `CompressionStream('deflate')` per chunk, as an async export path.
  - The **length of the image region never changes**, except for the "short" extension. This is
    what keeps Frigate (exactly 524,288 bytes) and gbarecomp (≤ flash size) happy, as long as the
    user brought the file from that same program.
- **mode `"raw"`**: the bare image at `canonicalSize`, with short images padded with 0xFF.
  Offered as **"Download plain .sav (for another emulator or port)"**. Recommended when the user
  moves a save between programs, and required for Frigate, gbarecomp and nativeplat imports when
  the save came from DeSmuME or mGBA (R/S/E).
- Download under the uploaded file name, so the user can overwrite in place. Always tell them to
  keep the original as a backup.

#### Test vectors (synthetic, no real saves needed)

For each base size, wrap a random image in each container and check that `unwrap` then `wrap`
returns identical bytes:

- GB: 0x8000, plus a 48-byte trailer, a 44-byte trailer, and NSO with and without RTC.
- JP Crystal: 0x10000, plus 48.
- GBA: 0x20000, plus 16 and plus 7.
- NDS: 0x80000, DSV, ARDS, No$GBA m0 and m1, and 0x80000 + 0x80000 of 0xFF.
- A 0x6C123-byte zero-padded `save.bin`.

Two exceptions to "identical bytes":

- RZIP v1 around a 0x20000 image: `unwrap` must yield the image, and `wrap` emits the
  **uncompressed** `.srm` by design.
- No$GBA method 1 is byte-identical only for files our own encoder produced. A real No$GBA file
  may encode the same data differently.

Also check:

- After changing one byte, only that byte changes in the output (plus the NSO hash or the No$GBA
  packed data).
- RLE encode then decode is the identity.
- `wrap(..., {mode: "raw"})` length is in `IMAGE_SIZES`.

### 3.3 "Where is my save file?" (user-facing)

Short form for the widget's help panel. "Next to the ROM" means the same folder, same base name,
`.sav` extension. Items marked † are unverified defaults: tell users to check the program's settings.

| Program | Linux | Windows | macOS | Android / iOS / console |
|---|---|---|---|---|
| **mGBA** | next to the ROM | next to the ROM | next to the ROM | — |
| **RetroArch** (any core) | `~/.config/retroarch/saves/<Core>/<game>.srm`. Flatpak: `~/.var/app/org.libretro.RetroArch/config/retroarch/saves/<Core>/` | `<RetroArch folder>\saves\<Core>\` | `~/Library/Application Support/RetroArch/saves/<Core>/` † | Android `/storage/emulated/0/RetroArch/saves/<Core>/` (or `Android/data/com.retroarch/files/saves` †). iOS: Files → RetroArch → `saves` † |
| VBA-M / VisualBoyAdvance | next to the ROM | next to the ROM | next to the ROM | — |
| SameBoy, BGB, Gearboy | next to the ROM | next to the ROM | next to the ROM | — |
| No$GBA | — | `<No$GBA folder>\BATTERY\` (convert or let the widget unwrap) | — | — |
| **melonDS** | next to the ROM | next to the ROM | next to the ROM | melonDS Android: app storage † |
| **DeSmuME** | `~/.config/desmume/` † | `<DeSmuME folder>\Battery\<game>.dsv` | † | — |
| DraStic | — | — | — | `DraStic/backup/<game>.dsv` on internal storage |
| My Boy! | — | — | — | `MyBoy/save/` on internal storage (or the folder set in its settings) |
| John GBA / Pizza Boy | — | — | — | the app's save folder † (use the app's export if it has one) |
| Delta | — | — | — | iOS: long-press the game → export / import save file |
| OpenEmu | — | — | `~/Library/Application Support/OpenEmu/<Core>/Battery Saves/` | — |
| EmulatorJS sites | browser | browser | browser | browser: the emulator menu → Export / Import save file |
| 3DS Virtual Console (Gen 1/2) | — | — | — | Modded 3DS: Checkpoint → back up → `/3ds/Checkpoint/saves/<game>/<backup>/sav.dat`. Restore with Checkpoint |
| Switch FireRed/LeafGreen | — | — | — | Modded Switch only: back up with JKSV/Checkpoint. File `FireRed_*.sav` / `LeafGreen_*.sav` † |
| GB-Recomp / pgbcomp | next to the program (`pokered.sav`, …) | same | same | — |
| Crystal Recompiled (arcanite24) | `~/.cache/crystal-recompiled/user-data/` | `%LOCALAPPDATA%\Crystal Recompiled\user-data\` | `~/Library/Application Support/Crystal Recompiled/user-data/` | — |
| mstan R/B / Yellow recomp, sp00nznet G/S/C | next to the `.exe` (named by the ROM title, for example `PM_CRYSTAL.sav`) | same | same | — |
| suiCune | `baserom.sav` next to the program | same | — | — |
| G1R Deluxe / gen2recomp | use the app's **Export save** (`exports/<game>/` in `~/.local/share/love/pokemon-love2d/`) | `%APPDATA%\LOVE\pokemon-love2d\exports\<game>\` | `~/Library/Application Support/LOVE/pokemon-love2d/exports/` † | Android/iOS/Switch: the app's export |
| EmeraldRecomp / FireRedLeafGreenRecomp / RubySapphireRecomp | — | **next to your ROM**, same name, `.sav` | — | — |
| pokeemerald-native | `~/.local/share/pokeemerald/pokeemerald.sav` | `%APPDATA%\pokeemerald\` | `~/Library/Application Support/pokeemerald/` | — |
| pokeemerald-sdl2pc (NTx86) | `pokeemerald.sav` in the folder you start it from | same | — | — |
| PokeRecomp | — | its data folder (`firered.sav`, …) or the linked `.sav` | — | — |
| FireRed Dual Screen | — | — | — | `Android/data/com.pokefirered.dualscreen/files/pokefirered.sav` |
| Emerald Dual Screen, Emerald 3DS | — | — | — | the app's Export save. 3DS: `emerald3ds.sav` in `/3ds/emerald3ds/` † |
| nativeplat | `~/.local/share/nativeplat/nativeplat/saves/<game>/<slot>.sav` † | `%APPDATA%\nativeplat\nativeplat\saves\…` † | `~/Library/Application Support/nativeplat/saves/<game>/<slot>.sav` (or Export .sav in the launcher) | — |
| Platinum PC Port | `save.bin` next to `main` | `save.bin` next to `main.exe` | — | — |
| ssrecomp / pokerecomp | `~/.local/share/ssrecomp/` | `%LOCALAPPDATA%\ssrecomp\` | `~/Library/Application Support/ssrecomp/` | Android: app storage (lost on uninstall) |
| pspoke | — | — | — | PSP: `PSP/GAME/NativePlatinum/Platinum.native.sav`, `PSP/GAME/NativeSoulSilver/SoulSilver.native.sav` |
| Frigate | `~/.local/share/Frigate/IREO.sav` or `IRDO.sav` | `%APPDATA%\Frigate\` | `~/Library/Application Support/Frigate/` | — |
| eidos | `~/.local/share/eidos/saves/pokeblack.sav` | `%APPDATA%\eidos\saves\` | `~/Library/Application Support/eidos/saves/` | — |

### 3.4 Further recommendations

1. **Export-target hints.** After an edit, show what the download is ("RetroArch `.srm`,
   uncompressed", "DeSmuME `.dsv`, footer kept", "mGBA `.sav` with RTC record") and the one-click
   **plain .sav** alternative.
2. **Port-specific guards** (shown as warnings, decided by game detection, not by file names):
   - Gen 3 NTx86 64-bit layout (detected as in format-gen3 §2.3): the party, boxes and SaveBlock2
     dex flags are safe. Do not write SaveBlock1 beyond 0xC70 (seen copies 2/3) or recompute the
     last SaveBlock1 sector with the GBA length. Until that is implemented, make such saves
     read-only and point users to pokeemerald-native, which converts them.
   - libntr `save.bin`: keep the zero fill and the original length (§3.2 "short").
   - Frigate: if the user uploads a `.dsv` or a padded file and says it is for Frigate, offer only
     the plain export.
3. **Switch FireRed/LeafGreen + Pokémon HOME.** Pokémon withdrawn into a Switch save can be sent to
   HOME, which runs legality checks. Off by default (server setting): allow unofficial conversions
   (Gen 1/2 → 3) into saves whose file name marks them as the Switch release, and show a HOME
   warning. The name is our only signal, since the layout is assumed identical.
4. **Never require the RTC sidecar.** Tell Gen 2 users of RetroArch, Gambatte, Delta and the
   recompilations to replace only the `.sav`/`.srm` and leave `.rtc` alone.
5. **Atomic replacement in ports.** Frigate, gbarecomp, eidos and nativeplat write saves through a
   temporary file and rename it. Users must quit the game before replacing the file, or the
   running game overwrites the widget's version on its next flush. Show this in the help text
   for every program: "Close the game or emulator before you replace the file."
6. **Phone emulators** whose format is UNVERIFIED (My Boy!, John GBA, Pizza Boy, DraStic): the
   generic detector handles any trailer below 0x100 bytes and the DSV cookie. Collect one real
   sample of each before claiming support in the UI.

---

## 4. Reconciliation with the format-gen*.md container sections

| Topic | Format doc says | This research | Verdict |
|---|---|---|---|
| Gen 1/2 raw sizes, 44/48-byte trailers, NSO header, VC `sav.dat` | format-gen1-gen2 §2 | Same. Re-verified in mGBA, VBA-M, SameBoy and Gearboy source, and on the BGB page | **Agree**. Add: Gearboy also writes 48 (s32 time + padding), and very old SameBoy wrote 13/9 bytes |
| PKHeX footer tolerance 0x0C-0x30 even, plus 0x07 | gen1-gen2 §2, gen3 §2.1 | Same code read (`SaveHandlerFooterRTC.cs`, PKHeX `a9ff306`). 0x07 comes from old FlashGBX **GBA** dumps. FlashGBX GB RTC is 48 and its GBA RTC is now 16 | **Agree**. Our rule (any 1..0xFF) is a superset |
| gb-recompiled `.rtc` = "48-byte BGB-compatible sidecar" | gen1-gen2 §2 [ports] | That is the **sp00nznet** fork's README. The upstream arcanite24 and mstan runtimes write a 40-byte `GRTC` struct | **Partial conflict**, harmless (it is a sidecar) |
| Gambatte `.rtc` format UNVERIFIED | gen1-gen2 §2 | libretro: `time_t` base time (8 B). gambatte-speedrun: 22 B. Original sinamas: 4 B BE (UNVERIFIED) | **Resolved** (still irrelevant to parsing) |
| G1R Deluxe import/export of `.sav` UNVERIFIED | gen1-gen2 §2 | It converts both ways (`docs/save-conversion.md`): Gen 1/2/3, English only. Its Switch doc still says Gen 2 export is unsupported | **Resolved** with a noted internal conflict in G1R's docs |
| JP Crystal VC size | gen1-gen2 §2: UNVERIFIED | Still UNVERIFIED. New: reports that VC GB saves are slightly over 32 KiB ("32.02 KB"), which suggests a small trailer. The generic trailer rule covers it | **Open** |
| Gen 3 0x20000 / 0x20010 mGBA footer at `size & ~0xFF` | format-gen3 §2.1 | Same (mGBA `savedata.c`). Note: mGBA **libretro** writes no GBA RTC, and gpSP libretro always writes 0x20000 | **Agree** |
| RZIP: "Version 2 (zstd) needs a library" | gen3 §2.1 | Current RetroArch writes **v2 by default** when built with zstd (`rzip_write_codec`). Compression itself is off by default. RetroArch reads uncompressed saves anyway, so exporting uncompressed is safe | **Agree, with emphasis**: v2 is the likely case when compression is on |
| Gen 3 detection "0x20000 + n, 0 ≤ n ≤ 0x40" | gen3 §2.1 | mGBA's placement rule allows a trailer up to 0xFF. Known trailers are 16 and 7 | **Minor**: allow up to 0xFF and warn on unknown sizes |
| EmeraldRecomp file name/container UNVERIFIED | gen3 §2.1 | `<ROM name>.sav` next to the ROM. Raw 0x20000. **Refuses larger files**. No RTC persisted (gbarecomp `runtime.cpp`, `gba_rtc.cpp`) | **Resolved** |
| 64-bit decomp-port layout caveat | gen3 §2.3 | Confirmed in NTx86 code (`IS64BIT ?= 1`, `SECRET_BASES_COUNT` 10 under `VER_64BIT`). alanb2305 converts. PokeRecomp is 32-bit DLLs, nativeplat is wasm32, the Android and 3DS ports are 32-bit. gradenGnostic desktop is UNVERIFIED | **Agree**, more ports classified |
| Switch FR/LG | gen3 §2.1: released 2026-02-27, PKHeX name check, UNVERIFIED sample | PKHeX `a9ff306` still has the same check. Release facts confirmed (VGC, ConsolePulse). HOME support from October 2026 | **Agree**, still no sample |
| NDS raw 0x80000, DSV 0x7A, ARDS 0xA4 | format-gen4 §2, gen5 §2 | Same. DSV inner fields documented (§2.5) | **Agree** |
| No$GBA | gen4 §2: UNVERIFIED. gen5 §2: "not handled by PKHeX, reject" | Format known from DeSmuME's importer (header 0x4C/0x50, RLE). It is also used for GBA saves | **Changed**: support reading it, write it back (export UNVERIFIED), always offer raw |
| DraStic | gen5 §2: "believed DeSmuME format, UNVERIFIED" | Reports conflict (raw vs footer). Cookie detection handles both | **Open** (handled generically) |
| Platinum PC port `save.bin` | gen4 §17 | Same libntr code read. Zero fill, grows on demand, DS offsets | **Agree** |
| "No HGSS or DP PC ports or static recompilations were found as of 2026-10" | gen4 §17 | **They exist**: ssrecomp (SoulSilver, 2026-10-14), LordPain11/pokerecomp (HG+SS), pokeheartgold-single-screen, pspoke (Platinum+SoulSilver on PSP), nativeplat (D/P/Pt/HG/SS). All write raw 512 KiB saves (a melonDS core or native) | **Conflict, update gen4 §17** (no format impact) |
| "No BW PC port exists as of 2026-10-24" | gen5 §14 | **eidos** (Black, playable opening hours, Windows releases, raw `pokeblack.sav`), **Isshu** (early), **nativeplat** (B/W static recomp, raw 512 KiB), gen2recomp (Lua) | **Conflict, update gen5 §14** (no format impact) |
| IRBO / IRAO game codes UNVERIFIED | gen5 §2 | **IRBO = Black (USA/EU)** confirmed by the Isshu README (SHA-1 `26ad0b99…`, the same SHA-1 nativeplat lists for Black). White's code is still UNVERIFIED (nativeplat lists White's SHA-1 `bc696a0d…` without a code) | **Partly resolved** |
| Frigate: exact 0x80000, refuses other sizes, `IREO.sav`/`IRDO.sav`, folders | gen5 §2/§14 | Same (`port/README.md` "Saves"). Status 2026-10-24: up to Aspertia City, battles pending, **never distributed** (build locally) | **Agree**. Add the status |

---

## 5. Sources

Code read (clones or raw files under `/tmp/claude-1000/pkres/ports-emulators/`):

- mstan/gbarecomp `src/runtime/runtime.cpp`, `src/runtime/launcher_seam.h`, `src/gba/gba_rtc.cpp`,
  `save_config.cpp` (commit `7bb70ec`, 2026-10-23). EmeraldRecomp / FireRedLeafGreenRecomp
  `variants/*/game.toml`, `game.toml`.
- mstan/gbrecompiled `runtime/src/gbrt.c`, `runtime/src/platform_sdl.cpp`, `gb_host_paths.c`
  (2026-10-18). arcanite24/gb-recompiled `test_persist.cpp`,
  `ports/pokemon-crystal/{README.md,PACKAGING.md,scripts/first_run.py}`.
- NTx86/pokeemerald-sdl2pc `src/platform/{sdl2.c,win32.c,system.c}`,
  `include/constants/global.h`, `include/global.h`, `Makefile`. alanb2305/pokeemerald-native
  `src/save.c`, `src/platform/sdl2.c`. gradenGnostic/pokeemerald-multiplatform
  `src/platform/sdl2.c`, `android/app/build.gradle`.
- cybervisi0n/libntr `include/nitro/card/backup.h` (2026-10-09).
- Project-Holon/eidos `sdk/plat_save.c`, `sdk/save_slots.c`, `tests/test_backup.c`.
- CallanCampos/Frigate `.github/README.md`, `port/README.md` (2026-10-24).
- DanZC/suiCune `tools/emu/peanut_sdl.c`. bryanthaboi/gen1recomp `conf.lua`,
  `src/core/SaveSerializer.lua`, `docs/save-conversion.md`, `docs/switch-transfer.md`,
  `portable-mode.md`.
- PKHeX `PKHeX.Core/Saves/Util/Recognition/SaveHandler{FooterRTC,NSO,DeSmuME,ARDS}.cs`,
  `Saves/SAV1.cs`, `SAV2.cs`, `SAV3.cs` (commit `a9ff306`, 2026-10-21). Read only, nothing copied.
- mGBA `src/gb/mbc.c`, `include/mgba/internal/gb/mbc.h`, `src/gba/savedata.c`,
  `src/platform/libretro/libretro.c`. VBA-M `src/core/gb/gb.cpp`, `gbMemory.h`,
  `src/core/gba/gba.cpp`. SameBoy `Core/gb.c`, `libretro/libretro.c`. Gearboy
  `MBC3MemoryRule.{cpp,h}`. gambatte-libretro `libretro.cpp`, `cartridge_libretro.cpp`.
  gambatte-speedrun `cartridge.cpp`. gpSP `libretro/libretro.c`. melonDS `src/frontend/qt_sdl/
  SaveManager.cpp`, `EmuInstance.cpp`, `src/NDSCart.cpp`. melonDS DS `src/libretro/core/core.cpp`.
  Legacy melonDS libretro. DeSmuME `src/mc.cpp`. RetroArch `runloop.c`, `save.c`, `config.def.h`,
  `frontend/drivers/platform_unix.c`, `libretro-common/streams/rzip_stream.c` (commit `ae6b6ee`,
  2026-10-24). EmulatorJS `emulator.js`, `GameManager.js`. FlashGBX `Mapper.py`, `LK_Device.py`,
  `CHANGES.md` (2026-10-22). Delta cores `GBCEmulatorBridge.mm`, `GBAEmulatorBridge.mm`,
  `MelonDSEmulatorBridge.mm`.

READMEs (in `readmes/`) of: aabrole/HeartSoulRecomp, alanb2305/pokeemerald-native,
arcanite24/gb-recompiled, brunocastro-trindade/PokeEme, bryanthaboi/gen1recomp,
BurgerBlaze/Pokemon-Crystal-native-Android-Port, ClickingMaster/ssrecomp,
ClickingMaster/pokeheartgold-single-screen, CMApex/CrystalClearStaticRecomp,
cybervisi0n/pokeplatinum (pc_port), DanZC/suiCune, dnllnoe/pokeemerald-ps2,
GB-Recomp/{gb-recompiled,pgbcomp,pokered,pokegold,pokecrystal}, Goldoire/Isshu,
gradenGnostic/pokeemerald-multiplatform, IbrahimIrfan/pspoke, LordPain11/pokerecomp,
LunchBox951/pokeemerald-rs, mstan/{gbarecomp,gbrecompiled,EmeraldRecomp,FireRedLeafGreenRecomp,
RubySapphireRecomp,PokemonRedAndBlueRecomp,PokemonYellowRecomp}, Project-Holon/eidos,
psspssr/pokeemerald-3Ds-dualscreen-thor, sohamb117/gen4recomp (+ `shell/README.md`),
sonsegajp/PokeRecomp (+ `docs/GAME_DLL.md`, `docs/LAUNCHER.md`),
sp00nznet/pokemon-{gold,silver,crystal}, uehlbran/pokeemerald-expansion-native,
UNDERdecoded/Gen2Recomped, venom13/pokefirered-dualscreen, xinpw8/pokefirered-native,
ZallaxDev/pokeemerald-3Ds-dualscreen. Repository metadata: `api.github.com/repos/<owner>/<repo>`,
2026-10-24 (saved in `meta/`).

Web:

- BGB RTC save format: https://bgb.bircd.org/rtcsave.html
- Switch FR/LG: https://www.videogameschronicle.com/news/pokemon-firered-and-leafgreen-coming-to-nintendo-switch-next-week-but-not-as-part-of-nso ,
  https://consolepulse.com/nintendo/pokemon/guides/every-pokemon-game-switch-switch-2 (catalogue
  checked 2026-08-21, updated 2026-09-27)
- 3DS VC save files (`sav.dat`, secure value): https://www.3dbrew.org/wiki/3DS_Virtual_Console
- NDS emulator save folders (DeSmuME, No$GBA, DraStic): https://projectpokemon.org/home/tutorials/save-editing/managing-nds-saves/using-emulators-r71
- GBA emulator save folders (VBA, No$GBA, My Boy!): https://projectpokemon.org/home/tutorials/save-editing/managing-gba-saves/using-emulators-r75/
- No$GBA header and raw-save option: https://forums.mgba.io/showthread.php?tid=4861 , https://github.com/mgba-emu/mgba/issues/878
- DraStic `.dsv` footer reports: https://forums.desmume.org/viewtopic.php?pid=23386
- OpenEmu battery-save folders: https://github.com/OpenEmu/OpenEmu/wiki/User-Guide:-Transfer-Save-Files
- VC Gen 2 size reports ("32.02 KB"): ProjectPokémon member posts found via web search (anecdotal)
