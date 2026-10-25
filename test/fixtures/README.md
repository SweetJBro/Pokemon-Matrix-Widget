# Test fixtures (PKHeX-derived)

Synthetic saves, single-Pokémon records and conversion vectors produced by **PKHeX.Core 24.7.27**
through the dev-only oracle in `tools/pkhex-oracle/` (see its README for the commands and JSON
shapes). They let the JavaScript save code be differential-tested against PKHeX without .NET or
PKHeX at test time. No real game saves are included; everything is generated from the specs in
`tools/pkhex-oracle/specs/`. The files are data written by running the tool and contain no PKHeX
code.

## Regenerating

```sh
tools/pkhex-oracle/make-fixtures.sh     # needs the .NET 8 SDK and Node
```

The script builds the oracle, rebuilds every file below with `PKHEX_ORACLE_NOW=2010-01-01` (PKHeX's
"today", used for Pal Park met dates and hatched eggs), and finishes with
`node tools/pkhex-oracle/verify-fixtures.mjs`. Output is deterministic: two runs give
byte-identical files. To change a fixture, edit its spec and rerun; never hand-edit the files.

`verify-fixtures.mjs` checks, for every save: PKHeX reports valid checksums (one known exception,
below); trainer, party, every boxed Pokémon (slot, species, form, level, nickname, moves, PP Ups,
IVs/DVs, EVs/stat exp, nature, ability slot, item, shininess, gender, ball, OT, met/egg data,
friendship, language, Pokérus, markings, ribbons, contest stats, PID substructure order) and the
Pokédex match the spec; re-dumping the `.sav` reproduces `.expected.json` byte for byte; and loading
and re-saving the file in PKHeX changes nothing. Records and conversions are re-run and compared,
and modified saves are checked against their operations. Current result: 17076 checks, 0 failures.

## Layout

```
saves/<id>.sav                    raw save image (no emulator trailer)
saves/<id>.expected.json          `pkhex-oracle dump` of that file
saves/<id>.modified.sav           <id>.sav after tools/pkhex-oracle/specs/ops/<id>.json
saves/<id>.modified.expected.json
records/<format>-<name>.hex       one record as in docs/ARCHITECTURE.md, lowercase hex
records/<format>-<name>.json      `pkhex-oracle pkm <format> <hex>`
convert/<from>-<to>-<name>.json   `pkhex-oracle convert` (input and output records + PKHeX's result)
```

In the JSON, `storedHex` is exactly what the slot holds, `recordHex` is the repo's record format,
and `decryptedHex` is decrypted **and unshuffled** into PKHeX's canonical substructure order.

## Saves

What every save contains (where the generation allows it):

* a party of 3: one nicknamed, one holding an item (not Gen 1), one shiny (Gen 1: shiny DVs);
* box 1: about five Pokémon, in non-contiguous slots for Gen 3-5 (Gen 1/2 lists are packed, so
  slots 0-4): an egg (Gen 2+), an Unown with a non-A letter (Gen 2+), a max-IV/max-EV Pokémon
  (Gen 3-5: all IVs 31 and all EVs 255; Gen 1/2: DVs 15 and stat exp 65535), a level-100 Pokémon,
  a Pokémon from another trainer, and (Gen 3-5) a Pokémon of another language;
* the last slot of the last box: one Pokémon in Gen 3-5; a full last box in Gen 1/2 (20 or 30
  entries), since packed lists only reach the last slot when full;
* Gen 3-5 box 2: 24 Pokémon whose PIDs give substructure orders 0-23 in slot order;
* every non-egg species registered as seen and caught (through PKHeX's own Pokédex update).

| id | game, layout | size | trainer | party | box 1 (slot: species) | notes |
|---|---|---|---|---|---|---|
| red-en | Red, INT | 32 KiB | RED 12345 | Bulbasaur, Pikachu "SPARKY", shiny Gyarados | 0 Mewtwo (max DV/stat exp), 1 Mew L100, 2 Eevee "VEE", 3 Snorlax, 4 Charmander (OT BLUE) | box 12 full (20) |
| yellow-en | Yellow, INT | 32 KiB | ASH 21212 | Pikachu (catch rate 0xA3), Butterfree "FLUTTER", shiny Onix | Mewtwo, Dragonite L100, Kadabra (catch rate 0x60), Squirtle "SQUIRT", Jigglypuff (OT GARY) | starter byte = Pikachu; box 12 full |
| red-ja | Red, Japanese | 32 KiB | サトシ | Charmander, Pikachu "ピカ", shiny Magikarp | Mewtwo, Mew L100, Gastly "ゴス", Psyduck, Pidgey (OT シゲル) | 8 boxes × 30; box 8 full (30) |
| gold-en | Gold, INT | 32 KiB | GOLD 23456 | Cyndaquil "BLAZE", Pikachu @Light Ball, shiny Gyarados | 0 Togepi egg, 1 Unown Q, 2 Lugia (max), 3 Ho-Oh L100, 4 Chikorita @Berry, Pokérus (OT SILVER) | box 14 full (20) |
| crystal-en | Crystal, INT | 32 KiB | KRIS (female) | Totodile "CHOMPY", Pikachu @Light Ball, shiny Gyarados | Pichu egg, Unown Z, Suicune (max), Tyranitar L100, Chikorita | caught data (met level/location/time, OT gender) |
| gold-ja | Gold, Japanese | 32 KiB | ゴールド | Chikorita "チコ", Pikachu @Light Ball, shiny Gyarados | Togepi egg, Unown H, Ho-Oh (max), Lugia L100, Totodile (OT シルバー) | 9 boxes × 30; box 9 full |
| crystal-ja | Crystal, Japanese | 64 KiB | クリス (female) | Cyndaquil "ヒノ", Pikachu @Light Ball, shiny Gyarados | Togepi egg, Unown Q, Suicune (max), Tyranitar L100, Chikorita | 64 KiB SRAM (mobile banks) |
| gold-ko | Gold, Korean | 32 KiB | 골드 | Cyndaquil "불꽃", Pikachu @Light Ball, shiny Gyarados | Togepi egg, Unown Q, Lugia (max), Ho-Oh L100, Chikorita (OT 실버) | **PKHeX reports checksum 2 invalid**, see below |
| ruby-en | Ruby, INT | 128 KiB | MAY (female) | Treecko "LEAFY" (Adamant, markings), Zigzagoon @Oran Berry, shiny Ralts | 0 Azurill egg, 3 Unown H, 7 Rayquaza (max), 12 Groudon L100 (ribbons, contest, Pokérus), 29 Japanese Pikachu (OT サトシ) | box 14 slot 30 Latias |
| emerald-en | Emerald, INT | 128 KiB | BRENDAN | Mudkip "MUDDY", Poochyena @Oran Berry, shiny Wurmple | 0 Wynaut egg, 3 Unown Z, 7 Kyogre (max), 12 Rayquaza L100 (ribbons), 20 Mew (fateful), 29 German Pikachu | security key 0x6D2B79F5, 48 BP |
| firered-en | FireRed, INT | 128 KiB | RED | Charmander "CHAR", Pikachu @Light Ball, shiny Gyarados | 0 Togepi egg, 3 Unown B, 7 Mewtwo (max), 12 Snorlax L100, 29 French Eevee "ÉVOLI" | security key 0x1BADB002 |
| ruby-ja | Ruby, Japanese | 128 KiB | ハルカ | Torchic "アチャ", Zigzagoon @Oran Berry, shiny Ralts | Azurill egg, Unown !, Groudon (max), Metagross L100, English Pikachu (OT ASH) | 5-character names, JP charset |
| diamond-en | Diamond, INT | 512 KiB | LUCAS | Turtwig "SHELLY", Pikachu @Light Ball, shiny Gible | 0 Riolu egg, 4 Unown Q, 9 Dialga (max, ribbons), 17 Garchomp L100, 25 Bibarel (HM moves), 29 Japanese Shellos East | |
| platinum-en | Platinum, INT | 512 KiB | DAWN | Piplup "PIPPY", Shinx @Oran Berry, shiny Starly | Munchlax egg, Unown ?, Giratina Origin @Griseous Orb (max), Rotom form 3 L100, French Burmy Trash | |
| heartgold-en | HeartGold, INT | 512 KiB | ETHAN | Cyndaquil "EMBER", Pikachu @Light Ball (Fast Ball), shiny Gyarados | Togepi egg, Unown Q, Ho-Oh (max), Lugia L100 (Moon Ball), Spanish Pichu (link trade, Love Ball) | HGSS ball byte, 0x10 footers |
| platinum-ja | Platinum, Japanese | 512 KiB | ヒカリ | Chimchar "ヒコ", Pikachu @Light Ball, shiny Gible | Togepi egg, Unown A + J, Palkia (max), Lucario L100, English Shellos (link trade) | |
| heartgold-ko | HeartGold, Korean | 512 KiB | 히비키 | Totodile "악어", Pikachu @Light Ball, shiny Gyarados | Togepi egg, Unown Q, Lugia (max), Ho-Oh L100 | block magic 0x20070903 |
| black-en | Black, INT | 512 KiB | HILBERT | Snivy "VINE" (hidden ability), Pikachu @Light Ball, shiny Axew | 0 Larvesta egg, 4 Unown Q (Poké Transfer), 9 Reshiram (max), 17 Haxorus L100, 22 Purrloin (N's sparkle), 29 Italian Basculin Blue | |
| black2-en | Black 2, INT | 512 KiB | NATE | Oshawott "SHELL", Pikachu @Leftovers, shiny Zorua | Munchlax egg, Unown Z, Kyurem (max), Hydreigon L100 (PokéStar fame), German Deerling Autumn | |
| black-ja | Black, Japanese | 512 KiB | トウヤ | Tepig "ポカ", Pikachu @Light Ball, shiny Venipede | Karrablast egg, Unown E, Zekrom (max), Krookodile L100, English Deerling Summer | |

The full contents of each save are in its `.expected.json` and its spec.

### Modified saves (`<id>.modified.*`)

Produced by `pkhex-oracle modify` from the ops in `tools/pkhex-oracle/specs/ops/<id>.json`, for
comparing the JS writers' take/put operations with PKHeX's:

| id | operations |
|---|---|
| red-en | delete box 1 slot 3 (packed list shifts), delete party slot 2 (party shifts), put `pk1-pikachu-sparky` into empty box 4, make box 12 current |
| gold-en | delete the egg (box 1 slot 1), put a Crystal record with caught data into box 2, delete party slot 3 |
| emerald-en | clear box 1 slot 8, delete party slot 1, put a Ruby record into box 3 slot 6, append a record to the party |
| platinum-en | clear box 1 slot 10, delete party slot 3, put a Diamond record into box 5 slot 30 |
| black-en | clear box 1 slot 10, delete party slot 1, put a Black 2 record into box 24 slot 1 |

## Records (`records/`)

Each `.hex` is one record in the repo's format (pk1: box struct + OT + nickname; pk2: list entry + box struct + OT + nickname; pk3-pk5: the
encrypted box struct) taken from a save fixture, and the `.json` is PKHeX's parse of it.

* pk1: `pikachu-sparky` (nickname, PP Ups, stat exp), `mewtwo-maxdv`, `yellow-pikachu-lightball`
  (catch rate 0xA3), `ja-pikachu` (6-byte names, 45-byte record).
* pk2: `cyndaquil-blaze`, `togepi-egg` (first byte 0xFD: the pk2 record carries the list entry that marks Gen 2 eggs), `unown-q`,
  `crystal-pikachu-caught` (caught data), `ja-chikorita`, `ko-cyndaquil` (Hangul).
* pk3: `treecko-leafy`, `azurill-egg` (JP egg name, language 1), `groudon-ribbons`,
  `zigzagoon-oranberry`, `mew-fateful`, `ja-torchic`, `empty` (80 zero bytes).
* pk4: `turtwig-shelly`, `riolu-egg`, `bibarel-hms`, `giratina-origin`, `hgss-pikachu-fastball`,
  `ja-chimchar`, `empty` (PKHeX's empty slot: a zeroed struct encrypted with seed 0; identical to
  the canonical record in docs/research/format-gen4.md 10.4).
* pk5: `snivy-hidden-ability`, `larvesta-egg`, `purrloin-nsparkle`, `basculin-blue-it`,
  `oshawott-shell`, `ja-tepig`, `empty`.
* Doc vectors, cross-checked: `pk3-docvec-1`, `pk3-docvec-2-shiny`, `pk3-docvec-3-egg`
  (format-gen3.md 14.1 CIPHER lines) and `pk4-docvec-pikachu` (format-gen4.md 19.1 ENCRYPTED).
  PKHeX decodes all four with valid checksums and the documented field values; the PK4 vector's
  decrypted bytes equal the doc's PLAIN block. (The Gen 3 PLAIN lines in the doc are in stored,
  shuffled order; `decryptedHex` here is unshuffled.)

## Conversions (`convert/`)

`EntityConverter.ConvertToType` results. What PKHeX does:

| vector | result |
|---|---|
| pk1→pk2 | Success. Catch rate becomes the held item through the Time Capsule table (190 → Berry, 0xA3 → Light Ball); friendship set to the species base; no caught data. |
| pk2→pk1 | Success for Gen 1 species: the held item byte becomes the catch rate; moves beyond 165 cleared. Cyndaquil and Unown fail with `IncompatibleSpecies`. |
| pk3→pk4 | Success (Pal Park): met location 55, met level = current level, met date = "today" (2010-01-01), friendship 70, item ids remapped (Oran Berry 139 → 155), markings truncated to 4 bits. An egg is force-hatched first (nickname becomes the species name in the egg's language, which stays Japanese). |
| pk3→pk5 | Success: PKHeX chains pk3→pk4→pk5. |
| pk4→pk5 | Success (Poké Transfer): met location 30001, met level = current level, friendship 70, HM moves deleted and the rest shifted up (the real Poké Transfer refuses such Pokémon), met date **kept** (PKHeX discards the new date it computes). Eggs are force-hatched first (met date becomes "today"). The HGSS ball byte and Giratina's Griseous Orb survive. |
| pk1→pk3, pk2→pk3 | `NoTransferRoute`: PKHeX has no Gen 1/2 → Gen 3 path. Its only route out of Gen 1/2 is the Virtual Console transfer to pk7. |
| pk1→pk7, pk2→pk7 | Success (Virtual Console/Poké Transporter). PID, encryption constant and IVs are random, so the output is summarised without them. |
| pk4→pk3, pk5→pk4 | `NoTransferRoute` (no downward conversion). |

## Things to know when comparing against PKHeX

PKHeX is an editor, not the game. These are the places where its output or its view differs from
what a game (or our docs) would do. Compare around them.

**Layouts PKHeX could not create on its own.** `SaveUtil.GetBlankSAV` cannot export a Gen 3 or
Gen 4 save at all (the blank has no flash image), Gen 1/2 blanks are written with list headers
PKHeX's own detector rejects, and the Gen 5 blank has raw-zero box slots (Bad Eggs in game) and an
empty save footer. The oracle supplies a minimal skeleton for all of these (details in
`tools/pkhex-oracle/README.md`): Gen 3 and 4 fixtures look like a game saved twice (the older
copy holds the blank game, the newer one the content), Gen 5 has its footer filled in and a backup
copy, Gen 1/2 get empty list headers, and international Gen 2 gets the 0x63/0x7F check bytes. Every
requested layout was produced. Japanese and Korean Gen 2 fixtures have no check bytes (offsets
unverified), so a real game may treat them as having no save; PKHeX does not care. Korean Crystal
does not exist; PKHeX turns a Korean Crystal request into Gold/Silver.

**Detection and version.** PKHeX cannot tell Red/Blue/Green apart (`RB`) or Gold/Silver (`GS`).
Yellow is recognised only by the starter byte (Pikachu) or a non-zero Pikachu-friendship byte.
Emerald needs a non-zero security key **and** a non-zero byte in small block 0x890-0xF2C, or PKHeX
reports Ruby/Sapphire. FireRed/LeafGreen need small-block 0xAC = 1.

**Save language.** Gen 1 always reports language 2 (English), even for the Japanese layout. Use
`japanese`. International Gen 2 reports -1. Gen 3 does not store a language (0). Gen 4/5 store it.

**Gen 1/2 lists.** PKHeX reads the Gen 1 current box from the bank-1 copy and the other boxes from
banks 2/3 (only when bit 7 of the current-box byte is set). It reads every Gen 2 box from the box
banks, ignores the current-box copy, and rewrites the copy on save. After the count, PKHeX fills
every remaining species-header byte with 0xFF (not just one terminator) and leaves unused structs
and names zero. After a deletion it writes its blank entity (party stats for "species 0", 0x50-filled
names) into the vacated entry, but reads unused entries back as zeros, so those bytes and the main
checksum are not stable across a PKHeX load/save. Compare only used entries.

**Gen 1 checksums.** PKHeX writes and checks only the main checksum (0x3523 / 0x3594). The bank
checksums (0x5A4C, 0x7A4C) and per-box checksums are never written. They are 0 in these fixtures.

**Gen 2 Korean.** PKHeX writes checksum 1 and an "oddball" five-range sum at 0x7E6B, but it then
validates 0x7E6B against the main-region sum, so its own Korean saves report
`Checksum 1 Valid, Checksum 2 Invalid`. It also never copies the main data into the Korean backup
ranges. The docs (format-gen1-gen2.md 5.3) note that the GS INT backup piece 2 offset PKHeX uses
also disagrees with the disassembly.

**Gen 2 eggs.** The egg flag lives in the list's species header (0xFD), not in the struct, so the
pk2 record starts with that list entry (docs/ARCHITECTURE.md). `listSpecies` shows the header byte.

**Language and nicknames of GB entities.** PKHeX infers a Gen 1/2 Pokémon's language from its
nickname. A nicknamed international Pokémon reports language 0. "Is nicknamed" is likewise a
comparison with the species name.

**Gen 3 eggs.** As in the games, an egg has language 1 and the nickname タマゴ (60 6F 8B FF). PKHeX's
own `PK3.IsEgg = true` writes the name *before* switching the language, which encodes it with the
wrong table on a non-Japanese entity. The oracle sets the language first. PKHeX then decodes the
(international) OT name with the Japanese table, so `ot.name` of such eggs shows full-width
letters ("ＭＡＹ"). The bytes are the game's.

**Markings.** PKHeX's `MarkingValue` swaps bits 1 and 2 for PK3. `markingsRaw` is the stored byte.

**Ability.** PKHeX's `AbilityNumber` is 1/2/4. The dump converts it to 0/1/2. For Gen 5 it comes
from PID bit 16 even when the species has one ability (Pikachu shows 1). Gen 4 stores the ability
id and PKHeX reports the slot from the PID.

**Gen 4 dual fields.** Met and egg locations are stored twice (DP and Pt/HGSS fields) and the ball
twice (DP/Pt and HGSS bytes). PKHeX's setters choose by origin game: for an HGSS-origin Pokémon the
DP met field holds 3002 ("faraway place") and the real location goes in the extended field; the
HGSS ball byte is set only for HGSS-origin, non-fateful Pokémon. `extra` shows both copies.

**Name padding.** PKHeX writes names terminator-first and leaves the rest zero: Gen 3 `FF 00 00 …`
(the games pad with 0xFF), Gen 4/5 `FFFF 0000 …` (Gen 5 games also put 0xFFFF in the last code
unit). Gen 1/2 names are padded with 0x50. Do not compare name bytes after the terminator.

**Gen 3 sector checksums.** PKHeX sums all 0xF80 data bytes of every sector. The games sum only
the section's real size. The results agree only while the tail bytes are zero, which they are in
these fixtures.

**Bad checksums.** For a Gen 3 slot whose checksum fails, PKHeX's PK3 constructor decides the data
is "still encrypted" and decrypts it a second time, so a corrupt record shows as garbage rather
than as the game's Bad Egg.

**Empty slots.** Gen 4/5 empties are PKHeX's blank entity encrypted with seed 0 (the canonical
empty record). `SaveFile.ClearBoxes()` skips slots that are all zero, so it cannot repair raw-zero
slots. Gen 3 empties are 80 zero bytes.

**Copies.** PKHeX edits only the active Gen 3 slot, the active Gen 4 partition and the Gen 5 main
copy. In Gen 4 it also recomputes the CRCs of the older partition (data unchanged).

**Crystal caught data.** The met level has 6 bits; PKHeX silently truncates (100 becomes 36).

**Unused list bytes and other quirks in `modify`.** In Gen 1/2, slot numbers in one `modify` run
refer to PKHeX's unpacked slots, and lists are packed only when the file is written.
