// The data layer on a hand-built fixture (see fixture.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { Corpus, parseJSONL, splitPassages, sourceView, terms, wordCount } from "../site/js/corpus.js";
import * as fx from "./fixture.mjs";

const corpus = () => Corpus.fromJSONL(fx.asJSONL(fx.responses()), fx.asJSONL(fx.sources()));

test("loading: blank lines are ignored, orphan responses rejected", () => {
  assert.equal(parseJSONL('{"a":1}\n\n  \n{"a":2}\n').length, 2);
  const rs = fx.responses();
  rs[0].source_id = "nope";
  assert.throws(() => new Corpus(rs, fx.sources()), /unknown source/);
});

test("index: columns are aligned", () => {
  const ix = corpus().index();
  assert.equal(ix.n, 6);
  for (const [name, col] of Object.entries(ix.cols)) assert.equal(col.length, 6, name);
  assert.deepEqual(new Set(Object.values(ix.spans).map((v) => v.length)), new Set([5]));
});

test("index: facets use the preferred order and keep unknowns", () => {
  const f = corpus().index().facets;
  assert.equal(f.models[0], "gpt-4-0613");
  assert.equal(f.models.at(-1), "zz-new-model");
  assert.deepEqual(f.tasks, ["QA", "Data2txt", "Summary"]);
  assert.deepEqual(f.types, ["Evident Baseless Info", "Evident Conflict", "Subtle Baseless Info", "Subtle Conflict"]);
  assert.deepEqual(f.temps, [0.7, 0.925, 1]);
  const expected = { MARCO: "QA", Yelp: "Data2txt", "CNN/DM": "Summary" };
  f.datasets.forEach((d, k) => assert.equal(f.tasks[f.dataset_task[k]], expected[d]));
});

test("index: spans sorted by row then start, offsets slice the response, words counted", () => {
  const c = corpus(), sp = c.index().spans;
  const keys = sp.r.map((r, k) => [r, sp.s[k]]);
  assert.deepEqual(keys, [...keys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  sp.r.forEach((row, k) => {
    const text = c.responses[row].response.slice(sp.s[k], sp.e[k]);
    const lab = c.responses[row].labels.find((l) => l.start === sp.s[k]);
    assert.equal(text, lab.text);
    assert.equal(sp.w[k], wordCount(lab.text));
  });
});

test("index: flags are carried, and the index survives being posted between threads", () => {
  const ix = corpus().index();
  assert.equal(ix.spans.n.reduce((a, b) => a + b), 1);   // one due_to_null span
  assert.equal(ix.spans.i.reduce((a, b) => a + b), 1);   // one implicit_true span
  assert.deepEqual(structuredClone(ix), ix);
});

test("detail: a response comes with its source and siblings, spans in reading order", () => {
  const d = corpus().responseDetail("2");
  assert.equal(d.source.kind, "summary");
  assert.deepEqual(d.siblings.map((s) => s.id), ["2", "3"]);
  assert.deepEqual(d.labels.map((l) => l.start), [...d.labels.map((l) => l.start)].sort((a, b) => a - b));
  assert.ok(d.labels[0].meta.trim());
  const overlaps = d.labels.filter((l, k) => k > 0 && l.start < d.labels[k - 1].end);
  assert.ok(overlaps.length, "overlapping spans survive");
});

test("detail: unknown ids throw", () => {
  assert.throws(() => corpus().responseDetail("999"), /no response/);
  assert.throws(() => corpus().sourceDetail("999"), /no source/);
});

test("detail: a source comes with all of its responses, text included", () => {
  const d = corpus().sourceDetail("30");
  assert.equal(d.kind, "data2txt");
  assert.deepEqual(d.responses.map((r) => r.model), ["gpt-4-0613", "zz-new-model"]);
  assert.ok(d.responses[0].response);
});

test("source views: QA passages split, structured data kept, plain text fallback", () => {
  const [qaSrc, , d2tSrc] = fx.sources();
  const qa = sourceView(qaSrc);
  assert.equal(qa.kind, "qa");
  assert.deepEqual(qa.passages.map((p) => p.n), [1, 2]);
  assert.equal(qa.passages[1].text, "It lies on the Seine.");
  assert.equal(sourceView(d2tSrc).data.name, "Cafe Rio");
  assert.deepEqual(splitPassages("just text"), [{ n: 1, text: "just text" }]);
});

test("search: each scope looks where it says", () => {
  const c = corpus();
  assert.deepEqual(c.search("seine", "response"), [0, 1]);
  assert.deepEqual(c.search("seine", "spans"), [1]);
  assert.deepEqual(c.search("february 1945", "notes"), [2]);
  assert.deepEqual(c.search("typhus", "source"), [2, 3]);
});

test("search: all terms required, case-insensitive; quoted phrases stay whole", () => {
  const c = corpus();
  assert.deepEqual(c.search("CAFE vegan"), [4, 5]);
  assert.deepEqual(c.search("cafe nonsense"), []);
  assert.deepEqual(c.search('"open on monday"'), [4, 5]);
  assert.deepEqual(c.search('"monday open"'), []);
  assert.deepEqual(terms('a "b c"  D'), ["a", "b c", "d"]);
});

test("search: empty queries match nothing, unknown scopes throw", () => {
  assert.deepEqual(corpus().search("   "), []);
  assert.throws(() => corpus().search("x", "everything"), /unknown scope/);
});

test("offsets: code points from upstream become UTF-16 units, so highlights never drift", () => {
  const text = "Great 🍕 place 🎉 open on Monday, said nobody.";
  const lab = fx.label(text, "open on Monday", "Evident Baseless Info");
  assert.notEqual(text.slice(lab.start, lab.end), "open on Monday");      // the trap, as upstream would hand it to us
  const src = { source_id: "s", task_type: "Summary", source: "CNN/DM", source_info: "x", prompt: "p" };
  const c = new Corpus([{ id: "e", source_id: "s", model: "m", temperature: 1, split: "train", quality: "good", response: text, labels: [lab] }], [src]);
  const [l] = c.responseDetail("e").labels;
  assert.equal(text.slice(l.start, l.end), "open on Monday");
});

test("record: the rows as the files have them, whatever the page did to its own copy", () => {
  const c = corpus(), [raw2] = fx.responses().filter((r) => r.id === "2");
  const rec = c.record("2");
  assert.deepEqual(rec.response, raw2);                                    // upstream label order, not sorted
  assert.notDeepEqual(c.responseDetail("2").labels.map((l) => l.text), raw2.labels.map((l) => l.text));
  assert.deepEqual(Object.keys(rec.response), Object.keys(raw2));          // field order preserved
  assert.deepEqual(rec.source, fx.sources().find((s) => s.source_id === "20"));
  assert.throws(() => c.record("999"), /no response/);
});

test("record: upstream code-point offsets survive even where the page converts them", () => {
  const text = "Great 🍕 place 🎉 open on Monday, said nobody.";
  const lab = fx.label(text, "open on Monday", "Evident Baseless Info");
  const src = { source_id: "s", task_type: "Summary", source: "CNN/DM", source_info: "x", prompt: "p" };
  const c = new Corpus([{ id: "e", source_id: "s", model: "m", temperature: 1, split: "train", quality: "good", response: text, labels: [lab] }], [src]);
  assert.deepEqual(c.record("e").response.labels[0], lab);                 // as upstream wrote it
  assert.notEqual(c.responseDetail("e").labels[0].start, lab.start);       // the page's converted copy
});
