/* Where a battle team comes from, as the challenge and accept dialogs offer it.

   Each entry turns into the `team` spec the server's team source of the same name understands
   (server/battles.js registerTeamSource). "random" works everywhere. "home" (Pokémon from your
   Home boxes, spec { source: "home", monIds }) and "party" (a party from a save you opened, spec
   { source: "party", records: [{ record, meta }] }) are shown but disabled until a picker is
   registered here AND the server lists the source in battle.list's `sources`.

   Seam for the Home/party feature: call registerTeamPicker("home", { label, hint,
   pick: async (app, options) => spec | null }) from a module the battle view imports (or add the
   picker right here). pick() may open its own dialog; null means the player cancelled. */

const pickers = new Map([
  ["random", { label: "Random team", hint: "A Random Battle team for this generation.", pick: async () => ({ source: "random" }) }],
]);

export const TEAM_SOURCES = [
  { id: "random" },
  { id: "home", label: "From Home", hint: "Pokémon from your Home boxes" },
  { id: "party", label: "From a save", hint: "Pokémon from a save you opened" },
];

export function registerTeamPicker(id, picker) { pickers.set(id, picker); }

/** Options for a team-source radio group: [{ id, label, hint, enabled }]. */
export function teamChoices(serverSources = ["random"]) {
  return TEAM_SOURCES.map((s) => {
    const p = pickers.get(s.id);
    return { id: s.id, label: p?.label ?? s.label, hint: p?.hint ?? s.hint, enabled: !!p && serverSources.includes(s.id) };
  });
}

/** Resolve the chosen source into a team spec (null when the player backed out). */
export async function pickTeam(app, id, options) {
  const p = pickers.get(id);
  if (!p) throw new Error("That team source is not available on this server");
  return p.pick(app, options);
}
