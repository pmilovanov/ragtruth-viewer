// The index (typed arrays), derived columns, global filter state, detail fetches.

export const D = { ready: false };
export const FACETS = ["task", "ds", "model", "split", "quality", "temp"]; // set-valued filters, by facet code

/** Filters are one shared object: the overview and the browser look through the same window. */
export const F = {
  task: new Set(), ds: new Set(), model: new Set(), split: new Set(), quality: new Set(),
  temp: new Set(), type: new Set(),
  hall: "any",          // any | yes | no
  q: "", scope: "response",
  implicit: true,       // count implicit_true spans as hallucinations?
};

const listeners = new Set();
export const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = () => listeners.forEach((fn) => fn());

// ------------------------------------------------------------ the worker
// The dataset is downloaded, parsed and searched in a Web Worker
// (corpus.worker.js); this side only ever holds the compact index.

let worker = null, nextCall = 0, onProgress = () => {};
const pending = new Map();

function startWorker() {
  worker = new Worker(new URL("./corpus.worker.js", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.progress) return onProgress(data.progress);
    const call = pending.get(data.id);
    if (!call) return;
    pending.delete(data.id);
    if (data.error) call.reject(new Error(data.error)); else call.resolve(data.result);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    const err = new Error(e.message || "the data worker failed to start");
    pending.forEach((call) => call.reject(err));
    pending.clear();
  };
}

function ask(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++nextCall;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}

/**
 * Download the dataset (in the worker) and take the columnar index.
 * progress(p) is called with {stage: "download", where, loaded, total} and {stage: "parse"}.
 * prefer: "local" | "upstream" to override where the data comes from.
 */
export async function loadIndex({ progress, prefer } = {}) {
  if (progress) onProgress = progress;
  if (!worker) startWorker();
  const ix = await ask("load", { prefer });
  const { facets: f, cols: c, spans: s } = ix;
  Object.assign(D, {
    n: ix.n, f, sourceIds: ix.source_ids,
    id: c.id,
    sx: Int32Array.from(c.sx),
    model: Uint8Array.from(c.model), task: Uint8Array.from(c.task), ds: Uint8Array.from(c.ds),
    split: Uint8Array.from(c.split), quality: Uint8Array.from(c.quality), temp: Uint8Array.from(c.temp),
    tempVal: Float64Array.from(c.temp, (k) => f.temps[k]),
    len: Int32Array.from(c.len), plen: Int32Array.from(c.plen),
    sp: {
      r: Int32Array.from(s.r), s: Int32Array.from(s.s), e: Int32Array.from(s.e),
      t: Uint8Array.from(s.t), n: Uint8Array.from(s.n), i: Uint8Array.from(s.i), w: Int32Array.from(s.w),
    },
  });
  D.rowOfId = new Map(D.id.map((id, i) => [id, i]));

  // CSR offsets: spans of row i are sp[off[i] .. off[i+1])  (spans arrive sorted by row)
  D.off = new Int32Array(D.n + 1);
  for (const r of D.sp.r) D.off[r + 1]++;
  for (let i = 0; i < D.n; i++) D.off[i + 1] += D.off[i];

  // Rows grouped by source, for sibling-aware charts.
  const groups = new Map();
  D.sx.forEach((x, i) => { (groups.get(x) || groups.set(x, []).get(x)).push(i); });
  D.groups = [...groups.values()];

  D.searchMask = null;
  derive();
  D.ready = true;
}

/** Per-row quantities that depend on whether implicit_true spans count. */
export function derive() {
  const { n, sp, off } = D;
  D.use = new Uint8Array(sp.r.length);
  D.nsp = new Uint16Array(n);
  D.hch = new Int32Array(n);
  D.tmask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let covered = 0, reach = -1;
    for (let k = off[i]; k < off[i + 1]; k++) {
      if (!F.implicit && sp.i[k]) continue;
      D.use[k] = 1;
      D.nsp[i]++;
      D.tmask[i] |= 1 << sp.t[k];
      const from = Math.max(sp.s[k], reach);        // spans are sorted by start
      if (sp.e[k] > from) covered += sp.e[k] - from;
      reach = Math.max(reach, sp.e[k]);
    }
    D.hch[i] = covered;
  }
}

export function setImplicit(on) {
  F.implicit = on;
  derive();
  emit();
}

// ------------------------------------------------------------ filtering

const maskOf = (set, size) => {
  if (!set.size) return null;
  const m = new Uint8Array(size);
  set.forEach((k) => { m[k] = 1; });
  return m;
};

/** Rows passing every filter, in file order. */
export function select() {
  const size = 16;
  const m = Object.fromEntries(FACETS.map((k) => [k, maskOf(F[k], size)]));
  const typeBits = [...F.type].reduce((b, t) => b | (1 << t), 0);
  const out = [];
  for (let i = 0; i < D.n; i++) {
    if (m.task && !m.task[D.task[i]]) continue;
    if (m.ds && !m.ds[D.ds[i]]) continue;
    if (m.model && !m.model[D.model[i]]) continue;
    if (m.split && !m.split[D.split[i]]) continue;
    if (m.quality && !m.quality[D.quality[i]]) continue;
    if (m.temp && !m.temp[D.temp[i]]) continue;
    if (typeBits && !(D.tmask[i] & typeBits)) continue;
    if (F.hall === "yes" && !D.nsp[i]) continue;
    if (F.hall === "no" && D.nsp[i]) continue;
    if (F.q && !(D.searchMask && D.searchMask[i])) continue;
    out.push(i);
  }
  return Int32Array.from(out);
}

export function activeFilterCount() {
  return FACETS.reduce((n, k) => n + F[k].size, 0) + F.type.size
    + (F.hall !== "any") + (F.q ? 1 : 0) + (F.implicit ? 0 : 1);
}

export function resetFilters() {
  FACETS.forEach((k) => F[k].clear());
  F.type.clear();
  F.hall = "any";
  F.q = "";
  F.scope = "response";
  D.searchMask = null;
  if (!F.implicit) { F.implicit = true; derive(); }
}

let searchSeq = 0;
/** Apply a text query (run in the worker); filters update once the answer is in. */
export async function applyQuery(q, scope) {
  const mine = ++searchSeq;
  q = q.trim();
  if (!q) {
    F.q = ""; F.scope = scope; D.searchMask = null;
    return emit();
  }
  const rows = await ask("search", { q, scope });
  if (mine !== searchSeq) return;                       // a newer keystroke overtook this one
  const mask = new Uint8Array(D.n);
  for (const r of rows) mask[r] = 1;
  F.q = q; F.scope = scope; D.searchMask = mask;
  emit();
}

// ------------------------------------------------------------ URL <-> filters

const facetNames = (k) => ({
  task: D.f.tasks, ds: D.f.datasets, model: D.f.models, split: D.f.splits,
  quality: D.f.qualities, temp: D.f.temps.map(String), type: D.f.types,
}[k]);

export function filtersToParams() {
  const p = new URLSearchParams();
  for (const k of [...FACETS, "type"]) {
    if (F[k].size) p.set(k, [...F[k]].sort((a, b) => a - b).map((c) => facetNames(k)[c]).join("|"));
  }
  if (F.hall !== "any") p.set("hall", F.hall);
  if (F.q) { p.set("q", F.q); p.set("in", F.scope); }
  if (!F.implicit) p.set("implicit", "0");
  return p;
}

/** Returns the search to apply afterwards, if the URL carried one. */
export function paramsToFilters(p) {
  FACETS.forEach((k) => F[k].clear());
  F.type.clear();
  for (const k of [...FACETS, "type"]) {
    const names = facetNames(k);
    (p.get(k) || "").split("|").filter(Boolean).forEach((nm) => {
      const code = names.indexOf(nm);
      if (code >= 0) F[k].add(code);
    });
  }
  F.hall = ["yes", "no"].includes(p.get("hall")) ? p.get("hall") : "any";
  const implicit = p.get("implicit") !== "0";
  if (implicit !== F.implicit) { F.implicit = implicit; derive(); }
  return { q: p.get("q") || "", scope: p.get("in") || "response" };
}

// ------------------------------------------------------------ records

const cache = new Map();
function cached(key, load) {
  if (cache.has(key)) return cache.get(key);
  const p = load().catch((e) => { cache.delete(key); throw e; });
  cache.set(key, p);
  if (cache.size > 400) cache.delete(cache.keys().next().value);
  return p;
}
export const getResponse = (id) => cached(`r/${id}`, () => ask("response", { id }));
export const getSource = (sid) => cached(`s/${sid}`, () => ask("source", { sid }));
/** {response, source}: the two rows exactly as the dataset files have them. */
export const getRecord = (id) => cached(`rec/${id}`, () => ask("record", { id }));

/** Row facts for a list entry, no network needed. */
export function rowInfo(i) {
  return {
    id: D.id[i], row: i,
    model: D.f.models[D.model[i]], task: D.f.tasks[D.task[i]], dataset: D.f.datasets[D.ds[i]],
    split: D.f.splits[D.split[i]], quality: D.f.qualities[D.quality[i]], temp: D.tempVal[i],
    len: D.len[i], nsp: D.nsp[i], hch: D.hch[i], share: D.len[i] ? D.hch[i] / D.len[i] : 0,
  };
}
