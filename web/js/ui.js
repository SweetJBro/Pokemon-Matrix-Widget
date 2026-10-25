/* DOM helpers, in-page dialogs, toasts, the tab router and formatting.

   Untrusted text is everywhere in this app: Pokémon nicknames and OT names decoded from save
   files, Matrix display names, server error messages. So nothing here (or in any view) uses
   innerHTML; h() builds elements and adds strings as text nodes, refuses odd attribute names
   and drops javascript:-style URLs.

   Element's widget sandbox has no allow-modals, so alert/confirm/prompt are blocked inside the
   iframe (docs/research/matrix-widget.md §5.1). dialog(), confirmDialog() and promptDialog()
   are the replacements: in-page modals that trap focus, make the page behind them inert, close
   on Escape (cancel) and give focus back to whatever had it.

   `document` is looked up when a function runs, not at import, so node tests can install a tiny
   fake DOM (test/web-ui.test.js). */

const doc = () => globalThis.document;

/* ---------- element builder ---------- */

const PROPS = new Set(["value", "checked", "selected", "disabled", "hidden", "indeterminate", "multiple", "readOnly", "required", "open", "defaultValue", "defaultChecked"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster", "xlink:href", "srcset"]);
const ATTR_NAME = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Allow relative URLs and http(s)/blob/mailto, plus raster data: images. */
export function safeUrl(v) {
  const s = String(v).trim();
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (!m) return s;
  const scheme = m[1].toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "blob" || scheme === "mailto") return s;
  if (scheme === "data" && /^data:image\/(png|gif|jpeg|webp);/i.test(s)) return s;
  return "about:blank";
}

function setAttrs(el, attrs, isSvg) {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class" || key === "className") {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value);
      if (isSvg) el.setAttribute("class", cls); else el.className = cls;
    } else if (key === "style") {
      if (typeof value === "string") el.setAttribute("style", value);
      else for (const [p, v] of Object.entries(value)) {
        if (v === null || v === undefined) continue;
        if (p.startsWith("--") || p.includes("-")) el.style.setProperty(p, String(v)); else el.style[p] = String(v);
      }
    } else if (key === "dataset") {
      for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) el.dataset[k] = String(v);
    } else if (key === "ref") {
      // handled by the caller after children are attached
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (!isSvg && PROPS.has(key)) {
      el[key] = value;
    } else {
      if (!ATTR_NAME.test(key) || /^on/i.test(key)) throw new Error("h(): refusing attribute " + JSON.stringify(key));
      const v = value === true ? "" : String(value);
      el.setAttribute(key, URL_ATTRS.has(key.toLowerCase()) ? safeUrl(v) : v);
    }
  }
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (typeof c === "string" || typeof c === "number" || typeof c === "bigint") el.appendChild(doc().createTextNode(String(c)));
    else el.appendChild(c);
  }
}

function isAttrs(x) {
  return x && typeof x === "object" && !Array.isArray(x) && typeof x.nodeType !== "number";
}

/** h("button", { class: "btn", onclick }, "Text", child, [more]) -> HTMLElement.
    Strings and numbers become text nodes; null/false/true are skipped; arrays are flattened.
    Attributes: class (string or array), style (string or object, "--vars" allowed), dataset,
    on<event> functions, ref(el), DOM properties (value, checked, disabled, ...), anything else
    via setAttribute (true -> ""). */
export function h(tag, attrs, ...children) {
  if (!TAG_NAME.test(tag)) throw new Error("h(): bad tag " + JSON.stringify(tag));
  if (!isAttrs(attrs)) { children.unshift(attrs); attrs = null; }
  const el = doc().createElement(tag);
  if (attrs) setAttrs(el, attrs, false);
  appendChildren(el, children);
  if (attrs && typeof attrs.ref === "function") attrs.ref(el);
  return el;
}

/** Same as h() for SVG elements (icons, HP bars drawn in SVG, ...). */
export function svg(tag, attrs, ...children) {
  if (!TAG_NAME.test(tag)) throw new Error("svg(): bad tag " + JSON.stringify(tag));
  if (!isAttrs(attrs)) { children.unshift(attrs); attrs = null; }
  const el = doc().createElementNS(SVG_NS, tag);
  if (attrs) setAttrs(el, attrs, true);
  appendChildren(el, children);
  if (attrs && typeof attrs.ref === "function") attrs.ref(el);
  return el;
}

/** Replace all children of el. */
export function clear(el, ...children) {
  while (el.firstChild) el.removeChild(el.firstChild);
  appendChildren(el, children);
  return el;
}

export const $ = (sel, root = doc()) => root.querySelector(sel);
export const $$ = (sel, root = doc()) => [...root.querySelectorAll(sel)];

/* ---------- small building blocks ---------- */

/** A spinner with a text label (role=status so screen readers announce it). */
export function spinner(label = "Loading…") {
  return h("div", { class: "spinner-wrap", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", { class: "spinner-label" }, label));
}

/** Panel for empty or not-yet-built states. action = { label, onClick, kind }. */
export function emptyState({ icon = "", title, text, action } = {}) {
  return h("div", { class: "empty-state" },
    icon && h("div", { class: "empty-icon", "aria-hidden": "true" }, icon),
    title && h("h2", null, title),
    text && h("p", { class: "muted" }, text),
    action && h("button", { type: "button", class: ["btn", "btn-" + (action.kind || "primary")], onclick: action.onClick }, action.label));
}

export function badge(text, kind) {
  return h("span", { class: ["badge", kind && "badge-" + kind] }, text);
}

/** Copy text to the clipboard (needs a user gesture; Element allows clipboard-write). */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ---------- dialogs ---------- */

const stack = [];
let dialogSeq = 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(panel) {
  return [...panel.querySelectorAll(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

function updateInert() {
  const app = doc().getElementById("app");
  if (app) app.inert = stack.length > 0;
  stack.forEach((d, i) => { d.overlay.inert = i !== stack.length - 1; });
}

/**
 * In-page modal. Resolves with the clicked button's value, or cancelValue on Escape / backdrop.
 *   title       heading text
 *   body        string (a paragraph), Node, or array of Nodes
 *   buttons     [{ label, value, kind: "primary"|"danger"|"ghost", autofocus, disabled,
 *                  onClick(ctx) -> false keeps the dialog open (may be async) }]
 *   cancelValue value for Escape / backdrop click (default null)
 *   dismissable false disables Escape and backdrop
 *   onOpen(ctx) called after mounting; ctx = { el, body, buttons, close(value) }
 *   wide        wider panel
 */
export function dialog({ title, body, buttons = [{ label: "OK", value: true, kind: "primary" }], cancelValue = null, dismissable = true, onOpen, wide = false } = {}) {
  return new Promise((resolve) => {
    const d = doc();
    const root = d.getElementById("dialog-root") || d.body;
    const prevFocus = d.activeElement;
    const titleId = "dialog-title-" + (++dialogSeq);
    let done = false;
    const entry = {};

    const bodyEl = h("div", { class: "dialog-body" }, typeof body === "string" ? h("p", null, body) : body);
    const ctx = { el: null, body: bodyEl, buttons: [], close };
    ctx.buttons = buttons.map((b) => h("button", {
      type: "button",
      class: ["btn", b.kind ? "btn-" + b.kind : null],
      disabled: !!b.disabled,
      dataset: { autofocus: b.autofocus ? "1" : null },
      onclick: async (ev) => {
        if (b.onClick) {
          // aria-busy (not disabled) guards double clicks, so onClick may enable/disable freely.
          const btn = ev.currentTarget;
          if (btn.getAttribute("aria-busy") === "true") return;
          btn.setAttribute("aria-busy", "true");
          let r;
          try { r = await b.onClick(ctx); } finally { btn.removeAttribute("aria-busy"); }
          if (r === false) return;
        }
        close(b.value);
      },
    }, b.label));
    const panel = h("div", {
      class: ["dialog", wide && "dialog-wide"], role: "dialog", "aria-modal": "true",
      "aria-labelledby": title ? titleId : null, tabindex: "-1",
    },
    title && h("h2", { class: "dialog-title", id: titleId }, title),
    bodyEl,
    ctx.buttons.length ? h("div", { class: "dialog-actions" }, ctx.buttons) : null);
    const overlay = h("div", { class: "dialog-overlay" }, panel);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay && dismissable) close(cancelValue); });
    ctx.el = panel;
    entry.overlay = overlay;

    function onKey(e) {
      if (stack[stack.length - 1] !== entry) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (dismissable) close(cancelValue);
      } else if (e.key === "Tab") {
        const f = focusables(panel);
        if (!f.length) { e.preventDefault(); panel.focus(); return; }
        const first = f[0], last = f[f.length - 1];
        const active = d.activeElement;
        if (!panel.contains(active)) { e.preventDefault(); first.focus(); }
        else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      }
    }

    function close(value) {
      if (done) return;
      done = true;
      d.removeEventListener("keydown", onKey, true);
      overlay.remove();
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      updateInert();
      if (prevFocus && typeof prevFocus.focus === "function" && d.contains(prevFocus)) prevFocus.focus();
      resolve(value);
    }

    d.addEventListener("keydown", onKey, true);
    root.appendChild(overlay);
    stack.push(entry);
    updateInert();

    const target = panel.querySelector("[autofocus]") || panel.querySelector('[data-autofocus="1"]') ||
      bodyEl.querySelector("input, select, textarea") || ctx.buttons.find((b) => b.classList.contains("btn-primary")) ||
      ctx.buttons[ctx.buttons.length - 1] || panel;
    target.focus();
    if (onOpen) onOpen(ctx);
  });
}

/** Yes/no question. Resolves true only when the confirm button is pressed. */
export async function confirmDialog(message, { title = "Are you sure?", confirmLabel = "OK", cancelLabel = "Cancel", danger = false } = {}) {
  const v = await dialog({
    title,
    body: message,
    buttons: [
      { label: cancelLabel, value: false, kind: "ghost" },
      { label: confirmLabel, value: true, kind: danger ? "danger" : "primary", autofocus: !danger },
    ],
    cancelValue: false,
  });
  return v === true;
}

/** Text input in a dialog. Resolves the trimmed string, or null when cancelled.
    validate(value) returns an error message or null. */
export async function promptDialog({ title, label, value = "", placeholder = "", confirmLabel = "OK", maxLength = 200, validate, type = "text", inputMode } = {}) {
  const input = h("input", { type, class: "input", value, placeholder, maxlength: maxLength, inputmode: inputMode, autocomplete: "off", spellcheck: "false" });
  const err = h("p", { class: "field-error", role: "alert" });
  const check = () => {
    const msg = validate ? validate(input.value.trim()) : null;
    err.textContent = msg || "";
    return !msg;
  };
  let ctxRef;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (check()) ctxRef.close("ok"); }
  });
  const r = await dialog({
    title,
    body: [h("label", { class: "field" }, label && h("span", { class: "field-label" }, label), input), err],
    buttons: [
      { label: "Cancel", value: "cancel", kind: "ghost" },
      { label: confirmLabel, value: "ok", kind: "primary", onClick: () => check() || false },
    ],
    cancelValue: "cancel",
    onOpen: (ctx) => { ctxRef = ctx; input.select(); },
  });
  return r === "ok" ? input.value.trim() : null;
}

/* ---------- toasts ---------- */

/** Short message in the toast area. kind: "info" | "ok" | "warn" | "error".
    action = { label, onClick }. Returns { dismiss }. */
export function toast(message, kind = "info", { timeout, action } = {}) {
  const d = doc();
  let area = d.getElementById("toasts");
  if (!area) { area = h("div", { id: "toasts", class: "toasts", "aria-live": "polite" }); d.body.appendChild(area); }
  let timer = null;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 180);
  };
  const el = h("div", { class: ["toast", "toast-" + kind], role: kind === "error" ? "alert" : "status" },
    h("span", { class: "toast-msg" }, String(message)),
    action && h("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => { dismiss(); action.onClick(); } }, action.label),
    h("button", { type: "button", class: "toast-close", "aria-label": "Dismiss", onclick: dismiss }, "×"));
  area.appendChild(el);
  while (area.children.length > 4) area.firstElementChild.remove();
  const ms = timeout ?? (kind === "error" ? 8000 : 4000);
  if (ms > 0) timer = setTimeout(dismiss, ms);
  return { dismiss, el };
}

/* ---------- tabs / hash router ---------- */

/**
 * Hash routes look like "#home", "#trade/abc123" or "#battle?spectate=1".
 * createRouter({ routes: ["saves", ...], fallback: "saves", onRoute(route) })
 *   route = { name, rest: ["abc123"], params: URLSearchParams }
 * Returns { start(), go(name, ...rest), current(), stop() }.
 */
export function createRouter({ routes, fallback, onRoute }) {
  let current = null;
  function parse() {
    const raw = String(globalThis.location.hash || "").replace(/^#/, "");
    const [path, query = ""] = raw.split("?");
    const segs = path.split("/").map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    const name = routes.includes(segs[0]) ? segs[0] : fallback;
    return { name, rest: name === segs[0] ? segs.slice(1) : [], params: new URLSearchParams(query) };
  }
  function fire() {
    current = parse();
    onRoute(current);
  }
  return {
    start() { globalThis.addEventListener("hashchange", fire); fire(); },
    stop() { globalThis.removeEventListener("hashchange", fire); },
    current: () => current,
    go(name, ...rest) {
      const hash = "#" + [name, ...rest].map(encodeURIComponent).join("/");
      if (globalThis.location.hash === hash) fire(); else globalThis.location.hash = hash;
    },
  };
}

/** Mark the active tab in a tab bar of <a data-tab="name"> links. */
export function setActiveTab(nav, name) {
  for (const a of nav.querySelectorAll("[data-tab]")) {
    const on = a.dataset.tab === name;
    a.classList.toggle("active", on);
    a.setAttribute("aria-selected", on ? "true" : "false");
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
}

/* ---------- formatting ---------- */

export function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(n / 1048576).toFixed(1)} MiB`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else a date. */
export function fmtRelative(ts, now = Date.now()) {
  if (!ts) return "never";
  const s = Math.round((now - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return plural(Math.round(s / 86400), "day") + " ago";
  return fmtDate(ts);
}

export function fmtDate(ts) {
  try { return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return new Date(ts).toISOString().slice(0, 10); }
}

export function fmtDateTime(ts) {
  try { return new Date(ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return new Date(ts).toISOString(); }
}

/** { h, m, s } -> "123:04" (hours:minutes, the way the games show it). */
export function fmtPlayTime(t) {
  if (!t) return "-";
  return `${t.h | 0}:${String(t.m | 0).padStart(2, "0")}`;
}

/** National Dex number -> "#025". */
export function dexNo(n) {
  return "#" + String(n | 0).padStart(3, "0");
}

/** "@ash:example.org" -> "ash". */
export function localpart(userId) {
  const m = /^@([^:]+):/.exec(String(userId || ""));
  return m ? m[1] : String(userId || "");
}

/** Up to two letters for an avatar bubble. */
export function initials(name) {
  // Letters and digits only, so "<img ...>" or emoji-only names do not produce odd bubbles.
  const words = String(name || "").split(/[\s._:@-]+/).map((w) => [...w].filter((ch) => /[\p{L}\p{N}]/u.test(ch))).filter((w) => w.length);
  if (!words.length) return "?";
  const chars = words.length > 1 ? [words[0][0], words[1][0]] : words[0].slice(0, 2);
  return chars.join("").toUpperCase();
}

export function truncate(s, n) {
  const a = [...String(s)];
  return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join("");
}

/** Hue 0-359 derived from a string, for stable avatar colours. */
export function hueOf(s) {
  let x = 0;
  for (const ch of String(s)) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}

/** Avatar bubble with initials (no remote images: mxc:// needs auth and leaks to the homeserver). */
export function avatar(name, id = name, size = "md") {
  return h("span", { class: ["avatar", "avatar-" + size], style: { "--hue": hueOf(id) }, "aria-hidden": "true" }, initials(name));
}
