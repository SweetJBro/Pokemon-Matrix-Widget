# Matrix room widgets with verified identity (research, 2026-10-24)

Scope: how our Pokemon widget (Home storage, trading, battling) should talk to Matrix clients, prove
"this browser session belongs to `@user:server`" to our own Node backend, and what to do in clients that
cannot host widgets. Everything here was checked against source code or specs on 2026-10-24 unless it is
marked **UNVERIFIED**. Downloaded material lives in `/tmp/claude-1000/pkres/matrix-widget/` (not in the
project).

---

## 0. Summary and recommendations

1. **Library**: `matrix-widget-api` **1.20.0** (npm `latest`, published 2026-10-01, Apache-2.0). Load the
   UMD bundle (`dist/api.min.js`, 110,815 bytes) as a classic `<script>` vendored into our `web/vendor/`,
   construct and `start()` the `WidgetApi` synchronously while the first script runs (same rule the
   sibling project already follows).
2. **Identity**: the only verifiable identity a widget can obtain is an **OpenID token** from the
   `get_openid` widget action (MSC1960, `WidgetApi.requestOpenIDConnectToken()`). The widget POSTs
   `{access_token, matrix_server_name}` to our backend; the backend calls
   `GET https://<resolved federation host>/_matrix/federation/v1/openid/userinfo?access_token=...`,
   requires `sub`'s server part to equal `matrix_server_name`, and then issues **our own** session token.
   `$matrix_user_id` / `userId` URL parameters are display hints only and must never authorize anything.
3. **Server-side verification must be SSRF-safe**: validate the server-name grammar, resolve DNS ourselves,
   refuse private/loopback/link-local/CGNAT/multicast ranges *at connect time* (Node `lookup` hook), cap
   redirects, sizes and timeouts, bound and expire caches. A working Node 26 prototype is in section 2.6.
4. **Client reality in 2026**: full widget + OpenID support exists in **Element Web/Desktop**, **Commet**
   and **Vommet** (both verified from the user's installed Flatpaks and their source). **Element X (iOS and
   Android), Cinny and FluffyChat do not host room widgets**; **Nheko** only opens widget URLs in an external
   browser without the widget API. Element Classic mobile is being removed from the stores on 2026-12-31.
5. **Fallback auth** (for Element X etc. and for "open in a real browser tab"): a community bot that sends a
   one-time code by Matrix DM ("enter your MXID, type the 6-digit code the bot DMs you"), plus a
   widget-to-browser one-time **handoff link** for users who already authenticated inside a widget. Do not
   ask for Matrix passwords or access tokens. Matrix OAuth 2.0 (MAS) login is possible but only defines a
   full-account scope, so it is not recommended for a game site.
6. **Do not rely on any browser storage inside the widget**: Element's iframe storage is partitioned per
   top-level site (and ephemeral in Brave), Commet/Vommet desktop widget windows are **incognito**
   (ephemeral WebKit/WebView2 contexts). The server is the source of truth; the widget re-authenticates with
   OpenID (silently when the user ticked "remember").
7. **Iframe constraints**: Element's sandbox has `allow-downloads` and `allow-popups(-to-escape-sandbox)`
   but **no `allow-modals`** (no `alert/confirm/prompt`). `showSaveFilePicker()`/`showOpenFilePicker()` are
   refused in cross-origin iframes; use `<input type="file">` to read saves and an `<a download>` Blob link
   (from a click) or a one-time server download URL to hand modified saves back.
   Our `Content-Security-Policy` must be `frame-ancestors * vector:` (or list `vector://vector`): CSP3's
   `*` does **not** match Element Desktop's `vector://vector` origin.
8. **Member list**: since widget-api 1.13 the client pushes full room state through the `update_state`
   to-widget action; `readStateEvents()` may only see the loaded timeline on Element. Handle
   `action:update_state` **and** call `readStateEvents()` (Commet answers it from real room state). Verified
   in headless Chromium (section 1.4).
9. **Dev harness**: extend the sibling `fake-matrix.html` pattern with `askOpenID()` (two-phase
   "request" then "allowed") and a dev-only fake federation `userinfo` endpoint reached through an explicit
   `MATRIX_FEDERATION_OVERRIDES` map, so the real verification code path runs locally (section 6).

---

## 1. matrix-widget-api (widget side)

### 1.1 Version, licence, loading without a build step

| Fact | Value | Source |
|---|---|---|
| Latest version | `1.20.0` (`dist-tags.latest`), published 2026-10-01T14:36:20Z | `npm view matrix-widget-api` |
| Licence | Apache-2.0 (compatible with our MIT code if the NOTICE/licence is kept with the vendored file) | `npm view`, `package/LICENSE` |
| Runtime deps | `events` ^3.2.0 (bundled into `dist/api.js` / `dist/api.min.js`) | `package/package.json` |
| Browser bundle | `dist/api.min.js` (UMD; sets `window.mxwidgets`) | `package/dist/` |
| Recent changes | 1.13.0 added the `org.matrix.msc2762_update_state` API version (client stops pushing state via `send_event`, uses `update_state`); 1.15/1.16.1 sticky events (MSC4354/MSC4407); 1.18 MSC4515 RTC transports; 1.19/1.20 MSC4533 LiveKit actions (1.20 is a breaking change only for those LiveKit actions) | GitHub releases of matrix-org/matrix-widget-api |

`window.mxwidgets` may be the exports object or a function returning it, depending on how the UMD wrapper is
evaluated; unwrap with `typeof m === "function" ? m() : m` (the sibling project does this; in Node,
`require("dist/api.js")` returns the object directly, checked locally). Importing the UMD file as an ES module
is **UNVERIFIED**; the classic-script approach is proven by the sibling project.

**Startup timing.** Element's `ClientWidgetApi` waits for the iframe `load` event and then immediately sends
the `capabilities` request (`waitForIframeLoad` defaults to true). The widget therefore has to construct
`new WidgetApi(widgetId)` and call `start()` during initial script evaluation. Module scripts are fine as long
as nothing awaits the network before construction. Do **not** call `sendContentLoaded()`: with
`waitForIframeLoad=true` Element rejects it (sibling project comment in `web/js/matrix-lobby.js`, lines 70-71).

### 1.2 Wire protocol basics

Every message is `{api: "fromWidget"|"toWidget", widgetId, requestId, action, data, response?}` over
`postMessage`. The widget-side `PostmessageTransport` posts to `targetOrigin = "*"` unless a `clientOrigin`
is given to the `WidgetApi` constructor, and by default does **no** origin check on incoming messages
(`strictOriginCheck = false`); it filters only on `api` direction and `widgetId`
(`src/transport/PostmessageTransport.ts`, lines 43-44 and 157-174).

Do **not** pass a `clientOrigin` derived from `parentUrl`: Commet/Vommet send `parentUrl=commet://widget`
(non-special scheme, `new URL(...).origin === "null"`, an invalid `targetOrigin`), and their relay pages have
yet another real origin (`http://localhost:<port>`). Security must come from the server-side OpenID check, not
from postMessage origins.

Legacy query parameters added by clients (not part of the template spec): `widgetId` and `parentUrl`. Element
adds them only for the in-client iframe, **not** for the "pop out" URL
(`apps/web/src/stores/widgets/WidgetMessaging.ts`, lines 252-264). Commet/Vommet always add `widgetId` and
set `parentUrl` to `commet://widget` (or `http://localhost/widget` for embedded/Android runners).

### 1.3 Capability strings (exact)

All event capabilities are still under MSC unstable prefixes. Parsed by
`WidgetEventCapability.findEventCapabilities` (`src/models/WidgetEventCapability.ts`).

| Purpose | Capability string | Notes |
|---|---|---|
| Read member list of the viewed room | `org.matrix.msc2762.receive.state_event:m.room.member` | `#<state_key>` suffix limits to one key; no suffix = all keys |
| Send our custom room events | `org.matrix.msc2762.send.event:<type>` | e.g. `org.matrix.msc2762.send.event:com.example.pokehome.challenge` |
| Receive our custom room events | `org.matrix.msc2762.receive.event:<type>` | delivered as to-widget `send_event` actions |
| Send/receive `m.room.message` of one msgtype | `org.matrix.msc2762.send.event:m.room.message#m.notice` | msgtype after `#`; no suffix = all msgtypes |
| Send state | `org.matrix.msc2762.send.state_event:<type>[#<state_key>]` | needs room power level |
| Other rooms' timelines | `org.matrix.msc2762.timeline:<roomId>` or `org.matrix.msc2762.timeline:*` | not needed for the viewed room |
| To-device | `org.matrix.msc3819.send.to_device:<type>`, `org.matrix.msc3819.receive.to_device:<type>` | |
| Room account data (read) | `com.beeper.capabilities.receive.room_account_data:<type>` | |
| Upload/download media | `org.matrix.msc4039.upload_file`, `org.matrix.msc4039.download_file` | homeserver media repo, not browser downloads |
| Hide Element's pop-out button | `io.element.requires_client` | deprecated, auto-approved by Element |
| Keep visible | `m.always_on_screen` | |
| **OpenID token** | *(no capability string)* | `get_openid` is an action with its own user prompt; Commet internally auto-grants a pseudo capability `m.oidc` |

Full enum in `src/interfaces/Capabilities.ts` (`MatrixCapabilities`). Helpers exist on `WidgetApi`:
`requestCapabilityToReceiveState(type, stateKey?)`, `requestCapabilityToSendEvent(type)`,
`requestCapabilityToReceiveEvent(type)`, `requestCapabilityForRoomTimeline(roomId)`.

Element prompts the user for every capability that is not auto-granted and can remember the approval per
widget id in `localStorage` (`widget_<id>_approved_caps`; `ElementWidgetDriver.ts`, lines 71-77, 253-301).
Self-hosted Element Web instances can pre-approve loading, identity and capabilities per widget URL pattern
via the `io.element.element-web-modules.widget-lifecycle` config (`modules/widget-lifecycle/README.md`).

**Recommended minimal set for us**: `receive.state_event:m.room.member` (to list trade/battle partners) and,
only if we want room-visible lobby announcements, one `send.event` + `receive.event` pair on a single
namespaced type. Trades/battles/Home storage themselves go through our HTTPS/WebSocket API, not room events.

### 1.4 Reading room members (verified)

Since 1.13.0 a widget built with this library advertises `org.matrix.msc2762_update_state`
(`CurrentApiVersions` in `src/interfaces/ApiVersion.ts`). A client using the same library then:

* pushes the **full current state** for each approved `receive.state_event` capability with a to-widget
  `update_state` action `{state: IRoomEvent[]}` after capability approval and whenever the viewed room
  changes (`ClientWidgetApi.pushRoomState` / `flushRoomState`, lines 1280-1300 and 1341-1381), and later
  single changes through `feedStateUpdate()`;
* answers `read_events` with a `state_key` from the **timeline** (`driver.readRoomTimeline(...)`), not from
  room state (`ClientWidgetApi.handleReadEvents`, around line 598).

The widget-side `WidgetApi` has **no default handler** for `update_state`; unhandled to-widget actions are
answered with an error (`WidgetApi.handleMessage`). The widget must do:

```js
api.on("action:update_state", (ev) => {
  ev.preventDefault();
  api.transport.reply(ev.detail, {});
  for (const e of ev.detail.data.state) if (e.type === "m.room.member") upsertMember(e);
});
```

Commet/Vommet also advertise `org.matrix.msc2762_update_state`, send `update_state`, **and** answer
`readStateEvents()` from real room state (`mx_capability_receive_state.dart`, lines 50-69 and 151-167).
So: handle `update_state` and also call `readStateEvents()`; merge by `state_key`.

**Empirical check** (headless Chromium 1.20.0 bundle, a `ClientWidgetApi` driver whose timeline is empty and
whose `readRoomState` returns Alice and Bob; files in the scratchpad `harness-test/`): the widget received
`update_state` with `["@alice:example.org","@bob:example.org"]`, while `readStateEvents("m.room.member")`
returned `[]`. The sibling project's `members()` (which only calls `readStateEvents`) would therefore show an
incomplete list on Element Web; its fake harness hides this because it never calls `setViewedRoomId()` and so
exercises the deprecated driver path.

### 1.5 Sending and receiving room events

* Send: `api.sendRoomEvent(type, content)` (needs `send.event:<type>`). Element encrypts it if the room is
  encrypted.
* Receive live: to-widget `send_event` action with the raw event; `preventDefault()` and reply `{}` (as the
  sibling does).
* History: `api.readRoomEvents(type, limit)` (`org.matrix.msc2876.read_events`). Commet handles this action
  even though it only advertises `org.matrix.msc2876` in debug builds (`matrix_widget_message_handler.dart`,
  lines 140-157).
* Trust: use the event's `sender` (set by the homeserver), never identity fields inside `content`. The
  sibling lobby trusts `content.from.id`; we must not.

### 1.6 OpenID (MSC1960, `get_openid`)

Wire flow (MSC1960 text, `proposals/1960-integrations-openid.md`):

1. widget -> client: `{api:"fromWidget", action:"get_openid", data:{}}`
2. client replies with `response.state` = `"allowed"` (+ credentials), `"blocked"`, or `"request"`
   (user is being asked; no timeout).
3. If `"request"`: later client -> widget `{api:"toWidget", action:"openid_credentials",
   data:{state, original_request_id, access_token, token_type, matrix_server_name, expires_in}}`; the widget
   acknowledges with an empty response.

The credentials are copied verbatim from `POST /_matrix/client/v3/user/{userId}/openid/request_token`
(example: `{"access_token":"SomeT0kenHere","token_type":"Bearer","matrix_server_name":"example.com",
"expires_in":3600}`; spec `data/api/client-server/openid.yaml`).

`WidgetApi.requestOpenIDConnectToken()` (`src/WidgetApi.ts`, lines 342-385) implements both phases and
resolves with the response object (which also contains `state` and, in the two-phase case,
`original_request_id`); it rejects with "User declined to verify their identity" on `blocked`. Forward only
`access_token` and `matrix_server_name` (and `expires_in` as a hint) to our server.

Client behaviour:

| Client | Behaviour | Source |
|---|---|---|
| Element Web/Desktop | `askOpenID`: module pre-approval -> remembered allow/deny -> otherwise replies `request` and shows `WidgetOpenIDPermissionsDialog` with a "remember" checkbox. Remembered key = `encodeURIComponent("<roomId>::<widget.templateUrl>")` at **device** level, so a different room or a changed widget URL asks again | `ElementWidgetDriver.ts` 662-705, `WidgetPermissionStore.ts` |
| Commet / Vommet | Always replies `request` first, then prompts "Allow <name> to verify your user id" with remember (default on); remembered as `chat.commet.internal.get_openid_auto_accept` per widget namespace (`roomId_id_sender_url`); calls `requestOpenIdToken` and sends `openid_credentials` | `mx_capability_oidc.dart` |

The dev harness must therefore exercise the two-phase path (section 6).

### 1.7 URL templates

`runTemplate` in widget-api supports `$matrix_room_id`, `$matrix_user_id`, `$matrix_display_name`,
`$matrix_avatar_url`, `$matrix_widget_id`, `$org.matrix.msc2873.client_id|client_theme|client_language`,
`$org.matrix.msc3819.matrix_device_id`, `$org.matrix.msc4039.matrix_base_url`, values URI-encoded
(`src/templating/url-template.ts`). Commet/Vommet replace only `$matrix_user_id`, `$matrix_room_id`,
`$matrix_display_name`, device id, base URL, `$org.matrix.msc2873.client_theme` and
`$chat.commet.color_scheme`, by raw string replacement **without** per-value encoding
(`matrix_widget_component.dart`, `openWidget`). So: treat any parameter that still starts with `$` as absent,
do not put user-controlled templates into paths, and take the display name from member state instead.
MSC1960 itself states `$matrix_user_id` "cannot be relied upon due to how easy it is to falsify".

Suggested widget URL to put in the `im.vector.modular.widgets` state event:
`https://poke.example/widget/?theme=$org.matrix.msc2873.client_theme&lang=$org.matrix.msc2873.client_language`
(state content: `{type:"m.custom", url, name, id, creatorUserId, data:{}}`, state key = id; same shape Commet
writes in `addWidget`).

---

## 2. Server-side verification of the OpenID token

### 2.1 Spec facts

| Item | Fact | Source |
|---|---|---|
| Endpoint | `GET /_matrix/federation/v1/openid/userinfo?access_token=<token>` | `data/api/server-server/openid.yaml` |
| Auth | none (no X-Matrix signature); Synapse servlet `REQUIRE_AUTH = False` | Synapse `federation/transport/server/__init__.py` lines 212-262 |
| 200 body | `{"sub": "@alice:example.com"}` (`sub` required) | spec yaml |
| 401 | `M_UNKNOWN_TOKEN` (unknown/expired); Synapse also `M_MISSING_TOKEN` when no token | spec yaml, Synapse |
| **MUST** | "The caller MUST validate that the returned user ID is on the server they called" | spec yaml, `sub` description |
| Token lifetime | Synapse: `EXPIRES_MS = 3600 * 1000` (1 h) | Synapse `rest/client/openid.py` line 72 |
| Reusable? | **Yes until expiry**: Synapse looks tokens up with `WHERE token = ? AND ? <= ts_valid_until_ms` and never deletes on use | Synapse `storage/databases/main/openid.py` |
| Live check | `matrix.org` -> `.well-known/matrix/server` = `{"m.server":"matrix-federation.matrix.org:443"}` (`cache-control: max-age=14400`); `userinfo` with a bogus token -> `401 {"errcode":"M_UNKNOWN_TOKEN","error":"Access Token unknown or expired"}` | curl + Node prototype, 2026-10-24 |

Server names (spec appendix "Server Name"): `server_name = hostname [":" port]`, `hostname = IPv4address /
"[" IPv6address "]" / dns-name`, `dns-char = DIGIT / ALPHA / "-" / "."`, `port = 1*5DIGIT`; compared
**case-sensitively**; recommended max 230 chars.

### 2.2 Resolving the federation base URL (spec v1.19, "Resolving server names")

| Case | Connect to | `Host` header | TLS certificate must match |
|---|---|---|---|
| 1. IP literal | IP : port or 8448 | server name (incl. port if given) | the IP |
| 2. hostname with explicit port | A/AAAA(CNAME) of hostname : port | server name with port | hostname |
| 3. `GET https://<hostname>/.well-known/matrix/server` valid (follow 30x, avoid loops) -> `m.server` = `delegated[:port]` | | | |
| 3a. delegated IP literal | IP : port or 8448 | IP (+port) | the IP |
| 3b. delegated host + port | A/AAAA of delegated : port | `delegated:port` | delegated host |
| 3c. delegated host, no port | SRV `_matrix-fed._tcp.<delegated>` -> target:port | delegated host | delegated host |
| 3d. (deprecated) | SRV `_matrix._tcp.<delegated>` | delegated host | delegated host |
| 3e. no SRV | A/AAAA of delegated : 8448 | delegated host | delegated host |
| 4. well-known error | SRV `_matrix-fed._tcp.<hostname>` | hostname | hostname |
| 5. (deprecated) | SRV `_matrix._tcp.<hostname>` | hostname | hostname |
| 6. nothing | A/AAAA of hostname : 8448 | hostname | hostname |

Caching: cache well-known responses including errors, respect `Cache-Control`, default 24 h, max 48 h,
errors up to 1 h with exponential back-off. SRV targets must not be CNAMEs. (Source:
`content/server-server-api.md` in matrix-org/matrix-spec, section "Resolving server names".)

### 2.3 How existing services do it (and where they disagree with the spec)

**Element's lk-jwt-service v0.9.0** (2026-10-13; now Rust, `src/helper.rs`, `src/handler.rs`):

* `resolve_federation_base_url` (helper.rs 1240-1308): explicit port -> `https://<server_name>`; else
  `GET https://<name>/.well-known/matrix/server` (10 s timeout); valid `m.server` -> `https://<m.server>`
  (adding `:8448` if portless); otherwise `https://<name>:8448`. **No SRV lookups at all.** Results cached
  1 h (`FEDERATION_BASE_URL_TTL`), cache bounded to 10,000 entries "because server names arrive in
  unauthenticated requests"; transport errors are not cached.
* `exchange_openid_userinfo` (helper.rs 642-674): `GET {base}/_matrix/federation/v1/openid/userinfo` with
  `access_token` as a properly encoded query param, 30 s timeout.
* `verify_openid_token` (handler.rs 706-740): rejects unless the server part of `sub` (text after the
  **first** `:` following `@`) **equals** `matrix_server_name`, and unless an optional claimed user id
  equals `sub`.
* No IP-range filtering for outbound requests (it relies on deployment). It distinguishes "full access"
  homeservers (`LIVEKIT_FULL_ACCESS_HOMESERVERS`, can be `*`) from restricted ones; config also has
  `LIVEKIT_CS_API_URL_OVERRIDES` (`example.com=matrix-client.example.com`) for C-S discovery.

**matrix-org/matrix-user-verification-service** (Node, `src/matrixUtils.js`, `src/utils.js`, `src/verify.js`):

* Optional single-homeserver mode (`UVS_OPENID_VERIFY_SERVER_NAME`); default trusts any server name.
* Implements the older spec steps with only the deprecated `_matrix._tcp` SRV, and puts the SRV *target*
  into the URL (so TLS is checked against the target, not the delegated name as the spec requires).
* Blocks private ranges (127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, 192.0.0/24, 169.254/16, 198.18/15,
  TEST-NETs, 224/4, ::1, fe80::/10, fc00::/7, fec0::/10, mapped v4) **by resolving before connecting**,
  which leaves a DNS-rebinding window; re-checks every redirect hop, max 4 redirects, 10 s timeout.
* Accepts `sub` if it `endsWith(":" + serverName)` and builds the URL as `?access_token=${token}` without
  URL-encoding (bug).
* README notes servers without a federation listener can expose Synapse's `openid` listener resource on the
  client port, but still need resolvable `.well-known/matrix/server`.

**Disagreement**: the spec requires `_matrix-fed._tcp` SRV handling; lk-jwt skips SRV and UVS uses only the
deprecated `_matrix._tcp`. I believe the spec; in practice nearly all public servers use `.well-known` or
port 8448, so lk-jwt's shortcut works for most users, but implementing the full table costs little in Node
(`dns.promises.resolveSrv`). Implement it, with SRV failures falling through to the next step.

### 2.4 Our verification algorithm (own words)

```
verify({access_token, matrix_server_name}):
  1. Shape: token is a string of 1..1024 visible ASCII chars; server name matches the spec grammar,
     <= 255 chars. Otherwise 400.
  2. Policy: if HOMESERVER_ALLOWLIST is set and the name is not in it -> 403 without any network I/O.
     (Optional: reject IP-literal server names outright.)
  3. Token cache: key = sha256(token). Hit and not expired -> return cached mxid.
  4. Resolve target (section 2.2) with: HTTPS only; each hostname resolved through the safe lookup
     (2.6); well-known: <= 3 redirects, each hop re-validated, 5-10 s timeout, body <= 64 KiB,
     must parse as JSON object with string m.server matching the server-name grammar.
     Cache result per server name: success 1-24 h (respect Cache-Control, cap 48 h), failure 1 h with
     back-off; LRU-bound the cache (e.g. 10k entries).
  5. GET /_matrix/federation/v1/openid/userinfo?access_token=<URLSearchParams-encoded> on the target,
     with the Host header and TLS servername from the table; no redirects; 10 s timeout; <= 64 KiB.
  6. 200 + JSON {sub: string} else reject (401 -> invalid/expired; others -> 502 "homeserver unreachable").
  7. sub must start with "@", the localpart (up to the first ":") must be non-empty, and the remainder
     must equal matrix_server_name byte-for-byte. Total length <= 255.
  8. Optional community gate: bot account checks the mxid is joined to the configured room(s)
     (GET /_matrix/client/v3/rooms/{roomId}/joined_members as the bot, cached ~60 s).
  9. Cache sub under sha256(token) for min(expires_in, 3600) s minus a margin.
 10. Create our session: 256-bit random opaque token stored in SQLite (mxid, created_at, expires_at
     ~12 h, client hint), return it; the widget sends it as Authorization: Bearer.
```

### 2.5 Pitfalls checklist

* **Trusting `matrix_server_name`**: it is client-supplied. Without step 7 anyone running a fake
  homeserver can return `sub: "@victim:matrix.org"`. With step 7 an attacker can only become users on
  servers they control, which is why an allowlist (or a membership gate via the bot) matters for a closed
  community.
* **SSRF**: the server name makes our backend fetch `https://<attacker-chosen-host>/...`. Block internal
  ranges at **connect time** (not just a pre-resolve), restrict to HTTPS, cap redirects and body sizes,
  and rate-limit `/auth/openid` per client IP and per server name. Never follow `m.server` to an IP in a
  blocked range.
* **Token replay / no audience**: OpenID tokens are bearer tokens without an audience, reusable for their
  whole lifetime (1 h on Synapse). Anyone who sees one (logs, proxies, another widget the user approved)
  can log in to every OpenID-relying service as that user during that hour, and conversely our server
  could replay tokens elsewhere. Mitigate on our side: never log tokens or full request URLs, send them in
  a POST body over HTTPS (not a query string to *our* server), exchange once for our own short session,
  and have the widget ask for a fresh token right before calling `/auth`.
* **Caching**: cache resolution (bounded) and token->mxid (bounded, until expiry). Do not cache negative
  token results for long; do cache resolution failures for <= 1 h.
* **Homeservers without federation**: verification fails if the server exposes neither a federation
  listener nor Synapse's `openid` resource (UVS README). Offer the bot fallback.
* **Case and normalisation**: server names are case-sensitive; do not lowercase mxids before comparing.
* **Membership is not identity**: OpenID proves who, not where. The widget's `roomId` parameter is
  unverified; use the bot for membership.
* **Time**: trust `expires_in` only as an upper bound; our own session expiry is what matters.

### 2.6 Node 26 implementation notes (prototype run 2026-10-24, Node v26.12.0)

A zero-dependency prototype (`node:https` + `node:dns` + `node:net`; scratchpad `verify-proto.mjs`)
fetched matrix.org's well-known, followed the delegation to `matrix-federation.matrix.org:443`, got the
expected `401 M_UNKNOWN_TOKEN`, and refused `localhost` with `EBLOCKED`. Key techniques:

* Pass a `lookup(host, opts, cb)` option to `https.request`; inside it call
  `dns.lookup(host, {all:true, verbatim:true})`, drop blocked addresses with a `net.BlockList`, and honour
  `opts.all` (Node's happy-eyeballs connect calls `lookup` with `all: true`). Because the same callback
  supplies the address that is actually connected, there is no rebinding gap.
* `servername:` sets TLS SNI and the name the certificate is checked against; `headers: {Host: ...}` sets
  the Matrix `Host` value. For SRV results: `host: srvTarget, port: srvPort, servername: delegatedHost,
  headers.Host: delegatedHost`.
* **`net.BlockList` gotcha (verified)**: an IPv4 address matches IPv4-mapped IPv6 rules and vice versa.
  Adding `::ffff:0:0/96` blocks **every** IPv4 address; add only the IPv4 ranges and they also cover their
  `::ffff:` forms.
* Ranges to block (IPv4): 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24,
  192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4. (IPv6): ::/128, ::1/128,
  64:ff9b::/96 (NAT64, optional), fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32.
* `dns.promises.resolveSrv("_matrix-fed._tcp." + host)` for SRV; sort by priority/weight.
* Dev/test override: a `MATRIX_FEDERATION_OVERRIDES` map (`example.org=http://127.0.0.1:8081/dev/fake-federation`)
  that bypasses discovery and IP filtering **only for listed names**; refuse to start with overrides when
  `NODE_ENV=production`.

---

## 3. Which clients host room widgets (October 2026)

| Client | Renders room widgets | Widget API | `get_openid` | Notes |
|---|---|---|---|---|
| **Element Web** | Yes | Reference implementation (uses matrix-widget-api `ClientWidgetApi`) | Yes, prompt + remember | sandbox/allow details in section 5 |
| **Element Desktop** | Yes (same web app in Electron, served from `vector://vector/webapp/`) | Yes | Yes | frame ancestor origin is `vector://vector` (`element-desktop/src/electron-main.ts` lines 305-320, 481); `window.open` opens the system browser (http/https/mailto only); downloads show the native save dialog |
| **Element X iOS / Android** | **No** (only the built-in Element Call widget) | - | - | Requests open: element-meta#3099 (2026-01, last comment 2026-10-14) and element-x-android#7099 (2026-06); community PR element-x-android#6480 "Add Widget support" **closed unmerged** 2026-06-03 |
| Element Classic Android/iOS | Yes (legacy) | Yes (OpenID support **UNVERIFIED**) | ? | Element's FAQ: Classic is removed from stores on **2026-12-31** (existing installs keep working) |
| **Cinny** | **No** | Only embedded Element Call | - | cinny#372 "Room Widgets" open since 2022, comments through 2026-04 cite Commet; PR #2335 (Element Call + "rudimentary widget support") closed unmerged 2026-02-14 |
| **FluffyChat** | **No** | - | - | PR #2384 "First draft implementation of Element Call and Widget API" closed unmerged (head repo deleted 2026-09-14); no webview dependency in `pubspec.yaml` on main |
| **Nheko** | Lists widgets under the topic and opens them **in the external browser** (since 0.9.2, 2022-03-09) | No | No | latest release 0.12.1 (2025-08-10); issue #82 "Add support for widgets" still open. Our page would run in standalone mode |
| **Commet** (`chat.commet.commetapp`) | **Yes** | Own Dart implementation | **Yes** (two-phase) | Details below |
| **Vommet** (`im.nether.chat`) | **Yes** | Commet's implementation + fork fixes | **Yes** | Details below |

### 3.1 Commet (verified from installed Flatpak build 2026-09-24 and commetchat/commet `main`)

* Reads `im.vector.modular.widgets` state, lists widgets in the room, "Add widget" writes the state event
  (`matrix_widget_component.dart`, `getWidgets`/`addWidget`). Installed `libapp.so` contains
  `MatrixWidgetApi`, `get_openid`, `openid_credentials`, `im.vector.modular.widgets`, and the runner
  assets `widget_runner_{remote,embedded,android}.html`, `widgets_common.js`, `widgets_ipc.js`.
* Host per platform (`defaultHostType`):
  * **Linux: `externalBrowser`**: starts a local HTTP server, then launches **host Chromium** (`chromium`
    or `google-chrome` found with `which`, run through `flatpak-spawn --host` with
    `WAYLAND_DISPLAY=wayland-0`/`DISPLAY=:0`) as `--app=http://localhost:<port>/?token=<secret>
    --user-data-dir=<tmp>/chat.commet.app/widget_runner`. That page iframes our widget
    (`<iframe allow="fullscreen">`, **no sandbox attribute**) and relays postMessage over
    `/transceiver/send|receive` long-polling (`matrix_widget_remote_http_runner.dart`,
    `widget_runner_remote.html`). Error if neither browser exists: "Could not find any installed chromium
    browser to run widget". On this machine `/usr/bin/chromium` exists, and the Flatpak has
    `org.freedesktop.Flatpak=talk`, so Commet widgets should open in a Chromium app window.
  * Windows: `childProcess` (`commet --widget_runner`, a wry window, widget loaded **as the top-level page**
    with the `widgets_ipc.js` polyfill; `with_incognito(true)`, spoofed UA
    `... WebKitGTK/537.36 ... Chrome/147.0.0.0 ...`; `rust/rust/src/widget_runner.rs`).
  * Android: `MatrixWidgetActivity` WebView with an iframe page; Web: embedded iframe; macOS/iOS:
    `supportedHostTypes()` throws `UnimplementedError` upstream.
  * Also `remoteHttpClient` ("open on another device": self-signed HTTPS server on the LAN IP + QR code).
* The polyfill (top-level runners) replaces `window.parent.postMessage` and captures
  `window.addEventListener("message", ...)`; messages are delivered with `origin: "commet://widget"`.
  Do not rely on `removeEventListener` or on a real `window.parent`.
* Supported versions advertised include `org.matrix.msc2762`, `org.matrix.msc2762_update_state`,
  `org.matrix.msc2871`, `org.matrix.msc2974`, `org.matrix.msc4039`, `town.robin.msc3846`,
  `org.matrix.msc3819`, `org.matrix.msc3869` (release builds).

### 3.2 Vommet (verified from installed Flatpak build 2026-10-21, vommet.app, nether.codes/nether/vommet)

* "An unofficial, LLM-assisted fork of the Commet Matrix client" (vommet.app). Same `rust_lib_commet`,
  same widget code base, plus fork changes on its `testing` branch (which tester builds use).
* In-app widget catalog (`assets/data/widget_catalog.json`) includes **Park Chess**
  (`https://vommet.app/widgets/park-chess/play/?widgetId=$matrix_widget_id&userId=$matrix_user_id&...`,
  type `app.vommet.park_chess`, sends room events of that type), Luanti, Drawpile, Neoboard, Watch Party,
  Paperchat; the Widgets panel "accepts any widget link" (changelog 2026-10-10).
* **Linux default host = its own WebKit window** (`childProcess`), "so no build needs Chromium"
  (testing-branch `matrix_widget_component.dart` lines 156-239): wry 0.54 + `webkit2gtk` 4.1
  (`.vommet/widgets/runner/Cargo.toml`); the GNOME 51 runtime ships **WebKitGTK 2.54.1**. Widget is the
  **top-level page** with the postMessage polyfill, **`with_incognito(true)`**. Users can switch to the
  external browser globally or per widget; call widgets always go to the browser. An experimental "Docked
  widgets" mode (off by default per the 2026-10-20 changelog) embeds a WebKit view created with
  `webkit_web_context_new_ephemeral()` (`linux/widget_dock.cc` line 383).
* Changelog entries that matter for us (installed `assets/data/changelog.json`):
  * 2026-10-19: "On Linux, widgets open in Vommet's own window instead of needing Chromium".
  * 2026-10-19: "Watch Together and other widgets that sign you in now work in Vommet's own widget window on
    Linux and Windows instead of waiting forever on 'Confirming who you are'" (OpenID works there).
  * 2026-10-12: "Widgets you can watch but not use show a View only badge".
  * 2026-10-13: Flatpak widgets fixed on displays other than `wayland-0`.
* Same template substitution gap as Commet (no `$matrix_widget_id`, `$matrix_avatar_url`,
  `$org.matrix.msc2873.client_language` replacement in `openWidget`).

**Implication**: Commet and Vommet both render our widget and answer `get_openid`, so OpenID verification
works there, but their desktop widget windows keep **no storage across sessions**.

---

## 4. Fallback authentication (no widget support, or a normal browser tab)

### 4.1 Options compared

| Option | Works with | Security | Verdict |
|---|---|---|---|
| **A. MXID + one-time code by bot DM** (user enters `@me:server`; bot DMs a 6-8 digit code valid 10 min; user types it on our page) | Every client (Element X, Cinny, FluffyChat, Nheko...) and every browser | Proves control of the account's DMs. Real-time phishing of the code is possible (standard OTP risk; bot message names our domain). DM spam: only DM members of the community room(s), rate-limit per target and per IP | **Recommended primary fallback** |
| **B. `!pokehome login` command -> bot DMs a one-time magic link** (`https://poke.example/login#t=<256-bit>`, fragment so it is not logged; page POSTs it) | Every client; the link opens where the user taps it | Initiated from the authenticated Matrix side, so no session-fixation; link single-use, 10 min | **Recommended convenience path** (mirrors the sibling project's Fluxer bot links) |
| C. Page shows a code, user sends it to the bot | Every client | Login-CSRF/"device-code phishing": an attacker can get a victim to send the attacker's code and gain a session as the victim | Avoid, or only with an extra confirmation step |
| D. Matrix OAuth 2.0 (MAS) "log in with Matrix" | Only homeservers on the OAuth 2.0 API (spec v1.15+; e.g. matrix.org) | Spec defines only `urn:matrix:client:api:*` (full read/write) and `urn:matrix:client:device:<id>`; a read-only scope is only mentioned as a possible future MSC (`content/client-server-api/_index.md`, "Allocated scope tokens") | Not recommended (full account access for a game) |
| E. Ask for password or access token | Everyone | Teaches users to hand over full credentials; an access token is full account control | **Never** |

Bot implementation notes: the bot can create the DM room itself without `m.room.encryption` (no E2EE stack
needed; Element X shows an "unencrypted" notice) or run an E2EE-capable SDK (**UNVERIFIED** which one we
pick). The bot is also the natural place for the membership gate of section 2.4 step 8.

### 4.2 Widget-to-browser handoff

When a user already authenticated in a widget but needs a real browser tab (Commet/Vommet incognito
windows, file downloads, Element's pop-out button which drops `widgetId`/`parentUrl`): the widget asks
`POST /api/auth/handoff` (Bearer session) for a one-time, 2-minute, single-use code and opens
`https://poke.example/#handoff=<code>` with `window.open` (Element Web: new tab outside the sandbox;
Element Desktop: system browser via `shell.openExternal`). The standalone page exchanges the code for its
own session.

---

## 5. Iframe and host constraints

### 5.1 Element's iframe

From `apps/web/src/components/views/elements/AppTile.tsx` (lines 62-74, 509-514):

* `sandbox="allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts allow-presentation allow-downloads"`
* `allow="microphone; camera; encrypted-media; autoplay; display-capture; clipboard-write; clipboard-read;"`, `allowFullscreen = true`
* Consequences: **no `allow-modals`** (`alert/confirm/prompt/print` are blocked; build in-page dialogs for
  trade confirmations); no `allow-top-navigation`; no `allow-storage-access-by-user-activation` (so no
  Storage Access API); `navigator.clipboard.writeText` allowed (needs user activation); popups escape the
  sandbox; Element shows a "mixed content" error for `http:` widgets on an `https:` Element.
* Widgets added by someone else show a "load this widget?" permission card first (`AppPermission`).

### 5.2 `frame-ancestors`

* CSP3 (`w3c.github.io/webappsec-csp`, "Does url match expression in origin with redirect count?"): `*`
  matches only HTTP(S) URLs or URLs whose scheme equals the protected resource's scheme; other schemes must
  be listed explicitly.
* Element Desktop frames widgets under `vector://vector`. An Element maintainer recommended adding
  `vector://vector` to `frame-ancestors` for Jitsi (element-web#23884). So `frame-ancestors *` (what the
  sibling `server/serve.js` sends) should block Element Desktop in spec-conforming Chromium.
  **UNVERIFIED in a real Element Desktop**, but the fix is free: send
  `Content-Security-Policy: frame-ancestors * vector:` (plus `http://localhost:*` is already covered by `*`
  for Commet's relay pages) and no `X-Frame-Options`.

### 5.3 Reading and writing save files

* Reading: `<input type="file">` (and drag-and-drop) works in Element's sandboxed iframe (no sandbox flag
  needed), in Commet's Chromium relay page and Android WebView page (**UNVERIFIED** for the Android
  WebView file chooser), and in WebKitGTK windows via WebKit's default GTK file chooser (**UNVERIFIED** in
  Vommet's Flatpak; the manifest has `org.freedesktop.portal.Documents`).
* File System Access API: Chromium refuses `showOpenFilePicker`/`showSaveFilePicker`/`showDirectoryPicker`
  in cross-origin subframes with `SecurityError: Cross origin sub frames aren't allowed to show a file
  picker` (jitsi-meet#16323, WPT fenced-frame tests). Firefox, Safari and WebKitGTK do not implement these
  pickers. Do not use them.
* Writing back: `URL.createObjectURL(blob)` + `<a download="POKEMON_RED.sav">` clicked from a user gesture.
  Element includes `allow-downloads` (sandboxed frames without that keyword cannot download; Chrome 74
  first blocked downloads from sandboxed iframes without user activation per its deprecation notes and the
  blink-dev intent; the exact Chrome version for the current `allow-downloads` rule is **UNVERIFIED**).
  Element Desktop's `will-download` handler does not set a save path, so Electron shows its save dialog and
  Element shows a "download completed" toast (`element-desktop/src/webcontents-handler.ts` lines 297-309).
  Commet's Chromium relay page has no sandbox, so downloads behave like a normal Chromium tab. Vommet/Commet
  WebKit windows register no download handler (`widget_runner.rs`, `widget_dock.cc`); what WebKitGTK does
  then is **UNVERIFIED** (possibly saves silently into `~/Downloads`, which the Flatpak can write).
  Robust alternative everywhere: server-generated one-time download URL opened with `window.open`/handoff
  (section 4.2), served with `Content-Disposition: attachment`.

### 5.4 Storage and cookies inside the widget

| Host | Top-level site that partitions our storage | Persistence |
|---|---|---|
| Element Web in Chrome (115+) | `app.element.io` (or the self-hosted Element origin) | persistent, but separate from our standalone site |
| Element Web in Firefox | same (Total Cookie Protection) | persistent (partitioned) |
| Element Web in Safari | same | **UNVERIFIED**; WebKit has called partitioned storage non-persistent by design |
| Element Web in Brave | same | **ephemeral**: Brave's ephemeral third-party storage is cleared shortly after the last first-party tab closes |
| Element Desktop | `vector://vector` | persistent (Electron default session) |
| Commet Linux (Chromium relay) | `http://localhost` | temp `--user-data-dir`; survives until the temp dir is cleaned (**UNVERIFIED**) |
| Commet Windows / Vommet desktop windows | (we are top-level) | **ephemeral** (incognito wry / ephemeral WebKit context) |

Chrome keeps third-party **cookies** enabled by default (Google's April 2025 decision; Privacy Sandbox APIs
retired October 2025, CHIPS retained), but Firefox, Safari and Brave block or partition them. Use a Bearer
token in memory (optionally `sessionStorage` for reloads), never cookies, for widget API calls. Serve the
widget page and the API from the same origin so no CORS is needed.

---

## 6. The sibling project and how to extend its fake Matrix harness

### 6.1 What `third-strike-lobby` does today

`web/js/matrix-lobby.js` (96 lines):

* Classic script loaded after `https://cdn.jsdelivr.net/npm/matrix-widget-api@1.20.0/dist/api.min.js`
  (`web/index.html` line 139). Unwraps `window.mxwidgets`.
* `earlyWidgetStart()` runs at script evaluation if the URL has `widgetId` or `parentUrl`: creates
  `new mx.WidgetApi(widgetId)`, requests `org.matrix.msc2762.send.event:app.thirdstrike.lobby`,
  `org.matrix.msc2762.receive.event:app.thirdstrike.lobby`,
  `org.matrix.msc2762.receive.state_event:m.room.member`; handles `action:send_event` (preventDefault,
  reply `{}`, buffer until the app attaches); `start()`.
* `MatrixLobby.init()` waits for `ready` (15 s timeout); `members()` uses `readStateEvents("m.room.member",
  500)`; `recent()` uses `readRoomEvents`; `send()` uses `sendRoomEvent`.
* Identity: `userId`/`displayName`/`roomId` from `$matrix_*` URL templates; `app.js` line 185 uses
  `state.matrix.userId` as the player id and trusts `content.from.id`. Fine for a casual lobby, not for
  Home storage.
* No `update_state` handler, so on Element Web the member list can be incomplete (section 1.4).

`web/dev/fake-matrix.html` (54 lines): mounts two iframes (Alice, Bob) with `ClientWidgetApi` and a
`WidgetDriver` subclass that approves all capabilities, appends sent events to an in-memory timeline and
`feedEvent`s them to both widgets, and answers the **deprecated** `readRoomEvents`/`readStateEvents` driver
methods. It never calls `setViewedRoomId()` and has no `askOpenID()`, so the base driver answers every
`get_openid` with `blocked`.

### 6.2 Harness changes for our project (own code; verified pattern)

In our copy of the harness, per mounted user:

```js
class Driver extends mx.WidgetDriver {
  validateCapabilities(req) { return Promise.resolve(new Set(req)); }
  getKnownRooms() { return [ROOM]; }
  async readRoomTimeline(roomId, type) { return timeline.filter((e) => e.type === type); }
  async readRoomState(roomId, type) { return type === "m.room.member" ? members : []; }
  async sendEvent(type, content, stateKey, roomId) { /* as today, then api.feedEvent(ev) for each api */ }
  askOpenID(observer) {
    const mode = new URLSearchParams(location.search).get("openid") || "prompt"; // prompt|allow|deny
    if (mode === "deny") return observer.update({ state: mx.OpenIDRequestState.Blocked });
    const grant = async () => observer.update({ state: mx.OpenIDRequestState.Allowed, token: await mintDevToken(u.id) });
    if (mode === "allow") return void grant();
    observer.update({ state: mx.OpenIDRequestState.PendingUserConfirmation }); // two-phase, like Element/Commet
    setTimeout(grant, 300);
  }
}
const api = new mx.ClientWidgetApi(widget, iframe, new Driver());
api.setViewedRoomId(ROOM);       // makes the client push members via update_state, as Element does
// for membership changes: api.feedStateUpdate(memberEvent)
```

`mintDevToken(userId)` calls a **dev-only** endpoint on our server:
`POST /dev/fake-openid/token {user_id}` -> `{access_token, token_type:"Bearer", matrix_server_name:"example.org",
expires_in:3600}`, storing `token -> {sub, exp}` in memory. The same dev server answers
`GET /dev/fake-federation/_matrix/federation/v1/openid/userinfo?access_token=` exactly like Synapse
(200 `{sub}`, 401 `M_UNKNOWN_TOKEN`, 401 `M_MISSING_TOKEN`). Start the server with
`DEV_FAKE_MATRIX=1 MATRIX_FEDERATION_OVERRIDES=example.org=http://127.0.0.1:<port>/dev/fake-federation`, so
`/api/auth/openid` runs the real code path (HTTP call, `sub` check, session creation) with only discovery
replaced. Add special dev tokens that return a foreign `sub` (`@mallory:evil.example`) and an expired token
to test rejection paths.

This two-phase flow was run in headless Chromium against widget-api 1.20.0: the widget received
`{"state":"allowed","original_request_id":"widgetapi-...","access_token":"dev-token-alice","token_type":"Bearer",
"matrix_server_name":"example.org","expires_in":3600}` from `requestOpenIDConnectToken()`, and the full member
list through `update_state`.

Unit tests (`node --test`): run the verifier against an in-process `node:http` fake federation through the
override map; test grammar rejection, allowlist, `sub` mismatch, 401, timeouts, oversize bodies, redirect
limits, and the BlockList (including `::ffff:127.0.0.1`).

Manual matrix: Element Web (Chrome + Firefox), Element Desktop (checks the `vector:` frame-ancestors fix
and downloads), Commet Linux (Chromium relay), Vommet Linux (WebKit window: OpenID, file input, download).

---

## 7. Open questions / UNVERIFIED

* Does Element Desktop really refuse a widget sent with `frame-ancestors *`? (Spec says it should; test.)
* Download behaviour in Vommet/Commet WebKit windows with no download handler; file chooser inside
  Vommet's Flatpak; Android WebView file chooser in Commet.
* Element Classic mobile: OpenID widget action support (moot after 2026-12-31).
* Safari: persistence of partitioned iframe storage.
* Whether non-Synapse homeservers (Conduit/conduwuit/Tuwunel, Dendrite) all serve the federation
  `openid/userinfo` endpoint; whether they use 1 h lifetimes.
* Importing the matrix-widget-api UMD bundle as an ES module (vs classic script).
* Commet's Chromium `--user-data-dir` inside the Flatpak temp dir: where it lands on the host and how long
  it lives.
* Which bot SDK we use and whether the bot does E2EE DMs.

---

## Sources

* npm: `npm view matrix-widget-api` (1.20.0); package tarball `matrix-widget-api-1.20.0.tgz`: `src/WidgetApi.ts`,
  `src/ClientWidgetApi.ts`, `src/interfaces/{Capabilities,ApiVersion,GetOpenIDAction,OpenIDCredentialsAction,WidgetApiAction,UpdateStateAction}.ts`,
  `src/models/WidgetEventCapability.ts`, `src/transport/PostmessageTransport.ts`, `src/templating/url-template.ts`,
  `src/driver/WidgetDriver.ts`
* https://github.com/matrix-org/matrix-widget-api/releases (1.11.0 to 1.20.0 notes)
* MSC1960: https://github.com/matrix-org/matrix-spec-proposals/blob/main/proposals/1960-integrations-openid.md
* Spec: https://raw.githubusercontent.com/matrix-org/matrix-spec/main/data/api/server-server/openid.yaml,
  `.../client-server/openid.yaml`, `content/server-server-api.md` (Resolving server names; page is v1.19),
  `content/appendices.md` (Server Name), `content/client-server-api/_index.md` (OAuth 2.0 API, scopes)
* Synapse: `synapse/rest/client/openid.py`, `synapse/federation/transport/server/__init__.py`,
  `synapse/storage/databases/main/openid.py` (element-hq/synapse develop)
* lk-jwt-service v0.9.0: https://github.com/element-hq/lk-jwt-service `README.md`, `src/helper.rs`, `src/handler.rs`, `src/requests.rs`
* matrix-user-verification-service: https://github.com/matrix-org/matrix-user-verification-service (`master`) `README.md`, `src/matrixUtils.js`, `src/utils.js`, `src/verify.js`
* Element Web (element-hq/element-web develop): `apps/web/src/components/views/elements/AppTile.tsx`,
  `apps/web/src/stores/widgets/{ElementWidgetDriver,WidgetPermissionStore,WidgetMessaging}.ts`,
  `apps/web/src/components/views/dialogs/WidgetOpenIDPermissionsDialog.tsx`, `modules/widget-lifecycle/README.md`
* Element Desktop (element-hq/element-desktop develop): `src/electron-main.ts`, `src/webcontents-handler.ts`
* https://github.com/vector-im/element-web/issues/23884 (vector://vector frame-ancestors)
* Element X: https://github.com/element-hq/element-meta/issues/3099, https://github.com/element-hq/element-x-android/issues/7099,
  https://github.com/element-hq/element-x-android/pull/6480
* Element Classic sunset: https://docs.element.io/latest/element-server-suite-pro/migration/classic-to-pro-mobile-apps-faq/
* Cinny: https://github.com/cinnyapp/cinny/issues/372, /pull/2335, /pull/2736
* FluffyChat: https://github.com/krille-chan/fluffychat/pull/2384, `pubspec.yaml` on main
* Nheko: https://github.com/Nheko-Reborn/nheko `CHANGELOG.md` (0.9.2 "Basic widgets"), issue #82
* Commet: https://github.com/commetchat/commet (`commet/lib/client/matrix/components/widgets/**`,
  `commet/lib/utils/system_processes_utils.dart`, `rust/rust/src/widget_runner.rs`); installed Flatpak
  `chat.commet.commetapp` (commit b6a74942..., 2026-09-24): `libapp.so` strings, `flutter_assets/assets/data/*`
* Vommet: https://vommet.app/, https://nether.codes/nether/vommet (`VOMMET_CHANGES.md`, testing branch
  `commet/lib/client/matrix/components/widgets/matrix_widget_component.dart`, `rust/rust/src/widget_runner.rs`,
  `commet/linux/widget_dock.cc`, `.vommet/widgets/runner/Cargo.toml`); installed Flatpak `im.nether.chat`
  (commit 79f409e6..., 2026-10-21): `changelog.json`, `widget_catalog.json`, `widgets_ipc.js`, runtime
  manifest of `org.gnome.Platform//51` (webkitgtk-2.54.1)
* CSP3: https://w3c.github.io/webappsec-csp/ (6.7.2.8)
* Storage partitioning: https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning
* Brave ephemeral storage: https://brave.com/privacy-updates/7-ephemeral-storage
* Chrome third-party cookies / Privacy Sandbox retirement: https://engadget.com/cybersecurity/google-has-killed-privacy-sandbox-130029899.html,
  https://windowsreport.com/google-is-scrapping-privacy-sandbox-apis-as-chrome-keeps-third-party-cookies-after-all/
* File pickers in cross-origin frames: https://github.com/jitsi/jitsi-meet/issues/16323
* Sandboxed-iframe downloads: https://developer.chrome.com/blog/chrome-74-deps-rems,
  https://groups.google.com/a/chromium.org/g/blink-dev/c/JdAQ6HNoZvk
* Sibling project: `/home/jbro/Projects/third-strike-lobby/web/js/matrix-lobby.js`, `web/dev/fake-matrix.html`,
  `web/index.html`, `web/js/app.js`, `server/serve.js`, `README.md`
