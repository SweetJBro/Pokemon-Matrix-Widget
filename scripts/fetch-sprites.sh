#!/usr/bin/env sh
# Fetch the static Gen 1-5 sprites from PokeAPI/sprites at a pinned commit into SPRITES_DIR.
#
#   SPRITES_DIR=/srv/sprites scripts/fetch-sprites.sh      (or: scripts/fetch-sprites.sh /srv/sprites)
#
# Result: $SPRITES_DIR/pokemon/versions/generation-{i..v}/<game>/[back/][shiny/][female/]<dex>.png plus the
# Gen III-V icon folders, about 24 MB of PNGs. The server serves $SPRITES_DIR at /sprites/ when SPRITES_DIR is
# set (server/config.js), and the widget then uses "sprites/pokemon/" as its sprite base.
#
# Why this way: the repository is ~26 GB, so a full clone is out and jsDelivr refuses it (50 MB package
# limit). GitHub lets us fetch one commit by SHA; a blob-less, depth-1 fetch with a sparse checkout only
# downloads the files we keep. Animated sprites (~400 MB) and the Gen I grey variants are left out.
#
# Licence: PokeAPI applies CC0 to the repository but the images remain the property of Nintendo /
# Creatures Inc. / GAME FREAK inc.; nothing grants us the images, so they stay out of our git repository
# and are fetched at deploy time. Credit them as "Sprites (c) Nintendo/Creatures Inc./GAME FREAK inc., via
# PokeAPI/sprites" wherever you deploy.
set -eu

SHA=97a7832d307311c0e1c6ea9035308bf80cc94f81   # keep in sync with SPRITES_COMMIT in server/config.js
REPO=https://github.com/PokeAPI/sprites.git
DEST="${1:-${SPRITES_DIR:-}}"
if [ -z "$DEST" ]; then
  echo "usage: SPRITES_DIR=/path/to/sprites $0   (or $0 /path/to/sprites)" >&2
  exit 2
fi
command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pokeapi-sprites.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

git init -q "$WORK/src"
git -C "$WORK/src" remote add origin "$REPO"
git -C "$WORK/src" config core.sparseCheckout true
# Non-cone patterns (gitignore syntax): the five generations, minus animated and grey sprites.
cat > "$WORK/src/.git/info/sparse-checkout" <<'EOF'
/LICENCE.txt
/sprites/pokemon/versions/generation-i/
/sprites/pokemon/versions/generation-ii/
/sprites/pokemon/versions/generation-iii/
/sprites/pokemon/versions/generation-iv/
/sprites/pokemon/versions/generation-v/
!animated/
!/sprites/pokemon/versions/generation-i/*/gray/
EOF
echo "Fetching PokeAPI/sprites@$SHA (sparse, static Gen 1-5 sprites only)..."
git -C "$WORK/src" fetch -q --depth 1 --filter=blob:none origin "$SHA"
git -C "$WORK/src" checkout -q FETCH_HEAD

mkdir -p "$DEST"
# Copy into place without leaving a half-updated tree behind on failure.
rm -rf "$DEST/pokemon.new"
cp -R "$WORK/src/sprites/pokemon" "$DEST/pokemon.new"
cp "$WORK/src/LICENCE.txt" "$DEST/pokemon.new/LICENCE-pokeapi-sprites.txt"
echo "$SHA" > "$DEST/pokemon.new/COMMIT"
rm -rf "$DEST/pokemon.old"
if [ -d "$DEST/pokemon" ]; then mv "$DEST/pokemon" "$DEST/pokemon.old"; fi
mv "$DEST/pokemon.new" "$DEST/pokemon"
rm -rf "$DEST/pokemon.old"

COUNT="$(find "$DEST/pokemon" -name '*.png' | wc -l | tr -d ' ')"
SIZE="$( (du -sh --apparent-size "$DEST/pokemon" 2>/dev/null || du -sh "$DEST/pokemon") | cut -f1)"
echo "Done: $COUNT PNG files ($SIZE) in $DEST/pokemon"
