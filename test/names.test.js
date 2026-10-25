/* shared/pkm/names.js: in-game default names (docs/research/data-and-transfers.md §1.8). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultName, isDefaultName, eggName } from "../shared/pkm/names.js";
import { MAX_SPECIES } from "../shared/data/index.js";

test("English: upper case in Gen 1-4, normal case in Gen 5", () => {
  assert.equal(defaultName(1, 1), "BULBASAUR");
  assert.equal(defaultName(25, 4), "PIKACHU");
  assert.equal(defaultName(25, 5), "Pikachu");
  assert.equal(defaultName(250, 2), "HO-OH");
  assert.equal(defaultName(233, 2), "PORYGON2");
  assert.equal(defaultName(474, 4), "PORYGON-Z");
  assert.equal(defaultName(29, 1), "NIDORAN♀");
  assert.equal(defaultName(32, 3), "NIDORAN♂");
  assert.equal(defaultName(29, 5), "Nidoran♀");
});

test("Mr. Mime and Farfetch'd", () => {
  assert.equal(defaultName(122, 1), "MR.MIME");
  assert.equal(defaultName(122, 2, "it"), "MR.MIME");
  assert.equal(defaultName(122, 2, "es"), "MR.MIME");
  assert.equal(defaultName(122, 1, "fr"), "M.MIME");
  assert.equal(defaultName(122, 3), "MR. MIME");
  assert.equal(defaultName(122, 4, "fr"), "M. MIME");
  assert.equal(defaultName(122, 5), "Mr. Mime");
  assert.equal(defaultName(122, 1, "de"), "PANTIMOS");
  assert.equal(defaultName(439, 4), "MIME JR.");
  assert.equal(defaultName(439, 5), "Mime Jr.");
  assert.equal(defaultName(83, 1), "FARFETCH'D");
  assert.equal(defaultName(83, 3, "it"), "FARFETCH'D");
  assert.equal(defaultName(83, 4, "es"), "FARFETCH'D");
  assert.equal(defaultName(83, 5), "Farfetch'd");
  assert.equal(defaultName(83, 2, "fr"), "CANARTICHO");
  assert.equal(defaultName(83, 2, "de"), "PORENTA");
});

test("French drops accents on E and I in Gen 1-4 only", () => {
  assert.equal(defaultName(35, 1, "fr"), "MELOFEE");        // Mélofée
  assert.equal(defaultName(4, 2, "fr"), "SALAMECHE");       // Salamèche
  assert.equal(defaultName(61, 3, "fr"), "TETARTE");        // Têtarte
  assert.equal(defaultName(101, 3, "fr"), "ELECTRODE");     // Électrode
  assert.equal(defaultName(438, 4, "fr"), "MANZAI");        // Manzaï
  assert.equal(defaultName(35, 5, "fr"), "Mélofée");
  assert.equal(defaultName(438, 5, "fr"), "Manzaï");
  for (let g = 1; g <= 4; g++) for (let s = 1; s <= MAX_SPECIES[g]; s++) assert.doesNotMatch(defaultName(s, g, "fr"), /[ÉÈÊËÎÏéèêëîï]/);
});

test("Japanese and Korean", () => {
  for (let g = 1; g <= 5; g++) assert.equal(defaultName(25, g, "ja"), "ピカチュウ");
  assert.equal(defaultName(29, 1, "ja"), "ニドラン♀");
  assert.equal(defaultName(25, 2, "ko"), "피카츄");
  assert.equal(defaultName(25, 4, "ko"), "피카츄");
  // Korean Gold/Silver spelled Poliwhirl and Tangela differently from Gen 4 on
  assert.equal(defaultName(61, 2, "ko"), "수륙챙이"); assert.equal(defaultName(61, 4, "ko"), "슈륙챙이");
  assert.equal(defaultName(114, 2, "ko"), "덩구리"); assert.equal(defaultName(114, 5, "ko"), "덩쿠리");
  assert.ok(!isDefaultName("슈륙챙이", 61, 2, "ko"));
  assert.equal(defaultName(25, 1, "ko"), null);   // no Korean Gen 1 or Gen 3 games
  assert.equal(defaultName(25, 3, "ko"), null);
});

test("unknown species, generation or language", () => {
  assert.equal(defaultName(152, 1), null);
  assert.equal(defaultName(387, 3), null);
  assert.equal(defaultName(0, 5), null);
  assert.equal(defaultName(25, 6), null);
  assert.equal(defaultName(25, 4, "zh"), null);
});

test("length limits: 10 characters (Western), 5 (Japanese, Korean)", () => {
  for (let g = 1; g <= 5; g++) for (let s = 1; s <= MAX_SPECIES[g]; s++) {
    for (const lang of ["en", "fr", "de", "it", "es"]) assert.ok([...defaultName(s, g, lang)].length <= 10, `${s} gen ${g} ${lang}`);
    assert.ok([...defaultName(s, g, "ja")].length <= 5, `${s} gen ${g} ja`);
    if (g !== 1 && g !== 3) assert.ok([...defaultName(s, g, "ko")].length <= 5, `${s} gen ${g} ko`);
  }
});

test("isDefaultName", () => {
  assert.ok(isDefaultName("PIKACHU", 25, 3));
  assert.ok(!isDefaultName("Pikachu", 25, 3));
  assert.ok(isDefaultName("Pikachu", 25, 5));
  assert.ok(isDefaultName("FARFETCH’D", 83, 3));         // decoders may return a curly apostrophe
  assert.ok(isDefaultName("Farfetch’d", 83, 5));
  assert.ok(!isDefaultName("MR. MIME", 122, 1));          // Gen 1/2 write MR.MIME
  assert.ok(isDefaultName("M.MIME", 122, 2, "fr"));
  assert.ok(!isDefaultName("SPARKY", 25, 1));
  assert.ok(isDefaultName("PIKACHU", 25, 1, "fr"));        // French Pikachu is also PIKACHU
  assert.ok(!isDefaultName("", 25, 1));
  assert.ok(!isDefaultName("PIKACHU", 25, 3, "ko"));
});

test("Egg names", () => {
  assert.equal(eggName(2), "EGG"); assert.equal(eggName(2, "fr"), "OEUF");
  assert.equal(eggName(3, "en"), "タマゴ"); assert.equal(eggName(3, "fr"), "タマゴ");
  assert.equal(eggName(4), "Egg"); assert.equal(eggName(4, "fr"), "Oeuf");
  assert.equal(eggName(5, "fr"), "Œuf"); assert.equal(eggName(5, "ja"), "タマゴ");
  assert.equal(eggName(1), null);
});
