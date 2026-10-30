/* Presence with activity: the tab each person's widget shows, and "battling" (with the battle id)
   from the battle module whatever their tab is. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../server/index.js";
import { loadConfig } from "../server/config.js";
import { createApi, Socket, wsUrl } from "../web/js/api.js";

const ROOM = "!presence:example.org";
let app, base;
before(async () => {
  app = createServer(loadConfig({ DB_FILE: ":memory:", PORT: "0", HOST: "127.0.0.1", DEV_AUTH: "1" }));
  base = `http://127.0.0.1:${(await app.listen()).port}/`;
});
after(() => app.close());

async function client(who) {
  const token = (await createApi({ base, storage: null }).post("api/auth/dev", { userId: `@${who}:example.org`, displayName: who }, { auth: false })).token;
  const ws = new Socket({ url: wsUrl(base), getToken: () => token, pingIntervalMs: 0 });
  let last = [];
  ws.on("presence", (m) => { if (m.roomId === ROOM) last = m.users; });
  ws.connect();
  await ws.join(ROOM);
  return { ws, users: () => last, close: () => ws.close() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what) {
  for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(10); }
  throw new Error("timed out: " + what);
}

test("presence carries each person's activity, and battles override it", async () => {
  const ash = await client("ash"), misty = await client("misty");
  try {
    const of = (who) => misty.users().find((u) => u.id === `@${who}:example.org`);
    await until(() => of("ash"), "ash present");
    assert.equal(of("ash").activity, null, "no tab reported yet");
    ash.ws.send("activity", { tab: "home" });
    await until(() => of("ash")?.activity === "home", "ash in Home");
    ash.ws.send("activity", { tab: "trade" });
    await until(() => of("ash")?.activity === "trading", "ash trading");
    ash.ws.send("activity", { tab: "<script>" });
    await until(() => of("ash")?.activity === null, "unknown tabs are ignored");

    const { battle } = await ash.ws.request("battle.challenge", { to: "cpu", roomId: ROOM, options: { gen: 1, teamSize: 1, timer: 0 } });
    await until(() => of("ash")?.activity === "battling", "ash battling");
    assert.equal(of("ash").battleId, battle.id, "presence says which battle, so others can watch");
    await ash.ws.request("battle.forfeit", { id: battle.id });
    await until(() => of("ash")?.activity !== "battling", "battle over");
    assert.equal(of("ash").battleId, undefined);
  } finally { ash.close(); misty.close(); }
});
