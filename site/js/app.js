// Shell: loads the index, owns the route (#/overview, #/browse/<id>[/compare]?<filters>)
// and the one shared selection that every view reads.

import { initTheme, toggleTheme, h, $ } from "./ui.js";
import {
  D, F, loadIndex, select, onChange, emit, filtersToParams, paramsToFilters, applyQuery,
} from "./data.js";
import { mountFilters } from "./filters.js";
import { mountOverview } from "./overview.js";
import { mountBrowse } from "./browse.js";
import { fmtInt } from "./lib.js";

initTheme();

let selection = null;
const selected = () => (selection ||= select());

let route = { view: "overview", id: null, compare: false, params: new URLSearchParams() };
let lastBrowse = { id: null, compare: false };
let lastImplicit = true;
let filters, overview, browse;

// ------------------------------------------------------------------ routing

function parseHash() {
  const [path, query = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const view = parts[0] === "browse" ? "browse" : "overview";
  return { view, id: view === "browse" ? parts[1] ?? null : null, compare: parts[2] === "compare", params: new URLSearchParams(query) };
}

function hashFor({ view, id, compare }) {
  let path = `#/${view}`;
  if (view === "browse" && id != null) path += `/${encodeURIComponent(id)}${compare ? "/compare" : ""}`;
  const q = filtersToParams().toString();
  return q ? `${path}?${q}` : path;
}

/** Go somewhere. `replace` swaps the history entry instead of adding one. */
function navigate(view, id = null, compare = false, { replace = false } = {}) {
  const target = { view, id, compare };
  const hash = hashFor(target);
  if (view === "browse") lastBrowse = { id, compare };
  if (replace) { history.replaceState(null, "", hash); apply(); }
  else if (location.hash === hash) apply();
  else location.hash = hash;
}

const navigateToResponse = (id, compare = false) => navigate("browse", id, compare);

/** True while the URL, not a click, is what changed the filters. */
let fromUrl = false;

async function apply() {
  route = parseHash();
  if (route.params.toString() === filtersToParams().toString()) return show();
  const { q, scope } = paramsToFilters(route.params);
  selection = null;
  fromUrl = true;
  try {
    if (q !== F.q || scope !== F.scope) await applyQuery(q, scope);   // emits once the server answers
    else emit();
  } finally {
    fromUrl = false;
  }
}

function show({ fromFilter = false } = {}) {
  const isBrowse = route.view === "browse";
  $("#overview").hidden = isBrowse;
  $("#browse").hidden = !isBrowse;
  document.querySelectorAll(".tabbtn").forEach((b) => b.setAttribute("aria-selected", String((b.dataset.view === "browse") === isBrowse)));
  filters.sync();
  if (!isBrowse) { overview.render(); return; }

  const { first, inList } = browse.update(route.id);
  if (first == null) { browse.empty(); return; }
  // No id yet, or a filter just excluded the one on screen: land on the list's first entry.
  // (A shared deep link to an id outside its own filters is shown as given.)
  if (route.id == null || (fromFilter && !inList)) return navigate("browse", first, false, { replace: true });
  if (F.implicit !== lastImplicit) { lastImplicit = F.implicit; browse.refresh(); }
  lastBrowse = { id: route.id, compare: route.compare };
  browse.show(route.id, route.compare);
}

onChange(() => {
  selection = null;
  // A click rewrites the URL to stay shareable and may move off an excluded response;
  // a URL that arrived with filters is shown as given.
  if (!fromUrl) history.replaceState(null, "", hashFor(route));
  show({ fromFilter: !fromUrl });
});

/** Overview click-throughs: narrow some filters, then read the responses. undefined = leave, null = clear. */
function drill({ model, task, type }) {
  const set = (key, v) => { if (v === undefined) return; F[key].clear(); if (v !== null) F[key].add(v); };
  set("model", model); set("task", task); set("type", type);
  selection = null;
  navigate("browse", lastBrowse.id);
}

// ---------------------------------------------------------------- shortcuts

function typing(e) {
  return e.target.closest?.("input, select, textarea, [contenteditable]") != null;
}

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") { document.activeElement?.blur?.(); return; }
  if (typing(e)) return;
  const inBrowse = route.view === "browse";
  switch (e.key) {
    case "/": e.preventDefault(); filters.focusSearch(); break;
    case "1": navigate("overview"); break;
    case "2": navigate("browse", lastBrowse.id, lastBrowse.compare); break;
    case "t": toggleTheme(); break;
    case "j": if (inBrowse) browse.step(1); break;
    case "k": if (inBrowse) browse.step(-1); break;
    case "ArrowDown": case "ArrowUp":
      if (inBrowse && e.target.closest?.(".vlist")) { e.preventDefault(); browse.step(e.key === "ArrowDown" ? 1 : -1); }
      break;
    case "ArrowLeft": case "ArrowRight":
      if (inBrowse && !e.target.closest?.("svg")) browse.siblings(e.key === "ArrowRight" ? 1 : -1);
      break;
    case "c": if (inBrowse && route.id != null) navigate("browse", route.id, !route.compare); break;
    default:
  }
});

addEventListener("hashchange", apply);
addEventListener("themechange", () => { if (route.view === "overview" && overview) overview.render(); });

// --------------------------------------------------------------------- boot

function showProgress(p) {
  const bar = $("#boot progress"), status = $("#boot .boot-status");
  if (p.stage === "download") {
    bar.max = p.total; bar.value = p.loaded;
    // A percentage, not megabytes: the stream counts decompressed bytes (~35 MB), the wire carries ~7 MB.
    status.textContent = `${p.where === "local" ? "Reading the local copy in site/data/" : "Downloading from GitHub"}… ${Math.floor((100 * p.loaded) / p.total)}%`;
  } else if (p.stage === "parse") {
    bar.removeAttribute("value");                          // indeterminate while parsing
    status.textContent = "Reading the responses…";
  }
}

async function main() {
  try {
    // ?data=local or ?data=upstream overrides where the dataset comes from.
    await loadIndex({ progress: showProgress, prefer: new URLSearchParams(location.search).get("data") || undefined });
  } catch (err) {
    $("#boot").replaceChildren(
      h("p", { class: "boot-title" }, "Could not load the RAGTruth dataset."),
      h("p", { class: "boot-status" }, String(err.message || err)),
      h("p", { class: "boot-note" }, "It is downloaded from the RAGTruth repository on GitHub, so check your connection and reload."));
    return;
  }
  lastImplicit = F.implicit;
  $("#boot").remove();
  $("#tagline").textContent = `${fmtInt(D.n)} responses · ${fmtInt(D.sourceIds.length)} sources · ${D.f.models.length} models`;

  filters = mountFilters($("#filters"), { selectedCount: () => selected().length });
  overview = mountOverview($("#overview"), { drill, selected });
  browse = mountBrowse($("#browse"), { selected, navigate: navigateToResponse });
  document.querySelectorAll(".tabbtn").forEach((b) => b.addEventListener("click", () =>
    b.dataset.view === "browse" ? navigate("browse", lastBrowse.id, lastBrowse.compare) : navigate("overview")));
  $("#theme").addEventListener("click", toggleTheme);

  // Enter via a (possibly filtered) deep link, or start at the overview.
  await apply();
}

main();
