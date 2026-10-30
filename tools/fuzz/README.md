# Differential fuzzing against PKHeX (development only)

Needs the .NET 8 SDK and the built oracle (`dotnet build tools/pkhex-oracle -c Release`, or
`tools/pkhex-oracle/make-fixtures.sh`, which builds it). Nothing here runs in `npm test`.

```sh
npm run fuzz -- --seed 5 --saves 3 --mons 60 --ops 60          # every layout in tools/pkhex-oracle/specs
npm run fuzz -- --only emerald-en,platinum-ja --seed 9          # some layouts
node tools/fuzz/gen5-vectors.mjs                                 # regenerate test/fixtures/stage2-gen5/pk5-vectors.json
```

`fuzz.mjs` does both directions for each layout:

* **Read**: PKHeX builds saves full of random but well-formed Pokémon (party and every box: species,
  forms, levels, moves and PP Ups, IVs/DVs, EVs/Stat Exp, natures, abilities, items, eggs,
  nicknames in the save's languages, foreign-language Pokémon with their own OTs, shininess, balls,
  Pokérus, markings). `openSave` must read every slot exactly as PKHeX's `dump` does, record bytes
  included, and `build(parse(r))` must return the stored bytes.
* **Write**: our `SaveFile` takes, puts (records from the other random saves), changes the current
  box and registers Pokédex entries at random; after `serialize()` PKHeX must report valid
  checksums and exactly the contents our model has.

Failures are written to `--out` (spec, save, the list of operations) so a case can be rebuilt with
`dotnet tools/pkhex-oracle/bin/Release/net8.0/pkhex-oracle.dll build <spec> <out.sav>`.

Known differences that are not bugs, and that the comparison ignores:

* PKHeX shows the Gen 1/2 dot tile as `․` (U+2024) and the apostrophe as `’`; we use `.` and `'`.
  The bytes are compared exactly.
* Gen 3 stores no Deoxys form; the game draws its own forme (Speed in Emerald, Attack in FireRed).
  We report that forme, PKHeX reports 0.
* Korean Gold/Silver saves are read-only here, so they get no write round.
