/* web/js/widget-early.js (run in a vm with a fake matrix-widget-api) and web/js/matrix.js
   (member merging, OpenID outcomes) under node. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";

const EARLY_SRC = fs.readFileSync(new URL("../web/js/widget-early.js", import.meta.url), "utf8");

/** Just enough of matrix-widget-api's WidgetApi for widget-early.js and matrix.js. */
class FakeWidgetApi extends EventEmitter {
  constructor(widgetId) {
    super();
    this.widgetId = widgetId;
    this.requested = null;
    this.started = false;
    this.replies = [];
    this.transport = { reply: (req, data) => this.replies.push({ action: req.action, data }) };
    this.stateEvents = [];
    this.openid = null;   // () => Promise
  }
  requestCapabilities(caps) { this.requested = caps; }
  start() { this.started = true; }
  hasCapability(c) { return this.requested.includes(c); }
  readStateEvents() { return Promise.resolve(this.stateEvents); }
  requestOpenIDConnectToken() { return this.openid(); }
  /** Deliver a to-widget action the way the real library does (cancelable CustomEvent-ish). */
  toWidget(action, data) {
    const ev = { detail: { action, data, requestId: "r" + Math.random() }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit("action:" + action, ev);
    return ev;
  }
}

function runEarly(search) {
  const attrs = new Map();
  const sandbox = {
    location: { search },
    document: { documentElement: { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) } },
    URLSearchParams, console, Promise,
    mxwidgets: () => ({ WidgetApi: FakeWidgetApi }),   // the UMD bundle may expose a loader function
  };
  sandbox.window = sandbox;
  vm.runInNewContext(EARLY_SRC, sandbox, { filename: "widget-early.js" });
  return { early: sandbox.PMW_EARLY, attrs };
}

test("widget-early: not a widget without widgetId/parentUrl, but the theme is applied", () => {
  const { early, attrs } = runEarly("?theme=light");
  assert.equal(early.isWidget, false);
  assert.equal(early.api, null);
  assert.equal(attrs.get("data-theme"), "light");
});

test("widget-early: unsubstituted $templates count as absent", () => {
  const { attrs } = runEarly("?theme=$org.matrix.msc2873.client_theme");
  assert.equal(attrs.has("data-theme"), false);
});

test("widget-early: starts the WidgetApi synchronously with the capability list", () => {
  const { early, attrs } = runEarly("?widgetId=w1&parentUrl=https%3A%2F%2Fapp.element.io&theme=dark-custom");
  assert.equal(early.isWidget, true);
  assert.equal(early.api.widgetId, "w1");
  assert.equal(early.api.started, true);
  assert.deepEqual([...early.api.requested], ["org.matrix.msc2762.receive.state_event:m.room.member"]);
  assert.deepEqual([...early.capabilities], [...early.api.requested]);
  assert.equal(attrs.get("data-theme"), "dark");
});

test("widget-early: update_state / send_event are acked at once and buffered until attach()", () => {
  const { early } = runEarly("?widgetId=w1");
  const member = { type: "m.room.member", state_key: "@a:x", content: { membership: "join" } };
  const ev = early.api.toWidget("update_state", { state: [member] });
  assert.equal(ev.defaultPrevented, true);
  // ({} comes from the vm realm, so compare as JSON)
  assert.equal(JSON.stringify(early.api.replies), '[{"action":"update_state","data":{}}]');
  early.api.toWidget("send_event", { type: "x.y", content: {} });
  const got = [];
  early.attach("update_state", (d) => got.push(["state", d.state.length]));
  early.attach("send_event", (d) => got.push(["event", d.type]));
  early.api.toWidget("update_state", { state: [member, member] });
  assert.deepEqual(got, [["state", 1], ["event", "x.y"], ["state", 2]]);
});

test("widget-early: theme_change pushes switch the theme", () => {
  const { early, attrs } = runEarly("?widgetId=w1&theme=dark");
  early.api.toWidget("theme_change", { name: "light" });
  assert.equal(attrs.get("data-theme"), "light");
  early.api.toWidget("theme_change", { name: "solarized" });
  assert.equal(attrs.has("data-theme"), false);   // unknown: follow prefers-color-scheme
});

/* ---------- matrix.js ---------- */

let matrix, early;
before(async () => {
  ({ early } = runEarly("?widgetId=w1"));
  early.api.once("ready", () => {});
  early.ready = true;
  early.readyPromise = Promise.resolve();
  globalThis.PMW_EARLY = early;
  matrix = await import("../web/js/matrix.js");
});

const member = (id, name, membership = "join", ts = 1, room = "!r:example.org") =>
  ({ type: "m.room.member", state_key: id, sender: id, room_id: room, origin_server_ts: ts, content: { membership, displayname: name } });

test("matrix: members merge pushes and reads by state_key, newest wins", async () => {
  matrix._internal.reset();
  early.api.stateEvents = [member("@ash:example.org", "Ash (old)", "join", 1), member("@misty:example.org", "Misty", "join", 5)];
  await matrix.init();
  const seen = [];
  const off = matrix.onMembers((list) => seen.push(list.map((m) => m.name)));
  matrix._internal.onUpdateState({ state: [member("@ash:example.org", "Ash", "join", 2), member("@brock:example.org", "Brock", "join", 2)] });
  await matrix.refreshMembers();   // the older read for Ash must not win
  await Promise.resolve();
  assert.deepEqual(matrix.members().map((m) => m.name), ["Ash", "Brock", "Misty"]);
  assert.equal(matrix.displayName("@ash:example.org"), "Ash");
  assert.equal(matrix.roomId(), "!r:example.org");
  matrix._internal.onUpdateState({ state: [member("@brock:example.org", "Brock", "leave", 9)] });
  await Promise.resolve();
  assert.deepEqual(matrix.members().map((m) => m.id), ["@ash:example.org", "@misty:example.org"]);
  assert.ok(seen.length >= 1);
  off();
});

test("matrix: a read never replaces a push of the same age; other rooms are ignored", async () => {
  matrix._internal.reset();
  matrix._internal.onUpdateState({ state: [member("@ash:example.org", "Pushed", "join", 7)] });
  early.api.stateEvents = [member("@ash:example.org", "Read", "join", 7), member("@eve:evil.example", "Eve", "join", 99, "!other:evil.example")];
  await matrix.refreshMembers();
  assert.deepEqual(matrix.members().map((m) => m.name), ["Pushed"]);
});

test("matrix: state delivered through send_event (older clients) counts; display names fall back to the id", async () => {
  matrix._internal.reset();
  matrix._internal.onSendEvent({ ...member("@gary:example.org", "   ", "join", 3) });
  const events = [];
  const off = matrix.onRoomEvent((e) => events.push(e.type));
  matrix._internal.onSendEvent({ type: "com.example.ping", sender: "@gary:example.org", content: {} });
  off();
  assert.deepEqual(matrix.members().map((m) => m.name), ["@gary:example.org"]);
  assert.deepEqual(events, ["com.example.ping"]);
});

test("matrix: openIdToken passes the token through and maps failures to clear messages", async () => {
  early.api.openid = () => Promise.resolve({ state: "allowed", original_request_id: "x", access_token: "dev:@ash:example.org", token_type: "Bearer", matrix_server_name: "example.org", expires_in: 3600 });
  assert.deepEqual(await matrix.openIdToken(), { access_token: "dev:@ash:example.org", matrix_server_name: "example.org", expires_in: 3600 });

  early.api.openid = () => Promise.reject(new Error("User declined to verify their identity"));
  await assert.rejects(matrix.openIdToken(), /declined the identity check/);

  early.api.openid = () => Promise.reject(new Error("Request timed out"));
  await assert.rejects(matrix.openIdToken(), /did not answer/);

  early.api.openid = () => new Promise(() => {});   // user sits on the permission prompt
  await assert.rejects(matrix.openIdToken({ timeoutMs: 20 }), /permission prompt/);

  early.api.openid = () => Promise.resolve({ state: "allowed" });
  await assert.rejects(matrix.openIdToken(), /incomplete/);
});
