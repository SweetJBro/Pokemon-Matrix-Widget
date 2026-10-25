# Game data sources and cross-generation transfer rules (Gen 1-5)

Research note for `scripts/build-data.mjs`, `shared/data/`, `shared/pkm/{stats,view,convert,evolve,showdown}.js`
and the UI. Written 2026-10-24. Byte layouts of the records themselves live in `format-gen1-gen2.md`,
`format-gen3.md`, `format-gen4.md` and `format-gen5.md`; this note only repeats a layout fact when a conversion
depends on it.

How to read the citations: `[tag]` refers to the Sources list at the end. Facts read from game decompilations are
the strongest evidence we have (that is the code the games run). PKHeX (GPLv3) was read to confirm behaviour and is
described here in our own words only; nothing from it may be copied into the repository. Anything not confirmed by a
primary source is marked **UNVERIFIED**.

Scratch work (fetched CSVs, decomp excerpts, cross-check scripts) is in `/tmp/claude-1000/pkres/data-transfers/`;
the three cross-check scripts are in its `scripts/` folder and are quoted by name below.

---

## 0. Summary and recommendations

1. **Data: PokeAPI CSVs + pret decomp constants, no runtime dependency.** PokeAPI (`PokeAPI/pokeapi`, BSD-3-Clause,
   pinned commit `2bf639e55728`, 2026-10-20) supplies names in every language, species attributes, per-generation
   stat/type/ability/move history, natures, growth tables and form indices. pret decompilations supply the index
   spaces PokeAPI gets wrong or lacks: Gen 1/2 item ids, Gen 2/3/4 met locations, and they are the reference for
   cross-checks. `@pkmn/dex`/`@pkmn/sim` (MIT) are **not** a build input: the server already depends on `@pkmn/sim`
   for battles and builds its `num -> Showdown id` maps from it at start-up (section 1.4).
2. **PokeAPI has real index errors in exactly the places we need** (section 1.3, all reproduced with fetched
   files): Gen 2 Max Elixer, missing Gen 2 items (EnergyPowder, all mail...), Gen 2 berries merged into their
   Gen 3 successors, Gen 3 Basement Key, Gen 5 Deep Sea Tooth and two Apricorns, Gen 2 landmarks 0x46/0x58/0x59,
   the Gen 5 transfer location 30001 missing and 30007 duplicated. The build script must take those spaces from
   pret (or a hand-checked table) and run the cross-checks as tests.
3. **Official conversions are now known field by field from game code**, not just from wikis:
   Time Capsule from pokecrystal `engine/link/link.asm`; Pal Park from pokeplatinum
   `src/main_menu/gba_pokemon.c` (`BoxMonGBAToBoxMon`), `gba_migrator.c` (eligibility) and
   `scrcmd_catching_show.c` (met data); Poké Transfer from Bulbapedia plus PKHeX (no BW decomp covers it).
4. **`convert()` needs the target save** (game and language), not just the target format: Pal Park's nickname flag
   depends on the destination game's language, its Deoxys form on the source cartridge, Poké Transfer's HM check
   on the source game, and Gen 4 writes its location/ball copies differently in DP and Pt/HGSS. Proposed
   signature: `convert(record, meta, toFormat, { allowUnofficial, target: { game, lang }, now })`.
5. **`tradeEvolve()` needs the partner's species** (Karrablast/Shelmet) and should apply the rules of the record's
   own generation (Everstone from Gen 2, the Gen 4+ Kadabra exception, item consumed, Gen 1 type/HP update,
   Gen 4/5 ability recomputation, per-generation rename rule). Proposed:
   `tradeEvolve(record, meta, { partnerSpecies })`.
6. **Unofficial Gen 1/2 -> Gen 3** is designed in section 2.5 on the Virtual Console/Poké Transporter model:
   nature = original EXP mod 25, EXP reset to the level minimum, Poké Ball, SID 0, Gen 2 rules for gender,
   shininess and Unown letter encoded into a searched PID, fateful flag for Mew/Celebi. Where VC's rule cannot be
   used in Gen 3 (random IVs with three 31s, hidden ability, Kanto/Johto transfer locations) we pick a
   deterministic, documented substitute: IV = 2 x DV + 1 bit chosen to keep the Gen 2 Hidden Power type.
7. **Offer as opt-in only** (section 5): Gen 1/2 -> Gen 3 (badge "Unofficial: VC-style transfer"), "remove HM
   moves for me" before Pal Park/Poké Transfer, "keep held item" on Poké Transfer. Never offer downward
   conversions except Gen 2 -> Gen 1 for Time Capsule-compatible Pokémon. Record every conversion as provenance
   metadata next to the record, never inside the bytes.

---

## 1. Machine-readable data sources

### 1.1 Candidates and licences

| Source | Licence | What it is good for | What it lacks / gets wrong |
|---|---|---|---|
| **PokeAPI CSVs** (`data/v2/csv/*.csv` in `PokeAPI/pokeapi`) [pokeapi] | Repository: BSD-3-Clause (GitHub licence API and the repository's licence file: "Copyright (c) 2013–2023 Paul Hallett and PokéAPI contributors"). The notice must be kept in our repo (e.g. `shared/data/LICENSE.pokeapi`). Pokémon names are Nintendo trademarks either way. | Localised names (ja-Hrkt, ko, fr, de, es, it, en + zh), species attributes, growth tables, per-generation history tables, natures with game index, per-generation form indices, Gen 3+ game indices for species/items, type byte values per generation | Index errors in Gen 2 items, Gen 2/5 locations, a few Gen 3/5 items (section 1.3); no in-game (ALL CAPS) names; location names mostly English only |
| **`@pkmn/dex` 0.10.11 / `@pkmn/data` 0.10.11** [pkmn-dex] | MIT | Per-generation views (`Dex.forGen(n)`) of species (num, types, base stats incl. Gen 1 Special as spa=spd), moves (num, type, PP, category), items (num), abilities (num) exactly as Showdown simulates them | No growth rate, catch rate or base friendship; item `num` is the modern (Gen 4+) item index, so useless for Gen 2/3 item bytes (e.g. Leftovers `num: 234`, Gen 2-only Mint Berry `num: 150`); no locations, no game versions |
| **pret decompilations** [pret-*] | No licence file on any pret repo (GitHub licence API returns none). Use as a reference and as a source of facts (ids, tables); generate our own data files, do not vendor source. | Ground truth for internal index orders, item ids, met location ids and names, and conversion behaviour | Gen 5 has no complete public decomp in pret; Gen 4 text is English-only in pokeplatinum/pokeheartgold JSON |
| **PKHeX** [pkhex] | GPLv3 (task statement; GitHub reports NOASSERTION) | Confirming behaviour and offsets | Must not be copied (code, tables or resource text files) |
| Bulbapedia [bulba-*] | CC BY-NC-SA | Human-readable confirmation of transfer rules | Not machine-readable; not a data source for the build |

### 1.2 PokeAPI files and columns we use

All files are `https://raw.githubusercontent.com/PokeAPI/pokeapi/<sha>/data/v2/csv/<file>`. Column lists below were
read from the fetched files (header rows), not from documentation.

| File | Columns (exact) | Used for |
|---|---|---|
| `pokemon_species.csv` | `id,identifier,generation_id,evolves_from_species_id,evolution_chain_id,color_id,shape_id,habitat_id,gender_rate,capture_rate,base_happiness,is_baby,hatch_counter,has_gender_differences,growth_rate_id,forms_switchable,is_legendary,is_mythical,order,conquest_order` | National dex (`id` = dex number), introduced generation, gender ratio, catch rate, base friendship, growth rate |
| `pokemon_species_names.csv` | `pokemon_species_id,local_language_id,name,genus` | Species names; languages 1 ja-Hrkt, 3 ko, 5 fr, 6 de, 7 es, 8 it, 9 en (`languages.csv`) |
| `pokemon.csv` | `id,identifier,species_id,height,weight,base_experience,order,is_default` | Joins `pokemon_id` (form-level rows, ids ≥ 10001 for alternate forms) to species |
| `pokemon_forms.csv`, `pokemon_form_generations.csv`, `pokemon_form_names.csv` | `id,identifier,form_identifier,pokemon_id,introduced_in_version_group_id,is_default,is_battle_only,is_mega,form_order,order`; `pokemon_form_id,generation_id,game_index`; `pokemon_form_id,local_language_id,form_name,pokemon_name` | **Per-generation form numbers** (e.g. Arceus-Fire is form 10 in Gen 4 but 9 in Gen 5 because Gen 5 drops the ??? type; Deoxys forms are all 0 in Gen 3 where the form is not stored; Unown `exclamation`/`question` are 26/27 from Gen 3) |
| `pokemon_stats.csv`, `pokemon_stats_past.csv`, `stats.csv` | `pokemon_id,stat_id,base_stat,effort`; `pokemon_id,generation_id,stat_id,base_stat,effort`; `id,damage_class_id,identifier,is_battle_only,game_index` | Base stats. `stat_id` 9 = Gen 1 Special (151 rows, all `generation_id` 1) |
| `pokemon_types.csv`, `pokemon_types_past.csv`, `types.csv`, `type_names.csv`, `type_game_indices.csv` | `pokemon_id,type_id,slot`; `pokemon_id,generation_id,type_id,slot`; `id,identifier,generation_id,damage_class_id`; `type_id,local_language_id,name`; `type_id,generation_id,game_index` | Types per generation; Gen 1/2 type bytes (Fire = 20, Dark = 27, `unknown`/??? = 19 in Gen 2, 9 in Gen 3/4, absent in Gen 5) |
| `pokemon_abilities.csv`, `pokemon_abilities_past.csv`, `abilities.csv`, `ability_names.csv` | `pokemon_id,ability_id,is_hidden,slot`; `pokemon_id,generation_id,ability_id,is_hidden,slot`; `id,identifier,generation_id,is_main_series`; `ability_id,local_language_id,name` | Ability slots per generation (an empty `ability_id` in a past row means "slot did not exist"), names; ability ids = game ids (76 Air Lock is the last Gen 3 id, 123 Bad Dreams Gen 4, 164 Teravolt Gen 5) |
| `moves.csv`, `move_changelog.csv`, `move_names.csv` | `id,identifier,generation_id,type_id,power,pp,accuracy,priority,target_id,damage_class_id,effect_id,effect_chance,contest_type_id,contest_effect_id,super_contest_effect_id`; `move_id,changed_in_version_group_id,type_id,power,pp,accuracy,priority,target_id,effect_id,effect_chance`; `move_id,local_language_id,name` | Move names, per-generation PP and type. Move ids = game ids (165 Struggle, 251 Beat Up, 354 Psycho Boost, 467 Shadow Force, 559 Fusion Bolt) |
| `items.csv`, `item_names.csv`, `item_game_indices.csv` | `id,identifier,category_id,cost,fling_power,fling_effect_id`; `item_id,local_language_id,name`; `item_id,generation_id,game_index` | Item names; Gen 3/4/5 game indices after the fixes in 1.3 |
| `natures.csv`, `nature_names.csv` | `id,identifier,decreased_stat_id,increased_stat_id,hates_flavor_id,likes_flavor_id,game_index`; `nature_id,local_language_id,name` | Natures. **PokeAPI `id` is not the game index**; use `game_index` (Hardy 0 ... Quirky 24) |
| `growth_rates.csv`, `experience.csv` | `id,identifier,formula`; `growth_rate_id,level,experience` | EXP table (600 rows, level 1 = 0 for every rate). PokeAPI ids differ from game ids: 1 slow → game 5, 2 medium (fast) → 0, 3 fast → 4, 4 medium-slow → 3, 5 slow-then-very-fast (Erratic) → 1, 6 fast-then-very-slow (Fluctuating) → 2 |
| `pokemon_evolution.csv`, `evolution_triggers.csv` | `id,evolved_species_id,evolution_trigger_id,version_group_id,is_default,trigger_item_id,minimum_level,gender_id,location_id,held_item_id,time_of_day,known_move_id,known_move_type_id,minimum_happiness,minimum_beauty,minimum_affection,relative_physical_stats,party_species_id,party_type_id,trade_species_id,needs_overworld_rain,turn_upside_down,needs_multiplayer,near_special_rock,region_id,required_pokemon_form_id,evolved_pokemon_form_id,used_move_id,minimum_move_count,minimum_steps,minimum_damage_taken,nature_bitmask,condition_expression,percentage_chance`; `id,identifier` | Trade evolutions: trigger 2 = trade; `held_item_id`; `trade_species_id`; `version_group_id` = where the method was introduced (Feebas + Prism Scale = vg 11, BW) |
| `pokemon_game_indices.csv` | `pokemon_id,version_id,game_index` | Gen 1 internal order (version 1 Red) and Gen 3 internal ids (version 7 Ruby); Gen 4/5 are identity (checked) |
| `locations.csv`, `location_names.csv`, `location_game_indices.csv` | `id,region_id,identifier`; `location_id,local_language_id,name,subtitle`; `location_id,generation_id,game_index` | Gen 5 met location names only (section 1.3); English has 1,096 name rows, Spanish/Italian only 286 |
| `versions.csv`, `version_names.csv`, `version_groups.csv`, `languages.csv` | `id,version_group_id,identifier`; `version_id,local_language_id,name`; `id,identifier,generation_id,order`; `id,iso639,iso3166,identifier,official,order` | Game names; **chronology must use `version_groups.order`, not `id`** (Colosseum is id 12 but order 9, BW2 id 14 order 16, Red/Green JP id 28 order 1) |

**How the history tables work** (confirmed against known facts):

- `*_past` tables (`pokemon_stats_past`, `pokemon_types_past`, `pokemon_abilities_past`): `generation_id` is the
  **last** generation in which the stored (old) value applied. Value for generation G = the row with the smallest
  `generation_id ≥ G`, else the current table. Examples: Clefairy `35,5,1,1` = Normal through Gen 5 (Fairy from
  Gen 6); Magnemite `81,1,13,1` = pure Electric in Gen 1; Gengar `94,6,26,0,1` = Levitate through Gen 6; Pidgey
  `16,3,,0,2` = no second ability in Gen 3; Pikachu `25,5,3,30,0` = Defense 30 through Gen 5.
- No base-stat row has `generation_id` 2, 3 or 4 (the six `generation_id 3` rows only change EV yields), so
  **base stats are identical in Gen 2-5**; Gen 1 differs only by Special. (Classification run over all 236 rows.)
- `move_changelog`: each row holds the **old** values of the columns that changed when
  `changed_in_version_group_id` came out (other columns empty). Value for version group V = from the rows whose
  version group is *later* than V (by `version_groups.order`) and whose column is non-empty, take the earliest;
  else `moves.csv`. Examples: Bite `44,3,1,...` = Normal before Gold/Silver; Gust `16,3,1` = Normal in Gen 1;
  Tackle `33,11,,35,,95` = 35 power / 95 accuracy before BW and `33,17,,50` = 50 power before Sun/Moon.
- Damage class is per move only from Gen 4; for Gen 1-3 it is derived from the type (Showdown does this itself).

### 1.3 Verified defects (why PokeAPI alone is not enough)

Each row was reproduced from the fetched files with `scripts/xcheck_items.py`, `xcheck_items3.py`,
`xcheck_species.py` and the inline checks noted.

| Space | PokeAPI says | Ground truth | Evidence |
|---|---|---|---|
| Gen 2 item 0x15 | `elixir` (duplicate of 0x41) | MAX ELIXER | pokecrystal `constants/item_constants.asm` [pret-c] |
| Gen 2 items missing | no rows for Town Map, Poké Flute, GS Ball, **EnergyPowder (0x79)**, Egg Ticket, Berserk Gene, Normal/Gorgeous Box, Polkadot Bow, Brick Piece, all 10 mails (0x9E, 0xB5-0xBD) | present in pokecrystal | same |
| Gen 2 berries | PSNCUREBERRY → `pecha-berry`, PRZCUREBERRY → `cheri-berry`, BURNT/ICE/MINT/BITTER → `aspear/rawst/chesto/persim`, MIRACLEBERRY → `lum`, MYSTERYBERRY → `leppa`, GOLD_BERRY → `sitrus`, PINK_BOW → `silk-scarf` | different items with different in-game names | design choice in PokeAPI (useful as a *conversion* hint, wrong as a *display* name) |
| Gen 3 item 271 | Basement Key listed at 261 (together with Itemfinder), 271 missing | 271 = ITEM_BASEMENT_KEY | pokeemerald `include/constants/items.h` enum [pret-e] |
| Gen 5 items | Deep Sea Tooth 227 (Gen 4: 226), Blue/Yellow Apricorn swapped (486/487) | Gen 5 keeps Gen 4 ids; Deep Sea Tooth 226 (= `@pkmn/dex` num), Ylw 486, Blu 487 | pokeheartgold `include/constants/items.h` [pret-hg]; `@pkmn/dex` item nums |
| Gen 2 met landmarks | 0x46 missing; Route 23 and Victory Road both at 0x58; 0x59 missing | 0x46 LAV_RADIO_TOWER, 0x58 VICTORY_ROAD, 0x59 ROUTE_23; 0x7E GIFT, 0x7F EVENT | pokecrystal `constants/landmark_constants.asm` [pret-c] |
| Gen 3 met sections | 37 ids in 0x00-0xD4 missing (route sub-sections, Underwater, Navel Rock, Trainer Hill...), 0xFD-0xFF missing | 213 sections in Emerald, 197 in FR/LG, specials 0xFD egg / 0xFE in-game trade / 0xFF fateful encounter | pokeemerald `src/data/region_map/region_map_sections.json` + `.constants.json.txt`, pokefirered same file [pret-e, pret-fr] |
| Gen 5 met locations | 30001 (Poké Transfer) missing; 30007 listed as both "Distant land" and "Sinnoh"; 0, 3, 138 missing | 30001 = Poké Transfer [pkhex Locations.cs]; full special list **UNVERIFIED** | section 1.5 |

Everything else checked agreed: all 151 Gen 1 internal ids, all 386 Gen 3 internal ids, Gen 1 items (name spelling
only), 301 Gen 3 items, 499 Gen 4 items against pokeheartgold, Gen 4/5 species identity, Gen 1-5 type bytes, the
EXP table against the closed-form formulas (section 4.9), and PokeAPI's Gen 3-only abilities against
pokeplatinum's `sSpeciesWithNewAbilities` (89 species agree; pokeplatinum additionally lists the five
Eeveelutions, which have no second ability anyway so the entry is inert).

### 1.4 `@pkmn/dex` / `@pkmn/sim`: what to use them for

- Species `num` = National Dex; move `num` = move id; ability `num` = ability id; item `num` = **Gen 4/5 item
  index** for every item that exists in Gen 4+ (246 of 247 comparable Gen ≤5 items agree with PokeAPI's Gen 5
  index; the one disagreement is PokeAPI's Deep Sea Tooth error). Gen 2/3-only items get Showdown-private nums.
- Per-generation data is applied by `Dex.forGen(n)` through inheritance, so `forGen(1)` really has Gen 1 types and
  Special, `forGen(3)` has no hidden abilities, etc.
- **Recommendation**: do not add it to `build-data.mjs`. `showdown.js` maps our numeric ids to Showdown ids on the
  server, where `@pkmn/sim` is already loaded (see `battle-engine.md`): at start-up iterate `Dex.species.all()`,
  `Dex.moves.all()`, `Dex.items.all()`, `Dex.abilities.all()` and index by `num`. Never map by name: PokeAPI
  identifiers and Showdown ids diverge after punctuation is stripped for renamed moves (PokeAPI `vice-grip` →
  `vicegrip`, Showdown `visegrip`). Forms are mapped with a small curated table from our per-generation form
  number to the Showdown forme name (e.g. Deoxys 1 → `Deoxys-Attack`, Rotom 2 → `Rotom-Wash`, Shaymin 1 →
  `Shaymin-Sky`, Giratina 1 → `Giratina-Origin`, Arceus by held plate, Basculin 1 → `Basculin-Blue-Striped`,
  Tornadus/Thundurus/Landorus 1 → `-Therian`, Kyurem 1/2 → `-White`/`-Black` (note PokeAPI's Gen 5 numbering:
  `white` = 1, `black` = 2), Keldeo 1 → `Keldeo-Resolute`, Genesect by held Drive, Wormadam 1/2 → `-Sandy`/
  `-Trash`, Pichu 1 → `Pichu-Spiky-eared`; Unown, Burmy, Shellos/Gastrodon, Deerling/Sawsbuck are cosmetic).

### 1.5 pret files to read (all verified to exist at the commits below)

| Repo @ commit (2026-10-24) | File | Gives |
|---|---|---|
| pokered @ `171e2c204f9c` | `constants/pokemon_constants.asm` | Gen 1 internal order: 190 slots 0x01-0xBE = 151 species, 36 unused (`const_skip`), 0xB6 fossil Kabutops, 0xB7 fossil Aerodactyl, 0xB8 ghost |
| pokered | `constants/item_constants.asm`, `data/items/names.asm` | Gen 1 item ids and in-game names (needed only to name a Gen 1 catch-rate byte as the Gen 2 item it becomes) |
| pokered / pokeyellow @ `9327549dce06` | `data/pokemon/base_stats/*.asm` | Gen 1 catch rates (whether Yellow differs for any species: **UNVERIFIED**); only for validation |
| pokecrystal @ `5c877ef55197` | `constants/item_constants.asm`, `data/items/names.asm` | Gen 2 item ids and names |
| pokecrystal | `data/items/catch_rate_items.asm` | Time Capsule catch-rate → item replacements (section 2.1) |
| pokecrystal | `constants/landmark_constants.asm`, `data/maps/landmarks.asm` | Crystal met locations 0x00 special, 0x01-0x5F, 0x7E gift, 0x7F event |
| pokecrystal | `data/pokemon/gen1_base_special.asm`, `data/pokemon/gen1_order.asm` | Cross-check for PokeAPI's Gen 1 Special and internal order |
| pokeemerald @ `731ad5bfd6e6` | `include/constants/species.h` | Gen 3 internal ids: 1-251 = National, 252-276 = the 25 unused `OLD_UNOWN_B`..`Z`, 277 Treecko … 411 Chimecho, 412 Egg |
| pokeemerald | `include/constants/items.h` (an `enum`, index = position) | Gen 3 item ids 0-376 (includes FR/LG key items 349-374) |
| pokeemerald | `src/data/region_map/region_map_sections.json`, `region_map_sections.constants.json.txt` | Gen 3 met sections 0x00-0xD4 with names, `MAPSEC_NONE` = 0xD5, specials 0xFD/0xFE/0xFF |
| pokefirered @ `ce6406d8c2ea` | `src/data/region_map/region_map_sections.json` | FR/LG names for 0x58-0xC4 (0xC4 = CELADON DEPT. in FR/LG, SPECIAL AREA in Emerald); FR/LG `MAPSEC_NONE` = 0xC5 |
| pokeplatinum @ `be36a9db3d23` | `res/text/location_names.json` (126 names, ids 0-125), `res/text/special_met_location_names.json` (13 names: 2000 Day-Care Couple, 2001/2002 Link trade, 2003 Kanto, 2004 Johto, 2005 Hoenn, 2006 Sinnoh, 2007 "----", 2008 Distant land, 2009 Traveling Man, 2010 Riley, 2011 Cynthia, 2012 Mystery Zone), `res/text/mystery_gift_event_names.json` | Gen 4 met locations (DP/Pt) |
| pokeheartgold @ `6988158691eb` | `files/msgdata/msg/msg_0279.json` (235 names, ids 0-234; 55 Pal Park, 126 New Bark Town, 182 Route 34, 233 Pokéwalker) | Gen 4 met locations including HGSS |
| pokeheartgold | `include/constants/items.h` | Gen 4 item ids 0-536 (also Gen 5 for 1-536, except mails 137-148 and HM07/HM08 426/427) |
| pokeplatinum | `include/constants/gba/items.h`, `src/main_menu/gba_convert_string.c` | Gen 3 item constants as seen by Pal Park; the Gen 3 → Gen 4 character table (by name, two columns: Japanese / international) |

Gen 4 event locations 3000-3076 and all Gen 5 locations come from PokeAPI (Gen 4 3001-3076 present and
plausible). Gen 5 special ids that matter for us: 30001 Poké Transfer, 30003 Link trade, 30010-30013 Relocator
Celebi/crown beasts, 60002 Day-Care Couple [pkhex Locations.cs]; the remaining 300xx/400xx/600xx names are
**UNVERIFIED** until checked against a BW2 text dump.

### 1.6 Recommended combination and build pipeline

Cheapest reliable combination: **PokeAPI (pinned) for everything with a name or a per-generation history; pret
(pinned) for Gen 1/2 item ids, Gen 2/3/4 locations and Gen 3 items; a few hand-written tables for rules
(Time Capsule item fixes, Pal Park blocked items, HM lists, transfer locations)**. `scripts/build-data.mjs`:

1. Downloads the pinned files into a cache directory outside the repo (`fetch` with an explicit commit SHA in the
   URL, SHA-256 of each file recorded in `shared/data/SOURCES.json` so a rebuild is reproducible).
2. Parses CSV (a 20-line RFC 4180 parser is enough; `growth_rates.csv` has quoted multi-line fields) and the
   asm/C/JSON constants with small regexes (the patterns used in the scratch scripts work on the pinned commits).
3. Applies the history rules of 1.2 to produce one value per generation 1-5.
4. Applies the corrections of 1.3 by preferring pret where both exist.
5. Runs the cross-checks (species, items, locations, EXP formula, ability lists) and fails the build on any new
   disagreement.
6. Emits compact ES modules (arrays indexed by id, strings joined with `\n` and split at load) plus
   `LICENSE.pokeapi`.

### 1.7 Generated tables and who uses them

All modules live in `shared/data/` and are pure data (no logic beyond a lookup helper). Names are split into one
module per language (`names.en.js`, `names.ja.js`, …) so the browser only loads the UI language; English is always
loaded because in-game default names for Western languages are derived from it plus rules (section 1.8).

| Module | Contents | Source | Used by |
|---|---|---|---|
| `species.js` | for dex 1-649: introduced gen; gender byte (0, 31, 63, 127, 191, 254, 255 = genderless; from PokeAPI `gender_rate` -1/0/1/2/4/6/8); growth (game index 0-5); base friendship (species value; Gen 2-4 trades and Pal Park use the constant 70 instead); catch rate; `MAX_SPECIES = [_,151,251,386,493,649]` | PokeAPI | pk3-pk5 (gender bits, ability validation), stats, convert (PID search), view |
| `basestats.js` | `[hp,atk,def,spa,spd,spe]` for Gen 2-5 (one table, section 1.2) + Gen 1 Special per dex 1-151; per-form rows for Deoxys, Wormadam, Rotom, Giratina, Shaymin, Arceus (same stats all forms), Basculin, Darmanitan, Meloetta, Tornadus/Thundurus/Landorus, Kyurem | PokeAPI | stats, evolve (Gen 1 HP delta), showdown (only for checks) |
| `types.js` | types per species per gen (Gen 1 Magnemite/Magneton Electric; Clefairy line, Togepi line, Snubbull line, Marill line, Mr. Mime, Jigglypuff line etc. per `pokemon_types_past`; Rotom forms Electric/Ghost in Gen 4); Gen 1/2 type byte ↔ type; type names; Hidden Power order | PokeAPI | pk1 (type bytes must match base types), evolve (Gen 1 type update), view |
| `abilities.js` | ability names (1-164); per species/form the slots `[a1, a2, hidden]` for Gen 3, 4, 5; max id per gen 76/123/164 | PokeAPI | pk3 (ability bit → id), pk4/pk5 validation, convert (Pal Park ability), evolve (Gen 4/5 recompute), view |
| `moves.js` | names (1-559); per gen 1-5: type, PP, (power/accuracy for UI tooltips); max id per gen 165/251/354/467/559 | PokeAPI | all codecs (PP / PP Up validation), stats (max PP), view, convert (move-too-new checks) |
| `items.js` | per generation, game index → `{ name, itemId }` where `itemId` is PokeAPI's id (shared across generations): Gen 1 (only for catch-rate display), Gen 2 (pret), Gen 3 (pret enum + PokeAPI names), Gen 4 (pokeheartgold + PokeAPI names), Gen 5 (Gen 4 ids + PokeAPI 537-638, Gen 5 mails 137-148) | pret + PokeAPI | view, convert, evolve (held-item trade evolutions, Everstone id per gen), validate (max id per gen) |
| `item-maps.js` | `G1_CATCH_RATE_FIX` (11 pairs, section 2.1), `G3_TO_G4` (Uint16Array 377; 0 = no equivalent), `PAL_PARK_BLOCKED_G3` (the 145 ids of 2.2), `G4_TO_G5_EXCEPTIONS` (137-148, 426, 427), `G2_TO_G3_UNOFFICIAL` (section 2.5) | derived | convert |
| `natures.js` | 25 names per language in game order; `up = floor(n/5)`, `down = n % 5` over Atk, Def, Spe, SpA, SpD | PokeAPI (`game_index`) | stats, view, showdown |
| `balls.js` | Gen 3: 1-12; Gen 4: 1-16, HGSS 17-24 (25 Park, unused); Gen 5: 1-25 (25 Dream Ball) → name, item id | format docs + PokeAPI names | view, convert (HGSS ball byte → PK5) |
| `locations.js` | met location id → name per generation: Gen 2 (Crystal landmarks), Gen 3 (Emerald names for 0x00-0x57 and 0xC5-0xD4, FR/LG names for 0x58-0xC4, specials 0xFD-0xFF), Gen 4 (0-234, 2000-2012, 3000-3076), Gen 5 (0-153 + specials) | pret, PokeAPI | view (met line), convert (transfer locations) |
| `games.js` | origin game ids → names (Gen 3: 1 S, 2 R, 3 E, 4 FR, 5 LG, 15 CXD; Gen 4 adds 7 HG, 8 SS, 10 D, 11 P, 12 Pt; Gen 5 adds 20 W, 21 B, 22 W2, 23 B2); language byte ↔ code (1 ja, 2 en, 3 fr, 4 it, 5 de, 7 es, 8 ko Gen 4+) | format docs, PokeAPI `version_names` | view, convert |
| `exp.js` | `Uint32Array(6 × 100)` minimum EXP per level per game growth index; `GEN12_MEDIUM_SLOW_L1 = 0xFFFFCA` note | PokeAPI `experience.csv` (verified against formulas) | stats, codecs (level from EXP), convert (VC EXP reset) |
| `index-maps.js` | Gen 1 internal ↔ dex (190), Gen 3 internal ↔ dex (0-412) | PokeAPI + pret check | pk1, pk3, saves (party species lists) |
| `evolutions.js` | trade evolutions: `{ from, to, gen, item: { 2: id, 3: id, 4: id, 5: id }, partner }` (section 3.1) | PokeAPI `pokemon_evolution` + item maps | evolve, UI ("will evolve when traded") |
| `forms.js` | per species per gen: form count, names, battle-only flag, Showdown forme name | PokeAPI forms tables + curated Showdown names | codecs (validate), view (formName), showdown, convert (Arceus/Giratina/Shaymin rules) |
| `hm.js` (hand-written) | HM move ids: Gen 3 `15,19,57,70,148,249,127,291`; DPPt `15,19,57,70,432,249,127,431`; HGSS `15,19,57,70,250,249,127,431` | pokeplatinum `sGBAHMMoves`; Bulbapedia Poké Transfer | convert (eligibility) |

The same table by consumer:

- **pk1** codec: `index-maps` (internal order), `types` (Gen 1 type bytes), `moves` (max id 165, base PP), `exp`,
  `species` (growth). **pk2**: `moves` (251), `items` (Gen 2 ids), `exp`, `species`. **pk3**: `index-maps`
  (internal ids, unused 252-276), `abilities` (bit → id), `items` (max 376), `moves` (354), `species` (gender
  ratio), `forms` (Unown from PID). **pk4/pk5**: `abilities`, `items` (536 / 638), `moves` (467 / 559),
  `species`, `forms`, `balls`, `locations` (validation warnings only).
- **stats.js**: `basestats`, `exp`, `species` (growth), `natures`, `moves` (base PP per generation).
- **view.js (MonView names)**: `names.<lang>` (species, moves, items, abilities, natures, types), `forms`,
  `balls`, `locations`, `games`, plus the default-name rules of 1.8 for `isNicknamed` in Gen 1-3.
- **convert.js**: `index-maps`, `item-maps`, `items`, `abilities` (Gen 4 slots for Pal Park), `species`
  (gender ratio, growth for the VC EXP reset), `hm`, `forms`, `locations` (55, 30001, 0xD5), `games`, default
  names (1.8), text modules.
- **evolve.js**: `evolutions`, `items` (trigger items and Everstone per generation), `types` (Gen 1 update),
  `basestats` (Gen 1 HP delta), `abilities` (Gen 4/5 recompute), default names (1.8).
- **showdown.js** (server): `forms` (Showdown forme names), `natures`; ids by `num` from `@pkmn/sim` (1.4).
- **UI**: everything in `names.<lang>`, `games`, `balls`, `locations`, `evolutions` ("evolves when traded"),
  obedience thresholds (3.4, small hand-written table).

Rough size: everything above in English is about 150-250 KB of JS before gzip; each extra language pack adds
~60 KB (species, moves, items, abilities, natures). Location names stay English-only (pret has no other language
for Gen 4; PokeAPI has sparse coverage).

### 1.8 In-game default species names (needed for nickname detection and for writing names)

Gen 1-3 store no nickname flag, so "is nicknamed" means "the stored name differs from the species name as that
game writes it". Gen 4/5 store a flag but still write default names when a Pokémon evolves or converts. The games'
own name tables are the truth (pret has English tables for Gen 1-4); for other languages derive the name from
PokeAPI's localised name with these rules (behaviour confirmed by reading PKHeX's `SpeciesName` and by Bulbapedia's
Poké Transporter notes [bulba-transporter]; implemented independently):

| Generation | Western languages (en, fr, de, it, es) | Japanese | Korean |
|---|---|---|---|
| 1-2 | Uppercase. French: strip accents on E and I (É È Ê Ë → E, Î Ï → I). Mr. Mime is written without the space and with the Gen 1/2 period glyph: `MR.MIME`, French `M.MIME`. Farfetch'd uses the Gen 1/2 apostrophe glyph. ♂/♀ are single glyphs | katakana as PokeAPI ja-Hrkt | Gen 2 only; PokeAPI ko names except Poliwhirl and Tangela, which had different Korean names in Gen 2 (**UNVERIFIED**: exact Gen 2 spellings, take them from a Korean Gen 2 dump) |
| 3-4 | Uppercase, same French rule, straight apostrophe in `FARFETCH'D` (en/it/es), `MR. MIME` with a space | katakana | Gen 4 only: PokeAPI ko |
| 5 | Title case exactly as PokeAPI (`Mr. Mime`), straight apostrophe in `Farfetch'd` | katakana | PokeAPI ko |

Eggs: Gen 2 `EGG`/`OEUF`…, Gen 3 always the Japanese `タマゴ`, Gen 4 title case (`Egg`, French `Oeuf`), Gen 5 the
localised word for Egg (French `Œuf`). Japanese Gen 3 names of Japanese-origin Pokémon use full-width Latin letters, so a Japanese name never
equals a Western default name [bulba-palpark].

---

## 2. Official transfer paths, field by field

### 2.0 Conventions for `convert.js`

- Home stores the record in the format it was deposited in. A conversion runs **when the Pokémon is withdrawn into
  a save of another format** (or when a battle needs a view in another mechanics generation), so the target game
  and language are known. The output record replaces the stored one only when the withdrawal is committed.
- Every conversion appends `{ from, to, rule, at }` to a provenance list kept next to the record on the server
  (rule = `time-capsule`, `pal-park`, `poke-transfer`, `vc-model-v1`, ...). The bytes never carry it.
- Eligibility failures throw with a user-facing reason (e.g. "knows Surf, an HM in Ruby; delete it first").
- "Verbatim" below means the decoded field value is copied; checksums, encryption and block order are always
  rebuilt by `pkN.build`.

### 2.1 Gen 1 ↔ Gen 2: Time Capsule

Source: pokecrystal `engine/link/link.asm` (`CheckTimeCapsuleCompatibility`, `Link_PrepPartyData_Gen1` /
`.ConvertPartyStruct2to1`, `Link_ConvertPartyStruct1to2` / `.ConvertToGen2`, `TimeCapsule_ReplaceTeruSama`),
`engine/link/time_capsule.asm` (`ValidateOTTrademon`), `engine/link/time_capsule_2.asm`
(`ConvertMon_1to2`/`2to1`),
`data/items/catch_rate_items.asm` [pret-c]. `format-gen1-gen2.md` §8 already summarises the same code; this
section adds the record-level rules.

**Who may cross**

| Direction | Rule | Source |
|---|---|---|
| Gen 2 → Gen 1 | species ≤ 151 (an Egg is species 0xFD and fails this test); every move ≤ 165 (Struggle); not holding mail | `CheckTimeCapsuleCompatibility` |
| Gen 1 → Gen 2 | level ≤ 100 and the two type bytes equal the species' Gen 2 base types, except Magnemite/Magneton (Electric/Electric accepted); otherwise the Gen 2 game reports an "abnormal" Pokémon | `ValidateOTTrademon` |
| Languages | Western (en/fr/de/it/es) ↔ Western only; Japanese ↔ Japanese only (Japanese ↔ Western corrupts both saves); Korean Gold/Silver ↔ Western Gen 1/2 works on cartridge with garbled Hangul; VC releases do not connect across these groups at all | [bulba-trade], [bulba-timecapsule] |

Our rule: allow pk1 ↔ pk2 only within the same language group (ja, ko, Western). Korean pk2 → Western pk1 is
technically possible but produces garbage names; refuse it in v1.

**pk1 → pk2** (box records)

| pk2 field | Value |
|---|---|
| species | Gen 1 internal index → National Dex (`index-maps.js`) |
| held item | the Gen 1 catch-rate byte, except these values, which are unused ("Teru-sama") ids in Gen 2 and are replaced: `0x19 → 0x92` Leftovers; `0x2D → 0x53` Bitter Berry; `0x32 → 0xAE` Gold Berry; `0x5A, 0x64, 0x78, 0x87, 0xBE, 0xC3, 0xDC, 0xFA, 0xFF → 0xAD` Berry. 0 stays 0. Every other value becomes the item with that index (Mewtwo's 3 → BRIGHTPOWDER, 45 → Bitter Berry via the table) |
| moves, OT ID, EXP, stat exp ×5, DVs, PP bytes (with PP Up bits) | verbatim (the game copies these 25 bytes as one block) |
| level (box byte 0x1F) | the Gen 1 level (box level byte, which Gen 1 keeps equal to the party level) |
| friendship | 70 (`BASE_HAPPINESS`) |
| Pokérus | 0 |
| caught data (Crystal, 2 bytes) | 0 |
| nickname, OT name | verbatim bytes (same character set within a language group); the Gen 1 in-game-trade OT control code 0x5D stays as is |
| dropped | current HP, status, type bytes, catch rate (the Gen 2 box struct has none of them) |

**pk2 → pk1**

| pk1 field | Value |
|---|---|
| species | National → Gen 1 internal |
| current HP | the link code copies party HP; a box record has none, so write the Gen 1 maximum HP for the current level (what a freshly healed party Pokémon would carry) |
| box level | current level (the link struct carries 0 here, but Gen 1 rewrites the byte when it deposits) |
| status | 0 |
| type 1/2 | the species' Gen 1 types: Gen 2 base types except Magnemite and Magneton = Electric/Electric (Steel 0x09 does not exist in Gen 1) |
| catch rate | the Gen 2 held item id, raw. On the way back to Gen 2 the fix table never touches a real Gen 2 item (all its keys are unused ids), so held items survive a round trip |
| moves, OT ID, EXP, stat exp, DVs, PP | verbatim |
| lost | friendship, Pokérus, caught data (Crystal met location, time, level and OT gender) |

Gender, shininess, Unown letter and Hidden Power are DV-derived, so they survive both directions unchanged.

### 2.2 Gen 3 → Gen 4: Pal Park ("Migrate from …")

Sources: pokeplatinum `src/main_menu/gba_migrator.c` (eligibility), `src/main_menu/gba_pokemon.c`
(`BoxMonGBAToBoxMon`, `ConvertBoxMonGBAtoDSAbility`, `sSpeciesWithNewAbilities`),
`src/main_menu/gba_convert_string.c` (`GBA_ConvertStringToDS`), `src/item.c` (`Item_FromGBAID`),
`src/scrcmd_catching_show.c` (`ScrCmd_MoveCatchingShowMonsToPCBoxes`), `src/unk_02092494.c`
(`UpdateBoxMonStatusAndTrainerInfo` case 2), `src/battle/battle_lib.c` (`BattleSystem_SetPokemonCatchData`)
[pret-pt]; Bulbapedia Pal Park [bulba-palpark]; PKHeX `PK3.ConvertToPK4` [pkhex] read for comparison. HGSS has
the same feature; its code was not read (**UNVERIFIED** that it is byte-identical, though PKHeX treats it so).

**Eligibility** (the migrator greys out the Pokémon):

1. not an Egg;
2. knows none of the Gen 3 HMs: Cut 15, Fly 19, Surf 57, Strength 70, Flash 148, Rock Smash 249, Waterfall 127,
   Dive 291 (`sGBAHMMoves`);
3. not holding a blocked item (`sInvalidGBAItems`, resolved to ids with `include/constants/gba/items.h`, 145 ids):
   5 (Safari Ball), 52-62, 72, 82, 87-92, 99-102, 105, 112-120 (unused ids), 121-132 (all mail), 176-178 (unused
   berries), 226-253 (unused), 259-288 (R/S/E key items), 339-346 (HM01-08), 347-348 (unused), 349-376 (FR/LG
   and Emerald key items);
4. species valid: internal 1-251 or 277-411 (`IsGBASpeciesInvalid`), i.e. not one of the 25 unused slots.

Game rules we do not emulate: six at a time, once per 24 h in DP/Pt, the GBA game must have at least six Pokémon
in its boxes, cartridge languages must match (a Korean Gen 4 game accepts Japanese and English Gen 3 carts). The
language rule is about cartridges: Gen 3 trades work across languages, so a Pokémon of any language can reach any
Gen 4 language officially, and we allow that.

**Field mapping** (PK3 box → PK4 box). The game first builds the PK4 from a zeroed struct, then the Catching Show
step rewrites the met data. Everything not listed is 0.

| PK4 field | Value | Notes |
|---|---|---|
| PID | verbatim | so nature (PID mod 25), shininess (same TID/SID, same < 8 rule), Spinda spots and gender carry over |
| species | Gen 3 internal → National | |
| held item | Gen 3 id → Gen 4 id via `Item_FromGBAID` (search the Gen 4 item table for the entry whose stored Gen 3 id matches; none → 0). Our table `G3_TO_G4` reproduces this from PokeAPI item ids (e.g. 13 Potion → 17, 200 Leftovers → 234, 175 Enigma Berry → 208, 289 TM01 → 328) | eligibility already removed the items with no equivalent |
| OT ID (TID + SID) | verbatim | |
| EXP | verbatim | level unchanged (shared EXP tables) |
| friendship | 70 | |
| ability (byte 0x15) | Gen 4 species data: if the species has a second ability in Gen 4 and is in `sSpeciesWithNewAbilities` (species that had one ability in Gen 3 and gained another in Gen 4; PokeAPI `pokemon_abilities_past` rows with `generation_id 3, slot 2, ability_id empty` give the same 89 species) → ability 1; else if it has two abilities → slot chosen by the Gen 3 ability bit (bit 31 of the IV word); else ability 1 | the stored ability may now disagree with PID bit 0; Gen 4/5 recompute it on evolution (3.3) |
| markings | verbatim (Gen 3 has 4 marks, Gen 4 6; the two new ones 0) | |
| language | verbatim (same ids 1-5, 7) | |
| EVs ×6, Cool/Beauty/Cute/Smart/Tough, Sheen | verbatim | |
| moves ×4, PP Ups | verbatim; current PP = maximum PP for the PP Ups | the code reads max PP back after setting the move |
| IVs ×6 | verbatim | |
| Hoenn contest ribbons | Gen 3 stores a rank 0-4 per category (Cool, Beauty, Cute, Smart, Tough); rank n sets the first n of that category's Normal/Super/Hyper/Master ribbon bits; ranks > 4 set nothing | |
| other Gen 3 ribbons | Champion, Winning, Victory, Artist, Effort, Marine, Land, Sky, Country, National, Earth, World: 1:1 | PKHeX calls Marine/Land/Sky "ChampionBattle/Regional/National" |
| fateful encounter flag | Gen 3 "modern fateful encounter" (obedience) bit | |
| gender bits | recomputed from PID and species ratio (equals the Gen 3 gender) | |
| form | Unown: Gen 3 letter from the PID (section 4.6), mod 28. **Deoxys: from the GBA cartridge in the slot** (`gSystem.gbaCartridgeVersion`): Ruby/Sapphire 0 Normal, FireRed 1 Attack, LeafGreen 2 Defense, Emerald 3 Speed. Others 0 | we use `meta.game`, the Gen 3 game the record was deposited from |
| nickname | re-encoded (below); **nickname flag = (name ≠ species name in the destination game's language) or (Pokémon language ≠ destination game language)** | the flag needs `target.lang` |
| OT name | re-encoded with the same table, 7 chars + terminator | |
| origin game | verbatim (1 S, 2 R, 3 E, 4 FR, 5 LG, 15 CXD) | Gen 4/5 display the region from this: FR/LG Kanto, R/S/E Hoenn, CXD "distant land" |
| Pokérus, ball (1-12, same ids), OT gender | verbatim | the Park Ball is never stored (`BattleSystem_SetPokemonCatchData` keeps the Pokémon's own ball in Pal Park battles) |
| met location | **55 (Pal Park)** | Gen 3 met location is discarded |
| met date | the date the six Pokémon are moved to the PC after the Catching Show | use the withdrawal date |
| met level | **current level** | the Gen 3 met level (including "0 = hatched") is lost |
| egg location, egg date | 0 | Gen 3 egg history is lost |
| encounter type (0x85) | 0 | |
| DP vs Pt/HGSS copies | DP writes only the DP met-location field (0x80 = 55) and DP ball byte (0x83); Pt and HGSS also write their copies (0x46 = 55; HGSS's ball setter also writes the HGSS ball byte 0x86 = ball for balls 1-16, per `format-gen4.md` §12.9; HGSS's own Pal Park code was not read) | follow `target.game`; `format-gen4.md` §12.8-12.9 |

**Text re-encoding** (`GBA_ConvertStringToDS`): each Gen 3 byte indexes a two-column table (column chosen by the
Pokémon's language: Japanese vs everything else) giving a Gen 4 character code; the "wide space" and the
Japanese opening/closing double quotes are replaced by the space and quote characters of the Pokémon's language;
0xFF ends the string; a byte beyond the table turns the **whole** string into `?` repeated min(length − 1, 10)
times. Japanese-origin names map Latin letters to full-width forms, so they are always "nicknamed" in a Western
Gen 4 game [bulba-palpark]. Our implementation: decode with `text/gen3.js` using the record's language, encode
with `text/gen4.js`; the per-character table from pokeplatinum is the test oracle (generate test vectors from it,
do not copy it).

**Where PKHeX differs from the game** (so its output is not a byte oracle for us): it deletes HM moves instead of
refusing, force-hatches Eggs and names them, always gives Deoxys form 0, takes the nickname flag from a comparison
in the Pokémon's own language rather than the destination game's, masks the markings, and fills the unused bytes
after the string terminators with the "trash" a real Gen 4 game leaves there. None of these matter in-game except
the Deoxys form and the nickname flag.

### 2.3 Gen 4 → Gen 5: Poké Transfer

Sources: Bulbapedia Poké Transfer [bulba-poketransfer] and Transfer [bulba-transfer] for observable behaviour;
PKHeX `PK4.ConvertToPK5`, `PK5.GetTransferMetLocation4`, `PersonalInfo4` HM lists [pkhex] for field details. No
public decompilation of the BW/B2W2 transfer lab or the DS Download Play client was found (**UNVERIFIED** in the
strict sense: nothing below is confirmed by game code). `format-gen5.md` §8 has the PK5 layout.

**Eligibility**: not an Egg (including the Manaphy Egg); not Spiky-eared Pichu (HGSS form 1); knows no HM of the
**source** game: DP/Pt `Cut 15, Fly 19, Surf 57, Strength 70, Defog 432, Rock Smash 249, Waterfall 127,
Rock Climb 431`; HGSS the same with `Whirlpool 250` instead of Defog. The two games must share a language
(Download Play); the Pokémon's own language does not matter. No daily limit.

**Field mapping**: the 136 stored bytes are copied (the PK4 and PK5 box layouts coincide for every field below
that is not mentioned), then:

| PK5 offset / field | Value |
|---|---|
| 0x41 nature | PID mod 25 (overwrites the HGSS shiny-leaves byte) |
| 0x42 | 0 (no hidden ability, no N's Sparkle); 0x43 = 0 |
| 0x44-0x47 | 0 (the Pt/HGSS copies of egg and met location do not exist in PK5) |
| 0x7E egg location | unchanged DP copy. For an egg hatched in a Pt/HGSS-only place the DP copy holds 3002, so the PK5 shows "Faraway place" |
| 0x80 met location | **30001 Poké Transfer**. Exception (PKHeX `GetTransferMetLocation4`, which identifies them by species + fateful flag + Gen 4 origin): the movie-13 Raikou/Entei/Suicune get 30012 and Celebi 30010, the "event not activated" values; Bulbapedia confirms that these events do not activate after Poké Transfer, unlike the Relocator (whose values would be 30013 / 30011, **UNVERIFIED**) |
| 0x7B-0x7D met date | transfer date |
| 0x84 met level | current level (bit 7 = OT gender kept) |
| 0x83 ball | the effective Gen 4 ball: HGSS byte 0x86 when the origin game is HG/SS and that byte is non-zero, else 0x83. Apricorn and Sport balls (17-24) therefore survive |
| 0x86 | 0; 0x87 = 0 (HGSS walking mood; PK5 uses 0x87 for Pokéstar fame) |
| friendship | 70 |
| held item | **removed** (the real Poké Transfer returns it to the Gen 4 Bag; "Gen 4 is the only generation where transferred Pokémon keep held items" [bulba-transfer]). PKHeX keeps any item valid in BW instead |
| Arceus | form 0 (its plate leaves with the item) |
| Giratina | form 0 when it ends up without a Griseous Orb (**UNVERIFIED** whether BW would fix this itself; keep the record self-consistent) |
| Shaymin | already Land in a box record (Gen 4-6 revert Sky Forme on PC deposit [bulba-shaymin]) |
| Shedinja | gender bits = genderless (DP/HGSS-evolved Shedinja kept Nincada's gender; PKHeX corrects it) |
| PP | maximum for the PP Ups |
| nickname, OT name | decode Gen 4 charset, re-encode Gen 5 (a few glyph remaps; `format-gen4.md` §13, `format-gen5.md` §9); nickname flag unchanged; unnicknamed Gen 4 names stay in ALL CAPS until the Pokémon evolves in Gen 5 |
| everything else | verbatim: PID, TID/SID, species, form, EXP, EVs, IVs, egg and nickname flags, ability byte, moves, PP Ups, ribbons (same three blocks), contest stats, markings, language, origin game, Pokérus, encounter type 0x85, egg date, fateful flag, gender |

The ability byte is kept. Gen 5 recomputes abilities on evolution using PID bit 0 for origin games < 20 (Gen 3/4
origins) and bit 16 for Gen 5 origins (`format-gen5.md` §8.6), so a Pal Park Pokémon whose ability disagrees with
PID bit 0 still changes ability when it evolves.

### 2.4 Gen 1/2 → Gen 7: Poké Transporter for the Virtual Console games (the official model)

Sources: Bulbapedia Poké Transporter [bulba-transporter]; PKHeX `PK1.ConvertToPK7`, `PK2.ConvertToPK7`,
`PK7.SetTransferPID`, `TransporterLogic` [pkhex]. This path does not touch our formats; it is listed because it is
the only official definition of how a DV-era Pokémon becomes a PID-era Pokémon.

| Aspect | Rule |
|---|---|
| eligibility | Box 1 only; no Eggs; Gen 2 Pokémon holding an item are refused; a Gen 1 catch-rate "item" is silently dropped; level > 100 is clamped; HM moves allowed; legality filters (Mew must be OT GF / ID 22796, Celebi ≥ Lv 30, a Pokémon knowing Dizzy Punch from the Odd Egg is refused until it forgets it; PKHeX deletes the move instead) |
| species, TID | kept; **SID = 0** |
| nature | **EXP mod 25**, taken before the EXP reset |
| EXP | reset to the minimum for the current level |
| IVs | random, three of them forced to 31 (five for Mew and Celebi); so Hidden Power type usually changes |
| EVs | 0 (stat exp discarded) |
| gender | Gen 2 rule from the Attack DV (Transporter ≥ 1.3; 1.2 was random) |
| shiny | Gen 2 DV rule (≥ 1.3); the random PID is then forced shiny (upper half = TID ⊕ lower half) or forced non-shiny (flip the PID's top bit) |
| ability | hidden ability, except species with no hidden ability in Gen 7: Gastly line, Koffing line, Mew; Gen 2 also Misdreavus, Unown, Celebi (slot 1) |
| Unown | form from the Gen 2 DV letter |
| met data | origin game = the VC game; met location 30013 "Kanto" (Gen 1) / 30017 "Johto" (Gen 2); met level = current level; met date = transfer date |
| ball | Poké Ball |
| language | the VC game's language |
| names | unnicknamed if the name equals the Gen 7 species name (ALL CAPS or normal case) after transcoding, else kept as a nickname (bugs: Gen 1/2 `MR.MIME`, French names that lost accents, two Korean names become "nicknames"); OT transcoded; the Gen 1 in-game trade OT code becomes the localised "Trainer" |
| fateful encounter | set for Mew and Celebi |
| friendship | species base friendship; Pokérus not transferred |

### 2.5 Unofficial Gen 1/2 → Gen 3 (opt-in): design modelled on 2.4

Goal: a PK3 that the Gen 3 games accept and display sensibly, that keeps everything the player can see in Gen 1/2
(species, level, moves, nickname, OT, gender, shininess, Unown letter), and that converts deterministically (same
input → same output, so tests and the server's re-validation are exact). Rule id `vc-model-v1`.

**Refuse**: Eggs; Korean pk2 (no Korean Gen 3 games, `format-gen3.md` §4.3); Gen 2 Pokémon holding an item unless
the user explicitly accepts losing it (VC refuses them outright); glitch species.

| PK3 field | Value | Basis |
|---|---|---|
| species | National Dex (Gen 3 internal id = dex for 1-251) | |
| TID / SID | Gen 1/2 OT ID / **0** | VC |
| PID | searched, see below | VC idea, Gen 3 constraints |
| nature (PID mod 25) | **original EXP mod 25** | VC |
| EXP | minimum EXP of the current level (level from the original EXP with the Gen 3 table, capped at 100) | VC |
| IVs | `IV = 2 × DV + b`, with HP DV derived as in Gen 1/2 and both SpA and SpD from the Special DV; the six bits `b` are chosen to give the Gen 3 Hidden Power the **same type** as the Gen 1/2 DVs (below) | our choice (VC's random IVs would make the conversion non-deterministic and change the Pokémon) |
| EVs, contest stats, ribbons, markings, Pokérus | 0 | VC (stat exp erased) |
| held item | 0 (Gen 1 catch rate ignored; Gen 2 item only with consent, dropped) | VC; a later `G2_TO_G3_UNOFFICIAL` map could keep items that exist in Gen 3 |
| moves, PP Ups | verbatim (ids 1-251 are the same in Gen 3); PP = maximum | VC heals PP |
| friendship | 70 | Gen 3 trade/Pal Park constant |
| ability bit | PID bit 0 (what a wild Gen 3 Pokémon would have) | |
| obedience/fateful bit | set for Mew (151) and Celebi (251) | VC sets fateful for both; FR/LG and Emerald make Mew (and Deoxys) disobey without it [bulba-obedience] |
| language | save language: ja 1, en 2, fr 3, it 4, de 5, es 7 | VC |
| origin game | our convention: Red, Yellow, Gold, Crystal → FireRed (4); Blue, Green, Silver → LeafGreen (5) | VC uses the VC game; Gen 3 has no Johto game, and FR/LG make Gen 4/5 say "Kanto" |
| met location | **0xD5** (`MAPSEC_NONE` in Emerald): not a real place in any Gen 3 game and not one of the specials 0xFD-0xFF. Emerald shows "met somewhere" (own OT) or "obtained in a trade"; FR/LG treat anything outside 0x58-0xC4 as "a trade" (pokefirered `PokeSum_PrintTrainerMemo_*`) | VC uses a region placeholder |
| met level | current level (never 0, which means "hatched") | VC |
| ball | Poké Ball (4) | VC |
| OT gender | Gen 1 and Gold/Silver: male; Crystal: the OT-gender bit of the caught data | VC (PKHeX copies Crystal's bit) |
| nickname | if the name equals the Gen 1/2 default name in the save language (section 1.8) → the Gen 3 default name in that language; else transcode the nickname (decode Gen 1/2, encode Gen 3; `PK`/`MN` glyphs exist in Gen 3; replace unencodable characters like Transporter does: `×` → `x`, `[ ]` → `( )`) | VC behaviour, without its Mr. Mime bug |
| OT name | transcoded; the Gen 1 in-game-trade code 0x5D becomes the Gen 1/2 word in the save language (`TRAINER`, `DRES.`/`DRESSEUR`, `ALLEN.`, `ENTREN.`, `トレーナー`) | VC |
| egg flags | not an egg; "has species" set | |

**PID search** (deterministic):

```
want.nature = originalExp % 25
want.shiny  = gen2Shiny(dvs)                  // def = spe = spc = 10 and atk in {2,3,6,7,10,11,14,15}
want.gender = gen2Gender(species, dvs)        // female iff atk <= ratio >> 4 (section 4.4)
want.letter = species == 201 ? gen2Unown(dvs) : none
rng = seeded PRNG (e.g. a 32-bit xorshift seeded from SHA-256 of the source record bytes)
repeat:
  lo = rng() & 0xFFFF
  hi = want.shiny ? (TID ^ SID ^ lo ^ (rng() & 7)) : (rng() & 0xFFFF)
  p  = hi << 16 | lo
  reject if p % 25 != want.nature
  reject if !want.shiny and ((TID ^ SID ^ hi ^ lo) < 8)
  reject if species has both genders and genderFromPid(p, ratio) != want.gender
  reject if want.letter != none and gen3UnownLetter(p) != want.letter
  return p
```

Expected tries ≈ 25 × (1 / P(gender)) — about 50-210 for ordinary species, about 700 for Unown; constraints are
always satisfiable (Gen 2 never produces a shiny female of a 12.5 %-female species, and Unown has no gender). The
game itself creates constrained Pokémon the same way (pokeemerald `CreateMonWithGenderNatureLetter` loops random
PIDs until nature, gender and Unown letter match [pret-e]).

**IV low bits for Hidden Power**: Gen 1/2 type index `t = 4 × (atk mod 4) + (def mod 4)` (0 Fighting … 15 Dark).
Gen 3 type = `floor(15 × v / 63)` with `v = b_hp + 2 b_atk + 4 b_def + 8 b_spe + 16 b_spa + 32 b_spd`
(section 4.3). Every `t` has candidates: v 0-4 → 0, 5-8 → 1, 9-12 → 2, 13-16 → 3, 17-20 → 4, 21-25 → 5,
26-29 → 6, 30-33 → 7, 34-37 → 8, 38-41 → 9, 42-46 → 10, 47-50 → 11, 51-54 → 12, 55-58 → 13, 59-62 → 14, 63 → 15.
Pick the candidate with the fewest set bits (ties: smallest v), so as few stats as possible gain the +1. The Gen 3
power then follows from the DVs' lowest bits and generally differs from the Gen 2 power (30-70 either way). With
`IV = 2 × DV + b` and 0 EVs, a Gen 3 stat **before the nature modifier** equals the Gen 1/2 stat with zero stat
exp, or exceeds it by at most 1 (compare the formulas in 4.1/4.2; this is the same equivalence `battle-engine.md`
uses for Showdown sets). The EXP-derived nature then moves two stats by ±10 %, exactly as VC transfers do.

### 2.6 Chained conversions

- pk3 → pk5 = Pal Park then Poké Transfer, run in sequence with the same `target` (the virtual Gen 4 game's
  language = the Gen 5 save's language, because Poké Transfer needs same-language games). Pick the virtual Gen 4
  game per Pokémon so the HM rule passes if possible (Defog → use HGSS, Whirlpool → use Pt). The result is
  exactly what the real chain produces: the Pal Park met data is overwritten by Poké Transfer anyway, the Deoxys
  form fixed by Pal Park is kept, and the held item is removed by Poké Transfer.
- pk1 → pk3 / pk1 → pk5: Time Capsule first is unnecessary (2.5 handles pk1 directly). pk1 → pk2 → pk3 gives the
  same Pokémon because 2.1 preserves every field 2.5 reads, with two exceptions: a pk1 is never refused for a held
  item (its catch-rate byte is ignored, while the pk2 copy would be "holding" that item), and the origin-game
  convention follows the save the record last came from.
- No other chains exist. In particular there is no path out of Gen 5 and none from Gen 3+ back to Gen 1/2.

---

## 3. Trade evolutions and receiving a Pokémon in trade

### 3.1 Trade evolutions (species ≤ 649)

From PokeAPI `pokemon_evolution.csv` (trigger 2) joined with item indices; item ids checked against pokecrystal,
pokeemerald and pokeheartgold constants. A row applies from the generation in the "gen" column onward.

| From → To | Gen | Held item (consumed) | Item id Gen 2 / 3 / 4-5 |
|---|---|---|---|
| Kadabra → Alakazam | 1 | none | |
| Machoke → Machamp | 1 | none | |
| Graveler → Golem | 1 | none | |
| Haunter → Gengar | 1 | none | |
| Poliwhirl → Politoed | 2 | King's Rock | 0x52 / 187 / 221 |
| Slowpoke → Slowking | 2 | King's Rock | 0x52 / 187 / 221 |
| Onix → Steelix | 2 | Metal Coat | 0x8F / 199 / 233 |
| Scyther → Scizor | 2 | Metal Coat | 0x8F / 199 / 233 |
| Seadra → Kingdra | 2 | Dragon Scale | 0x97 / 201 / 235 |
| Porygon → Porygon2 | 2 | Up-Grade | 0xAC / 218 / 252 |
| Clamperl → Huntail | 3 | DeepSeaTooth | — / 192 / 226 |
| Clamperl → Gorebyss | 3 | DeepSeaScale | — / 193 / 227 |
| Rhydon → Rhyperior | 4 | Protector | — / — / 321 |
| Electabuzz → Electivire | 4 | Electirizer | — / — / 322 |
| Magmar → Magmortar | 4 | Magmarizer | — / — / 323 |
| Porygon2 → Porygon-Z | 4 | Dubious Disc | — / — / 324 |
| Dusclops → Dusknoir | 4 | Reaper Cloth | — / — / 325 |
| Boldore → Gigalith | 5 | none | |
| Gurdurr → Conkeldurr | 5 | none | |
| Feebas → Milotic | 5 | Prism Scale (537) | (the Gen 3/4 beauty level-up method still exists) |
| Karrablast → Escavalier | 5 | none; **only when traded for a Shelmet** | |
| Shelmet → Accelgor | 5 | none; **only when traded for a Karrablast** | |

Everstone ids: Gen 2 0x70, Gen 3 195, Gen 4-5 229.

### 3.2 When a trade evolution happens

| Rule | Gen 1 | Gen 2 | Gen 3 | Gen 4 | Gen 5 |
|---|---|---|---|---|---|
| Everstone blocks it | (no held items; always evolves) | yes, every trade evolution | yes (any evolution except item use) | yes, **except Kadabra** | yes, except Kadabra [bulba-everstone] |
| Item-based trade evolution in a Time Capsule trade | n/a | never (the Gen 2 code skips them in Time Capsule mode); plain ones (Kadabra …) do evolve | | | |
| Held item consumed | | at the check | at the check (`GetEvolutionTargetSpecies`, trade mode) | after the evolution scene finishes (`EVO_TRADE_WITH_HELD_ITEM`) | yes (**UNVERIFIED** in code) |
| Player can stop it with B | no [bulba-trade] | no per Bulbapedia (the shared evolution routine has a cancel path; **UNVERIFIED** whether trades can reach it) | no (the trade evolution scene has no cancel) | no | no |
| Other gates | | | FR/LG without the National Dex: an evolution into a species > 151 is cancelled automatically and the item is not consumed (pokefirered `GetEvolutionTargetSpecies`, `evolution_scene.c`) | | Karrablast/Shelmet: neither evolves if either holds an Everstone [bulba-karrablast] |

Sources: pokered `engine/pokemon/evos_moves.asm`; pokecrystal `engine/pokemon/evolve.asm`; pokeemerald
`src/pokemon.c`, `src/evolution_scene.c`; pokefirered same; pokeplatinum `src/pokemon.c`
(`Pokemon_GetEvolutionTargetSpecies`: the Kadabra exception is explicit), `src/evolution.c` [pret-*].

### 3.3 What evolving changes in the record

| Effect | Gen 1 | Gen 2 | Gen 3 | Gen 4 | Gen 5 |
|---|---|---|---|---|---|
| species | yes | yes | yes | yes | yes |
| other stored fields | **type bytes** set to the new species' Gen 1 types; **current HP += new max HP − old max HP** (Gen 1 box records keep current HP) | (box records hold no stats) | ability slot bit unchanged, so the ability becomes the new species' ability in that slot (slot 1 if it has only one) | **ability recomputed** from PID bit 0 (`BoxPokemon_CalcAbility`) | **ability recomputed**: hidden-ability flag → hidden; else slot by PID bit 16 for Gen 5 origin, bit 0 for origin < 20 (`format-gen5.md` §8.6) |
| default name | if the name equals the old species name in the game's language → new species name (`RenameEvolvedMon`) | same (`UpdateSpeciesNameIfNotNicknamed`) | only if the Pokémon's language = game language **and** name = old species name (`EvolutionRenameMon`) | if the nickname flag is clear → new species name in the **game's** language (`MON_DATA_SPECIES_NAME`) | if the flag is clear → species name in the game's language, title case (ALL CAPS Gen 4 names become title case here) [bulba-nickname] |
| Pokédex | seen + owned | seen + caught | seen + caught | `Pokedex_Capture` | seen + caught |
| moves | offered level-up moves of the new species at the current level | same | same | same | same |

### 3.4 Receiving a Pokémon in a trade

| Effect | Gen 1 | Gen 2 | Gen 3 | Gen 4 | Gen 5 |
|---|---|---|---|---|---|
| friendship | (none; Yellow's partner Pikachu is separate) | 70 (`AddTempmonToParty`) | 70, not for Eggs (`TradeMons`) | 70, not for Eggs (`TRADE_FRIENDSHIP_RESET_VALUE`) | species base friendship (**UNVERIFIED**; 70 for nearly all species) |
| Pokédex | seen + owned (pokered `_AddEnemyMonToPlayerParty`) | seen + caught, Unown Dex | seen + caught (passes the PID so Spinda/Unown "first seen" can be stored) | yes (**UNVERIFIED**: code location not found in the trade files read) | yes |
| Eggs | n/a | kept as is | kept as is | met location + date set to 2002 "Link trade" (`UpdateMonStatusAndTrainerInfo` case 5); on hatching that moves to the egg location | same idea with 30003 (PKHeX `Locations.TradedEggLocation`) |
| gender | DV-derived | DV-derived | PID-derived | gender bits rewritten from PID (`MON_DATA_GENDER` recalculated) | stored; consistent with PID |
| other | | party mail travels with the Pokémon | mail travels; sender's mail slot cleared | Seal capsule data cleared; Chatot cry reset if the sender has no Chatot left; Arceus event flag | |
| OT, nickname | unchanged | unchanged | unchanged | unchanged | unchanged |

Home records are PC-box records, and every game's PC refuses Pokémon holding mail, so mail never enters Home
(refuse to deposit a party Pokémon holding mail, `format-gen3.md` §8.8).

**Obedience** (outsider = OT name or ID differs from the save's trainer; the level cap rises with badges)
[bulba-obedience]:

| Games | No badge | Then |
|---|---|---|
| R/B/Y, FR/LG | 10 | Cascade 30, Rainbow 50, Marsh 70, Earth all |
| G/S/C | 10 | Hive 30, Fog 50, Storm 70, Rising all |
| HG/SS | 10 | counts badges, Kanto ones included: any 1 badge 20, any 2 badges 30, Fog 50, Mineral 70, any 8 badges all (pokeheartgold `TryDisobedience`; corrected in stage-1 review) |
| R/S/E | 10 | Knuckle 30, Heat 50, Feather 70, Rain all |
| D/P/Pt | 10 | 2 badges 30, 4 → 50, 6 → 70, 8 → all |
| B/W | 10 | Trio 20, Basic 30, Insect 40, Bolt 50, Quake 60, Jet 70, Freeze 80, Legend all |
| B2/W2 | 10 | Basic 20, Toxic 30, Insect 40, Bolt 50, Quake 60, Jet 70, Legend 80, Wave all |

FR/LG and Emerald: Mew and Deoxys without the fateful-encounter flag never obey [bulba-obedience]. The UI can warn
on withdrawal when the save's badges are below the Pokémon's level; nothing in the record changes.

### 3.5 What `tradeEvolve()` does on the server

Home trades swap owners of records; the records keep their formats (a pk1 can be traded for a pk5). The server
applies trade evolution with the rules of **the record's own generation**, as if that trade had happened in that
generation, immediately when the trade commits, so both players see the result:

1. Look up the trade evolution for `(species, held item)` in that generation's table (3.1, rows with gen ≤ the
   record's gen); for Karrablast/Shelmet require `partnerSpecies` to be the other one.
2. Apply the Everstone rule of that generation (none for pk1; Kadabra exception from pk4).
3. Change species, clear the held item if it was the trigger, apply the per-generation side effects of 3.3
   (pk1 type bytes and HP delta, pk4/pk5 ability recomputation).
4. Rename if the Pokémon counts as unnicknamed. The receiving game's language is unknown, so use the **Pokémon's
   own language** (`meta.lang` for pk1/pk2, the language byte for pk3-pk5) as the "game language". This matches
   the cartridge whenever the receiver plays a game of the same language and avoids the Gen 4/5 quirk of renaming
   foreign Pokémon into the local language.
5. Set friendship to 70 (pk2-pk4; pk5 base friendship), as the receiving game would.
6. Do not learn moves (no player to ask); do not apply the FR/LG National Dex gate (the receiver's save is not
   known at trade time). Both deviations are listed in the UI help.
7. Return `{ record, meta, from, to }` and record it in the trade history.

Pokédex registration happens on withdrawal through `save.registerDex` (the format docs say which flags each game
needs: Gen 2 Unown Dex, Gen 3 Spinda/Unown personality, Gen 4 form/gender tables, Gen 5 forms).

---

## 4. Formulas: stats, Hidden Power, gender, shininess, Unown, Spinda, EXP

All divisions are integer divisions rounding down. `DV` = 0-15, `IV` = 0-31.

### 4.1 Stats, Gen 1-2 (pokecrystal `CalcMonStatC`; `format-gen1-gen2.md` §7.4)

- HP DV = `(atk & 1) << 3 | (def & 1) << 2 | (spe & 1) << 1 | (spc & 1)`.
- Stat-exp bonus `e = floor(min(255, ceilSqrt(statExp)) / 4)`, `ceilSqrt(x)` = smallest n with n² ≥ x.
- `stat = floor(((base + DV) × 2 + e) × L / 100) + 5`; HP: `floor(((base + DV) × 2 + e) × L / 100) + L + 10`.
  Capped at 999.
- Gen 1 Special uses the Gen 1 base Special with the Special DV and Special stat exp. Gen 2 Sp. Atk and Sp. Def
  both use the Special DV and Special stat exp with their own base stats.

### 4.2 Stats, Gen 3-5

- HP: `floor((2 × base + IV + floor(EV / 4)) × L / 100) + L + 10`; Shedinja always 1.
- Others: `floor((floor((2 × base + IV + floor(EV / 4)) × L / 100) + 5) × N / 100)` with N = 110 / 100 / 90.
- EVs ≤ 255 each, ≤ 510 in total.
- Nature index n (= PID mod 25 in Gen 3/4, the stored byte in Gen 5): raised stat `floor(n / 5)`, lowered stat
  `n mod 5`, over the order Atk, Def, Spe, SpA, SpD; neutral when both are equal (Hardy 0, Docile 6, Serious 12,
  Bashful 18, Quirky 24). Example: Adamant 3 = +Atk −SpA; Timid 10 = +Spe −Atk; Modest 15 = +SpA −Atk.

### 4.3 Hidden Power

- **Gen 2** (pokecrystal `HiddenPowerDamage`): type = `4 × (atk & 3) + (def & 3)` indexing Fighting, Flying,
  Poison, Ground, Rock, Bug, Ghost, Steel, Fire, Water, Grass, Electric, Psychic, Ice, Dragon, Dark.
  Power = `floor((5 × X + (spc & 3)) / 2) + 31` with `X = 8·[atk ≥ 8] + 4·[def ≥ 8] + 2·[spe ≥ 8] + [spc ≥ 8]`
  (range 31-70). Gen 1 has no Hidden Power, but the same DVs give the type if a Gen 1 Pokémon reaches Gen 2.
- **Gen 3-5** (pokeemerald `Cmd_hiddenpowercalc`): with `a…f` = lowest bit of the HP, Atk, Def, Spe, SpA, SpD IVs
  (in that order) and `u…z` = their
  second-lowest bit (`IV & 2`): type = `floor(15 × (a + 2b + 4c + 8d + 16e + 32f) / 63)` (same type order),
  power = `floor(40 × (u + 2v + 4w + 8x + 16y + 32z) / 63) + 30` (range 30-70). Gen 6+ fixes the power at 60.

### 4.4 Gender

- Ratio byte r (species data): 0 always male, 254 always female, 255 genderless, else 31 / 63 / 127 / 191 for
  12.5 / 25 / 50 / 75 % female.
- **Gen 2** (and Gen 1 Pokémon whenever they are interpreted by Gen 2 or VC): female iff
  `(atkDV << 4 | speDV) ≤ r`; because r's low nibble is always F this is "female iff atkDV ≤ r >> 4", i.e.
  Atk DV ≤ 1 / 3 / 7 / 11 (pokecrystal `GetGender`).
- **Gen 3-5**: female iff `(PID & 0xFF) < r` (for 0 < r < 254). Gen 4 and 5 also store the gender bits, which must
  agree. Because the threshold depends on the species, an evolution can change gender: Azurill is 75 % female
  (r = 191) and Marill 50 % (r = 127), so a female Azurill whose PID low byte is 127-190 becomes a male Marill
  [bulba-transporter].

### 4.5 Shininess

- **Gen 2**: shiny iff Def DV = Spe DV = Spc DV = 10 and `atkDV & 2` (Atk ∈ {2, 3, 6, 7, 10, 11, 14, 15})
  (pokecrystal `CheckShininess`; PKHeX: `(DV16 & 0x2FFF) == 0x2AAA`). Gen 1 has no shininess on cartridge;
  Gen 2 and VC apply the rule to Gen 1 Pokémon.
- **Gen 3-5**: shiny iff `(TID ^ SID ^ (PID >> 16) ^ (PID & 0xFFFF)) < 8`. Gen 6+ uses < 16, which is why Poké
  Transporter flips the top PID bit of Gen 5 Pokémon whose value is 8-15.

### 4.6 Unown

- **Gen 2**: `v = (atk & 6) << 5 | (def & 6) << 3 | (spe & 6) << 1 | (spc & 6) >> 1`; letter = `floor(v / 10)`,
  0 = A … 25 = Z (pokecrystal `GetUnownLetter`). Only A-Z exist.
- **Gen 3**: letter = `((PID >> 24 & 3) << 6 | (PID >> 16 & 3) << 4 | (PID >> 8 & 3) << 2 | (PID & 3)) mod 28`;
  26 = !, 27 = ? (pokeemerald `GET_UNOWN_LETTER`). Not stored.
- **Gen 4-5**: stored form byte 0-27; Pal Park writes the Gen 3 formula's value there.

### 4.7 Spinda (Gen 3-5)

Four spots; spot i (i = 0…3) uses PID byte i, least significant first: horizontal offset `(byte & 0x0F) − 8`,
vertical offset `(byte >> 4) − 8`, relative to that spot's fixed base position on the sprite (pokeemerald
`DRAW_SPINDA_SPOTS`). The pattern therefore survives Pal Park and Poké Transfer (same PID). Gen 6+ uses the
encryption constant instead. For our UI this is optional (plain sprite is acceptable).

### 4.8 Ability slot

- Gen 3: explicit bit (bit 31 of the IV word); wild Pokémon get it from PID bit 0. If the species has one ability,
  slot 1 is used whatever the bit.
- Gen 4: the ability id is stored; when the game computes it (capture, evolution) it uses PID bit 0 when the
  species has a second ability (pokeplatinum `BoxPokemon_CalcAbility`).
- Gen 5: ability id stored plus the hidden-ability flag (0x42 bit 0); computed from PID bit 16 for Gen 5 origins
  and bit 0 for older origins.

### 4.9 EXP groups

Game growth index (species data) and the minimum EXP for level n (n ≥ 2; **level 1 is 0 in every Gen 3+ table**
and in PokeAPI's `experience.csv`):

| Index | Group (PokeAPI id) | Formula |
|---|---|---|
| 0 | Medium Fast (2) | n³ |
| 1 | Erratic (5) | n ≤ 50: n³(100 − n)/50; 51-68: n³(150 − n)/100; 69-98: n³ × floor((1911 − 10n)/3) / 500; 99-100: n³(160 − n)/100 |
| 2 | Fluctuating (6) | n ≤ 15: n³(floor((n + 1)/3) + 24)/50; 16-36: n³(n + 14)/50; 37-100: n³(floor(n/2) + 32)/50 |
| 3 | Medium Slow (4) | floor(6n³/5) − 15n² + 100n − 140 |
| 4 | Fast (3) | floor(4n³/5) |
| 5 | Slow (1) | floor(5n³/4) |

Verified: these formulas reproduce all 594 non-level-1 rows of PokeAPI's `experience.csv` exactly. Level 100:
1,000,000 / 600,000 / 1,640,000 / 1,059,860 / 800,000 / 1,250,000.

Level-1 special case: Gen 1/2 evaluate the formula at run time instead of using a table, so Medium Slow level 1
is −54, stored in the 24-bit EXP field as 16,777,162 (0xFFFFCA); this is the experience underflow glitch, and in
Gen 1 such a Pokémon freezes the game when withdrawn from the PC [bulba-experience]. No legitimate Gen 1/2 Pokémon
is level 1. Indices 1 and 2 exist in Gen 1/2 as "slightly fast" (¾n³ + 10n² − 30) and "slightly slow"
(¾n³ + 20n² − 70) but no species uses them (pokecrystal `constants/pokemon_data_constants.asm`); from Gen 3 the
same indices mean Erratic and Fluctuating, used only by Gen 3+ species.

Rules for `stats.js`: level from EXP = the largest n with `exp ≥ table[n]` (table with level 1 = 0), capped at
100; Gen 1/2 records also store a level byte, which the games trust; show that and use EXP only when converting.

### 4.10 PP

- Gen 1-2: max PP = `base + ups × min(7, floor(base / 5))` (40-PP moves reach 61; the field holds 6 bits).
- Gen 3-5: max PP = `base + floor(base × ups / 5)` (40-PP moves reach 64).
- Base PP comes from `moves.js` for the record's generation (history rules of 1.2).

---

## 5. Unofficial conversions: what is safe to offer and how to label it

"Safe" here means: the destination game accepts and displays the record, nothing is duplicated, and the
Pokémon the player sees (species, level, moves, nickname, OT, gender, shininess, form) is preserved. It does not
mean "legal" by PKHeX-style checkers or Nintendo's later services.

| Conversion | Status | Offer? | Label / UI | Why |
|---|---|---|---|---|
| pk1 ↔ pk2 (Time Capsule-compatible, same language group) | official | always | "Time Capsule" | 2.1 |
| pk3 → pk4 | official | always | "Pal Park" | 2.2 |
| pk4 → pk5 | official | always | "Poké Transfer" | 2.3 |
| pk3 → pk5 | official chain | always | "Pal Park + Poké Transfer" | 2.6 |
| remove HM moves to pass Pal Park / Poké Transfer | convenience | opt-in per Pokémon | amber: "Forgets Surf and Fly (as the Move Deleter would)" | The player could do this in-game; refuse if no move would remain |
| keep the held item on Poké Transfer | convenience | opt-in (server and user) | amber: "Keeps its Leftovers (the real Poké Transfer returns items to your Gen 4 Bag)" | No duplication (we never put the item back in a Bag); items 1-536 exist in Gen 5 except mails 137-148 and HM07/08, which must be stripped. Arceus/Genesect/Giratina forms must then follow the item with **Gen 5** form numbers |
| pk1 / pk2 → pk3, `vc-model-v1` | unofficial | opt-in per server (`ALLOW_UNOFFICIAL=vc-model-v1`), then per transfer with an explicit checkbox | red badge on the Pokémon from then on: "Unofficial transfer (Virtual Console style)"; confirmation lists what changes: nature from EXP, EXP reset to level minimum, IVs from DVs, EVs reset, met "somewhere", Poké Ball, held item dropped, one-way | 2.5; modelled on the only official DV → PID conversion; deterministic |
| pk1 / pk2 → pk4 / pk5 | unofficial (2.5 then official chain) | only when 2.5 is enabled | same red badge | The badge stays; the later steps are official |
| Gen 2 → Gen 1 after deleting Gen 2 moves for the player | convenience | not in v1 | — | Rarely useful; the Move Deleter exists in Gen 2 if the player wants it |
| Eggs across any generation | never | — | "Eggs cannot be transferred" | Every official path refuses Eggs; PKHeX's forced hatching invents data |
| Downward: pk5 → pk4, pk4 → pk3, pk3 → pk2 | never | — | — | No official path; newer moves, abilities, items, balls, forms and species cannot be represented, and PID data would have to be thrown away or invented |
| pk1/pk2 Japanese ↔ Western, Korean pk2 → Western pk1, Korean pk2 → pk3 | never | — | "Not compatible with this game's language" | Corrupts saves on hardware / no Korean Gen 3 |
| Any "legality fix" (re-rolling PIDs, editing IVs, changing OT) | never | — | — | Not a transfer |

Implementation notes:

- The server re-runs the conversion it is asked to commit and compares bytes (deterministic conversions make this
  possible, including 2.5 thanks to the seeded PID search).
- Unofficial and convenience options are listed in the record's provenance so a later viewer (or a trade partner)
  sees them before accepting a trade. The trade UI shows the badge.
- Lazy conversion means there is nothing to "undo": until a withdrawal commits, Home still holds the original
  record.

---

## 6. Open questions / UNVERIFIED

1. Pal Park in HG/SS: only Platinum's code was read. PKHeX treats HGSS identically; confirm with pokeheartgold
   (`src/` GBA migration files) if the decomp has them.
2. Poké Transfer has no decompiled source: friendship 70, the met-date change, the 0x41/0x42/0x44-0x47/0x86/0x87
   clearing, and keeping 0x85 come from PKHeX and Bulbapedia only. A real before/after pair (Gen 4 save before,
   Gen 5 save after) would settle it.
3. Giratina-Origin arriving in Gen 5 without its orb: does BW fix the form byte on load or in battle?
4. Gen 5 special met locations other than 30001, 30003, 30010-30013, 60002 (PokeAPI is incomplete and lists 30007
   twice).
5. Gen 5 trade evolution internals (item consumption, Everstone/Kadabra, rename language), and Gen 5 trade
   friendship (base friendship vs 70).
6. Gen 2: can the player cancel a trade evolution? The shared evolution routine has a cancel path; Bulbapedia
   says trade evolutions cannot be cancelled.
7. Gen 4 Pokédex registration on trade receipt: behaviour is standard, but the code location was not found in the
   trade files read.
8. Ruby/Sapphire display of met location 0xD5 (their `MAPSEC_NONE` is 0x58, so it should fall in the "somewhere /
   in a trade" branch); pokeruby's summary screen was not read.
9. FR/LG before the National Dex holding non-Kanto species withdrawn straight into the PC: the trade code refuses
   them, the PC is expected to cope; not tested.
10. In-game default names outside English: the French accent rule and the two Korean Gen 2 names come from PKHeX
    and Bulbapedia; no French/Italian/Spanish/Korean decomp text was checked.
11. PokeAPI Gen 4 event locations 3000-3076 were not cross-checked against pokeplatinum
    `res/text/mystery_gift_event_names.json`.
12. Gen 2 → Gen 3 item mapping for a future `G2_TO_G3_UNOFFICIAL` (PokeAPI's berry merges are a reasonable start,
    e.g. MIRACLEBERRY → Lum Berry, GOLD_BERRY → Sitrus Berry, but it is our own choice, not an official rule).

---

## Sources

Fetched 2026-10-24 unless noted. Raw files: `raw.githubusercontent.com/<repo>/<commit>/<path>`.

- **[pokeapi]** PokeAPI/pokeapi @ `2bf639e5572812a67d2b94903fdcb9d095f5aeb2` (2026-10-20), `LICENSE.md`
  (BSD-3-Clause) and `data/v2/csv/`: every file named in 1.2, plus `pal_park.csv`, `type_efficacy*.csv`,
  `generations.csv`, `region_names.csv`.
- **[pkmn-dex]** `@pkmn/dex` 0.10.11 and `@pkmn/data` 0.10.11 (npm, MIT): `build/index.js`, `README.md`.
- **[pret-r]** pret/pokered @ `171e2c204f9c`: `constants/pokemon_constants.asm`, `constants/item_constants.asm`,
  `engine/pokemon/evos_moves.asm`, `engine/pokemon/add_mon.asm`, `engine/link/cable_club.asm`,
  `data/pokemon/base_stats/*.asm`.
- **[pret-y]** pret/pokeyellow @ `9327549dce06`: `engine/pokemon/evos_moves.asm`, `engine/pokemon/add_mon.asm`.
- **[pret-c]** pret/pokecrystal @ `5c877ef55197`: `engine/link/link.asm`, `engine/link/time_capsule.asm`,
  `engine/link/time_capsule_2.asm`, `data/items/catch_rate_items.asm`, `engine/pokemon/evolve.asm`,
  `engine/pokemon/move_mon.asm` (`AddTempmonToParty`), `engine/pokemon/mon_stats.asm` (`GetGender`),
  `engine/battle/hidden_power.asm` (`HiddenPowerDamage`), `engine/gfx/color.asm` (`CheckShininess`),
  `engine/gfx/load_pics.asm` (`GetUnownLetter`), `constants/item_constants.asm`, `constants/landmark_constants.asm`,
  `data/maps/landmarks.asm`, `constants/pokemon_data_constants.asm`.
- **[pret-e]** pret/pokeemerald @ `731ad5bfd6e6`: `include/constants/species.h`, `include/constants/items.h`,
  `src/data/region_map/region_map_sections.json`, `src/data/region_map/region_map_sections.constants.json.txt`,
  `src/pokemon.c` (`GetEvolutionTargetSpecies`, `EvolutionRenameMon`, `CreateMonWithGenderNatureLetter`,
  `DRAW_SPINDA_SPOTS`), `include/pokemon.h` (`GET_UNOWN_LETTER`), `src/battle_script_commands.c`
  (`Cmd_hiddenpowercalc`), `src/evolution_scene.c`, `src/trade.c`
  (`TradeMons`, `UpdatePokedexForReceivedMon`), `src/pokemon_summary_screen.c`.
- **[pret-fr]** pret/pokefirered @ `ce6406d8c2ea`: `src/data/region_map/region_map_sections.json`, `src/pokemon.c`,
  `src/evolution_scene.c`, `src/trade.c`, `src/pokemon_summary_screen.c`.
- **[pret-pt]** pret/pokeplatinum @ `be36a9db3d23`: `src/main_menu/gba_migrator.c`, `src/main_menu/gba_pokemon.c`,
  `src/main_menu/gba_convert_string.c`, `include/constants/gba/items.h`, `src/item.c`, `src/pal_park_transfers.c`,
  `src/scrcmd_catching_show.c`, `src/catching_show.c`, `src/unk_02092494.c`, `src/battle/battle_lib.c`,
  `src/battle/battle_script.c`, `src/pokemon.c`, `src/evolution.c`, `src/applications/trade_room/application.c`,
  `include/constants/pokemon.h`, `res/text/location_names.json`, `res/text/special_met_location_names.json`.
- **[pret-hg]** pret/pokeheartgold @ `6988158691eb`: `include/constants/items.h`,
  `files/msgdata/msg/msg_0279.json`.
- **[pkhex]** kwsch/PKHeX @ `a9ff30657073` (GPLv3; read, not copied): `PKHeX.Core` `PK1.cs`, `PK2.cs`, `PK3.cs`,
  `PK4.cs`, `PK5.cs`, `PK7.cs`, `G3PKM.cs`, `GBPKM.cs`, `Locations.cs`, `ItemConverter.cs`, `SpeciesName.cs`,
  `EntityGender.cs`, `HiddenPower.cs`, `ShinyUtil.cs`, `TransporterLogic.cs`, `PersonalInfo3.cs`,
  `PersonalInfo4.cs`, `Experience.cs`.
- **[bulba-palpark]** Bulbapedia "Pal Park"; **[bulba-poketransfer]** "Poké Transfer"; **[bulba-transfer]**
  "Transfer"; **[bulba-transporter]** "Poké Transporter"; **[bulba-timecapsule]** "Time Capsule";
  **[bulba-trade]** "Trade"; **[bulba-everstone]** "Everstone"; **[bulba-obedience]** "Obedience";
  **[bulba-nickname]** "Nickname"; **[bulba-shaymin]** "Shaymin (Pokémon)"; **[bulba-karrablast]**
  "Karrablast (Pokémon)"; **[bulba-experience]** "Experience"; also "Personality value", "Friendship",
  "Deoxys (Pokémon)" (wikitext, CC BY-NC-SA; facts only).
- This repository: `docs/ARCHITECTURE.md`, `docs/research/format-gen1-gen2.md`, `format-gen3.md`,
  `format-gen4.md`, `format-gen5.md`, `battle-engine.md`.
