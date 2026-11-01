// The list/detail view: a virtualised list of the selected responses beside the
// full view of the one under the cursor.

import { D, rowInfo } from "./data.js";
import { h, download, csvCell } from "./ui.js";
import { fmtInt, fmtPct } from "./lib.js";
import { mountDetail, strip } from "./detail.js";

const ROW_H = 66;

const SORTS = {
  order: { label: "Dataset order", cmp: (a, b) => a - b },
  spans: { label: "Most spans", cmp: (a, b) => D.nsp[b] - D.nsp[a] || a - b },
  share: { label: "Most text annotated", cmp: (a, b) => D.hch[b] / D.len[b] - D.hch[a] / D.len[a] || a - b },
  long: { label: "Longest response", cmp: (a, b) => D.len[b] - D.len[a] || a - b },
  short: { label: "Shortest response", cmp: (a, b) => D.len[a] - D.len[b] || a - b },
};

export function mountBrowse(root, { selected, navigate }) {
  let sort = "order", order = new Int32Array(0), cur = -1, shown = null;

  const count = h("span", { class: "list-count" });
  const sortSel = h("select", { class: "ctl", "aria-label": "Sort", onchange: (e) => { sort = e.target.value; resort(); } },
    Object.entries(SORTS).map(([k, v]) => h("option", { value: k }, v.label)));
  const vp = h("div", { class: "vlist", tabindex: 0, role: "listbox", "aria-label": "Responses" });
  const space = h("div", { class: "vspace" });
  const rowsEl = h("div", { class: "vrows" });
  space.append(rowsEl);
  vp.append(space);

  const randomBtn = h("button", { class: "btn small", type: "button", title: "Jump to a random response in this list", onclick: () => {
    if (order.length) navigate(D.id[order[Math.floor(Math.random() * order.length)]]);
  } }, "Random");
  const csvBtn = h("button", { class: "btn small", type: "button", title: "Download the filtered list as CSV", onclick: () => {
    const head = ["id", "source_id", "model", "task", "dataset", "split", "temperature", "quality", "n_spans", "hallucinated_chars", "response_chars"];
    const lines = [head.join(",")];
    for (const r of order) {
      const i = rowInfo(r);
      lines.push([i.id, D.sourceIds[D.sx[r]], i.model, i.task, i.dataset, i.split, i.temp, i.quality, i.nsp, i.hch, i.len].map(csvCell).join(","));
    }
    download("ragtruth-selection.csv", lines.join("\n") + "\n");
  } }, "CSV");

  const pane = h("section", { class: "detail-pane", "aria-live": "polite" });
  const detail = mountDetail(pane, { navigate });

  const list = h("aside", { class: "list-pane" },
    h("div", { class: "list-head" }, count, h("div", { class: "list-tools" }, sortSel, randomBtn, csvBtn)),
    vp,
    h("p", { class: "list-help" }, h("kbd", {}, "j"), " ", h("kbd", {}, "k"), " move · ", h("kbd", {}, "←"), " ", h("kbd", {}, "→"),
      " models · ", h("kbd", {}, "c"), " compare · ", h("kbd", {}, "/"), " search"));
  root.append(list, pane);

  // ------------------------------------------------------------ list

  function rowEl(r) {
    const i = rowInfo(r);
    const el = h("div", {
      class: "row" + (r === cur ? " cur" : ""), role: "option", "aria-selected": r === cur ? "true" : "false", tabindex: -1,
      style: { height: `${ROW_H}px` }, dataset: { row: r },
      onclick: () => navigate(i.id),
    },
      h("div", { class: "row-top" },
        h("span", { class: "rid" }, `#${i.id}`), h("span", { class: "rmodel" }, i.model),
        h("span", { class: "rtask" }, i.dataset),
        i.quality !== "good" && h("span", { class: "chip warn tiny", title: i.quality }, "!")),
      strip(r),
      h("div", { class: "row-sub" },
        i.nsp ? `${i.nsp} ${i.nsp === 1 ? "span" : "spans"} · ${fmtPct(i.share, 0)} of text` : h("span", { class: "clean" }, "clean"),
        h("span", { class: "dim" }, ` · ${fmtInt(i.len)} chars · T ${i.temp}`)));
    return el;
  }

  let queued = false;
  function paint() {
    queued = false;
    const top = vp.scrollTop, view = vp.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 5), last = Math.min(order.length, Math.ceil((top + view) / ROW_H) + 5);
    rowsEl.style.transform = `translateY(${first * ROW_H}px)`;
    rowsEl.replaceChildren(...Array.from(order.subarray(first, last), rowEl));
  }
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  vp.addEventListener("scroll", schedule);
  new ResizeObserver(schedule).observe(vp);

  function resort() {
    order = Int32Array.from(selected()).sort(SORTS[sort].cmp);
    space.style.height = `${order.length * ROW_H}px`;
    count.textContent = `${fmtInt(order.length)} of ${fmtInt(D.n)} responses`;
    paint();
  }

  function reveal() {
    const at = order.indexOf(cur);
    if (at < 0) return;
    const y = at * ROW_H, view = vp.clientHeight;
    if (y < vp.scrollTop) vp.scrollTop = y;
    else if (y + ROW_H > vp.scrollTop + view) vp.scrollTop = y + ROW_H - view;
  }

  // ------------------------------------------------------------ api

  function step(delta) {
    if (!order.length) return;
    const at = order.indexOf(cur);
    const next = at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, at + delta));
    navigate(D.id[order[next]]);
  }

  return {
    /**
     * Rebuild the list from the current selection, pointing it at the route's id.
     * -> the first id in the list, and whether the route's id is in it.
     */
    update(routeId) {
      cur = routeId != null ? (D.rowOfId.get(routeId) ?? -1) : -1;
      resort();
      return { first: order.length ? D.id[order[0]] : null, inList: cur >= 0 && order.indexOf(cur) >= 0 };
    },
    /** Point the list at `id`; the detail is rebuilt only if the id or mode changed. */
    show(id, compare) {
      cur = D.rowOfId.get(id) ?? -1;
      if (cur < 0) { shown = null; detail.clear(`No response with id ${id}.`); return; }
      paint();
      reveal();
      if (!shown || shown.id !== id || shown.compare !== !!compare) {
        shown = { id, compare: !!compare };
        detail.show(id, compare);
      }
    },
    empty() { cur = -1; shown = null; paint(); detail.clear("No responses match the current filters."); },
    refresh() { paint(); detail.refresh(); },
    step,
    siblings: (delta) => {
      if (cur < 0) return;
      const mates = D.groups.find((g) => g.includes(cur));
      if (!mates) return;
      const sorted = mates.slice().sort((a, b) => D.model[a] - D.model[b]);
      const next = sorted[sorted.indexOf(cur) + delta];
      if (next != null) navigate(D.id[next]);
    },
  };
}
