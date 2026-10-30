# Pokémon Matrix Widget

Vibecoded by JBro:dewrito.net

A Matrix room widget for a Pokémon community: a shared **Home** for Pokémon from Generations 1–5, **trading**
between people in the room, and **battles** with the Pokémon you actually raised. It works from save files, so it
covers cartridge dumps, emulators, RetroArch, Switch Online and the PC ports and recompilations alike.

* **Home**: open your save in the widget, deposit Pokémon into your cloud boxes, download the updated save. Withdraw
  them later into any save of the same generation, or into a newer one the way the games allow it
  (Time Capsule, Pal Park, Poké Transfer).
* **Trading**: offer a Pokémon to someone in the room or to everyone, answer offers, both confirm, and the server
  swaps them in one step. Trade evolutions happen the way each Pokémon's own game does them.
* **Battling**: challenge someone in the room or practise against the CPU, with teams from your Home or straight
  from a save, on the Pokémon Showdown simulator with Gen 1–5 rules. Stats match the cartridge exactly.
* **Room life**: who is online and what they are doing, optional announcements of trades and battles in the room,
  and a read-only "showroom" link to show your collection to anyone.

**Your save never leaves your browser.** It is read and edited locally; only the Pokémon you move are sent to the
server.

## Supported games and files

| Generation | Games | Notes |
|---|---|---|
| 1 | Red, Blue, Yellow (international and Japanese) | |
| 2 | Gold, Silver, Crystal (international, Japanese; Korean Gold/Silver read-only) | |
| 3 | Ruby, Sapphire, Emerald, FireRed, LeafGreen (international, Japanese) | Switch FireRed/LeafGreen saves should work (untested) |
| 4 | Diamond, Pearl, Platinum, HeartGold, SoulSilver (international, Japanese, Korean) | Platinum PC port `save.bin` |
| 5 | Black, White, Black 2, White 2 (international, Japanese) | Frigate (Black 2/White 2 PC port) |

The file can be any emulator's save (`.sav`, `.srm`, `.dsv`, `.dat`, `save.bin`, ...): clock data and emulator
headers or footers (mGBA, VBA-M, SameBoy, BGB, DeSmuME, No$GBA, RetroArch including compressed saves, Switch
Online, 3DS Virtual Console) are recognised and put back exactly when you download. The widget's "Where is my save
file?" help lists where each emulator and port keeps them. Saves from games with their own formats (Gen1Recomp /
G1R Deluxe, ROM hacks such as pokeemerald-expansion) are refused with an explanation.

Always **close the game or emulator** before you open a save and before you replace it with the downloaded one,
and keep a backup of your original file.

## Matrix setup

Host the widget (see Deploy), then add it to a room. In Element Web or Desktop:

```
/addwidget https://pokemon.example.org/?theme=$org.matrix.msc2873.client_theme
```

The first time, the Matrix client asks each person to let the widget read the room's members and to confirm their
identity (OpenID). The server checks that identity with the person's own homeserver, so nobody can pretend to be
someone else.

* **Element Web/Desktop, Commet, Vommet** show room widgets.
* **Element X, Cinny, FluffyChat** don't. Their users open the widget's address in a browser and sign in with a
  code the server's bot sends them by Matrix DM (needs `MATRIX_BOT_TOKEN`, below). Inside a widget, "Open in
  browser tab" in the account menu hands the session to a normal tab.
* **Room announcements** are off by default; each person can turn them on in the account menu, and their Matrix
  client asks them to allow it.

## Deploy

Needs a host with Docker and a DNS name pointing at it.

```bash
cp .env.example .env          # set WIDGET_HOST, and optionally the bot and the other settings
cd deploy && docker compose --env-file ../.env up -d --build
```

That runs the widget behind Caddy, which gets the HTTPS certificate. Data lives in the `widget_data` volume
(one SQLite file); back it up. All settings are environment variables documented at the top of
[server/config.js](server/config.js) and in [.env.example](.env.example). The important ones:

| Variable | What it does |
|---|---|
| `ALLOWED_HOMESERVERS` | Only these Matrix servers may sign in. |
| `REQUIRE_ROOM` + `MATRIX_BOT_TOKEN` + `MATRIX_BOT_HOMESERVER` | Only members of your community room may use the server; the bot also sends sign-in codes. |
| `UNOFFICIAL_TRANSFERS=1` | Allows the opt-in Gen 1/2 → Gen 3 conversion (no game can do this; converted Pokémon carry a permanent mark). |
| `FETCH_SPRITES=1` | Builds the image with self-hosted sprites (default); `0` loads them from GitHub. |

Without Docker: Node 22.13 or newer, `npm ci --omit=dev`, `node server/index.js` behind any HTTPS reverse proxy
(set `TRUST_PROXY=1` there and `PUBLIC_URL`). For self-hosted sprites run `scripts/fetch-sprites.sh /srv/sprites`
and set `SPRITES_DIR=/srv/sprites`.

The page must be served over HTTPS for Matrix clients to embed it. It sends `frame-ancestors * vector:` so Element
Desktop can embed it too, and a strict Content-Security-Policy.

## Development

```bash
npm install
npm test                       # ~460 tests, about 30 s
scripts/dev.sh                 # http://127.0.0.1:8090/dev/fake-matrix.html: two users in a fake Matrix client
```

`DEV_AUTH=1` (set by `scripts/dev.sh`) accepts fake sign-ins and refuses to run with `NODE_ENV=production`.

* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the contract the code follows: record formats, module APIs,
  the HTTP and WebSocket APIs.
* [docs/research/](docs/research/) holds the save-format specifications (checked against the pret
  disassemblies) and the research behind the transfer rules, the battle engine and the Matrix integration.
* [tools/pkhex-oracle/](tools/pkhex-oracle/) builds test saves with PKHeX.Core and
  [tools/fuzz/](tools/fuzz/) compares our save editors with PKHeX on random saves. Both are development-only
  (they need the .NET 8 SDK) and are not part of the widget.

## Status

Every save format was checked against PKHeX: the committed test saves cover all 20 layouts, and random fuzzing
(342 saves, about 20,000 edits) found no difference. **It has not yet been tried with saves from real games
played by real people.** Keep backups, and please report any save that doesn't open or comes back wrong.

Not done here on purpose: moves a Pokémon would learn when it evolves in a trade, FireRed/LeafGreen's
"no National Dex yet" check, and any form of legality checking. A server cannot stop someone cloning Pokémon by
copying their save file; it marks a Pokémon "seen before" when the same one shows up twice, so trade partners
can see it.

## Credits and licences

The code is MIT licensed ([LICENSE](LICENSE)). It includes:

* [matrix-widget-api](https://github.com/matrix-org/matrix-widget-api) (Apache-2.0), in `web/vendor/`;
* [fzstd](https://github.com/101arrowz/fzstd) (MIT), in `web/vendor/`;
* game data generated from [PokeAPI](https://github.com/PokeAPI/pokeapi) (BSD-3-Clause, notice in
  `shared/data/LICENSE.pokeapi`), checked against the [pret](https://github.com/pret) disassemblies;
* battles run on [@pkmn/sim](https://github.com/pkmn/ps) (MIT), the Pokémon Showdown simulator.

**Sprites** are © Nintendo / Creatures Inc. / GAME FREAK inc., fetched from
[PokeAPI/sprites](https://github.com/PokeAPI/sprites) at deploy time and not part of this repository.

Pokémon and all related names are trademarks of Nintendo, Creatures Inc. and GAME FREAK inc. This is a fan
project, not affiliated with or endorsed by them. It ships no game data: players bring their own saves.
