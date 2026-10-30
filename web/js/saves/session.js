/* Moving Pokémon between an opened save (js/savestore.js entry) and Home, without the DOM.

   Every operation re-opens the save from the entry's working bytes, applies all of its changes
   to that fresh SaveFile, talks to the server, and only then writes the new bytes back to the
   store. If anything fails before the server has agreed, the store is untouched: a deposit
   either removes every chosen Pokémon from the save and puts them all in Home, or does nothing.

   Withdrawal follows the server's two phases (server/home.js): lock and fetch each record, put
   it into the save (the save module refuses what that game cannot hold), store the new bytes,
   then commit. A record the save refuses is cancelled at once, so it stays in Home. */
import { openSave, exportSave } from "../../shared/saves/index.js";
import { toBase64, fromBase64 } from "../../shared/bytes.js";

/** The SaveFile for a store entry's working copy. */
export async function openEntry(entry) {
  return openSave(entry.working, entry.filename);
}

/** Small JSON-able description kept in the store entry's meta (lists and badges). */
export function describe(save) {
  return {
    gen: save.gen, game: save.game, gameName: save.gameName, lang: save.lang, format: save.format || `pk${save.gen}`,
    trainer: save.trainer?.name ?? "", tid: save.trainer?.tid ?? null, readOnly: save.readOnly || null,
  };
}

/** picks: [{ party: true, index } | { box, index }] in any order.
    -> { stored: [{ id, box, slot }], warnings, taken: [view] } */
export async function deposit({ api, store, entryId, picks, homeBox = null }) {
  const entry = store.get(entryId);
  if (!entry) throw new Error("That save is no longer open.");
  if (!picks.length) throw new Error("Choose at least one Pokémon first.");
  const save = await openEntry(entry);
  if (save.readOnly) throw new Error(save.readOnly);
  // Packed Gen 1/2 lists shift when a Pokémon leaves, so take from the highest slot down.
  const order = [...picks].sort((a, b) => (a.party === b.party ? 0 : a.party ? -1 : 1) || (a.box ?? -1) - (b.box ?? -1) || b.index - a.index);
  const taken = [];
  for (const p of order) {
    const view = p.party ? save.party()[p.index]?.view : save.box(p.box)[p.index]?.view;
    const r = p.party ? save.takeFromParty(p.index) : save.takeFromBox(p.box, p.index);
    taken.push({ ...r, view });
  }
  const body = { mons: taken.map((t) => ({ record: toBase64(t.record), meta: t.meta })) };
  if (homeBox != null) body.box = homeBox;
  const res = await api.post("api/home/deposit", body);   // throws: nothing was changed
  await store.update(entryId, exportSave(save), describe(save));
  return { stored: res.stored, warnings: res.warnings || [], taken: taken.map((t) => t.view) };
}

/** -> { done: [{ id, view, box, index }], failed: [{ id, error }] } */
export async function withdraw({ api, store, entryId, monIds, targetBox = null }) {
  const entry = store.get(entryId);
  if (!entry) throw new Error("That save is no longer open.");
  const save = await openEntry(entry);
  if (save.readOnly) throw new Error(save.readOnly);
  const target = { format: save.format || `pk${save.gen}`, game: save.game, lang: save.lang };
  const done = [], failed = [];
  for (const id of monIds) {
    let got;
    try { got = await api.post("api/home/withdraw", { id, target }); }
    catch (e) { failed.push({ id, error: e.message }); continue; }
    try {
      const at = save.putInBox(fromBase64(got.record), got.meta, targetBox ?? undefined);
      done.push({ id, view: got.view, box: at.box, index: at.index });
    } catch (e) {
      failed.push({ id, error: e.message, view: got.view });
      await api.post(`api/home/withdraw/${encodeURIComponent(id)}/cancel`).catch(() => {});
    }
  }
  if (done.length) {
    try { await store.update(entryId, exportSave(save), describe(save)); }
    catch (e) {
      // The new save bytes never reached the store, so none of these are in a save: keep them in Home.
      for (const d of done) await api.post(`api/home/withdraw/${encodeURIComponent(d.id)}/cancel`).catch(() => {});
      throw e;
    }
    for (const d of done) {
      try { await api.post(`api/home/withdraw/${encodeURIComponent(d.id)}/commit`); }
      catch (e) { d.commitError = e.message; }   // stays pending in Home; the Home tab offers "finish"
    }
  }
  return { done, failed };
}
