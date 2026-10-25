#!/usr/bin/env bash
# Regenerates the committed PKHeX-derived test fixtures:
#   test/fixtures/saves/    <id>.sav + <id>.expected.json (one per spec in specs/*.json)
#                           <id>.modified.sav + <id>.modified.expected.json (one per specs/ops/*.json)
#   test/fixtures/records/  <format>-<name>.hex + .json
#   test/fixtures/convert/  <from>-<to>-<name>.json
# then runs verify-fixtures.mjs.
#
# Development only. Needs the .NET 8 SDK (PKHeX.Core 24.7.27 is restored from NuGet) and Node.
# Output is deterministic: running it twice produces byte-identical files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TOOL=tools/pkhex-oracle
SAVES=test/fixtures/saves
RECORDS=test/fixtures/records
CONVERT=test/fixtures/convert

# PKHeX stamps "today" into some conversions (Pal Park met date); freeze it.
export PKHEX_ORACLE_NOW=2010-01-01

echo "building oracle..."
dotnet build "$TOOL" -c Release --nologo -v quiet -clp:ErrorsOnly
DLL="$TOOL/bin/Release/net8.0/pkhex-oracle.dll"

oracle() {
  local out
  if ! out="$(dotnet "$DLL" "$@")"; then
    printf '%s\n' "$out" >&2
    echo "oracle failed: $*" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

# Prints the recordHex of one Pokémon from an expected.json: selector "party:<i>" or "box:<b>:<s>".
record_hex() {
  node -e '
    const [file, sel] = process.argv.slice(1);
    const j = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const p = sel.split(":");
    const m = p[0] === "party" ? j.party[+p[1]] : j.boxes.find(x => x.box === +p[1] && x.slot === +p[2]);
    if (!m) { console.error("no Pokémon at " + sel + " in " + file); process.exit(1); }
    process.stdout.write(m.recordHex);
  ' "$1" "$2"
}

mkdir -p "$SAVES" "$RECORDS" "$CONVERT"

# ---------------------------------------------------------------- saves
for spec in "$TOOL"/specs/*.json; do
  id="$(basename "$spec" .json)"
  echo "save    $id"
  oracle build "$spec" "$SAVES/$id.sav" > /dev/null
  oracle dump "$SAVES/$id.sav" > "$SAVES/$id.expected.json"
done

# ---------------------------------------------------------------- records
# name | source fixture | selector | extra pkm flags
RECORD_TABLE="
pk1-pikachu-sparky|red-en|party:1|
pk1-mewtwo-maxdv|red-en|box:0:0|
pk1-yellow-pikachu-lightball|yellow-en|party:0|
pk1-ja-pikachu|red-ja|party:1|
pk2-cyndaquil-blaze|gold-en|party:0|
pk2-togepi-egg|gold-en|box:0:0|--egg
pk2-unown-q|gold-en|box:0:1|
pk2-crystal-pikachu-caught|crystal-en|party:1|
pk2-ja-chikorita|gold-ja|party:0|
pk2-ko-cyndaquil|gold-ko|party:0|
pk3-treecko-leafy|ruby-en|party:0|
pk3-azurill-egg|ruby-en|box:0:0|
pk3-groudon-ribbons|ruby-en|box:0:12|
pk3-zigzagoon-oranberry|ruby-en|party:1|
pk3-mew-fateful|emerald-en|box:0:20|
pk3-ja-torchic|ruby-ja|party:0|
pk4-turtwig-shelly|diamond-en|party:0|
pk4-riolu-egg|diamond-en|box:0:0|
pk4-bibarel-hms|diamond-en|box:0:25|
pk4-giratina-origin|platinum-en|box:0:9|
pk4-hgss-pikachu-fastball|heartgold-en|party:1|
pk4-ja-chimchar|platinum-ja|party:0|
pk5-snivy-hidden-ability|black-en|party:0|
pk5-larvesta-egg|black-en|box:0:0|
pk5-purrloin-nsparkle|black-en|box:0:22|
pk5-basculin-blue-it|black-en|box:0:29|
pk5-oshawott-shell|black2-en|party:0|
pk5-ja-tepig|black-ja|party:0|
"
while IFS='|' read -r name fixture sel flags; do
  [ -z "$name" ] && continue
  echo "record  $name"
  fmt="${name%%-*}"
  hex="$(record_hex "$SAVES/$fixture.expected.json" "$sel")"
  printf '%s\n' "$hex" > "$RECORDS/$name.hex"
  # shellcheck disable=SC2086
  oracle pkm "$fmt" "$hex" $flags > "$RECORDS/$name.json"
done <<< "$RECORD_TABLE"

# PKHeX's empty-slot entity per format (Gen 4/5: zeroed struct encrypted with seed 0).
for fmt in pk3 pk4 pk5; do
  echo "record  $fmt-empty"
  hex="$(oracle blankpkm "$fmt" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).recordHex))')"
  printf '%s\n' "$hex" > "$RECORDS/$fmt-empty.hex"
  oracle pkm "$fmt" "$hex" > "$RECORDS/$fmt-empty.json"
done

# Vectors from docs/research (our own reference implementation), checked against PKHeX.
# format-gen3.md §14.1 vectors 1-3 (CIPHER lines) and format-gen4.md §19.1 (ENCRYPTED block).
DOC_VECTORS="
pk3-docvec-1|EFBEADDE3412EFBEC7CFBEC5C3CAFF0000000202CDBBC7FF0000000530490000FABCC7C1E42403EADF2C42E0DAAE4164DEAA4560DBAC4268FAAC6F60DBAC4260F8844260C0AD8A605CAC4260C0EA4260
pk3-docvec-2-shiny|5A5A82F63412EFBEC7CFBEC5C3CAFF0000000202CDBBC7FF00000005304900004F4840486E486D484D606D484F58E8E951C02CC26AC86DC87549A548E9486D48750E6D486F4A6E4C6B4E6A486E486D40
pk3-docvec-3-egg|256C3A9F3412EFBE606F8BFF0000000000000106CDBBC7FF00000005634600000A7FD521967ED5210A6AD521307E55802EF694EB15FED5A1107CD6251478D221117ED529307EF821117ED5213256D521
pk4-docvec-pikachu|78563412 0000bdcd 2c5c30d1 5bef0cf4 c5a8ebbe d8f05688 dd05d22e 7f042796 0688ab54 7bbff990 7c326c7a 846513c4 900ff974 124a97b6 f39cd748 6a6959c6 f9cbc862 177c9ac4 99c3fff3 1dd52be1 1c1ff13b e1167569 5fe606de c65f7e06 4ae2eaa7 f5a9483f afb8a511 6362e36b 23c42bca 03829208 d4b0d3e8 6680f9b4 e5dd7f8d 78ace82c
"
while IFS='|' read -r name hex; do
  [ -z "$name" ] && continue
  echo "record  $name"
  fmt="${name%%-*}"
  hex="$(printf '%s' "$hex" | tr -d ' ' | tr 'A-F' 'a-f')"
  printf '%s\n' "$hex" > "$RECORDS/$name.hex"
  oracle pkm "$fmt" "$hex" > "$RECORDS/$name.json"
done <<< "$DOC_VECTORS"

# ---------------------------------------------------------------- conversions
# name | from | to | record | extra flags
CONVERT_TABLE="
pk1-pk2-pikachu-sparky|pk1|pk2|pk1-pikachu-sparky|
pk1-pk2-yellow-pikachu-lightball|pk1|pk2|pk1-yellow-pikachu-lightball|
pk1-pk2-ja-pikachu|pk1|pk2|pk1-ja-pikachu|
pk2-pk1-crystal-pikachu|pk2|pk1|pk2-crystal-pikachu-caught|
pk2-pk1-cyndaquil-fails|pk2|pk1|pk2-cyndaquil-blaze|
pk2-pk1-unown-fails|pk2|pk1|pk2-unown-q|
pk3-pk4-treecko-leafy|pk3|pk4|pk3-treecko-leafy|
pk3-pk4-zigzagoon-oranberry|pk3|pk4|pk3-zigzagoon-oranberry|
pk3-pk4-azurill-egg|pk3|pk4|pk3-azurill-egg|
pk3-pk4-mew-fateful|pk3|pk4|pk3-mew-fateful|
pk3-pk5-treecko-chain|pk3|pk5|pk3-treecko-leafy|
pk4-pk5-turtwig-shelly|pk4|pk5|pk4-turtwig-shelly|
pk4-pk5-bibarel-hms|pk4|pk5|pk4-bibarel-hms|
pk4-pk5-hgss-pikachu-fastball|pk4|pk5|pk4-hgss-pikachu-fastball|
pk4-pk5-giratina-origin|pk4|pk5|pk4-giratina-origin|
pk4-pk5-riolu-egg|pk4|pk5|pk4-riolu-egg|
pk1-pk3-pikachu-fails|pk1|pk3|pk1-pikachu-sparky|
pk2-pk3-cyndaquil-fails|pk2|pk3|pk2-cyndaquil-blaze|
pk4-pk3-turtwig-fails|pk4|pk3|pk4-turtwig-shelly|
pk5-pk4-snivy-fails|pk5|pk4|pk5-snivy-hidden-ability|
pk1-pk7-pikachu-vc|pk1|pk7|pk1-pikachu-sparky|
pk2-pk7-cyndaquil-vc|pk2|pk7|pk2-cyndaquil-blaze|
"
while IFS='|' read -r name from to rec flags; do
  [ -z "$name" ] && continue
  echo "convert $name"
  # shellcheck disable=SC2086
  oracle convert "$from" "$to" "$(cat "$RECORDS/$rec.hex")" $flags > "$CONVERT/$name.json"
done <<< "$CONVERT_TABLE"

# ---------------------------------------------------------------- modified saves
for ops in "$TOOL"/specs/ops/*.json; do
  id="$(basename "$ops" .json)"
  echo "modify  $id"
  oracle modify "$SAVES/$id.sav" "$SAVES/$id.modified.sav" "$ops" > /dev/null
  oracle dump "$SAVES/$id.modified.sav" > "$SAVES/$id.modified.expected.json"
done

# ---------------------------------------------------------------- verify
node "$TOOL/verify-fixtures.mjs"
