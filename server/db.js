/* SQLite storage (node:sqlite, synchronous). One file, WAL mode.

   Every write that must be atomic across rows (trades, deposits of several Pokémon, moves
   between boxes) goes through tx(), which runs the callback inside BEGIN IMMEDIATE ... COMMIT. */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,          -- Matrix user ID, e.g. @ash:example.org
  display_name  TEXT,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,          -- sha256 of the bearer token
  user_id       TEXT NOT NULL REFERENCES users(id),
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS home_boxes (
  user_id       TEXT NOT NULL REFERENCES users(id),
  box           INTEGER NOT NULL,
  name          TEXT NOT NULL,
  PRIMARY KEY (user_id, box)
);
CREATE TABLE IF NOT EXISTS home_mons (
  id            TEXT PRIMARY KEY,          -- random id
  owner         TEXT NOT NULL REFERENCES users(id),
  box           INTEGER NOT NULL,
  slot          INTEGER NOT NULL,
  format        TEXT NOT NULL,             -- pk1..pk5
  lang          TEXT NOT NULL,
  game          TEXT,                      -- game the record came from (origin of this copy)
  record        BLOB NOT NULL,             -- canonical record bytes (docs/ARCHITECTURE.md)
  view          TEXT NOT NULL,             -- cached MonView JSON
  fingerprint   TEXT NOT NULL,             -- sha256 of format+record, used to spot re-deposits
  deposited_by  TEXT NOT NULL,             -- who first put this Pokémon into Home
  deposited_at  INTEGER NOT NULL,
  locked_by     TEXT,                      -- trade or battle id holding this Pokémon, if any
  UNIQUE (owner, box, slot)
);
CREATE INDEX IF NOT EXISTS home_mons_owner ON home_mons(owner);
CREATE INDEX IF NOT EXISTS home_mons_fp ON home_mons(fingerprint);

CREATE TABLE IF NOT EXISTS history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  user_id       TEXT NOT NULL,
  action        TEXT NOT NULL,             -- deposit | withdraw | trade | release | move | evolve
  mon_id        TEXT,
  detail        TEXT                       -- JSON
);
CREATE INDEX IF NOT EXISTS history_user ON history(user_id, at);

CREATE TABLE IF NOT EXISTS trades (
  id            TEXT PRIMARY KEY,
  room_id       TEXT,
  from_user     TEXT NOT NULL,
  to_user       TEXT,                      -- null: open offer anyone in the room can answer
  from_mon      TEXT NOT NULL,
  to_mon        TEXT,
  wanted        TEXT,                      -- JSON { species?, note? }
  status        TEXT NOT NULL,             -- open | answered | done | cancelled | expired
  from_ok       INTEGER NOT NULL DEFAULT 0,
  to_ok         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  result        TEXT                       -- JSON summary once done
);
CREATE INDEX IF NOT EXISTS trades_room ON trades(room_id, status);

CREATE TABLE IF NOT EXISTS battles (
  id            TEXT PRIMARY KEY,
  room_id       TEXT,
  format        TEXT NOT NULL,             -- JSON battle options
  p1            TEXT NOT NULL,
  p2            TEXT NOT NULL,             -- user id or "cpu"
  status        TEXT NOT NULL,             -- active | done | aborted
  winner        TEXT,
  log           TEXT,                      -- spectator protocol log once finished
  created_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
`;

export function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  let depth = 0;
  return {
    raw: db,
    run: (sql, ...args) => prep(sql).run(...args),
    get: (sql, ...args) => prep(sql).get(...args),
    all: (sql, ...args) => prep(sql).all(...args),
    /** Run fn inside one transaction; nested calls join the outer one. */
    tx(fn) {
      if (depth > 0) return fn();
      db.exec("BEGIN IMMEDIATE");
      depth++;
      try { const r = fn(); db.exec("COMMIT"); return r; }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      finally { depth--; }
    },
    close: () => db.close(),
  };
}
