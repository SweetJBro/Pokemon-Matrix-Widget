/* The picture of one Pokémon in a box cell or a card: the front sprite from the game the
   Pokémon is in (a Gen 2 Pokémon looks like Crystal, a Gen 4 one like Platinum), falling back
   along js/battle/sprites.js's candidate list, then to a plain text badge when sprites are off
   (config.spriteBase "") or the image is missing. */
import { h } from "../ui.js";
import { spriteCandidates, onSpriteError } from "../battle/sprites.js";
import { spriteStem } from "../../shared/data/index.js";

/** Save/record game codes -> the sprite set to use (js/battle/sprites.js GAME_FOLDERS keys). */
const GAME_LOOK = { R: "RB", B: "RB", RB: "RB", Y: "Y", G: "GS", S: "GS", GS: "GS", C: "C",
  RS: "RS", RUBY: "RS", SAPPHIRE: "RS", E: "E", FR: "FRLG", LG: "FRLG", FRLG: "FRLG",
  D: "DP", P: "DP", DP: "DP", Pt: "Pt", HG: "HGSS", SS: "HGSS", HGSS: "HGSS", B2: "B2W2", W2: "B2W2", B2W2: "B2W2", BW: "BW", W: "BW" };

/** <img> for a MonView (or Home summary), sized by CSS. Eggs get the egg glyph. */
export function monSprite(view, base, { className = "cell-sprite", back = false } = {}) {
  if (view.isEgg) return h("span", { class: "cell-egg", "aria-hidden": "true" }, "🥚");
  const urls = spriteCandidates({
    num: view.species, file: spriteStem(view.species, view.form || 0, view.gen),
    gen: view.gen, game: GAME_LOOK[view.game] ?? GAME_LOOK[String(view.game || "").toUpperCase()],
    shiny: view.shiny, female: view.gender === "F", back,
  }, base);
  if (!urls.length) return h("span", { class: "cell-noart" }, String(view.speciesName || "?").slice(0, 3));
  const [first, ...rest] = urls;
  const img = h("img", { class: className, src: first, alt: "", loading: "lazy", decoding: "async", "data-fallback": rest.join(" ") });
  img.addEventListener("error", onSpriteError);
  return img;
}

export const genLabel = (format) => ({ pk1: "Gen 1", pk2: "Gen 2", pk3: "Gen 3", pk4: "Gen 4", pk5: "Gen 5" })[format] || format;
