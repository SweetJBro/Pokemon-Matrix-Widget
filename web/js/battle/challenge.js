/* The challenge dialog (also used for practice battles) and the accept dialog.

   Everything is validated again on the server; here normalizeOptions() only keeps the form
   honest (doubles needs Gen 3+, Battle Tower is doubles) and describeOptions() shows the result
   in one line before anyone commits. */
import { h, dialog } from "../ui.js";
import { PRESETS, GENS, LEVEL_RULES, TIMERS, DEFAULT_TIMER, normalizeOptions, describeOptions, ruleLabels, pickCount } from "../../shared/battle/formats.js";
import { teamChoices, pickTeam } from "./teams.js";

const CPU = "cpu";

function select(name, items, value) {
  return h("select", { class: "input", name },
    items.map(([v, label, disabled]) => h("option", { value: String(v), selected: String(v) === String(value), disabled: !!disabled }, label)));
}

function field(label, control, hint) {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), control, hint ?? null);
}

function teamField(sources, name = "team") {
  const choices = teamChoices(sources);
  return h("fieldset", { class: "bt-team-source" },
    h("legend", { class: "field-label" }, "Your team"),
    choices.map((c, i) => h("label", { class: ["bt-radio", !c.enabled && "is-disabled"], title: c.hint ?? "" },
      h("input", { type: "radio", name, value: c.id, checked: i === 0, disabled: !c.enabled }),
      h("span", null, c.label, c.enabled ? null : h("small", { class: "muted" }, " · not on this server")))));
}

const fmtTimer = (s) => (s ? (s >= 60 ? `${s / 60} min` : `${s} s`) + " per turn" : "Off");

/**
 * opponents: [{ id, name }] people who can be challenged; to: preselected id or "cpu".
 * Resolves { to, options, team } or null.
 */
export async function challengeDialog(app, { opponents = [], to = null, options = {}, sources = ["random"], practice = false } = {}) {
  const init = { gen: 3, preset: "cartridge", timer: practice ? 0 : DEFAULT_TIMER, ...options };
  const opp = practice ? null : select("to", opponents.length ? opponents.map((o) => [o.id, o.name]) : [["", "Nobody else has the widget open", true]], to ?? opponents[0]?.id);
  const preset = select("preset", Object.entries(PRESETS).map(([k, p]) => [k, p.label]), init.preset);
  const gen = select("gen", Object.entries(GENS).map(([k, g]) => [k, `${g.label} · ${g.games}`]), init.gen);
  const gameType = select("gameType", [["singles", "Single battle"], ["doubles", "Double battle"]], init.gameType ?? "singles");
  const levelRule = select("levelRule", Object.entries(LEVEL_RULES).map(([k, r]) => [k, r.label]), init.levelRule ?? PRESETS[init.preset]?.levelRule ?? "asis");
  const teamSize = select("teamSize", [1, 2, 3, 4, 5, 6].map((n) => [n, `${n} Pokémon`]), init.teamSize ?? 6);
  const timer = select("timer", [...new Set([...TIMERS, init.timer])].sort((a, b) => a - b).map((s) => [s, fmtTimer(s)]), init.timer);
  const presetHint = h("span", { class: "field-hint" });
  const summary = h("p", { class: "bt-summary" });
  const rules = h("p", { class: "field-hint" });
  const err = h("p", { class: "field-error", role: "alert" });
  const team = teamField(sources);

  const read = () => ({ gen: Number(gen.value), preset: preset.value, gameType: gameType.value, levelRule: levelRule.value, teamSize: Number(teamSize.value), timer: Number(timer.value) });
  function sync(changed) {
    const p = PRESETS[preset.value];
    if (changed === preset) levelRule.value = p.levelRule;
    if (Number(gen.value) < p.minGen) gen.value = String(p.minGen);
    for (const o of gen.options) o.disabled = Number(o.value) < p.minGen;
    if (!p.gameTypes.includes(gameType.value)) gameType.value = p.gameTypes[0];
    if (Number(gen.value) < 3) gameType.value = "singles";
    for (const o of gameType.options) o.disabled = !p.gameTypes.includes(o.value) || (o.value === "doubles" && Number(gen.value) < 3);
    if (gameType.value === "doubles" && Number(teamSize.value) < 2) teamSize.value = "2";
    presetHint.textContent = p.hint;
    try {
      const o = normalizeOptions(read());
      summary.textContent = describeOptions(o);
      const labels = ruleLabels(o);
      rules.textContent = (labels.length ? labels.join(", ") : "No clauses") + (pickCount(o) ? `. Each player picks ${pickCount(o)} at Team Preview.` : ".");
      err.textContent = "";
    } catch (e) { summary.textContent = ""; err.textContent = e.message; }
  }
  for (const s of [preset, gen, gameType, levelRule, teamSize, timer]) s.addEventListener("change", () => sync(s));
  sync();

  let result = null;
  const v = await dialog({
    title: practice ? "Practice against the CPU" : "Challenge someone",
    wide: true,
    body: h("form", { class: "bt-form", onsubmit: (e) => e.preventDefault() },
      opp && field("Opponent", opp),
      field("Rules", preset, presetHint),
      h("div", { class: "row row-fields" }, field("Generation (mechanics)", gen), field("Battle", gameType)),
      h("div", { class: "row row-fields" }, field("Levels", levelRule), field("Team size", teamSize), field("Turn timer", timer)),
      team,
      summary, rules, err),
    buttons: [
      { label: "Cancel", value: null, kind: "ghost" },
      {
        label: practice ? "Start" : "Send challenge", value: "go", kind: "primary",
        onClick: async (ctx) => {
          let options;
          try { options = normalizeOptions(read()); } catch (e) { err.textContent = e.message; return false; }
          const target = practice ? CPU : opp.value;
          if (!target) { err.textContent = "Pick an opponent"; return false; }
          const source = ctx.body.querySelector('input[name="team"]:checked')?.value ?? "random";
          let spec;
          try { spec = await pickTeam(app, source, options); } catch (e) { err.textContent = e.message; return false; }
          if (!spec) return false;
          result = { to: target, options, team: spec };
          return true;
        },
      },
    ],
  });
  return v === "go" ? result : null;
}

/** Shows an incoming challenge; resolves a team spec to accept with, or null. */
export async function acceptDialog(app, challenge, { sources = ["random"] } = {}) {
  const err = h("p", { class: "field-error", role: "alert" });
  const o = challenge.options;
  let spec = null;
  const labels = ruleLabels(o);
  const v = await dialog({
    title: `${challenge.from.name} challenges you`,
    body: [
      h("p", { class: "bt-summary" }, describeOptions(o)),
      h("p", { class: "field-hint" }, `${PRESETS[o.preset].hint} ${labels.length ? "Clauses: " + labels.join(", ") + "." : ""}`),
      teamField(sources, "accept-team"),
      err,
    ],
    buttons: [
      { label: "Not now", value: null, kind: "ghost" },
      { label: "Decline", value: "decline", kind: "danger" },
      {
        label: "Accept", value: "accept", kind: "primary",
        onClick: async (ctx) => {
          const source = ctx.body.querySelector('input[name="accept-team"]:checked')?.value ?? "random";
          try { spec = await pickTeam(app, source, o); } catch (e) { err.textContent = e.message; return false; }
          return spec ? true : false;
        },
      },
    ],
  });
  if (v === "accept") return { action: "accept", team: spec };
  if (v === "decline") return { action: "decline" };
  return null;
}
