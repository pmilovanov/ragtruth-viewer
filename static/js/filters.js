// The filter bar: one set of controls that scopes every chart, table and list.

import { D, F, emit, applyQuery, setImplicit, resetFilters, activeFilterCount } from "./data.js";
import { h, debounce } from "./ui.js";
import { fmtInt } from "./lib.js";

const SCOPES = [["response", "response text"], ["spans", "hallucinated spans"], ["notes", "annotator notes"], ["source", "source text"]];

export function mountFilters(root, { selectedCount }) {
  const facet = (title, key, names) => {
    const buttons = names.map((name, code) => h("button", {
      class: "chip tog", type: "button", "aria-pressed": "false", dataset: { facet: key, code },
      onclick: () => { F[key].has(code) ? F[key].delete(code) : F[key].add(code); emit(); },
    }, String(name)));
    return h("div", { class: "fgroup", role: "group", "aria-label": title }, h("span", { class: "flabel" }, title), ...buttons);
  };

  const hall = h("div", { class: "fgroup", role: "group", "aria-label": "Hallucination" },
    h("span", { class: "flabel" }, "Hallucination"),
    ...[["any", "Any"], ["yes", "Has some"], ["no", "None"]].map(([v, text]) => h("button", {
      class: "chip tog", type: "button", "aria-pressed": "false", dataset: { hall: v },
      onclick: () => { F.hall = v; emit(); },
    }, text)));

  const input = h("input", {
    class: "search", type: "search", placeholder: "Search…  (all words must match; “quote” a phrase)", "aria-label": "Search text", id: "search",
    oninput: debounce(() => applyQuery(input.value, scope.value), 250),
  });
  const scope = h("select", { class: "ctl", "aria-label": "Search in", onchange: () => input.value.trim() && applyQuery(input.value, scope.value) },
    SCOPES.map(([v, text]) => h("option", { value: v }, `in ${text}`)));

  const implicit = h("input", { type: "checkbox", id: "implicit", checked: true, onchange: (e) => setImplicit(e.target.checked) });
  const implicitLabel = h("label", { class: "switch", for: "implicit",
    title: "Annotators marked some spans as true but absent from the context (implicit true). Untick to stop treating them as hallucinations." },
    implicit, "Count implicit-true spans");

  const readout = h("span", { class: "readout", "aria-live": "polite" });
  const reset = h("button", { class: "btn small", type: "button", onclick: () => { resetFilters(); syncInputs(); emit(); } }, "Reset");

  const more = h("div", { class: "frow more", hidden: true },
    facet("Dataset", "ds", D.f.datasets), facet("Quality", "quality", D.f.qualities),
    facet("Temperature", "temp", D.f.temps), facet("Has label type", "type", D.f.types));
  const moreBtn = h("button", { class: "btn small", type: "button", "aria-expanded": "false", onclick: () => {
    more.hidden = !more.hidden;
    moreBtn.setAttribute("aria-expanded", String(!more.hidden));
  } }, "More filters");

  root.append(
    h("div", { class: "frow" }, input, scope, implicitLabel, h("span", { class: "grow" }), readout, reset),
    h("div", { class: "frow" }, facet("Task", "task", D.f.tasks), facet("Model", "model", D.f.models),
      facet("Split", "split", D.f.splits), hall, moreBtn),
    more);

  function syncInputs() {
    input.value = F.q;
    scope.value = F.scope;
    implicit.checked = F.implicit;
  }

  /** Reflect F in the controls; call after any change to F. */
  function sync() {
    root.querySelectorAll("[data-facet]").forEach((b) => b.setAttribute("aria-pressed", String(F[b.dataset.facet].has(+b.dataset.code))));
    root.querySelectorAll("[data-hall]").forEach((b) => b.setAttribute("aria-pressed", String(F.hall === b.dataset.hall)));
    implicit.checked = F.implicit;
    const extra = ["ds", "quality", "temp", "type"].reduce((n, k) => n + F[k].size, 0);
    moreBtn.textContent = extra ? `More filters (${extra})` : "More filters";
    if (extra && more.hidden) { more.hidden = false; moreBtn.setAttribute("aria-expanded", "true"); }
    const active = activeFilterCount();
    reset.disabled = !active;
    readout.textContent = `${fmtInt(selectedCount())} of ${fmtInt(D.n)} responses`;
  }

  return { sync, syncInputs, focusSearch: () => input.focus() };
}
