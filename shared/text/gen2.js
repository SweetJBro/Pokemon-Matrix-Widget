/* Gen 2 text (Gold, Silver, Crystal), including Korean Gold/Silver. The tables and rules live in
   gb.js, shared with Gen 1; docs/research/format-gen1-gen2.md §10.

   Same API as gen1.js: decode(bytes, lang, opts), encode(str, lang, maxBytes, opts),
   canEncode(str, lang, maxBytes?, opts?), limits(lang) (adds box names: 9 bytes, 17 in Korean).
   Korean names use the Western field sizes: 11 bytes hold five two-byte Hangul syllables and the
   terminator. */
import * as gb from "./gb.js";
import { LANGS } from "./core.js";

export { LANGS };
export const GEN = 2;
export const TERMINATOR = gb.TERMINATOR;
export const TRAINER_CODE = gb.TRAINER_CODE;
export const NAME_LENGTH = { intl: 11, ja: 6, ko: 11 };
export const BOX_NAME_LENGTH = { intl: 9, ja: 9, ko: 17 };

export const decode = (bytes, lang, opts) => gb.decode(2, bytes, lang, opts);
export const encode = (str, lang, maxBytes, opts) => gb.encode(2, str, lang, maxBytes, opts);
export const canEncode = (str, lang, maxBytes, opts) => gb.canEncode(2, str, lang, maxBytes, opts);
export const limits = (lang) => gb.limits(2, lang);
