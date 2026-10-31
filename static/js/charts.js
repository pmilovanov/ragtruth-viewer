// Chart primitives. Bars/heatmaps are HTML (they size themselves); lines and
// columns are SVG redrawn at the container's pixel width. Every chart sits in a
// card that provides a legend, a table-view twin, and a note.
//
// Marks follow the dataviz specs: thin bars with a 4px rounded data end, 2px
// lines, >=8px markers, 2px surface gaps/rings, recessive hairline grid.

import { h, bindTip, showTip, hideTip, seqColor, inkOn, cssVar } from "./ui.js";
import { niceTicks } from "./lib.js";

const NO_DATA = "No responses match the current filters.";

// ------------------------------------------------------------------ card

/**
 * A titled panel. `set(spec)` paints it:
 *   spec = { draw(box), legend?: [{label,color,kind}], table: {head, rows}, note?, empty? }
 */
export function card({ title, sub, controls = [], span = 6, tableToggle = true }) {
  let spec = null, showTable = false;
  const toggle = h("button", {
    class: "btn small", type: "button", "aria-pressed": "false", title: "Switch between chart and table",
    onclick: () => { showTable = !showTable; toggle.setAttribute("aria-pressed", String(showTable)); paint(); },
  }, "Table");
  const body = h("div", { class: "card-body" });
  const legendEl = h("div", { class: "legend" });
  const noteEl = h("p", { class: "note" });
  const el = h("section", { class: `card span-${span}` },
    h("header", { class: "card-head" },
      h("div", { class: "card-titles" }, h("h3", {}, title), sub && h("p", { class: "sub" }, sub)),
      h("div", { class: "card-ctl" }, ...controls, tableToggle && toggle)),
    legendEl, body, noteEl);

  function paint() {
    hideTip();
    body._ro?.disconnect();
    body.replaceChildren();
    legendEl.replaceChildren();
    noteEl.textContent = "";
    if (!spec) return;
    if (spec.empty) {
      body.append(h("div", { class: "empty" }, spec.empty));
    } else {
      if (spec.legend && !showTable) legendEl.append(...spec.legend.map(legendItem));
      if (showTable) body.append(tableEl(spec.table));
      else spec.draw(body);
    }
    noteEl.textContent = spec.note || "";
  }
  return { el, set(s) { spec = s; paint(); }, repaint: paint, empty: NO_DATA };
}

export function legendItem({ label, color, kind = "rect" }) {
  return h("span", { class: "lg" }, h("i", { class: `key ${kind}`, style: { background: color } }), label);
}

export function tableEl({ head, rows, align }) {
  return h("div", { class: "table-wrap" },
    h("table", { class: "dt" },
      h("thead", {}, h("tr", {}, head.map((t, i) => h("th", { class: align?.[i] === "l" ? "l" : "" }, t)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: align?.[i] === "l" || i === 0 ? "l" : "" }, c)))))));
}

export function tile({ label, value, sub }) {
  return h("div", { class: "tile" },
    h("div", { class: "tile-label" }, label),
    h("div", { class: "tile-value" }, value),
    [].concat(sub || []).filter(Boolean).map((line) => h("div", { class: "tile-sub" }, line)));
}

/** Call draw(width) whenever the box's width changes; it returns the node to show. */
function responsive(box, draw) {
  let width = 0;
  const run = () => {
    const w = Math.floor(box.clientWidth);
    if (!w || w === width) return;
    width = w;
    box.replaceChildren(draw(w));
  };
  box._ro?.disconnect();
  box._ro = new ResizeObserver(run);
  box._ro.observe(box);
  run();
}

// --------------------------------------------------------------- heatmap

/**
 * cells[r][c] = null | {value, text, tip, onClick}
 * Colour is sequential over 0..max; the number is printed in the cell, so the
 * scale is never colour-only.
 */
export function heatmap(box, { rowLabels, colLabels, cells, max, labelWidth = 150, scaleLabel }) {
  const grid = h("div", { class: "hm", style: { gridTemplateColumns: `${labelWidth}px repeat(${colLabels.length}, minmax(0, 1fr))` } });
  grid.append(h("div", { class: "hm-corner" }));
  colLabels.forEach((c) => grid.append(h("div", { class: "hm-col" }, c)));
  rowLabels.forEach((rl, r) => {
    grid.append(h("div", { class: "hm-row" }, rl));
    colLabels.forEach((_, c) => {
      const cell = cells[r][c];
      if (!cell) { grid.append(h("div", { class: "hm-cell none" }, "–")); return; }
      const bg = seqColor(max > 0 ? cell.value / max : 0);
      const node = h("div", {
        class: "hm-cell" + (cell.onClick ? " click" : ""), tabindex: 0,
        role: cell.onClick ? "button" : "img", "aria-label": cell.aria || cell.text,
        style: { background: bg, color: inkOn(bg) },
      }, cell.text);
      bindTip(node, () => cell.tip);
      if (cell.onClick) {
        node.addEventListener("click", cell.onClick);
        node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cell.onClick(); } });
      }
      grid.append(node);
    });
  });
  const scale = h("div", { class: "hm-scale" },
    h("span", {}, "0"),
    h("i", { style: { background: `linear-gradient(90deg, ${[0, .25, .5, .75, 1].map(seqColor).join(",")})` } }),
    h("span", {}, scaleLabel || ""));
  box.replaceChildren(grid, scale);
}

// ------------------------------------------------------------ horizontal bars

/**
 * rows: [{label, sub?, segs: [{value, color(hex), tip, onClick?, label?}]}]
 * Segments are laid end to end from a single baseline with a 2px surface gap;
 * the last one carries the 4px rounded data end. `label` is printed inside the
 * segment only when it fits.
 */
export function hbars(box, { rows, max, ticks, fmtTick, labelWidth = 150, rowH = 28, barH = 18 }) {
  const labels = h("div", { class: "hb-labels" });
  const plot = h("div", { class: "hb-plot" }, h("div", { class: "hb-grid", "aria-hidden": "true" },
    ticks.map((t) => h("i", { style: { left: `${(t / max) * 100}%` } }))));
  const inside = [];
  for (const row of rows) {
    labels.append(h("div", { class: "hb-label", style: { height: `${rowH}px` } }, row.label, row.sub && h("small", {}, row.sub)));
    const track = h("div", { class: "hb-track", style: { height: `${rowH}px` } });
    const live = row.segs.filter((s) => s.value > 0);
    let x = 0;
    for (const s of live) {
      const w = (s.value / max) * 100;
      const text = s.label ? h("span", { class: "hb-text" }, s.label) : null;
      const seg = h("div", {
        class: "hb-seg" + (s === live[live.length - 1] ? " last" : "") + (s.onClick ? " click" : ""),
        tabindex: 0, role: s.onClick ? "button" : "img", "aria-label": s.aria || (s.tip && s.tip.title) || "",
        style: { left: `${x}%`, width: `max(2px, calc(${w}% - 2px))`, height: `${barH}px`, background: s.color, color: inkOn(s.color) },
      }, text);
      x += w;
      bindTip(seg, () => s.tip);
      if (s.onClick) {
        seg.addEventListener("click", s.onClick);
        seg.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); s.onClick(); } });
      }
      if (text) inside.push({ seg, text });
      track.append(seg);
    }
    plot.append(track);
  }
  const tickRow = h("div", { class: "hb-ticks" }, ticks.map((t) => h("span", { style: { left: `${(t / max) * 100}%` } }, fmtTick(t))));
  const wrap = h("div", { class: "hb", style: { "--labw": `${labelWidth}px` } }, labels, plot, h("div"), tickRow);
  box.replaceChildren(wrap);

  // A label that won't fit is dropped (the tooltip and table keep the value); never clipped.
  const fit = () => {
    for (const { seg, text } of inside) {
      text.hidden = false;
      if (seg.clientWidth < text.scrollWidth + 12) text.hidden = true;
    }
  };
  box._ro?.disconnect();
  box._ro = new ResizeObserver(fit);
  box._ro.observe(wrap);
  requestAnimationFrame(fit);
}

// --------------------------------------------------------------- SVG plots

const svg = (tag, attrs, ...kids) => h(`svg:${tag}`, attrs, ...kids);

/** Shared frame: margins, hairline y grid, y tick labels, x tick labels. */
function frame(w, { height, left = 44, right = 12, top = 10, bottom = 30, yMax, yFmt, labels, tick }) {
  const pw = w - left - right, ph = height - top - bottom;
  tick = tick || ((i) => labels[i]);
  // Thin the x labels so neighbours never collide: every k-th, k from the widest label.
  const widest = Math.max(...labels.map((_, i) => String(tick(i)).length));
  const tickEvery = Math.max(1, Math.ceil((widest * 6.6 + 14) / (pw / labels.length)));
  const { ticks, top: yTop } = niceTicks(yMax, 4);
  const n = labels.length;
  const x = (i) => left + (pw * (i + 0.5)) / n;
  const y = (v) => top + ph - (v / yTop) * ph;
  const root = svg("svg", { class: "plot", width: w, height, viewBox: `0 0 ${w} ${height}`, role: "img" });
  for (const t of ticks) {
    root.append(svg("line", { class: "gl", x1: left, x2: left + pw, y1: y(t), y2: y(t) }));
    root.append(svg("text", { class: "tick", x: left - 8, y: y(t) + 4, "text-anchor": "end" }, yFmt(t)));
  }
  labels.forEach((_, i) => {
    if (i % tickEvery === 0) {
      root.append(svg("text", { class: "tick", x: x(i), y: top + ph + 18, "text-anchor": "middle" }, tick(i)));
    }
  });
  root.append(svg("line", { class: "axis", x1: left, x2: left + pw, y1: y(0), y2: y(0) }));
  return { root, x, y, pw, ph, left, top, n, band: pw / n, yTop };
}

/** Pointer + arrow-key hover over n x-bands, with a crosshair and one tooltip for every series. */
function bandHover(fr, { onShow, svgRoot = fr.root }) {
  const cross = svg("line", { class: "cross", y1: fr.top, y2: fr.top + fr.ph, visibility: "hidden" });
  const hits = svg("g");
  let cur = -1;
  const show = (i, clientX, clientY) => {
    cur = i;
    cross.setAttribute("x1", fr.x(i)); cross.setAttribute("x2", fr.x(i));
    cross.setAttribute("visibility", "visible");
    if (clientX == null) {                       // keyboard: anchor to the band
      const r = svgRoot.getBoundingClientRect();
      clientX = r.left + fr.x(i); clientY = r.top + fr.top + fr.ph / 2;
    }
    showTip(onShow(i), clientX, clientY);
  };
  const clear = () => { cur = -1; cross.setAttribute("visibility", "hidden"); hideTip(); };
  for (let i = 0; i < fr.n; i++) {
    const r = svg("rect", { class: "hit", x: fr.x(i) - fr.band / 2, y: fr.top, width: fr.band, height: fr.ph });
    r.addEventListener("pointerenter", (e) => show(i, e.clientX, e.clientY));
    r.addEventListener("pointermove", (e) => show(i, e.clientX, e.clientY));
    r.addEventListener("pointerleave", clear);
    hits.append(r);
  }
  svgRoot.setAttribute("tabindex", "0");
  svgRoot.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    show(Math.min(fr.n - 1, Math.max(0, (cur < 0 ? (e.key === "ArrowRight" ? -1 : fr.n) : cur) + (e.key === "ArrowRight" ? 1 : -1))));
  });
  svgRoot.addEventListener("blur", clear);
  return { cross, hits };
}

/**
 * Lines over categorical/binned x. series: [{name, color, values[], lo?[], hi?[]}]
 * `lo`/`hi` draw whiskers (confidence intervals). Missing values are null.
 * End labels are printed only where they don't collide; the legend carries the rest.
 */
export function lineChart(box, { x, xTick, series, yMax, yFmt, tipTitle, tipValue, height = 250, endLabels = false }) {
  responsive(box, (w) => {
    const right = endLabels ? 150 : 14;
    const fr = frame(w, { height, right, yMax, yFmt, labels: x, tick: xTick });
    const hover = bandHover(fr, {
      onShow: (i) => ({
        title: tipTitle(i),
        rows: series.filter((s) => s.values[i] != null).map((s) => ({ color: s.color, label: s.name, value: tipValue(s, i) })),
      }),
    });
    const dots = [];
    for (const s of series) {
      const pts = s.values.map((v, i) => (v == null ? null : [fr.x(i), fr.y(v)]));
      if (s.lo) {
        s.values.forEach((v, i) => {
          if (v == null) return;
          fr.root.append(svg("line", { class: "whisker", style: { stroke: s.color }, x1: fr.x(i), x2: fr.x(i), y1: fr.y(s.lo[i]), y2: fr.y(s.hi[i]) }));
          for (const yy of [s.lo[i], s.hi[i]]) {
            fr.root.append(svg("line", { class: "whisker", style: { stroke: s.color }, x1: fr.x(i) - 4, x2: fr.x(i) + 4, y1: fr.y(yy), y2: fr.y(yy) }));
          }
        });
      }
      const path = pts.reduce((d, p, i) => (p ? d + `${d && pts[i - 1] ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}` : d), "");
      fr.root.append(svg("path", { class: "line", d: path, style: { stroke: s.color } }));
      pts.forEach((p, i) => {
        if (!p || (x.length > 14 && i !== pts.length - 1)) return;         // dense: mark only the end
        const c = svg("circle", { class: "dot", cx: p[0], cy: p[1], r: 4, style: { fill: s.color } });
        dots.push(c);
        fr.root.append(c);
      });
    }
    if (endLabels) {
      const placed = [];
      series.map((s) => {
        const i = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null);
        return { s, i, yy: fr.y(s.values[i]) };
      }).sort((a, b) => a.yy - b.yy).forEach(({ s, i, yy }) => {
        if (placed.some((p) => Math.abs(p - yy) < 14)) return;
        placed.push(yy);
        fr.root.append(svg("text", { class: "endlabel", x: fr.x(i) + 10, y: yy + 4 }, s.name));
      });
    }
    fr.root.append(hover.cross, hover.hits);
    return fr.root;
  });
}

/**
 * Columns with optional "expected" markers. series: observed values, marks: expected values.
 * Columns are capped at 24px with a 4px rounded top and a square base.
 */
export function columnChart(box, { x, values, marks, color, markColor, yMax, yFmt, tipTitle, tipRows, height = 240 }) {
  responsive(box, (w) => {
    const fr = frame(w, { height, yMax, yFmt, labels: x });
    const bw = Math.min(24, fr.band * 0.6);
    values.forEach((v, i) => {
      if (!(v > 0)) return;
      const top = fr.y(v), base = fr.y(0), r = Math.min(4, (base - top) / 2, bw / 2);
      fr.root.append(svg("path", {
        class: "col", style: { fill: color },
        d: `M${fr.x(i) - bw / 2},${base}V${top + r}Q${fr.x(i) - bw / 2},${top} ${fr.x(i) - bw / 2 + r},${top}H${fr.x(i) + bw / 2 - r}Q${fr.x(i) + bw / 2},${top} ${fr.x(i) + bw / 2},${top + r}V${base}Z`,
      }));
    });
    marks?.forEach((v, i) => {
      if (v == null) return;
      fr.root.append(svg("circle", { class: "dot", cx: fr.x(i), cy: fr.y(v), r: 4.5, style: { fill: markColor } }));
    });
    const hover = bandHover(fr, { onShow: (i) => ({ title: tipTitle(i), rows: tipRows(i) }) });
    fr.root.append(hover.cross, hover.hits);
    return fr.root;
  });
}

// ------------------------------------------------------------ data table with bars

/** A table whose chosen columns carry a thin in-cell bar (0..1). cells: string | {text, bar} */
export function barTable({ head, rows, barColor }) {
  const cell = (c, i) => {
    if (c && typeof c === "object" && !(c instanceof Node)) {
      return h("td", { class: "bar-cell" },
        h("span", { class: "bar-num" }, c.text),
        h("span", { class: "bar-track" }, h("i", { style: { width: `${Math.max(0, Math.min(1, c.bar)) * 100}%`, background: barColor } })));
    }
    return h("td", { class: i === 0 ? "l" : "" }, c);
  };
  return h("div", { class: "table-wrap" },
    h("table", { class: "dt" },
      h("thead", {}, h("tr", {}, head.map((t, i) => h("th", { class: i === 0 ? "l" : "" }, t)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map(cell))))));
}

export const typeColors = () => [0, 1, 2, 3].map((i) => cssVar(`--t${i}`));
