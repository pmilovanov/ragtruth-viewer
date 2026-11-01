// Checks against the real dataset. They run when site/data/ holds it
// (`just fetch-data`; CI always fetches it) and are skipped otherwise.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { Corpus, sourceView } from "../site/js/corpus.js";
import { FILES, SIZES } from "../site/js/config.js";

const dir = new URL("../site/data/", import.meta.url);
const present = Object.values(FILES).every((f) => existsSync(new URL(f, dir)));
const skip = present ? false : "dataset not in site/data/ (run `just fetch-data`)";

let cached = null;
const corpus = () => (cached ||= Corpus.fromJSONL(
  readFileSync(new URL(FILES.responses, dir), "utf8"), readFileSync(new URL(FILES.sources, dir), "utf8")));

test("the files are the pinned ones, so the loading progress bar is honest", { skip }, () => {
  for (const f of Object.values(FILES)) assert.equal(statSync(new URL(f, dir)).size, SIZES[f], f);
});

test("every span slices exactly its text out of its response", { skip }, () => {
  for (const r of corpus().responses) {
    for (const l of r.labels) assert.equal(r.response.slice(l.start, l.end), l.text, `response ${r.id}`);
  }
});

test("every source has six responses, and every QA source parses into passages", { skip }, () => {
  const c = corpus();
  for (const rows of c.rowsOfSource.values()) assert.equal(rows.length, 6);
  for (const s of c.sources.values()) if (s.task_type === "QA") assert.ok(sourceView(s).passages.length >= 1);
});

test("totals match the statistics table published in the upstream README", { skip }, () => {
  // https://github.com/ParticleMedia/RAGTruth#data-statistics : (instances, responses,
  // responses with a hallucination, hallucination spans). Reproducing it pins down that
  // every labelled span, implicit_true included, counts by default.
  const c = corpus(), got = new Map();
  for (const r of c.responses) {
    const s = c.sources.get(r.source_id);
    const keys = ["all", `task ${s.task_type}${s.task_type === "Summary" ? ` ${s.source}` : ""}`, `model ${r.model}`];
    for (const k of keys) {
      const row = got.get(k) || got.set(k, [new Set(), 0, 0, 0]).get(k);
      row[0].add(r.source_id); row[1]++; row[2] += r.labels.length ? 1 : 0; row[3] += r.labels.length;
    }
  }
  const val = (k) => { const [ids, ...rest] = got.get(k); return [ids.size, ...rest]; };
  const published = {
    all: [2965, 17790, 7664, 14289],
    "task Summary CNN/DM": [628, 3768, 1165, 1474],
    "task Summary Recent News": [315, 1890, 521, 598],
    "task QA": [989, 5934, 1724, 2927],
    "task Data2txt": [1033, 6198, 4254, 9290],
  };
  for (const [k, v] of Object.entries(published)) assert.deepEqual(val(k), v, k);
  const byModel = {
    "gpt-3.5-turbo-0613": [401, 533], "gpt-4-0613": [406, 485], "llama-2-7b-chat": [1832, 3302],
    "llama-2-13b-chat": [1677, 3799], "llama-2-70b-chat": [1395, 2608], "mistral-7B-instruct": [1953, 3562],
  };
  for (const [m, v] of Object.entries(byModel)) assert.deepEqual(val(`model ${m}`).slice(2), v, m);
});
