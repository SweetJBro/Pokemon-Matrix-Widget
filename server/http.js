/* Minimal router and JSON helpers. Feature modules register routes with
     app.get(path, handler, opts) / app.post / app.put / app.del
   where path segments starting with ":" are parameters and handler is
     async (ctx) => result
   ctx = { req, res, url, params, query, body, user, config, db, hub }.
   A returned value is sent as 200 JSON (undefined -> 204). Throw HttpError for anything else.
   opts.auth defaults to true: the request must carry "Authorization: Bearer <session token>". */

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJson(req, limit = 1 << 20) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString("utf8")); } catch { throw new HttpError(400, "Body is not valid JSON"); }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, path, handler, opts = {}) {
    const parts = path.split("/").filter(Boolean);
    this.routes.push({ method, parts, handler, auth: opts.auth !== false, bodyLimit: opts.bodyLimit || (1 << 20) });
  }
  get(p, h, o) { this.add("GET", p, h, o); }
  post(p, h, o) { this.add("POST", p, h, o); }
  put(p, h, o) { this.add("PUT", p, h, o); }
  del(p, h, o) { this.add("DELETE", p, h, o); }

  match(method, pathname) {
    let segs;
    try { segs = pathname.split("/").filter(Boolean).map(decodeURIComponent); }
    catch { throw new HttpError(400, "Bad URL encoding"); }   // "%E0%A4%A" would otherwise be a 500
    let methodMismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i].startsWith(":")) params[r.parts[i].slice(1)] = segs[i];
        else if (r.parts[i] !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (r.method !== method) { methodMismatch = true; continue; }
      return { route: r, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }
}

/** Fixed-window per-key rate limiter (in memory). */
export class RateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  check(key) {
    const now = Date.now();
    let h = this.hits.get(key);
    if (!h || now - h.start > this.windowMs) { h = { start: now, n: 0 }; this.hits.set(key, h); }
    if (++h.n > this.max) throw new HttpError(429, "Too many requests, slow down");
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (now - v.start > this.windowMs) this.hits.delete(k);
  }
}
