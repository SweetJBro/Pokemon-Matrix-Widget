# Battle engine: Pokémon Showdown's simulator for Gen 1-5 Pokémon imported from saves

Research note for `server/battles.js` and the widget's battle view. Written 2026-10-24.
Every code block marked **tested** was run on Node v26.12.0 against `@pkmn/sim@0.10.11`
(scripts in `/tmp/claude-1000/pkres/battle/pkmn/`, see [Appendix A](#appendix-a-scratch-scripts)).
The `ensureFormat`, `toShowdownSet`, `BattleRoom`, `chooseGreedy` and `spriteCandidates` blocks
were extracted from this document and re-run against the tests (`*.from-doc.test.mjs`: all pass).
Facts taken from source code cite the file; anything not verified is marked **UNVERIFIED**.

Summary of decisions:

1. Depend on **`@pkmn/sim`** (MIT, ESM, pinned). No other `@pkmn/*` package on the server; none in the browser.
2. Run each battle in a `BattleStreams.BattleStream` owned by a server-side `BattleRoom` that splits
   the output per channel with `extractChannelMessages()`, in **our own formats** registered on
   demand with `Dex.formats.extend()`, never in `genNcustomgame` (those set `debug: true`, which
   leaks exact HP to the opponent, and `trunc: Math.trunc`, which changes integer overflow behaviour).
3. Convert records with `toShowdownSet(view, gen)`: Gen 1/2 DVs -> `ivs = 2*DV` (HP DV recomputed),
   Stat Exp -> `evs = min(255, ceil(sqrt(statExp)))`; always pass `gender` and `shiny` explicitly;
   strip ability/nature/item where the generation has none; pass `happiness` and (Gen 3+) `ability`
   explicitly. This reproduces cartridge stats exactly (4,800 stats checked, 0 mismatches, section 2.4).
4. The server owns the battle and sends each socket only its channel (`p1`, `p2` or `spectator`)
   of protocol lines; it stores the per-channel logs plus the sim's input log in SQLite so that
   reconnects, late spectators and server restarts are replays.
5. The browser uses a small dependency-free protocol tracker (`shared/battle/state.js`, tested,
   handles duplicate nicknames, doubles and Team Preview) and draws HP bars, sprites and a text log
   itself. Running `@pkmn/client` on the server also works but is not worth the extra packages.
6. Practice opponent: a ~60-line greedy function that sees only its own channel and request (wins
   92-100 of 100 mirror matches against random play in every Gen 1-5 format tested).
7. Sprites: one configurable base URL that mirrors PokeAPI/sprites' `sprites/pokemon/` tree
   (`<base>/versions/generation-iii/emerald/[back/][shiny/]<dex>.png`); self-host a ~24 MB static
   subset in production, use `raw.githubusercontent.com/PokeAPI/sprites/<sha>/...` in development.
   jsDelivr's GitHub mode is **not reliable** for this repo (50 MB package limit, 403s observed).

## 1. Package choice

All numbers below were measured on 2026-10-24 with Node v26.12.0 on Linux, using fresh installs in
`/tmp/claude-1000/pkres/battle/` (scripts listed in [Appendix A](#appendix-a-scratch-scripts)).
Release dates come from `npm view <pkg> time`, repository activity from `api.github.com/repos/...`.

### 1.1 What each package is

| package | latest (date) | license | module format | runtime deps | unpacked / installed | role for us |
|---|---|---|---|---|---|---|
| `pokemon-showdown` | 0.11.11 (2026-07-28; previous 0.11.10 was 2025-02-27) | MIT | CommonJS only (`main: dist/sim/index.js`, no `exports` map) | 6 deps + 11 optional (esbuild, mysql2, preact, sockjs, sqlite3, better-sqlite3, nodemailer, pg ...) | 147 MB unpacked; `node_modules` 153 MB with `--omit=optional`, 188 MB full | the whole PS server published to npm; the sim is a subdirectory |
| `@pkmn/sim` | 0.10.11 (2026-06-18; 227 releases since 2020, roughly monthly) | MIT | dual: ESM (`build/esm/*.mjs`) + CJS, proper `exports` map | `@pkmn/sets`, `@pkmn/streams`, `ts-chacha20` | 46 MB; `node_modules` 47 MB (5 packages) | the simulator + validator + data, extracted from PS |
| `@pkmn/dex` | 0.10.11 (2026-06-18) | MIT | dual (`module` + `main`) | `@pkmn/dex-types` | 52 MB (all gens' data incl. learnsets) | data layer only; **not needed** if we use `@pkmn/sim` (it has its own `Dex`) |
| `@pkmn/data` | 0.10.11 (2026-06-18) | MIT | dual | `@pkmn/dex-types` | 0.15 MB | per-generation view over a Dex (`new Generations(Dex).get(3)`), needed by `@pkmn/client` |
| `@pkmn/protocol` | 0.7.3 (2026-05-08) | MIT | dual + `exports` | `@pkmn/types` | 0.8 MB | typed parser for protocol lines (`Protocol.parseBattleLine`), handler interfaces |
| `@pkmn/client` | 0.7.3 (2026-05-08) | MIT | dual | `@pkmn/data`, `@pkmn/protocol` | 0.5 MB | client-side battle state model (like PS client's `battle.ts`), needs a Dex |
| `@pkmn/view` | 0.7.3 (2026-05-08) | MIT | dual | `@pkmn/protocol`, `@pkmn/types` | 0.6 MB | `LogFormatter` (protocol -> English battle text, PS client wording), choice builder |
| `@pkmn/img` | 0.3.4 (2026-06-02) | MIT (code only, not the images) | dual + `exports` | none | 1.9 MB | URL/size/CSS helpers for PS-hosted sprites and the icon sheet |
| `@pkmn/randoms` | 0.10.11 (2026-06-18) | MIT | dual | `@pkmn/sim` | 7.6 MB | random-battle team generators (`gen1randombattle` ...); handy for AI opponents |

Source repos: `pkmn/ps` (MIT, last push 2026-06-18, last commit "Import
smogon/pokemon-showdown@755f4665"); `smogon/pokemon-showdown` (MIT, last push 2026-10-23, very active).
`@pkmn/sim` is regenerated from PS master by an import script, so it lags PS by weeks to a few
months; the README states the goal is to "stay as close to `sim/` from smogon/pokemon-showdown as
possible" and lists every divergence (ESM/explicit imports, Gens 1-9 canonical mods only, random
battles moved to `@pkmn/randoms`, all gens loaded eagerly, `Dex.formats.extend()` added,
`Teams` delegating to `@pkmn/sets`).

### 1.2 Things we measured

| check | `pokemon-showdown@0.11.11` | `@pkmn/sim@0.10.11` |
|---|---|---|
| Runs on Node 26.12.0 | yes (sim only; server-only native optional deps are not built: npm 11 blocks their install scripts, harmless) | yes |
| `import { BattleStreams } from '...'` from an ES module | **no**: Node only exposes `default` (`module.exports`); use `import PS from 'pokemon-showdown'` and deep path `pokemon-showdown/dist/sim/tools/random-player-ai.js` for `RandomPlayerAI` | yes, named exports: `Battle BattleStreams Dex PRNG Pokemon RandomPlayerAI RuleTable Side State Streams Tags TeamValidator Teams extractChannelMessages toID` |
| Registering our own formats | no public API: either append rules to an id (`gen3customgame@@@Sleep Clause Mod,...`, keeps `debug: true` = exact-HP leak) or poke `Dex.formats.rulesetCache` with a `Format` built from an existing instance's constructor (works, see `ps/custom-format-ps.mjs`, but it is internal API) | `Dex.formats.extend([{ name, mod, gameType, ruleset, battle }])`, documented |
| `npm audit` | 11 advisories (1 critical, 6 high) - all in server-only deps (nodemailer, sockjs, sqlite3/node-gyp chain) | 0 |
| Cold import time / RSS | 25 ms / 67 MB (lazy per-gen loading) | 201 ms / 169 MB (loads all gens) |
| 200 Gen 3 battles run concurrently (RandomPlayerAI vs RandomPlayerAI, 2v2) | 803 ms, RSS 291 MB | 605 ms, RSS 300 MB |
| Gen 1-5 singles + Gen 3-5 doubles battles to completion | yes | yes (`pkmn/all-gens-smoke.mjs`, 8 formats, 0.3 s total) |

Interpretation: a battle costs well under a millisecond of CPU per turn and a few hundred kB of
memory, so a single Node process can host hundreds of concurrent widget battles. The 170 MB baseline
of `@pkmn/sim` is the price of eager data loading and is paid once per process.

### 1.3 Recommendation: `@pkmn/sim` (pin an exact version), nothing else on the server

* It is a proper versioned ESM package with named exports, which matches our "Node 26, ES modules,
  no build step" stack; `pokemon-showdown` is CommonJS-only and drags in a web server's dependency
  tree (and its audit noise) to give us one directory.
* `Dex.formats.extend()` is the clean way to declare our widget formats (section 2.2); PS has no
  public equivalent.
* Same simulator code: the mechanics are PS's `sim/` and `data/` with only packaging changes, so
  behaviour matches play.pokemonshowdown.com for Gen 1-5 (those mods change very rarely; the lag
  behind PS master does not matter for us).
* MIT, like our project. Depending on it (not copying it) is all we need; keep its LICENSE notice in
  our third-party notices file because we redistribute it inside the Docker image.

Dependencies to add: **`@pkmn/sim` only** (exact version, e.g. `"@pkmn/sim": "0.10.11"`). Optional,
later: `@pkmn/randoms` if we want generated opponent teams (section 4). Not needed:

* `@pkmn/dex`/`@pkmn/data`: `@pkmn/sim` exports a full `Dex`; our own `shared/data/` tables cover
  the browser.
* `@pkmn/client` + `@pkmn/protocol` + `@pkmn/view`: the browser cannot load them without a bundler
  or CDN rewriting (their ESM builds use bare specifiers like `@pkmn/protocol`, and `@pkmn/client`
  needs a 50 MB Dex to resolve species/moves). Section 3.4 explains why a ~160-line protocol
  tracker in `shared/` is the better fit, and how the server could still run `@pkmn/client` if we
  ever want richer state.
* `@pkmn/img`: only builds URLs for PS's sprite server; we want a configurable base URL that also
  supports PokeAPI's per-game sprites (section 5). It is a useful reference for PS's naming rules.

Upgrade policy: bump `@pkmn/sim` deliberately and re-run the tests in `test/battle-*.test.js`
(stat reproduction, protocol tracker, smoke battle per gen); the stream protocol is described by PS
itself as "VERY NOT FINALIZED" in `sim/battle-stream.ts`'s header, so do not float the version.

## 2. Running a battle: streams, formats, teams

### 2.1 The stream API in five lines (**tested**, `pkmn/all-gens-smoke.mjs`)

The simulator is a text protocol behind an object stream. You write commands (`>start`, `>player`,
`>p1 <choice>`), it emits messages (`update`, `sideupdate`, `end`). `getPlayerStreams()` wraps one
`BattleStream` into five views: `omniscient` (write commands, read everything), `spectator`,
`p1`, `p2` (write choices for that side, read that side's view).

```js
import { BattleStreams, RandomPlayerAI } from '@pkmn/sim';

const streams = BattleStreams.getPlayerStreams(new BattleStreams.BattleStream());
void new RandomPlayerAI(streams.p1, { seed: [1, 1, 1, 1] }).start();   // bots answer |request|s
void new RandomPlayerAI(streams.p2, { seed: [2, 2, 2, 2] }).start();
void (async () => { for await (const chunk of streams.spectator) console.log(chunk); })();
void streams.omniscient.write(`>start {"formatid":"gen3customgame","seed":[3,3,3,3]}
>player p1 ${JSON.stringify({ name: 'Alice', team: teamA })}
>player p2 ${JSON.stringify({ name: 'Bob', team: teamB })}`);
```

Result of the smoke test (one battle per format, both sides random, 0.3 s total):

```
gen1customgame           9 turns  |win|A   first: |switch|p1a: Starmie|Starmie, L40|114/114
gen2customgame           7 turns  |win|A   first: |switch|p1a: Typhlosion|Typhlosion, L40, M, shiny|112/112
gen3customgame          10 turns  |win|A   first: |switch|p1a: Salamence|Salamence, L50, M|170/170
gen4customgame           8 turns  |win|B   ...
gen5customgame          12 turns  |win|B   ...
gen3doublescustomgame    3 turns  |win|B   ...   (gen4/gen5 doubles also OK)
```

For the server we do not use `getPlayerStreams()`; `BattleRoom` (section 3.3) reads the raw
`BattleStream` and splits channels itself with the exported `extractChannelMessages()`, because it
needs to store each channel's log and rewrite requests (adding `rqid`). `getPlayerStreams()` is
handy for tests and bots.

Commands we use (`sim/battle-stream.ts`, `sim/SIMULATOR.md`): `>start {formatid, seed}`,
`>player pN {name, team}`, `>pN <choice>` (choice grammar in `sim/SIM-PROTOCOL.md` "Possible
choices": `move 2`, `move 1 2` = move 1 at foe slot 2 in doubles, `switch 3`, `team 213`,
`default`, `undo`, `pass`; doubles joins two with `, `), `>forcelose pN` (forfeit/timeout loss),
`>forcetie`, `>forcewin pN`. `>requestlog` returns the input log, but in the same process
`stream.battle.inputLog` is simpler.

**Gotchas found while testing**

* An **unknown format id does not throw**: `new Battle({ formatid: 'gen4nosuchformat' })` silently
  builds a Gen 9 battle with `format.exists === false`. Always check
  `Dex.formats.get(id).exists` (our `ensureFormat()` guarantees it).
* `team` is **not validated** by `>player` ("`team` will not be validated! Use the team validator
  first", `sim/SIMULATOR.md`). The battle happily gives a Gen 1 Gyarados Intimidate if the set
  says so (`pkmn/gen12-leaks.mjs` printed `|-ability|p1a: Gyarados|Intimidate|boost` in
  `gen1customgame`). Our converter must strip what a generation does not have.
* The stream treats everything after `>p1 ` as the player's choice, but a raw `\n` in an untrusted
  string would start a new command line (`>forcewin p1`). `getPlayerStreams().p1.write` prefixes
  every line with `>p1 `; when writing to the raw stream ourselves we whitelist the choice
  (section 3.3, tested).

### 2.2 Formats: do not use `genNcustomgame`, register our own

The built-in `[Gen N] Custom Game` formats (`config/formats.ts`) are meant for testing:

| property | gen1-4 customgame | gen5customgame | consequence for us |
|---|---|---|---|
| `debug: true` | yes | yes | `reportExactHP = !!format.debug` (`sim/battle.ts`): **exact HP of every Pokémon is sent to the opponent and spectators**, overriding HP Percentage Mod; debug lines too |
| `battle: { trunc: Math.trunc }` | yes (not gen3 doubles) | yes | replaces the sim's 16/32-bit truncation, so integer overflow behaviour differs from the cartridge (only matters at extreme stats, but no reason to accept it) |
| ruleset | `Cancel Mod`, `Max Team Size = 24`, `Max Level = 9999`, (+`HP Percentage Mod` gen1-3, `Desync Clause Mod` gen1) | adds `Team Preview` | no clauses, no level limit |

`forfeit-timer.mjs` shows the leak: a spectator of `gen4customgame` sees `|switch|p2a: Pidgey|Pidgey, L20, F|52/52`.

`@pkmn/sim` adds `Dex.formats.extend()`. A format is plain data: `name` (at most 50 characters,
`[Gen N] ...`), `mod: 'genN'`, `gameType: 'singles' | 'doubles'`, `ruleset: [...]`. Its id is
`toID(name)`. Two traps (both **tested**):

* `extend()` throws on a duplicate id, so check `Dex.formats.get(id).exists` first.
* PS's per-battle custom rules (`formatid@@@Rule A,Rule B`) work for built-in formats but **not**
  for extended ones in 0.10.11: `gen4quirk@@@Sleep Clause Mod` resolves to a non-existent Gen 9
  format (`dex-formats.ts` only looks for `@@@` bases in `Dex.data.Rulesets`, while `extend()`
  stores formats in `rulesetCache`). So we register **one format per option combination**, named
  deterministically, on demand. The same options always give the same id, which matters for
  replaying stored input logs after a restart (section 3.5).

Rules are of two kinds (`effectType` in `data/rulesets.ts`): **battle rules** act inside the
simulation; **validator rules** only act when `TeamValidator` runs. Relevant ones for Gen 1-5:

| option | Showdown rule | kind | notes |
|---|---|---|---|
| sleep | `Sleep Clause Mod` | battle | "Prevents players from putting more than one of their opponent's Pokémon to sleep at a time" |
| freeze | `Freeze Clause Mod` | battle | Gen 1-2 convention (freeze never thaws in Gen 1) |
| desync | `Desync Clause Mod` | battle | Gen 1: "If a desync would happen, the move fails instead" (Bide, Counter, Psywave). We always add it in Gen 1 |
| endless | `Endless Battle Clause` | battle | stops unwinnable loops |
| percent | `HP Percentage Mod` | battle | opponents/spectators see HP as `NN/100`; without it Gen 1-6 battles report cartridge-style **48-pixel** HP (`24/48`, `pokemon.ts getHealth`) |
| preview | `Team Preview` | battle | did not exist on Gen 1-4 cartridges; Gen 5 link battles had it |
| switchprio | `Switch Priority Clause Mod` | battle | Gen 3 doubles: without it player 1's Pokémon switch first, as in Emerald link battles (rule `desc`) |
| species | `Species Clause` | validator | one of each species (National Dex number) |
| item | `Item Clause = 1` | validator | needs the `= 1` value (throws otherwise, found by test) |
| ohko | `OHKO Clause` | validator | bans Fissure/Horn Drill/Guillotine/Sheer Cold |
| evasion | `Evasion Moves Clause` | validator | bans Double Team/Minimize |
| level cap | `Adjust Level Down = N` | validator | **only the validator applies it** (it rewrites `set.level`); the battle reads `set.adjustLevel ?? set.level` (`pokemon.ts`). Without validation the Pokémon keeps its real level (tested: 78 stays 78) |
| pick N of 6 | `Picked Team Size = N` | battle (+ validator: implies "bring at least N") | needs Team Preview |

Do **not** put `Obtainable`/`Standard` in our formats: they check learnsets and event data, and
can reject legitimate cartridge Pokémon (trade-back moves, Pomeg glitch, event distributions -
PS has special clauses for some of these, which says how fiddly it is). Our own record
validation (`pkN.validate`) is the authority; the PS validator only enforces team-level clauses.
Note the corollary: without `Obtainable Misc` the validator does **not** check Gen 2 gender/shiny
against DVs or the HP DV (tested: wrong gender passes), so our converter must get them right.

`ensureFormat()` (**tested**, `pkmn/widget-formats.mjs`):

```js
import { Dex, TeamValidator } from '@pkmn/sim';

export const RULES = {
  sleep:      { rule: 'Sleep Clause Mod',           code: 'Slp' },
  freeze:     { rule: 'Freeze Clause Mod',          code: 'Frz' },
  desync:     { rule: 'Desync Clause Mod',          code: 'Dsc' },
  endless:    { rule: 'Endless Battle Clause',      code: 'End' },
  percent:    { rule: 'HP Percentage Mod',          code: 'Pct' },
  preview:    { rule: 'Team Preview',               code: 'Prv' },
  switchprio: { rule: 'Switch Priority Clause Mod', code: 'Swp' },
  species:    { rule: 'Species Clause',             code: 'Spc' },
  item:       { rule: 'Item Clause = 1',            code: 'Itm' },
  ohko:       { rule: 'OHKO Clause',                code: 'Ohk' },
  evasion:    { rule: 'Evasion Moves Clause',       code: 'Eva' },
};

/** -> format id for `>start`; registers "[Gen 3] W Dbl L50 6v4 ItmPctPrvSpc"-style formats once. */
export function ensureFormat({ gen, doubles = false, levelCap = null, teamSize = 6, pick = null, rules = [] }) {
  if (![1, 2, 3, 4, 5].includes(gen)) throw new RangeError(`gen ${gen}`);
  if (doubles && gen < 3) throw new RangeError('Double battles exist from Gen 3 on');
  const keys = [...new Set(rules)].filter(k => RULES[k]).sort();
  if (pick && !keys.includes('preview')) keys.push('preview'), keys.sort();
  const ruleset = ['Cancel Mod', `Max Team Size = ${teamSize}`, 'Max Level = 100', 'Default Level = 100',
    ...keys.map(k => RULES[k].rule)];
  if (gen === 1 && !keys.includes('desync')) ruleset.push('Desync Clause Mod');
  if (levelCap) ruleset.push(`Adjust Level Down = ${levelCap}`);
  if (pick) ruleset.push(`Picked Team Size = ${pick}`);
  const name = `[Gen ${gen}] W${doubles ? ' Dbl' : ''}${levelCap ? ` L${levelCap}` : ''}${pick ? ` ${teamSize}v${pick}` : ''}` +
    (keys.length ? ' ' + keys.map(k => RULES[k].code).join('') : '');
  if (name.length > 50) throw new Error('format name too long');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!Dex.formats.get(id).exists) {
    Dex.formats.extend([{ section: 'Matrix Widget', name, mod: `gen${gen}`, gameType: doubles ? 'doubles' : 'singles',
      ruleset, challengeShow: false, searchShow: false, tournamentShow: false }]);
  }
  return id;
}

/** null when OK, else messages. Mutates sets (Adjust Level Down sets set.level). Run on a copy you then use. */
export const checkTeam = (formatid, team) => new TeamValidator(formatid).validateTeam(team);
```

Test output: Gen 1-5 singles and Gen 3-5 doubles formats register and resolve; Gen 2 doubles is
refused; `Species Clause` and `Item Clause = 1` violations are reported
(`'You are limited to 1 of each item by Item Clause.'`); `Adjust Level Down = 50` turns levels
`[78, 62]` into `[50, 50]`; a Mudkip with Spore passes (no learnset checks, as intended).

Suggested presets for the challenge dialog (all also allow the level cap and team size options):

* **Cartridge link battle**: no clauses, real levels, pixel HP (Gen 1: Desync Clause Mod is still
  forced; it only replaces a cartridge desync with a move failure).
* **Smogon-style**: `sleep`, `species`, `ohko`, `evasion`, `endless`, `percent` (+ `freeze` in Gen 1-2, `switchprio` in Gen 3).
* **Battle Tower / VGC-like doubles (Gen 3-5)**: `doubles`, `levelCap: 50`, `species`, `item`,
  `pick: 4` (`preview` implied).

### 2.3 PokemonSet fields and how each is filled from a MonView

`PokemonSet` (`@pkmn/types`): `name, species, item, ability, moves, nature, gender, evs, ivs,
level, shiny?, happiness?, pokeball?, hpType?` (+ Gen 8/9 fields we never set). What the
**battle** does with each when building a `Pokemon` (`sim/pokemon.ts` constructor, read in the
0.10.11 build), and what we pass:

| field | battle behaviour if missing / odd | we pass |
|---|---|---|
| `species` | must exist, else throws `Unidentified species` | Dex name from National Dex number + form (`Unown-B`, `Deoxys-Speed`, `Rotom-Wash`, `Giratina-Origin`, `Basculin-Blue-Striped` ...). For species that exist in the gen, all 151/251/386/493/649 base species resolve (tested) |
| `name` | empty or equal to species -> base species name; truncated to 20 chars | nickname only if `isNicknamed`, cleaned of `\| , [ ]`, max 18; duplicates in a team numbered ("Pidgey 2") because the protocol identifies Pokémon by `p1a: NAME` |
| `level` | `set.adjustLevel \|\| set.level \|\| 100`, clamped 1..9999 | `view.level` (validator applies level caps) |
| `gender` | `set.gender \|\| species.gender \|\| random M/F` - **random if omitted** (6 seeds gave `FFFMMM` for a Ralts) | Gen 1: `''`; Gen 2: from Atk DV (MonView already computes it); Gen 3+: from PID; species with fixed gender: `''` |
| `shiny` | false | Gen 1: false; Gen 2: from DVs; Gen 3+: from PID/TID/SID (MonView). Purely cosmetic in battle (sprite + `shiny` in details) |
| `ivs` | default 31 each; clamped 0..31; **Gen 1-2: `&= 30`** (DV = iv/2) | Gen 1-2: `2*DV` with HP DV recomputed (2.4); Gen 3+: `view.ivs` |
| `evs` | default **0**; clamped 0..255 | Gen 1-2: from Stat Exp (2.4); Gen 3+: `view.evs` |
| `nature` | '' = neutral | Gen 3+: `view.nature`; Gen 1-2: '' |
| `ability` | toID; **'' = no ability at all in Gen 3+** (a Rattata without ability has none) | Gen 3+: `view.ability` (always pass it); Gen 1-2: '' |
| `item` | toID; unknown ids are harmless (no effect) | Gen 2+: item name if `Dex.forGen(gen).items.get(name)` exists for that gen, else dropped with a note. Items that do not exist in the sim are battle-irrelevant (tested lists: Gen 2 Amulet Coin, Cleanse Tag, Smoke Ball, Everstone, Exp.Share, Lucky Egg, mail; Gen 3 Soothe Bell, flutes, mail); all Gen 2 battle items (Miracle Berry, PSNCureBerry, BrightPowder, Berserk Gene, Polkadot Bow ...) resolve |
| `moves` | ids; unknown ids skipped; **max PP assumed (3 PP Ups) for every move** | by move **number**: Gen 1-5 store move numbers 1..165/251/354/467/559, and in each gen's Dex these map 1:1 to ids except Hidden Power (17 typed aliases share #237 - skip ids `hiddenpower<type>`) (tested) |
| `happiness` | **255 if omitted** (Frustration would be 1 BP, Return 102) | Gen 2+: `view.friendship` |
| `hpType` | derived from ivs (`dex.getHiddenPower`, Gen 2 formula from DVs, Gen 3-5 formula from IVs, power 30-70) | leave unset so the cartridge type/power follow from the real IVs |
| `pokeball` | cosmetic | optional |

Forms: Arceus with a Plate needs no form in `species` (types follow the Plate - tested
`Arceus` + Flame Plate -> Fire), but pass the form anyway for sprites. `Giratina-Origin`, `Unown-B`,
`Deoxys-Speed` work as species names (tested). Battle-only forms (Castform weather, Cherrim,
Darmanitan-Zen, Meloetta-Pirouette) must be passed as the base form.

### 2.4 Gen 1/2: DVs and Stat Exp -> Showdown ivs/evs (verified against the sim and the cartridge code)

How the sim represents Game Boy stats (from `sim/pokemon.ts`, `sim/battle.ts statModify`,
`sim/dex.ts getHiddenPower`, `sim/team-validator.ts`):

* A DV `d` (0-15) is stored as IV `2d`; the battle forces `ivs[stat] &= 30` in Gen 1-2.
* The HP DV is **not** derived by the battle: it uses `ivs.hp` as given. Only the validator checks
  `HP DV = (Atk&1)<<3 | (Def&1)<<2 | (Spe&1)<<1 | (Spc&1)`. So we compute it.
* Special: `spa` and `spd` both use the Special DV (`ivs.spa === ivs.spd`) and the single Special
  Stat Exp (`evs.spa === evs.spd`) - Gen 1 has one Special stat (the Gen 1 Dex has
  `spa === spd` base stats, e.g. Mewtwo 154/154); Gen 2 splits the base stat but keeps one DV and one
  Stat Exp for both (pokecrystal `CalcMonStatC` reads the same DV/Stat Exp for `STAT_SATK` and `STAT_SDEF`).
* The formula is the modern one, `floor((2*base + iv + floor(ev/4)) * L/100) + 5` (HP: `+ L + 10`),
  with no nature in Gen 1-2. With `iv = 2*DV` this equals the cartridge's `(base + DV) * 2`.

Cartridge formula, from pret disassemblies (described, not copied): pokered `home/move_mon.asm`
`CalcStat` and pokecrystal `engine/pokemon/move_mon.asm` `CalcMonStatC` +
`engine/math/get_square_root.asm` compute `b` = the smallest integer 1..255 with `b*b >= StatExp`
(the loop stops at 255, so Stat Exp above 254² = 64516 still gives 255), then
`stat = floor(((base + DV) * 2 + floor(b / 4)) * L / 100) + 5`, HP `+ L + 10`, capped at 999.

Therefore the mapping is

```
ivs  = { hp: 2*hpDV, atk: 2*atkDV, def: 2*defDV, spa: 2*spcDV, spd: 2*spcDV, spe: 2*speDV }
evs  = { hp: e(StatExp.hp), atk: e(.atk), def: e(.def), spa: e(.spc), spd: e(.spc), spe: e(.spe) }
e(x) = min(255, ceil(sqrt(x)))        // sim then uses floor(e/4), the cartridge floor(b/4); e == b
```

`e(0) = 0` while the cartridge's `b` is 1 for Stat Exp 0, but `floor(1/4) = floor(0/4) = 0`, so
the result is identical.

**Verification** (`pkmn/gen12-stats-v2.mjs`, **tested**): 800 random Pokémon (random species,
level 1-100, DVs 0-15, Stat Exp including the edge values 0, 1, 64516, 64517, 65025, 65026,
65535) built in the sim with this mapping: **4,800 stats checked, 0 mismatches** against the
cartridge formula above. (The interrupted run's first version reported 300 mismatches at Stat
Exp >= 65026; that was a bug in the *test's* reference formula, which forgot the 255 cap the
cartridge loop has. With the cap the sim and cartridge agree.)

Gen 3-5: the sim's formula is the cartridge formula (natures with 16-bit truncation); the
textbook example Garchomp L78 Adamant, IVs 24/12/30/16/23/5, EVs 74/190/91/48/84/23 gives
289/278/193/135/171/171 in both `gen4` and `gen5` (**tested**; the numbers are the well-known
Bulbapedia "Stat" article example - the page returned 403 to our fetcher, so the attribution is
UNVERIFIED, but HP/Atk/Def were re-derived by hand). Shedinja's 1 HP comes from the Dex
(`maxHP: 1`).

So **yes, the sim reproduces the imported Pokémon's actual stats** from base stats + ivs/evs/level/nature,
because Home records are box structures whose stats the game itself recomputes on withdrawal with
the same formulas. An optional exact-stat override (format `battle: { statModify }` that returns
`set.stats[stat]`) works (`pkmn/custom-format.mjs`), but is unnecessary and would diverge from what
the game shows after withdrawing; do not ship it.

Gen 2 gender and shininess (from pokecrystal `engine/pokemon/mon_stats.asm` `GetGender`,
`engine/gfx/color.asm` `CheckShininess` and `constants/pokemon_data_constants.asm`):

* Gender: the byte `AtkDV<<4 | SpeDV` is compared with the species' gender ratio byte
  (12.5% F = 31, 25% = 63, 50% = 127, 75% = 191); female if the byte is <= the ratio. Because the
  ratios are all `16k - 1`, only the Atk DV matters: female iff `AtkDV < 16 * femaleFraction`
  (thresholds 2, 4, 8, 12). PS's validator uses exactly `atkDV >= genderRatio.F * 16 ? 'M' : 'F'`.
* Shiny: Def = Spe = Spc = 10 and the Atk DV has bit 1 set (`SHINY_ATK_MASK`), i.e. Atk in
  {2, 3, 6, 7, 10, 11, 14, 15}. PS's validator has the same rule (`atkDV % 4 >= 2`).
* Neither is applied by the battle, so pass both explicitly (the battle otherwise picks a random gender).

Gen 1-2 specifics in Showdown: no abilities (`'No Ability'`) and no natures; the Gen 1 Dex only
knows nine non-held items (balls and evolution stones; `Leftovers` is `isNonstandard: 'Future'`),
and the validator strips `shiny` in Gen 1; Gen 2 items are the GSC set. The battle does not reject
items, abilities or natures a generation lacks, so the converter strips them.

### 2.5 The converter (**tested**, `pkmn/to-showdown-set.mjs` + `.test.mjs`)

Implements `toShowdownSet(view, mechanicsGen)` from docs/ARCHITECTURE.md. Server-side it can use
`@pkmn/sim`'s `Dex` for ids; in the browser the same logic can use `shared/data` tables.

```js
import { Dex } from '@pkmn/sim';

const moveIdByNum = new Map();
function moveId(gen, num) {           // Gen 1-5 move numbers -> Showdown ids, per gen
  if (!moveIdByNum.has(gen)) {
    const m = new Map();
    for (const mv of Dex.forGen(gen).moves.all())
      if (mv.num > 0 && !mv.isNonstandard && !(mv.id.startsWith('hiddenpower') && mv.id !== 'hiddenpower')) m.set(mv.num, mv.id);
    moveIdByNum.set(gen, m);
  }
  return moveIdByNum.get(gen).get(num);
}

export function cleanName(s) { return String(s ?? '').replace(/[|,[\]‮\r\n]+/g, ' ').trim().slice(0, 18); }

export function toShowdownSet(view, gen) {
  const notes = [];
  if (view.isEgg) throw new Error('Eggs cannot battle');
  const era = (g) => (g <= 2 ? 'gb' : 'gba+');
  if (view.gen > gen || era(view.gen) !== era(gen)) throw new Error(`A Gen ${view.gen} Pokémon must be converted before a Gen ${gen} battle`);
  const dex = Dex.forGen(gen);
  const species = dex.species.get(view.formName ? `${view.speciesName}-${view.formName}` : view.speciesName);
  const base = dex.species.get(view.speciesName);
  const sp = species.exists && species.gen <= gen ? species : base;
  if (!sp.exists || sp.gen > gen) throw new Error(`${view.speciesName} does not exist in Gen ${gen}`);
  const moves = view.moves.map(m => moveId(gen, m.id)).filter(Boolean);
  if (moves.length !== view.moves.length) throw new Error(`${view.nickname} knows a move that does not exist in Gen ${gen}`);
  if (!moves.length) throw new Error(`${view.nickname} has no moves`);
  const set = {
    name: view.isNicknamed ? cleanName(view.nickname) : '',
    species: sp.name, level: view.level, moves,
    gender: sp.gender ? '' : (view.gender ?? ''),
    shiny: gen >= 2 && !!view.shiny,
  };
  if (gen <= 2) {
    const d = view.dvs, se = view.statExp;
    const hpDV = ((d.atk & 1) << 3) | ((d.def & 1) << 2) | ((d.spe & 1) << 1) | (d.spc & 1);
    const ev = (x) => Math.min(255, Math.ceil(Math.sqrt(x)));
    set.ivs = { hp: 2 * hpDV, atk: 2 * d.atk, def: 2 * d.def, spa: 2 * d.spc, spd: 2 * d.spc, spe: 2 * d.spe };
    set.evs = { hp: ev(se.hp), atk: ev(se.atk), def: ev(se.def), spa: ev(se.spc), spd: ev(se.spc), spe: ev(se.spe) };
    set.ability = ''; set.nature = '';
    if (gen === 1) set.gender = '';
  } else {
    set.ivs = { ...view.ivs }; set.evs = { ...view.evs };
    set.nature = view.nature; set.ability = view.ability;
  }
  if (gen >= 2) {
    set.happiness = view.friendship;
    if (view.heldItem) {
      const item = dex.items.get(view.heldItem);
      if (item.exists && item.gen <= gen) set.item = item.name;
      else notes.push(`${view.heldItem} has no effect in battle and is left out`);
    }
  }
  return { set, notes };
}

/** The protocol names Pokémon "p1a: NAME", so make names unique within a team. */
export function uniqueNames(sets) {
  const seen = new Map();
  for (const s of sets) {
    const shown = s.name || Dex.species.get(s.species).baseSpecies;
    const n = (seen.get(shown) ?? 0) + 1; seen.set(shown, n);
    if (n > 1) s.name = `${shown.slice(0, 15)} ${n}`;
  }
  return sets;
}
```

Tests: a Gen 2 Gyarados (Atk/Def/Spe/Spc DV 10, Stat Exp 9000/65535/3/64517/0, Mystic Water)
gets exactly the cartridge stats, gender M, shiny, item kept; a Gen 1 view never gets gender/item/
ability; a Gen 3 Ralts gets Trace + Modest (SpA matches the hand formula) and its Mach Bike is
dropped with a note; a Gen 1 record in a Gen 3 battle and a Lucario in Gen 3 are refused; names
`A|B,C[D]` -> `A B C D`, two Pidgey -> `''`, `Pidgey 2`.

Cross-generation battles: Gen 1 <-> Gen 2 records can battle under either gen's rules if
representable (a Gen 2-only species/move/item cannot be in a Gen 1 battle: the converter throws
for species/moves; items are dropped in Gen 1). Gen 3 -> 4 -> 5 records can battle in a later gen
directly (same IV/EV/nature system). Gen 1/2 -> Gen 3+ requires `convert()` first (the unofficial
VC-style conversion), never an implicit mapping inside the battle code.

### 2.6 Cartridge vs Showdown: what to tell users

Mechanics come from PS's per-generation mods (`data/mods/gen1` ... `gen5`), which implement
cartridge behaviour including well-known quirks (e.g. Gen 1's 1/256 miss chance for 100%-accurate
moves is in `mods/gen1/scripts.ts`, with the hint "In Gen 1, moves with 100% accuracy can still
miss 1/256 of the time."). Differences a player can notice:

* **Everything starts fresh**: full HP, no status, **every move at maximum PP as if it had 3 PP
  Ups** (the sim hard-codes `ppUps = 3`; tested: Gen 2 Pikachu Thunder Shock 48, Growl 61).
  Nothing that happens in a widget battle changes the stored Pokémon: no Exp., EVs/Stat Exp,
  friendship, PP use, Pokérus or level-ups (battles never write records).
* **Clauses** (Sleep/Freeze/Species/...) are Smogon conventions; cartridge link battles had none.
  "Cartridge" preset = no clauses.
* **Gen 1 desync moves**: with Desync Clause Mod, Bide/Counter/Psywave situations that would desync
  two Game Boys make the move fail instead.
* **Level caps** recompute stats at the capped level (like Battle Tower/Stadium), the stored
  Pokémon keeps its level.
* **Team Preview** and **pick N of 6** only existed from Gen 5 (and Stadium); optional.
* **HP display**: opponents see percentages with `HP Percentage Mod`, otherwise the 48-pixel bar
  value like on the cartridge.
* **Gen 3 double switches**: default PS behaviour matches Emerald (player 1 first); offer
  `switchprio` for speed order.
* **RNG**: the server seeds every battle (stored), so no RNG manipulation; it is still
  per-battle reproducible for replays.
* **Gen 4**: one mechanics set for DPPt/HGSS (PS `gen4` mod); **Gen 5**: one set for BW/B2W2.
  Small version differences (UNVERIFIED which ones, if any, matter for Gen 4) are not modelled.
* Items with no battle effect are left out of the battle team (the stored Pokémon keeps them).
* Gen 1 glitch Pokémon / levels above 100 cannot battle (`Max Level = 100`; the converter
  should refuse species not in the Dex).

## 3. Protocol, hidden information and the renderer

### 3.1 What the simulator emits

`BattleStream` emits three message types (`sim/SIMULATOR.md`, "Reading from the simulator"):

* `update\n<lines>` - battle log for everyone. It may contain **`|split|pN`** blocks: the line
  after `|split|p1` is the *secret* version (exact HP, for p1 and omniscient observers), the line
  after that is the *public* version (for p2 and spectators; may be empty).
* `sideupdate\npN\n<lines>` - for one player only: `|request|{json}` and
  `|error|[Invalid choice] ...` / `|error|[Unavailable choice] ...` (the latter is followed by a new
  `|request|`). `|split|` never appears here.
* `end\n<json>` - summary at the end (we ignore it; `|win|`/`|tie|` already came in an `update`).

`extractChannelMessages(data, [-1, 0, 1, 2])` (exported by `@pkmn/sim`) resolves the split blocks:
channel `-1` = omniscient (all secrets), `0` = spectator (all public), `1`/`2` = that player
(own secrets, foe public).

Raw output of a widget Gen 3 format (`pkmn/protocol-channels.mjs`, **tested**, abridged):

```
update
|player|p1|Alice||          |gen|3          |tier|[Gen 3] W PctSlp
|rule|HP Percentage Mod: HP is shown in percentages
|teamsize|p1|2   |teamsize|p2|1   |start
|split|p1
|switch|p1a: MUDKIP|Swampert, L55, M|192/192      <- secret (p1, omniscient)
|switch|p1a: MUDKIP|Swampert, L55, M|100/100      <- public (p2, spectators)
|split|p2
|switch|p2a: GARDY|Gardevoir, L52, F, shiny|148/148
|switch|p2a: GARDY|Gardevoir, L52, F, shiny|100/100
|turn|1
sideupdate
p1
|request|{"active":[{"moves":[{"move":"Surf","id":"surf","pp":24,"maxpp":24,...}]}],"side":{...}}
...
update
|move|p2a: GARDY|Psychic|p1a: MUDKIP
|split|p1
|-damage|p1a: MUDKIP|114/192
|-damage|p1a: MUDKIP|60/100
|move|p1a: MUDKIP|Surf|p2a: GARDY
|split|p2
|-damage|p2a: GARDY|94/148
|-damage|p2a: GARDY|64/100
|split|p1
|-heal|p1a: MUDKIP|126/192|[from] item: Leftovers
|-heal|p1a: MUDKIP|66/100|[from] item: Leftovers
|upkeep
|turn|2
```

### 3.2 Who sees what (tested with the same battle)

| line | omniscient | spectator | p1 | p2 |
|---|---|---|---|---|
| `\|switch\|p1a: MUDKIP\|Swampert, L55, M\|...` | `192/192` | `100/100` | `192/192` | `100/100` |
| `\|-damage\|p2a: GARDY\|...` | `94/148` | `64/100` | `64/100` | `94/148` |
| without `HP Percentage Mod` (pixels) | `94/148` | `30/48` | `30/48` | `94/148` |
| `\|request\|{...}` (moves, PP, own team's exact stats, items, abilities) | - | - | own only | own only |
| `\|error\|[Invalid choice] Can't move: Your Rattata doesn't have a move 9` | - | - | sender only | - |
| everything else (`\|move\|`, `\|faint\|`, `\|-status\|`, `\|-boost\|`, `\|-weather\|`, `\|win\|`, `\|turn\|`, ...) | all | all | all | all |

Hidden information beyond HP: the foe's moves, item and ability are only revealed when used
(`|move|`, `|-item|`/`|-enditem|`, `|-ability|`); unrevealed bench Pokémon are unknown unless
Team Preview is on (tested: `|poke|p1|Gardevoir, L52, F|item` reveals species, level, gender and
*whether* an item is held, not the nickname, shininess or which item; Arceus appears as
`Arceus-*`). The server must therefore **never send the omniscient channel or
another player's channel/requests to a client**, and finished battles' public replays should use
the spectator log. The `|request|` JSON contains the player's full team (stats, moves, items) -
fine for its owner only.

Request shapes the UI must handle (from SIM-PROTOCOL.md "Choice requests" and the tests):
`{ wait: true }` (nothing to do, e.g. the foe must replace a fainted Pokémon), `{ teamPreview: true }`
(answer `team 213...`), `{ forceSwitch: [true, false] }` (answer `switch N` / `pass` per slot),
and the normal `{ active: [{ moves: [{move, id, pp, maxpp, target, disabled}], trapped?,
maybeTrapped? }], side: { name, id, pokemon: [{ ident, details, condition, active, stats, moves,
baseAbility, item }] } }`. Doubles requests have two `active` entries and moves need a target for
`normal`/`any`/`adjacentFoe` targets (`move 1 2` = foe slot 2; `-1`/`-2` = ally slots).

### 3.3 Server side: `BattleRoom` (core of `server/battles.js`, **tested**)

Responsibilities: own the `BattleStream`; split channels; keep `logs.{omniscient,spectator,p1,p2}`;
stamp each request with an `rqid` and a `deadline`; accept only whitelisted choices for the
current `rqid`; turn timer (auto-choose `default`, then forfeit); `undo` (Cancel Mod);
`snapshot(role)` for reconnects and late spectators; persist the input log so the battle can be
rebuilt after a restart; survive a sim crash.

```js
import { BattleStreams, extractChannelMessages } from '@pkmn/sim';

const CHANNEL = { omniscient: -1, spectator: 0, p1: 1, p2: 2 };

export class BattleRoom {
  /**
   * o.formatid  from ensureFormat()          o.players  { p1: {name, team}, p2: {name, team} } (validated)
   * o.seed      [a, b, c, d] (store it)      o.send(channel, lines)  channel = 'p1' | 'p2' | 'spectator'
   * o.persist(line)  append to SQLite        o.timer { turnSeconds = 90, autoChooses = 2 }
   * o.inputLog  stored lines, when restoring after a restart
   */
  constructor(o) {
    this.send = o.send; this.persist = o.persist ?? (() => {});
    this.logs = { omniscient: [], spectator: [], p1: [], p2: [] };
    this.requests = { p1: null, p2: null };     // { rqid, request, choice }
    this.rqid = 0; this.ended = false; this.winner = undefined;
    this.timerCfg = { turnSeconds: 90, autoChooses: 2, ...o.timer };
    this.timers = { p1: null, p2: null }; this.timeouts = { p1: 0, p2: 0 };
    this.stream = new BattleStreams.BattleStream({ keepAlive: false });
    this.restoring = !!o.inputLog;
    this.pump = this.#readLoop();
    const lines = o.inputLog ?? [
      `>start ${JSON.stringify({ formatid: o.formatid, seed: o.seed })}`,
      `>player p1 ${JSON.stringify(o.players.p1)}`,
      `>player p2 ${JSON.stringify(o.players.p2)}`,
    ];
    for (const l of lines) this.#write(l, !o.inputLog);
    this.restoring = false;
  }
  get battle() { return this.stream.battle; } // inputLog, sides, turn (same process)
  #write(line, persist = true) { if (persist) this.persist(line); void this.stream.write(line); }
  async #readLoop() {
    try { await this.#read(); } catch (err) { // a sim crash must not take the server down
      this.ended = true; this.winner = null; this.#stopTimers();
      this.#broadcast([`|-message|The battle crashed and was ended (${String(err.message).slice(0, 100)}).`, '|tie']);
      this.onCrash?.(err);
    }
  }
  async #read() {
    for await (const chunk of this.stream) {
      const nl = chunk.indexOf('\n');
      const type = chunk.slice(0, nl), data = chunk.slice(nl + 1);
      if (type === 'update') {
        const ch = extractChannelMessages(data, [-1, 0, 1, 2]);
        for (const [name, id] of Object.entries(CHANNEL)) {
          this.logs[name].push(...ch[id]);
          if (name !== 'omniscient') this.send(name, ch[id]);
        }
        for (const l of ch[-1]) if (l.startsWith('|win|') || l === '|tie') { this.ended = true; this.winner = l === '|tie' ? null : l.slice(5); this.#stopTimers(); }
      } else if (type === 'sideupdate') {
        const side = data.slice(0, 2), msg = data.slice(3);
        if (msg.startsWith('|request|')) {
          const request = JSON.parse(msg.slice(9));
          request.rqid = ++this.rqid;
          if (!request.wait && this.timerCfg.turnSeconds && !this.restoring) request.deadline = Date.now() + this.timerCfg.turnSeconds * 1000;
          this.requests[side] = { rqid: this.rqid, request, choice: '' };
          this.send(side, [`|request|${JSON.stringify(request)}`]);
          if (!request.wait) this.#startTimer(side);
        } else { // |error|[Invalid choice] -> that player only; let them choose again (as PS does)
          if (msg.startsWith('|error|') && this.requests[side]) { this.requests[side].choice = ''; this.#startTimer(side); }
          this.send(side, [msg]);
        }
      }
    }
  }
  /** A player's choice from the widget; returns null or an error string. `choice` is untrusted. */
  choose(side, choice, rqid) {
    const r = this.requests[side];
    if (this.ended || !r || r.request.wait) return 'no request pending';
    if (rqid !== r.rqid) return 'stale request';
    choice = String(choice).trim();
    // clients send slot numbers only, so a strict whitelist is possible (no newlines, no '>')
    if (choice.length > 100 || !/^(move|switch|team|default|pass|undo)\b[a-z0-9 ,+-]*$/i.test(choice)) return 'bad choice';
    if (choice === 'undo') { if (!r.choice) return 'nothing to undo'; r.choice = ''; this.#startTimer(side); }
    else { r.choice = choice; this.#stopTimer(side); this.timeouts[side] = 0; }
    this.#write(`>${side} ${choice}`);
    return null;
  }
  forfeit(side) { if (!this.ended) this.#write(`>forcelose ${side}`); }
  /** Everything a (re)connecting socket needs: its channel's log + the pending request. */
  snapshot(role) {
    const out = [...this.logs[role === 'p1' || role === 'p2' ? role : 'spectator']];
    const r = this.requests[role];
    if (r && !this.ended) { out.push(`|request|${JSON.stringify(r.request)}`); if (r.choice) out.push(`|sentchoice|${r.choice}`); }
    return out;
  }
  #startTimer(side) {
    if (this.restoring || !this.timerCfg.turnSeconds) return;
    this.#stopTimer(side);
    this.timers[side] = setTimeout(() => {
      this.timers[side] = null;
      if (++this.timeouts[side] > this.timerCfg.autoChooses) return this.forfeit(side);
      this.#broadcast([`|inactive|${this.battle.sides[side === 'p1' ? 0 : 1].name} ran out of time; a move was chosen automatically.`]);
      this.#write(`>${side} default`);
    }, this.timerCfg.turnSeconds * 1000);
    this.timers[side].unref?.();
  }
  #broadcast(lines) { // server-made lines go to every channel and into the logs
    for (const name of Object.keys(CHANNEL)) { this.logs[name].push(...lines); if (name !== 'omniscient') this.send(name, lines); }
  }
  #stopTimer(side) { clearTimeout(this.timers[side]); this.timers[side] = null; }
  #stopTimers() { this.#stopTimer('p1'); this.#stopTimer('p2'); }
}
```

Tests (`pkmn/battle-room.test.mjs`, 3 tests pass): a full 2v2 Gen 3 battle driven through
`choose()`; a stale `rqid` is rejected; `'move 1\n>forcewin p1'` is rejected as `bad choice`;
p1 receives exact HP for its own Pokémon while every spectator `|switch|` shows `/100`; a late
spectator replaying `snapshot('spectator')` reaches the same winner/turn as a live one; a room
rebuilt from the persisted input log (19 lines) produces an **identical omniscient log** (ignoring
`|t:|` timestamps) and winner; with a 20 ms timer and a silent p1 there are two auto-chosen turns
(`|inactive|...` broadcast, requests carry `deadline`) and then p1 forfeits; an invalid `move 9`
returns `|error|[Invalid choice]` to p1 only; `undo` before the foe chooses works; forfeit makes Bob win.

Wiring into the WebSocket layer (sketch, untested glue):

```js
// battles: Map<battleId, { room, players: { p1: userId, p2: userId } }>
// sockets subscribe with { t: 'battle.join', id }; role = p1/p2 if the Matrix user is that player, else 'spectator'
function join(ws, b, role) {
  ws.send(JSON.stringify({ t: 'battle.log', id: b.id, role, lines: b.room.snapshot(role), replay: true }));
  subscribers(b.id, role).add(ws);
}
const room = new BattleRoom({
  formatid, seed, players: { p1: { name: p1Name, team: t1 }, p2: { name: p2Name, team: t2 } },
  persist: (line) => db.prepare('INSERT INTO battle_input (battle_id, seq, line) VALUES (?, ?, ?)').run(id, seq++, line),
  send: (ch, lines) => { for (const ws of subscribers(id, ch)) ws.send(JSON.stringify({ t: 'battle.log', id, lines })); },
});
// client -> server: { t: 'battle.choose', id, choice: 'move 2', rqid }   { t: 'battle.forfeit', id }
```

### 3.4 Browser side: tiny tracker + renderer (recommended) vs `@pkmn/client` on the server

**Option A (recommended): send protocol lines, track state in the browser with our own module.**
The server sends each socket its channel's lines unchanged. The widget feeds them into
`shared/battle/state.js` (dependency-free, ~165 lines, works in Node and browsers; full code in
[Appendix B](#appendix-b-shared-battle-state-tracker)) and renders with `web/battle/view.js`.

* No bundler, no CDN dependency, nothing secret can leak because the server already filtered.
* Reconnect = replay the snapshot lines into a fresh state, skipping animations.
* The same tracker gives the practice AI its view (section 4), so it is exercised by the server
  tests too.
* Identity rule that makes duplicate nicknames work: events carrying a slot (`p1a: X`) refer to
  whoever is active in that slot; switch-ins pick a non-fainted bench member with identical
  `details` (species, level, gender, shiny); Team Preview `|poke|` creates placeholders that are
  claimed on switch-in. Tested on Gen 1/2 singles, Gen 3/5 doubles and Gen 4/5 with Team
  Preview, using teams with two un-nicknamed Pidgey: for all three channels the number of
  Pokémon seen, the fainted counts and the winner match the sim, and each player's own exact HP
  equals the sim's HP for every Pokémon (`pkmn/shared/battle-state.test.mjs`, 7 tests pass).

**Option B: run `@pkmn/client` on the server and push JSON.** It works (`pkmn/client-on-server.mjs`,
**tested**): `new Battle(new Generations(Dex))` from `@pkmn/client` + `@pkmn/data` accepts
`@pkmn/sim`'s `Dex`, tracks everything PS's client tracks, and `@pkmn/view`'s `LogFormatter`
produces PS's English text (`"The opposing Typhlosion lost 59% of its health!"`). Costs: three more
packages, one client-state object per viewer perspective on the server (p1, p2, spectator), our
own JSON diff protocol, and PS's text uses markdown-ish markup (`**Typhlosion**`, `||spoiler||`)
we would strip. Choose B only if the UI grows to need things like full volatile/condition tracking
with PS-exact wording. Loading these packages directly in the browser is not viable without a
build step (bare-specifier imports between packages, and `@pkmn/client` needs a full Dex).

Renderer design (`web/battle/view.js`, pure `renderBattle(state, cfg) -> HTML string`, **tested**
in Node: correct back sprite URL for the own Pokémon, move buttons from the request, HTML
escaping of a `<b>ZAP</b>` nickname, winner banner after a full battle):

* Layout: foe top-right (front sprite), own bottom-left (back sprite), each with a name plate:
  nickname, gender symbol, `L50`, status badge (`PAR`, `SLP`...), HP bar
  (`width = hp/maxhp`, green > 50 %, yellow > 20 %, red otherwise - the cartridge thresholds),
  exact `hp/maxhp` for own Pokémon and `%` for the foe; boosts as small chips; party balls.
* Log: last N lines of `state.textLog` (our own short English strings).
* Controls from `state.request`: move buttons (`move N`, disabled when `disabled`, PP shown),
  switch buttons (`switch N`, hidden when `trapped`), team preview order, "Waiting for the
  opponent..." on `wait`; buttons carry `data-choice`, one delegated click handler sends
  `{ t: 'battle.choose', choice, rqid }`. Doubles: two pickers build `move 1 2, move 3 1`.
* Sprites: `<img src=first candidate data-fallback="next candidates">` plus one global
  `error` listener that advances the list; `image-rendering: pixelated` and integer scaling
  (Gen 1-2 sprites are 40-56 px, Gen 3 64 px, Gen 4 80 px, Gen 5 96 px).
* Pacing: the server sends whole turns at once. The client queues incoming lines and applies
  them one by one with a short delay for visible events (`|move|`, `|-damage|`, `|switch|`,
  `|faint|`: ~500-800 ms; others: 0), re-rendering after each, and animates the HP bar with a CSS
  `transition: width .4s`. When `replay: true` (join/reconnect) it applies everything at once.
* Timer: show `request.deadline - Date.now()` as a countdown; the server is authoritative.

### 3.5 Timers, forfeit, disconnects, spectators

* **Timer.** The sim has none; PS implements it in `server/room-battle.ts` (`BattleTimer`):
  defaults there are 150 s starting bank (+60 s grace), +10 s per turn, max 150 s per turn
  (300 s for challenges), and on expiry either `>pN default` (when `timeoutAutoChoose` is set and
  the player still has bank time) or forfeit (`forfeitPlayer` writes `>forcelose pN`, adding
  "|-message|NAME lost due to inactivity."); if everyone is inactive it ties. Our simpler policy:
  per-turn timer (default 90 s), auto-choose `default` on the first two expiries, forfeit on the
  third; reset the counter whenever the player chooses. Matrix users drift in and out, so keep it
  generous and make it a challenge option (`off` for friendly battles).
* **Forfeit**: `>forcelose pN`; the sim emits `|win|<other>` (tested).
* **Disconnect/reconnect**: battles live on the server, independent of sockets. On (re)join the
  server sends `snapshot(role)`: the role's full channel log, then the pending `|request|` and
  `|sentchoice|` if a choice was already made (exactly what PS's `RoomBattle.onConnect` does). The
  timer keeps running while disconnected (PS has a separate shorter disconnection timer; optional).
* **Spectators** joining mid-battle get the spectator log replayed; anyone in the Matrix room who
  is not a player is a spectator. A live battle's spectator log grows ~100 lines/turn; fine to
  send whole.
* **Persistence / restarts**: store `{ battle_id, format options, seed, players, status }` and
  every input line (`>start`, `>player`, each accepted `>pN choice`, `>forcelose`) in SQLite.
  Replaying the input log through a new `BattleRoom` (after `ensureFormat(options)`) reproduces the
  battle exactly - same seed, same choices - including all channel logs, so nothing else needs to
  be stored. Measured: about 0.8 kB of input log and ~70 kB of heap per live 6v6 battle (500
  concurrent rooms: +33 MB). `State.serializeBattle()` exists as an alternative but is larger and
  version-sensitive; the input log is what PS itself uses for replays/exports (`>requestexport`).
* **Version pinning**: an input log replays correctly only with the same `@pkmn/sim` version. On
  upgrade, let running battles finish first (or keep them as "abandoned/tie").

### 3.6 Security checklist

* Build teams on the server from Home records (re-parse, `validate`, `toShowdownSet`); never accept
  a `PokemonSet` from the browser. A party sent "for this battle only" goes through the same
  record path.
* Run `checkTeam()` on the server for team-level clauses.
* Whitelist choices (above); only the player bound to a side may choose for it (Matrix user id
  from the OpenID session).
* Never send `logs.omniscient` or the other side's channel/requests to a client.

## 4. Practice AI

### 4.1 Options

* **`RandomPlayerAI`** (exported by `@pkmn/sim`, `sim/tools/random-player-ai.ts`): extends
  `BattlePlayer`, attaches to a player stream from `getPlayerStreams()`, answers every request
  with a random legal choice (handles forced switches, doubles targets, team preview `default`).
  Overridable hooks: `chooseMove(active, moves)`, `chooseSwitch(active, switches)`,
  `chooseTeamPreview(team)`. Good for tests; too weak to be fun.
* **A greedy function** (below): a pure `(request, ownChannelState, prng) -> choice`. It does not
  need a stream, plugs into `BattleRoom` as if it were a remote player, and only sees what a
  human in that seat would see (its `|request|` and its channel), so it cannot cheat.
* Stronger options exist (the MIT `pkmn/engine` project, last push 2026-10-20, is a
  performance-oriented battle engine - its generation coverage was not checked, UNVERIFIED;
  search-based PS bots) but are out of scope for a practice opponent.

### 4.2 Greedy opponent (**tested**, `pkmn/practice-ai.mjs`)

Scores each usable move as base power (fixed-damage moves ~60, OHKO 25, status 5) x type
effectiveness/immunity against the foe's visible species (the gen's own type chart, e.g. Gen 1
Ghost -> Psychic is 0 as on the cartridge) x STAB 1.5 x attacker's Atk or SpA / 100 (category from
the gen's Dex, so Gen 1-3 split by type) x accuracy, recharge moves x 0.6, with +-10 % noise; picks
the best (move, target) per active slot; on a forced switch sends in the healthiest bench Pokémon
weighted by its best move against the current foe; Team Preview `default`.

```js
import { Dex, PRNG } from '@pkmn/sim';

const bench = (req, taken) => req.side.pokemon
  .map((p, i) => ({ p, slot: i + 1 }))
  .filter(({ p, slot }) => !p.active && !p.condition.endsWith(' fnt') && !taken.includes(slot));
const hpFrac = (cond) => { const [a, b] = cond.split(' ')[0].split('/').map(Number); return b ? a / b : 0; };

function scoreMove(dex, moveName, me, foe) {
  const move = dex.moves.get(moveName);
  if (!move.exists) return 0;
  if (move.category === 'Status') return 5;
  if (move.ohko) return 25;
  let s = move.basePower || (move.damage ? 60 : 40);
  if (move.multihit) s *= Array.isArray(move.multihit) ? 3 : move.multihit;
  if (move.flags?.recharge) s *= 0.6;
  if (foe?.exists) {
    if (!dex.getImmunity(move.type, foe.types)) return 0;
    s *= 2 ** dex.getEffectiveness(move.type, foe.types);
  }
  const mine = dex.species.get(me.details.split(', ')[0]);
  if (mine.types.includes(move.type)) s *= 1.5;
  s *= (move.category === 'Physical' ? me.stats.atk : me.stats.spa) / 100;
  if (move.accuracy !== true) s *= move.accuracy / 100;
  return s;
}

/** request: this side's |request| JSON; state: BattleState fed with this side's channel. */
export function chooseGreedy(request, state, prng = new PRNG()) {
  if (request.wait) return null;
  if (request.teamPreview) return 'default';
  const dex = Dex.forGen(state.gen || 9);
  const foeSide = request.side.id === 'p1' ? 'p2' : 'p1';
  const foes = (state.sides[foeSide]?.active ?? []).map(m => m && !m.fainted ? dex.species.get(m.species) : null);
  const taken = [];
  if (request.forceSwitch) {
    return request.forceSwitch.map((must) => {
      if (!must) return 'pass';
      const options = bench(request, taken);
      if (!options.length) return 'pass';
      let best = options[0], bestScore = -1;
      for (const o of options) {
        const sc = Math.max(0, ...o.p.moves.map(m => scoreMove(dex, m, o.p, foes.find(Boolean)))) * hpFrac(o.p.condition);
        if (sc > bestScore) { best = o; bestScore = sc; }
      }
      taken.push(best.slot);
      return `switch ${best.slot}`;
    }).join(', ');
  }
  const doubles = request.active.length > 1;
  return request.active.map((act, i) => {
    const mon = request.side.pokemon[i];
    if (!mon || mon.condition.endsWith(' fnt') || mon.commanding) return 'pass';
    let best = null, bestScore = -1;
    act.moves.forEach((m, j) => {
      if (m.disabled || (m.pp === 0 && act.moves.some(x => x.pp > 0 && !x.disabled))) return;
      const targets = doubles && ['normal', 'any', 'adjacentFoe'].includes(m.target) ? [1, 2] : [null];
      for (const t of targets) {
        if (m.target === 'adjacentAlly') continue;
        const foe = t ? foes[t - 1] : foes.find(Boolean);
        if (t && !foe) continue;
        const sc = scoreMove(dex, m.move, mon, foe) * (0.9 + 0.2 * prng.random());
        if (sc > bestScore) { bestScore = sc; best = `move ${j + 1}${t ? ` ${t}` : ''}`; }
      }
    });
    return best ?? 'default';
  }).join(', ');
}
```

Plugging it into a room (from `pkmn/practice-ai.eval.mjs`; the AI is just another `send` target):

```js
const aiState = new BattleState('p2');
const prng = new PRNG(seed);
const room = new BattleRoom({ formatid, seed, players: { p1: human, p2: { name: 'Practice Bot', team: botTeam } },
  timer: { turnSeconds: 90 },
  send: (ch, lines) => {
    if (ch === 'p2') for (const l of lines) {
      aiState.add(l);
      if (l.startsWith('|request|')) {
        const req = JSON.parse(l.slice(9));
        const choice = chooseGreedy(req, aiState, prng);
        if (choice) setTimeout(() => room.choose('p2', choice, req.rqid), 600); // feel "human"
      }
    } else forward(ch, lines);
  } });
```

Evaluation through `BattleRoom` (100 mirror matches each, greedy as p1 vs uniform random as p2,
3-Pokémon teams at L50; **tested**, 3.6 s total):

| format | greedy wins |
|---|---|
| Gen 1 singles | 94/100 |
| Gen 2 singles | 100/100 |
| Gen 3 singles | 92/100 |
| Gen 4 singles | 96/100 |
| Gen 5 singles | 94/100 |
| Gen 4 doubles | 98/100 |

(The stream-based `GreedyAI extends RandomPlayerAI` variant from the interrupted run,
`pkmn/greedy-ai.mjs`, won 287/300 Gen 3 mirror matches; the function version supersedes it.)

Easy improvements if players find it too predictable: switch out when the active Pokémon is
immune/4x weak, use a status move when the foe has none, consider the foe's revealed moves, or
lower the noise for a "hard" level.

### 4.3 Opponent teams

* **Mirror/own Home**: the player's other Home Pokémon (no new data).
* **Generated**: `@pkmn/randoms` generates `gen1randombattle` ... `gen5randombattle` teams
  (**tested**: `Teams.setGeneratorFactory(TeamGenerators); Teams.generate('gen3randombattle', { seed })`
  returns 6 sets; Gen 1-2 sets carry `ivs: 30` (DV 15) and `evs: 255`, Gen 3-5 `evs: 85` each,
  levels 65-90 by tier). They are competitive sets, so cap them to the player's level with the
  format's level cap (validator rewrites levels) or scale `level` before `>player`. Adds a 7.6 MB
  dependency.
* **Curated**: in-game trainer teams (gym leaders, Elite Four) as JSON sets per game; the pret
  disassemblies have the trainer party data (`data/trainers/parties.asm` in pokered/pokecrystal,
  `src/data/trainer_parties.h` in pokeemerald; all three paths return 200) - read them to build
  our own data file. The pret repos declare no license (no LICENSE/COPYING file at the root of
  pokered, pokecrystal, pokeemerald or pokeplatinum, checked 2026-10-24), so use them as reference
  only and write the team data ourselves, as with PKHeX.

## 5. Sprites

### 5.1 Sources

**PokeAPI/sprites** (`github.com/PokeAPI/sprites`, last push 2026-10-20, HEAD
`97a7832d307311c0e1c6ea9035308bf80cc94f81`). Per-game battle sprites live under
`sprites/pokemon/versions/<generation>/<game>/`, named by National Dex number. Inventory from a
sparse checkout of that commit (counts are files per folder; forms add files like `201-b.png`):

| folder | variants (sub-folders) | front size |
|---|---|---|
| `generation-i/red-blue`, `yellow`, `red-green-japan` | `back/`, `gray/`, `transparent/` (+`transparent/back/`), yellow also `gbc/` | 40x40 (transparent 96x96); no shiny (Gen 1 has none) |
| `generation-ii/crystal` | `shiny/`, `back/`, `back/shiny/`, `transparent/...`, `animated/` + `animated/shiny/` (GIF, front only) | 40x40 (transparent 56x56) |
| `generation-ii/gold`, `silver` | `shiny/`, `back/`, `back/shiny/`, `transparent/...` | 40x40 |
| `generation-iii/emerald` | `shiny/`, `back/`, `back/shiny/`, `animated/` (APNG, front and back, shiny) | 64x64 |
| `generation-iii/ruby-sapphire`, `firered-leafgreen` | `shiny/`, `back/`, `back/shiny/` | 64x64 |
| `generation-iv/diamond-pearl`, `platinum`, `heartgold-soulsilver` | `shiny/`, `back/`, `back/shiny/`, `female/` variants in each, `animated/` (front) | 80x80 |
| `generation-v/black-white` | `shiny/`, `back/`, `back/shiny/`, `female/` variants, `animated/` GIFs incl. `animated/back/shiny/` | 96x96 (GIFs vary, e.g. 50x46) |
| `generation-iii/icons`, `generation-iv/icons`, `generation-v/icons` (+`animated/`) | box/party icons | 32x32 |

Path grammar (consistent across all folders):
`versions/<gen>/<game>/[animated/][transparent/][back/][shiny/][female/]<file>.<png|gif>`.
Forms: Unown/Burmy/Shellos/Arceus/Deerling/Genesect-style cosmetic forms use `<dex>-<form>.png`
(`201-b`, `201-exclamation`, `412-sandy`, `422-east`, `493-fire`, `585-summer`, `649-douse`;
Crystal also has `201-a`, Black/White uses `201.png` for A), stat-changing forms use PokeAPI
*pokemon* ids from `data/v2/csv/pokemon.csv`: 10001-10003 Deoxys Attack/Defense/Speed, 10004-10005
Wormadam, 10006 Shaymin-Sky, 10007 Giratina-Origin, 10008-10012 Rotom forms, 10013-10015 Castform,
10016 Basculin-Blue-Striped, 10017 Darmanitan-Zen, 10018 Meloetta-Pirouette, 10019-10021 Therian
forms, 10022-10023 Kyurem-Black/White, 10024 Keldeo-Resolute (PokeAPI CSV, fetched 2026-10-24).
Generate the PS-name -> file table in `scripts/build-data.mjs` and always fall back to `<dex>.png`.

Static PNGs for **all** Gen 1-5 games are ~24 MB (1.8 + 3.1 + 3.3 + 7.6 + 8.1 MB, apparent size);
the animated sets add ~400 MB (mostly BW GIFs and Emerald APNGs).

License: the repo's `LICENCE.txt` says "All image contents within are Copyright The Pokémon
Company" and then applies CC0 1.0 to the repository - i.e. PokeAPI disclaims its own rights but
the images remain Nintendo/Creatures/GAME FREAK/TPC property. No license grants us the images;
like every fan project we rely on fair-use-style tolerance. Keep sprites out of our MIT git repo
(fetch them at build/deploy time), credit "Sprites © Nintendo/Creatures Inc./GAME FREAK inc.,
via PokeAPI/sprites", and make the base URL configurable so a deployment can swap sources.

**Showdown** (`play.pokemonshowdown.com/sprites/`): folders `gen1`, `gen1-back`, `gen1rb`, `gen1rg`,
`gen1rgb-back`, `gen2`(-shiny/-back/-back-shiny), `gen2g`, `gen2s`, `gen3`(...), `gen3rs`,
`gen3frlg`, `gen4`(...), `gen4dp`, `gen5`(...), `gen5ani`(-shiny/-back/-back-shiny, GIF), the
`pokemonicons-sheet.png` icon sheet (40x30 cells), item icons, type icons, trainer sprites.
Files are named by PS sprite id (`pikachu.png`, `unown-b.png`, `deoxys-attack.png`), which
`@pkmn/img`'s `Sprites.getPokemon(name, { gen, shiny, side })` computes (tested output:
`https://play.pokemonshowdown.com/sprites/gen5ani-back/pikachu.gif`; Gen 1 + shiny correctly falls
back to the non-shiny `gen1/pikachu.png`). The index page offers a prepackaged
`//www.pokemonshowdown.com/files/resources/sprites.zip` (890 MB, last modified 2026-07-14) and
points to PokeAPI/sprites. Served via Cloudflare with `cache-control: max-age=691200`. PS's own
policy on hotlinking is **UNVERIFIED** (not stated on the index page we fetched); as a courtesy do
not hotlink PS from a community deployment. The PS *client* code is AGPLv3 (its README), so do
not copy its battle-animation code either.

### 5.2 Verified URLs (curl, 2026-10-24)

| URL | result |
|---|---|
| `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-i/red-blue/25.png` | 200 image/png 394 B |
| `https://raw.githubusercontent.com/PokeAPI/sprites/97a7832d.../sprites/pokemon/versions/generation-iii/emerald/shiny/25.png` | 200 image/png 600 B |
| `.../master/sprites/pokemon/versions/generation-v/black-white/animated/back/shiny/25.gif` | 200 image/gif 21058 B |
| `.../master/sprites/pokemon/versions/generation-iv/platinum/female/25.png` | 200 |
| `.../master/sprites/pokemon/versions/generation-ii/crystal/animated/25.gif` | 200 |
| `.../master/sprites/pokemon/versions/generation-iii/icons/25.png` | 200 (32x32) |
| `.../master/sprites/pokemon/versions/generation-viii/icons/25.png` | 404 (no Gen VIII icon folder) |
| `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/versions/generation-i/red-blue/25.png` | **403** "Package size exceeded the configured limit of 50 MB" |
| `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@97a7832d.../sprites/pokemon/versions/generation-i/red-blue/25.png` | 200 image/png 394 B |
| same `@<sha>` pattern, 12 more files across Gen I-V (yellow back, RB transparent, Crystal shiny, Gold back shiny, FRLG back shiny, RS shiny, HGSS back shiny, DP female, Gen IV/V icons, BW animated shiny) | 200 |
| `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@97a7832d.../sprites/pokemon/versions/generation-v/black-white/back/646.png` | 200 on the first request, then **403** (same 50 MB message) on two retries |
| `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/25.png` | 200 (top-level default sprites) |
| `https://play.pokemonshowdown.com/sprites/gen3/pikachu.png` | 200 543 B |
| `https://play.pokemonshowdown.com/sprites/gen5ani-back-shiny/pikachu.gif` | 200 |
| `https://play.pokemonshowdown.com/sprites/gen2/unown-b.png`, `gen1rb/`, `gen2g/`, `gen3rs/`, `gen3frlg/`, `gen4dp/`, `gen1rgb-back/` pikachu | 200 |
| `https://play.pokemonshowdown.com/sprites/pokemonicons-sheet.png` | 200, 392 kB |

**Conclusion on jsDelivr**: its GitHub mode enforces a 50 MB package limit (the 403 body says so)
and PokeAPI/sprites is ~26 GB (GitHub API `size` 26,372,690 KB), so jsDelivr serves only what it happens to have cached and refuses the rest. The exact
pattern `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@<commit-sha>/sprites/pokemon/versions/<gen>/<game>/[back/][shiny/]<dex>.png`
*often* works but is **not reliable**; do not use it as the default. `raw.githubusercontent.com`
pinned to a commit works for every file but is not a CDN (rate limits, no SLA) - fine for
development. Production: self-host.

### 5.3 Recommended scheme: one configurable base URL

* Server config `SPRITE_BASE_URL`, sent to the widget in its config response. It points at a
  directory that mirrors PokeAPI's `sprites/pokemon/` tree, so the same relative paths work for:
  * production: `/sprites/pokemon` served by Caddy from a volume filled at deploy time;
  * development: `https://raw.githubusercontent.com/PokeAPI/sprites/<pinned-sha>/sprites/pokemon`;
  * a third-party mirror, or `''` to disable sprites (text-only UI).
* `scripts/fetch-sprites.sh` (or `.mjs`) with a pinned commit. Fetching one commit by SHA with a
  blob filter and a sparse checkout is fast (**tested**: Gen I + Gen III icons, 3,739 files,
  1.6 s; GitHub allows fetching a commit by SHA):

  ```sh
  SHA=97a7832d307311c0e1c6ea9035308bf80cc94f81
  git init -q sprites-src
  git -C sprites-src remote add origin https://github.com/PokeAPI/sprites.git
  git -C sprites-src sparse-checkout set --no-cone \
    /sprites/pokemon/versions/generation-i/ /sprites/pokemon/versions/generation-ii/ \
    /sprites/pokemon/versions/generation-iii/ /sprites/pokemon/versions/generation-iv/ \
    /sprites/pokemon/versions/generation-v/
  git -C sprites-src fetch -q --depth 1 --filter=blob:none origin "$SHA"
  git -C sprites-src checkout -q FETCH_HEAD
  rsync -a --exclude 'animated/' sprites-src/sprites/pokemon/ /srv/sprites/pokemon/   # ~24 MB static
  ```

* The browser resolves a candidate list per Pokémon and falls back on `error`
  (`web/battle/sprites.js`, **tested** path grammar):

```js
export const GAME_FOLDERS = {
  1: { RB: 'generation-i/red-blue', Y: 'generation-i/yellow', RG: 'generation-i/red-green-japan' },
  2: { C: 'generation-ii/crystal', GS: 'generation-ii/gold', G: 'generation-ii/gold', S: 'generation-ii/silver' },
  3: { E: 'generation-iii/emerald', RS: 'generation-iii/ruby-sapphire', FRLG: 'generation-iii/firered-leafgreen' },
  4: { Pt: 'generation-iv/platinum', DP: 'generation-iv/diamond-pearl', HGSS: 'generation-iv/heartgold-soulsilver' },
  5: { BW: 'generation-v/black-white', B2W2: 'generation-v/black-white' },
};
const FEATURES = {
  1: { shiny: false, female: false, transparent: true, animated: false, ext: 'png' },
  2: { shiny: true, female: false, transparent: true, animated: 'front', ext: 'png', animExt: 'gif' },  // Crystal only
  3: { shiny: true, female: false, transparent: false, animated: 'both', ext: 'png', animExt: 'png' }, // Emerald only (APNG)
  4: { shiny: true, female: true, transparent: false, animated: 'front', ext: 'png', animExt: 'png' },
  5: { shiny: true, female: true, transparent: false, animated: 'both', ext: 'png', animExt: 'gif' },
};

/** m = { num, file?, gen, game?, back?, shiny?, female?, animated? } -> URLs, best first */
export function spriteCandidates(m, base) {
  const f = FEATURES[m.gen], games = GAME_FOLDERS[m.gen];
  const folder = games[m.game] ?? Object.values(games)[0];
  const anim = m.animated && f.animated && (f.animated === 'both' || !m.back) &&
    (m.gen !== 2 || folder.endsWith('crystal')) && (m.gen !== 3 || folder.endsWith('emerald'));
  const out = [];
  for (const stem of [m.file, String(m.num)].filter(Boolean))
    for (const female of (m.female && f.female ? [true, false] : [false]))
      for (const a of (anim ? [true, false] : [false])) {
        const parts = [base, 'versions', folder, a && 'animated', !a && f.transparent && 'transparent', m.back && 'back',
          m.shiny && f.shiny && 'shiny', female && 'female'].filter(Boolean);
        out.push(`${parts.join('/')}/${stem}.${a ? f.animExt : f.ext}`);
      }
  return [...new Set(out)];
}
export const iconUrl = (num, base, file) => `${base}/versions/generation-v/icons/${file ?? num}.png`; // covers #1-649
```

Tested expectations: Gen 4 back shiny female Pikachu ->
`versions/generation-iv/platinum/back/shiny/female/25.png` then `.../back/shiny/25.png`; Gen 1
shiny -> `generation-i/red-blue/transparent/25.png` (no shiny in Gen 1); Crystal animated Unown B ->
`animated/201-b.gif`, `transparent/201-b.png`, then `201` fallbacks; Gen 5 animated back shiny
Genesect -> `generation-v/black-white/animated/back/shiny/649.gif`.

Which game's look to use: default to the battle format's generation and the Pokémon's origin
game when it belongs to that generation (`MonView.game`), else the gen default (RB, Crystal,
Emerald, Platinum, BW); a user setting can override. Box/Home grid: Gen V icons (32x32) for every
Pokémon (there are no Gen I/II icon folders upstream).

## Appendix A: scratch scripts

All under `/tmp/claude-1000/pkres/battle/` (scratch, not part of the repo). `pkmn/` has
`@pkmn/sim@0.10.11` and friends installed, `ps/` has `pokemon-showdown@0.11.11`. Re-run with
`cd /tmp/claude-1000/pkres/battle/pkmn && node <script>` / `node --test <file>`.

| script | what it shows | result on 2026-10-24 |
|---|---|---|
| `pkmn/all-gens-smoke.mjs` | one random-vs-random battle per Gen 1-5 singles + Gen 3-5 doubles custom format | 8/8 finish, 0.3 s |
| `pkmn/gen12-stats.mjs` | first DV/Stat Exp check (interrupted run) | 300 "mismatches" - reference formula lacked the 255 cap |
| `pkmn/gen12-stats-v2.mjs` | corrected check vs pret formula; Garchomp Gen 4/5 fixture | 4,800 stats, 0 mismatches; 289 278/193/135/171/171 |
| `pkmn/gen12-leaks.mjs` | battle accepts Gen 1 item/ability/nature, random gender | Intimidate fires in Gen 1 |
| `pkmn/set-quirks.mjs` | gender/happiness/PP defaults, Adjust Level Down, `@@@`, items, forms, move/species numbering | see 2.2-2.3 |
| `pkmn/custom-format.mjs` | `Dex.formats.extend`, exact-stat override, validator clauses, doubles + preview battle | works |
| `pkmn/widget-formats.mjs` | `ensureFormat()` + `checkTeam()` | 8 formats; clauses enforced |
| `pkmn/protocol-dump.mjs`, `pkmn/protocol-channels.mjs` | raw output, `\|split\|`, per-channel views (`pixels` arg for 48-px HP) | see 3.1-3.2 |
| `pkmn/forfeit-timer.mjs` | invalid choice error, `default`, `>forcelose` | `\|win\|A` |
| `pkmn/battle-room.mjs` + `.test.mjs` | server core | 3/3 pass |
| `pkmn/shared/battle-state.js` + `.test.mjs` | browser/Node tracker incl. duplicate names, doubles, preview | 7/7 pass |
| `pkmn/web/view.js`, `web/sprites.js` + `web/view.test.mjs` | renderer and sprite URLs | 2/2 pass |
| `pkmn/to-showdown-set.mjs` + `.test.mjs` | MonView -> PokemonSet | 4/4 pass |
| `pkmn/practice-ai.mjs` + `practice-ai.eval.mjs` | greedy vs random through BattleRoom | table in 4.2 |
| `pkmn/greedy-ai.mjs` | stream-based greedy (older) | 287/300 |
| `pkmn/client-on-server.mjs` | `@pkmn/client` + `@pkmn/view` on the server | works |
| `pkmn/randoms-img.mjs` | `@pkmn/randoms` Gen 1-5 teams, `@pkmn/img` URLs | works |
| `pkmn/perf.mjs` (`ps` arg for upstream), `pkmn/mem.mjs` | throughput, memory per room | see 1.2, 3.5 |
| `ps/gen3-battle.mjs`, `ps/custom-format-ps.mjs` | same with `pokemon-showdown` (default import, `@@@`, rulesetCache hack) | works |
| `pkmn/make-demo.mjs` -> `pkmn/demo-gen2.html`, `demo-gen3.html` | self-contained renderer demo (classic script, opens from file://) built from a real p1 log | generated; not visually reviewed in this run |
| `web/sprites-repo/` | sparse checkout of PokeAPI/sprites versions/generation-i..v at 97a7832 | 539 MB on disk |

## Appendix B: shared battle-state tracker

`shared/battle/state.js` (**tested**; 163 lines). Pure ES module, no DOM, no dependencies.

```js
// shared/battle/state.js - dependency-free tracker for the Showdown battle protocol.
// Runs unchanged in the browser (ES module, no DOM) and in Node (tests, AI).
// Feed it every line of ONE channel (p1, p2 or spectator) in order: state.add(line).

/** "p2a: GARDY" -> { side: 'p2', slot: 0, name: 'GARDY' }; "p1: Mr. Mime" -> slot null */
export function parseIdent(ident) {
  const m = /^(p[1-4])([a-c])?: ?(.*)$/.exec(ident ?? '');
  return m ? { side: m[1], slot: m[2] ? m[2].charCodeAt(0) - 97 : null, name: m[3] } : null;
}
/** "Gardevoir, L52, F, shiny" -> { species, level, gender, shiny } */
export function parseDetails(details = '') {
  const [species, ...rest] = details.split(', ');
  const out = { species, level: 100, gender: '', shiny: false };
  for (const t of rest) {
    if (/^L\d+$/.test(t)) out.level = +t.slice(1);
    else if (t === 'M' || t === 'F') out.gender = t;
    else if (t === 'shiny') out.shiny = true;
  }
  return out;
}
/** "87/100 par" | "0 fnt" | "148/148" | "24/48y" (pixel HP) -> { hp, maxhp?, status, fainted } */
export function parseHP(cond = '') {
  const [hpPart, status = ''] = cond.split(' ');
  if (status === 'fnt' || hpPart === '0') return { hp: 0, status: '', fainted: true }; // keep previous maxhp
  const [hp, max] = hpPart.split('/');
  return { hp: parseInt(hp, 10), maxhp: parseInt(max, 10) || 100, status, fainted: false };
}
/** split "|cmd|a|b|[from] item: Leftovers|[of] p1a: X" -> { cmd, args: [a, b], kw: { from, of } } */
export function parseLine(line) {
  const parts = line.slice(1).split('|');
  const cmd = parts.shift();
  const kw = {};
  while (parts.length && /^\[\w+\]/.test(parts[parts.length - 1])) {
    const m = /^\[(\w+)\] ?(.*)$/.exec(parts.pop()); kw[m[1]] = m[2] || true;
  }
  return { cmd, args: parts, kw };
}

const STATUS = { brn: 'burned', par: 'paralyzed', slp: 'fell asleep', frz: 'was frozen solid', psn: 'was poisoned', tox: 'was badly poisoned' };

export class BattleState {
  /** @param {'p1'|'p2'|null} perspective  null for spectators */
  constructor(perspective = null) {
    this.perspective = perspective;
    this.sides = {};            // p1/p2 -> { id, name, active: [mon], team: [mon], teamsize, conditions: Set }
    this.gen = 0; this.gameType = 'singles'; this.turn = 0; this.tier = '';
    this.weather = ''; this.fields = new Set(); this.winner = undefined; this.ended = false;
    this.request = null; this.textLog = []; this.rules = []; this.errors = []; this.inactive = '';
  }
  side(id) { return (this.sides[id] ??= { id, name: id, active: [], team: [], teamsize: 0, conditions: new Set() }); }
  #newMon(s, name, details) {
    const mon = { name, details: details ?? '?', species: name, level: 100, gender: '', shiny: false, hp: 100, maxhp: 100, status: '', fainted: false, boosts: {}, volatiles: new Set(), item: '', ability: '', revealedMoves: [] };
    if (details) Object.assign(mon, parseDetails(details));
    s.team.push(mon);
    return mon;
  }
  /**
   * Resolve a Pokemon. Slot idents ("p1a: X") mean "whoever is active there" - this is what makes
   * duplicate nicknames work. Switch-ins pick a bench member with the same name and species.
   */
  mon(ident, details, switching = false) {
    const id = parseIdent(ident); if (!id) return null;
    const s = this.side(id.side);
    if (!switching && id.slot !== null && s.active[id.slot] && s.active[id.slot].name === id.name) return { mon: s.active[id.slot], id, side: s };
    const named = s.team.filter(m => m.name === id.name);
    let mon;
    if (switching) { // fainted Pokemon never come back in Gen 1-5; prefer an exact details match
      const free = named.filter(m => !s.active.includes(m) && !m.fainted);
      const species = parseDetails(details).species;
      mon = free.find(m => m.details === details)
        ?? s.team.find(m => m.name === '?' && m.species === species.replace(/-.*$/, '') || m.name === '?' && m.species === species);
      if (mon) mon.name = id.name; // a team-preview placeholder is now identified
    } else {
      mon = named.find(m => !m.fainted) ?? named[0];
    }
    if (!mon) mon = this.#newMon(s, id.name, details);
    else if (details) Object.assign(mon, parseDetails(details), { details });
    return { mon, id, side: s };
  }
  label(r) { return r.side.id === this.perspective || !this.perspective ? r.mon.name : `The opposing ${r.mon.name}`; }
  add(line) {
    if (!line || line[0] !== '|') return;
    const { cmd, args, kw } = parseLine(line);
    const from = kw.from ? ` (${kw.from.replace(/^(item|ability|move): /, '')})` : '';
    switch (cmd) {
      case 'player': if (args[1]) this.side(args[0]).name = args[1]; break;
      case 'teamsize': this.side(args[0]).teamsize = +args[1]; break;
      case 'gen': this.gen = +args[0]; break;
      case 'tier': this.tier = args[0]; break;
      case 'gametype': this.gameType = args[0]; break;
      case 'rule': this.rules.push(args[0]); break;
      case 'clearpoke': for (const s of Object.values(this.sides)) s.team = []; break;
      case 'poke': { const s = this.side(args[0]); this.#newMon(s, '?', '?' + args[1]).species = parseDetails(args[1]).species.replace(/-\*$/, ''); break; } // team preview placeholder ("Arceus-*")
      case 'start': this.log('The battle started!'); break;
      case 'turn': this.turn = +args[0]; this.log(`— Turn ${this.turn} —`); break;
      case 'request': this.request = args[0] ? JSON.parse(args.join('|')) : null; break;
      case 'inactive': case 'inactiveoff': this.inactive = args[0]; break;
      case 'error': this.errors.push(args[0]); break;
      case 'switch': case 'drag': case 'replace': {
        const r = this.mon(args[0], args[1], true); if (!r) break;
        const prev = r.side.active[r.id.slot];
        if (prev && prev !== r.mon) { prev.boosts = {}; prev.volatiles = new Set(); }
        Object.assign(r.mon, parseHP(args[2] ?? '100/100'), { boosts: {}, volatiles: new Set() });
        r.side.active[r.id.slot] = r.mon;
        if (cmd === 'switch') this.log(r.side.id === this.perspective ? `Go! ${r.mon.name}!` : `${r.side.name} sent out ${r.mon.name}!`);
        if (cmd === 'drag') this.log(`${this.label(r)} was dragged out!`);
        break;
      }
      case 'detailschange': case '-formechange': { const r = this.mon(args[0]); if (r) r.mon.species = parseDetails(args[1]).species; break; }
      case 'move': { const r = this.mon(args[0]); if (!r) break;
        if (!r.mon.revealedMoves.includes(args[1])) r.mon.revealedMoves.push(args[1]);
        this.log(`${this.label(r)} used ${args[1]}!`); if (kw.miss) this.log('The attack missed!'); break; }
      case 'cant': { const r = this.mon(args[0]); if (r) this.log(`${this.label(r)} can't move${args[1] ? ` (${args[1]})` : ''}!`); break; }
      case '-damage': case '-heal': case '-sethp': {
        const r = this.mon(args[0]); if (!r) break;
        const before = r.mon.hp / (r.mon.maxhp || 1);
        Object.assign(r.mon, parseHP(args[1]));
        const pct = Math.round(Math.abs(before - r.mon.hp / (r.mon.maxhp || 1)) * 100);
        this.log(`${this.label(r)} ${cmd === '-damage' ? 'lost' : 'restored'} ${pct}% of its HP${from}`);
        break;
      }
      case 'faint': { const r = this.mon(args[0]); if (r) { Object.assign(r.mon, { fainted: true, hp: 0, status: '' }); this.log(`${this.label(r)} fainted!`); } break; }
      case '-status': { const r = this.mon(args[0]); if (r) { r.mon.status = args[1]; this.log(`${this.label(r)} ${STATUS[args[1]] ?? args[1]}!`); } break; }
      case '-curestatus': { const r = this.mon(args[0]); if (r) { r.mon.status = ''; this.log(`${this.label(r)} was cured${from}.`); } break; }
      case '-cureteam': { const r = this.mon(args[0]); if (r) for (const m of r.side.team) m.status = ''; break; }
      case '-boost': case '-unboost': {
        const r = this.mon(args[0]); if (!r) break;
        const n = (+args[2]) * (cmd === '-boost' ? 1 : -1);
        r.mon.boosts[args[1]] = Math.max(-6, Math.min(6, (r.mon.boosts[args[1]] ?? 0) + n));
        this.log(`${this.label(r)}'s ${args[1]} ${n > 0 ? 'rose' : 'fell'}${Math.abs(n) > 1 ? ' sharply' : ''}!`);
        break;
      }
      case '-setboost': { const r = this.mon(args[0]); if (r) r.mon.boosts[args[1]] = +args[2]; break; }
      case '-clearboost': { const r = this.mon(args[0]); if (r) r.mon.boosts = {}; break; }
      case '-clearallboost': for (const s of Object.values(this.sides)) for (const m of s.active) if (m) m.boosts = {}; break;
      case '-start': { const r = this.mon(args[0]); if (r) { r.mon.volatiles.add(args[1].replace(/^move: /, '')); this.log(`${this.label(r)}: ${args[1].replace(/^move: /, '')} started${from}`); } break; }
      case '-end': { const r = this.mon(args[0]); if (r) r.mon.volatiles.delete(args[1].replace(/^move: /, '')); break; }
      case '-item': { const r = this.mon(args[0]); if (r) { r.mon.item = args[1]; this.log(`${this.label(r)} has ${args[1]}${from}`); } break; }
      case '-enditem': { const r = this.mon(args[0]); if (r) { r.mon.item = ''; this.log(`${this.label(r)}'s ${args[1]} was used up${from}`); } break; }
      case '-ability': { const r = this.mon(args[0]); if (r) { r.mon.ability = args[1]; this.log(`[${this.label(r)}'s ${args[1]}]`); } break; }
      case '-transform': { const r = this.mon(args[0]); if (r) this.log(`${this.label(r)} transformed!`); break; }
      case '-weather': this.weather = args[0] === 'none' ? '' : args[0]; if (!kw.upkeep) this.log(this.weather ? `Weather: ${this.weather}` : 'The weather cleared.'); break;
      case '-fieldstart': this.fields.add(args[0].replace(/^move: /, '')); break;
      case '-fieldend': this.fields.delete(args[0].replace(/^move: /, '')); break;
      case '-sidestart': this.side(args[0].slice(0, 2)).conditions.add(args[1].replace(/^move: /, '')); break;
      case '-sideend': this.side(args[0].slice(0, 2)).conditions.delete(args[1].replace(/^move: /, '')); break;
      case '-miss': this.log('The attack missed!'); break;
      case '-crit': this.log('A critical hit!'); break;
      case '-supereffective': this.log("It's super effective!"); break;
      case '-resisted': this.log("It's not very effective..."); break;
      case '-immune': this.log("It doesn't affect the target..."); break;
      case '-fail': this.log('But it failed!'); break;
      case '-ohko': this.log("It's a one-hit KO!"); break;
      case '-hitcount': this.log(`Hit ${args[1]} time(s)!`); break;
      case '-mustrecharge': { const r = this.mon(args[0]); if (r) this.log(`${this.label(r)} must recharge!`); break; }
      case '-message': case 'message': this.log(args[0]); break;
      case 'win': this.winner = args[0]; this.ended = true; this.request = null; this.log(`${args[0]} won the battle!`); break;
      case 'tie': this.winner = null; this.ended = true; this.request = null; this.log('The battle ended in a tie.'); break;
      // ignored: |t:|, |upkeep|, |debug|, |-activate|, |-hint|, |-singleturn|, |-prepare|, |-anim|, |split| ...
    }
  }
  log(text) { this.textLog.push(text); }
}
```

`web/battle/view.js` (**tested** HTML generation; CSS below is a starting point, not visually reviewed):

```js
// web/battle/view.js - renders a BattleState (+ this player's request) to HTML. Pure function, so
// it is unit-testable in Node; web/battle/main.js does root.innerHTML = renderBattle(...) and uses
// event delegation on [data-choice] buttons.
import { spriteCandidates } from './sprites.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const STATUS_LABEL = { brn: 'BRN', par: 'PAR', slp: 'SLP', frz: 'FRZ', psn: 'PSN', tox: 'TOX' };

export function hpColor(frac) { return frac > 0.5 ? 'g' : frac > 0.2 ? 'y' : 'r'; }

function monCard(mon, { back, gen, spriteBase, speciesNum, exact }) {
  if (!mon) return '<div class="mon empty"></div>';
  const frac = mon.maxhp ? mon.hp / mon.maxhp : 0;
  const num = speciesNum(mon.species);
  const urls = num ? spriteCandidates({ num: num.num, file: num.file, gen, back, shiny: mon.shiny, female: mon.gender === 'F' }, spriteBase) : [];
  const boosts = Object.entries(mon.boosts ?? {}).filter(([, v]) => v).map(([k, v]) => `<span class="boost">${esc(k)} ${v > 0 ? '+' : ''}${v}</span>`).join('');
  return `<div class="mon${mon.fainted ? ' fainted' : ''}">
  <div class="plate"><b>${esc(mon.name)}</b> ${mon.gender === 'M' ? '♂' : mon.gender === 'F' ? '♀' : ''} L${mon.level}
    ${mon.status ? `<span class="status ${esc(mon.status)}">${STATUS_LABEL[mon.status] ?? esc(mon.status)}</span>` : ''}
    <div class="hpbar"><div class="hp ${hpColor(frac)}" style="width:${Math.max(frac > 0 ? 1 : 0, Math.round(frac * 100))}%"></div></div>
    <small>${exact ? `${mon.hp}/${mon.maxhp}` : `${Math.round(frac * 100)}%`}</small> ${boosts}
  </div>
  <img class="sprite" alt="${esc(mon.species)}" src="${esc(urls[0] ?? '')}" data-fallback="${esc(urls.slice(1).join(' '))}">
</div>`;
}

/** Buttons for the pending request. Values are slot numbers only (the server whitelists them). */
function controls(req) {
  if (!req || req.wait) return '<p class="waiting">Waiting for the opponent…</p>';
  if (req.teamPreview) return `<div class="choices">${req.side.pokemon.map((p, i) => `<button data-choice="team ${i + 1}">${esc(p.ident.slice(4))} first</button>`).join('')}</div>`;
  const switches = (forced) => req.side.pokemon.map((p, i) => p.active || p.condition.endsWith(' fnt') ? '' :
    `<button data-choice="switch ${i + 1}">${esc(p.ident.slice(4))} <small>${esc(p.condition)}</small></button>`).join('');
  if (req.forceSwitch) return `<div class="choices">${switches(true)}</div>`;
  const act = req.active?.[0]; // singles UI; doubles builds "move 1 2, move 3 1" from two pickers
  const trapped = act?.trapped || act?.maybeTrapped;
  return `<div class="choices">${(act?.moves ?? []).map((m, i) =>
    `<button data-choice="move ${i + 1}"${m.disabled ? ' disabled' : ''}>${esc(m.move)} <small>${m.pp}/${m.maxpp}</small></button>`).join('')}</div>
<div class="choices">${trapped ? '' : switches(false)}</div>`;
}

/**
 * @param {import('../shared/battle-state.js').BattleState} state  fed with this viewer's channel
 * @param {{spriteBase: string, speciesNum: (name: string) => ({num:number, file?:string}|null), logLines?: number}} cfg
 */
export function renderBattle(state, cfg) {
  const me = state.perspective ?? 'p1';
  const foe = me === 'p1' ? 'p2' : 'p1';
  const gen = Math.min(5, Math.max(1, state.gen || 5));
  const side = (id, back) => (state.sides[id]?.active ?? [undefined]).map(m => monCard(m, { back, gen, spriteBase: cfg.spriteBase, speciesNum: cfg.speciesNum, exact: back && !!state.perspective })).join('');
  const balls = (id) => (state.sides[id]?.team ?? []).map(m => `<i class="ball${m.fainted ? ' out' : ''}" title="${esc(m.name)}"></i>`).join('');
  return `<section class="battle gen${gen}">
  <header>${esc(state.tier)} · Turn ${state.turn}${state.inactive ? ` · <span class="timer">${esc(state.inactive)}</span>` : ''}</header>
  <div class="field">
    <div class="side foe"><div class="trainer">${esc(state.sides[foe]?.name ?? '')} ${balls(foe)}</div>${side(foe, false)}</div>
    <div class="side me"><div class="trainer">${esc(state.sides[me]?.name ?? '')} ${balls(me)}</div>${side(me, true)}</div>
  </div>
  <ol class="log">${state.textLog.slice(-(cfg.logLines ?? 8)).map(t => `<li>${esc(t)}</li>`).join('')}</ol>
  ${state.ended ? `<p class="result">${state.winner ? `${esc(state.winner)} won!` : 'Tie.'}</p>` : state.perspective ? controls(state.request) : ''}
</section>`;
}
```

```css
.battle .field { display: grid; grid-template-rows: 1fr 1fr; min-height: 260px; }
.battle .side.foe { justify-self: end; text-align: right; }
.battle .side.me  { justify-self: start; }
.battle .sprite { width: 128px; height: 128px; image-rendering: pixelated; object-fit: contain; }
.battle .gen5 .sprite { width: 96px; height: 96px; }
.battle .hpbar { width: 120px; height: 6px; background: #333; border-radius: 3px; overflow: hidden; }
.battle .hp { height: 100%; transition: width .4s; }
.battle .hp.g { background: #3c3; } .battle .hp.y { background: #fc3; } .battle .hp.r { background: #e33; }
.battle .status { font-size: .7em; padding: 0 .3em; border-radius: 3px; background: #888; color: #fff; }
.battle .fainted .sprite { opacity: .2; }
.battle .log { max-height: 8em; overflow-y: auto; font-size: .9em; }
.battle .ball { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #e33; }
.battle .ball.out { background: #777; }
```

Sprite fallback (one listener for the whole widget):

```js
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
  const [next, ...rest] = img.dataset.fallback.split(' ');
  img.dataset.fallback = rest.join(' ');
  img.src = next;
}, true); // capture: error events do not bubble
```

## Sources

* `@pkmn/sim` 0.10.11 build (read locally): `sim/battle-stream.mjs`, `sim/battle.mjs`
  (`extractChannelMessages`, `statModify`, `calculatePP`, `reportExactHP`), `sim/pokemon.mjs`
  (constructor defaults, `getHealth`), `sim/dex.mjs` (`getHiddenPower`), `sim/dex-formats.mjs`
  (`get`, `extend`, `validate`), `sim/team-validator.mjs` (Gen 1-2 DV/gender/shiny checks, adjust
  level), `sim/tools/random-player-ai.mjs`, `config/formats.mjs` (custom game formats),
  `data/rulesets.mjs` (rule descriptions), `data/mods/gen1/scripts.mjs` (1/256 miss);
  `@pkmn/sim` README (divergences, `Dex.formats.extend`); `@pkmn/client` README.
* smogon/pokemon-showdown master (fetched 2026-10-24): `sim/SIMULATOR.md`, `sim/SIM-PROTOCOL.md`,
  `sim/TEAMS.md`, `PROTOCOL.md`, `server/room-battle.ts` (timer constants, `checkTimeout`,
  `forfeitPlayer`, `onConnect`, rqid handling).
* pret: `pokered/home/move_mon.asm` (`CalcStat`), `pokecrystal/engine/pokemon/move_mon.asm`
  (`CalcMonStatC`), `pokecrystal/engine/math/get_square_root.asm`,
  `pokecrystal/engine/pokemon/mon_stats.asm` (`GetGender`), `pokecrystal/engine/gfx/color.asm`
  (`CheckShininess`), `pokered/data/trainers/parties.asm` etc. (existence only),
  `pokecrystal/constants/pokemon_data_constants.asm` (gender ratio constants).
* npm registry (`npm view <pkg> version license time dist.unpackedSize`), `npm audit`, GitHub REST
  API (`/repos/pkmn/ps`, `/repos/smogon/pokemon-showdown`, `/repos/PokeAPI/sprites`, commits).
* PokeAPI/sprites: `README.md`, `LICENCE.txt`, the tree at `97a7832d307311c0e1c6ea9035308bf80cc94f81`;
  PokeAPI `data/v2/csv/pokemon.csv` (form ids).
* play.pokemonshowdown.com/sprites/ index page and HTTP headers; curl status codes in 5.2.
* `smogon/pokemon-showdown-client` README (AGPLv3 notice), fetched by the interrupted run
  (`psclient/README.md`).
* Bulbapedia "Stat" article for the Garchomp example: not fetchable (HTTP 403); numbers verified
  by computation instead.



