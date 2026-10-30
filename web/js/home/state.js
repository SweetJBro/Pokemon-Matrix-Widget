/* The signed-in player's Home, cached for every view that shows it (Home tab, the deposit
   dialog's box choice, the withdraw picker). It reloads when the server pushes { type: "home" }
   (a change from this or another open widget) and after any change made through it.

     const home = homeState(app);
     home.onChange(fn) -> off      fn(data) with the GET /api/home body
     await home.load()             -> data (fetches if not loaded yet)
     await home.refresh()          -> data (always fetches)
     home.data                     last data or null
     home.freeIn(box)              free slots in a box
     home.find(id)                 -> listing entry | null */
let shared = null;

export function homeState(app) {
  if (shared && shared.app === app) return shared;
  const listeners = new Set();
  let data = null, inflight = null;
  const emit = () => listeners.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } });
  async function refresh() {
    inflight ??= app.api.get("api/home").then((d) => { data = d; emit(); return d; }).finally(() => { inflight = null; });
    return inflight;
  }
  app.ws?.on("home", () => { refresh().catch(() => {}); });
  shared = {
    app,
    get data() { return data; },
    load: () => (data ? Promise.resolve(data) : refresh()),
    refresh,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    freeIn: (box) => (data ? data.boxSlots - (data.boxes[box]?.mons.length ?? 0) : 0),
    find: (id) => data?.boxes.flatMap((b) => b.mons).find((m) => m.id === id) ?? null,
  };
  return shared;
}
