/* The name a game gives an un-nicknamed Pokémon, per generation and language.

   Gen 1-3 store no nickname flag: "nicknamed" means the stored name differs from what the game would
   have written. Gen 4/5 store a flag but still write these names on evolution and transfer. Rules from
   docs/research/data-and-transfers.md §1.8, applied to PokeAPI's localized names:
   - Western (en/fr/de/it/es) Gen 1-4: upper case; French drops the accents on E and I (É È Ê Ë -> E,
     Î Ï -> I). Gen 1/2 write Mr. Mime without the space (MR.MIME, French M.MIME); Gen 3/4 keep it.
     Farfetch'd uses a straight apostrophe (a text codec maps it to its own glyph).
   - Western Gen 5: the normal-case name (Mr. Mime, Farfetch'd).
   - Japanese: katakana in every generation. Korean: only Gen 2, 4 and 5 had Korean games.
   Strings are Unicode; the text codecs in shared/text/ turn them into game bytes. */
import { speciesName, LANGS, MAX_SPECIES } from "../data/index.js";

const WESTERN = new Set(["en", "fr", "de", "it", "es"]);
// Korean Gold/Silver spelled two names differently from later games (later 슈륙챙이 and 덩쿠리), which is why
// Poké Transporter treats them as nicknames. UNVERIFIED against a Korean Gen 2 dump; spellings as PKHeX has them.
const KO_GEN2 = { 61: "수륙챙이", 114: "덩구리" };

/** defaultName(species, gen, lang = "en") -> string, or null when no such game/language exists or the species is unknown. */
export function defaultName(species, gen, lang = "en") {
  if (!(gen >= 1 && gen <= 5) || !LANGS.includes(lang) || !(species >= 1 && species <= MAX_SPECIES[gen])) return null;
  if (lang === "ko" && (gen === 1 || gen === 3)) return null;   // no Korean Gen 1 or Gen 3 games
  if (lang === "ko" && gen === 2 && KO_GEN2[species]) return KO_GEN2[species];
  let name = speciesName(species, lang).replace(/[’‘]/g, "'");
  if (!WESTERN.has(lang) || gen === 5) return name;
  if (gen <= 2) name = name.replace(/\. /g, ".");                 // MR.MIME / M.MIME
  name = name.toUpperCase();
  if (lang === "fr") name = name.replace(/[ÉÈÊË]/g, "E").replace(/[ÎÏ]/g, "I");
  return name;
}

/** Apostrophe variants a decoder may produce for the same glyph compare equal. */
const fold = (s) => String(s).replace(/[’‘`´]/g, "'");

/** True when `name` is exactly the default name of the species in that game generation and language. */
export function isDefaultName(name, species, gen, lang = "en") {
  const d = defaultName(species, gen, lang);
  return d != null && fold(name) === fold(d);
}

// Egg names (data-and-transfers.md §1.8). Gen 3 Eggs are always the Japanese タマゴ (language 1).
// UNVERIFIED: the German/Italian/Spanish/Korean words agree with PKHeX (read only) but were not checked against
// game text dumps.
const EGG = {
  2: { en: "EGG", fr: "OEUF", de: "EI", it: "UOVO", es: "HUEVO", ja: "タマゴ", ko: "알" },
  4: { en: "Egg", fr: "Oeuf", de: "Ei", it: "Uovo", es: "Huevo", ja: "タマゴ", ko: "알" },
  5: { en: "Egg", fr: "Œuf", de: "Ei", it: "Uovo", es: "Huevo", ja: "タマゴ", ko: "알" },
};
/** Name the game writes on an Egg, null for Gen 1 (no Eggs) or an unknown language. */
export function eggName(gen, lang = "en") {
  if (gen === 3) return "タマゴ";
  return EGG[gen]?.[lang] ?? null;
}
