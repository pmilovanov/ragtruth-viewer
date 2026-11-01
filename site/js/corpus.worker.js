// The dataset lives here, off the main thread, so downloading and parsing
// ~35 MB never freezes the page. The page asks once for the index, then for
// single records and searches.
//
// Protocol: {id, op, args} in; {id, result} or {id, error} out, plus
// {progress} messages while loading.

import { Corpus } from "./corpus.js";
import { UPSTREAM_BASE, FILES, SIZES } from "./config.js";

const LOCAL_BASE = new URL("../data/", import.meta.url).href;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

let corpus = null;

async function fetchText(url, onBytes) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
  if (!resp.body) {
    const text = await resp.text();
    onBytes(text.length);
    return text;
  }
  const reader = resp.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
    onBytes(value.byteLength);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return new TextDecoder().decode(all);
}

/** Both files from one place, reporting progress as a share of their known size. */
async function download(base, where) {
  const names = [FILES.responses, FILES.sources];
  const total = names.reduce((n, f) => n + SIZES[f], 0);
  let loaded = 0, shown = -1;
  const onBytes = (n) => {
    loaded += n;
    const pct = Math.floor((100 * loaded) / total);
    if (pct !== shown) { shown = pct; self.postMessage({ progress: { stage: "download", where, loaded, total } }); }
  };
  const [responses, sources] = await Promise.all(names.map((f) => fetchText(base + f, onBytes)));
  return { responses, sources };
}

async function load({ prefer } = {}) {
  // A local copy (site/data/, see `just fetch-data`) is tried first when the page
  // is served from this machine, or when asked with ?data=local.
  const tryLocal = prefer === "local" || (prefer !== "upstream" && LOCAL_HOSTS.includes(self.location.hostname));
  let texts = null;
  if (tryLocal) {
    try { texts = await download(LOCAL_BASE, "local"); } catch { /* no local copy: use upstream */ }
  }
  if (!texts) texts = await download(UPSTREAM_BASE, "github");
  self.postMessage({ progress: { stage: "parse" } });
  corpus = Corpus.fromJSONL(texts.responses, texts.sources);
  return corpus.index();
}

self.onmessage = async ({ data: { id, op, args = {} } }) => {
  try {
    let result;
    if (op === "load") result = await load(args);
    else if (!corpus) throw new Error("the dataset is not loaded yet");
    else if (op === "response") result = corpus.responseDetail(args.id);
    else if (op === "source") result = corpus.sourceDetail(args.sid);
    else if (op === "record") result = corpus.record(args.id);
    else if (op === "search") result = corpus.search(args.q, args.scope);
    else throw new Error(`unknown operation ${op}`);
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
