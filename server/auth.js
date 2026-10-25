/* Matrix identity. See docs/research/matrix-widget.md §2 and §4.

   1. Widget login: the widget asks its Matrix client for an OpenID token (matrix-widget-api
      requestOpenIDConnectToken, MSC1960) and posts it here. We resolve the user's federation
      endpoint (spec "Resolving server names": well-known delegation, SRV, port 8448), call
      /_matrix/federation/v1/openid/userinfo, and trust "sub" only if its server part equals the
      token's matrix_server_name byte for byte. Then we issue our own bearer token (not a cookie:
      the widget is a third-party iframe and its cookies are partitioned or blocked).
   2. Handoff: a signed-in widget can mint a single-use, 2-minute code and open the page in a real
      browser tab (pop-out, downloads, clients with incognito widget windows).
   3. Bot code: for clients without widgets (Element X, Cinny, FluffyChat) a bot account DMs a
      one-time code to the Matrix ID the user typed. Enabled when MATRIX_BOT_TOKEN is set.

   matrix_server_name comes from the client, so fetching it is an SSRF vector: every address is
   filtered through a BlockList inside the socket's own lookup (the address we check is the one we
   connect to), only HTTPS is used, redirects/sizes/timeouts are capped, and ALLOWED_HOMESERVERS
   can pin the list. ALLOW_PRIVATE_HOMESERVERS=1 lifts the address filter for a LAN homeserver;
   MATRIX_FEDERATION_OVERRIDES maps server names to fixed base URLs for tests. */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { HttpError, RateLimiter } from "./http.js";

export const USER_ID_RE = /^@([a-z0-9._=\-/+]+):((?:[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?)$/;
const SERVER_NAME_RE = /^(?:[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

export function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }

/* ---------- outbound requests that cannot reach private networks ---------- */

const BLOCKED = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]]) BLOCKED.addSubnet(a, p, "ipv4");
// IPv4 rules also match their ::ffff: forms; never add ::ffff:0:0/96 (it would block all IPv4).
for (const [a, p] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]])
  BLOCKED.addSubnet(a, p, "ipv6");

export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  return family ? BLOCKED.check(ip, family === 4 ? "ipv4" : "ipv6") : true;
}

function safeLookup(allowPrivate) {
  return (host, opts, cb) => {
    dns.lookup(host, { all: true, verbatim: true }).then((addrs) => {
      const ok = allowPrivate ? addrs : addrs.filter((a) => !isBlockedAddress(a.address));
      if (!ok.length) { const e = new Error(`${host} resolves only to private addresses`); e.code = "EBLOCKED"; throw e; }
      if (opts && opts.all) cb(null, ok); else cb(null, ok[0].address, ok[0].family);
    }).catch((e) => cb(e));
  };
}

/** GET returning { status, headers, json }. target = { url?, connectHost, port, tlsName, hostHeader }. */
function getJson(target, path, opts) {
  const insecure = target.protocol === "http:";
  if (insecure && !target.override) return Promise.reject(new Error("plain HTTP is only allowed for overrides"));
  const mod = insecure ? http : https;
  const literal = net.isIP(target.connectHost);
  if (literal && !opts.allowPrivate && !target.override && isBlockedAddress(target.connectHost))
    return Promise.reject(Object.assign(new Error(`${target.connectHost} is a private address`), { code: "EBLOCKED" }));
  return new Promise((resolve, reject) => {
    const req = mod.request({
      host: target.connectHost, port: target.port, path, method: "GET",
      // TLS is checked against servername (the delegated or original name), not the SRV target.
      servername: net.isIP(target.tlsName) ? undefined : target.tlsName,
      headers: { host: target.hostHeader, accept: "application/json", "user-agent": "pokemon-matrix-widget" },
      lookup: literal || target.override ? undefined : safeLookup(opts.allowPrivate),
      timeout: 8000,
    }, (res) => {
      let size = 0; const chunks = [];
      res.on("data", (c) => { size += c.length; if (size > 65536) { req.destroy(new Error("response too large")); return; } chunks.push(c); });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function splitHostPort(s) {
  const m = s.match(/^(\[[^\]]+\]|[^:\[\]]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host: m[1].replace(/^\[|\]$/g, ""), port };
}

async function srv(name) {
  for (const prefix of ["_matrix-fed._tcp.", "_matrix._tcp."]) {
    try {
      const recs = await dns.resolveSrv(prefix + name);
      if (recs.length) {
        recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
        return { host: recs[0].name.replace(/\.$/, ""), port: recs[0].port };
      }
    } catch { /* no record: next step */ }
  }
  return null;
}

/** .well-known/matrix/server with up to 3 redirects (each hop re-validated). Returns m.server or null. */
async function wellKnown(host, opts) {
  let url = new URL(`https://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}/.well-known/matrix/server`);
  for (let hop = 0; hop <= 3; hop++) {
    if (url.protocol !== "https:") return null;
    const h = url.hostname.replace(/^\[|\]$/g, "");
    const r = await getJson({ protocol: "https:", connectHost: h, port: Number(url.port || 443), tlsName: h, hostHeader: url.host }, url.pathname + url.search, opts);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { url = new URL(r.headers.location, url); continue; }
    if (r.status === 200 && r.json && typeof r.json["m.server"] === "string" && SERVER_NAME_RE.test(r.json["m.server"])) return r.json["m.server"];
    return null;
  }
  return null;
}

/** Matrix server discovery (Server-Server API, "Resolving server names"). */
export async function resolveFederation(serverName, opts) {
  const override = opts.overrides && opts.overrides.get(serverName);
  if (override) {
    const u = new URL(override);
    return { protocol: u.protocol, connectHost: u.hostname, port: Number(u.port || (u.protocol === "http:" ? 80 : 443)), tlsName: u.hostname, hostHeader: u.host, basePath: u.pathname.replace(/\/$/, ""), override: true };
  }
  const hp = splitHostPort(serverName);
  if (!hp) throw new Error("bad server name");
  const t = (connectHost, port, tlsName, hostHeader) => ({ protocol: "https:", connectHost, port, tlsName, hostHeader, basePath: "" });
  if (net.isIP(hp.host)) return t(hp.host, hp.port || 8448, hp.host, serverName);
  if (hp.port) return t(hp.host, hp.port, hp.host, serverName);
  let delegated = null;
  try { delegated = await wellKnown(hp.host, opts); } catch { /* fall through to SRV / 8448 */ }
  const d = delegated && splitHostPort(delegated);
  if (d) {
    if (net.isIP(d.host)) return t(d.host, d.port || 8448, d.host, delegated);
    if (d.port) return t(d.host, d.port, d.host, delegated);
    const s = await srv(d.host);
    return s ? t(s.host, s.port, d.host, d.host) : t(d.host, 8448, d.host, d.host);
  }
  const s = await srv(hp.host);
  return s ? t(s.host, s.port, hp.host, hp.host) : t(hp.host, 8448, hp.host, hp.host);
}

/** Bounded TTL cache (insertion order eviction). */
class TtlCache {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { const e = this.m.get(k); if (!e) return undefined; if (e.until < Date.now()) { this.m.delete(k); return undefined; } return e.v; }
  set(k, v, ttlMs) { this.m.delete(k); this.m.set(k, { v, until: Date.now() + ttlMs }); if (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
}

/* ---------- sessions and login flows ---------- */

export function createAuth({ db, config }) {
  db.raw.exec(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      code_hash   TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,              -- handoff | dm
      user_id     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS bot_dms (user_id TEXT PRIMARY KEY, room_id TEXT NOT NULL);`);

  const fedCache = new TtlCache(10000);
  const tokenCache = new TtlCache(10000);
  const memberCache = new TtlCache(16);
  const ipLimit = new RateLimiter(30, 60_000);
  const serverLimit = new RateLimiter(60, 60_000);
  const codeLimit = new RateLimiter(3, 600_000);
  const fedOpts = { allowPrivate: config.allowPrivateHomeservers, overrides: config.federationOverrides };

  function upsertUser(id, displayName) {
    const now = Date.now();
    db.run(`INSERT INTO users (id, display_name, created_at, last_seen) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET display_name = COALESCE(excluded.display_name, users.display_name), last_seen = excluded.last_seen`,
      id, displayName || null, now, now);
    return db.get("SELECT id, display_name AS displayName FROM users WHERE id = ?", id);
  }

  function issueSession(userId) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    db.run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      sha256(token), userId, now, now + config.sessionHours * 3600_000);
    return token;
  }

  function userForToken(token) {
    if (!token || token.length > 200) return null;
    const row = db.get(`SELECT u.id, u.display_name AS displayName, s.expires_at AS expiresAt
                        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha256(token));
    if (!row || row.expiresAt < Date.now()) return null;
    return { id: row.id, displayName: row.displayName };
  }

  function bearer(req) {
    const m = (req.headers.authorization || "").match(/^Bearer\s+(\S+)$/i);
    return m ? m[1] : null;
  }
  function userFromRequest(req) { return userForToken(bearer(req)); }

  /* ----- bot account (membership gate, DM login codes) ----- */

  async function botFetch(method, path, body) {
    const r = await fetch(config.botHomeserver + path, {
      method, signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${config.botToken}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new HttpError(503, `Matrix bot request failed (${r.status})`);
    return r.json();
  }

  async function checkMembership(userId) {
    if (!config.requireRoom) return;
    let members = memberCache.get(config.requireRoom);
    if (!members) {
      const j = await botFetch("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(config.requireRoom)}/joined_members`);
      members = new Set(Object.keys(j.joined || {}));
      memberCache.set(config.requireRoom, members, 60_000);
    }
    if (!members.has(userId)) throw new HttpError(403, "This server is only open to members of its community room");
  }

  async function dmRoomFor(userId) {
    const row = db.get("SELECT room_id AS roomId FROM bot_dms WHERE user_id = ?", userId);
    if (row) return row.roomId;
    const j = await botFetch("POST", "/_matrix/client/v3/createRoom", { is_direct: true, invite: [userId], preset: "trusted_private_chat", name: "Pokémon Home login" });
    db.run("INSERT OR REPLACE INTO bot_dms (user_id, room_id) VALUES (?, ?)", userId, j.room_id);
    return j.room_id;
  }

  /* ----- OpenID ----- */

  async function verifyOpenId(openid, ip) {
    if (!openid || typeof openid.access_token !== "string" || typeof openid.matrix_server_name !== "string")
      throw new HttpError(400, "Missing OpenID token");
    const serverName = openid.matrix_server_name;
    const token = openid.access_token;
    if (!SERVER_NAME_RE.test(serverName) || serverName.length > 255 || !/^[\x21-\x7e]{1,1024}$/.test(token))
      throw new HttpError(400, "Malformed OpenID token");
    if (config.devAuth && token.startsWith("dev:")) {
      const sub = token.slice(4);
      if (!USER_ID_RE.test(sub)) throw new HttpError(400, "Bad dev user id");
      return sub;
    }
    if (config.allowedHomeservers && !config.allowedHomeservers.has(serverName.toLowerCase()))
      throw new HttpError(403, `Homeserver ${serverName} is not allowed on this server`);
    const cacheKey = sha256(serverName + "\n" + token);
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;
    serverLimit.check(serverName);
    let res;
    try {
      let target = fedCache.get(serverName);
      if (!target) { target = await resolveFederation(serverName, fedOpts); fedCache.set(serverName, target, 4 * 3600_000); }
      res = await getJson(target, (target.basePath || "") + "/_matrix/federation/v1/openid/userinfo?" + new URLSearchParams({ access_token: token }), fedOpts);
    } catch (e) {
      if (e.code === "EBLOCKED") throw new HttpError(403, `Homeserver ${serverName} is on a private network (ALLOW_PRIVATE_HOMESERVERS=1 allows it)`);
      throw new HttpError(502, `Could not reach homeserver ${serverName} (${e.code || e.message})`);
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(401, "Your homeserver rejected the sign-in token; reopen the widget to get a fresh one");
    if (res.status !== 200 || !res.json || typeof res.json.sub !== "string") throw new HttpError(502, `Homeserver ${serverName} answered ${res.status}`);
    const sub = res.json.sub;
    const m = sub.length <= 255 && sub.match(USER_ID_RE);
    if (!m || m[2] !== serverName) throw new HttpError(401, "The sign-in token belongs to a different server");
    const ttl = Math.min(Number(openid.expires_in) || 3600, 3600) * 1000 - 60_000;
    if (ttl > 0) tokenCache.set(cacheKey, sub, ttl);
    return sub;
  }

  function newCode(kind, userId, ttlMs, digits) {
    const code = digits ? String(crypto.randomInt(0, 10 ** digits)).padStart(digits, "0") : crypto.randomBytes(24).toString("base64url");
    db.run("INSERT OR REPLACE INTO auth_codes (code_hash, kind, user_id, expires_at) VALUES (?, ?, ?, ?)",
      sha256(kind + ":" + (digits ? userId + ":" : "") + code), kind, userId, Date.now() + ttlMs);
    return code;
  }
  function takeCode(kind, code, userId) {
    const hash = sha256(kind + ":" + (userId ? userId + ":" : "") + code);
    const row = db.get("SELECT user_id AS userId, expires_at AS expiresAt FROM auth_codes WHERE code_hash = ? AND kind = ?", hash, kind);
    if (!row || row.expiresAt < Date.now()) return null;
    db.run("DELETE FROM auth_codes WHERE code_hash = ?", hash);
    return row.userId;
  }

  function register(app) {
    app.post("/api/auth/openid", async (ctx) => {
      ipLimit.check(ctx.ip);
      const userId = await verifyOpenId(ctx.body.openid, ctx.ip);
      await checkMembership(userId);
      const user = upsertUser(userId, cleanName(ctx.body.displayName));
      return { token: issueSession(user.id), user };
    }, { auth: false });

    // Widget -> real browser tab. The code goes in the URL fragment so it never reaches logs.
    app.post("/api/auth/handoff", (ctx) => ({ code: newCode("handoff", ctx.user.id, 120_000), expiresIn: 120 }));
    app.post("/api/auth/handoff/redeem", (ctx) => {
      ipLimit.check(ctx.ip);
      const userId = takeCode("handoff", String(ctx.body.code || ""));
      if (!userId) throw new HttpError(401, "That link has expired; open it again from the widget");
      const user = upsertUser(userId, null);
      return { token: issueSession(user.id), user };
    }, { auth: false });

    app.get("/api/auth/methods", () => ({ openid: true, dmCode: !!(config.botToken && config.botHomeserver), dev: config.devAuth }), { auth: false });

    if (config.botToken && config.botHomeserver) {
      app.post("/api/auth/code/request", async (ctx) => {
        ipLimit.check(ctx.ip);
        const userId = String(ctx.body.userId || "").trim();
        if (!USER_ID_RE.test(userId)) throw new HttpError(400, "Enter your full Matrix ID, like @name:example.org");
        if (config.allowedHomeservers && !config.allowedHomeservers.has(userId.slice(userId.indexOf(":") + 1).toLowerCase()))
          throw new HttpError(403, "That homeserver is not allowed on this server");
        codeLimit.check(userId);
        await checkMembership(userId);
        const code = newCode("dm", userId, 600_000, 6);
        const roomId = await dmRoomFor(userId);
        await botFetch("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${crypto.randomUUID()}`, {
          msgtype: "m.text",
          body: `Your Pokémon Home sign-in code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this message.`,
        });
        return { sent: true };
      }, { auth: false });

      app.post("/api/auth/code/verify", (ctx) => {
        ipLimit.check(ctx.ip);
        const userId = String(ctx.body.userId || "").trim();
        const code = String(ctx.body.code || "").replace(/\D/g, "");
        const live = db.get("SELECT attempts FROM auth_codes WHERE kind = 'dm' AND user_id = ? AND expires_at > ?", userId, Date.now());
        if (!live) throw new HttpError(401, "No code is pending for that Matrix ID; request a new one");
        if (live.attempts >= 5) throw new HttpError(429, "Too many wrong codes; request a new one");
        if (!takeCode("dm", code, userId)) {
          db.run("UPDATE auth_codes SET attempts = attempts + 1 WHERE kind = 'dm' AND user_id = ?", userId);
          throw new HttpError(401, "Wrong code");
        }
        db.run("DELETE FROM auth_codes WHERE kind = 'dm' AND user_id = ?", userId);
        const user = upsertUser(userId, null);
        return { token: issueSession(user.id), user };
      }, { auth: false });
    }

    if (config.devAuth) {
      app.post("/api/auth/dev", (ctx) => {
        const userId = String(ctx.body.userId || "");
        if (!USER_ID_RE.test(userId)) throw new HttpError(400, "userId must look like @name:server");
        const user = upsertUser(userId, cleanName(ctx.body.displayName));
        return { token: issueSession(user.id), user };
      }, { auth: false });
    }

    app.get("/api/me", (ctx) => ({ user: ctx.user }));
    app.post("/api/auth/logout", (ctx) => {
      const t = bearer(ctx.req);
      if (t) db.run("DELETE FROM sessions WHERE token_hash = ?", sha256(t));
    });
  }

  function cleanName(n) {
    if (typeof n !== "string" || n.startsWith("$")) return null;   // unsubstituted URL template
    const s = n.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 64);
    return s || null;
  }

  function prune() {
    db.run("DELETE FROM sessions WHERE expires_at < ?", Date.now());
    db.run("DELETE FROM auth_codes WHERE expires_at < ?", Date.now());
  }

  return { register, userFromRequest, userForToken, upsertUser, issueSession, verifyOpenId, prune };
}
