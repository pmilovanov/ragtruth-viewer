import test from "node:test";
import assert from "node:assert/strict";
import {
  wilson, segment, quantileEdges, binOf,
  poissonBinomial, niceTicks, median, parseOriginal, findLoose, kvQuoted,
} from "../site/js/lib.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("wilson: known values and edge cases", () => {
  const [lo, hi] = wilson(50, 100);
  near(lo, 0.4038, 1e-3); near(hi, 0.5962, 1e-3);
  assert.deepEqual(wilson(0, 0), [0, 0]);
  const [l0, h0] = wilson(0, 20);
  assert.equal(l0, 0); assert.ok(h0 > 0.1 && h0 < 0.2);      // no certainty from zero hits
  const [l1, h1] = wilson(20, 20);
  assert.equal(h1, 1); assert.ok(l1 > 0.8);
});

test("segment: covers the text exactly, tracks overlaps in span order", () => {
  const spans = [{ start: 2, end: 6 }, { start: 4, end: 9 }];
  const segs = segment(12, spans);
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.ids]), [
    [0, 2, []], [2, 4, [0]], [4, 6, [0, 1]], [6, 9, [1]], [9, 12, []],
  ]);
  // contiguous, gap-free
  segs.reduce((end, s) => { assert.equal(s.start, end); return s.end; }, 0);
});

test("segment: no spans, span at the edges, span past the end", () => {
  assert.deepEqual(segment(5, []), [{ start: 0, end: 5, ids: [] }]);
  assert.deepEqual(segment(5, [{ start: 0, end: 5 }]), [{ start: 0, end: 5, ids: [0] }]);
  assert.deepEqual(segment(5, [{ start: 3, end: 99 }]).map((s) => s.ids), [[], [0]]);
  assert.deepEqual(segment(0, []), []);
});

test("segment: identical spans stack rather than vanish", () => {
  const segs = segment(6, [{ start: 1, end: 3 }, { start: 1, end: 3 }]);
  assert.deepEqual(segs.find((s) => s.start === 1).ids, [0, 1]);
});

test("quantileEdges + binOf: ties collapse, every value lands in a bin", () => {
  const values = [1, 1, 1, 1, 1, 1, 2, 3, 4, 100];
  const edges = quantileEdges(values, 5);
  assert.deepEqual(edges, [...new Set(edges)].sort((a, b) => a - b));
  for (const v of values) {
    const b = binOf(edges, v);
    assert.ok(b >= 0 && b < edges.length - 1, `value ${v} -> bin ${b}`);
  }
  assert.equal(binOf(edges, edges[edges.length - 1]), edges.length - 2);  // top edge is inclusive
  assert.deepEqual(quantileEdges([], 4), []);
  assert.equal(binOf([5], 5), -1);                                         // degenerate: no bins
});

test("poissonBinomial: reduces to binomial, handles unequal p, sums to one", () => {
  const pmf = poissonBinomial([0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
  near(pmf.reduce((a, b) => a + b, 0), 1);
  near(pmf[2], 15 * 0.09 * Math.pow(0.7, 4), 1e-9);               // C(6,2) p^2 q^4
  assert.deepEqual(poissonBinomial([0, 0, 0]), [1, 0, 0, 0]);
  assert.deepEqual(poissonBinomial([1, 0]), [0, 1, 0]);
  const mixed = poissonBinomial([0.9, 0.1]);                       // a sure-ish and an unlikely trial
  near(mixed[0], 0.1 * 0.9); near(mixed[1], 0.9 * 0.9 + 0.1 * 0.1); near(mixed[2], 0.09);
  assert.deepEqual(poissonBinomial([]), [1]);
});

test("niceTicks: round steps that cover the max", () => {
  for (const max of [0.37, 1, 7, 83, 1234, 0.0042]) {
    const { ticks, top } = niceTicks(max, 4);
    assert.ok(top >= max, `${top} >= ${max}`);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.length >= 2 && ticks.length <= 8, `${ticks.length} ticks for ${max}`);
  }
  assert.deepEqual(niceTicks(100, 4).ticks, [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0).ticks, [0, 1]);
});

test("median", () => {
  assert.equal(median([3, 1, 2]), 3 - 1);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test("parseOriginal: pulls the quoted source text out of annotator notes", () => {
  assert.equal(parseOriginal("EVIDENT CONFLICT\nOriginal: February 7 (1945)\nGenerated: February 7, 2022"), "February 7 (1945)");
  assert.equal(parseOriginal("CONFLICT\nOriginal: “exact dates unclear” Generated: before"), "exact dates unclear");
  assert.equal(parseOriginal("HIGH INTRO OF NEW INFO\nnot mentioned"), null);
  assert.equal(parseOriginal("Original: ok"), null);                       // too short to search for
  assert.equal(parseOriginal(""), null);
  assert.equal(parseOriginal(undefined), null);
});

test("findLoose: case, whitespace and trailing punctuation are forgiven", () => {
  const text = "Anne Frank and her sister died of typhus\n  at Bergen-Belsen in February 1945.";
  const hit = findLoose(text, "bergen-belsen IN february   1945");
  assert.deepEqual(text.slice(hit.start, hit.end), "Bergen-Belsen in February 1945");
  const hit2 = findLoose(text, "died of typhus at Bergen-Belsen.");
  assert.ok(hit2);
  assert.equal(findLoose(text, "nothing like this"), null);
  assert.equal(findLoose(text, ""), null);
  assert.equal(findLoose("price (USD) $5.00", "(USD) $5.00").start, 6);     // regex metacharacters are literal
});

test("kvQuoted: matches quoted JSON fragments against key/value pairs", () => {
  assert.ok(kvQuoted('intimate": null,', "intimate", null));
  assert.ok(kvQuoted('OutdoorSeating": false', "OutdoorSeating", false));
  assert.ok(kvQuoted('"touristy": null, "trendy": null', "trendy", null));         // one quote, several pairs
  assert.ok(kvQuoted("WiFi: no", "WiFi", "no"));
  assert.ok(!kvQuoted('intimate": null,', "intimate", false));                      // value must agree
  assert.ok(!kvQuoted('casual": false', "classy", false));                          // and so must the key
  assert.ok(!kvQuoted("no", "a", "b"));
});

test("jsonTokens: round-trips exactly and classifies keys, strings, numbers and literals", async () => {
  const { jsonTokens } = await import("../site/js/lib.js");
  const text = JSON.stringify({ a: 1, 'b"c': 'x \\" y: 2', d: [true, null, -2.5e3, false], e: {} }, null, 2);
  const tokens = jsonTokens(text);
  assert.equal(tokens.map((t) => t.text).join(""), text);
  const of = (kind) => tokens.filter((t) => t.kind === kind).map((t) => t.text);
  assert.deepEqual(of("key"), ['"a"', '"b\\"c"', '"d"', '"e"']);
  assert.deepEqual(of("str"), ['"x \\\\\\" y: 2"']);            // a colon inside a string is not a key
  assert.deepEqual(of("num"), ["1", "-2500"]);
  assert.deepEqual(of("lit"), ["true", "null", "false"]);
  assert.deepEqual(jsonTokens(""), []);
});
