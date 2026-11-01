// Aggregate views. Everything here is a pure function of the current selection
// (the rows that pass the global filters), so every number on the page agrees.

import { D, F } from "./data.js";
import { h, cssVar, ordinalRamp } from "./ui.js";
import { card, tile, heatmap, hbars, lineChart, columnChart, barTable, typeColors } from "./charts.js";
import {
  wilson, quantileEdges, binOf, poissonBinomial, median, niceTicks, fmtInt, fmtPct, fmtNum,
} from "./lib.js";

const NO_DATA = "No responses match the current filters.";
const pct0 = (v) => fmtPct(v, 0);

function select(options, value, onChange, label) {
  return h("select", { class: "ctl", "aria-label": label, onchange: (e) => onChange(e.target.value) },
    options.map(([v, text]) => h("option", { value: v, selected: v === value }, text)));
}

/** Rows grouped by a small-integer facet column -> arrays of row indices. */
function groupBy(rows, col, size) {
  const out = Array.from({ length: size }, () => []);
  for (const r of rows) out[col[r]].push(r);
  return out;
}

export function mountOverview(root, { drill, selected }) {
  const ui = { metric: "rate", mix: "count", x: "len" };
  const tilesEl = h("div", { class: "tiles" });

  const heat = card({
    title: "Hallucination by model and task", sub: "Click a cell to read those responses",
    controls: [select([["rate", "Responses with a hallucination"], ["spans", "Spans per response"], ["share", "Share of text annotated"]],
      ui.metric, (v) => { ui.metric = v; render(); }, "Heatmap metric")],
  });
  const mix = card({
    title: "What kind of hallucination", sub: "Annotated spans by label type",
    controls: [select([["count", "Spans per response"], ["share", "Share of spans"]], ui.mix, (v) => { ui.mix = v; render(); }, "Stack mode")],
  });
  const dist = card({ title: "Spans per response", sub: "Share of each model's responses, by how many spans were annotated" });
  const lens = card({ title: "How long hallucinated spans are", sub: "Share of each type's spans, by length in words" });
  const pos = card({ title: "Where in the response", sub: "Share of text annotated as hallucination, by relative position" });
  const rate = card({
    title: "Hallucination rate against", sub: "Share of responses with at least one span; bars are 95% Wilson intervals",
    controls: [select([["len", "response length"], ["plen", "prompt length"], ["temp", "temperature"]], ui.x, (v) => { ui.x = v; render(); }, "X variable")],
  });
  const diff = card({ title: "The source, or the model?", sub: "How many of a source's responses hallucinate, against what independent models would give" });
  const types = card({ title: "Annotation details", sub: "Every annotated span, implicit-true included", tableToggle: false });
  const splits = card({ title: "Splits", sub: "Train/test composition and hallucination rate by dataset", tableToggle: false });
  const quality = card({ title: "Response quality flags", sub: "Annotator-marked refusals and truncations, by model", tableToggle: false });

  root.append(tilesEl, h("div", { class: "grid" }, heat.el, mix.el, dist.el, lens.el, pos.el, rate.el, diff.el, types.el, splits.el, quality.el));

  const models = D.f.models, tasks = D.f.tasks, typeNames = D.f.types;
  let baseline = null, baselineKey = null;

  function render() {
    const rows = selected();
    renderTiles(rows);
    const cards = [heat, mix, dist, lens, pos, rate, diff, types, splits, quality];
    if (!rows.length) { cards.forEach((c) => c.set({ empty: NO_DATA })); return; }
    renderHeat(rows); renderMix(rows); renderDist(rows); renderLens(rows); renderPos(rows);
    renderRate(rows); renderDiff(rows); renderTypes(rows); renderSplits(rows); renderQuality(rows);
  }

  // ------------------------------------------------------------- tiles

  function overall() {
    const key = String(F.implicit);
    if (baselineKey !== key) {
      let hal = 0;
      for (let i = 0; i < D.n; i++) if (D.nsp[i]) hal++;
      baseline = hal / D.n; baselineKey = key;
    }
    return baseline;
  }

  function renderTiles(rows) {
    const n = rows.length;
    let hal = 0, spans = 0, hch = 0, chars = 0;
    const sources = new Set();
    for (const r of rows) {
      if (D.nsp[r]) hal++;
      spans += D.nsp[r]; hch += D.hch[r]; chars += D.len[r]; sources.add(D.sx[r]);
    }
    const [lo, hi] = wilson(hal, n);
    const filtered = n !== D.n;
    tilesEl.replaceChildren(
      tile({ label: "Responses", value: fmtInt(n), sub: `${fmtInt(sources.size)} sources${filtered ? ` · of ${fmtInt(D.n)}` : ""}` }),
      tile({
        label: "With a hallucination", value: n ? fmtPct(hal / n) : "–",
        sub: n ? [`${fmtInt(hal)} responses · 95% CI ${fmtPct(lo)}–${fmtPct(hi)}`, filtered ? `overall ${fmtPct(overall())}` : ""] : "",
      }),
      tile({
        label: "Annotated spans", value: fmtInt(spans),
        sub: n ? `${fmtNum(spans / n)} per response · ${hal ? fmtNum(spans / hal) : "–"} per hallucinated one` : "",
      }),
      tile({ label: "Text annotated", value: chars ? fmtPct(hch / chars) : "–", sub: "of all response characters" }),
    );
  }

  // ----------------------------------------------------------- heatmap

  function renderHeat(rows) {
    const M = models.length, T = tasks.length;
    const mk = () => Array.from({ length: M }, () => new Float64Array(T + 1));
    const cnt = mk(), hal = mk(), spn = mk(), hch = mk(), chr = mk();
    for (const r of rows) {
      for (const c of [D.task[r], T]) {
        const m = D.model[r];
        cnt[m][c]++; hal[m][c] += D.nsp[r] ? 1 : 0; spn[m][c] += D.nsp[r]; hch[m][c] += D.hch[r]; chr[m][c] += D.len[r];
      }
    }
    const value = (m, c) => (ui.metric === "rate" ? hal[m][c] / cnt[m][c]
      : ui.metric === "spans" ? spn[m][c] / cnt[m][c] : hch[m][c] / chr[m][c]);
    const fmt = ui.metric === "spans" ? (v) => fmtNum(v) : (v) => fmtPct(v);
    const metricName = { rate: "responses with a hallucination", spans: "spans per response", share: "of text annotated" }[ui.metric];
    const vis = models.map((_, m) => m).filter((m) => cnt[m][T] > 0);
    const colLabels = [...tasks, "All tasks"];
    let max = 0;
    vis.forEach((m) => colLabels.forEach((_, c) => { if (cnt[m][c]) max = Math.max(max, value(m, c)); }));

    const cells = vis.map((m) => colLabels.map((_, c) => {
      if (!cnt[m][c]) return null;
      const v = value(m, c), [lo, hi] = wilson(hal[m][c], cnt[m][c]);
      return {
        value: v, text: fmt(v), aria: `${models[m]}, ${colLabels[c]}: ${fmt(v)} ${metricName}`,
        tip: {
          title: `${models[m]} · ${colLabels[c]}`,
          rows: [
            { value: fmt(v), label: metricName },
            { value: `${fmtInt(hal[m][c])} of ${fmtInt(cnt[m][c])}`, label: `with a hallucination (${fmtPct(lo)}–${fmtPct(hi)})` },
            { value: fmtNum(spn[m][c] / cnt[m][c]), label: "spans per response" },
          ],
          note: "Click to browse these responses",
        },
        onClick: () => drill({ model: m, task: c < T ? c : null }),
      };
    }));
    heat.set({
      draw: (box) => heatmap(box, { rowLabels: vis.map((m) => models[m]), colLabels, cells, max, scaleLabel: fmt(max) }),
      table: {
        head: ["Model", ...colLabels],
        rows: vis.map((m) => [models[m], ...colLabels.map((_, c) => (cnt[m][c] ? `${fmt(value(m, c))} (n=${fmtInt(cnt[m][c])})` : "–"))]),
      },
      note: `Colour runs from 0 to the largest cell. Metric: ${metricName}.`,
    });
  }

  // ------------------------------------------------------- type mix

  function renderMix(rows) {
    const colors = typeColors(), T = typeNames.length;
    const per = groupBy(rows, D.model, models.length);
    const buckets = [...per.map((rs, m) => ({ label: models[m], rows: rs, model: m })).filter((b) => b.rows.length),
      { label: "All models", rows: Array.from(rows), model: null }];
    for (const b of buckets) {
      b.counts = new Float64Array(T);
      for (const r of b.rows) for (let k = D.off[r]; k < D.off[r + 1]; k++) if (D.use[k]) b.counts[D.sp.t[k]]++;
      b.total = b.counts.reduce((a, c) => a + c, 0);
    }
    const share = ui.mix === "share";
    const val = (b, t) => (share ? (b.total ? b.counts[t] / b.total : 0) : b.counts[t] / b.rows.length);
    const maxVal = share ? 1 : Math.max(...buckets.map((b) => b.total / b.rows.length), 0.001);
    const axis = share ? { ticks: [0, 0.25, 0.5, 0.75, 1], top: 1 } : niceTicks(maxVal, 4);
    const fmtV = share ? pct0 : (v) => fmtNum(v);
    mix.set({
      legend: typeNames.map((t, i) => ({ label: t, color: colors[Math.min(i, 3)] })),
      draw: (box) => hbars(box, {
        max: axis.top, ticks: axis.ticks, fmtTick: share ? pct0 : (t) => String(t),
        rows: buckets.map((b) => ({
          label: b.label,
          segs: typeNames.map((tn, t) => ({
            value: val(b, t), color: colors[Math.min(t, 3)], label: fmtV(val(b, t)),
            tip: {
              title: `${b.label} · ${tn}`,
              rows: [
                { color: colors[Math.min(t, 3)], value: fmtNum(b.counts[t] / b.rows.length), label: "spans per response" },
                { value: b.total ? fmtPct(b.counts[t] / b.total) : "–", label: "of this model's spans" },
                { value: fmtInt(b.counts[t]), label: "spans in total" },
              ],
              note: b.model != null ? "Click to browse responses containing this type" : "Click to browse responses with this type",
            },
            onClick: () => drill({ model: b.model, type: t }),
          })),
        })),
      }),
      table: {
        head: ["Model", ...typeNames.map((t) => (share ? `${t} (share)` : `${t} (per response)`))],
        rows: buckets.map((b) => [b.label, ...typeNames.map((_, t) => fmtV(val(b, t)))]),
      },
      note: "Counts only spans that are counted as hallucinations (see the implicit-true switch).",
    });
  }

  // ------------------------------------------------- spans per response

  function renderDist(rows) {
    const per = groupBy(rows, D.model, models.length);
    const buckets = [...per.map((rs, m) => ({ label: models[m], rows: rs })).filter((b) => b.rows.length),
      { label: "All models", rows: Array.from(rows) }];
    const names = ["0", "1", "2", "3", "4+"];
    const colors = [cssVar("--zero"), ...ordinalRamp(4)];
    for (const b of buckets) {
      b.hist = new Float64Array(5);
      for (const r of b.rows) b.hist[Math.min(4, D.nsp[r])]++;
    }
    dist.set({
      legend: names.map((nm, i) => ({ label: nm === "1" ? "1 span" : `${nm} spans`, color: colors[i] })),
      draw: (box) => hbars(box, {
        max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmtTick: pct0,
        rows: buckets.map((b) => ({
          label: b.label,
          segs: names.map((nm, i) => ({
            value: b.hist[i] / b.rows.length, color: colors[i], label: pct0(b.hist[i] / b.rows.length),
            tip: { title: `${b.label} · ${nm} spans`, rows: [
              { color: colors[i], value: fmtPct(b.hist[i] / b.rows.length), label: "of responses" },
              { value: fmtInt(b.hist[i]), label: `responses of ${fmtInt(b.rows.length)}` }] },
          })),
        })),
      }),
      table: {
        head: ["Model", ...names.map((nm) => `${nm} spans`)],
        rows: buckets.map((b) => [b.label, ...names.map((_, i) => fmtPct(b.hist[i] / b.rows.length))]),
      },
    });
  }

  // ------------------------------------------------------ span length

  function renderLens(rows) {
    const edges = [1, 2, 4, 7, 13];                         // words: 1 | 2-3 | 4-6 | 7-12 | 13+
    const names = ["1 word", "2–3", "4–6", "7–12", "13+"];
    const colors = ordinalRamp(5);
    const T = typeNames.length;
    const buckets = typeNames.map((t, i) => ({ label: t, t: i, hist: new Float64Array(5), words: [] }));
    const all = { label: "All spans", t: null, hist: new Float64Array(5), words: [] };
    for (const r of rows) {
      for (let k = D.off[r]; k < D.off[r + 1]; k++) {
        if (!D.use[k]) continue;
        const w = D.sp.w[k];
        const bin = edges.filter((e) => w >= e).length - 1;
        for (const b of [buckets[Math.min(D.sp.t[k], T - 1)], all]) { b.hist[Math.max(0, bin)]++; b.words.push(w); }
      }
    }
    const shown = [...buckets.filter((b) => b.words.length), all];
    if (!all.words.length) { lens.set({ empty: "No annotated spans in this selection." }); return; }
    lens.set({
      legend: names.map((nm, i) => ({ label: nm, color: colors[i] })),
      draw: (box) => hbars(box, {
        max: 1, ticks: [0, 0.25, 0.5, 0.75, 1], fmtTick: pct0,
        rows: shown.map((b) => ({
          label: b.label, sub: `median ${fmtNum(median(b.words), 0)} words`,
          segs: names.map((nm, i) => ({
            value: b.hist[i] / b.words.length, color: colors[i], label: pct0(b.hist[i] / b.words.length),
            tip: { title: `${b.label} · ${nm}${i === 0 ? "" : " words"}`, rows: [
              { color: colors[i], value: fmtPct(b.hist[i] / b.words.length), label: "of spans" },
              { value: fmtInt(b.hist[i]), label: `spans of ${fmtInt(b.words.length)}` }] },
          })),
        })),
      }),
      table: {
        head: ["Label type", "Median words", ...names],
        rows: shown.map((b) => [b.label, fmtNum(median(b.words), 0), ...names.map((_, i) => fmtPct(b.hist[i] / b.words.length))]),
      },
    });
  }

  // --------------------------------------------------------- position

  function renderPos(rows) {
    const B = 20, colors = typeColors(), T = typeNames.length;
    const cover = Array.from({ length: T }, () => new Float64Array(B));
    const reach = new Float64Array(T);
    for (const r of rows) {
      const len = D.len[r];
      if (!len || D.off[r] === D.off[r + 1]) continue;
      reach.fill(-1);
      for (let k = D.off[r]; k < D.off[r + 1]; k++) {
        if (!D.use[k]) continue;
        const t = Math.min(D.sp.t[k], T - 1);
        const from = Math.max(D.sp.s[k], reach[t]), to = D.sp.e[k];
        reach[t] = Math.max(reach[t], to);
        if (to <= from) continue;
        const binLen = len / B;
        for (let b = Math.floor(from / binLen); b <= Math.min(B - 1, Math.floor((to - 1) / binLen)); b++) {
          const lo = Math.max(from, b * binLen), hi = Math.min(to, (b + 1) * binLen);
          if (hi > lo) cover[t][b] += (hi - lo) / binLen;
        }
      }
    }
    const n = rows.length;
    const series = typeNames.map((name, t) => ({ name, color: colors[Math.min(t, 3)], values: Array.from(cover[t], (v) => v / n) }));
    const yMax = Math.max(...series.flatMap((s) => s.values), 0.001);
    const x = Array.from({ length: B }, (_, b) => `${b * 5}–${(b + 1) * 5}%`);
    pos.set({
      legend: series.map((s) => ({ label: s.name, color: s.color, kind: "line" })),
      draw: (box) => lineChart(box, {
        x, xTick: (i) => `${i * 5}%`, series, yMax, yFmt: (v) => fmtPct(v, v < 0.1 ? 1 : 0), endLabels: true,
        tipTitle: (i) => `${x[i]} of the way through the response`,
        tipValue: (s, i) => fmtPct(s.values[i], 2),
      }),
      table: { head: ["Position", ...typeNames], rows: x.map((label, i) => [label, ...series.map((s) => fmtPct(s.values[i], 2))]) },
      note: "Averaged over every selected response, hallucinated or not, so heights compare across types.",
    });
  }

  // ------------------------------------------------------ rate vs x

  function renderRate(rows) {
    let bins;
    if (ui.x === "temp") {
      bins = D.f.temps.map((t) => ({ label: String(t), n: 0, k: 0 }));
      for (const r of rows) { const b = bins[D.temp[r]]; b.n++; if (D.nsp[r]) b.k++; }
    } else {
      const col = ui.x === "len" ? D.len : D.plen;
      const edges = quantileEdges(Array.from(rows, (r) => col[r]), 8);
      bins = edges.slice(0, -1).map((lo, i) => ({ label: `${fmtInt(lo)}–${fmtInt(edges[i + 1])}`, n: 0, k: 0 }));
      for (const r of rows) { const b = bins[binOf(edges, col[r])]; if (b) { b.n++; if (D.nsp[r]) b.k++; } }
    }
    bins = bins.filter((b) => b.n > 0);
    if (bins.length < 2) { rate.set({ empty: "Too little variation in this selection to bin." }); return; }
    bins.forEach((b) => { b.rate = b.k / b.n; [b.lo, b.hi] = wilson(b.k, b.n); });
    const color = cssVar("--t0");
    const unit = { len: "characters", plen: "characters", temp: "" }[ui.x];
    const series = [{ name: "Responses with a hallucination", color, values: bins.map((b) => b.rate), lo: bins.map((b) => b.lo), hi: bins.map((b) => b.hi) }];
    rate.set({
      draw: (box) => lineChart(box, {
        x: bins.map((b) => b.label), series, yMax: Math.max(...bins.map((b) => b.hi)), yFmt: pct0,
        tipTitle: (i) => `${bins[i].label} ${unit}`.trim(),
        tipValue: (s, i) => `${fmtPct(bins[i].rate)} (${fmtPct(bins[i].lo)}–${fmtPct(bins[i].hi)})`,
      }),
      table: { head: [ui.x === "temp" ? "Temperature" : "Bin (characters)", "Responses", "With a hallucination", "Rate", "95% CI"],
        rows: bins.map((b) => [b.label, fmtInt(b.n), fmtInt(b.k), fmtPct(b.rate), `${fmtPct(b.lo)}–${fmtPct(b.hi)}`]) },
      note: ui.x === "temp"
        ? "Only the open models were sampled at several temperatures; GPT-4 and GPT-3.5 sit at 0.7. Filter by model to isolate one."
        : "Longer text offers more room for error, and models differ in how much they write. Filter by model to separate the two.",
    });
  }

  // ------------------------------------------------ source vs model

  function renderDiff(rows) {
    if (F.hall !== "any" || F.type.size) {
      diff.set({ empty: "This comparison needs every response to a source, so set the hallucination filter to “any” and clear the label-type filter." });
      return;
    }
    const mask = new Uint8Array(D.n);
    for (const r of rows) mask[r] = 1;
    const groups = D.groups.map((g) => g.filter((r) => mask[r]));
    const size = Math.max(...groups.map((g) => g.length));
    const full = groups.filter((g) => g.length === size);
    if (size < 2 || full.length < 20) { diff.set({ empty: "Too few complete sources in this selection (select at least two models, and a broad slice)." }); return; }

    const mCnt = new Float64Array(models.length), mHal = new Float64Array(models.length);
    for (const g of full) for (const r of g) { mCnt[D.model[r]]++; if (D.nsp[r]) mHal[D.model[r]]++; }
    const pm = (m) => mHal[m] / mCnt[m];
    const obs = new Float64Array(size + 1), exp = new Float64Array(size + 1);
    for (const g of full) {
      obs[g.reduce((k, r) => k + (D.nsp[r] ? 1 : 0), 0)]++;
      poissonBinomial(g.map((r) => pm(D.model[r]))).forEach((p, k) => { exp[k] += p; });
    }
    const N = full.length;
    const x = Array.from({ length: size + 1 }, (_, k) => String(k));
    const values = Array.from(obs, (v) => v / N), marks = Array.from(exp, (v) => v / N);
    const colors = { bar: cssVar("--t0"), mark: cssVar("--t1") };
    const word = size === 6 ? "six" : String(size);
    diff.set({
      legend: [{ label: "Observed", color: colors.bar }, { label: "Expected if each model hallucinated independently", color: colors.mark, kind: "dot" }],
      draw: (box) => columnChart(box, {
        x, values, marks, color: colors.bar, markColor: colors.mark,
        yMax: Math.max(...values, ...marks), yFmt: pct0,
        tipTitle: (k) => `${k} of ${size} responses hallucinate`,
        tipRows: (k) => [
          { color: colors.bar, value: fmtPct(values[k]), label: `observed (${fmtInt(obs[k])} sources)` },
          { color: colors.mark, value: fmtPct(marks[k]), label: "expected" },
        ],
      }),
      table: { head: ["Responses that hallucinate", "Sources", "Observed", "Expected"],
        rows: x.map((k) => [k, fmtInt(obs[+k]), fmtPct(values[+k]), fmtPct(marks[+k])]) },
      note: `${fmtInt(N)} sources with all ${word} responses selected. Expected: each model hallucinates independently at its own rate. ` +
        `Zero: ${fmtPct(values[0])} observed vs ${fmtPct(marks[0])}. All ${size}: ${fmtPct(values[size])} vs ${fmtPct(marks[size])}.`,
    });
  }

  // ------------------------------------------------------------ tables

  function renderTypes(rows) {
    const T = typeNames.length;
    const b = typeNames.map(() => ({ n: 0, nul: 0, imp: 0, words: [] }));
    for (const r of rows) {
      for (let k = D.off[r]; k < D.off[r + 1]; k++) {
        const t = b[Math.min(D.sp.t[k], T - 1)];
        t.n++; t.nul += D.sp.n[k]; t.imp += D.sp.i[k]; t.words.push(D.sp.w[k]);
      }
    }
    const colors = typeColors();
    types.set({
      draw: (box) => box.replaceChildren(barTable({
        head: ["Label type", "Spans", "Per 100 resp.", "Due to null", "Implicit true", "Median words"],
        barColor: colors[0],
        rows: typeNames.map((name, t) => [
          h("span", { class: "lg" }, h("i", { class: "key rect", style: { background: colors[Math.min(t, 3)] } }), name),
          fmtInt(b[t].n), fmtNum((b[t].n / rows.length) * 100, 1),
          b[t].n ? { text: fmtPct(b[t].nul / b[t].n), bar: b[t].nul / b[t].n } : "–",
          b[t].n ? { text: fmtPct(b[t].imp / b[t].n), bar: b[t].imp / b[t].n } : "–",
          b[t].n ? fmtNum(median(b[t].words), 0) : "–",
        ]),
      })),
      note: "Due to null: the claim rests on a null or missing value in the source. Implicit true: the span is correct but not in the context.",
    });
  }

  function renderSplits(rows) {
    const nd = D.f.datasets.length, ns = D.f.splits.length;
    const n = Array.from({ length: nd }, () => new Float64Array(ns)), k = Array.from({ length: nd }, () => new Float64Array(ns));
    for (const r of rows) { n[D.ds[r]][D.split[r]]++; if (D.nsp[r]) k[D.ds[r]][D.split[r]]++; }
    const vis = D.f.datasets.map((_, d) => d).filter((d) => n[d].some((v) => v > 0));
    const head = ["Dataset", ...D.f.splits.flatMap((s) => [`${s} responses`, `${s} hallucinated`])];
    splits.set({
      draw: (box) => box.replaceChildren(barTable({
        head, barColor: cssVar("--t0"),
        rows: vis.map((d) => [`${D.f.datasets[d]} (${tasks[D.f.dataset_task[d]]})`,
          ...D.f.splits.flatMap((_, s) => [fmtInt(n[d][s]), n[d][s] ? { text: fmtPct(k[d][s] / n[d][s]), bar: k[d][s] / n[d][s] } : "–"])]),
      })),
      note: "Splits are as published in the corpus.",
    });
  }

  function renderQuality(rows) {
    const nq = D.f.qualities.length;
    const per = groupBy(rows, D.model, models.length);
    const cnt = per.map((rs) => { const c = new Float64Array(nq); rs.forEach((r) => c[D.quality[r]]++); return c; });
    const vis = models.map((_, m) => m).filter((m) => per[m].length);
    const flags = D.f.qualities.map((q, i) => ({ q, i })).filter(({ q }) => q !== "good");
    quality.set({
      draw: (box) => box.replaceChildren(barTable({
        head: ["Model", "Responses", ...flags.map(({ q }) => q.replace("_", " "))], barColor: cssVar("--t1"),
        rows: vis.map((m) => [models[m], fmtInt(per[m].length),
          ...flags.map(({ i }) => ({ text: `${fmtInt(cnt[m][i])} · ${fmtPct(cnt[m][i] / per[m].length)}`, bar: Math.min(1, (cnt[m][i] / per[m].length) * 10) }))]),
      })),
      note: "Bars are scaled ×10 so the rare cases are visible.",
    });
  }

  render();
  return { render };
}
