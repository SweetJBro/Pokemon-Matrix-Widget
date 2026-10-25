/* web/js/ui.js under node with a minimal fake DOM: h() must never let untrusted text become
   markup (nicknames and display names are attacker-controlled), plus the formatting helpers. */
import { test, before } from "node:test";
import assert from "node:assert/strict";

/* A fake DOM just big enough for h()/svg()/clear(). Setting innerHTML throws, so a test fails
   if ui.js ever reaches for it. outerHTML serialises with proper escaping. */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => esc(s).replace(/"/g, "&quot;");
class Node_ { constructor() { this.childNodes = []; this.parentNode = null; } get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; } }
class Text_ extends Node_ { constructor(t) { super(); this.nodeType = 3; this.data = t; } get outerHTML() { return esc(this.data); } get textContent() { return this.data; } }
class Element_ extends Node_ {
  constructor(tag, ns) {
    super(); this.nodeType = 1; this.tagName = tag; this.namespaceURI = ns || "http://www.w3.org/1999/xhtml";
    this.attrs = new Map(); this.listeners = {}; this.dataset = {}; this.props = {};
    const style = {}; this.style = new Proxy(style, { get: (t, k) => k === "setProperty" ? (p, v) => { t[p] = v; } : t[k] });
  }
  set innerHTML(_) { throw new Error("innerHTML used"); }
  set className(v) { this.attrs.set("class", v); } get className() { return this.attrs.get("class") || ""; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); } getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  get outerHTML() {
    const a = [...this.attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
    return `<${this.tagName}${a}>${this.childNodes.map((c) => c.outerHTML).join("")}</${this.tagName}>`;
  }
}
for (const p of ["value", "checked", "disabled", "hidden"]) Object.defineProperty(Element_.prototype, p, { get() { return this.props[p]; }, set(v) { this.props[p] = v; } });

let ui;
before(async () => {
  globalThis.document = {
    createElement: (t) => new Element_(t),
    createElementNS: (ns, t) => new Element_(t, ns),
    createTextNode: (t) => new Text_(t),
  };
  ui = await import("../web/js/ui.js");
});

test("text children are text, never markup", () => {
  const nick = '<img src=x onerror="alert(1)">';
  const el = ui.h("span", { class: "nick" }, nick, " Lv ", 5);
  assert.equal(el.textContent, nick + " Lv 5");
  assert.equal(el.childNodes.length, 3);
  assert.ok(el.childNodes.every((c) => c.nodeType === 3));
  assert.equal(el.outerHTML, '<span class="nick">&lt;img src=x onerror="alert(1)"&gt; Lv 5</span>');
});

test("attribute values are set as data, quotes and all", () => {
  const el = ui.h("div", { title: '"><script>x</script>', "data-x": "a&b" });
  assert.equal(el.getAttribute("title"), '"><script>x</script>');
  assert.equal(el.outerHTML, '<div title="&quot;&gt;&lt;script&gt;x&lt;/script&gt;" data-x="a&amp;b"></div>');
});

test("string event handlers and odd attribute names are refused", () => {
  assert.throws(() => ui.h("div", { onclick: "alert(1)" }), /refusing attribute/);
  assert.throws(() => ui.h("div", { 'x"y': "1" }), /refusing attribute/);
  assert.throws(() => ui.h("img src=x", null), /bad tag/);
  const fn = () => {};
  const el = ui.h("button", { onclick: fn });
  assert.deepEqual(el.listeners.click, [fn]);
});

test("javascript: and other script URLs are neutralised; normal ones kept", () => {
  assert.equal(ui.h("a", { href: "javascript:alert(1)" }).getAttribute("href"), "about:blank");
  assert.equal(ui.h("a", { href: " JaVaScRiPt:alert(1)" }).getAttribute("href"), "about:blank");
  assert.equal(ui.h("img", { src: "data:text/html,<script>" }).getAttribute("src"), "about:blank");
  assert.equal(ui.h("img", { src: "data:image/png;base64,AAAA" }).getAttribute("src"), "data:image/png;base64,AAAA");
  assert.equal(ui.h("a", { href: "#home" }).getAttribute("href"), "#home");
  assert.equal(ui.h("a", { href: "https://example.org/x" }).getAttribute("href"), "https://example.org/x");
  assert.equal(ui.h("img", { src: "sprites/25.png" }).getAttribute("src"), "sprites/25.png");
});

test("h() details: classes, booleans, props, dataset, style, nesting, ref", () => {
  let seen = null;
  const el = ui.h("input", {
    class: ["btn", null, "btn-primary", false && "x"], disabled: true, value: "<x>", hidden: false,
    dataset: { slot: 3, skip: null }, style: { "--hp": 0.5, color: "red" }, required: true, autofocus: true,
    ref: (e) => { seen = e; },
  });
  assert.equal(el.className, "btn btn-primary");
  assert.equal(el.disabled, true);
  assert.equal(el.value, "<x>");
  assert.equal(el.hidden, undefined);            // false is skipped
  assert.deepEqual(el.dataset, { slot: "3" });
  assert.equal(el.style["--hp"], "0.5");
  assert.equal(el.style.color, "red");
  assert.equal(el.getAttribute("autofocus"), "");
  assert.equal(seen, el);
  const list = ui.h("ul", null, [1, 2].map((n) => ui.h("li", null, n)), null, false, [[ui.h("li", null, "3")]]);
  assert.equal(list.outerHTML, "<ul><li>1</li><li>2</li><li>3</li></ul>");
  const noAttrs = ui.h("p", "just text");
  assert.equal(noAttrs.outerHTML, "<p>just text</p>");
});

test("svg() creates namespaced elements; clear() replaces children", () => {
  const s = ui.svg("svg", { viewBox: "0 0 10 10", class: "icon" }, ui.svg("rect", { width: 10, height: 10 }));
  assert.equal(s.namespaceURI, "http://www.w3.org/2000/svg");
  assert.equal(s.getAttribute("class"), "icon");
  ui.clear(s, "x");
  assert.equal(s.outerHTML, '<svg viewBox="0 0 10 10" class="icon">x</svg>');
});

test("formatting helpers", () => {
  assert.equal(ui.plural(1, "save"), "1 save");
  assert.equal(ui.plural(3, "box", "boxes"), "3 boxes");
  assert.equal(ui.fmtBytes(512), "512 B");
  assert.equal(ui.fmtBytes(32768), "32 KiB");
  assert.equal(ui.fmtBytes(8192), "8.0 KiB");
  assert.equal(ui.fmtBytes(524288 * 3), "1.5 MiB");
  assert.equal(ui.dexNo(25), "#025");
  assert.equal(ui.dexNo(493), "#493");
  assert.equal(ui.localpart("@ash:example.org"), "ash");
  assert.equal(ui.fmtPlayTime({ h: 123, m: 4, s: 59 }), "123:04");
  assert.equal(ui.truncate("Bulbasaur", 5), "Bulb…");
  assert.equal(ui.truncate("Mew", 5), "Mew");
  assert.equal(ui.initials("Professor Oak"), "PO");
  assert.equal(ui.initials('<img src=x onerror="a">'), "IS");
  assert.equal(ui.initials("🎉"), "?");
  const now = 1_000_000_000_000;
  assert.equal(ui.fmtRelative(now - 10_000, now), "just now");
  assert.equal(ui.fmtRelative(now - 5 * 60_000, now), "5 min ago");
  assert.equal(ui.fmtRelative(now - 3 * 3600_000, now), "3 h ago");
  assert.equal(ui.fmtRelative(now - 2 * 86400_000, now), "2 days ago");
  assert.equal(ui.fmtRelative(0, now), "never");
  assert.equal(ui.hueOf("@ash:example.org"), ui.hueOf("@ash:example.org"));
});
