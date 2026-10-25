/* Gen 1 text (Red, Green, Blue, Yellow). The tables and rules live in gb.js, shared with Gen 2;
   docs/research/format-gen1-gen2.md §10.

   decode(bytes, lang, opts)          -> string; stops at 0x50 (or 0x00). opts.unknown replaces
                                         unmapped codes (default U+FFFD), opts.trainer the word
                                         shown for the 0x5D <TRAINER> code.
   encode(str, lang, maxBytes, opts)  -> Uint8Array(maxBytes): text, 0x50, then 0x50 padding.
                                         opts.original keeps a field's unchanged codes and the
                                         bytes after its terminator; opts.trailing = "pad" pads
                                         anyway; opts.maxChars caps the length; opts.ligatures
                                         writes 'd 's ... as one-tile ligatures. Throws FormatError.
   canEncode(str, lang, maxBytes?, opts?) -> boolean
   limits(lang) -> { nickname, ot, player, rival: { bytes, chars } }
   Fields hold 10 characters + terminator (11 bytes) in Western games and 5 + 1 in Japanese. */
import * as gb from "./gb.js";
import { LANGS } from "./core.js";

export { LANGS };   // "ko" reads and writes Korean Gold/Silver bytes (see gb.js)
export const GEN = 1;
export const TERMINATOR = gb.TERMINATOR;
export const TRAINER_CODE = gb.TRAINER_CODE;
export const NAME_LENGTH = { intl: 11, ja: 6 };

export const decode = (bytes, lang, opts) => gb.decode(1, bytes, lang, opts);
export const encode = (str, lang, maxBytes, opts) => gb.encode(1, str, lang, maxBytes, opts);
export const canEncode = (str, lang, maxBytes, opts) => gb.canEncode(1, str, lang, maxBytes, opts);
export const limits = (lang) => gb.limits(1, lang);
