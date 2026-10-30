/* Trades between two players' Home boxes (docs/ARCHITECTURE.md "Trade API").

   An offer locks the offered Pokémon (home_mons.locked_by = "trade:<id>"), so it cannot be
   moved, withdrawn, released or offered twice. An offer is either to one person or open to the
   room; answering it locks the answer and resets both confirmations, so nobody confirms a deal
   they have not seen. When both have confirmed, one transaction swaps the owners: each received
   Pokémon takes the slot the receiver's own Pokémon left (so a full Home can always trade), gets
   what receiving a trade does in its generation, and trade-evolves by that generation's rules
   (shared/pkm/evolve.js). The new bytes get a new fingerprint and the trade goes into the
   provenance of both Pokémon and the ledger.

   Offers that nobody finishes expire after TRADE_DAYS; expiring (like cancelling) unlocks both. */
import crypto from "node:crypto";
import { HttpError, RateLimiter } from "./http.js";
import { fingerprint } from "./records.js";
import { readRecord } from "../shared/pkm/index.js";
import { applyTrade, tradeEvolution } from "../shared/pkm/evolve.js";
import { codecFor } from "../shared/pkm/index.js";
import { summary } from "../shared/pkm/view.js";

const TRADE_DAYS = 7;
const MAX_OPEN = 20;
const EVERSTONE = 229;
const ROOM_RE = /^(!.{1,250}|standalone)$/;
const ACTIVE = "('open', 'answered')";

export function register(app, deps) {
  const { db, hub } = deps;
  const limiter = new RateLimiter(60, 60_000);
  const lock = (id) => `trade:${id}`;
  const now = () => Date.now();
  const nameOf = (userId) => db.get("SELECT display_name AS n FROM users WHERE id = ?", userId)?.n || null;

  /** One side of a trade for the client: who, and what (summary, format, flags, evolution preview). */
  function side(userId, monId, partnerMonId) {
    if (!userId) return null;
    const out = { user: userId, name: nameOf(userId), mon: null };
    const m = monId && db.get("SELECT * FROM home_mons WHERE id = ?", monId);
    if (!m) return out;
    const meta = { format: m.format, lang: m.lang, game: m.game };
    const partner = partnerMonId && db.get("SELECT record, format, lang, game FROM home_mons WHERE id = ?", partnerMonId);
    let evolves = null;
    if (partner) {
      const pv = readRecord(new Uint8Array(partner.record), { format: partner.format, lang: partner.lang, game: partner.game }).view;
      const t = tradeEvolution(codecFor(m.format).parse(new Uint8Array(m.record), meta), meta, { partnerSpecies: pv.species });
      if (t) evolves = { to: t.to, blockedBy: t.blockedBy };
    }
    out.mon = { id: m.id, format: m.format, game: m.game, summary: JSON.parse(m.view), flags: JSON.parse(m.provenance || "[]").map((p) => p.rule), evolves };
    return out;
  }

  function tradeOut(t) {
    return {
      id: t.id, roomId: t.room_id, status: t.status,
      from: side(t.from_user, t.from_mon, t.to_mon),
      to: t.to_user ? side(t.to_user, t.to_mon, t.from_mon) : null,
      wanted: JSON.parse(t.wanted || "null"),
      fromOk: !!t.from_ok, toOk: !!t.to_ok,
      createdAt: t.created_at, updatedAt: t.updated_at,
      result: JSON.parse(t.result || "null"),
    };
  }

  /** Tell everyone who should know: both parties, and the room while the offer is open. */
  function push(t) {
    const msg = { type: "trade", trade: tradeOut(t) };
    hub?.sendUser(t.from_user, msg);
    if (t.to_user) hub?.sendUser(t.to_user, msg);
    if (t.room_id && !t.to_user) hub?.broadcastRoom(t.room_id, msg);
    for (const u of [t.from_user, t.to_user].filter(Boolean)) hub?.sendUser(u, { type: "home", change: "trade" });
  }

  function unlockAll(t) {
    for (const m of [t.from_mon, t.to_mon].filter(Boolean)) db.run("UPDATE home_mons SET locked_by = NULL WHERE id = ? AND locked_by = ?", m, lock(t.id));
  }

  function expire() {
    const cutoff = now() - TRADE_DAYS * 86400_000;
    const old = db.all(`SELECT * FROM trades WHERE status IN ${ACTIVE} AND updated_at < ?`, cutoff);
    for (const t of old) db.tx(() => { unlockAll(t); db.run("UPDATE trades SET status = 'expired', updated_at = ? WHERE id = ?", now(), t.id); });
  }

  function getTrade(id) {
    const t = db.get("SELECT * FROM trades WHERE id = ?", String(id || ""));
    if (!t) throw new HttpError(404, "No such trade");
    return t;
  }
  const isParty = (t, uid) => t.from_user === uid || t.to_user === uid;

  /** The caller's own, unlocked Pokémon; locks it for trade `tradeId`. */
  function lockMine(uid, monId, tradeId) {
    const m = db.get("SELECT * FROM home_mons WHERE id = ?", String(monId || ""));
    if (!m || m.owner !== uid) throw new HttpError(404, "That Pokémon is not in your Home");
    if (m.locked_by) throw new HttpError(409, m.locked_by.startsWith("trade:") ? "That Pokémon is already offered in another trade" : "That Pokémon is busy (being withdrawn)");
    db.run("UPDATE home_mons SET locked_by = ? WHERE id = ?", lock(tradeId), m.id);
    return m;
  }

  app.get("/api/trades", (ctx) => {
    expire();
    const uid = ctx.user.id, roomId = ctx.query.get("roomId");
    const mine = db.all(`SELECT * FROM trades WHERE (from_user = ? OR to_user = ?) AND (status IN ${ACTIVE} OR updated_at > ?) ORDER BY updated_at DESC LIMIT 50`,
      uid, uid, now() - 86400_000);
    const open = roomId ? db.all(`SELECT * FROM trades WHERE room_id = ? AND status = 'open' AND to_user IS NULL AND from_user != ? ORDER BY created_at DESC LIMIT 50`, roomId, uid) : [];
    return { mine: mine.map(tradeOut), open: open.map(tradeOut) };
  });

  app.post("/api/trades", (ctx) => {
    const uid = ctx.user.id;
    limiter.check(uid);
    const { roomId, to = null, offerMonId, wanted = null } = ctx.body;
    if (typeof roomId !== "string" || !ROOM_RE.test(roomId)) throw new HttpError(400, "Trades happen in a room");
    if (to !== null && (typeof to !== "string" || !/^@.+:.+$/.test(to) || to.length > 255)) throw new HttpError(400, "Trade partner must be a Matrix user ID");
    if (to === uid) throw new HttpError(400, "You can't trade with yourself");
    if (to && !db.get("SELECT 1 FROM users WHERE id = ?", to)) throw new HttpError(404, "That person has not opened the widget yet, so they have no Home to trade from");
    const w = wanted && typeof wanted === "object" ? { species: Number.isInteger(wanted.species) ? wanted.species : undefined, note: typeof wanted.note === "string" ? wanted.note.slice(0, 140) : undefined } : null;
    const t = db.tx(() => {
      const count = db.get(`SELECT count(*) AS n FROM trades WHERE from_user = ? AND status IN ${ACTIVE}`, uid).n;
      if (count >= MAX_OPEN) throw new HttpError(429, `You already have ${MAX_OPEN} open trades; finish or cancel some first`);
      const id = crypto.randomBytes(9).toString("base64url");
      lockMine(uid, offerMonId, id);
      db.run(`INSERT INTO trades (id, room_id, from_user, to_user, from_mon, wanted, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
        id, roomId, uid, to, String(offerMonId), JSON.stringify(w), now(), now());
      return getTrade(id);
    });
    push(t);
    return tradeOut(t);
  });

  app.post("/api/trades/:id/answer", (ctx) => {
    const uid = ctx.user.id;
    limiter.check(uid);
    const t = db.tx(() => {
      const t0 = getTrade(ctx.params.id);
      if (!["open", "answered"].includes(t0.status)) throw new HttpError(409, "This trade is over");
      if (t0.from_user === uid) throw new HttpError(400, "You can't answer your own offer");
      if (t0.to_user && t0.to_user !== uid) throw new HttpError(403, "This offer is for someone else");
      if (t0.to_mon) db.run("UPDATE home_mons SET locked_by = NULL WHERE id = ? AND locked_by = ?", t0.to_mon, lock(t0.id));
      const m = lockMine(uid, ctx.body.monId, t0.id);
      db.run("UPDATE trades SET to_user = ?, to_mon = ?, status = 'answered', from_ok = 0, to_ok = 0, updated_at = ? WHERE id = ?", uid, m.id, now(), t0.id);
      return getTrade(t0.id);
    });
    push(t);
    return tradeOut(t);
  });

  app.post("/api/trades/:id/confirm", (ctx) => {
    const uid = ctx.user.id;
    const t = db.tx(() => {
      const t0 = getTrade(ctx.params.id);
      if (!isParty(t0, uid)) throw new HttpError(403, "This is not your trade");
      if (t0.status !== "answered") throw new HttpError(409, t0.status === "open" ? "Nobody has answered this offer yet" : "This trade is over");
      // Confirm only the deal the player last saw: the client sends the two Pokémon it showed.
      if (ctx.body.fromMon !== t0.from_mon || ctx.body.toMon !== t0.to_mon) throw new HttpError(409, "The offer changed; look at it again before confirming");
      db.run(`UPDATE trades SET ${t0.from_user === uid ? "from_ok" : "to_ok"} = 1, updated_at = ? WHERE id = ?`, now(), t0.id);
      const t1 = getTrade(t0.id);
      return t1.from_ok && t1.to_ok ? swap(t1) : t1;
    });
    push(t);
    return tradeOut(t);
  });

  app.post("/api/trades/:id/cancel", (ctx) => {
    const uid = ctx.user.id;
    const t = db.tx(() => {
      const t0 = getTrade(ctx.params.id);
      if (!isParty(t0, uid)) throw new HttpError(403, "This is not your trade");
      if (!["open", "answered"].includes(t0.status)) throw new HttpError(409, "This trade is already over");
      unlockAll(t0);
      db.run("UPDATE trades SET status = 'cancelled', updated_at = ? WHERE id = ?", now(), t0.id);
      return getTrade(t0.id);
    });
    push(t);
    return tradeOut(t);
  });

  /** Inside the confirm transaction: swap owners, apply receive + evolution, record everything. */
  function swap(t) {
    const a = db.get("SELECT * FROM home_mons WHERE id = ?", t.from_mon);
    const b = db.get("SELECT * FROM home_mons WHERE id = ?", t.to_mon);
    if (!a || !b || a.locked_by !== lock(t.id) || b.locked_by !== lock(t.id) || a.owner !== t.from_user || b.owner !== t.to_user)
      throw new HttpError(409, "One of the Pokémon is no longer available; the trade was not made");
    const at = now();
    const views = [a, b].map((m) => readRecord(new Uint8Array(m.record), { format: m.format, lang: m.lang, game: m.game }).view);
    const evolved = [];
    // Park both outside the grid first: each takes the other's slot (UNIQUE owner/box/slot).
    db.run("UPDATE home_mons SET box = -1, slot = -1 WHERE id = ?", a.id);
    db.run("UPDATE home_mons SET box = -2, slot = -2 WHERE id = ?", b.id);
    for (const [m, partner, pview, receiver, giver, slotOf] of [[a, b, views[1], t.to_user, t.from_user, b], [b, a, views[0], t.from_user, t.to_user, a]]) {
      const meta = { format: m.format, lang: m.lang, game: m.game };
      const r = applyTrade(new Uint8Array(m.record), meta, { partnerSpecies: pview.species, partnerEverstone: pview.heldItemNational === EVERSTONE, now: new Date(at) });
      const v = readRecord(r.record, meta).view;
      const prov = JSON.parse(m.provenance || "[]");
      prov.push({ rule: "trade", at, from: giver, to: receiver, tradeId: t.id, ...(r.evolved ? { evolved: r.evolved } : {}) });
      db.run(`UPDATE home_mons SET owner = ?, box = ?, slot = ?, record = ?, view = ?, fingerprint = ?, provenance = ?, locked_by = NULL WHERE id = ?`,
        receiver, slotOf.box, slotOf.slot, r.record, JSON.stringify(summary(v)), fingerprint(m.format, r.record), JSON.stringify(prov), m.id);
      db.run("INSERT INTO home_ledger (identity, at, user_id, event, mon_id) VALUES (?, ?, ?, 'trade-out', ?)", m.identity, at, giver, m.id);
      db.run("INSERT INTO home_ledger (identity, at, user_id, event, mon_id) VALUES (?, ?, ?, 'trade-in', ?)", m.identity, at, receiver, m.id);
      for (const [u, action] of [[giver, "trade-out"], [receiver, "trade-in"]])
        db.run("INSERT INTO history (at, user_id, action, mon_id, detail) VALUES (?, ?, ?, ?, ?)", at, u, action, m.id, JSON.stringify({ tradeId: t.id, species: v.species, evolved: r.evolved }));
      if (r.evolved) evolved.push({ monId: m.id, owner: receiver, ...r.evolved });
    }
    db.run("UPDATE trades SET status = 'done', updated_at = ?, result = ? WHERE id = ?", at, JSON.stringify({ evolved }), t.id);
    return getTrade(t.id);
  }
}
