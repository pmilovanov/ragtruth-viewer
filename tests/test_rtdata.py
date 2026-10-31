import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parent)]

import fixture  # noqa: E402
import rtdata  # noqa: E402

REAL = HERE.parent / "data"  # filled by serve.py --download


class FixtureCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.dir = fixture.write(Path(cls._tmp.name))
        cls.ds = rtdata.Dataset.load(cls.dir)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()


class TestLoading(unittest.TestCase):
    def test_missing_files_raise(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(rtdata.DataError):
                rtdata.Dataset.load(Path(d))

    def test_orphan_response_is_rejected(self):
        rs = fixture.responses()
        rs[0]["source_id"] = "nope"
        with self.assertRaises(rtdata.DataError):
            rtdata.Dataset(rs, fixture.sources())


class TestIndex(FixtureCase):
    def test_columns_are_aligned(self):
        ix = self.ds.index()
        self.assertEqual(ix["n"], 6)
        for name, col in ix["cols"].items():
            self.assertEqual(len(col), 6, name)
        sp = ix["spans"]
        self.assertEqual({len(v) for v in sp.values()}, {5})

    def test_facets_use_preferred_order_and_keep_unknowns(self):
        f = self.ds.index()["facets"]
        self.assertEqual(f["models"][0], "gpt-4-0613")
        self.assertEqual(f["models"][-1], "zz-new-model")
        self.assertEqual(f["tasks"], ["QA", "Data2txt", "Summary"])
        self.assertEqual(f["types"], ["Evident Baseless Info", "Evident Conflict",
                                      "Subtle Baseless Info", "Subtle Conflict"])
        # dataset -> task lookup lines up with the two orderings
        for d, t in zip(f["datasets"], f["dataset_task"]):
            expected = {"MARCO": "QA", "Yelp": "Data2txt", "CNN/DM": "Summary"}[d]
            self.assertEqual(f["tasks"][t], expected)

    def test_spans_sorted_by_row_then_start(self):
        sp = self.ds.index()["spans"]
        keys = list(zip(sp["r"], sp["s"]))
        self.assertEqual(keys, sorted(keys))

    def test_span_offsets_slice_the_response(self):
        ix = self.ds.index()
        sp = ix["spans"]
        for k in range(len(sp["r"])):
            text = self.ds.responses[sp["r"][k]]["response"]
            label = next(l for l in self.ds.responses[sp["r"][k]]["labels"] if l["start"] == sp["s"][k])
            self.assertEqual(text[sp["s"][k]:sp["e"][k]], label["text"])
            self.assertEqual(sp["w"][k], len(label["text"].split()))

    def test_flags_are_carried(self):
        sp = self.ds.index()["spans"]
        self.assertEqual(sum(sp["n"]), 1)  # one due_to_null span
        self.assertEqual(sum(sp["i"]), 1)  # one implicit_true span

    def test_index_json_roundtrips_and_is_cached(self):
        import json
        raw = self.ds.index_json()
        self.assertIs(raw, self.ds.index_json())
        self.assertEqual(json.loads(raw)["n"], 6)


class TestDetail(FixtureCase):
    def test_response_detail_includes_source_and_siblings(self):
        d = self.ds.response_detail("2")
        self.assertEqual(d["source"]["kind"], "summary")
        self.assertEqual([s["id"] for s in d["siblings"]], ["2", "3"])
        self.assertEqual([l["start"] for l in d["labels"]], sorted(l["start"] for l in d["labels"]))
        self.assertTrue(d["labels"][0]["meta"].strip())

    def test_overlap_survives(self):
        labels = self.ds.response_detail("2")["labels"]
        overlaps = [(a["text"], b["text"]) for a, b in zip(labels, labels[1:]) if b["start"] < a["end"]]
        self.assertTrue(overlaps)

    def test_unknown_ids_raise_keyerror(self):
        with self.assertRaises(KeyError):
            self.ds.response_detail("999")
        with self.assertRaises(KeyError):
            self.ds.source_detail("999")

    def test_source_detail_returns_all_siblings_with_text(self):
        d = self.ds.source_detail("30")
        self.assertEqual(d["kind"], "data2txt")
        self.assertEqual([r["model"] for r in d["responses"]], ["gpt-4-0613", "zz-new-model"])
        self.assertIn("response", d["responses"][0])

    def test_source_views(self):
        qa = rtdata.source_view(self.ds.sources["10"])
        self.assertEqual(qa["kind"], "qa")
        self.assertEqual([p["n"] for p in qa["passages"]], [1, 2])
        self.assertEqual(qa["passages"][1]["text"], "It lies on the Seine.")
        self.assertEqual(rtdata.source_view(self.ds.sources["30"])["data"]["name"], "Cafe Rio")

    def test_split_passages_without_markers(self):
        self.assertEqual(rtdata.split_passages("just text"), [{"n": 1, "text": "just text"}])


class TestSearch(FixtureCase):
    def test_scopes(self):
        self.assertEqual(self.ds.search("seine", "response"), [0, 1])
        self.assertEqual(self.ds.search("seine", "spans"), [1])
        self.assertEqual(self.ds.search("february 1945", "notes"), [2])
        self.assertEqual(self.ds.search("typhus", "source"), [2, 3])

    def test_all_terms_required_and_case_insensitive(self):
        self.assertEqual(self.ds.search("CAFE vegan"), [4, 5])
        self.assertEqual(self.ds.search("cafe nonsense"), [])

    def test_quoted_phrase_stays_whole(self):
        self.assertEqual(self.ds.search('"open on monday"'), [4, 5])
        self.assertEqual(self.ds.search('"monday open"'), [])

    def test_empty_query_matches_nothing(self):
        self.assertEqual(self.ds.search("   "), [])

    def test_bad_scope(self):
        with self.assertRaises(ValueError):
            self.ds.search("x", "everything")


@unittest.skipUnless(all((REAL / f).is_file() for f in rtdata.FILES),
                     "real RAGTruth files not present (run serve.py --download)")
class TestRealCorpus(unittest.TestCase):
    """Assumptions the UI leans on, checked against the real thing."""

    @classmethod
    def setUpClass(cls):
        cls.ds = rtdata.Dataset.load(REAL)

    def test_every_span_matches_its_text(self):
        for r in self.ds.responses:
            for l in r["labels"]:
                self.assertEqual(r["response"][l["start"]:l["end"]], l["text"], r["id"])

    def test_six_siblings_per_source(self):
        self.assertTrue(all(len(v) == 6 for v in self.ds.rows_of_source.values()))

    def test_qa_sources_parse_into_passages(self):
        for s in self.ds.sources.values():
            if s["task_type"] == "QA":
                self.assertGreaterEqual(len(rtdata.source_view(s)["passages"]), 1)


if __name__ == "__main__":
    unittest.main()
