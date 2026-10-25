#!/usr/bin/env node
/* Pokémon Matrix Widget server: static widget, /shared modules, JSON API, WebSocket hub.
   Configuration: server/config.js. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, publicConfig, ROOT } from "./config.js";
import { openDb } from "./db.js";
import { createAuth } from "./auth.js";
import { createHub } from "./hub.js";
import { Router, HttpError, sendJson, readJson } from "./http.js";
import * as home from "./home.js";
import * as trades from "./trades.js";
import * as battles from "./battles.js";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".webp": "image/webp", ".gif": "image/gif",
};
const STATIC = [
  { prefix: "shared/", dir: path.join(ROOT, "shared") },
  { prefix: "", dir: path.join(ROOT, "web") },
];

export function createServer(config = loadConfig()) {
  const db = openDb(config.dbFile);
  const auth = createAuth({ db, config });
  const app = new Router();
  const server = http.createServer((req, res) => handle(req, res).catch((e) => fail(res, e)));
  const hub = createHub({ server, auth, config });
  const deps = { db, config, auth, hub };

  auth.register(app, deps);
  home.register(app, deps);
  trades.register(app, deps);
  battles.register(app, deps);

  // Self-hosted sprites (scripts/fetch-sprites.sh fills SPRITES_DIR from a pinned commit) at /sprites/.
  const statics = config.spritesDir
    ? [{ prefix: "sprites/", dir: path.resolve(config.spritesDir), cache: "public, max-age=604800", noSpa: true }, ...STATIC]
    : STATIC;

  const pruneTimer = setInterval(() => auth.prune(), 3600_000);
  pruneTimer.unref();

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    let p = url.pathname;
    if (!p.startsWith(config.basePath)) { res.writeHead(404); return res.end("not found"); }
    p = "/" + p.slice(config.basePath.length);

    if (p === "/healthz") { res.writeHead(200); return res.end("ok"); }
    if (p === "/config.json") return sendJson(res, 200, publicConfig(config));

    if (p.startsWith("/api/")) {
      const m = app.match(req.method, p);
      if (!m) throw new HttpError(404, "No such endpoint");
      if (m.methodMismatch) throw new HttpError(405, "Method not allowed");
      const user = auth.userFromRequest(req);
      if (m.route.auth && !user) throw new HttpError(401, "Not signed in");
      const body = (req.method === "POST" || req.method === "PUT") ? await readJson(req, m.route.bodyLimit) : {};
      const ctx = {
        req, res, url, params: m.params, query: url.searchParams, body, user, ...deps,
        // Only a reverse proxy we run (TRUST_PROXY=1) may set the client address; otherwise
        // anyone could spoof X-Forwarded-For past the per-IP rate limits.
        ip: (config.trustProxy && req.headers["x-forwarded-for"]?.split(",").pop().trim()) || req.socket.remoteAddress,
      };
      const result = await m.route.handler(ctx);
      if (res.headersSent) return;
      if (result === undefined) { res.writeHead(204); return res.end(); }
      return sendJson(res, 200, result);
    }
    return serveStatic(req, res, p);
  }

  function fail(res, e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(e);
    if (res.headersSent) { res.destroy(); return; }
    sendJson(res, status, { error: status >= 500 && !(e instanceof HttpError) ? "Internal error" : e.message, ...(e.extra || {}) });
  }

  function serveStatic(req, res, p) {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(p.slice(1)); } catch { res.writeHead(400); return res.end("bad URL encoding"); }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    const root = statics.find((s) => rel.startsWith(s.prefix));
    const file = path.normalize(path.join(root.dir, rel.slice(root.prefix.length)));
    if (!file.startsWith(root.dir + path.sep)) { res.writeHead(403); return res.end(); }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        // Extension-less paths are the single-page app; anything else is a 404.
        if (!root.noSpa && !path.basename(rel).includes(".")) return send(path.join(ROOT, "web", "index.html"));
        res.writeHead(404); return res.end("not found");
      }
      send(file);
    });
    function send(f) {
      const headers = {
        "content-type": TYPES[path.extname(f).toLowerCase()] || "application/octet-stream",
        "cache-control": root.cache || "no-cache",
        // Matrix clients iframe this page; frame-ancestors is deliberately open, no X-Frame-Options.
        // CSP3 "*" only matches http(s), so Element Desktop's vector://vector needs its own entry.
        "content-security-policy": "frame-ancestors * vector:",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      };
      const stream = fs.createReadStream(f);
      stream.on("open", () => { res.writeHead(200, headers); if (req.method === "HEAD") { stream.destroy(); res.end(); } else stream.pipe(res); });
      stream.on("error", () => { if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy(); });
      res.on("close", () => stream.destroy());
    }
  }

  return {
    server, db, hub, config,
    listen() { return new Promise((r) => server.listen(config.port, config.host, () => r(server.address()))); },
    async close() { hub.close(); battles.shutdown?.(deps); await new Promise((r) => server.close(r)); db.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server/index.js")) {
  const s = createServer();
  s.listen().then((a) => console.log(`Pokémon widget on http://${a.address}:${a.port}${s.config.basePath}${s.config.devAuth ? " (DEV_AUTH on)" : ""}`));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => s.close().then(() => process.exit(0)));
}
