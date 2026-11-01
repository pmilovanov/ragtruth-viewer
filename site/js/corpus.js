// The dataset in memory: the columnar index the charts run on, single-record
// views, and text search. No DOM and no fetch: the worker hands it text, and
// node:test drives it directly.
//
// The corpus is two JSONL files (https://github.com/ParticleMedia/RAGTruth):
//   response.jsonl      one row per LLM response, with hallucination `labels`
//   source_info.jsonl   one row per source (six responses share each source)

export const LABEL_TYPES = ["Evident Baseless Info", "Evident Conflict", "Subtle Baseless Info", "Subtle Conflict"];
export const MODELS = [
  "gpt-4-0613", "gpt-3.5-turbo-0613", "llama-2-70b-chat", "llama-2-13b-chat", "llama-2-7b-chat", "mistral-7B-instruct",
];
export const TASKS = ["QA", "Data2txt", "Summary"];
export const DATASETS = ["MARCO", "Yelp", "CNN/DM", "Recent News"];
export const QUALITIES = ["good", "incorrect_refusal", "truncated"];
export const SPLITS = ["train", "test"];
export const SEARCH_SCOPES = ["response", "spans", "notes", "source"];

const byString = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);

/** Preferred display order first; anything unforeseen after it, sorted, so a newer corpus still loads. */
function ordered(values, preferred) {
  const seen = new Set(values);
  const head = preferred.filter((v) => seen.has(v));
  return [...head, ...[...seen].filter((v) => !head.includes(v)).sort(byString)];
}

export function parseJSONL(text) {
  const rows = [];
  for (const line of text.split("\n")) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
}

/**
 * Upstream span offsets count code points (the corpus was built in Python);
 * JS strings are indexed in UTF-16 units. Where a response contains a
 * character outside the Basic Multilingual Plane the two disagree, so convert,
 * or every highlight after it would drift. Returns null when nothing to do.
 */
function codePointToUtf16(text) {
  if (!/[\uD800-\uDFFF]/.test(text)) return null;
  const at = [];
  let unit = 0;
  for (const ch of text) { at.push(unit); unit += ch.length; }
  at.push(unit);
  return (cp) => at[Math.min(Math.max(cp, 0), at.length - 1)];
}

/** Whitespace-separated words, as str.split() counts them. */
export const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/** 'passage 1:foo\n\npassage 2:bar' -> [{n:1,text:'foo'},{n:2,text:'bar'}] */
export function splitPassages(text) {
  const marks = [...text.matchAll(/passage (\d+):/g)];
  if (!marks.length) return [{ n: 1, text: text.trim() }];
  return marks.map((m, k) => ({
    n: Number(m[1]),
    text: text.slice(m.index + m[0].length, k + 1 < marks.length ? marks[k + 1].index : text.length).trim(),
  }));
}

const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A source row normalised into something the page can render. */
export function sourceView(src) {
  const info = src.source_info;
  const view = { source_id: src.source_id, task: src.task_type, dataset: src.source, prompt: src.prompt };
  if (src.task_type === "Summary" && typeof info === "string") return { ...view, kind: "summary", text: info };
  if (src.task_type === "QA" && isRecord(info)) {
    return { ...view, kind: "qa", question: info.question ?? "", passages: splitPassages(info.passages ?? "") };
  }
  if (src.task_type === "Data2txt" && isRecord(info)) return { ...view, kind: "data2txt", data: info };
  return { ...view, kind: "raw", data: info };
}

/** A source flattened to searchable text (structured sources keep their keys). */
export const sourceText = (src) => (typeof src.source_info === "string" ? src.source_info : JSON.stringify(src.source_info));

/** Whitespace-separated terms, all required; "quoted phrases" stay whole. */
export function terms(q) {
  const out = [];
  for (const m of q.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2]).trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

export class Corpus {
  /** responses / sources: the parsed rows of the two files. */
  constructor(responses, sources) {
    this.sources = new Map(sources.map((s) => [s.source_id, s]));
    this.responses = responses;
    this.rowOf = new Map();
    this.rowsOfSource = new Map();
    this.rawLabels = [];   // labels as upstream has them (order and code-point offsets), for record()
    responses.forEach((r, i) => {
      if (!this.sources.has(r.source_id)) throw new Error(`response ${r.id} refers to unknown source ${r.source_id}`);
      const toUtf16 = codePointToUtf16(r.response);
      const raw = r.labels || [];
      this.rawLabels.push(raw);
      // Spans in reading order make every consumer simpler. (map() leaves `raw` untouched.)
      r.labels = raw
        .map((l) => (toUtf16 ? { ...l, start: toUtf16(l.start), end: toUtf16(l.end) } : l))
        .sort((a, b) => a.start - b.start || a.end - b.end);
      this.rowOf.set(r.id, i);
      if (!this.rowsOfSource.has(r.source_id)) this.rowsOfSource.set(r.source_id, []);
      this.rowsOfSource.get(r.source_id).push(i);
    });
    this.lowered = {};
  }

  static fromJSONL(responsesText, sourcesText) {
    return new Corpus(parseJSONL(responsesText), parseJSONL(sourcesText));
  }

  // ---- columnar index ----------------------------------------------------

  /**
   * Everything the aggregate views need, minus the bulky text: one array per
   * field, aligned by row; spans flattened into parallel arrays sorted by
   * (row, start).
   */
  index() {
    const rs = this.responses;
    const src = (r) => this.sources.get(r.source_id);
    const models = ordered(rs.map((r) => r.model), MODELS);
    const tasks = ordered(rs.map((r) => src(r).task_type), TASKS);
    const datasets = ordered(rs.map((r) => src(r).source), DATASETS);
    const splits = ordered(rs.map((r) => r.split), SPLITS);
    const qualities = ordered(rs.map((r) => r.quality), QUALITIES);
    const temps = [...new Set(rs.map((r) => r.temperature))].sort((a, b) => a - b);
    const types = ordered(rs.flatMap((r) => r.labels.map((l) => l.label_type)), LABEL_TYPES);
    const sourceIds = [...this.sources.keys()];
    const pos = (list) => new Map(list.map((v, k) => [v, k]));
    const P = {
      model: pos(models), task: pos(tasks), ds: pos(datasets), split: pos(splits),
      quality: pos(qualities), temp: pos(temps), type: pos(types), sx: pos(sourceIds),
    };
    const dsTask = new Map();
    for (const s of this.sources.values()) if (!dsTask.has(s.source)) dsTask.set(s.source, P.task.get(s.task_type));

    const cols = { id: [], sx: [], model: [], temp: [], split: [], quality: [], task: [], ds: [], len: [], plen: [] };
    const sp = { r: [], s: [], e: [], t: [], n: [], i: [], w: [] };
    rs.forEach((r, row) => {
      const s = src(r);
      cols.id.push(r.id);
      cols.sx.push(P.sx.get(r.source_id));
      cols.model.push(P.model.get(r.model));
      cols.temp.push(P.temp.get(r.temperature));
      cols.split.push(P.split.get(r.split));
      cols.quality.push(P.quality.get(r.quality));
      cols.task.push(P.task.get(s.task_type));
      cols.ds.push(P.ds.get(s.source));
      cols.len.push(r.response.length);
      cols.plen.push(s.prompt.length);
      for (const l of r.labels) {
        sp.r.push(row);
        sp.s.push(l.start);
        sp.e.push(l.end);
        sp.t.push(P.type.get(l.label_type));
        sp.n.push(l.due_to_null ? 1 : 0);
        sp.i.push(l.implicit_true ? 1 : 0);
        sp.w.push(wordCount(l.text));
      }
    });
    return {
      version: 1,
      n: rs.length,
      facets: {
        models, tasks, datasets, dataset_task: datasets.map((d) => dsTask.get(d)),
        splits, qualities, temps, types,
      },
      source_ids: sourceIds,
      cols,
      spans: sp,
    };
  }

  // ---- single records ----------------------------------------------------

  view(i) {
    const r = this.responses[i];
    return {
      id: r.id, row: i, source_id: r.source_id, model: r.model, temperature: r.temperature,
      split: r.split, quality: r.quality, response: r.response,
      labels: r.labels.map((l) => ({
        start: l.start, end: l.end, text: l.text, type: l.label_type, meta: l.meta || "",
        due_to_null: Boolean(l.due_to_null), implicit_true: Boolean(l.implicit_true),
      })),
    };
  }

  /** One response, its source and its siblings. Throws on an unknown id. */
  responseDetail(id) {
    const i = this.rowOf.get(String(id));
    if (i === undefined) throw new Error(`no response ${JSON.stringify(id)}`);
    const r = this.responses[i];
    return {
      ...this.view(i),
      source: sourceView(this.sources.get(r.source_id)),
      siblings: this.rowsOfSource.get(r.source_id).map((j) => ({
        id: this.responses[j].id, row: j, model: this.responses[j].model, n_spans: this.responses[j].labels.length,
      })),
    };
  }

  /**
   * The response and its source as parsed from the two files: upstream field
   * names, label order and (code-point) offsets, nothing added.
   */
  record(id) {
    const i = this.rowOf.get(String(id));
    if (i === undefined) throw new Error(`no response ${JSON.stringify(id)}`);
    const r = this.responses[i];
    return { response: { ...r, labels: this.rawLabels[i] }, source: this.sources.get(r.source_id) };
  }

  /** A source with all of its responses, for side-by-side comparison. */
  sourceDetail(sid) {
    const s = this.sources.get(String(sid));
    if (!s) throw new Error(`no source ${JSON.stringify(sid)}`);
    return { ...sourceView(s), responses: (this.rowsOfSource.get(s.source_id) || []).map((j) => this.view(j)) };
  }

  // ---- search ------------------------------------------------------------

  haystack(scope) {
    if (!this.lowered[scope]) {
      const rs = this.responses;
      if (scope === "source") {
        // Lowered once per source; the six siblings share one string.
        const per = new Map([...this.sources].map(([sid, s]) => [sid, sourceText(s).toLowerCase()]));
        this.lowered[scope] = rs.map((r) => per.get(r.source_id));
      } else if (scope === "response") {
        this.lowered[scope] = rs.map((r) => r.response.toLowerCase());
      } else if (scope === "spans") {
        this.lowered[scope] = rs.map((r) => r.labels.map((l) => l.text).join("\n").toLowerCase());
      } else if (scope === "notes") {
        this.lowered[scope] = rs.map((r) => r.labels.map((l) => l.meta || "").join("\n").toLowerCase());
      } else {
        throw new Error(`unknown scope ${JSON.stringify(scope)}`);
      }
    }
    return this.lowered[scope];
  }

  /** Row indices whose `scope` text contains every term of `q`. */
  search(q, scope = "response") {
    if (!SEARCH_SCOPES.includes(scope)) throw new Error(`unknown scope ${JSON.stringify(scope)}`);
    const ts = terms(q);
    if (!ts.length) return [];
    const out = [];
    this.haystack(scope).forEach((h, i) => { if (ts.every((t) => h.includes(t))) out.push(i); });
    return out;
  }
}
