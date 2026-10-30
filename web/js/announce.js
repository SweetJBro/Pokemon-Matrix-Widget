/* Announcements in the Matrix room: short notices ("Alice offers Pikachu for trade", "Bob beat
   Alice in a Gen 2 battle") so people who don't have the widget open see what's happening and can
   join in.

   Opt-in per person (the account dialog has the switch), because the notice is sent as that
   person: turning it on asks the Matrix client for permission to post m.notice messages
   (matrix-widget-api capability renegotiation), and nothing is posted before the client agrees.
   Only the widget that did something announces it, so a trade or battle is announced once:
   the offerer announces an offer, whoever confirms last announces the finished trade, the
   challenger announces a challenge and the result. Practice battles are not announced.

     init(app)                 call once; restores the switch (best effort, browser storage)
     enabled() / available()   switch state / inside a widget that can ask for the permission
     setEnabled(app, on)       -> Promise<boolean> (false if the client refused)
     announce(app, kind, data) kind: "offer" | "trade-done" | "challenge" | "battle-result" */
const CAPABILITY = "org.matrix.msc2762.send.event:m.room.message#m.notice";
const early = () => globalThis.PMW_EARLY || {};
const sent = new Set();   // keys of things already announced from this widget
let on = false, key = null;

const storage = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function init(app) {
  key = "pmw.announce." + app.user.id;
  try { on = storage()?.getItem(key) === "1" && hasPermission(); } catch { on = false; }
}

export const available = () => !!(early().isWidget && early().api?.requestCapabilityToSendMessage);
export const enabled = () => on;
const hasPermission = () => !!early().api?.hasCapability?.(CAPABILITY);

export async function setEnabled(app, value) {
  if (!value) { on = false; try { storage()?.setItem(key, "0"); } catch { /* no storage */ } return true; }
  if (!available()) return false;
  const api = early().api;
  if (!hasPermission()) {
    api.requestCapabilityToSendMessage("m.notice");
    try { await api.updateRequestedCapabilities(); } catch { /* client without renegotiation */ }
    // The client answers with notify_capabilities; give the player time to click through its prompt.
    for (let i = 0; i < 600 && !hasPermission(); i++) await new Promise((r) => setTimeout(r, 100));
  }
  on = hasPermission();
  try { storage()?.setItem(key, on ? "1" : "0"); } catch { /* no storage */ }
  return on;
}

/** Plain text only: names come from Matrix profiles and nicknames from saves, so no markup. */
const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 60);

export async function announce(app, kind, data) {
  if (!on || !hasPermission()) return;
  const id = `${kind}:${data.id}`;
  if (sent.has(id)) return;
  sent.add(id);
  const me = clean(app.user.displayName || app.nameOf(app.user.id));
  let body;
  if (kind === "offer") body = `🔁 ${me} offers ${clean(data.mon)} for trade${data.to ? ` to ${clean(data.to)}` : ""} in the Pokémon widget.${data.wanted ? ` Looking for: ${clean(data.wanted)}.` : ""}`;
  else if (kind === "trade-done") body = `🤝 ${me} and ${clean(data.partner)} traded: ${clean(data.gave)} for ${clean(data.got)}.${data.evolved ? ` ${clean(data.evolved)}` : ""}`;
  else if (kind === "challenge") body = `⚔️ ${me} challenged ${clean(data.to)} to a ${clean(data.desc)} battle in the Pokémon widget.`;
  else if (kind === "battle-result") body = data.winner ? `🏆 ${clean(data.winner)} beat ${clean(data.loser)} in a ${clean(data.desc)} battle.` : `The ${clean(data.desc)} battle between ${clean(data.p1)} and ${clean(data.p2)} ended in a tie.`;
  else return;
  try { await early().api.sendRoomEvent("m.room.message", { msgtype: "m.notice", body }); }
  catch (e) { console.warn("announcement not sent:", e?.message || e); }
}
