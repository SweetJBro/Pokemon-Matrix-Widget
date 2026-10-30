/* Home: each user's cloud boxes (docs/ARCHITECTURE.md "Home API").

   Deposits arrive as records the browser took out of its working copy of a save. Every record
   passes server/records.js; a deposit of several Pokémon is all or nothing, and a record whose
   exact bytes are already in someone's Home is refused (the fingerprint index is UNIQUE, so two
   racing requests cannot both win).

   Withdrawal is two-phase because the save lives only in the browser: POST withdraw locks the
   Pokémon and hands its record out; the browser puts it into the save and then commits (the
   Pokémon leaves Home) or cancels (it stays). A tab that dies in between leaves a pending
   withdrawal the player can finish or cancel later, so a Pokémon is never in neither place.

   Save files can be copied, so nothing here can stop someone cloning a Pokémon by keeping an
   old save. The ledger records which individual Pokémon (shared/pkm identity) entered and left
   Home and by whom; a deposit of one that another player withdrew, or that is in another
   player's Home right now, is stored with a "seen before" provenance entry that everyone who
   looks at it (trade partners included) can see. */
import crypto from "node:crypto";
import { HttpError, RateLimiter } from "./http.js";
import { acceptRecord, toBase64 } from "./records.js";
import { readRecord, identity } from "../shared/pkm/index.js";
import { convert, canConvert } from "../shared/pkm/convert.js";
import { FormatError } from "../shared/bytes.js";

export const BOX_SLOTS = 30;
const MAX_DEPOSIT = 30;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,24}$/;

const SCHEMA = `
CREATE UNIQUE INDEX IF NOT EXISTS home_mons_fp_unique ON home_mons(fingerprint);
CREATE TABLE IF NOT EXISTS home_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  identity  TEXT NOT NULL,
  at        INTEGER NOT NULL,
  user_id   TEXT NOT NULL,
  event     TEXT NOT NULL,            -- deposit | withdraw | trade-out | trade-in | release
  mon_id    TEXT
);
CREATE INDEX IF NOT EXISTS home_ledger_identity ON home_ledger(identity);
CREATE TABLE IF NOT EXISTS home_withdrawals (
  mon_id     TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  target     TEXT NOT NULL,           -- JSON { format, game, lang }
  created_at INTEGER NOT NULL
);`;

function migrate(db) {
  const cols = new Set(db.all("PRAGMA table_info(home_mons)").map((c) => c.name));
  if (!cols.has("identity")) db.raw.exec("ALTER TABLE home_mons ADD COLUMN identity TEXT");
  if (!cols.has("provenance")) db.raw.exec("ALTER TABLE home_mons ADD COLUMN provenance TEXT NOT NULL DEFAULT '[]'");
  db.raw.exec(SCHEMA);
  const wcols = new Set(db.all("PRAGMA table_info(home_withdrawals)").map((c) => c.name));
  if (!wcols.has("result")) db.raw.exec("ALTER TABLE home_withdrawals ADD COLUMN result TEXT");   // JSON { identity, provenance }
}

const newId = () => crypto.randomBytes(9).toString("base64url");

export function register(app, deps) {
  const { db, config, hub } = deps;
  migrate(db);
  const BOXES = config.homeBoxes;
  const limiter = new RateLimiter(120, 60_000);

  const notify = (userId, change) => hub?.sendUser(userId, { type: "home", change });
  const log = (userId, action, monId, detail) =>
    db.run("INSERT INTO history (at, user_id, action, mon_id, detail) VALUES (?, ?, ?, ?, ?)", Date.now(), userId, action, monId, JSON.stringify(detail ?? null));
  const ledger = (identity, userId, event, monId) =>
    db.run("INSERT INTO home_ledger (identity, at, user_id, event, mon_id) VALUES (?, ?, ?, ?, ?)", identity, Date.now(), userId, event, monId);

  function getMon(userId, id) {
    const row = db.get("SELECT * FROM home_mons WHERE id = ?", String(id || ""));
    if (!row || row.owner !== userId) throw new HttpError(404, "That Pokémon is not in your Home");
    return row;
  }
  const lockReason = (row) => row.locked_by === "withdraw" ? "it is being withdrawn (finish or cancel that first)"
    : row.locked_by?.startsWith("trade:") ? "it is offered in a trade" : "it is in use";
  function requireUnlocked(row) {
    if (row.locked_by) throw new HttpError(409, `That Pokémon can't be changed right now: ${lockReason(row)}`);
  }
  const checkBox = (b) => { if (!Number.isInteger(b) || b < 0 || b >= BOXES) throw new HttpError(400, `Box must be 1-${BOXES}`); };
  const checkSlot = (s) => { if (!Number.isInteger(s) || s < 0 || s >= BOX_SLOTS) throw new HttpError(400, `Slot must be 1-${BOX_SLOTS}`); };

  function occupied(userId) {
    const set = new Set();
    for (const r of db.all("SELECT box, slot FROM home_mons WHERE owner = ?", userId)) set.add(r.box * BOX_SLOTS + r.slot);
    return set;
  }
  function freeSlot(taken, fromBox = 0) {
    for (let i = fromBox * BOX_SLOTS; i < BOXES * BOX_SLOTS; i++) if (!taken.has(i)) return i;
    for (let i = 0; i < fromBox * BOX_SLOTS; i++) if (!taken.has(i)) return i;
    return -1;
  }

  function seenBefore(identity, userId) {
    const elsewhere = db.get("SELECT owner FROM home_mons WHERE identity = ? AND owner != ? LIMIT 1", identity, userId);
    if (elsewhere) return "The same Pokémon is in another player's Home right now";
    const left = db.get("SELECT user_id, at FROM home_ledger WHERE identity = ? AND event IN ('withdraw', 'trade-out', 'converted-out', 'unofficial-out') AND user_id != ? ORDER BY at DESC LIMIT 1", identity, userId);
    if (left) return "The same Pokémon left another player's Home before";
    return null;
  }

  const monOut = (r) => ({
    id: r.id, box: r.box, slot: r.slot, format: r.format, lang: r.lang, game: r.game,
    summary: JSON.parse(r.view), locked: r.locked_by ? lockReason(r) : null,
    lockedBy: r.locked_by ? r.locked_by.split(":")[0] : null,
    flags: JSON.parse(r.provenance || "[]").map((p) => p.rule),
  });

  app.get("/api/home", (ctx) => {
    const uid = ctx.user.id;
    const names = new Map(db.all("SELECT box, name FROM home_boxes WHERE user_id = ?", uid).map((r) => [r.box, r.name]));
    const boxes = Array.from({ length: BOXES }, (_, i) => ({ index: i, name: names.get(i) || `Box ${i + 1}`, mons: [] }));
    for (const r of db.all("SELECT * FROM home_mons WHERE owner = ? ORDER BY box, slot", uid)) boxes[r.box]?.mons.push(monOut(r));
    const pending = db.all("SELECT w.mon_id AS id, w.target, w.created_at AS createdAt FROM home_withdrawals w WHERE w.user_id = ?", uid)
      .map((w) => ({ id: w.id, target: JSON.parse(w.target), createdAt: w.createdAt }));
    return { boxCount: BOXES, boxSlots: BOX_SLOTS, boxes, pendingWithdrawals: pending };
  });

  app.get("/api/home/mon/:id", (ctx) => {
    const r = getMon(ctx.user.id, ctx.params.id);
    const { view } = readRecord(new Uint8Array(r.record), { format: r.format, lang: r.lang, game: r.game });
    return {
      id: r.id, box: r.box, slot: r.slot, format: r.format, lang: r.lang, game: r.game,
      record: toBase64(new Uint8Array(r.record)), view, provenance: JSON.parse(r.provenance || "[]"),
      depositedAt: r.deposited_at, depositedBy: r.deposited_by, locked: r.locked_by ? lockReason(r) : null,
    };
  });

  app.post("/api/home/deposit", (ctx) => {
    const uid = ctx.user.id;
    limiter.check(uid);
    const list = ctx.body.mons;
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, "Nothing to deposit");
    if (list.length > MAX_DEPOSIT) throw new HttpError(400, `At most ${MAX_DEPOSIT} Pokémon per deposit`);
    const accepted = list.map((m, i) => ({ ...acceptRecord(m, `Pokémon ${i + 1}`), box: m.box, slot: m.slot }));
    const fps = new Set();
    for (const a of accepted) {
      if (fps.has(a.fingerprint)) throw new HttpError(409, "The same Pokémon is in this deposit twice");
      fps.add(a.fingerprint);
    }
    const warnings = [];
    const stored = db.tx(() => {
      const taken = occupied(uid);
      const out = [];
      for (const [i, a] of accepted.entries()) {
        if (db.get("SELECT 1 FROM home_mons WHERE fingerprint = ?", a.fingerprint))
          throw new HttpError(409, `Pokémon ${i + 1} (${a.summary.speciesName}) is already in Home; reload your save, it may be an old copy`);
        let pos;
        if (a.box != null || a.slot != null) {
          checkBox(a.box); checkSlot(a.slot);
          pos = a.box * BOX_SLOTS + a.slot;
          if (taken.has(pos)) throw new HttpError(409, `Box ${a.box + 1} slot ${a.slot + 1} is not empty`);
        } else {
          pos = freeSlot(taken, Number.isInteger(ctx.body.box) && ctx.body.box >= 0 && ctx.body.box < BOXES ? ctx.body.box : 0);
          if (pos < 0) throw new HttpError(409, "Your Home is full");
        }
        taken.add(pos);
        const id = newId(), now = Date.now();
        const provenance = [{ rule: "deposit", at: now, by: uid, game: a.meta.game }];
        if (db.get("SELECT 1 FROM home_ledger WHERE identity = ? AND event = 'unofficial-out' LIMIT 1", a.identity))
          provenance.push({ rule: "unofficial", at: now, note: "Converted from Gen 1/2 by this server's unofficial transfer; no game can do this." });
        const seen = seenBefore(a.identity, uid);
        if (seen) { provenance.push({ rule: "seen-before", at: now, note: seen }); warnings.push(`${a.summary.speciesName}: ${seen}.`); }
        db.run(`INSERT INTO home_mons (id, owner, box, slot, format, lang, game, record, view, fingerprint, deposited_by, deposited_at, identity, provenance)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, uid, Math.floor(pos / BOX_SLOTS), pos % BOX_SLOTS, a.meta.format, a.meta.lang, a.meta.game, a.record,
          JSON.stringify(a.summary), a.fingerprint, uid, now, a.identity, JSON.stringify(provenance));
        ledger(a.identity, uid, "deposit", id);
        log(uid, "deposit", id, { species: a.summary.species, format: a.meta.format, game: a.meta.game });
        out.push({ id, box: Math.floor(pos / BOX_SLOTS), slot: pos % BOX_SLOTS });
        warnings.push(...a.warnings.map((w) => `${a.summary.speciesName}: ${w}`));
      }
      return out;
    });
    notify(uid, "deposit");
    return { stored, warnings };
  });

  app.post("/api/home/move", (ctx) => {
    const uid = ctx.user.id;
    limiter.check(uid);
    const { box, slot } = ctx.body;
    checkBox(box); checkSlot(slot);
    db.tx(() => {
      const r = getMon(uid, ctx.body.id);
      requireUnlocked(r);
      if (r.box === box && r.slot === slot) return;
      const other = db.get("SELECT * FROM home_mons WHERE owner = ? AND box = ? AND slot = ?", uid, box, slot);
      if (other) {
        requireUnlocked(other);
        // UNIQUE(owner, box, slot): park one Pokémon outside the grid while they swap.
        db.run("UPDATE home_mons SET box = -1, slot = -1 WHERE id = ?", other.id);
        db.run("UPDATE home_mons SET box = ?, slot = ? WHERE id = ?", box, slot, r.id);
        db.run("UPDATE home_mons SET box = ?, slot = ? WHERE id = ?", r.box, r.slot, other.id);
      } else {
        db.run("UPDATE home_mons SET box = ?, slot = ? WHERE id = ?", box, slot, r.id);
      }
      log(uid, "move", r.id, { from: [r.box, r.slot], to: [box, slot], swapped: other?.id ?? null });
    });
    notify(uid, "move");
  });

  app.put("/api/home/box/:index", (ctx) => {
    const index = Number(ctx.params.index);
    checkBox(index);
    const name = String(ctx.body.name ?? "").trim();
    if (!NAME_RE.test(name)) throw new HttpError(400, "Box names are 1-24 characters");
    db.run("INSERT INTO home_boxes (user_id, box, name) VALUES (?, ?, ?) ON CONFLICT(user_id, box) DO UPDATE SET name = excluded.name", ctx.user.id, index, name);
    notify(ctx.user.id, "box");
  });

  /** The record that would go into a save of `target`, converted when the formats differ (shared/pkm/convert.js).
      -> { ok, code?, reason?, record?, meta?, notes, provenance, unofficial } */
  function prepareWithdrawal(row, body) {
    const target = body.target;
    if (!target || typeof target.format !== "string" || !/^pk[1-5]$/.test(target.format)) throw new HttpError(400, "Say which save it goes into (target.format)");
    const clean = { format: target.format, game: target.game == null ? null : String(target.game).slice(0, 8), lang: target.lang == null ? null : String(target.lang).slice(0, 4) };
    const meta = { format: row.format, lang: row.lang, game: row.game };
    const record = new Uint8Array(row.record);
    if (clean.format === row.format) return { ok: true, record, meta, notes: [], provenance: [], unofficial: false, target: clean };
    const allowUnofficial = !!(config.unofficialTransfers && body.allowUnofficial);
    const can = canConvert(meta, clean.format, { allowUnofficial: !!config.unofficialTransfers });
    if (!can.ok) return { ok: false, code: "conversion", reason: can.unofficial ? "No game can move Gen 1/2 Pokémon to Gen 3 or later, and this server does not do unofficial conversions." : can.reason, notes: [], unofficial: can.unofficial, target: clean };
    if (can.unofficial && !allowUnofficial) return { ok: false, code: "unofficial", reason: "This needs an unofficial conversion. Tick the box to allow it.", notes: [], unofficial: true, target: clean };
    try {
      const out = convert(record, meta, clean.format, { allowUnofficial, dropItem: !!body.dropItem, target: { game: clean.game, lang: clean.lang ?? row.lang }, now: new Date() });
      return { ok: true, record: out.record, meta: out.meta, notes: out.notes, provenance: out.provenance, unofficial: can.unofficial, target: clean };
    } catch (e) {
      if (!(e instanceof FormatError)) throw e;
      return { ok: false, code: e.detail?.code || "conversion", reason: e.message, notes: [], unofficial: can.unofficial, target: clean };
    }
  }

  app.post("/api/home/withdraw/preview", (ctx) => {
    const r = getMon(ctx.user.id, ctx.body.id);
    const p = prepareWithdrawal(r, ctx.body);
    const view = readRecord(p.ok ? p.record : new Uint8Array(r.record), p.ok ? p.meta : { format: r.format, lang: r.lang, game: r.game }).view;
    return { ok: p.ok, code: p.code, reason: p.reason, view, notes: p.notes, unofficial: p.unofficial, rules: (p.provenance || []).map((x) => x.rule), locked: r.locked_by ? lockReason(r) : null };
  });

  app.post("/api/home/withdraw", (ctx) => {
    const uid = ctx.user.id;
    limiter.check(uid);
    const out = db.tx(() => {
      const row = getMon(uid, ctx.body.id);
      const p = prepareWithdrawal(row, ctx.body);
      if (!p.ok) throw new HttpError(409, p.reason, { code: p.code });
      requireUnlocked(row);
      const view = readRecord(p.record, p.meta).view;
      db.run("UPDATE home_mons SET locked_by = 'withdraw' WHERE id = ?", row.id);
      db.run("INSERT INTO home_withdrawals (mon_id, user_id, target, created_at, result) VALUES (?, ?, ?, ?, ?)", row.id, uid,
        JSON.stringify(p.target), Date.now(), JSON.stringify({ identity: identity(view), provenance: p.provenance }));
      return { id: row.id, record: toBase64(p.record), meta: p.meta, view, notes: p.notes };
    });
    notify(uid, "withdraw-start");
    return out;
  });

  function pendingRow(uid, id) {
    const w = db.get("SELECT * FROM home_withdrawals WHERE mon_id = ? AND user_id = ?", String(id || ""), uid);
    if (!w) throw new HttpError(404, "No withdrawal of that Pokémon is in progress");
    return w;
  }

  app.post("/api/home/withdraw/:id/commit", (ctx) => {
    const uid = ctx.user.id;
    db.tx(() => {
      const w = pendingRow(uid, ctx.params.id);
      const r = getMon(uid, ctx.params.id);
      const res = JSON.parse(w.result || "null");
      db.run("DELETE FROM home_withdrawals WHERE mon_id = ?", r.id);
      db.run("DELETE FROM home_mons WHERE id = ?", r.id);
      ledger(r.identity, uid, "withdraw", r.id);
      // A converted Pokémon has a new identity (a Gen 3 PID); remember it, and whether the conversion was
      // unofficial, so it is recognised and badged if it is ever deposited again.
      if (res?.provenance?.length) {
        const unofficial = res.provenance.some((p) => p.rule === "vc-model-v1");
        ledger(res.identity, uid, unofficial ? "unofficial-out" : "converted-out", r.id);
      }
      // History keeps the record, so a player who loses the save afterwards can be helped by hand.
      log(uid, "withdraw", r.id, { species: JSON.parse(r.view).species, format: r.format, record: toBase64(new Uint8Array(r.record)), conversions: res?.provenance ?? [] });
    });
    notify(uid, "withdraw");
  });

  app.post("/api/home/withdraw/:id/cancel", (ctx) => {
    const uid = ctx.user.id;
    db.tx(() => {
      pendingRow(uid, ctx.params.id);
      db.run("DELETE FROM home_withdrawals WHERE mon_id = ?", ctx.params.id);
      db.run("UPDATE home_mons SET locked_by = NULL WHERE id = ? AND locked_by = 'withdraw'", ctx.params.id);
    });
    notify(uid, "withdraw-cancel");
  });

  app.post("/api/home/release", (ctx) => {
    const uid = ctx.user.id;
    limiter.check(uid);
    db.tx(() => {
      const r = getMon(uid, ctx.body.id);
      requireUnlocked(r);
      db.run("DELETE FROM home_mons WHERE id = ?", r.id);
      ledger(r.identity, uid, "release", r.id);
      log(uid, "release", r.id, { species: JSON.parse(r.view).species, format: r.format, record: toBase64(new Uint8Array(r.record)) });
    });
    notify(uid, "release");
  });

  app.get("/api/home/history", (ctx) => {
    const limit = Math.max(1, Math.min(200, Number(ctx.query.get("limit")) || 50));
    return {
      entries: db.all("SELECT at, action, mon_id AS monId, detail FROM history WHERE user_id = ? ORDER BY id DESC LIMIT ?", ctx.user.id, limit)
        .map((e) => {
          const detail = JSON.parse(e.detail || "null");
          if (detail) delete detail.record;   // the stored copy is for support, not for the listing
          return { ...e, detail };
        }),
    };
  });
}

const formatLabel = (f) => ({ pk1: "Generation 1", pk2: "Generation 2", pk3: "Generation 3", pk4: "Generation 4", pk5: "Generation 5" })[f] || f;
