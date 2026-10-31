# RAGTruth viewer

A local viewer for the [RAGTruth](https://github.com/ParticleMedia/RAGTruth) hallucination corpus:
17,790 LLM responses (6 models × 2,965 sources, across QA, data-to-text and summarisation), each with
word-level hallucination spans labelled by annotators.

Two ways in, one shared set of filters:

- **Overview** – aggregate patterns across whatever slice you have filtered to.
- **Browse** – read individual responses, with the annotations on the text and the source beside it.

Standard library only (developed on Python 3.13). No `pip install`, no `npm install`, no build step.

Originally built in [`pmilovanov/guardrails`](https://github.com/pmilovanov/guardrails) under `data/ragtruth/ui/`.

## Run it

```bash
python3 serve.py --download   # first time: fetches the corpus (~36 MB) into ./data/
python3 serve.py              # afterwards
```

Then open <http://127.0.0.1:8765/>. Options: `--port`, `--host`, `--data-dir`, `--open`, `--quiet`.
If you already have `response.jsonl` and `source_info.jsonl` somewhere, pass `--data-dir`.
(`/data/` is gitignored, so the downloaded files stay out of git.)

With [just](https://github.com/casey/just):

```bash
just run --download   # first time; extra arguments go straight to serve.py
just run              # afterwards
just test             # both test suites (just test-py / just test-js for one)
just                  # list the recipes
```

From another directory, `just --justfile path/to/ragtruth-viewer/justfile run`. To use another
interpreter, e.g. uv: `PYTHON="uv run python" just run`.

## What you can see

### Overview

Every chart, tile and table is computed from the current filter selection, so the numbers always agree.
Each chart has a **Table** button giving the same numbers as a table.

| View | Question it answers |
|---|---|
| Model × task heatmap | Who hallucinates, where? Metric switchable (responses with ≥1 span / spans per response / share of text). Click a cell to read those responses. |
| Label-type mix by model | Evident vs Subtle, Baseless vs Conflict. Per response, or as a share. Click a segment to browse it. |
| Spans per response | How many spans a response gets, by model. |
| Span length | Words per span, by label type. |
| Where in the response | Share of text annotated at each relative position, per label type. |
| Rate against… | Hallucination rate (with 95% Wilson intervals) against response length, prompt length or temperature. |
| Source or model? | How many of a source's six responses hallucinate, against what you would see if each model hallucinated independently at its own rate. Excess at 0 and 6 means some sources are intrinsically easy or hard. |
| Annotation details · Splits · Quality | Flag rates (due-to-null, implicit-true), train/test composition, refusals and truncations. |

### Browse

- A virtualised list (fast at 17,790 rows) with a minimap of where each response's spans fall.
  Sort by span count, share of text annotated, or length. **CSV** exports the filtered list; **Random** jumps to one.
- The response with spans highlighted (colour = label type; overlaps are drawn, not lost), numbered
  annotations with the annotators' notes, and the **source** and **prompt** alongside.
- **Evidence linking.** Select an annotation and, where the annotator quoted the source
  (`Original: …`), that text is highlighted in the source panel. Plain-text quotes are matched
  loosely (case, whitespace); Data2txt notes mostly quote JSON fragments (`"intimate": null,`), which
  are matched against the key/value rows. On the published corpus this locates roughly a third of
  Summary quotes, a seventh of QA and two-thirds of Data2txt; the rest are paraphrases, and the
  annotation says so rather than guessing.
- **Compare models** (`c`): all six responses to one source side by side.

### Filters (top bar, shared by both views)

Text search runs on the server over response text, hallucinated spans, annotator notes or source text
(all words must match; `"quote"` a phrase). *Has label type* selects responses that contain a span of
that type. Everything is reflected in the URL, so a view can be shared or bookmarked.

**Count implicit-true spans.** Annotators flagged some spans as *true but absent from the context*
(`implicit_true`). They are labelled spans, so by default they count as hallucinations, which is the
usual convention (a response is hallucinated if it has any label). Untick the box to treat them as
supported; every number, chart and list responds. On the published corpus that moves the response-level
rate from 43.1% to 39.4%.

### Keys

`j` / `k` next/previous in the list · `←` / `→` previous/next model for the same source ·
`c` compare · `/` search · `1` / `2` Overview / Browse · `t` theme · `Esc` leave a field

## Layout

```
  justfile        `just run`, `just test`
  package.json    only so `node --test` treats static/js as ES modules
  serve.py        HTTP server and CLI (stdlib http.server)
  rtdata.py       load, columnar index, record lookup, search; no HTTP, usable from a notebook
  static/         index.html, style.css, js/ (ES modules, hand-rolled SVG/HTML charts)
    js/lib.js     pure helpers (CIs, span segmentation, evidence matching), no DOM
    js/data.js    index in typed arrays, derived columns, filter state, URL <-> filters
  tests/          unittest (Python) and node:test (JS)
  data/           the corpus, fetched by --download (gitignored)
```

The server sends one ~190 KB gzipped columnar index (everything except bulky text); the browser does all
aggregation and cross-filtering itself, so charts update in tens of milliseconds. Response and source text
are fetched per record on demand.

## Tests

```bash
python3 -m unittest discover -s tests    # loader, index, search, HTTP (a real-corpus check runs if the data is present)
node --test                              # pure logic, selection and URL state (developed on Node 22)
```

## Notes on the charts

Colours are the dataviz reference palette, validated per mode with its checker. The four label types take
categorical slots 1–4 in fixed order; that set passes the adjacent-pair checks but **fails the all-pairs
floor** (yellow against orange), so it is used only in forms where marks touch their neighbours only
(bars, stacks, lines), never in scatter or small multiples. Aqua and yellow fall under 3:1 on the light
surface, so every chart carries a legend, a tooltip and a table view.
