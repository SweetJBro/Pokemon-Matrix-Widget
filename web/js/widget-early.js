/* Starts the Matrix widget API before anything else can run (classic script, not a module).

   Why this file exists: the hosting Matrix client sends its `capabilities` request as soon as
   the iframe fires "load". If the WidgetApi is not listening by then, the handshake is lost and
   the widget never becomes ready. Module scripts are deferred and app.js awaits the network, so
   the WidgetApi is constructed and started here, synchronously, by a classic script that
   index.html loads right after vendor/matrix-widget-api/api.min.js.

   Everything that arrives before the app is listening (to-widget `update_state` pushes and
   `send_event` deliveries) is acknowledged at once (preventDefault + reply {}, otherwise the
   library answers "unknown action" with an error) and buffered until js/matrix.js drains it.
   We never call sendContentLoaded(): clients use waitForIframeLoad=true and reject it.

   The theme is applied here too (URL parameter, then `theme_change` pushes) so the page does not
   flash the wrong colours while the modules load. Exposes window.PMW_EARLY:
     { isWidget, api, mx, ready, readyPromise, capabilities, buffers, attach(kind, fn), error } */
(function () {
  "use strict";

  // The ONE place to add capabilities. Strings are in docs/research/matrix-widget.md §1.3.
  // OpenID needs no capability (get_openid has its own prompt in the client).
  var CAPABILITIES = [
    "org.matrix.msc2762.receive.state_event:m.room.member",
  ];

  var params = new URLSearchParams(location.search);
  // URL template values that the client did not substitute still start with "$".
  function param(name) {
    var v = params.get(name);
    return v && v.charAt(0) !== "$" ? v : null;
  }

  /** "dark", "light-high-contrast", "custom-Foo Dark" ... -> "dark" | "light" | null. */
  function normaliseTheme(name) {
    var s = String(name || "").toLowerCase();
    if (s.indexOf("dark") >= 0) return "dark";
    if (s.indexOf("light") >= 0) return "light";
    return null;
  }
  function applyTheme(name) {
    var t = normaliseTheme(name);
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");   // prefers-color-scheme decides
  }
  applyTheme(param("theme") || param("client_theme"));

  var early = {
    isWidget: false,
    api: null,
    mx: null,
    ready: false,
    readyPromise: Promise.resolve(),
    capabilities: CAPABILITIES.slice(),
    buffers: { update_state: [], send_event: [] },
    handlers: { update_state: null, send_event: null },
    error: null,
    normaliseTheme: normaliseTheme,
    applyTheme: applyTheme,
    /** Route a buffered action kind to fn(data) from now on, replaying what was buffered. */
    attach: function (kind, fn) {
      early.handlers[kind] = fn;
      var queued = early.buffers[kind].splice(0);
      for (var i = 0; i < queued.length; i++) {
        try { fn(queued[i]); } catch (e) { console.error(e); }
      }
    },
  };
  window.PMW_EARLY = early;

  // Element (in-client iframe), Commet and Vommet add widgetId/parentUrl. Element's pop-out URL
  // has neither; that page then behaves like a plain browser tab, which is what we want.
  if (!(params.has("widgetId") || params.has("parentUrl"))) return;

  var m = window.mxwidgets;
  var mx = typeof m === "function" ? m() : m;   // the UMD bundle may expose a loader function
  if (!mx || !mx.WidgetApi) {
    early.error = "The Matrix widget library did not load.";
    console.error(early.error);
    return;
  }

  var api = new mx.WidgetApi(params.get("widgetId") || undefined);
  early.isWidget = true;
  early.api = api;
  early.mx = mx;
  early.readyPromise = new Promise(function (resolve) {
    api.once("ready", function () { early.ready = true; resolve(); });
  });

  // Someone who turned on room announcements (js/announce.js) gets that permission asked for in the
  // first handshake too, so it survives a reload. The flag is only a hint about what to ask for.
  try {
    for (var k = 0; k < localStorage.length; k++) {
      var key = localStorage.key(k);
      if (key && key.indexOf("pmw.announce.") === 0 && localStorage.getItem(key) === "1") {
        CAPABILITIES.push("org.matrix.msc2762.send.event:m.room.message#m.notice");
        break;
      }
    }
  } catch (e) { /* storage blocked: ask later */ }
  early.capabilities = CAPABILITIES.slice();
  api.requestCapabilities(CAPABILITIES);

  // matrix-widget-api 1.20 stores approved capabilities only from the FIRST notify_capabilities;
  // after a renegotiation (MSC2974) the client's new approval would be acknowledged and forgotten,
  // and hasCapability() would stay false. Keep the latest approval ourselves; the library replies.
  api.on("action:notify_capabilities", function (ev) {
    var approved = ev.detail && ev.detail.data && ev.detail.data.approved;
    if (Array.isArray(approved)) api.approvedCapabilities = approved;
  });

  function bufferAction(kind) {
    api.on("action:" + kind, function (ev) {
      ev.preventDefault();
      try { api.transport.reply(ev.detail, {}); } catch (e) { /* transport stopped */ }
      var data = ev.detail && ev.detail.data;
      if (!data) return;
      if (early.handlers[kind]) {
        try { early.handlers[kind](data); } catch (e) { console.error(e); }
      } else {
        early.buffers[kind].push(data);
      }
    });
  }
  bufferAction("update_state");   // {state: [IRoomEvent]} (widget-api >= 1.13 clients)
  bufferAction("send_event");     // one IRoomEvent (live events; older clients also send state here)

  api.on("action:theme_change", function (ev) {
    ev.preventDefault();
    try { api.transport.reply(ev.detail, {}); } catch (e) { /* transport stopped */ }
    var d = (ev.detail && ev.detail.data) || {};
    applyTheme(d.name || d.theme);
  });

  api.start();
})();
