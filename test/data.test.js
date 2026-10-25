/* shared/data: cross-checks from docs/research/data-and-transfers.md that must keep holding after any
   rebuild, plus the API in docs/ARCHITECTURE.md "Game data". Expected values come from the research
   notes and the pret decompilations, not from the generated tables. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as D from "../shared/data/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "shared", "data");

test("limits per generation", () => {
  assert.deepEqual({ ...D.MAX_SPECIES }, { 1: 151, 2: 251, 3: 386, 4: 493, 5: 649 });
  assert.deepEqual({ ...D.MAX_MOVE }, { 1: 165, 2: 251, 3: 354, 4: 467, 5: 559 });
  assert.equal(D.MAX_ABILITY[3], 76); assert.equal(D.MAX_ABILITY[4], 123); assert.equal(D.MAX_ABILITY[5], 164);
  assert.equal(D.MAX_ITEM[3], 376); assert.equal(D.MAX_ITEM[4], 536); assert.equal(D.MAX_ITEM[5], 638);
  assert.equal(D.moveCountForGen(4), 467);
  assert.equal(D.moveName(165), "Struggle"); assert.equal(D.moveName(251), "Beat Up"); assert.equal(D.moveName(354), "Psycho Boost");
  assert.equal(D.moveName(467), "Shadow Force"); assert.equal(D.moveName(559), "Fusion Bolt");
  assert.equal(D.abilityName(76), "Air Lock"); assert.equal(D.abilityName(123), "Bad Dreams"); assert.equal(D.abilityName(164), "Teravolt");
});

test("Gen 1 internal species order (pokered constants)", () => {
  const known = { 0x01: 112, 0x03: 32, 0x15: 151, 0x54: 25, 0x83: 150, 0x99: 1, 0xb0: 4, 0xb1: 7, 0xb4: 6, 0xbe: 71, 0x1f: 0, 0xb6: 0, 0xb7: 0, 0xb8: 0 };
  for (const [i, sp] of Object.entries(known)) assert.equal(D.gen1ToNational(Number(i)), sp, `internal 0x${Number(i).toString(16)}`);
  const seen = new Set();
  for (let i = 1; i <= 190; i++) { const sp = D.gen1ToNational(i); if (sp) { assert.ok(sp <= 151); seen.add(sp); assert.equal(D.nationalToGen1(sp), i); } }
  assert.equal(seen.size, 151);
  assert.equal(D.gen1ToNational(191), 0); assert.equal(D.nationalToGen1(152), 0);
});

test("Gen 3 internal species order (pokeemerald species.h)", () => {
  for (let i = 1; i <= 251; i++) assert.equal(D.gen3ToNational(i), i);
  for (let i = 252; i <= 276; i++) assert.equal(D.gen3ToNational(i), 0, `old Unown slot ${i}`);
  assert.equal(D.gen3ToNational(277), 252);   // Treecko
  assert.equal(D.gen3ToNational(407), 380);   // Latias
  assert.equal(D.gen3ToNational(409), 385);   // Jirachi
  assert.equal(D.gen3ToNational(410), 386);   // Deoxys
  assert.equal(D.gen3ToNational(411), 358);   // Chimecho
  assert.equal(D.gen3ToNational(D.GEN3_EGG), 0);
  const seen = new Set();
  for (let i = 1; i <= 411; i++) { const sp = D.gen3ToNational(i); if (sp) { seen.add(sp); assert.equal(D.nationalToGen3(sp), i); } }
  assert.equal(seen.size, 386);
});

test("items: the documented PokeAPI defects are corrected", () => {
  // Gen 2 (pokecrystal item_constants.asm)
  assert.equal(D.itemName(2, 0x15), "Max Elixir");
  assert.equal(D.itemName(2, 0x41), "Elixir");
  assert.equal(D.itemName(2, 0x74), "Blue Card");
  assert.equal(D.itemName(2, 0x79), "Energy Powder");
  assert.equal(D.itemName(2, 0x06), "Town Map");
  assert.equal(D.itemName(2, 0x73), "GS Ball");
  assert.equal(D.itemName(2, 0x98), "Berserk Gene");
  assert.equal(D.itemName(2, 0x9e), "Flower Mail");
  assert.equal(D.itemName(2, 0xbd), "Mirage Mail");
  assert.equal(D.itemName(2, 0xdc), null);       // unused id between TM28 and TM29
  assert.equal(D.itemName(2, 0xdd), "TM29");
  assert.equal(D.itemName(2, 0xf9), "HM07");
  // Gen 2 berries are their own items, with the later item as a conversion hint only
  assert.equal(D.itemName(2, 0x6d), "MiracleBerry");
  assert.equal(D.itemInfo(2, 0x6d).approx, 157);   // Lum Berry (national = Gen 4/5 id)
  assert.equal(D.nationalItemName(D.itemInfo(2, 0xad).approx), "Oran Berry");
  assert.equal(D.nationalItemName(D.itemInfo(2, 0x68).approx), "Silk Scarf");   // Pink Bow
  assert.equal(D.itemName(2, 0xae), "Gold Berry");
  // Gen 3 (pokeemerald items.h): Basement Key is 271, Itemfinder 261
  assert.equal(D.itemName(3, 271), "Basement Key");
  assert.equal(D.itemToNational(3, 261), D.itemToNational(4, 471));   // Itemfinder = Dowsing Machine
  assert.equal(D.itemName(3, 267), null);
  // Gen 5 keeps Gen 4 ids: Deep Sea Tooth 226, Deep Sea Scale 227, Yellow Apricorn 486, Blue Apricorn 487
  for (const g of [4, 5]) {
    assert.equal(D.itemName(g, 226), "Deep Sea Tooth"); assert.equal(D.itemName(g, 227), "Deep Sea Scale");
    assert.equal(D.itemName(g, 486), "Yellow Apricorn"); assert.equal(D.itemName(g, 487), "Blue Apricorn");
  }
  assert.equal(D.itemName(5, 356), "TM29");
});

test("items: index spaces and national ids", () => {
  // Leftovers in every generation that has it, as one national item
  const nat = D.itemToNational(5, 234);
  assert.equal(D.itemToNational(2, 0x92), nat); assert.equal(D.itemToNational(3, 200), nat); assert.equal(D.itemToNational(4, 234), nat);
  assert.equal(nat, 234);   // Gen 4/5 records store national ids directly
  assert.equal(D.itemName(1, 0x28), "Rare Candy"); assert.equal(D.itemName(1, 0xc4), "HM01"); assert.equal(D.itemName(1, 0xc9), "TM01");
  assert.equal(D.itemName(1, 0x07), "Surfboard");
  // Everstone 0x70 / 195 / 229 and the trade items of §3.1
  assert.equal(D.itemFromNational(2, D.itemToNational(5, 229)), 0x70);
  assert.equal(D.itemFromNational(3, D.itemToNational(5, 229)), 195);
  for (const [g2, g3, g4] of [[0x52, 187, 221], [0x8f, 199, 233], [0x97, 201, 235], [0xac, 218, 252]]) {
    assert.equal(D.itemToNational(2, g2), g4); assert.equal(D.itemToNational(3, g3), g4);
  }
  assert.equal(D.itemToNational(3, 192), 226); assert.equal(D.itemToNational(3, 193), 227);
  assert.equal(D.itemName(4, 321), "Protector"); assert.equal(D.itemName(4, 325), "Reaper Cloth"); assert.equal(D.itemName(5, 537), "Prism Scale");
  // Gen 4 mails and HM07/HM08 are not Gen 5 items
  assert.equal(D.itemName(4, 137), "Grass Mail"); assert.equal(D.itemName(5, 137), "Greet Mail");
  assert.notEqual(D.itemToNational(4, 137), D.itemToNational(5, 137));
  assert.equal(D.itemName(4, 426), "HM07"); assert.equal(D.itemName(5, 426), null);
  assert.deepEqual([...D.G4_TO_G5_EXCEPTIONS], [137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 426, 427]);
  assert.equal(D.g4ItemToG5(234), 234); assert.equal(D.g4ItemToG5(140), 0);
  assert.equal(D.g4ItemToG5(116), 0);    // unused in Gen 4 (Douse Drive in Gen 5)
  assert.equal(D.g4ItemToG5(537), 0);
  // round trips within each generation
  for (const g of [1, 2, 3, 4, 5]) for (let i = 1; i <= D.MAX_ITEM[g]; i++) {
    const n = D.itemToNational(g, i);
    if (n) { assert.equal(D.itemFromNational(g, n), i, `gen ${g} item ${i}`); assert.ok(D.itemName(g, i)); }
  }
  assert.equal(D.itemFromNational(3, D.itemToNational(5, 576)), 0);   // Dream Ball is Gen 5 only
});

test("item rules: Time Capsule catch rates, Pal Park, Gen 3 -> Gen 4", () => {
  assert.deepEqual({ ...D.G1_CATCH_RATE_FIX }, { 0x19: 0x92, 0x2d: 0x53, 0x32: 0xae, 0x5a: 0xad, 0x64: 0xad, 0x78: 0xad, 0x87: 0xad,
    0xbe: 0xad, 0xc3: 0xad, 0xdc: 0xad, 0xfa: 0xad, 0xff: 0xad });
  assert.equal(D.gen1CatchRateItem(0x19), 0x92); assert.equal(D.gen1CatchRateItem(3), 3); assert.equal(D.gen1CatchRateItem(0), 0);
  assert.equal(D.itemName(2, D.gen1CatchRateItem(3)), "Bright Powder");   // Mewtwo's catch rate 3
  assert.equal(D.itemName(2, D.gen1CatchRateItem(0xa3)), "Light Ball");   // Yellow's starter Pikachu
  assert.equal(D.PAL_PARK_BLOCKED_G3.length, 145);
  for (const i of [5, 52, 62, 72, 121, 132, 176, 178, 226, 253, 259, 288, 339, 346, 349, 376]) assert.ok(D.PAL_PARK_BLOCKED_G3.includes(i), `${i} blocked`);
  for (const i of [1, 4, 13, 175, 200, 289]) assert.ok(!D.PAL_PARK_BLOCKED_G3.includes(i), `${i} allowed`);
  assert.equal(D.g3ItemToG4(13), 17); assert.equal(D.g3ItemToG4(200), 234); assert.equal(D.g3ItemToG4(175), 208); assert.equal(D.g3ItemToG4(289), 328);
  for (let i = 1; i <= 376; i++) if (!D.PAL_PARK_BLOCKED_G3.includes(i)) assert.ok(D.g3ItemToG4(i) > 0, `Gen 3 item ${i} must have a Gen 4 equivalent`);
});

test("EXP table matches the closed-form formulas (§4.9)", () => {
  const f = (rate, n) => {
    if (n === 1) return 0;
    const c = n ** 3;
    if (rate === 0) return c;
    if (rate === 1) return n <= 50 ? Math.floor(c * (100 - n) / 50) : n <= 68 ? Math.floor(c * (150 - n) / 100)
      : n <= 98 ? Math.floor(c * Math.floor((1911 - 10 * n) / 3) / 500) : Math.floor(c * (160 - n) / 100);
    if (rate === 2) return n <= 15 ? Math.floor(c * (Math.floor((n + 1) / 3) + 24) / 50) : n <= 36 ? Math.floor(c * (n + 14) / 50)
      : Math.floor(c * (Math.floor(n / 2) + 32) / 50);
    if (rate === 3) return Math.floor(6 * c / 5) - 15 * n * n + 100 * n - 140;
    if (rate === 4) return Math.floor(4 * c / 5);
    return Math.floor(5 * c / 4);
  };
  for (let r = 0; r < 6; r++) for (let n = 1; n <= 100; n++) assert.equal(D.expAtLevel(r, n), f(r, n), `rate ${r} level ${n}`);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((r) => D.expAtLevel(r, 100)), [1000000, 600000, 1640000, 1059860, 800000, 1250000]);
  for (let r = 0; r < 6; r++) for (let n = 1; n <= 100; n++) {
    assert.equal(D.levelAtExp(r, D.expAtLevel(r, n)), n);
    if (n > 1) assert.equal(D.levelAtExp(r, D.expAtLevel(r, n) - 1), n - 1);
  }
  assert.equal(D.levelAtExp(0, 5_000_000), 100);
  assert.equal(D.growthRate(1), 3); assert.equal(D.growthRate(25), 0); assert.equal(D.growthRate(129), 5);
  assert.equal(D.growthRate(290), 1); assert.equal(D.growthRate(336), 2); assert.equal(D.growthRate(35), 4);
});

test("base stats: Gen 1 Special, Gen 2 split, history to Gen 5, forms", () => {
  assert.deepEqual(D.baseStats(1, 150), { hp: 106, atk: 110, def: 90, spa: 154, spd: 154, spe: 130 });
  assert.deepEqual(D.baseStats(2, 150), { hp: 106, atk: 110, def: 90, spa: 154, spd: 90, spe: 130 });
  assert.equal(D.baseStats(1, 1).spa, 65); assert.equal(D.baseStats(1, 65).spa, 135); assert.equal(D.baseStats(1, 113).spa, 105);
  assert.equal(D.baseStats(1, 113).spd, 105); assert.equal(D.baseStats(2, 113).spa, 35);
  assert.deepEqual(D.baseStats(5, 25), { hp: 35, atk: 55, def: 30, spa: 50, spd: 40, spe: 90 });   // Pikachu before Gen 6
  assert.equal(D.baseStats(5, 36).spa, 85);    // Clefable before Gen 6
  assert.equal(D.baseStats(3, 12).spa, 80);    // Butterfree before Gen 6
  assert.deepEqual(D.baseStats(5, 615), { hp: 70, atk: 50, def: 30, spa: 95, spd: 135, spe: 105 });   // Cryogonal (PokeAPI files Def under Atk)
  assert.deepEqual(D.baseStats(4, 386, 1), { hp: 50, atk: 180, def: 20, spa: 180, spd: 20, spe: 150 });
  assert.deepEqual(D.baseStats(3, 386, D.DEOXYS_GEN3_FORM.E), { hp: 50, atk: 95, def: 90, spa: 95, spd: 90, spe: 180 });
  assert.deepEqual(D.baseStats(4, 487, 1), { hp: 150, atk: 120, def: 100, spa: 120, spd: 100, spe: 90 });
  assert.deepEqual(D.baseStats(4, 492, 1), { hp: 100, atk: 103, def: 75, spa: 120, spd: 75, spe: 127 });
  assert.deepEqual(D.baseStats(5, 479, 2), { hp: 50, atk: 65, def: 107, spa: 105, spd: 107, spe: 86 });
  assert.deepEqual(D.baseStats(5, 493, 9), D.baseStats(5, 493, 0));
  assert.equal(D.baseStats(1, 152), null); assert.equal(D.baseStats(4, 494), null);
});

test("types per generation", () => {
  assert.deepEqual(D.types(1, 81), ["Electric"]); assert.deepEqual(D.types(2, 81), ["Electric", "Steel"]);
  assert.deepEqual(D.types(5, 35), ["Normal"]); assert.deepEqual(D.types(1, 94), ["Ghost", "Poison"]);
  assert.deepEqual(D.types(4, 479, 2), ["Electric", "Ghost"]); assert.deepEqual(D.types(5, 479, 2), ["Electric", "Water"]);
  assert.deepEqual(D.types(4, 493, 10), ["Fire"]); assert.deepEqual(D.types(5, 493, 9), ["Fire"]); assert.deepEqual(D.types(4, 493, 9), ["???"]);
  assert.equal(D.formName(493, 9, 4), "??? Type"); assert.equal(D.formName(493, 9, 5), "Fire Type");
  assert.deepEqual(D.types(4, 413, 1), ["Bug", "Ground"]);
  assert.equal(D.typeByte(1, "Fire"), 0x14); assert.equal(D.typeByte(2, "Dark"), 0x1b); assert.equal(D.typeByte(2, "???"), 0x13);
  assert.equal(D.typeByte(1, "Steel"), -1); assert.equal(D.typeByte(5, "???"), -1); assert.equal(D.typeByte(3, "???"), 9); assert.equal(D.typeByte(5, "Fire"), 9);
  assert.equal(D.typeFromByte(1, 0x17), "Electric"); assert.equal(D.typeFromByte(1, 0x06), null);
  assert.deepEqual([...D.HIDDEN_POWER_TYPES], ["Fighting", "Flying", "Poison", "Ground", "Rock", "Bug", "Ghost", "Steel", "Fire", "Water",
    "Grass", "Electric", "Psychic", "Ice", "Dragon", "Dark"]);
});

test("abilities per generation", () => {
  const a = (g, sp, f) => D.abilities(g, sp, f).map((x) => (x ? D.abilityName(x) : null));
  assert.deepEqual(a(3, 16), ["Keen Eye", null, null]);
  assert.deepEqual(a(4, 16), ["Keen Eye", "Tangled Feet", null]);
  assert.deepEqual(a(5, 16), ["Keen Eye", "Tangled Feet", "Big Pecks"]);
  assert.deepEqual(a(5, 94), ["Levitate", null, null]);
  assert.deepEqual(a(5, 109), ["Levitate", null, null]);   // no Stench before Gen 8
  assert.deepEqual(a(4, 386, 3), ["Pressure", null, null]);
  assert.deepEqual(a(5, 641, 1), ["Regenerator", null, null]);
  assert.deepEqual(D.abilities(2, 25), [0, 0, 0]);
  assert.ok(D.gainedAbilityInGen4(16)); assert.ok(!D.gainedAbilityInGen4(1));
  for (let sp = 1; sp <= 386; sp++) for (const x of D.abilities(3, sp)) assert.ok(x <= 76);
  for (let sp = 1; sp <= 493; sp++) for (const x of D.abilities(4, sp)) assert.ok(x <= 123);
});

test("moves per generation (history, categories, PokeAPI PP fixes)", () => {
  const m = (id, g) => D.moveInfo(id, g);
  assert.equal(m(44, 1).type, "Normal"); assert.equal(m(44, 2).type, "Dark");
  assert.equal(m(16, 1).type, "Normal"); assert.equal(m(16, 2).type, "Flying");
  assert.equal(m(2, 1).type, "Normal"); assert.equal(m(2, 2).type, "Fighting");
  assert.equal(m(174, 2).type, "???"); assert.equal(m(174, 4).type, "???"); assert.equal(m(174, 5).type, "Ghost");
  assert.deepEqual([m(33, 4).power, m(33, 4).accuracy, m(33, 5).power, m(33, 5).accuracy], [35, 95, 50, 100]);
  assert.deepEqual([1, 3, 4, 5].map((g) => m(105, g).pp), [20, 20, 10, 10]);   // Recover
  for (const id of [135, 156]) assert.deepEqual([1, 2, 3, 4, 5].map((g) => m(id, g).pp), [10, 10, 10, 10, 10]);
  assert.equal(m(208, 2).pp, 10); assert.equal(m(303, 3).pp, 10); assert.equal(m(355, 4).pp, 10);
  assert.deepEqual([2, 3, 4, 5].map((g) => m(170, g).pp), [5, 5, 5, 5]);   // Mind Reader
  assert.equal(m(165, 1).pp, 10); assert.equal(m(165, 2).pp, 1);          // Struggle
  assert.equal(m(295, 3).power, 70); assert.equal(m(296, 5).power, 70);   // Luster Purge, Mist Ball
  assert.equal(m(247, 3).category, "Physical"); assert.equal(m(247, 4).category, "Special");   // Shadow Ball
  assert.equal(m(44, 3).category, "Special"); assert.equal(m(44, 4).category, "Physical");      // Bite
  assert.equal(m(14, 1).category, "Status");
  for (let g = 2; g <= 5; g++) assert.equal(m(237, g).power, 0);   // Hidden Power: variable, like Low Kick
  assert.equal(m(67, 3).power, 0);
  assert.equal(m(166, 1), null); assert.equal(m(252, 2), null); assert.equal(m(355, 3), null); assert.equal(m(560, 5), null);
  assert.equal(D.basePP(1, 1), 35);
});

test("natures", () => {
  assert.equal(D.natureName(0), "Hardy"); assert.equal(D.natureName(3), "Adamant"); assert.equal(D.natureName(24), "Quirky");
  assert.deepEqual(D.natureStats(3), { up: "atk", down: "spa" });
  assert.deepEqual(D.natureStats(10), { up: "spe", down: "atk" });
  assert.deepEqual(D.natureStats(15), { up: "spa", down: "atk" });
  for (const n of [0, 6, 12, 18, 24]) assert.equal(D.natureStats(n), null);
});

test("species attributes", () => {
  assert.equal(D.genderThreshold(1), 31); assert.equal(D.genderThreshold(25), 127); assert.equal(D.genderThreshold(298), 191);
  assert.equal(D.genderThreshold(183), 127); assert.equal(D.genderThreshold(29), D.FEMALE_ONLY); assert.equal(D.genderThreshold(128), D.MALE_ONLY);
  assert.equal(D.genderThreshold(81), D.GENDERLESS); assert.equal(D.genderThreshold(35), 191); assert.equal(D.genderThreshold(133), 31);
  assert.equal(D.speciesGen(251), 2); assert.equal(D.speciesGen(252), 3); assert.equal(D.speciesGen(649), 5); assert.equal(D.speciesGen(650), 0);
  assert.equal(D.baseFriendship(25), 70); assert.equal(D.catchRate(150), 3); assert.equal(D.evolvesFrom(26), 25);
  assert.equal(D.speciesName(25), "Pikachu"); assert.equal(D.speciesName(25, "ja"), "ピカチュウ"); assert.equal(D.speciesName(25, "ko"), "피카츄");
  assert.equal(D.speciesName(122, "fr"), "M. Mime"); assert.equal(D.speciesName(122, "de"), "Pantimos"); assert.equal(D.speciesName(0), null);
});

test("forms, Showdown names and sprite stems", () => {
  assert.equal(D.formCount(201, 2), 26); assert.equal(D.formCount(201, 3), 28); assert.equal(D.formCount(493, 4), 18); assert.equal(D.formCount(493, 5), 17);
  assert.equal(D.formCount(172, 4), 2); assert.equal(D.formCount(172, 5), 1); assert.equal(D.formCount(25, 5), 1); assert.equal(D.formCount(646, 5), 3);
  assert.equal(D.formName(201, 26), "!"); assert.equal(D.formName(386, 1), "Attack Forme"); assert.equal(D.formName(386, 0), null);
  assert.equal(D.formName(646, 1), "White Kyurem"); assert.equal(D.formName(646, 2), "Black Kyurem");
  assert.ok(D.formsOf(351, 4)[1].battleOnly); assert.ok(!D.formsOf(487, 4)[1].battleOnly);
  assert.equal(D.showdownName(29), "Nidoran-F"); assert.equal(D.showdownId(32), "nidoranm"); assert.equal(D.showdownId(83), "farfetchd");
  assert.equal(D.showdownName(122), "Mr. Mime"); assert.equal(D.showdownId(250), "hooh"); assert.equal(D.showdownId(474), "porygonz");
  assert.equal(D.showdownName(201, 1), "Unown-B"); assert.equal(D.showdownName(201, 27), "Unown-Question");
  assert.equal(D.showdownName(386, 3), "Deoxys-Speed"); assert.equal(D.showdownName(479, 2), "Rotom-Wash");
  assert.equal(D.showdownName(172, 1, 4), "Pichu-Spiky-eared"); assert.equal(D.showdownName(550, 1), "Basculin-Blue-Striped");
  assert.equal(D.showdownName(646, 1), "Kyurem-White"); assert.equal(D.showdownName(641, 1), "Tornadus-Therian");
  assert.equal(D.showdownName(493, 9, 4), "Arceus"); assert.equal(D.showdownName(493, 9, 5), "Arceus-Fire");
  assert.deepEqual(D.showdownToSpecies("Kyurem-Black"), { species: 646, form: 2 });
  assert.deepEqual(D.showdownToSpecies("arceusfire"), { species: 493, form: 9 });
  assert.deepEqual(D.showdownToSpecies("Farfetch’d"), { species: 83, form: 0 });
  assert.deepEqual(D.showdownToSpecies("Pichu-Spiky-eared"), { species: 172, form: 1 });
  assert.equal(D.showdownToSpecies("Missingno"), null);
  assert.equal(D.spriteStem(25), "25"); assert.equal(D.spriteStem(201, 1), "201-b"); assert.equal(D.spriteStem(201, 0), "201");
  assert.equal(D.spriteStem(201, 26), "201-exclamation"); assert.equal(D.spriteStem(386, 1), "10001"); assert.equal(D.spriteStem(487, 1), "10007");
  assert.equal(D.spriteStem(479, 2), "10009"); assert.equal(D.spriteStem(493, 9), "493-fire"); assert.equal(D.spriteStem(493, 9, 4), "493-unknown");
  assert.equal(D.spriteStem(412, 1), "412-sandy"); assert.equal(D.spriteStem(422, 1), "422-east"); assert.equal(D.spriteStem(649, 1), "649-douse");
  assert.equal(D.spriteStem(351, 1), "10013"); assert.equal(D.spriteStem(646, 1), "10023");
  assert.deepEqual(D.showdownSprite("Deoxys-Speed"), { num: 386, file: "10003" });
  assert.deepEqual(D.showdownSprite("Pikachu"), { num: 25 });
  assert.deepEqual(D.showdownSprite("Unown-B"), { num: 201, file: "201-b" });
});

test("trade evolutions (§3.1)", () => {
  const trade = [];
  for (let sp = 1; sp <= 649; sp++) for (const e of D.evolutions(sp)) if (e.method === "trade") trade.push([e.from, e.to, e.gen, e.item ?? 0, e.partner ?? 0].join(":"));
  assert.deepEqual(trade.sort(), ["64:65:1:0:0", "67:68:1:0:0", "75:76:1:0:0", "93:94:1:0:0", "61:186:2:221:0", "79:199:2:221:0",
    "95:208:2:233:0", "123:212:2:233:0", "117:230:2:235:0", "137:233:2:252:0", "366:367:3:226:0", "366:368:3:227:0",
    "112:464:4:321:0", "125:466:4:322:0", "126:467:4:323:0", "233:474:4:324:0", "356:477:4:325:0", "525:526:5:0:0",
    "533:534:5:0:0", "588:589:5:0:616", "616:617:5:0:588", "349:350:5:537:0"].sort());
  assert.ok(D.evolutions(349).some((e) => e.method === "level-up" && e.beauty === 170));
  // Friendship evolutions need 220 in Gen 2-5 (PokeAPI mostly lists Gen 8's 160)
  const friendship = [];
  for (let sp = 1; sp <= 649; sp++) for (const e of D.evolutions(sp)) if (e.happiness != null) friendship.push(`${e.to}:${e.happiness}`);
  assert.equal(friendship.length, 16);
  assert.ok(friendship.every((s) => s.endsWith(":220")), friendship.join(" "));
  assert.deepEqual(D.evolutionsInto(196).map((e) => [e.from, e.time, e.happiness]), [[133, "day", 220]]);
  assert.deepEqual(D.evolutionsInto(26).map((e) => [e.from, e.method, D.nationalItemName(e.item)]), [[25, "use-item", "Thunder Stone"]]);
});

test("locations, games, balls, HMs, languages", () => {
  assert.equal(D.locationName(2, 0x46), "Lav Radio Tower"); assert.equal(D.locationName(2, 0x58), "Victory Road");
  assert.equal(D.locationName(2, 0x59), "Route 23"); assert.equal(D.locationName(2, 0x7e), "Gift"); assert.equal(D.locationName(2, 0x7f), "Event");
  assert.equal(D.locationName(3, 0x10), "Route 101"); assert.equal(D.locationName(3, 0x58), "Pallet Town"); assert.equal(D.locationName(3, 0xc4), "Celadon Dept.");
  assert.equal(D.locationName(3, 0xd4), "Trainer Hill"); assert.equal(D.locationName(3, 0xd5), null);
  assert.equal(D.locationName(3, 0xfd), "Special Egg"); assert.equal(D.locationName(3, 0xff), "Fateful encounter");
  assert.equal(D.locationName(4, 55), "Pal Park"); assert.equal(D.locationName(4, 126), "New Bark Town"); assert.equal(D.locationName(4, 182), "Route 34");
  assert.equal(D.locationName(4, 233), "Pokéwalker"); assert.equal(D.locationName(4, 2000), "Day-Care Couple"); assert.equal(D.locationName(4, 2002), "Link trade");
  assert.equal(D.locationName(4, 3002), "Faraway place");
  assert.equal(D.locationName(5, 30001), "Poké Transfer"); assert.equal(D.locationName(5, 30007), "Sinnoh"); assert.equal(D.locationName(5, 60002), "Day-Care Couple");
  assert.equal(D.locationName(5, 30004), "Kanto"); assert.equal(D.locationName(5, 30008), "Distant land");
  assert.equal(D.gameName(12), "Platinum"); assert.equal(D.gameName(15), "Colosseum/XD"); assert.equal(D.gameName(23), "Black 2"); assert.equal(D.gameName(9), null);
  assert.equal(D.gameCode(3), "E"); assert.equal(D.gameGen(7), 4); assert.equal(D.gameGen(20), 5);
  assert.equal(D.gameCodeName(4, "HGSS"), "HeartGold/SoulSilver"); assert.deepEqual(D.gameCodeOrigins(4, "HGSS"), [7, 8]);
  assert.deepEqual(D.gameCodeOrigins(3, "E"), [3]); assert.ok(D.gameCodes(1).includes("Y"));
  assert.equal(D.ballName(4, 3), "Poké Ball"); assert.equal(D.ballName(12, 3), "Premier Ball"); assert.equal(D.ballName(13, 3), null);
  assert.equal(D.ballName(17, 4), "Fast Ball"); assert.equal(D.ballName(24, 4), "Sport Ball"); assert.equal(D.ballItem(24, 4), 499);
  assert.equal(D.ballName(25, 4), "Park Ball"); assert.equal(D.ballName(25, 5), "Dream Ball"); assert.equal(D.ballItem(16, 5), 16);
  assert.deepEqual(D.hmMoves(1), [15, 19, 57, 70, 148]);
  assert.deepEqual(D.hmMoves(3), [15, 19, 57, 70, 148, 249, 127, 291]);
  assert.deepEqual(D.hmMoves(4, "Pt"), [15, 19, 57, 70, 432, 249, 127, 431]);
  assert.deepEqual(D.hmMoves(4, "HGSS"), [15, 19, 57, 70, 250, 249, 127, 431]);
  assert.deepEqual({ ...D.LANG_IDS }, { ja: 1, en: 2, fr: 3, it: 4, de: 5, es: 7, ko: 8 });
  assert.equal(D.langFromId(5), "de"); assert.equal(D.langFromId(6), null);
});

test("item conversion between generations and obedience caps", () => {
  assert.equal(D.convertItem(3, 200, 4), 234);                // Leftovers through Pal Park
  assert.equal(D.convertItem(3, 121, 4), 0);                  // Orange Mail has no Gen 4 equivalent
  assert.equal(D.convertItem(4, 140, 5), 0);                  // Gen 4 Bloom Mail
  assert.equal(D.convertItem(2, 0x92, 3), 200);               // Leftovers Gen 2 -> Gen 3
  assert.equal(D.convertItem(2, 0x6d, 3), 0);                 // MiracleBerry is not Lum Berry ...
  assert.equal(D.convertItem(2, 0x6d, 3, { approx: true }), 141);   // ... unless the caller opts in
  assert.equal(D.convertItem(1, 0x28, 2), 0x20);              // Rare Candy Gen 1 -> Gen 2
  for (let i = 1; i <= 376; i++) assert.equal(D.convertItem(3, i, 4), D.g3ItemToG4(i));
  assert.equal(D.obedienceLevel(1, "RB", 0), 10);
  assert.equal(D.obedienceLevel(1, "Y", 0b10), 30);           // Cascade Badge
  assert.equal(D.obedienceLevel(2, "C", 0b11111111), 100);
  // pokecrystal wJohtoBadges: Zephyr 0, Hive 1, Plain 2, Fog 3, Mineral 4, Storm 5, Glacier 6, Rising 7
  assert.equal(D.obedienceLevel(2, "C", 0b00100000), 70);     // Storm Badge
  assert.equal(D.obedienceLevel(2, "GS", 0b01011111), 50);    // Fog and Mineral, but no Storm
  assert.equal(D.obedienceLevel(4, "HGSS", 0b1), 20);         // Zephyr Badge
  // pokeheartgold TryDisobedience: any 1 badge 20, any 2 30, Fog (bit 3) 50, Mineral (bit 5) 70, any 8 all
  assert.equal(D.obedienceLevel(4, "HG", 1 << 8), 20);        // a Kanto badge counts
  assert.equal(D.obedienceLevel(4, "SS", 0b00001000), 50);    // Fog alone
  assert.equal(D.obedienceLevel(4, "HGSS", 0b00011111), 50);  // Storm is bit 4 in HGSS, not the 70 badge
  assert.equal(D.obedienceLevel(4, "HGSS", 0b00111111), 70);
  assert.equal(D.obedienceLevel(4, "HGSS", 0b10000000), 20);  // Rising alone is just one badge
  assert.equal(D.obedienceLevel(4, "HGSS", 0xff00), 100);     // eight Kanto badges
  assert.equal(D.obedienceLevel(2, "GS", 0b1), 10);
  assert.equal(D.obedienceLevel(4, "Pt", 0b101000), 30);      // two badges, whichever they are
  assert.equal(D.obedienceLevel(3, "FRLG", 0b100000), 70);    // Marsh Badge
  assert.equal(D.obedienceLevel(5, "B2W2", 0b1000000), 80);
});

test("non-English text loads lazily and falls back to English", async () => {
  assert.equal(D.languageLoaded("en"), true);
  if (!D.languageLoaded("fr")) assert.equal(D.moveName(1, "fr"), "Pound");
  await D.loadLanguage("fr");
  assert.equal(D.languageLoaded("fr"), true);
  assert.equal(D.moveName(1, "fr"), "Écras’Face");
  assert.equal(D.typeName("Fire", "fr"), "Feu");
  assert.equal(D.natureName(3, "fr"), "Rigide");
  assert.equal(D.itemName(4, 234, "fr"), "Restes");
  await D.loadLanguage("ja");
  assert.equal(D.itemName(4, 1, "ja"), "マスターボール");
  await assert.rejects(D.loadLanguage("xx"));
});

test("shared/data modules are browser-safe and small", () => {
  let defaultBytes = 0;
  for (const f of fs.readdirSync(DATA).filter((f) => f.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(DATA, f), "utf8");
    assert.ok(!/from\s+["']node:|require\(|\bprocess\.|\bBuffer\b/.test(src), `${f} uses a Node-only API`);
    if (!/^text\.(?!en)/.test(f)) defaultBytes += src.length;
  }
  assert.ok(defaultBytes < 400 * 1024, `default-loaded data is ${defaultBytes} bytes`);
  for (const f of ["stats.js", "names.js"]) {
    const src = fs.readFileSync(path.join(ROOT, "shared", "pkm", f), "utf8");
    assert.ok(!/from\s+["']node:|require\(|\bprocess\.|\bBuffer\b/.test(src), `pkm/${f} uses a Node-only API`);
  }
  const sources = JSON.parse(fs.readFileSync(path.join(DATA, "SOURCES.json"), "utf8"));
  assert.ok(sources.files.length > 40);
  for (const f of sources.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
    assert.match(f.url, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//, f.path);
  }
  const lic = fs.readFileSync(path.join(DATA, "LICENSE.pokeapi"), "utf8");
  assert.ok(lic.includes("BSD-3-Clause") && lic.includes("Redistributions of source code must retain"));
});

test("rebuilding from the download cache reproduces the committed files", { timeout: 120_000 }, (t) => {
  const cache = process.env.PKDATA_CACHE || "/tmp/claude-1000/pkres/stage1-data/cache";
  if (!fs.existsSync(cache)) { t.skip(`no download cache at ${cache}`); return; }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pkdata-"));
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "build-data.mjs"), "--offline", "--cache", cache, "--out", out], { stdio: "pipe" });
    const generated = JSON.parse(fs.readFileSync(path.join(DATA, "SOURCES.json"), "utf8")).generated;
    for (const f of [...generated, "SOURCES.json"]) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(DATA, f))), `${f} differs from a rebuild`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
