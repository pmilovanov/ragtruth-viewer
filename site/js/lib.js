// Pure helpers: no DOM, no fetch. Tested with `node --test` (see ../../tests).

/** Wilson score interval for k successes in n trials -> [lo, hi] in 0..1. */
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Cut text of length `len` at every span boundary.
 * spans: [{start, end}]. Returns contiguous segments covering [0, len), each
 * with `ids`: indices of the spans covering it, in the order given.
 */
export function segment(len, spans) {
  const cuts = new Set([0, len]);
  for (const { start, end } of spans) {
    cuts.add(Math.min(Math.max(start, 0), len));
    cuts.add(Math.min(Math.max(end, 0), len));
  }
  const edges = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    const [a, b] = [edges[k], edges[k + 1]];
    const ids = [];
    spans.forEach((sp, i) => { if (sp.start <= a && sp.end >= b) ids.push(i); });
    out.push({ start: a, end: b, ids });
  }
  return out;
}

/**
 * Bin edges at the quantiles of `values`, de-duplicated (heavy ties collapse
 * bins rather than producing empty ones). Returns ascending edges; k bins
 * need k+1 edges, fewer come back when ties force it.
 */
export function quantileEdges(values, k) {
  if (!values.length) return [];
  const v = Float64Array.from(values).sort();
  const edges = [];
  for (let i = 0; i <= k; i++) {
    const x = v[Math.min(v.length - 1, Math.floor((i / k) * (v.length - 1)))];
    if (!edges.length || x > edges[edges.length - 1]) edges.push(x);
  }
  return edges;
}

/** Index of the bin holding x: edges[i] <= x < edges[i+1]; the last bin is closed. */
export function binOf(edges, x) {
  const last = edges.length - 2;
  if (last < 0) return -1;
  let lo = 0, hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return Math.min(lo, last);
}

/**
 * Distribution of the number of successes among independent trials with
 * success probabilities `ps` (Poisson-binomial). -> array of length ps.length+1.
 */
export function poissonBinomial(ps) {
  let dist = [1];
  for (const p of ps) {
    const next = new Array(dist.length + 1).fill(0);
    dist.forEach((q, k) => { next[k] += q * (1 - p); next[k + 1] += q * p; });
    dist = next;
  }
  return dist;
}

/** "Nice" axis ticks from 0 to at least `max`. -> {ticks, top} */
export function niceTicks(max, target = 4) {
  if (!(max > 0)) return { ticks: [0, 1], top: 1 };
  const raw = max / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks = [];
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(+t.toPrecision(12));
  return { ticks, top };
}

export function median(values) {
  if (!values.length) return NaN;
  const v = Array.from(values).sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The quoted source text in an annotator's conflict note ("Original: ..."). */
export function parseOriginal(meta) {
  const m = /Original:\s*([^\n]+)/i.exec(meta || "");
  if (!m) return null;
  let s = m[1].split(/\s+Generated:/i)[0].trim();
  s = s.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  return s.length >= 4 ? s : null;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find `needle` in `text`, ignoring case and whitespace differences, and
 * tolerating trailing punctuation the annotator may have added.
 * -> {start, end} or null.
 */
export function findLoose(text, needle) {
  if (!needle) return null;
  const tries = [needle.trim(), needle.trim().replace(/[\s.,;:!?)"'”]+$/, "")];
  for (const t of tries) {
    if (t.length < 4) continue;
    const re = new RegExp(escapeRegExp(t).replace(/\s+/g, "\\s+"), "i");
    const m = re.exec(text);
    if (m) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** Lower-case a quote with JSON punctuation and trailing commas stripped, for key/value comparison. */
export const normQuote = (s) =>
  String(s).toLowerCase().replace(/["'{}]/g, "").replace(/\s+/g, " ").replace(/[,\s]+$/, "").trim();

/**
 * Does an annotator's quote (e.g. `"intimate": null,`) name this key/value pair
 * of structured source data? Data2txt notes mostly quote the serialised JSON.
 */
export function kvQuoted(needle, key, value) {
  const frag = normQuote(`${key}: ${value == null ? "null" : value}`);
  const n = normQuote(needle);
  return frag.length >= 5 && (n === frag || n.includes(frag));
}

export const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
export const fmtPct = (x, digits = 1) => (x * 100).toFixed(digits) + "%";
export const fmtNum = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : "–");
