/* The gate every Pokémon record passes before the server stores it.

   Records arrive from browsers we do not control, so nothing about them is trusted: the meta
   is checked against an allow-list, the base64 is decoded with a size cap, and the bytes go
   through shared/pkm checkRecord (exact size for the format and language, the codec's own
   validation: checksums, ranges, Bad Eggs). The view the server caches is the one it computed,
   never one the client sent. */
import crypto from "node:crypto";
import { HttpError } from "./http.js";
import { checkRecord, identity } from "../shared/pkm/index.js";
import { summary } from "../shared/pkm/view.js";

const META_GAMES = /^[A-Za-z0-9]{1,8}$/;
const MAX_B64 = 400;   // the largest record (pk2 Korean, 56 bytes; pk4/pk5, 136 bytes) is well under this

/** { record: base64, meta } from a request body -> { record, meta, view, summary, fingerprint, identity }. */
export function acceptRecord(input, where = "Pokémon") {
  if (!input || typeof input !== "object") throw new HttpError(400, `${where}: missing record`);
  const { record: b64, meta } = input;
  if (typeof b64 !== "string" || b64.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new HttpError(400, `${where}: record must be base64`);
  if (!meta || typeof meta !== "object") throw new HttpError(400, `${where}: missing meta`);
  const clean = {
    format: String(meta.format || ""),
    lang: String(meta.lang || ""),
    game: meta.game == null ? null : String(meta.game),
  };
  if (clean.game !== null && !META_GAMES.test(clean.game)) throw new HttpError(400, `${where}: bad game code`);
  const record = new Uint8Array(Buffer.from(b64, "base64"));
  const check = checkRecord(record, clean);
  if (!check.ok) throw new HttpError(422, `${where}: ${check.errors[0] || "this record is not valid"}`, { errors: check.errors });
  return {
    record, meta: clean, view: check.view, summary: summary(check.view), warnings: check.warnings,
    fingerprint: fingerprint(clean.format, record),
    identity: identity(check.view),
  };
}

export function fingerprint(format, record) {
  return crypto.createHash("sha256").update(format).update("\0").update(record).digest("hex");
}

export const toBase64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
