// One response (or one source's six responses) in full: highlighted text, the
// annotators' notes, and the source it was generated from.

import { D, F, getResponse, getSource, getRecord } from "./data.js";
import { h, bindTip } from "./ui.js";
import { segment, parseOriginal, findLoose, kvQuoted, jsonTokens, fmtInt, fmtPct } from "./lib.js";

const tIdx = (name) => Math.min(3, Math.max(0, D.f.types.indexOf(name)));
const isCounted = (l) => F.implicit || !l.implicit_true;
const byModel = (a, b) => D.f.models.indexOf(a.model) - D.f.models.indexOf(b.model);
const firstLine = (meta) => (meta || "").split("\n")[0].trim();

/** Where the annotated spans of a row sit along its response: a tiny map. */
export function strip(row) {
  const len = D.len[row] || 1;
  const el = h("div", { class: "strip", "aria-hidden": "true" });
  for (let k = D.off[row]; k < D.off[row + 1]; k++) {
    if (!D.use[k]) continue;
    el.append(h("i", {
      class: `ty${Math.min(D.sp.t[k], 3)}`,
      style: { left: `${(D.sp.s[k] / len) * 100}%`, width: `max(3px, ${((D.sp.e[k] - D.sp.s[k]) / len) * 100}%)` },
    }));
  }
  return el;
}

// ------------------------------------------------------------- response text

/**
 * The response with each annotated span highlighted. Overlapping spans are cut
 * at every boundary; where two overlap, the segment carries both colours.
 * Returns {node, marks: Map(spanIndex -> [mark elements])}.
 */
function responseText(d, { numbered = true, onPick } = {}) {
  const spans = d.labels;
  const marks = spans.map(() => []);
  const frag = document.createDocumentFragment();
  for (const seg of segment(d.response.length, spans)) {
    const text = d.response.slice(seg.start, seg.end);
    if (!seg.ids.length) { frag.append(text); continue; }
    const [a, b] = seg.ids;
    const m = h("mark", {
      class: "hl" + (b != null ? " two" : "") + (seg.ids.every((i) => !isCounted(spans[i])) ? " uncounted" : ""),
      style: { "--c1": `var(--t${tIdx(spans[a].type)})`, "--c2": b != null ? `var(--t${tIdx(spans[b].type)})` : null },
      dataset: { ids: seg.ids.join(",") },
    }, text);
    seg.ids.forEach((i) => marks[i].push(m));
    bindTip(m, () => ({
      title: seg.ids.length > 1 ? `${seg.ids.length} overlapping spans` : undefined,
      rows: seg.ids.map((i) => ({
        color: `var(--t${tIdx(spans[i].type)})`, value: `${i + 1}. ${spans[i].type}`,
        label: [spans[i].due_to_null && "due to null", spans[i].implicit_true && "implicit true", !isCounted(spans[i]) && "not counted"]
          .filter(Boolean).join(" · ") || firstLine(spans[i].meta).toLowerCase(),
      })),
    }));
    if (onPick) m.addEventListener("click", () => onPick(seg.ids, m));
    frag.append(m);
    if (numbered) {
      seg.ids.filter((i) => spans[i].end === seg.end).forEach((i) =>
        frag.append(h("sup", { class: "ann-no" + (onPick ? " click" : ""), onclick: onPick ? () => onPick([i]) : null }, String(i + 1))));
    }
  }
  const node = h("div", { class: "resp-text", tabindex: 0 });
  node.append(frag);
  return { node, marks };
}

// ------------------------------------------------------------------- source

/** Flatten a source to the text an annotator might have quoted. */
function flatten(v, out = []) {
  if (v == null) return out;
  if (typeof v === "object") Object.values(v).forEach((x) => flatten(x, out));
  else out.push(String(v));
  return out;
}
function sourceText(src) {
  if (src.kind === "summary") return src.text;
  if (src.kind === "qa") return [src.question, ...src.passages.map((p) => p.text)].join("\n");
  return flatten(src.data).join("\n");
}

/** A string with the first occurrence of ctx.needle marked, as DOM-ready pieces. */
function marked(text, ctx) {
  const hit = ctx.needle ? findLoose(String(text), ctx.needle) : null;
  if (!hit) return [String(text)];
  const mk = h("mark", { class: "ev" }, String(text).slice(hit.start, hit.end));
  ctx.first = ctx.first || mk;
  return [String(text).slice(0, hit.start), mk, String(text).slice(hit.end)];
}

const isLeaf = (v) => v == null || typeof v !== "object";
const anyKv = (obj, needle) => Object.entries(obj).some(([k, v]) => (isLeaf(v) ? kvQuoted(needle, k, v) : anyKv(v, needle)));

/** Where an annotator's quote can be found in the source: running text, or a key/value row. */
function locates(src, flat, needle) {
  return !!(findLoose(flat, needle) || (src.kind === "data2txt" && anyKv(src.data, needle)));
}

function kv(obj, ctx) {
  return h("dl", { class: "kv" }, Object.entries(obj).flatMap(([k, v]) => {
    const hit = ctx.needle && isLeaf(v) && kvQuoted(ctx.needle, k, v);
    const cls = hit ? "ev" : null;
    const dt = h("dt", { class: cls }, k);
    if (hit) ctx.first = ctx.first || dt;
    return [dt, h("dd", { class: cls }, isLeaf(v) ? (v == null ? h("span", { class: "null" }, "null") : marked(v, ctx)) : kv(v, ctx))];
  }));
}

function businessEl(data, ctx) {
  const known = ["name", "address", "city", "state", "categories", "hours", "attributes", "business_stars", "review_info"];
  const extra = Object.fromEntries(Object.entries(data).filter(([k]) => !known.includes(k)));
  return h("div", { class: "biz" },
    h("h4", {}, marked(data.name ?? "", ctx)),
    h("p", { class: "biz-addr" }, marked([data.address, data.city, data.state].filter(Boolean).join(", "), ctx),
      data.business_stars != null && h("span", { class: "stars" }, ` · ${data.business_stars}★ overall`)),
    data.categories && h("p", { class: "biz-cats" }, marked(data.categories, ctx)),
    data.hours && h("section", {}, h("h5", {}, "Hours"), kv(data.hours, ctx)),
    data.attributes && h("section", {}, h("h5", {}, "Attributes"), kv(data.attributes, ctx)),
    Object.keys(extra).length > 0 && h("section", {}, h("h5", {}, "Other"), kv(extra, ctx)),
    h("section", {}, h("h5", {}, `Reviews (${(data.review_info || []).length})`),
      (data.review_info || []).map((r) => h("article", { class: "review" },
        h("div", { class: "rv-head" }, `${r.review_stars}★`, h("span", {}, r.review_date)),
        h("p", {}, marked(r.review_text ?? "", ctx))))));
}

function sourceBody(src, tab, ctx) {
  if (tab === "prompt") return h("pre", { class: "prompt" }, marked(src.prompt, ctx));
  if (src.kind === "summary") return h("div", { class: "doc" }, marked(src.text, ctx));
  if (src.kind === "qa") {
    return h("div", {},
      h("p", { class: "question" }, h("small", {}, "Question"), marked(src.question, ctx)),
      src.passages.map((p) => h("section", { class: "passage" }, h("h5", {}, `Passage ${p.n}`), h("p", {}, marked(p.text, ctx)))));
  }
  if (src.kind === "data2txt") return businessEl(src.data, ctx);
  return h("pre", { class: "prompt" }, JSON.stringify(src.data, null, 2));
}

/** The source panel; `setNeedle` re-marks the evidence without losing the reader's place. */
function sourcePanel(src) {
  let tab = "source", needle = null;
  const body = h("div", { class: "src-body" });
  const tabs = ["source", "prompt"].map((t) => h("button", {
    class: "tab", type: "button", role: "tab", onclick: () => { tab = t; paint(true); },
  }, t === "source" ? "Source" : "Prompt"));
  const badge = h("span", { class: "ev-status" });
  const el = h("section", { class: "d-src" },
    h("header", { class: "src-head", role: "tablist" }, ...tabs, badge,
      h("span", { class: "src-meta" }, `${src.dataset} · source ${src.source_id}`)),
    body);

  function paint(resetScroll) {
    const keep = body.scrollTop;
    const ctx = { needle, first: null };
    body.replaceChildren(sourceBody(src, tab, ctx));
    tabs.forEach((t, i) => t.setAttribute("aria-selected", String((i === 0) === (tab === "source"))));
    badge.textContent = needle ? (ctx.first ? "evidence highlighted" : "quote not found here") : "";
    body.scrollTop = resetScroll ? 0 : keep;
    if (ctx.first) body.scrollTop = Math.max(0, ctx.first.offsetTop - body.clientHeight / 3);
  }
  paint(true);
  return { el, setNeedle(n) { needle = n; paint(false); } };
}

// ---------------------------------------------------------------- annotations

const chip = (type) => h("span", { class: `chip ty${tIdx(type)}` }, type);

function annotationList(d, srcFlat, onPick) {
  const src = d.source;
  const items = d.labels.map((l, i) => {
    const original = parseOriginal(l.meta);
    const located = original && locates(src, srcFlat, original);
    const el = h("li", { class: "ann-item" + (isCounted(l) ? "" : " uncounted"), tabindex: 0, dataset: { i } },
      h("div", { class: "ann-top" },
        h("span", { class: "num" }, String(i + 1)), chip(l.type),
        l.due_to_null && h("span", { class: "flag" }, "due to null"),
        l.implicit_true && h("span", { class: "flag" }, "implicit true"),
        !isCounted(l) && h("span", { class: "flag muted" }, "not counted")),
      h("blockquote", {}, l.text),
      l.meta && h("div", { class: "meta" }, l.meta),
      original && h("div", { class: "ev-line" + (located ? " found" : "") },
        located ? "Quoted source text found: shown in the source panel when selected" : "Quoted source text not found verbatim in the source"));
    el.addEventListener("click", () => onPick(i));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(i); } });
    return el;
  });
  return h("ol", { class: "anns" }, items);
}

// ------------------------------------------------------------------ the view

function chips(d, src) {
  return [
    h("span", { class: "chip plain strong" }, d.model),
    h("span", { class: "chip plain" }, `${src.task} · ${src.dataset}`),
    h("span", { class: "chip plain" }, `T ${d.temperature}`),
    h("span", { class: "chip plain" }, d.split),
    d.quality !== "good" && h("span", { class: "chip warn" }, h("b", { "aria-hidden": "true" }, "!"), d.quality.replace("_", " ")),
  ];
}

function summaryLine(row) {
  const n = D.nsp[row];
  if (!n) {
    return h("p", { class: "d-sum ok" }, h("b", { class: "ok-icon", "aria-hidden": "true" }, "✓"),
      "No hallucination annotated");
  }
  return h("p", { class: "d-sum" }, `${n} ${n === 1 ? "span" : "spans"} · ${fmtPct(D.hch[row] / D.len[row])} of the text`);
}

// ------------------------------------------------------------------- JSON

const pretty = (v) => JSON.stringify(v, null, 2);

function flash(btn, text, back) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = back; }, 1400);
}

async function copyText(btn, text, back) {
  try { await navigator.clipboard.writeText(text); flash(btn, "Copied", back); }
  catch { flash(btn, "Copy failed", back); }
}

/**
 * Pretty-printed JSON as coloured text nodes (never innerHTML), one block per
 * line so that a long string wraps under its own key, not back at the margin.
 */
function jsonBlock(value) {
  const frag = document.createDocumentFragment();
  let line;
  const newLine = () => frag.append(line = h("span", { class: "jl" }));
  newLine();
  for (const { kind, text } of jsonTokens(pretty(value))) {
    if (kind) { line.append(h("span", { class: `j-${kind}` }, text)); continue; }
    text.split("\n").forEach((part, k) => {        // strings never hold a raw newline, so only this kind does
      if (k) newLine();
      if (!line.firstChild) line.style.setProperty("--in", `${part.length - part.trimStart().length}ch`);
      if (part) line.append(part);
    });
  }
  return frag;
}

/** A modal showing a response's row from response.jsonl and its source's row from source_info.jsonl. */
function showRecord(rec) {
  if (document.querySelector("dialog.json-dialog")) return;     // already open (say, v pressed twice while loading)
  const tabsSpec = [
    { name: "response.jsonl", value: rec.response,
      note: `Response ${rec.response.id}, as recorded in response.jsonl. Span offsets count Unicode code points.` },
    { name: "source_info.jsonl", value: rec.source,
      note: `Its source, ${rec.source.source_id}, as recorded in source_info.jsonl.` },
  ];
  let cur = 0;
  const pre = h("pre", { class: "json", tabindex: 0 });
  const note = h("p", { class: "json-note" });
  const tabs = tabsSpec.map((t, i) => h("button", { class: "tab", type: "button", role: "tab", onclick: () => show(i) }, t.name));
  const copyBtn = h("button", { class: "btn small", type: "button", onclick: () => copyText(copyBtn, pretty(tabsSpec[cur].value), "Copy") }, "Copy");
  const dlg = h("dialog", { class: "json-dialog", "aria-label": `JSON for response ${rec.response.id}` },
    h("header", { class: "json-head" },
      h("div", { class: "json-tabs", role: "tablist" }, ...tabs),
      h("div", { class: "json-actions" },
        copyBtn,
        h("button", { class: "btn small", type: "button", onclick: () => dlg.close() }, "Close"))),
    note, pre);

  function show(i) {
    cur = i;
    tabs.forEach((t, k) => t.setAttribute("aria-selected", String(k === i)));
    note.textContent = tabsSpec[i].note;
    pre.replaceChildren(jsonBlock(tabsSpec[i].value));
    pre.scrollTop = 0;
  }
  dlg.addEventListener("close", () => dlg.remove());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // a click on the backdrop
  document.body.append(dlg);
  show(0);
  dlg.showModal();
}

export function mountDetail(root, { navigate }) {
  let token = 0, last = null;

  async function show(id, compare = false) {
    last = { id, compare };
    const mine = ++token;
    root.classList.add("loading");
    try {
      const d = await getResponse(id);
      const src = compare ? await getSource(d.source_id) : null;
      if (mine !== token) return;
      root.replaceChildren(compare ? compareView(d, src) : singleView(d));
      root.scrollTop = 0;
    } catch (e) {
      if (mine === token) root.replaceChildren(h("div", { class: "empty" }, `Could not load response ${id}: ${e.message}`));
    } finally {
      if (mine === token) root.classList.remove("loading");
    }
  }

  const clear = (message) => { token++; last = null; root.replaceChildren(h("div", { class: "empty" }, message)); };

  function siblingNav(d) {
    const sibs = d.siblings.slice().sort(byModel);
    const at = sibs.findIndex((s) => s.id === d.id);
    const go = (s, compare) => s && navigate(s.id, compare);
    return { sibs, prev: sibs[at - 1], next: sibs[at + 1], go };
  }

  function singleView(d) {
    const { sibs, prev, next } = siblingNav(d);
    const src = sourcePanel(d.source);
    let selected = -1;
    const text = responseText(d, { onPick: (ids) => pick(ids.includes(selected) ? ids[(ids.indexOf(selected) + 1) % ids.length] : ids[0]) });
    const flat = sourceText(d.source);
    const anns = annotationList(d, flat, (i) => pick(i));

    function pick(i) {
      selected = selected === i ? -1 : i;
      text.marks.forEach((ms, k) => ms.forEach((m) => m.classList.toggle("sel", k === selected)));
      [...anns.children].forEach((li, k) => li.classList.toggle("sel", k === selected));
      if (selected >= 0) {
        text.marks[selected][0]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        anns.children[selected].scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      src.setNeedle(selected >= 0 ? parseOriginal(d.labels[selected].meta) : null);
    }

    // The record as the dataset has it; fetched now so a click can copy it at once.
    let recordText = null;
    const record = getRecord(d.id);
    record.then((rec) => { recordText = pretty(rec.response); }).catch(() => {});
    const copy = h("button", {
      class: "btn small", type: "button", title: "Copy this response's record from response.jsonl",
      onclick: async () => copyText(copy, recordText ?? pretty((await record).response), "Copy JSON"),
    }, "Copy JSON");
    const viewJson = h("button", {
      class: "btn small", type: "button", dataset: { action: "view-json" },
      title: "This response's record, and its source's, as in the dataset files (v)",
      onclick: async () => showRecord(await record),
    }, "View JSON");

    const view = h("div", { class: "detail" },
      h("header", { class: "d-head" },
        h("div", { class: "d-title" }, h("h2", {}, `#${d.id}`), ...chips(d, d.source)),
        h("div", { class: "d-actions" },
          h("button", { class: "btn small", type: "button", disabled: !prev, title: "Previous model (←)", onclick: () => siblingNav(d).go(prev) }, "←"),
          h("button", { class: "btn small", type: "button", disabled: !next, title: "Next model (→)", onclick: () => siblingNav(d).go(next) }, "→"),
          h("button", { class: "btn small", type: "button", title: "All six responses side by side (c)", onclick: () => navigate(d.id, true) }, "Compare models"),
          viewJson, copy)),
      h("nav", { class: "sibs", "aria-label": "Responses to the same source" },
        h("span", { class: "sibs-label" }, "Same source"),
        sibs.map((s) => h("button", {
          class: "sib" + (s.id === d.id ? " cur" : ""), type: "button", "aria-current": s.id === d.id ? "true" : null,
          onclick: () => navigate(s.id),
        }, h("span", { class: "sib-model" }, s.model), strip(s.row), h("span", { class: "sib-n" }, String(D.nsp[s.row]))))),
      h("div", { class: "d-cols" },
        h("section", { class: "d-resp" },
          summaryLine(d.row), strip(d.row), text.node,
          d.labels.length > 0 && h("h4", { class: "anns-h" }, "Annotations"), anns),
        src.el));
    return view;
  }

  function compareView(d, src) {
    const rs = src.responses.slice().sort(byModel);
    const panel = sourcePanel(src);
    const open = h("details", { class: "cmp-src" }, h("summary", {}, "Source"), panel.el);
    const cards = rs.map((r) => {
      const t = responseText(r, { numbered: true });
      return h("article", { class: "cmp-card" + (r.id === d.id ? " cur" : "") },
        h("header", {},
          h("h4", {}, r.model, h("small", {}, ` T ${r.temperature}`)),
          h("button", { class: "btn small", type: "button", onclick: () => navigate(r.id) }, "Open")),
        summaryLine(r.row), strip(r.row), t.node,
        r.labels.length > 0 && h("ul", { class: "mini-anns" }, r.labels.map((l, i) =>
          h("li", { class: isCounted(l) ? "" : "uncounted" }, h("span", { class: "num" }, String(i + 1)), chip(l.type), h("q", {}, l.text)))));
    });
    return h("div", { class: "detail" },
      h("header", { class: "d-head" },
        h("div", { class: "d-title" }, h("h2", {}, `Source ${src.source_id}`),
          h("span", { class: "chip plain" }, `${src.task} · ${src.dataset}`),
          h("span", { class: "chip plain" }, `${fmtInt(rs.filter((r) => D.nsp[r.row]).length)} of ${rs.length} hallucinate`)),
        h("div", { class: "d-actions" },
          h("button", { class: "btn small", type: "button", onclick: () => navigate(d.id) }, "Back to #" + d.id))),
      open, h("div", { class: "cmp-grid" }, cards));
  }

  return {
    show, clear,
    refresh: () => last && show(last.id, last.compare),
  };
}
