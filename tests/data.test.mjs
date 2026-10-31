// The selection logic and URL state, with a hand-built index (no server, no DOM).
import test from "node:test";
import assert from "node:assert/strict";
import { D, F, derive, select, resetFilters, filtersToParams, paramsToFilters, applyQuery } from "../static/js/data.js";

// Row 0: two overlapping spans (0-5 type 0, 3-8 type 1)   -> 8 chars covered
// Row 1: one implicit-true span (2-4 type 0)
// Row 2: clean
function load() {
  D.n = 3;
  D.f = {
    tasks: ["QA", "Summary"], datasets: ["MARCO", "CNN/DM"], models: ["gpt-4-0613", "llama-2-7b-chat"],
    splits: ["train", "test"], qualities: ["good", "truncated"], temps: [0.7, 1], types: ["Evident Baseless Info", "Evident Conflict"],
  };
  D.sp = {
    r: Int32Array.of(0, 0, 1), s: Int32Array.of(0, 3, 2), e: Int32Array.of(5, 8, 4),
    t: Uint8Array.of(0, 1, 0), n: Uint8Array.of(0, 0, 0), i: Uint8Array.of(0, 0, 1), w: Int32Array.of(1, 1, 1),
  };
  D.off = Int32Array.of(0, 2, 3, 3);
  D.len = Int32Array.of(20, 10, 10);
  D.task = Uint8Array.of(0, 0, 1); D.ds = Uint8Array.of(0, 0, 1);
  D.model = Uint8Array.of(0, 1, 1); D.split = Uint8Array.of(0, 0, 1);
  D.quality = Uint8Array.of(0, 0, 1); D.temp = Uint8Array.of(0, 1, 1);
  D.searchMask = null;
  resetFilters();
  derive();
}

test("derive counts each character once where spans overlap", () => {
  load();
  assert.deepEqual([...D.nsp], [2, 1, 0]);
  assert.deepEqual([...D.hch], [8, 2, 0]);               // union of 0-5 and 3-8 is 8, not 10
  assert.deepEqual([...D.tmask], [0b11, 0b01, 0]);
});

test("derive: implicit-true spans drop out when they do not count", () => {
  load();
  F.implicit = false; derive();
  assert.deepEqual([...D.nsp], [2, 0, 0]);
  assert.deepEqual([...D.hch], [8, 0, 0]);
  assert.deepEqual([...D.tmask], [0b11, 0, 0]);
  F.implicit = true; derive();
  assert.deepEqual([...D.nsp], [2, 1, 0]);               // and back again, nothing stale
});

test("select: facets AND together, values within a facet OR", () => {
  load();
  assert.deepEqual([...select()], [0, 1, 2]);
  F.model.add(1);
  assert.deepEqual([...select()], [1, 2]);
  F.task.add(0);
  assert.deepEqual([...select()], [1]);
  F.task.add(1);
  assert.deepEqual([...select()], [1, 2]);
});

test("select: hallucination and label-type filters follow the counting rule", () => {
  load();
  F.hall = "yes"; assert.deepEqual([...select()], [0, 1]);
  F.hall = "no"; assert.deepEqual([...select()], [2]);
  F.hall = "any"; F.type.add(1);
  assert.deepEqual([...select()], [0]);                  // only row 0 has an Evident Conflict
  F.implicit = false; derive(); F.type.clear(); F.type.add(0); F.hall = "yes";
  assert.deepEqual([...select()], [0]);                  // row 1's only span no longer counts
});

test("select: a search mask restricts, and an unanswered search matches nothing", () => {
  load();
  F.q = "x"; D.searchMask = Uint8Array.of(0, 1, 1);
  assert.deepEqual([...select()], [1, 2]);
  D.searchMask = null;
  assert.deepEqual([...select()], []);
});

test("filters survive a round trip through the URL", () => {
  load();
  F.model.add(1); F.type.add(0); F.type.add(1); F.temp.add(1); F.hall = "yes"; F.implicit = false; derive();
  const qs = filtersToParams().toString();
  resetFilters();
  assert.equal(filtersToParams().toString(), "");
  const back = paramsToFilters(new URLSearchParams(qs));
  assert.equal(filtersToParams().toString(), qs);
  assert.deepEqual([...F.type].sort(), [0, 1]);
  assert.equal(F.implicit, false);
  assert.deepEqual(back, { q: "", scope: "response" });
});

test("a URL naming things that do not exist is ignored, not fatal", () => {
  load();
  paramsToFilters(new URLSearchParams("model=gpt-9&task=QA&hall=maybe&type=Nonsense"));
  assert.deepEqual([...F.task], [0]);
  assert.equal(F.model.size, 0);
  assert.equal(F.type.size, 0);
  assert.equal(F.hall, "any");
});

test("an empty query clears the search without a request", async () => {
  load();
  F.q = "x"; D.searchMask = Uint8Array.of(1, 1, 1);
  await applyQuery("   ", "response");                   // would throw if it reached fetch()
  assert.equal(F.q, ""); assert.equal(D.searchMask, null);
});
