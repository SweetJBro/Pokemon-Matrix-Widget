/* Sprite URLs for the battle screen, from config.spriteBase.

   spriteBase points at a copy of PokeAPI/sprites' sprites/pokemon/ tree (self-hosted at
   sprites/pokemon/ in production, raw.githubusercontent.com at a pinned commit in development;
   server/config.js). Per-game battle sprites follow one grammar:
     versions/<generation>/<game>/[transparent/][back/][shiny/][female/]<file>.png
   where <file> is the National Dex number or a form stem ("201-b", "10001" for Deoxys-Attack,
   from shared/data's showdownSprite()). Not every variant exists for every game (Gen 1 has no
   shiny, female sprites start in Gen 4, Gen 1/2 look best from the transparent set), so we build
   a list of candidates, best first, and the <img> walks down it on error. Only static PNGs: the
   fetch script leaves the animated sets out. docs/research/battle-engine.md §5. */
// URL layout: the server serves shared/ next to js/ (BASE/shared/, BASE/js/), not on disk under web/.
import { showdownSprite } from "../../shared/data/index.js";

export const GAME_FOLDERS = {
  1: { RB: "generation-i/red-blue", Y: "generation-i/yellow", RG: "generation-i/red-green-japan" },
  2: { C: "generation-ii/crystal", GS: "generation-ii/gold", G: "generation-ii/gold", S: "generation-ii/silver" },
  3: { E: "generation-iii/emerald", RS: "generation-iii/ruby-sapphire", FRLG: "generation-iii/firered-leafgreen" },
  4: { Pt: "generation-iv/platinum", DP: "generation-iv/diamond-pearl", HGSS: "generation-iv/heartgold-soulsilver" },
  5: { BW: "generation-v/black-white", B2W2: "generation-v/black-white" },
};
/** The look a battle in that generation uses unless told otherwise. */
export const DEFAULT_GAME = { 1: "RB", 2: "C", 3: "E", 4: "Pt", 5: "BW" };
const FEATURES = {
  1: { shiny: false, female: false, transparent: true },
  2: { shiny: true, female: false, transparent: true },
  3: { shiny: true, female: false, transparent: false },
  4: { shiny: true, female: true, transparent: false },
  5: { shiny: true, female: true, transparent: false },
};
/** Nominal sprite size per generation (CSS scales them with pixelated rendering). */
export const SPRITE_PX = { 1: 56, 2: 56, 3: 64, 4: 80, 5: 96 };

const trimBase = (base) => String(base ?? "").replace(/\/+$/, "");

/** m = { num, file?, gen, game?, back?, shiny?, female? } -> URLs, best first. */
export function spriteCandidates(m, base) {
  base = trimBase(base);
  if (!base || !m?.num) return [];
  const gen = Math.min(5, Math.max(1, m.gen | 0 || 5));
  const f = FEATURES[gen], games = GAME_FOLDERS[gen];
  const folder = games[m.game] ?? games[DEFAULT_GAME[gen]];
  const out = [];
  for (const stem of [m.file, String(m.num)].filter(Boolean)) {
    for (const female of (m.female && f.female ? [true, false] : [false])) {
      for (const transparent of (f.transparent ? [true, false] : [false])) {
        const parts = [base, "versions", folder, transparent && "transparent", m.back && "back", m.shiny && f.shiny && "shiny", female && "female"].filter(Boolean);
        out.push(`${parts.join("/")}/${stem}.png`);
      }
    }
  }
  // a later generation's sprite beats no sprite (a form missing from an older game's set)
  if (gen < 5) out.push(...spriteCandidates({ ...m, gen: 5, game: "BW" }, base).filter((u) => !out.includes(u)));
  return [...new Set(out)];
}

/** Box/party icon (Gen V icons cover #1-649). */
export function iconUrl(num, base, file) {
  base = trimBase(base);
  return base && num ? `${base}/versions/generation-v/icons/${file ?? num}.png` : "";
}

/** Sprite candidates for a tracked battle Pokémon ({ species, shiny, gender }). */
export function monSprites(mon, { gen, back, base, game }) {
  const hit = mon?.species ? showdownSprite(mon.transformed || mon.species) ?? showdownSprite(String(mon.species).replace(/-.*$/, "")) : null;
  if (!hit) return [];
  return spriteCandidates({ num: hit.num, file: hit.file, gen, game, back, shiny: mon.shiny, female: mon.gender === "F" }, base);
}

/** Icon URL for a species name ("Pikachu", "Unown-B"). */
export function speciesIcon(species, base) {
  const hit = species ? showdownSprite(species) ?? showdownSprite(String(species).replace(/-.*$/, "")) : null;
  return hit ? iconUrl(hit.num, base, hit.file) : "";
}

/** <img> error handler: try the next candidate from data-fallback, then give up quietly. */
export function onSpriteError(e) {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || img.dataset.fallback === undefined) return;
  const [next, ...rest] = img.dataset.fallback.split(" ").filter(Boolean);
  if (next) { img.dataset.fallback = rest.join(" "); img.src = next; }
  else { img.removeAttribute("src"); img.classList.add("is-missing"); }
}
