/* Showroom: an opt-in, read-only link to some of a player's Home boxes, for showing off a
   collection to people outside the room (no sign-in needed to look).

   The link carries a random token in the URL fragment (showroom.html#<token>), so it never reaches
   server or proxy logs; the page sends it in the request path. Off by default; the owner picks
   which boxes are shown, and "new link" replaces the token, which revokes every copy of the old one.
   The public listing has only what the boxes show: species, nickname, level, gender, shininess,
   item, generation and OT name. No record bytes, trainer IDs, locks or trades.

     GET  /api/showroom               (owner) -> { enabled, token, boxes: [index] | null }
     POST /api/showroom               (owner) { enabled, boxes? } -> same
     POST /api/showroom/rotate        (owner) -> same, with a new token
     GET  /api/showroom/view/:token   (anyone) -> { owner, boxes: [{ index, name, mons: [{ slot, format, summary }] }], counts } */
import crypto from "node:crypto";
import { HttpError } from "./http.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS showrooms (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  token       TEXT NOT NULL UNIQUE,
  enabled     INTEGER NOT NULL DEFAULT 0,
  boxes       TEXT,                    -- JSON list of box indices, null = every box
  updated_at  INTEGER NOT NULL
);`;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const newToken = () => crypto.randomBytes(18).toString("base64url");

export function register(app, { db, config }) {
  db.raw.exec(SCHEMA);
  const BOXES = config.homeBoxes;

  function settings(uid) {
    let row = db.get("SELECT * FROM showrooms WHERE user_id = ?", uid);
    if (!row) {
      db.run("INSERT INTO showrooms (user_id, token, enabled, boxes, updated_at) VALUES (?, ?, 0, NULL, ?)", uid, newToken(), Date.now());
      row = db.get("SELECT * FROM showrooms WHERE user_id = ?", uid);
    }
    return { enabled: !!row.enabled, token: row.token, boxes: row.boxes ? JSON.parse(row.boxes) : null };
  }

  app.get("/api/showroom", (ctx) => settings(ctx.user.id));

  app.post("/api/showroom", (ctx) => {
    const uid = ctx.user.id;
    settings(uid);
    const { enabled, boxes } = ctx.body;
    let list = null;
    if (Array.isArray(boxes)) {
      list = [...new Set(boxes)].filter((b) => Number.isInteger(b) && b >= 0 && b < BOXES).sort((a, b) => a - b);
      if (!list.length) throw new HttpError(400, "Choose at least one box to show");
    }
    db.run("UPDATE showrooms SET enabled = ?, boxes = ?, updated_at = ? WHERE user_id = ?", enabled ? 1 : 0, list ? JSON.stringify(list) : null, Date.now(), uid);
    return settings(uid);
  });

  app.post("/api/showroom/rotate", (ctx) => {
    settings(ctx.user.id);
    db.run("UPDATE showrooms SET token = ?, updated_at = ? WHERE user_id = ?", newToken(), Date.now(), ctx.user.id);
    return settings(ctx.user.id);
  });

  app.get("/api/showroom/view/:token", (ctx) => {
    const token = String(ctx.params.token || "");
    const row = TOKEN_RE.test(token) && db.get("SELECT s.user_id AS uid, s.boxes, s.enabled, u.display_name AS name FROM showrooms s JOIN users u ON u.id = s.user_id WHERE s.token = ?", token);
    // Same answer for "no such link" and "turned off", so a link's existence leaks nothing.
    if (!row || !row.enabled) throw new HttpError(404, "This showroom link is not active");
    const shown = row.boxes ? new Set(JSON.parse(row.boxes)) : null;
    const names = new Map(db.all("SELECT box, name FROM home_boxes WHERE user_id = ?", row.uid).map((r) => [r.box, r.name]));
    const boxes = new Map();
    for (const m of db.all("SELECT box, slot, format, view FROM home_mons WHERE owner = ? ORDER BY box, slot", row.uid)) {
      if (m.box < 0 || (shown && !shown.has(m.box))) continue;
      if (!boxes.has(m.box)) boxes.set(m.box, { index: m.box, name: names.get(m.box) || `Box ${m.box + 1}`, mons: [] });
      const s = JSON.parse(m.view);
      boxes.get(m.box).mons.push({ slot: m.slot, format: m.format, summary: { ...s, ot: { name: s.ot?.name ?? "" } } });
    }
    const list = [...boxes.values()];
    const all = list.flatMap((b) => b.mons);
    ctx.res.setHeader("x-robots-tag", "noindex");
    return {
      owner: row.name || row.uid.replace(/^@|:.*$/g, ""), boxSlots: 30, boxes: list,
      counts: { pokemon: all.length, shiny: all.filter((m) => m.summary.shiny).length, species: new Set(all.map((m) => m.summary.species)).size },
    };
  }, { auth: false });
}
