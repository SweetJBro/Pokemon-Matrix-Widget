# pkhex-oracle (development only)

A small C# command-line wrapper around [PKHeX.Core](https://www.nuget.org/packages/PKHeX.Core)
used as a **differential-testing oracle** for the widget's JavaScript save parsers and writers,
and to generate the committed fixtures in `test/fixtures/`.

* **Never part of the shipped widget.** Nothing in `server/`, `shared/` or `web/` may import,
  spawn or depend on it, and it is not needed to run the widget or `npm test`.
* **Licensing.** The widget is MIT. PKHeX.Core is GPLv3. This tool only *references* the
  PKHeX.Core NuGet package (pinned to **24.7.27**, the last release that targets .NET 8); no
  PKHeX source is copied into this repository. The fixtures it writes are data produced by
  running the tool, not PKHeX code.
* Build output (`bin/`, `obj/`) is git-ignored.

## Requirements and running

.NET 8 SDK (`dotnet --version` ≥ 8.0). The first build restores PKHeX.Core from NuGet.

```sh
dotnet run --project tools/pkhex-oracle -- <command> [args]      # ad hoc
tools/pkhex-oracle/make-fixtures.sh                             # regenerate + verify all fixtures
node tools/pkhex-oracle/verify-fixtures.mjs                     # verify only (needs a Release build)
```

Every command prints exactly one JSON document on stdout and exits 0. On error it prints
`{"ok": false, "error": "...", "type": "usage" | <exception type>, "stack"?: "..."}` and exits 1.

PKHeX stamps "today" into a few conversions (Pal Park met date, traded/hatched eggs). The oracle
freezes that clock at **2010-01-01**; override with `PKHEX_ORACLE_NOW=YYYY-MM-DD`. No other
randomness is used: PIDs, Gen 1/2 DVs and Unown letters are found by seeded/fixed-order searches,
so the same spec always produces the same bytes.

## Commands

| command | does |
|---|---|
| `blank <GameVersion> <lang> <out.sav>` | blank save (see "Save skeletons") |
| `build <spec.json> <out.sav>` | save built from a JSON spec |
| `dump <in.sav>` | PKHeX's view of a save |
| `pkm <pk1..pk5> <hex> [--decrypted] [--egg]` | parse one record |
| `convert <from> <to> <hex> [--decrypted] [--egg]` | `EntityConverter.ConvertToType` (`to` = pk1..pk5, or pk6/pk7) |
| `modify <in.sav> <out.sav> <ops.json>` | apply slot operations through PKHeX and save |
| `roundtrip <in.sav>` | load + re-save with PKHeX; reports whether bytes / decoded view change |
| `blankpkm <pk1..pk5>` | PKHeX's empty-slot entity as a record |
| `version` | `{"tool", "pkhexCore", "now"}` |

`GameVersion` uses PKHeX names: `RD GN BU YW GD SI C R S E FR LG D P Pt HG SS B W B2 W2`.
`lang` is `en ja fr de it es ko` (or a PKHeX `LanguageID` name).

### Record input (`pkm`, `convert`, `modify` setBox/setParty)

Records follow `docs/ARCHITECTURE.md`:

* `pk1` / `pk2`: box struct (33 / 32 bytes) + OT name + nickname, names 11 bytes each
  (6 for Japanese). A party struct (44 / 48) + names and PKHeX's own `.pk1`/`.pk2` single-entry
  list layout (69/59, 73/63 bytes) are also accepted. Korean `pk2` is recognised by PKHeX from the
  OT name bytes. **A Gen 2 egg cannot be expressed in this record format** (the egg flag lives in
  the list's species header byte, 0xFD); pass `--egg` to mark the record as an egg.
* `pk3` / `pk4` / `pk5`: the encrypted box struct (80 / 136 / 136 bytes) exactly as stored, or
  encrypted party data (100 / 236 / 220). `--decrypted` takes decrypted, unshuffled bytes instead.

### `dump` output

```jsonc
{
  "oracle": {"tool": "pkhex-oracle", "pkhexCore": "24.7.27"},
  "file": {"name", "size", "sha256"},
  "saveType": "SAV3E", "version": "E", "versionId": 3, "generation": 3, "format": "pk3",
  "language": 0, "languageCode": null,          // PKHeX's save language (see notes below)
  "japanese": false, "korean": false,           // layout flags (Gen 1-3 / Gen 2)
  "checksumsValid": true, "checksumInfo": "Checksums are valid.",
  "trainer": {"name", "tid", "sid" /*null Gen 1-2*/, "gender" /*null Gen 1, GS*/, "money", "playTime": {"h","m","s"}},
  "currentBox": 0, "boxCount": 14, "boxSlotCount": 30, "boxNames": ["BOX 1", ...],
  "gb": {                                       // Gen 1/2 only: raw packed-list headers
    "partyList": {"offset", "count", "speciesHex"},
    "boxListOffsets": [...], "boxListCounts": [...], "boxListSpeciesHex": [...],
    "currentBoxCopyOffset": 12480, "currentBoxCopyMatchesBank": true,
    "boxesInitialized": true                    // Gen 1: bit 7 of the current-box byte
  },
  "partyCount": 3,
  "party": [{"slot": 0, ...Pokémon}],
  "boxSlotsUsed": 31,
  "boxes": [{"box": 0, "slot": 7, ...Pokémon}], // every non-empty slot, box-major
  "pokedex": {"seen": [species...], "caught": [species...]}
}
```

### Pokémon JSON (`dump`, `pkm`, `convert`)

```jsonc
{
  "format": "pk4", "species": 445, "speciesName": "Garchomp", "form": 0,
  "nickname": "GARCHOMP", "isNicknamed": false, "isEgg": false,
  "level": 100, "exp": 1250000,
  "moves": [{"id": 200, "name": "Outrage", "pp": 15, "ppUps": 0}, ... always 4],
  "ivs": {"hp","atk","def","spa","spd","spe"},   // Gen 1/2: DVs (spa = spd = special)
  "dvs": {"hp","atk","def","spe","spc"},          // Gen 1/2 only
  "evs": {...},                                   // Gen 1/2: stat experience
  "statExp": {"hp","atk","def","spe","spc"},      // Gen 1/2 only
  "nature": 14, "natureName": "Naive",            // null Gen 1/2
  "ability": 8, "abilityName": "Sand Veil",
  "abilityNumber": 0,                             // 0, 1, 2 (= hidden, Gen 5); PKHeX itself uses 1/2/4
  "heldItem": 0, "heldItemName": null,            // null Gen 1 (use extra.catchRate)
  "gender": 0,                                    // 0 male, 1 female, 2 genderless (PKHeX convention)
  "isShiny": false, "pid": 534198739,             // pid null Gen 1/2
  "ot": {"name", "tid", "sid", "gender"},
  "met": {"location", "locationName", "level", "ball", "version", "versionName", "date"},
        // Gen 2: {"location","level","timeOfDay"} from Crystal caught data; Gen 1: null; date Gen 4/5 only
  "egg": {"location", "locationName", "date"},    // Gen 4/5 only
  "friendship": 70,                               // eggs: remaining egg cycles; null Gen 1
  "language": 2, "languageCode": "en",
  "pokerus": {"strain", "days"},
  "markings": 0,        // PKHeX's MarkingValue (for PK3 it swaps bits 1 and 2)
  "markingsRaw": 0,     // the stored marking byte
  "fatefulEncounter": false,
  "contest": {"cool","beauty","cute","smart","tough","sheen"},     // Gen 3-5
  "ribbonCount": 0, "ribbons": ["RibbonChampionG3", "RibbonCountG3Cool=4", ...], // PKHeX property names
  "checksumValid": true, "checksum": 8456,       // checksum null Gen 1/2 (no checksum)
  "extra": {...},       // format-specific: pk1 catchRate/type1/type2/boxLevel/speciesInternal;
                        // pk2 caughtData/korean; pk3 abilityBit/speciesInternal/flag bits;
                        // pk4 both met/egg location copies, ballDPPt/ballHGSS, groundTile, ...;
                        // pk5 hiddenAbility/nSparkle/pokeStarFame/groundTile
  "partyStats": {"level","status","hpCurrent","hpMax","atk","def","spa","spd","spe"}, // party / party-sized input
  // raw bytes, lowercase hex
  "storedHex": "...",     // exactly what the slot holds: Gen 3-5 encrypted (box size in boxes,
                          // party size in the party); Gen 1/2 the struct from the packed list
  "decryptedHex": "...",  // decrypted AND unshuffled to PKHeX's canonical order
                          // (Gen 3 Growth/Attacks/EVs/Misc, Gen 4/5 blocks A/B/C/D); Gen 1/2 = storedHex
  "recordHex": "...",     // the repo's record (docs/ARCHITECTURE.md): Gen 3-5 the encrypted box
                          // struct (first 80/136 bytes of a party slot); Gen 1/2 box struct + OT + nickname
  "shuffleOrder": 1,      // Gen 3-5: PID % 24 (Gen 3) or ((PID >> 13) & 31) % 24 (Gen 4/5)
  "structHex", "partyStructHex", "otNameHex", "nicknameHex", "listSpecies"   // Gen 1/2 only
}
```

### `convert` output

`{"oracle": {..., "now"}, "from", "to", "ok", "result" (PKHeX EntityConverterResult), "resultMessage",
"input": Pokémon, "output": Pokémon | null}`. The output is re-encoded as a box record and parsed
back, as a save slot would hold it. Gen 6/7 output (only PKHeX's Virtual Console path pk1/pk2 →
pk7) is summarised without PKHeX's random fields (PID, encryption constant, IVs).

### `modify` ops

`ops.json` is `[op, ...]` or `{"ops": [op, ...]}`:

| op | fields |
|---|---|
| `deleteBox` | `box`, `slot` — writes PKHeX's blank entity |
| `deleteParty` | `slot` — PKHeX's `DeletePartySlot` (later members shift down) |
| `setBox` | `box`, `slot`, `format`, `hex` or `hexFile`, optional `decrypted`, `egg`, `registerDex`, `adapt` |
| `setParty` | `slot` (default: append), same record fields; party stats are computed if absent |
| `setCurrentBox` | `box` |
| `registerDex` | `species`, `seen` (true), `caught` (true) |

`adapt: true` lets PKHeX apply its trade adaptation (`SetPKM`, Gen 4/5 only); the default writes
the record unchanged. Gen 1/2 slot numbers address PKHeX's unpacked in-memory slots: a deleted
slot leaves a gap until the save is written, when the list is packed. So within one `modify` run,
`deleteBox 0/2` followed by `setBox 0/4` overwrites whatever was in slot 4 before the delete.

Output: `{"ok", "command", "out", "size", "sha256", "warnings", "notes", "save": dump, "applied": [...]}`
(`blank` and `build` print the same envelope without `applied`).

## Build specs

`specs/<id>.json` (used by `make-fixtures.sh`; any file works with `build`):

```jsonc
{
  "game": "E", "lang": "en",
  "trainer": {"name": "BRENDAN", "tid": 24680, "sid": 13579, "gender": 0, "money": 271828, "playTime": {"h": 99, "m": 59, "s": 59}},
  "registerDex": true,          // register non-egg Pokémon as seen+caught via PKHeX (default true)
  "currentBox": 0,
  "boxNames": ["..."],          // optional
  "gen1": {"starter": 25, "rivalStarter": 133, "pikachuFriendship": 255},   // Gen 1 only (national dex numbers)
  "gen3": {"securityKey": "0x6D2B79F5", "battlePoints": 48},               // Gen 3 only
  "defaults": {...},            // fields merged into every Pokémon
  "party": [Pokémon, ...],
  "boxes": [{"box": 0, "slot": 7, ...Pokémon}],
  "fill": [{"box": 1, "start": 0, "count": 24, "species": [...] | "speciesStart": 252,
            "shuffleOrders": true, "levelStep": 1, "template": {...}}],
  "dexSeen": [...], "dexCaught": [...]   // extra Pokédex flags
}
```

Pokémon spec fields (all optional except `species`): `species` (national), `form`, `level` (5),
`exp`, `nickname` (default: species name in the Pokémon's language), `moves` ([33]), `ppUps`,
`pp` (default: full PP), `ivs` / `dvs` (Gen 3-5 default 1/2/3/4/5/6; Gen 1/2: `{atk,def,spe,spc}`,
HP is derived), `evs` / `statExp`, `nature` (name or 0-24), `abilityNumber` (0, 1, 2 = hidden in
Gen 5), `heldItem` (that generation's item id), `catchRate` (Gen 1, default species rate),
`shiny` (false), `gender` (`"M"`/`"F"`/0/1), `ball` (4), `otName`/`tid`/`sid`/`otGender` (default:
trainer), `language` (default: save language), `metLocation`, `metLevel` (default level; eggs 0,
Gen 5 eggs 1), `metVersion` (origin game, default the save's game), `metDate`, `eggLocation`,
`eggDate`, `metTimeOfDay` (Crystal), `friendship` (default base friendship, eggs hatch cycles),
`isEgg`, `pid`, `pidSeed`, `shuffleOrder` (0-23), `pokerus` `{strain, days}`, `markings` (raw
byte), `fatefulEncounter`, `contest` `{cool,...,sheen}`, `ribbons` (array of PKHeX ribbon property
names, or an object for counted ribbons: `{"RibbonCountG3Cool": 4}`), `groundTile`, `nSparkle`,
`pokeStarFame`, `registerDex`.

Gen 3-5 PIDs are searched (seeded per slot) to satisfy nature, gender, ability slot, shininess,
Gen 3 Unown letter and `shuffleOrder`; Gen 1/2 DVs are searched for shininess, gender and Unown
letter. Gen 1/2 box lists are packed, so box slots are compacted (a warning is printed).

## Save skeletons

PKHeX's `SaveUtil.GetBlankSAV` objects are editor templates, not game-loadable images. `blank` and
`build` therefore start from a minimal skeleton (see `Skeleton.cs`), and every trainer, Pokémon
and checksum write after that goes through PKHeX:

* **Gen 1/2**: PKHeX's blank object plus empty list headers (count 0, terminator 0xFF) for the
  party, the current-box copy and every box. Without them PKHeX writes nothing for empty lists and
  cannot re-detect its own file. International Gen 2 saves also get the 0x63/0x7F "save exists"
  check bytes in the primary and backup copies (PKHeX ignores them; the games require them).
  Japanese/Korean Gen 2 offsets are unverified, so those fixtures have none. Gen 2 output is cut to the 32 KiB cartridge size (PKHeX always
  allocates 64 KiB) except Japanese Crystal. Yellow gets its Pikachu-friendship byte so PKHeX tells
  it from Red/Blue.
* **Gen 3**: PKHeX cannot serialise a blank SAV3 at all. The skeleton is 128 KiB of erased flash
  with two slots, as after two in-game saves: slot B (counter 1, sector rotation 1) holds the blank
  game with the trainer, slot A (counter 2, rotation 2) is the active copy. FRLG gets small-block
  0xAC = 1, Emerald a security key and Battle Points (PKHeX needs a non-zero byte at small-block
  0x890-0xF2C to tell Emerald from Ruby/Sapphire).
* **Gen 4**: PKHeX cannot serialise a blank SAV4 either. Partition B holds the blank game
  (footer counters 1), partition A the active copy (counters 2); footers carry size and magic
  (0x20060623, Korean 0x20070903); Pokédex magic 0xBEEFCAFE and the Unown list are initialised.
* **Gen 5**: PKHeX's blank image, with every slot rewritten as PKHeX's encrypted empty entity (the
  blank has raw zeros, which the games read as Bad Eggs), the save footer's count, size and magic
  (0x31053527) filled in, and the main copy mirrored to the backup copy as an older save. PKHeX
  only edits the main copy.

Box names default to "BOX n" (Gen 2 "BOXn", Gen 5 "Box n", Japanese "ボックスｎ").
