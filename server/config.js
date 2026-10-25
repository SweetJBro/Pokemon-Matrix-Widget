/* Server configuration from the environment.

   PORT                      listen port (default 8090)
   HOST                      bind address (default 0.0.0.0; 127.0.0.1 keeps a dev server off the LAN)
   TRUST_PROXY=1             take the client address from X-Forwarded-For (set it only behind your own proxy)
   DB_FILE                   SQLite file (default ./data/pokemon.db)
   PUBLIC_URL                public URL of the widget page (for links in room messages)
   BASE_PATH                 path prefix when served behind a sub-path (default "/")
   ALLOWED_HOMESERVERS       comma-separated Matrix server names allowed to log in (default: any public one)
   ALLOW_PRIVATE_HOMESERVERS=1  allow homeservers on private/loopback addresses (LAN Synapse)
   REQUIRE_ROOM              room ID whose members may use this server (needs MATRIX_BOT_TOKEN + MATRIX_BOT_HOMESERVER)
   MATRIX_BOT_TOKEN          access token of a bot account joined to REQUIRE_ROOM
   MATRIX_BOT_HOMESERVER     client-server base URL of that bot's homeserver, e.g. https://matrix.example.org
   DEV_AUTH=1                accept fake OpenID tokens ("dev:@user:server") and /api/auth/dev; never in production
   UNOFFICIAL_TRANSFERS=1    allow Gen 1/2 -> Gen 3 conversions (no such path exists in the real games)
   SPRITE_BASE               base URL of a copy of PokeAPI/sprites' sprites/pokemon/ tree, ending in "/". Default:
                             "sprites/pokemon/" (relative to the page) when SPRITES_DIR is set, else
                             raw.githubusercontent.com at SPRITES_COMMIT (fine for development, not a CDN).
                             jsDelivr refuses the repository (50 MB package limit); "" turns sprites off
   SPRITES_DIR               directory filled by scripts/fetch-sprites.sh (it holds pokemon/versions/...);
                             served at /sprites/ when set
   HOME_BOXES                number of Home boxes per user (default 40)
   SESSION_HOURS             bearer token lifetime (default 24; the widget silently re-runs OpenID after that)
   MATRIX_FEDERATION_OVERRIDES  tests only: "example.org=http://127.0.0.1:9000/fake,..." skips discovery for those names */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");

/** PokeAPI/sprites commit the development default and scripts/fetch-sprites.sh both pin. */
export const SPRITES_COMMIT = "97a7832d307311c0e1c6ea9035308bf80cc94f81";
const DEV_SPRITE_BASE = `https://raw.githubusercontent.com/PokeAPI/sprites/${SPRITES_COMMIT}/sprites/pokemon/`;

export function loadConfig(env = process.env) {
  let basePath = env.BASE_PATH || "/";
  if (!basePath.startsWith("/")) basePath = "/" + basePath;
  if (!basePath.endsWith("/")) basePath += "/";
  const list = (s) => (s ? new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) : null);
  const cfg = {
    port: Number(env.PORT || 8090),
    host: env.HOST || "0.0.0.0",
    trustProxy: env.TRUST_PROXY === "1",
    dbFile: env.DB_FILE || path.join(ROOT, "data", "pokemon.db"),
    publicUrl: env.PUBLIC_URL || null,
    basePath,
    allowedHomeservers: list(env.ALLOWED_HOMESERVERS),
    allowPrivateHomeservers: env.ALLOW_PRIVATE_HOMESERVERS === "1",
    requireRoom: env.REQUIRE_ROOM || null,
    botToken: env.MATRIX_BOT_TOKEN || null,
    botHomeserver: (env.MATRIX_BOT_HOMESERVER || "").replace(/\/+$/, "") || null,
    devAuth: env.DEV_AUTH === "1",
    unofficialTransfers: env.UNOFFICIAL_TRANSFERS === "1",
    spritesDir: env.SPRITES_DIR || null,
    spriteBase: env.SPRITE_BASE ?? (env.SPRITES_DIR ? "sprites/pokemon/" : DEV_SPRITE_BASE),
    homeBoxes: Math.max(1, Math.min(200, Number(env.HOME_BOXES || 40))),
    sessionHours: Number(env.SESSION_HOURS || 24),
    federationOverrides: null,
  };
  if (env.MATRIX_FEDERATION_OVERRIDES) {
    if (env.NODE_ENV === "production") throw new Error("MATRIX_FEDERATION_OVERRIDES is for tests and refuses to run with NODE_ENV=production");
    cfg.federationOverrides = new Map(env.MATRIX_FEDERATION_OVERRIDES.split(",").filter(Boolean).map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }));
  }
  if (cfg.devAuth && env.NODE_ENV === "production") throw new Error("DEV_AUTH=1 refuses to run with NODE_ENV=production");
  if (cfg.requireRoom && !(cfg.botToken && cfg.botHomeserver))
    throw new Error("REQUIRE_ROOM needs MATRIX_BOT_TOKEN and MATRIX_BOT_HOMESERVER");
  return cfg;
}

/** The subset of the config the browser sees at /config.json. */
export function publicConfig(cfg) {
  return {
    devAuth: cfg.devAuth,
    unofficialTransfers: cfg.unofficialTransfers,
    spriteBase: cfg.spriteBase,
    homeBoxes: cfg.homeBoxes,
    publicUrl: cfg.publicUrl,
    dmCodeLogin: !!(cfg.botToken && cfg.botHomeserver),
  };
}
