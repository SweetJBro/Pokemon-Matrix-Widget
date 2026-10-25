/* shared/pkm/stats.js against hand-verified numbers (docs/research/data-and-transfers.md §4, the worked
   struct vectors in format-gen1-gen2.md §13.2, and the textbook Garchomp example in battle-engine.md §2.4). */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../shared/pkm/stats.js";

const STATS = (o) => [o.hp, o.atk, o.def, o.spa, o.spd, o.spe];

test("Gen 1 stats: worked Pikachu and Bulbasaur vectors", () => {
  // Pikachu L5, DVs A9 8C (Atk 10, Def 9, Spe 8, Spc 12 -> HP DV 4), no stat exp: HP/Atk/Def/Spe/Spc 18/11/8/14/11.
  const dvs = { atk: 10, def: 9, spe: 8, spc: 12 };
  assert.equal(S.hpDV(dvs), 4);
  const p = S.calcStats(1, 25, 0, 5, dvs, null);
  assert.deepEqual([p.hp, p.atk, p.def, p.spe, p.spa, p.spd], [18, 11, 8, 14, 11, 11]);
  // Bulbasaur L10, all DVs 15: max HP 32 (the box struct's current HP).
  assert.equal(S.calcStats(1, 1, 0, 10, { atk: 15, def: 15, spe: 15, spc: 15 }, {}).hp, 32);
});

test("Gen 2 stats: worked Cyndaquil vector and Special split", () => {
  // Crystal Cyndaquil L5, DVs A9 8C, no stat exp: 19/11/10 Spe 12 SpA 12 SpD 11.
  const c = S.calcStats(2, 155, 0, 5, { atk: 10, def: 9, spe: 8, spc: 12 }, {});
  assert.deepEqual([c.hp, c.atk, c.def, c.spe, c.spa, c.spd], [19, 11, 10, 12, 12, 11]);
  // Mewtwo L70, all DVs 15, max stat exp (bonus 63). By hand: HP floor((121*2+63)*70/100)+80 = 293,
  // Atk floor(313*.7)+5 = 224, Def 196, SpA floor(401*.7)+5 = 285, SpD 196, Spe floor(353*.7)+5 = 252.
  const max = { hp: 65535, atk: 65535, def: 65535, spe: 65535, spc: 65535 };
  assert.deepEqual(STATS(S.calcStats(2, 150, 0, 70, { atk: 15, def: 15, spe: 15, spc: 15 }, max)), [293, 224, 196, 285, 196, 252]);
  // Gen 1 Mewtwo has one Special (154) used for both.
  const g1 = S.calcStats(1, 150, 0, 70, { atk: 15, def: 15, spe: 15, spc: 15 }, max);
  assert.equal(g1.spa, 285); assert.equal(g1.spd, 285);
  // 999 cap (only reachable above level 100)
  assert.equal(S.calcStats(2, 242, 0, 250, { atk: 15, def: 15, spe: 15, spc: 15 }, max).hp, 999);
});

test("Gen 1/2 stat experience: ceil(sqrt) with the 255 cap", () => {
  const cases = [[0, 0], [1, 0], [9, 0], [15, 1], [16, 1], [62001, 62], [63001, 62], [63002, 63], [64516, 63], [64517, 63], [65025, 63], [65026, 63], [65535, 63]];
  for (const [x, e] of cases) assert.equal(S.statExpBonus(x), e, `stat exp ${x}`);
  // Exhaustive against a direct loop like the cartridge's (smallest b in 1..255 with b*b >= x).
  for (let x = 0; x <= 65535; x++) {
    let b = 1;
    while (b < 255 && b * b < x) b++;
    if (S.statExpBonus(x) !== Math.floor(b / 4)) assert.fail(`stat exp ${x}: ${S.statExpBonus(x)} vs ${Math.floor(b / 4)}`);
  }
});

test("Gen 3-5 stats: Garchomp L78 Adamant and nature handling", () => {
  const ivs = { hp: 24, atk: 12, def: 30, spa: 16, spd: 23, spe: 5 };
  const evs = { hp: 74, atk: 190, def: 91, spa: 48, spd: 84, spe: 23 };
  for (const gen of [4, 5]) assert.deepEqual(STATS(S.calcStats(gen, 445, 0, 78, ivs, evs, 3)), [289, 278, 193, 135, 171, 171]);
  // Pikachu L50, all 31 IVs, no EVs, Hardy: HP floor(101/2)+60 = 110, Atk floor(141/2)+5 = 75.
  const pk = S.calcStats(3, 25, 0, 50, { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, {}, 0);
  assert.deepEqual(STATS(pk), [110, 75, 50, 70, 60, 110]);
  // Timid (+Spe -Atk): floor(110*1.1) = 121, floor(75*0.9) = 67.
  const t = S.calcStats(3, 25, 0, 50, { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 }, {}, 10);
  assert.equal(t.spe, 121); assert.equal(t.atk, 67);
  assert.deepEqual(S.natureModifiers(3), { atk: 110, def: 100, spe: 100, spa: 90, spd: 100 });
  assert.equal(S.calcStats(3, 292, 0, 100, ivs, evs, 0).hp, 1);   // Shedinja
  // Forms use their own base stats (Deoxys-Speed: 50/95/90/95/90/180).
  assert.equal(S.calcStats(4, 386, 3, 100, { spe: 31 }, {}, 0).spe, 2 * 180 + 31 + 5);
  assert.equal(S.calcStats(1, 152, 0, 5, {}, {}), null);
});

test("Hidden Power", () => {
  assert.deepEqual(S.hiddenPower(2, { atk: 15, def: 15, spe: 15, spc: 15 }), { type: "Dark", power: 70 });
  assert.deepEqual(S.hiddenPower(2, { atk: 0, def: 0, spe: 0, spc: 0 }), { type: "Fighting", power: 31 });
  // Atk 10 (& 3 = 2), Def 9 (& 3 = 1): index 9 = Water; X = 8 + 4 + 2 + 1 = 15, Spc & 3 = 0 -> floor(75 / 2) + 31 = 68.
  assert.deepEqual(S.hiddenPower(2, { atk: 10, def: 9, spe: 8, spc: 12 }), { type: "Water", power: 68 });
  const all = (v) => ({ hp: v, atk: v, def: v, spa: v, spd: v, spe: v });
  assert.deepEqual(S.hiddenPower(3, all(31)), { type: "Dark", power: 70 });
  assert.deepEqual(S.hiddenPower(3, all(30)), { type: "Fighting", power: 70 });
  assert.deepEqual(S.hiddenPower(3, all(0)), { type: "Fighting", power: 30 });
  assert.equal(S.hiddenPower(4, { hp: 31, atk: 30, def: 31, spa: 30, spd: 31, spe: 30 }).type, "Fire");
  assert.equal(S.hiddenPower(4, { hp: 31, atk: 30, def: 30, spa: 31, spd: 31, spe: 31 }).type, "Ice");
  assert.equal(S.hiddenPower(5, { hp: 30, atk: 31, def: 31, spa: 30, spd: 31, spe: 31 }).type, "Grass");
  assert.equal(S.hiddenPower(5, { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 30 }).type, "Ice");
});

test("Gen 2 gender, shininess, Unown", () => {
  assert.equal(S.gen2Gender(1, 1), "F"); assert.equal(S.gen2Gender(1, 2), "M");      // 12.5 %: Atk DV <= 1
  assert.equal(S.gen2Gender(25, 7), "F"); assert.equal(S.gen2Gender(25, 8), "M");    // 50 %: <= 7
  assert.equal(S.gen2Gender(35, 11), "F"); assert.equal(S.gen2Gender(35, 12), "M");  // 75 %: <= 11
  assert.equal(S.gen2Gender(58, 3), "F"); assert.equal(S.gen2Gender(58, 4), "M");    // 25 %: <= 3
  assert.equal(S.gen2Gender(29, 15), "F"); assert.equal(S.gen2Gender(128, 0), "M"); assert.equal(S.gen2Gender(81, 0), null);
  for (const atk of [2, 3, 6, 7, 10, 11, 14, 15]) assert.ok(S.gen2Shiny({ atk, def: 10, spe: 10, spc: 10 }));
  for (const atk of [0, 1, 4, 5, 8, 9, 12, 13]) assert.ok(!S.gen2Shiny({ atk, def: 10, spe: 10, spc: 10 }));
  assert.ok(!S.gen2Shiny({ atk: 10, def: 9, spe: 10, spc: 10 }));
  assert.equal(S.unownLetterGen2({ atk: 5, def: 11, spe: 14, spc: 7 }), 15);   // DVs 5B E7 -> v 159 -> P
  assert.equal(S.unownLetterGen2({ atk: 0, def: 0, spe: 0, spc: 0 }), 0);
  assert.equal(S.unownLetterGen2({ atk: 15, def: 15, spe: 15, spc: 15 }), 25);
});

test("Gen 3-5 gender, shininess, Unown, nature, Spinda, ability slot", () => {
  // Azurill (75 % F) vs Marill (50 % F): PID low byte 127-190 is a female Azurill but a male Marill.
  for (const lo of [127, 150, 190]) { assert.equal(S.gen3Gender(298, lo), "F"); assert.equal(S.gen3Gender(183, lo), "M"); }
  assert.equal(S.gen3Gender(298, 191), "M"); assert.equal(S.gen3Gender(183, 126), "F");
  assert.equal(S.gen3Gender(1, 30), "F"); assert.equal(S.gen3Gender(1, 31), "M");
  assert.equal(S.gen3Gender(29, 255), "F"); assert.equal(S.gen3Gender(32, 0), "M"); assert.equal(S.gen3Gender(81, 5), null);
  // format-gen3.md §14.1 vector 2: PID 0xF6825A5A, OTID 0xBEEF1234 is shiny (value 3), nature 21 (Gentle).
  assert.equal(S.shinyValue(0xf6825a5a, 0x1234, 0xbeef), 3);
  assert.ok(S.gen3Shiny(0xf6825a5a, 0x1234, 0xbeef));
  assert.equal(S.natureFromPid(0xf6825a5a), 21);
  assert.ok(!S.gen3Shiny(0xdeadbeef, 0x1234, 0xbeef));
  const tid = 12345, sid = 54321;
  assert.ok(S.gen3Shiny(((tid ^ sid ^ 7) << 16) >>> 0, tid, sid));
  assert.ok(!S.gen3Shiny(((tid ^ sid ^ 8) << 16) >>> 0, tid, sid));
  assert.equal(S.natureFromPid(0xffffffff), 20);
  assert.equal(S.unownFormGen3(0), 0); assert.equal(S.unownFormGen3(0x03030303), 255 % 28);
  assert.equal(S.unownFormGen3(0x00000102), (1 << 2 | 2) % 28);
  assert.deepEqual(S.spindaSpots(0x12345678), [{ x: 0, y: -1 }, { x: -2, y: -3 }, { x: -4, y: -5 }, { x: -6, y: -7 }]);
  assert.equal(S.abilitySlotFromPid(0x00010000, 5, 21), 1); assert.equal(S.abilitySlotFromPid(0x00010000, 5, 12), 0);
  assert.equal(S.abilitySlotFromPid(0x00000001, 4), 1);
});

test("PP with PP Ups", () => {
  assert.equal(S.maxPP(1, 33, 3), 56);   // Tackle 35: 35 + 3 * 7
  assert.equal(S.maxPP(1, 45, 3), 61);   // Growl 40: 40 + 3 * 7 (6-bit field)
  assert.equal(S.maxPP(2, 86, 3), 32);   // Thunder Wave 20: 20 + 3 * 4
  assert.equal(S.maxPP(3, 45, 3), 64);   // 40 + floor(40 * 3 / 5)
  assert.equal(S.maxPP(4, 105, 3), 16);  // Recover is 10 PP in Gen 4
  assert.equal(S.maxPP(5, 1, 0), 35);
});

test("EXP: Medium Slow level-1 quirk and level from EXP", () => {
  assert.equal(S.expAtLevelForGen(1, 3, 1), 0xffffca);
  assert.equal(S.expAtLevelForGen(2, 3, 1), 16777162);
  assert.equal(S.expAtLevelForGen(3, 3, 1), 0);
  assert.equal(S.expAtLevelForGen(1, 3, 2), 9);
  assert.equal(S.levelAtExp(3, S.GEN12_MEDIUM_SLOW_L1), 100);   // the underflow glitch: the game sees level 100
  assert.equal(S.levelAtExp(3, 0), 1); assert.equal(S.levelAtExp(3, 135), 5); assert.equal(S.levelAtExp(0, 125), 5);
  assert.equal(S.levelAtExp(0, 124), 4); assert.equal(S.levelAtExp(3, 560), 10); assert.equal(S.expAtLevel(3, 10), 560);
});
